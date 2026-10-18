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
#[allow(unused_imports)] // Included as a private module by native fixture tests.
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
