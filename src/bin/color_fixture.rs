//! Owned color-detection fixture. No credential stores or network services.
#![allow(dead_code)]
#[path = "../native.rs"]
mod native;

use std::io::{self, BufRead, IsTerminal, Read, Write};
use std::process::{Command, ExitCode};
use std::time::{Duration, Instant};

const TERMINAL_VARS: [&str; 7] = [
    "TERM",
    "COLORTERM",
    "TERM_PROGRAM",
    "NO_COLOR",
    "CLICOLOR",
    "CLICOLOR_FORCE",
    "FORCE_COLOR",
];

fn main() -> ExitCode {
    match std::env::args().nth(1).as_deref() {
        Some("--host") | Some("--host-user-no-color") => host(),
        Some("--user-no-color") => {
            let status = Command::new(std::env::current_exe().unwrap())
                .arg("--probe")
                .env("NO_COLOR", "1")
                .status()
                .unwrap();
            ExitCode::from(status.code().unwrap_or(1) as u8)
        }
        Some("--probe") => {
            report();
            paint();
            ExitCode::SUCCESS
        }
        Some("--interactive") => {
            report();
            paint();
            for line in io::stdin().lock().lines() {
                match line.unwrap().trim() {
                    "paint" => paint(),
                    "scroll" => {
                        for n in 0..80 {
                            println!("scroll {n}");
                        }
                        paint();
                    }
                    "alternate" => {
                        print!("\x1b[?1049h");
                        paint();
                    }
                    "primary" => print!("\x1b[?1049l"),
                    "exit" => break,
                    _ => {}
                }
                io::stdout().flush().unwrap();
            }
            ExitCode::SUCCESS
        }
        _ => {
            eprintln!("Usage: color_fixture --host|--host-user-no-color|--probe|--interactive");
            ExitCode::FAILURE
        }
    }
}

fn colors_enabled() -> bool {
    io::stdout().is_terminal()
        && std::env::var("TERM").is_ok_and(|value| value == "xterm-256color")
        && std::env::var("COLORTERM").is_ok_and(|value| value == "truecolor")
        && std::env::var_os("NO_COLOR").is_none()
        && std::env::var_os("CLICOLOR").is_none_or(|value| value != "0")
        && std::env::var_os("FORCE_COLOR").is_none_or(|value| value != "0")
}

fn report() {
    // Only terminal capability variables and an explicitly owned marker.
    for name in TERMINAL_VARS {
        println!("{name}={}", std::env::var(name).unwrap_or_default());
    }
    if let Ok(marker) = std::env::var("WEBTERMINAL_COLOR_FIXTURE") {
        println!("FIXTURE_MARKER={marker}");
    }
    println!("COLOR_ENABLED={}", colors_enabled());
}

fn paint() {
    if !colors_enabled() {
        println!("PLAIN_OUTPUT");
    } else {
        for n in 0..8 {
            print!("\x1b[{}mNORMAL_{n} \x1b[0m", 30 + n);
        }
        println!();
        for n in 0..8 {
            print!("\x1b[{}mBRIGHT_{n} \x1b[0m", 90 + n);
        }
        println!();
        println!("\x1b[38;5;196mINDEXED_RED\x1b[0m");
        println!("\x1b[38;2;17;34;51mRGB_TEXT\x1b[0m");
        println!("\x1b[48;2;26;43;60mRGB_BACKGROUND\x1b[0m");
        println!("\x1b[31;7mINVERSE_RED\x1b[0m");
        println!("\x1b[32mUNICODE_é_界_👩‍💻\x1b[0m");
        println!("DEFAULT_TEXT");
    }
    println!("PAINT_END");
    io::stdout().flush().unwrap();
}

fn host() -> ExitCode {
    let before: Vec<_> = TERMINAL_VARS.iter().map(std::env::var_os).collect();
    let exe = std::env::current_exe().unwrap();
    let mode = if std::env::args().nth(1).as_deref() == Some("--host-user-no-color") {
        "--user-no-color"
    } else {
        "--probe"
    };
    let command = format!("\"{}\" {mode}", exe.display());
    let spawned = native::spawn(&command, exe.parent().unwrap(), 120, 30).unwrap();
    let reader = std::thread::spawn(move || {
        let mut bytes = Vec::new();
        let mut output = spawned.output;
        output.read_to_end(&mut bytes).unwrap();
        bytes
    });
    let until = Instant::now() + Duration::from_secs(10);
    let code = loop {
        if let Some(code) = spawned.pty.exit_code().unwrap() {
            break code;
        }
        if Instant::now() >= until {
            spawned.pty.terminate().unwrap();
            panic!("color fixture did not exit");
        }
        std::thread::sleep(Duration::from_millis(10));
    };
    spawned.pty.terminate().unwrap();
    io::stdout().write_all(&reader.join().unwrap()).unwrap();
    assert_eq!(
        before,
        TERMINAL_VARS
            .iter()
            .map(std::env::var_os)
            .collect::<Vec<_>>()
    );
    println!("PARENT_ENV_UNCHANGED");
    ExitCode::from(code as u8)
}
