use super::Spawned;
#[path = "environment.rs"]
mod environment;
use std::ffi::{OsStr, c_void};
use std::fs::File;
use std::io;
use std::mem::{size_of, zeroed};
use std::os::windows::ffi::OsStrExt;
use std::os::windows::io::FromRawHandle;
use std::path::Path;
use std::ptr::{null, null_mut};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};

type Handle = *mut c_void;
const CREATE_SUSPENDED: u32 = 0x0000_0004;
const CREATE_UNICODE_ENVIRONMENT: u32 = 0x0000_0400;
const EXTENDED_STARTUPINFO_PRESENT: u32 = 0x0008_0000;
const PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE: usize = 0x0002_0016;
const STARTF_USESTDHANDLES: u32 = 0x0000_0100;
const JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE: u32 = 0x0000_2000;
const JOB_OBJECT_EXTENDED_LIMIT_INFORMATION: i32 = 9;
const WAIT_OBJECT_0: u32 = 0;
const WAIT_FAILED: u32 = 0xffff_ffff;
const CTRL_C_EVENT: u32 = 0;
const CTRL_BREAK_EVENT: u32 = 1;
static SHUTDOWN: AtomicBool = AtomicBool::new(false);
static HANDLER: OnceLock<Result<(), i32>> = OnceLock::new();

#[repr(C)]
#[derive(Clone, Copy)]
struct Coord {
    x: i16,
    y: i16,
}

#[repr(C)]
struct StartupInfoW {
    cb: u32,
    reserved: *mut u16,
    desktop: *mut u16,
    title: *mut u16,
    x: u32,
    y: u32,
    x_size: u32,
    y_size: u32,
    x_count_chars: u32,
    y_count_chars: u32,
    fill_attribute: u32,
    flags: u32,
    show_window: u16,
    reserved2: u16,
    reserved2_ptr: *mut u8,
    stdin: Handle,
    stdout: Handle,
    stderr: Handle,
}
#[repr(C)]
struct StartupInfoExW {
    startup: StartupInfoW,
    attributes: *mut c_void,
}
#[repr(C)]
struct ProcessInformation {
    process: Handle,
    thread: Handle,
    process_id: u32,
    thread_id: u32,
}
#[repr(C)]
#[derive(Default)]
struct IoCounters {
    read_operations: u64,
    write_operations: u64,
    other_operations: u64,
    read_transfer: u64,
    write_transfer: u64,
    other_transfer: u64,
}
#[repr(C)]
#[derive(Default)]
struct BasicLimitInformation {
    per_process_user_time_limit: i64,
    per_job_user_time_limit: i64,
    limit_flags: u32,
    minimum_working_set_size: usize,
    maximum_working_set_size: usize,
    active_process_limit: u32,
    affinity: usize,
    priority_class: u32,
    scheduling_class: u32,
}
#[repr(C)]
#[derive(Default)]
struct ExtendedLimitInformation {
    basic: BasicLimitInformation,
    io: IoCounters,
    process_memory_limit: usize,
    job_memory_limit: usize,
    peak_process_memory_used: usize,
    peak_job_memory_used: usize,
}

#[link(name = "kernel32")]
unsafe extern "system" {
    fn CreatePipe(read: *mut Handle, write: *mut Handle, security: *const c_void, size: u32)
    -> i32;
    fn CloseHandle(handle: Handle) -> i32;
    fn CreatePseudoConsole(
        size: Coord,
        input: Handle,
        output: Handle,
        flags: u32,
        console: *mut Handle,
    ) -> i32;
    fn ResizePseudoConsole(console: Handle, size: Coord) -> i32;
    fn ClosePseudoConsole(console: Handle);
    fn InitializeProcThreadAttributeList(
        list: *mut c_void,
        count: u32,
        flags: u32,
        size: *mut usize,
    ) -> i32;
    fn UpdateProcThreadAttribute(
        list: *mut c_void,
        flags: u32,
        attribute: usize,
        value: *mut c_void,
        size: usize,
        previous: *mut c_void,
        return_size: *mut usize,
    ) -> i32;
    fn DeleteProcThreadAttributeList(list: *mut c_void);
    fn CreateProcessW(
        application: *const u16,
        command: *mut u16,
        process_security: *const c_void,
        thread_security: *const c_void,
        inherit: i32,
        flags: u32,
        environment: *const c_void,
        directory: *const u16,
        startup: *const StartupInfoW,
        info: *mut ProcessInformation,
    ) -> i32;
    fn CreateJobObjectW(security: *const c_void, name: *const u16) -> Handle;
    fn SetInformationJobObject(
        job: Handle,
        class: i32,
        information: *const c_void,
        length: u32,
    ) -> i32;
    fn AssignProcessToJobObject(job: Handle, process: Handle) -> i32;
    fn QueryInformationJobObject(
        job: Handle,
        class: i32,
        information: *mut c_void,
        length: u32,
        returned: *mut u32,
    ) -> i32;
    fn TerminateJobObject(job: Handle, exit_code: u32) -> i32;
    fn TerminateProcess(process: Handle, exit_code: u32) -> i32;
    fn ResumeThread(thread: Handle) -> u32;
    fn WaitForSingleObject(handle: Handle, milliseconds: u32) -> u32;
    fn GetExitCodeProcess(process: Handle, exit_code: *mut u32) -> i32;
    fn SetConsoleCtrlHandler(
        handler: Option<unsafe extern "system" fn(u32) -> i32>,
        add: i32,
    ) -> i32;
    fn GetLastError() -> u32;
    fn GetLogicalDrives() -> u32;
}

/// Root paths of the drive letters currently defined, such as `C:\`.
/// Drives are listed without probing, so a disconnected share cannot block.
pub fn logical_drives() -> Vec<String> {
    // SAFETY: GetLogicalDrives takes no arguments and returns a bitmask.
    let mask = unsafe { GetLogicalDrives() };
    (0..26u8)
        .filter(|bit| mask & (1 << bit) != 0)
        .map(|bit| format!("{}:\\", char::from(b'A' + bit)))
        .collect()
}

struct OwnedHandle(Handle);
// A Windows HANDLE is a process-wide, kernel-managed reference. All uses below
// either synchronize through `Pty::console` or call thread-safe Win32 APIs.
unsafe impl Send for OwnedHandle {}
unsafe impl Sync for OwnedHandle {}
impl OwnedHandle {
    fn new(raw: Handle) -> io::Result<Self> {
        if raw.is_null() || raw as isize == -1 {
            Err(io::Error::last_os_error())
        } else {
            Ok(Self(raw))
        }
    }
    fn into_file(mut self) -> File {
        let raw = std::mem::replace(&mut self.0, null_mut());
        // SAFETY: this transfers sole ownership of a valid pipe HANDLE to File.
        unsafe { File::from_raw_handle(raw) }
    }
}
impl Drop for OwnedHandle {
    fn drop(&mut self) {
        if !self.0.is_null() {
            unsafe {
                CloseHandle(self.0);
            }
        }
    }
}

struct Console(Handle);
// Closing a pseudoconsole can emit final output and block until it is drained.
// The caller must keep its output reader running through the close operation.
unsafe impl Send for Console {}
impl Drop for Console {
    fn drop(&mut self) {
        unsafe {
            ClosePseudoConsole(self.0);
        }
    }
}

struct AttributeList {
    storage: Vec<usize>,
}
impl AttributeList {
    fn new(console: Handle) -> io::Result<Self> {
        let mut bytes = 0;
        unsafe {
            InitializeProcThreadAttributeList(null_mut(), 1, 0, &mut bytes);
        }
        if bytes == 0 {
            return Err(io::Error::last_os_error());
        }
        // Vec<usize> gives pointer alignment; byte arithmetic rounds up to a
        // whole word. The Win32 buffer remains fixed while initialized.
        let mut storage = vec![0usize; bytes.div_ceil(size_of::<usize>())];
        let list = storage.as_mut_ptr().cast();
        check_bool(unsafe { InitializeProcThreadAttributeList(list, 1, 0, &mut bytes) })?;
        let mut result = Self { storage };
        check_bool(unsafe {
            UpdateProcThreadAttribute(
                result.as_mut_ptr(),
                0,
                PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE,
                console,
                size_of::<Handle>(),
                null_mut(),
                null_mut(),
            )
        })?;
        Ok(result)
    }
    fn as_mut_ptr(&mut self) -> *mut c_void {
        self.storage.as_mut_ptr().cast()
    }
}
impl Drop for AttributeList {
    fn drop(&mut self) {
        unsafe {
            DeleteProcThreadAttributeList(self.as_mut_ptr());
        }
    }
}

pub struct Pty {
    // This lock serializes resize with detaching the HPCON for closure.
    console: Mutex<Option<Console>>,
    job: OwnedHandle,
    process: OwnedHandle,
    process_id: u32,
}

impl Pty {
    pub fn process_id(&self) -> u32 {
        self.process_id
    }

    pub fn resize(&self, cols: u16, rows: u16) -> io::Result<()> {
        let size = coord(cols, rows)?;
        let guard = self.console.lock().unwrap_or_else(|e| e.into_inner());
        let console = guard
            .as_ref()
            .ok_or_else(|| io::Error::new(io::ErrorKind::BrokenPipe, "pseudoconsole closed"))?;
        check_hresult(unsafe { ResizePseudoConsole(console.0, size) })
    }

    pub fn exit_code(&self) -> io::Result<Option<u32>> {
        match unsafe { WaitForSingleObject(self.process.0, 0) } {
            WAIT_OBJECT_0 => {
                let mut code = 0;
                check_bool(unsafe { GetExitCodeProcess(self.process.0, &mut code) })?;
                Ok(Some(code))
            }
            0x102 => Ok(None), // WAIT_TIMEOUT; avoids the STILL_ACTIVE exit-code ambiguity.
            WAIT_FAILED => Err(io::Error::last_os_error()),
            other => Err(io::Error::other(format!(
                "unexpected process wait result: {other}"
            ))),
        }
    }

    /// Processes alive in the job; the shell alone means the terminal is idle.
    pub fn active_processes(&self) -> io::Result<u32> {
        // JOBOBJECT_BASIC_ACCOUNTING_INFORMATION: four times, then four counters.
        let mut info = [0u64; 6];
        check_bool(unsafe {
            QueryInformationJobObject(self.job.0, 1, info.as_mut_ptr().cast(), 48, null_mut())
        })?;
        Ok(info[5] as u32)
    }

    pub fn terminate(&self) -> io::Result<()> {
        let result = check_bool(unsafe { TerminateJobObject(self.job.0, 1) });
        let console = self
            .console
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .take();
        if let Some(console) = console {
            // ClosePseudoConsole can synchronously write a final frame. Closing
            // on a separate thread keeps session teardown responsive while the
            // independent output reader drains the pipe until EOF.
            std::thread::spawn(move || drop(console));
        }
        result
    }
}
impl Drop for Pty {
    fn drop(&mut self) {
        let _ = self.terminate();
    }
}

pub fn spawn(command: &str, cwd: &Path, cols: u16, rows: u16) -> io::Result<Spawned> {
    let size = coord(cols, rows)?;
    if command.trim().is_empty() || command.contains('\0') {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "invalid command line",
        ));
    }
    let mut command = wide(OsStr::new(command))?;
    let directory = process_directory(cwd)?;
    let environment = environment::for_terminal()?;
    let (input_read, input_write) = pipe()?;
    let (output_read, output_write) = pipe()?;
    let mut raw_console = null_mut();
    check_hresult(unsafe {
        CreatePseudoConsole(size, input_read.0, output_write.0, 0, &mut raw_console)
    })?;
    let console = Console(raw_console);
    let mut attributes = AttributeList::new(console.0)?;
    let mut startup: StartupInfoExW = unsafe { zeroed() };
    startup.startup.cb = size_of::<StartupInfoExW>() as u32;
    // With redirected server stdio, explicitly clear the child's standard
    // handles so the attached console supplies its own three handles.
    startup.startup.flags = STARTF_USESTDHANDLES;
    startup.attributes = attributes.as_mut_ptr();
    let mut info: ProcessInformation = unsafe { zeroed() };
    check_bool(unsafe {
        CreateProcessW(
            null(),
            command.as_mut_ptr(),
            null(),
            null(),
            0,
            CREATE_SUSPENDED | CREATE_UNICODE_ENVIRONMENT | EXTENDED_STARTUPINFO_PRESENT,
            environment.as_ptr().cast(),
            directory.as_ptr(),
            &startup.startup,
            &mut info,
        )
    })?;
    let process = OwnedHandle::new(info.process)?;
    let thread = OwnedHandle::new(info.thread)?;
    let job = match create_job() {
        Ok(job) => job,
        Err(error) => {
            unsafe {
                TerminateProcess(process.0, 1);
            }
            return Err(error);
        }
    };
    if let Err(error) = check_bool(unsafe { AssignProcessToJobObject(job.0, process.0) }) {
        unsafe {
            TerminateProcess(process.0, 1);
        }
        return Err(error);
    }
    // ConPTY holds its own copies. Releasing ours allows EOF after closure.
    if unsafe { ResumeThread(thread.0) } == u32::MAX {
        let error = io::Error::last_os_error();
        unsafe {
            TerminateJobObject(job.0, 1);
        }
        return Err(error);
    }
    drop(input_read);
    drop(output_write);
    drop(thread);
    drop(attributes);
    Ok(Spawned {
        pty: Arc::new(Pty {
            console: Mutex::new(Some(console)),
            job,
            process,
            process_id: info.process_id,
        }),
        input: input_write.into_file(),
        output: output_read.into_file(),
    })
}

fn pipe() -> io::Result<(OwnedHandle, OwnedHandle)> {
    let (mut read, mut write) = (null_mut(), null_mut());
    check_bool(unsafe { CreatePipe(&mut read, &mut write, null(), 0) })?;
    Ok((OwnedHandle::new(read)?, OwnedHandle::new(write)?))
}
fn create_job() -> io::Result<OwnedHandle> {
    let job = OwnedHandle::new(unsafe { CreateJobObjectW(null(), null()) })?;
    let mut limits = ExtendedLimitInformation::default();
    limits.basic.limit_flags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
    check_bool(unsafe {
        SetInformationJobObject(
            job.0,
            JOB_OBJECT_EXTENDED_LIMIT_INFORMATION,
            (&limits as *const ExtendedLimitInformation).cast(),
            size_of::<ExtendedLimitInformation>() as u32,
        )
    })?;
    Ok(job)
}
fn coord(cols: u16, rows: u16) -> io::Result<Coord> {
    if cols == 0 || rows == 0 || cols > i16::MAX as u16 || rows > i16::MAX as u16 {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "terminal dimensions out of range",
        ));
    }
    Ok(Coord {
        x: cols as i16,
        y: rows as i16,
    })
}
fn process_directory(cwd: &Path) -> io::Result<Vec<u16>> {
    let encoded = wide(cwd.as_os_str())?;
    // canonicalize() normally returns a verbatim path on Windows. cmd.exe
    // treats that spelling as a UNC current directory and silently switches
    // to C:\Windows, even though CreateProcessW accepts it. Pass the ordinary
    // DOS/UNC spelling so the child starts in the selected directory.
    if encoded.starts_with(&[b'\\' as u16, b'\\' as u16, b'?' as u16, b'\\' as u16]) {
        if encoded.get(5) == Some(&(b':' as u16)) && encoded.get(6) == Some(&(b'\\' as u16)) {
            return Ok(encoded[4..].to_vec());
        }
        if encoded[4..].starts_with(&[b'U' as u16, b'N' as u16, b'C' as u16, b'\\' as u16]) {
            let mut ordinary = vec![b'\\' as u16, b'\\' as u16];
            ordinary.extend_from_slice(&encoded[8..]);
            return Ok(ordinary);
        }
    }
    Ok(encoded)
}
fn wide(value: &OsStr) -> io::Result<Vec<u16>> {
    let mut encoded: Vec<u16> = value.encode_wide().collect();
    if encoded.contains(&0) {
        return Err(io::Error::new(io::ErrorKind::InvalidInput, "embedded NUL"));
    }
    encoded.push(0);
    Ok(encoded)
}
fn check_bool(value: i32) -> io::Result<()> {
    if value == 0 {
        Err(io::Error::last_os_error())
    } else {
        Ok(())
    }
}
fn check_hresult(value: i32) -> io::Result<()> {
    if value >= 0 {
        Ok(())
    } else {
        // HRESULT_FROM_WIN32 embeds the Win32 code in the low word.
        if (value as u32 & 0xffff_0000) == 0x8007_0000 {
            Err(io::Error::from_raw_os_error((value as u32 & 0xffff) as i32))
        } else {
            Err(io::Error::other(format!(
                "ConPTY HRESULT 0x{:08x}",
                value as u32
            )))
        }
    }
}

unsafe extern "system" fn console_handler(kind: u32) -> i32 {
    if kind == CTRL_C_EVENT || kind == CTRL_BREAK_EVENT {
        SHUTDOWN.store(true, Ordering::SeqCst);
        1
    } else {
        0
    }
}
pub fn install_shutdown_handler() -> io::Result<()> {
    let result = HANDLER.get_or_init(|| {
        if unsafe { SetConsoleCtrlHandler(Some(console_handler), 1) } == 0 {
            Err(unsafe { GetLastError() } as i32)
        } else {
            Ok(())
        }
    });
    result.map_err(io::Error::from_raw_os_error)
}
pub fn shutdown_requested() -> bool {
    SHUTDOWN.load(Ordering::SeqCst)
}
