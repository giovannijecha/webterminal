//! Windows ConPTY and process ownership boundary.
//!
//! Requires Windows 10 1809 or Windows Server 2019 or newer. The foreign
//! interface is Kernel32, plus ntdll's documented `NtQueryInformationProcess`
//! for parent identifiers in process snapshots (see `native/processes.rs`).
//! The two synchronous pipes must be serviced on separate threads; in
//! particular, keep reading `output` through teardown.
//! Each spawned process joins a private, non-breakaway job before it resumes.
//! Closing that job on normal or abnormal server exit kills its descendants.
#![allow(unsafe_code)]

use std::fs::File;
#[cfg(not(windows))]
use std::io;
#[cfg(not(windows))]
use std::path::Path;
use std::sync::Arc;

#[cfg(windows)]
#[path = "native/windows.rs"]
mod windows;

#[cfg(windows)]
pub use windows::{Pty, install_shutdown_handler, logical_drives, shutdown_requested, spawn};

pub struct Spawned {
    pub pty: Arc<Pty>,
    pub input: File,
    pub output: File,
}

/// Most processes one snapshot inspects or returns per session.
pub const PROCESS_LIMIT: usize = 64;

/// One live process of a session's job, from `Pty::processes`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ProcessInfo {
    pub pid: u32,
    /// Creator, only when it is in the same list and started no later.
    pub parent: Option<u32>,
    /// Image file name; empty when the image path is unavailable.
    pub name: String,
    pub path: Option<String>,
    /// Creation time in Unix epoch milliseconds.
    pub started_ms: Option<u64>,
    /// The process the session started.
    pub root: bool,
}

/// A bounded snapshot of the processes in a session's job.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct ProcessList {
    pub processes: Vec<ProcessInfo>,
    /// Active processes the job reported, including any not listed.
    pub total: u32,
    /// Some live processes may be missing from `processes`.
    pub truncated: bool,
}

#[cfg(not(windows))]
pub struct Pty;

#[cfg(not(windows))]
impl Pty {
    pub fn resize(&self, _: u16, _: u16) -> io::Result<()> {
        unsupported()
    }
    pub fn terminate(&self) -> io::Result<()> {
        unsupported()
    }
    pub fn exit_code(&self) -> io::Result<Option<u32>> {
        unsupported()
    }
    pub fn wait_exit(&self) -> io::Result<u32> {
        unsupported()
    }
    pub fn active_processes(&self) -> io::Result<u32> {
        unsupported()
    }
    pub fn processes(&self, _: usize) -> io::Result<ProcessList> {
        unsupported()
    }
    pub fn process_id(&self) -> u32 {
        0
    }
}

#[cfg(not(windows))]
pub fn spawn(_: &str, _: &Path, _: u16, _: u16) -> io::Result<Spawned> {
    unsupported()
}
#[cfg(not(windows))]
pub fn install_shutdown_handler() -> io::Result<()> {
    unsupported()
}
#[cfg(not(windows))]
pub fn shutdown_requested() -> bool {
    false
}
#[cfg(not(windows))]
pub fn logical_drives() -> Vec<String> {
    Vec::new()
}
#[cfg(not(windows))]
fn unsupported<T>() -> io::Result<T> {
    Err(io::Error::new(
        io::ErrorKind::Unsupported,
        "ConPTY requires Windows",
    ))
}

/// Ordinary DOS/UNC spelling for shells and public paths; preserve OS strings.
/// Other verbatim namespaces are kept intact.
pub fn ordinary_path(path: &std::path::Path) -> std::path::PathBuf {
    #[cfg(windows)]
    {
        use std::ffi::OsString;
        use std::os::windows::ffi::{OsStrExt, OsStringExt};
        let units: Vec<u16> = path.as_os_str().encode_wide().collect();
        let prefix: Vec<u16> = r"\\?\".encode_utf16().collect();
        if let Some(rest) = units.strip_prefix(prefix.as_slice()) {
            if matches!(rest, [drive, 58, 92, ..] if (*drive as u8).is_ascii_alphabetic() && *drive < 128)
            {
                return OsString::from_wide(rest).into();
            }
            if let Some(share) = rest.strip_prefix(&[85, 78, 67, 92]) {
                let mut unc = vec![92, 92];
                unc.extend_from_slice(share);
                return OsString::from_wide(&unc).into();
            }
        }
    }
    path.to_path_buf()
}
