//! Test-only inspection of console input records and VT input bytes.
#![allow(unsafe_code)]

use std::ffi::c_void;
use std::io;
use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle};

type Handle = *mut c_void;
#[repr(C, align(4))]
struct InputRecord {
    kind: u16,
    _padding: u16,
    event: [u8; 16],
}

#[link(name = "kernel32")]
unsafe extern "system" {
    fn CreateFileW(
        name: *const u16,
        access: u32,
        share: u32,
        security: *mut c_void,
        creation: u32,
        flags: u32,
        template: Handle,
    ) -> Handle;
    fn GetStdHandle(which: u32) -> Handle;
    fn GetConsoleMode(console: Handle, mode: *mut u32) -> i32;
    fn SetConsoleMode(console: Handle, mode: u32) -> i32;
    fn SetConsoleCP(code_page: u32) -> i32;
    fn ReadFile(
        file: Handle,
        buffer: *mut u8,
        count: u32,
        read: *mut u32,
        overlapped: *mut c_void,
    ) -> i32;
    fn ReadConsoleInputW(
        input: Handle,
        records: *mut InputRecord,
        count: u32,
        read: *mut u32,
    ) -> i32;
}

pub fn inspect_mouse_records() -> io::Result<()> {
    let name: Vec<u16> = "CONIN$".encode_utf16().chain(Some(0)).collect();
    let raw = unsafe {
        CreateFileW(
            name.as_ptr(),
            0xc000_0000,
            3,
            std::ptr::null_mut(),
            3,
            0,
            std::ptr::null_mut(),
        )
    };
    if raw.is_null() || raw as isize == -1 {
        return Err(io::Error::last_os_error());
    }
    let input = unsafe { OwnedHandle::from_raw_handle(raw) };
    let handle = input.as_raw_handle();
    let mut mode = 0;
    if unsafe { GetConsoleMode(handle, &mut mode) } == 0 {
        return Err(io::Error::last_os_error());
    }
    // Match Jecode's Win32 record mode: no processed/line/echo/quick-edit/VT
    // input, with mouse, window, and extended input flags enabled.
    if unsafe { SetConsoleMode(handle, (mode & !0x247) | 0x98) } == 0 {
        return Err(io::Error::last_os_error());
    }
    print!("\x1b[?1000h\x1b[?1006hMOUSE_RECORDS_READY\r\n");
    use std::io::Write;
    io::stdout().flush()?;
    loop {
        let mut record = InputRecord {
            kind: 0,
            _padding: 0,
            event: [0; 16],
        };
        let mut read = 0;
        if unsafe { ReadConsoleInputW(handle, &mut record, 1, &mut read) } == 0 {
            return Err(io::Error::last_os_error());
        }
        if read != 1 {
            continue;
        }
        if record.kind == 2 {
            let x = i16::from_ne_bytes(record.event[0..2].try_into().unwrap());
            let y = i16::from_ne_bytes(record.event[2..4].try_into().unwrap());
            let buttons = u32::from_ne_bytes(record.event[4..8].try_into().unwrap());
            let flags = u32::from_ne_bytes(record.event[12..16].try_into().unwrap());
            println!("MOUSE {x} {y} {buttons} {flags}");
        } else if record.kind == 1 {
            let down = u32::from_ne_bytes(record.event[0..4].try_into().unwrap());
            let key = u16::from_ne_bytes(record.event[6..8].try_into().unwrap());
            let unicode = u16::from_ne_bytes(record.event[10..12].try_into().unwrap());
            println!("KEY {down} {key} {unicode}");
            if down != 0 && unicode == b'q' as u16 {
                break;
            }
        } else {
            println!("RECORD {}", record.kind);
        }
        io::stdout().flush()?;
    }
    Ok(())
}

pub fn inspect_mouse_vt() -> io::Result<()> {
    let input = unsafe { GetStdHandle((-10i32) as u32) };
    if input.is_null() || input as isize == -1 {
        return Err(io::Error::last_os_error());
    }
    let mut mode = 0;
    if unsafe { GetConsoleMode(input, &mut mode) } == 0 {
        return Err(io::Error::last_os_error());
    }
    if unsafe { SetConsoleCP(65001) } == 0 {
        return Err(io::Error::last_os_error());
    }
    if unsafe { SetConsoleMode(input, (mode | 0x200) & !(0x2 | 0x4)) } == 0 {
        return Err(io::Error::last_os_error());
    }
    print!("\x1b[?1000hVT_READY\r\n");
    use std::io::Write;
    io::stdout().flush()?;
    loop {
        let mut buffer = [0u8; 64];
        let mut read = 0;
        if unsafe {
            ReadFile(
                input,
                buffer.as_mut_ptr(),
                buffer.len() as u32,
                &mut read,
                std::ptr::null_mut(),
            )
        } == 0
        {
            return Err(io::Error::last_os_error());
        }
        if read == 0 {
            return Err(io::Error::new(
                io::ErrorKind::UnexpectedEof,
                "VT input closed",
            ));
        }
        let data = &buffer[..read as usize];
        print!("VT");
        for byte in data {
            print!(" {byte:02X}");
        }
        println!();
        io::stdout().flush()?;
        if data.contains(&b'q') {
            break;
        }
    }
    Ok(())
}

pub fn verify_two_keys() -> io::Result<()> {
    let input = unsafe { GetStdHandle((-10i32) as u32) };
    if input.is_null() || input as isize == -1 {
        return Err(io::Error::last_os_error());
    }
    println!("RECORDS_READY");
    let mut found = 0;
    while found < 2 {
        let mut record = InputRecord {
            kind: 0,
            _padding: 0,
            event: [0; 16],
        };
        let mut read = 0;
        if unsafe { ReadConsoleInputW(input, &mut record, 1, &mut read) } == 0 {
            return Err(io::Error::last_os_error());
        }
        if read != 1 || record.kind != 1 {
            continue;
        }
        let down = u32::from_ne_bytes(record.event[0..4].try_into().unwrap());
        if down == 0 {
            continue;
        }
        let key = u16::from_ne_bytes(record.event[6..8].try_into().unwrap());
        if key != 13 && key != 32 {
            continue;
        }
        let unicode = u16::from_ne_bytes(record.event[10..12].try_into().unwrap());
        let modifiers = u32::from_ne_bytes(record.event[12..16].try_into().unwrap());
        println!("KEY {key} {unicode} {modifiers}");
        found += 1;
    }
    Ok(())
}
