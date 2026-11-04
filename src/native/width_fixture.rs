//! Test-only console width measurements. Kernel32 reads the cursor after each
//! flushed glyph; no width table or browser font is used as the native oracle.
#![allow(unsafe_code)]

use std::ffi::c_void;
use std::io::{self, Write};

type Handle = *mut c_void;
#[repr(C)]
#[derive(Default)]
struct Coord {
    x: i16,
    y: i16,
}
#[repr(C)]
#[derive(Default)]
struct Rect {
    left: i16,
    top: i16,
    right: i16,
    bottom: i16,
}
#[repr(C)]
#[derive(Default)]
struct BufferInfo {
    size: Coord,
    cursor: Coord,
    attributes: u16,
    window: Rect,
    maximum: Coord,
}

#[link(name = "kernel32")]
unsafe extern "system" {
    fn GetStdHandle(which: u32) -> Handle;
    fn GetConsoleScreenBufferInfo(output: Handle, info: *mut BufferInfo) -> i32;
    fn GetConsoleMode(console: Handle, mode: *mut u32) -> i32;
    fn SetConsoleMode(console: Handle, mode: u32) -> i32;
    fn SetConsoleOutputCP(code_page: u32) -> i32;
}

fn info() -> io::Result<BufferInfo> {
    let mut info = BufferInfo::default();
    // GetStdHandle returns a borrowed handle owned by this fixture's console.
    let output = unsafe { GetStdHandle((-11i32) as u32) };
    if unsafe { GetConsoleScreenBufferInfo(output, &mut info) } == 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(info)
}

pub fn columns() -> io::Result<usize> {
    Ok(info()?.size.x as usize)
}

pub fn prepare() -> io::Result<()> {
    let input = unsafe { GetStdHandle((-10i32) as u32) };
    let output = unsafe { GetStdHandle((-11i32) as u32) };
    let mut mode = 0;
    if unsafe { GetConsoleMode(input, &mut mode) } == 0
        || unsafe { SetConsoleMode(input, mode & !0x4) } == 0
        || unsafe { GetConsoleMode(output, &mut mode) } == 0
        || unsafe { SetConsoleMode(output, mode | 0x4) } == 0
        || unsafe { SetConsoleOutputCP(65001) } == 0
    {
        return Err(io::Error::last_os_error());
    }
    Ok(())
}

pub fn measure() -> io::Result<()> {
    prepare()?;
    let mut measurements = Vec::new();
    // Trigrams, monograms/digrams, hexagrams, Tai Xuan Jing and counting rods.
    // All acquired East Asian Wide in Unicode 16; inspect the whole families.
    for (start, end) in [
        (0x2630, 0x2637),
        (0x268a, 0x268f),
        (0x4dc0, 0x4dff),
        (0x1d300, 0x1d356),
        (0x1d360, 0x1d376),
    ] {
        for code in start..=end {
            let ch = char::from_u32(code).unwrap();
            print!("\x1b[1;1H{ch}");
            io::stdout().flush()?;
            measurements.push((code, info()?.cursor.x));
        }
    }
    print!("\x1b[2J\x1b[H");
    for (code, width) in measurements {
        println!("WIDTH U+{code:04X}={width}\r");
    }
    io::stdout().flush()
}
