//! Session-owned staging for files dropped onto a terminal in the browser.
//!
//! The browser uploads each dropped file, then pastes the staged paths as
//! ordinary terminal input. Each running server stages under its own folder
//! of the system temporary directory and holds a lock beside it, so a later
//! server can remove what a crashed one left behind.
use std::fs::{self, File, OpenOptions, TryLockError};
use std::io::{self, Read, Write};
#[cfg(windows)]
use std::os::windows::fs::MetadataExt;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::sync::atomic::{AtomicU64, Ordering};

pub const FILE_LIMIT: u64 = 1 << 30;
const NAME_LIMIT: usize = 180;
const MARKER: &[u8] = b"webterminal-upload-staging-v1\n";
const MARKER_FILE: &str = ".webterminal-upload";

pub struct Uploads {
    base: PathBuf,
    owner: String,
    root: Mutex<Option<Root>>,
    next: AtomicU64,
}
struct Root {
    path: PathBuf,
    lock: PathBuf,
    _held: File,
}

impl Uploads {
    /// `owner` names this server's folder under `base`; nothing is created
    /// until the first upload.
    pub fn new(base: PathBuf, owner: String) -> Self {
        // A new server cleans up a previous crash even if no file is dropped.
        sweep(&base);
        Self {
            base,
            owner,
            root: Mutex::new(None),
            next: AtomicU64::new(1),
        }
    }
    pub fn temporary(owner: String) -> Self {
        Self::new(std::env::temp_dir().join("webterminal-uploads"), owner)
    }
    fn root(&self) -> io::Result<PathBuf> {
        let mut root = self.root.lock().unwrap();
        if let Some(root) = root.as_ref() {
            return Ok(root.path.clone());
        }
        fs::create_dir_all(&self.base)?;
        if !plain_dir(&self.base) {
            return Err(io::Error::other("Upload staging base is a reparse point"));
        }
        sweep(&self.base);
        let lock = self.base.join(format!("{}.lock", self.owner));
        let mut held = OpenOptions::new()
            .read(true)
            .write(true)
            .create_new(true)
            .open(&lock)?;
        let path = self.base.join(&self.owner);
        let mut created = false;
        let result = (|| {
            held.try_lock().map_err(|error| match error {
                TryLockError::Error(error) => error,
                TryLockError::WouldBlock => io::Error::other("Upload staging is owned elsewhere"),
            })?;
            held.write_all(MARKER)?;
            fs::create_dir(&path)?;
            created = true;
            let mut marker = File::create_new(path.join(MARKER_FILE))?;
            marker.write_all(MARKER)?;
            marker.sync_all()
        })();
        if let Err(error) = result {
            if created {
                let _ = fs::remove_dir_all(&path);
            }
            drop(held);
            let _ = fs::remove_file(&lock);
            return Err(error);
        }
        *root = Some(Root {
            path: path.clone(),
            lock,
            _held: held,
        });
        Ok(path)
    }
    /// Streams exactly `length` bytes, starting with `prefix`, into a new
    /// folder of `session`. A short or failed transfer leaves nothing behind.
    pub fn receive(
        &self,
        session: &str,
        name: &str,
        length: u64,
        prefix: &[u8],
        body: &mut impl Read,
    ) -> io::Result<PathBuf> {
        if length > FILE_LIMIT {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "Dropped files are limited to 1 GiB each",
            ));
        }
        if prefix.len() as u64 > length {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "Upload is longer than its Content-Length",
            ));
        }
        let index = self.next.fetch_add(1, Ordering::Relaxed);
        let folder = self.root()?.join(session).join(index.to_string());
        fs::create_dir_all(&folder)?;
        let path = folder.join(file_name(name));
        match copy(&path, length, prefix, body) {
            Ok(()) => Ok(path),
            Err(error) => {
                let _ = fs::remove_dir_all(&folder);
                Err(error)
            }
        }
    }
    /// Removes one staged file whose session ended during its transfer.
    pub fn discard(&self, path: &Path) {
        if let Some(folder) = path.parent() {
            let _ = fs::remove_dir_all(folder);
        }
    }
    pub fn remove_session(&self, session: &str) {
        if let Some(root) = self.root.lock().unwrap().as_ref()
            && plain_dir(&root.path)
            && marker_matches(&root.path.join(MARKER_FILE))
        {
            let _ = fs::remove_dir_all(root.path.join(session));
        }
    }
    pub fn remove_all(&self) {
        if let Some(root) = self.root.lock().unwrap().take() {
            if plain_dir(&root.path) && marker_matches(&root.path.join(MARKER_FILE)) {
                let _ = fs::remove_dir_all(&root.path);
            }
            let lock = root.lock.clone();
            drop(root);
            let _ = fs::remove_file(lock);
        }
    }
}
impl Drop for Uploads {
    fn drop(&mut self) {
        self.remove_all();
    }
}

fn copy(path: &Path, length: u64, prefix: &[u8], body: &mut impl Read) -> io::Result<()> {
    let mut file = File::create_new(path)?;
    file.write_all(prefix)?;
    let mut remaining = length - prefix.len() as u64;
    let mut buffer = vec![0; 65_536];
    while remaining > 0 {
        let want = buffer.len().min(remaining as usize);
        let read = body.read(&mut buffer[..want])?;
        if read == 0 {
            return Err(io::Error::new(
                io::ErrorKind::UnexpectedEof,
                "Upload ended before its Content-Length",
            ));
        }
        file.write_all(&buffer[..read])?;
        remaining -= read as u64;
    }
    file.sync_all()
}

fn plain_entry(path: &Path) -> Option<fs::Metadata> {
    let metadata = fs::symlink_metadata(path).ok()?;
    if metadata.file_type().is_symlink() {
        return None;
    }
    // Windows junctions and other reparse points are not always symlinks.
    #[cfg(windows)]
    if metadata.file_attributes() & 0x400 != 0 {
        return None;
    }
    Some(metadata)
}

fn plain_dir(path: &Path) -> bool {
    plain_entry(path).is_some_and(|metadata| metadata.is_dir())
}

fn marker_matches(path: &Path) -> bool {
    if !plain_entry(path).is_some_and(|metadata| metadata.is_file()) {
        return false;
    }
    let Ok(mut file) = File::open(path) else {
        return false;
    };
    let mut marker = [0; MARKER.len()];
    let mut extra = [0];
    file.read_exact(&mut marker).is_ok()
        && marker == MARKER
        && matches!(file.read(&mut extra), Ok(0))
}

fn owner_name(name: &str) -> bool {
    let Some((pid, port)) = name.split_once('-') else {
        return false;
    };
    pid.parse::<u32>().is_ok_and(|pid| pid > 0) && port.parse::<u16>().is_ok_and(|port| port > 0)
}

/// Removes only marked staging folders whose server no longer holds its lock.
fn sweep(base: &Path) {
    if !plain_dir(base) {
        return;
    }
    let Ok(entries) = fs::read_dir(base) else {
        return;
    };
    for entry in entries.flatten() {
        let lock_path = entry.path();
        if lock_path
            .extension()
            .is_none_or(|extension| extension != "lock")
            || !plain_entry(&lock_path).is_some_and(|metadata| metadata.is_file())
        {
            continue;
        }
        let owner = lock_path.with_extension("");
        if !owner
            .file_name()
            .and_then(|name| name.to_str())
            .is_some_and(owner_name)
        {
            continue;
        }
        let Ok(mut lock) = OpenOptions::new().read(true).write(true).open(&lock_path) else {
            continue;
        };
        if lock.try_lock().is_err() {
            continue;
        }
        let mut marker = [0; MARKER.len()];
        let mut extra = [0];
        if lock.read_exact(&mut marker).is_err()
            || marker != MARKER
            || !matches!(lock.read(&mut extra), Ok(0))
        {
            continue;
        }
        if owner.exists() {
            if !plain_dir(&owner) || !marker_matches(&owner.join(MARKER_FILE)) {
                continue;
            }
            if fs::remove_dir_all(&owner).is_err() {
                continue;
            }
        }
        drop(lock);
        let _ = fs::remove_file(&lock_path);
    }
}

/// Keeps the browser's file name readable while making it a single valid
/// Windows path component.
pub fn file_name(name: &str) -> String {
    let mut clean = String::new();
    for c in name.chars() {
        if clean.len() + c.len_utf8() > NAME_LIMIT {
            break;
        }
        let invalid = c.is_control() || r#"<>:"/\|?*"#.contains(c);
        clean.push(if invalid { '_' } else { c });
    }
    let clean = clean.trim().trim_end_matches('.');
    if clean.is_empty() {
        return "file".into();
    }
    let stem = clean
        .split('.')
        .next()
        .unwrap_or("")
        .trim()
        .to_ascii_uppercase();
    let numbered = stem.len() == 4
        && (stem.starts_with("COM") || stem.starts_with("LPT"))
        && stem.as_bytes()[3].is_ascii_digit();
    if numbered || ["CON", "PRN", "AUX", "NUL"].contains(&stem.as_str()) {
        format!("_{clean}")
    } else {
        clean.into()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    struct Base(PathBuf);
    impl Base {
        fn new(label: &str) -> Self {
            let stamp = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos();
            let path = std::env::temp_dir().join(format!(
                "webterminal-uploads-test-{label}-{}-{stamp}",
                std::process::id()
            ));
            Self(path)
        }
    }
    impl Drop for Base {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn names_stay_single_valid_components() {
        assert_eq!(file_name("report.pdf"), "report.pdf");
        assert_eq!(file_name("a/b\\c:d?.txt"), "a_b_c_d_.txt");
        assert_eq!(file_name("con.txt"), "_con.txt");
        assert_eq!(file_name("COM1"), "_COM1");
        assert_eq!(file_name("COMPANY.txt"), "COMPANY.txt");
        assert_eq!(file_name(" .. "), "file");
        assert_eq!(file_name("tail. "), "tail");
        assert_eq!(file_name("日本\u{7}.png"), "日本_.png");
        assert!(file_name(&"é".repeat(200)).len() <= NAME_LIMIT);
    }

    #[test]
    fn staged_files_hold_exact_bytes_and_failures_leave_nothing() {
        let base = Base::new("receive");
        let uploads = Uploads::new(base.0.clone(), "owner".into());
        let mut body: &[u8] = b"lo world";
        let path = uploads
            .receive("s1", "hello.txt", 11, b"hel", &mut body)
            .unwrap();
        assert_eq!(fs::read(&path).unwrap(), b"hello world");
        assert!(path.starts_with(base.0.join("owner").join("s1")));
        assert_eq!(path.file_name().unwrap(), "hello.txt");

        let mut short: &[u8] = b"12";
        let error = uploads
            .receive("s1", "short.bin", 10, b"", &mut short)
            .unwrap_err();
        assert_eq!(error.kind(), io::ErrorKind::UnexpectedEof);
        let mut empty: &[u8] = b"";
        assert!(
            uploads
                .receive("s1", "big", FILE_LIMIT + 1, b"", &mut empty)
                .is_err()
        );
        assert!(uploads.receive("s1", "x", 1, b"ab", &mut empty).is_err());
        let staged = fs::read_dir(base.0.join("owner").join("s1"))
            .unwrap()
            .count();
        assert_eq!(staged, 1, "failed uploads must remove their folders");

        let mut again: &[u8] = b"";
        let same = uploads
            .receive("s1", "hello.txt", 0, b"", &mut again)
            .unwrap();
        assert_ne!(same, path, "equal names stage side by side");
        uploads.discard(&same);
        assert!(!same.exists());

        uploads.remove_session("s1");
        assert!(!base.0.join("owner").join("s1").exists());
        uploads.remove_all();
        assert!(!base.0.join("owner").exists());
        assert!(!base.0.join("owner.lock").exists());
    }

    #[test]
    fn a_new_server_sweeps_only_marked_unlocked_staging() {
        let base = Base::new("sweep");
        let live = Uploads::new(base.0.clone(), "100-4183".into());
        let mut body: &[u8] = b"";
        live.receive("s1", "kept", 0, b"", &mut body).unwrap();
        fs::create_dir_all(base.0.join("200-4184").join("s1")).unwrap();
        fs::write(base.0.join("200-4184.lock"), MARKER).unwrap();
        fs::write(base.0.join("200-4184").join(MARKER_FILE), MARKER).unwrap();
        fs::create_dir_all(base.0.join("300-4185")).unwrap();
        fs::write(base.0.join("300-4185").join(MARKER_FILE), MARKER).unwrap();
        fs::write(base.0.join("300-4185.lock"), b"another owner").unwrap();
        fs::create_dir_all(base.0.join("400-4186")).unwrap();
        fs::write(base.0.join("400-4186.lock"), MARKER).unwrap();
        fs::create_dir_all(base.0.join("orphan")).unwrap();
        fs::write(base.0.join("orphan").join(MARKER_FILE), MARKER).unwrap();
        fs::write(base.0.join("orphan.lock"), MARKER).unwrap();
        fs::create_dir_all(base.0.join("500-4187")).unwrap();

        let next = Uploads::new(base.0.clone(), "600-4188".into());
        assert!(
            base.0.join("100-4183").exists(),
            "live lock must protect its staging"
        );
        assert!(!base.0.join("200-4184").exists());
        assert!(!base.0.join("200-4184.lock").exists());
        for name in ["300-4185", "400-4186", "orphan", "500-4187"] {
            assert!(
                base.0.join(name).exists(),
                "unowned directory {name} must survive"
            );
        }
        assert!(base.0.join("300-4185.lock").exists());
        assert!(base.0.join("400-4186.lock").exists());
        assert!(base.0.join("orphan.lock").exists());
        next.receive("s1", "new", 0, b"", &mut body).unwrap();
        assert!(base.0.join("100-4183").exists());
        assert!(!base.0.join("200-4184").exists());
        drop(live);
        assert!(!base.0.join("100-4183").exists());
        drop(next);
        assert!(!base.0.join("600-4188").exists());
        assert!(base.0.join("orphan").exists());
    }
}
