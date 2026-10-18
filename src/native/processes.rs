//! Bounded process snapshots of one session's private Job Object.
//!
//! Only processes assigned to the session's own job are inspected; nothing
//! enumerates system-wide processes, and every handle opened here is closed
//! before the call returns. Native calls:
//!
//! - `QueryInformationJobObject(JobObjectBasicProcessIdList)` (Kernel32) reads
//!   at most [`PROCESS_LIMIT`] identifiers from the job handle the session owns.
//! - `OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION)` (Kernel32) opens each
//!   identifier with the least query right, which normally suffices for the
//!   user's own processes. Identifiers that cannot be opened, for example
//!   because the process exited, are skipped.
//! - `IsProcessInJob` (Kernel32) guards against identifier reuse: a listed
//!   process can exit and its identifier can pass to an unrelated process
//!   before it is opened. The open handle pins the process it names, so a
//!   process confirmed in the job stays the one inspected.
//! - `GetExitCodeProcess`, `QueryFullProcessImageNameW` and `GetProcessTimes`
//!   (Kernel32) read liveness, the Win32 image path and the creation time.
//! - `NtQueryInformationProcess(ProcessBasicInformation)` (ntdll, documented in
//!   `winternl.h`) reads the creator's identifier. Creator identifiers are
//!   reused once the creator exits, so one is reported as the parent only when
//!   it is in the same snapshot and its process did not start after the child.

use super::super::{PROCESS_LIMIT, ProcessInfo, ProcessList};
use super::{GetExitCodeProcess, Handle, OwnedHandle, Pty, QueryInformationJobObject};
use std::ffi::{OsString, c_void};
use std::io;
use std::mem::size_of;
use std::os::windows::ffi::OsStringExt;
use std::ptr::null_mut;

const JOB_OBJECT_BASIC_PROCESS_ID_LIST: i32 = 3;
const PROCESS_BASIC_INFORMATION: u32 = 0;
const PROCESS_QUERY_LIMITED_INFORMATION: u32 = 0x1000;
const STILL_ACTIVE: u32 = 259;
const ERROR_MORE_DATA: i32 = 234;
/// UTF-16 units of the longest extended-length Win32 path.
const IMAGE_CAPACITY: usize = 32_768;
/// FILETIME ticks (100 ns) between 1601-01-01 and 1970-01-01.
const UNIX_EPOCH_TICKS: u64 = 116_444_736_000_000_000;

/// JOBOBJECT_BASIC_PROCESS_ID_LIST with a fixed identifier capacity.
#[repr(C)]
struct ProcessIdList {
    assigned: u32,
    listed: u32,
    ids: [usize; PROCESS_LIMIT],
}

/// PROCESS_BASIC_INFORMATION as documented for NtQueryInformationProcess.
#[repr(C)]
struct BasicInformation {
    exit_status: i32,
    peb: *mut c_void,
    affinity: usize,
    base_priority: i32,
    process_id: usize,
    creator_id: usize,
}

#[link(name = "kernel32")]
unsafe extern "system" {
    fn OpenProcess(access: u32, inherit: i32, process_id: u32) -> Handle;
    fn IsProcessInJob(process: Handle, job: Handle, result: *mut i32) -> i32;
    fn QueryFullProcessImageNameW(
        process: Handle,
        flags: u32,
        name: *mut u16,
        size: *mut u32,
    ) -> i32;
    // Each FILETIME is two little-endian u32 halves, read here as one u64.
    fn GetProcessTimes(
        process: Handle,
        creation: *mut u64,
        exit: *mut u64,
        kernel: *mut u64,
        user: *mut u64,
    ) -> i32;
}

#[link(name = "ntdll")]
unsafe extern "system" {
    fn NtQueryInformationProcess(
        process: Handle,
        class: u32,
        information: *mut c_void,
        length: u32,
        returned: *mut u32,
    ) -> i32;
}

struct JobIds {
    ids: Vec<u32>,
    total: u32,
    truncated: bool,
}

struct Inspected {
    info: ProcessInfo,
    creator: Option<u32>,
    created: Option<u64>,
}

impl Pty {
    /// Live processes of this session's job, root first, then by start time.
    /// `limit` is capped at [`PROCESS_LIMIT`]; `parent` refers only to an
    /// entry of the returned list.
    pub fn processes(&self, limit: usize) -> io::Result<ProcessList> {
        let job = job_ids(self.job.0)?;
        let mut image = vec![0u16; IMAGE_CAPACITY];
        let mut found: Vec<Inspected> = job
            .ids
            .iter()
            .filter_map(|&pid| inspect(self.job.0, pid, self.process_id, &mut image))
            .collect();
        found.sort_by_key(|entry| {
            let info = &entry.info;
            (!info.root, entry.created.is_none(), entry.created, info.pid)
        });
        let limit = limit.min(PROCESS_LIMIT);
        let truncated = job.truncated || found.len() > limit;
        found.truncate(limit);
        let starts: Vec<(u32, Option<u64>)> = found
            .iter()
            .map(|entry| (entry.info.pid, entry.created))
            .collect();
        let processes = found
            .into_iter()
            .map(|entry| {
                let mut info = entry.info;
                info.parent = entry.creator.filter(|&creator| {
                    starts.iter().any(|&(pid, started)| {
                        pid == creator
                            && matches!((started, entry.created), (Some(a), Some(b)) if a <= b)
                    })
                });
                info
            })
            .collect();
        Ok(ProcessList {
            processes,
            total: job.total,
            truncated,
        })
    }
}

fn job_ids(job: Handle) -> io::Result<JobIds> {
    let mut list = ProcessIdList {
        assigned: 0,
        listed: 0,
        ids: [0; PROCESS_LIMIT],
    };
    // SAFETY: the job handle is owned by the Pty; the buffer is a properly
    // aligned, fixed-size JOBOBJECT_BASIC_PROCESS_ID_LIST with its exact size.
    let ok = unsafe {
        QueryInformationJobObject(
            job,
            JOB_OBJECT_BASIC_PROCESS_ID_LIST,
            (&mut list as *mut ProcessIdList).cast(),
            size_of::<ProcessIdList>() as u32,
            null_mut(),
        )
    };
    let mut truncated = false;
    if ok == 0 {
        let error = io::Error::last_os_error();
        if error.raw_os_error() != Some(ERROR_MORE_DATA) {
            return Err(error);
        }
        truncated = true;
    }
    let listed = (list.listed as usize).min(PROCESS_LIMIT);
    truncated |= list.assigned as usize > listed;
    Ok(JobIds {
        ids: list.ids[..listed]
            .iter()
            .filter_map(|&id| u32::try_from(id).ok())
            .collect(),
        total: list.assigned,
        truncated,
    })
}

fn inspect(job: Handle, pid: u32, root: u32, image: &mut [u16]) -> Option<Inspected> {
    // SAFETY: plain values; OwnedHandle closes the returned handle.
    let process =
        OwnedHandle::new(unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid) }).ok()?;
    let mut in_job = 0;
    // SAFETY: both handles are open; the flag is a local out-parameter.
    if unsafe { IsProcessInJob(process.0, job, &mut in_job) } == 0 || in_job == 0 {
        return None;
    }
    let mut code = 0;
    // SAFETY: the process handle is open; the code is a local out-parameter.
    if unsafe { GetExitCodeProcess(process.0, &mut code) } == 0 || code != STILL_ACTIVE {
        return None;
    }
    let path = image_path(&process, image);
    let name = path
        .as_deref()
        .and_then(|path| path.rsplit('\\').next())
        .unwrap_or_default()
        .to_owned();
    let created = creation_ticks(&process);
    Some(Inspected {
        info: ProcessInfo {
            pid,
            parent: None,
            name,
            path,
            started_ms: created
                .and_then(|ticks| ticks.checked_sub(UNIX_EPOCH_TICKS))
                .map(|ticks| ticks / 10_000),
            root: pid == root,
        },
        creator: creator_id(&process),
        created,
    })
}

fn image_path(process: &OwnedHandle, buffer: &mut [u16]) -> Option<String> {
    let mut length = u32::try_from(buffer.len()).ok()?;
    // SAFETY: `length` is the buffer capacity in UTF-16 units on input and
    // the written length, excluding the terminator, on success.
    if unsafe { QueryFullProcessImageNameW(process.0, 0, buffer.as_mut_ptr(), &mut length) } == 0 {
        return None;
    }
    let units = buffer.get(..length as usize)?;
    Some(OsString::from_wide(units).to_string_lossy().into_owned())
}

fn creation_ticks(process: &OwnedHandle) -> Option<u64> {
    let (mut created, mut exited, mut kernel, mut user) = (0u64, 0u64, 0u64, 0u64);
    // SAFETY: each pointer is a local, sufficiently aligned FILETIME slot.
    let ok =
        unsafe { GetProcessTimes(process.0, &mut created, &mut exited, &mut kernel, &mut user) };
    (ok != 0 && created != 0).then_some(created)
}

fn creator_id(process: &OwnedHandle) -> Option<u32> {
    let mut info = BasicInformation {
        exit_status: 0,
        peb: null_mut(),
        affinity: 0,
        base_priority: 0,
        process_id: 0,
        creator_id: 0,
    };
    // SAFETY: the buffer is a local PROCESS_BASIC_INFORMATION of exact size.
    let status = unsafe {
        NtQueryInformationProcess(
            process.0,
            PROCESS_BASIC_INFORMATION,
            (&mut info as *mut BasicInformation).cast(),
            size_of::<BasicInformation>() as u32,
            null_mut(),
        )
    };
    if status < 0 {
        return None;
    }
    u32::try_from(info.creator_id).ok().filter(|&id| id != 0)
}
