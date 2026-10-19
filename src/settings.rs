//! User-scoped settings shared by every browser view of one server.
//!
//! A [`Store`] keeps one validated [`Settings`] value in memory and mirrors it
//! to a small JSON file, `~/.webterminal/settings.json` by default:
//!
//! ```text
//! {"version":1,"revision":N,"settings":{...}}
//! ```
//!
//! Every successful save increments the persisted revision. A save names the
//! revision it was based on, so two views cannot silently overwrite each
//! other: a stale base is a [`SaveError::Conflict`] and nothing is written.
//! A persistent sidecar lock serializes the read/compare/write transaction
//! across servers; each save re-reads the file while holding that lock.
//!
//! Writes are atomic: the content goes to `<file>.<pid>.tmp` in the same
//! folder, is flushed with `sync_all`, then renamed over the target; the
//! temporary file is removed on failure. A missing file means defaults. A
//! malformed, oversized or unreadable file also means defaults and is
//! reported through `problem`; the first successful save then keeps that file
//! as `<stem>.invalid.json` (replacing an older copy) before writing, and
//! reports it once through the save result's `notice`.
//!
//! Files written by earlier versions may still hold the retired
//! `notifications` preferences. Loading accepts and drops exactly that legacy
//! shape, so the other saved values stay in effect; new writes omit it.
mod fields;
mod file;

use crate::json::{self, Value};
use std::fmt;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard, PoisonError};

pub use fields::{FONT_SIZES, PATH_LIMIT};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum TerminalTheme {
    #[default]
    Dark,
    Light,
}

impl TerminalTheme {
    /// The JSON spelling: `"dark"` or `"light"`.
    pub fn name(self) -> &'static str {
        match self {
            Self::Dark => "dark",
            Self::Light => "light",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Settings {
    /// Folder for new terminals; `None` means the server's `--cwd`. Stored in
    /// ordinary DOS/UNC spelling, never with the verbatim `\\?\` prefix.
    pub start_folder: Option<PathBuf>,
    /// Terminal font size in CSS pixels, within [`FONT_SIZES`].
    pub font_size: u8,
    pub terminal_theme: TerminalTheme,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            start_folder: None,
            font_size: 13,
            terminal_theme: TerminalTheme::Dark,
        }
    }
}

impl Settings {
    /// The `settings` object shared by the API and the file.
    pub fn json(&self) -> String {
        fields::render(self)
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SaveError {
    /// The base revision is stale; carries the current [`Store::json`].
    Conflict(String),
    /// The submitted settings were rejected; the message names the field.
    Invalid(String),
    /// The file could not be written; nothing was saved.
    Io(String),
}

impl fmt::Display for SaveError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Conflict(_) => {
                f.write_str("Settings were changed elsewhere; review and save again")
            }
            Self::Invalid(message) | Self::Io(message) => f.write_str(message),
        }
    }
}

/// What the settings file currently provides.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
struct State {
    revision: u64,
    settings: Settings,
    /// Why the file could not be used; defaults are in effect.
    problem: Option<String>,
    /// The unusable file must be kept as `<stem>.invalid.json` before a write.
    preserve: bool,
}

pub struct Store {
    path: PathBuf,
    state: Mutex<State>,
}

impl Store {
    /// Loads `path`. Never fails: a missing file gives defaults; a malformed
    /// or unreadable one gives defaults plus a `problem`.
    pub fn open(path: PathBuf) -> Store {
        let state = file::load(&path);
        Store {
            path,
            state: Mutex::new(state),
        }
    }
    pub fn path(&self) -> &Path {
        &self.path
    }
    /// `{"type":"settings","revision":N,"settings":{...},"path":"...",
    /// "problem":null|"...","notice":null}`.
    pub fn json(&self) -> String {
        render(&self.path, &self.lock(), None)
    }
    pub fn current(&self) -> Settings {
        self.lock().settings.clone()
    }
    pub fn revision(&self) -> u64 {
        self.lock().revision
    }
    /// The saved start folder while it is still a directory.
    pub fn start_folder(&self) -> Option<PathBuf> {
        let folder = self.lock().settings.start_folder.clone();
        folder.filter(|path| path.is_dir())
    }
    /// Validates `settings` (the API `settings` object; absent fields keep
    /// their saved value) and persists it as revision `base_revision + 1`.
    /// Returns the new [`Store::json`], whose `notice` reports a preserved
    /// invalid file.
    pub fn save(&self, base_revision: u64, settings: &Value) -> Result<String, SaveError> {
        let mut state = self.lock();
        // Serialize the read/compare/replace transaction across Store values
        // and across servers that share this user-scoped file.
        let _file_lock = file::lock(&self.path).map_err(SaveError::Io)?;
        *state = file::load(&self.path);
        if base_revision != state.revision {
            return Err(SaveError::Conflict(render(&self.path, &state, None)));
        }
        let next = fields::merge(&state.settings, settings, fields::Source::Save)
            .map_err(SaveError::Invalid)?;
        let revision = state
            .revision
            .checked_add(1)
            .filter(|revision| i64::try_from(*revision).is_ok())
            .ok_or_else(|| SaveError::Invalid("Settings revision limit reached".into()))?;
        let notice =
            file::write(&self.path, revision, &next, state.preserve).map_err(SaveError::Io)?;
        *state = State {
            revision,
            settings: next,
            problem: None,
            preserve: false,
        };
        Ok(render(&self.path, &state, notice.as_deref()))
    }
    fn lock(&self) -> MutexGuard<'_, State> {
        self.state.lock().unwrap_or_else(PoisonError::into_inner)
    }
}

/// `%USERPROFILE%\.webterminal\settings.json`, falling back to `HOME`; `None`
/// when neither names an absolute folder.
pub fn default_path() -> Option<PathBuf> {
    ["USERPROFILE", "HOME"]
        .into_iter()
        .filter_map(std::env::var_os)
        .map(PathBuf::from)
        .find(|home| home.is_absolute())
        .map(|home| home.join(".webterminal").join("settings.json"))
}

fn render(path: &Path, state: &State, notice: Option<&str>) -> String {
    let optional = |text: Option<&str>| text.map_or_else(|| "null".into(), json::quote);
    format!(
        "{{\"type\":\"settings\",\"revision\":{},\"settings\":{},\"path\":{},\"problem\":{},\"notice\":{}}}",
        state.revision,
        state.settings.json(),
        json::quote(&path.to_string_lossy()),
        optional(state.problem.as_deref()),
        optional(notice)
    )
}
