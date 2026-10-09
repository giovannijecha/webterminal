//! Windows ConPTY and process ownership boundary.
//!
//! Requires Windows 10 1809 or Windows Server 2019 or newer. The only foreign
//! interface is Kernel32. The two synchronous pipes must be serviced on
//! separate threads; in particular, keep reading `output` through teardown.
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
