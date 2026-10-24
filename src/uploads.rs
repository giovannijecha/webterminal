//! Session-owned staging for files dropped onto a terminal in the browser.
//!
//! The browser uploads each dropped file, then pastes the staged path as
//! ordinary terminal input. Every finished upload becomes a registered staged
//! copy with a server-owned ID, so views can list and remove copies; the
//! original dropped file is never known to the server. Each running server
//! stages under its own folder of the system temporary directory and holds a
//! lock beside it, so a later server can remove what a crashed one left behind.
mod disk;
#[cfg(test)]
mod tests;

use crate::json;
use disk::Root;
pub use disk::file_name;
use std::collections::{BTreeMap, HashSet};
use std::fmt;
use std::fs;
use std::io::{self, Read};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

pub const FILE_LIMIT: u64 = 1 << 30;
/// Maximum files accepted from one browser drop.
pub const DROP_LIMIT: usize = 64;
/// Registered copies plus transfers in flight; removing copies frees room.
pub const COPY_LIMIT: usize = 512;
const ORIGINAL_LIMIT: usize = 1024;

/// One staged file. `id` is server-owned and never reused; `original` is the
/// client-supplied name (bounded) and `name` the sanitized file name written.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct StagedCopy {
    pub id: String,
    pub session: String,
    pub original: String,
    pub name: String,
    pub size: u64,
    pub path: PathBuf,
    /// Unix time in milliseconds when the copy was registered.
    pub created_ms: u64,
}

impl StagedCopy {
    pub fn json(&self) -> String {
        format!(
            "{{\"id\":{},\"session\":{},\"original\":{},\"name\":{},\"size\":{},\"path\":{},\"created\":{}}}",
            json::quote(&self.id),
            json::quote(&self.session),
            json::quote(&self.original),
            json::quote(&self.name),
            self.size,
            json::quote(&self.path.to_string_lossy()),
            self.created_ms
        )
    }
}

/// Why an upload left nothing in staging.
#[derive(Debug)]
pub enum UploadError {
    /// The copy limit is reached; the body was not read.
    Full,
    /// The session is closed or closed during the transfer.
    Closed,
    /// The request or the transfer failed.
    Failed(io::Error),
}

impl fmt::Display for UploadError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Full => f.write_str("Staged copy limit reached; remove dropped files first"),
            Self::Closed => f.write_str("Terminal session closed during the upload"),
            Self::Failed(error) => error.fmt(f),
        }
    }
}

impl From<io::Error> for UploadError {
    fn from(error: io::Error) -> Self {
        Self::Failed(error)
    }
}

pub struct Uploads {
    base: PathBuf,
    owner: String,
    limit: usize,
    state: Mutex<Staging>,
}

/// Root, live sessions and registered copies change under one lock, so a
/// copy is registered only while its session is still open.
#[derive(Default)]
struct Staging {
    root: Option<Root>,
    live: HashSet<String>,
    copies: BTreeMap<u64, StagedCopy>,
    reserved: usize,
    next: u64,
    /// Counts list changes, so views refresh only when the list changed.
    changes: u64,
}

impl Uploads {
    /// `owner` names this server's folder under `base`; nothing is created
    /// until the first upload.
    pub fn new(base: PathBuf, owner: String) -> Self {
        // A new server cleans up a previous crash even if no file is dropped.
        disk::sweep(&base);
        Self {
            base,
            owner,
            limit: COPY_LIMIT,
            state: Mutex::new(Staging::default()),
        }
    }
    pub fn temporary(owner: String) -> Self {
        Self::new(std::env::temp_dir().join("webterminal-uploads"), owner)
    }
    /// Lets `session` stage files until `remove_session`. Session IDs are
    /// never reused.
    pub fn open_session(&self, session: &str) {
        self.state.lock().unwrap().live.insert(session.to_owned());
    }
    /// Streams exactly `length` bytes, starting with `prefix`, into a new
    /// folder of `session`. The copy is listed only after `Pending::commit`;
    /// a refused, short or failed transfer leaves nothing behind.
    pub fn receive(
        &self,
        session: &str,
        name: &str,
        length: u64,
        prefix: &[u8],
        body: &mut impl Read,
    ) -> Result<Pending<'_>, UploadError> {
        if length > FILE_LIMIT {
            return Err(UploadError::Failed(io::Error::new(
                io::ErrorKind::InvalidInput,
                "Dropped files are limited to 1 GiB each",
            )));
        }
        if prefix.len() as u64 > length {
            return Err(UploadError::Failed(io::Error::new(
                io::ErrorKind::InvalidData,
                "Upload is longer than its Content-Length",
            )));
        }
        let pending = self.reserve(session, name, length)?;
        disk::copy(&pending.copy.path, length, prefix, body)?;
        Ok(pending)
    }
    /// Checks liveness and room before any body byte is read.
    fn reserve(&self, session: &str, name: &str, size: u64) -> Result<Pending<'_>, UploadError> {
        let mut state = self.state.lock().unwrap();
        if !state.live.contains(session) {
            return Err(UploadError::Closed);
        }
        if state.copies.len() + state.reserved >= self.limit {
            return Err(UploadError::Full);
        }
        let root = match &mut state.root {
            Some(root) => root.path.clone(),
            empty => empty
                .insert(Root::create(&self.base, &self.owner)?)
                .path
                .clone(),
        };
        state.next += 1;
        let index = state.next;
        let folder = root.join(session).join(index.to_string());
        if !disk::inside(&root, &folder) {
            return Err(UploadError::Failed(io::Error::new(
                io::ErrorKind::InvalidInput,
                "Invalid upload session",
            )));
        }
        let guards = disk::create_folder(&root, &folder)?;
        state.reserved += 1;
        let clean = file_name(name);
        Ok(Pending {
            uploads: self,
            index,
            root,
            guards,
            committed: false,
            copy: StagedCopy {
                id: format!("f{index}"),
                session: session.to_owned(),
                original: bounded(name, ORIGINAL_LIMIT),
                path: folder.join(&clean),
                name: clean,
                size,
                created_ms: 0,
            },
        })
    }
    /// Registered copies, newest first.
    pub fn copies(&self) -> Vec<StagedCopy> {
        let state = self.state.lock().unwrap();
        state.copies.values().rev().cloned().collect()
    }
    /// `{"type":"files","files":[...],"limit":N}`, newest first. Lists only
    /// registered metadata, never file contents or folders.
    pub fn copies_json(&self) -> String {
        let files = self
            .copies()
            .iter()
            .map(StagedCopy::json)
            .collect::<Vec<_>>()
            .join(",");
        format!(
            "{{\"type\":\"files\",\"files\":[{files}],\"limit\":{}}}",
            self.limit
        )
    }
    pub fn copy(&self, id: &str) -> Option<StagedCopy> {
        let state = self.state.lock().unwrap();
        lookup(&state, id).map(|(_, copy)| copy.clone())
    }
    /// Deletes only the staged copy `id` and its private folder.
    pub fn remove_copy(&self, id: &str) -> Result<StagedCopy, String> {
        let mut state = self.state.lock().unwrap();
        let (index, copy) = lookup(&state, id).ok_or("Staged copy no longer exists")?;
        let root = state.root.as_ref().ok_or("Staged copy no longer exists")?;
        let folder = root.path.join(&copy.session).join(index.to_string());
        if copy.path.parent() != Some(folder.as_path()) {
            return Err("Staged copy is outside its staging folder".into());
        }
        disk::remove_inside(&root.path, &folder)
            .map_err(|error| format!("Cannot remove staged copy: {error}"))?;
        state.changes += 1;
        Ok(state.copies.remove(&index).expect("looked-up copy"))
    }
    pub fn changes(&self) -> u64 {
        self.state.lock().unwrap().changes
    }
    /// Closes `session` for staging and deletes all of its copies.
    pub fn remove_session(&self, session: &str) {
        let mut state = self.state.lock().unwrap();
        state.live.remove(session);
        state.copies.retain(|_, copy| copy.session != session);
        state.changes += 1;
        if let Some(root) = state.root.as_ref() {
            let _ = disk::remove_inside(&root.path, &root.path.join(session));
        }
    }
    pub fn remove_all(&self) {
        let mut state = self.state.lock().unwrap();
        state.live.clear();
        state.copies.clear();
        state.changes += 1;
        if state.reserved == 0
            && let Some(root) = state.root.take()
        {
            root.remove();
        }
    }
}

impl Drop for Uploads {
    fn drop(&mut self) {
        self.remove_all();
    }
}

/// A fully received copy that is not listed yet. Dropping it without a
/// successful `commit` deletes its folder.
pub struct Pending<'a> {
    uploads: &'a Uploads,
    index: u64,
    root: PathBuf,
    guards: Vec<fs::File>,
    committed: bool,
    copy: StagedCopy,
}

impl Pending<'_> {
    pub fn path(&self) -> &Path {
        &self.copy.path
    }
    /// Lists the copy if its session is still open; otherwise discards it.
    pub fn commit(mut self) -> Result<StagedCopy, UploadError> {
        let mut state = self.uploads.state.lock().unwrap();
        if !state.live.contains(&self.copy.session) {
            return Err(UploadError::Closed);
        }
        state.reserved = state.reserved.saturating_sub(1);
        self.copy.created_ms = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_or(0, |elapsed| elapsed.as_millis() as u64);
        state.copies.insert(self.index, self.copy.clone());
        state.changes += 1;
        self.guards.clear();
        self.committed = true;
        Ok(self.copy.clone())
    }
}

impl Drop for Pending<'_> {
    fn drop(&mut self) {
        if self.committed {
            return;
        }
        // Removal needs DELETE access; release the receive-time handles first.
        self.guards.clear();
        let mut state = self.uploads.state.lock().unwrap();
        state.reserved = state.reserved.saturating_sub(1);
        if let Some(folder) = self.copy.path.parent() {
            let _ = disk::remove_inside(&self.root, folder);
        }
        // A session closed mid-transfer may have left its folder behind.
        if !state.live.contains(&self.copy.session) {
            let _ = disk::remove_inside(&self.root, &self.root.join(&self.copy.session));
        }
        if state.reserved == 0
            && state.live.is_empty()
            && state.copies.is_empty()
            && let Some(root) = state.root.take()
        {
            root.remove();
        }
    }
}

fn lookup<'a>(state: &'a Staging, id: &str) -> Option<(u64, &'a StagedCopy)> {
    let index = id.strip_prefix('f')?.parse::<u64>().ok()?;
    state
        .copies
        .get(&index)
        .filter(|copy| copy.id == id)
        .map(|copy| (index, copy))
}

fn bounded(text: &str, limit: usize) -> String {
    let mut end = text.len().min(limit);
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    text[..end].to_owned()
}
