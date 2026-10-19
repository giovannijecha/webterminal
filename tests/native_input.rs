//! Console input across the ConPTY boundary: keys, pastes, replies and mouse.
#![cfg(windows)]
#![allow(dead_code)]
mod conpty;

use conpty::{await_exit, collect, collect_lines, collect_until, command, fixture, scratch};
use std::fs;
use std::io::Write;
use std::path::Path;
use std::sync::mpsc;
use std::time::{Duration, Instant};
use webterminal::native;

#[test]
fn win32_input_mode_preserves_modified_keys() {
    let dir = scratch();
    let mut spawned = native::spawn(&command("--records", None), &dir, 80, 24).unwrap();
    let output = collect(spawned.output);
    // Win32 input mode CSI: virtual key, scan code, Unicode, key down,
    // control state, repeat. Shift+Enter and Ctrl+Space are ambiguous as
    // ordinary text bytes, so inspect the child's actual INPUT_RECORDs.
    spawned
        .input
        .write_all(b"\x1b[13;28;13;1;16;1_\x1b[32;57;0;1;8;1_")
        .unwrap();
    let code = await_exit(&spawned.pty);
    spawned.pty.terminate().unwrap();
    let text = String::from_utf8(output.recv_timeout(Duration::from_secs(10)).unwrap()).unwrap();
    assert_eq!(code, 0, "{text:?}");
    assert!(text.contains("KEY 13 13 16"), "{text:?}");
    assert!(text.contains("KEY 32 0 8"), "{text:?}");
    fs::remove_dir(dir).unwrap();
}

fn paste_records(input: &[u8]) -> String {
    let dir = scratch();
    let mut spawned = native::spawn(&command("--paste-records", None), &dir, 80, 24).unwrap();
    let (ready, output) = collect_until(spawned.output, b"PASTE_READY");
    ready
        .recv_timeout(Duration::from_secs(5))
        .expect("paste records fixture was not ready");
    spawned.input.write_all(input).unwrap();
    let code = await_exit(&spawned.pty);
    spawned.pty.terminate().unwrap();
    let text = String::from_utf8(output.recv_timeout(Duration::from_secs(10)).unwrap()).unwrap();
    assert_eq!(code, 0, "{text:?}");
    fs::remove_dir(dir).unwrap();
    text.lines()
        .filter(|line| line.contains("KEY "))
        .map(|line| line.trim_start_matches(|c: char| c != 'K'))
        .collect::<Vec<_>>()
        .join(" | ")
}

fn paste_vt(input: &[u8]) -> String {
    let dir = scratch();
    let mut spawned = native::spawn(&command("--mouse-vt", None), &dir, 80, 24).unwrap();
    let (ready, output) = collect_until(spawned.output, b"VT_READY");
    ready
        .recv_timeout(Duration::from_secs(5))
        .expect("VT input fixture was not ready");
    spawned.input.write_all(input).unwrap();
    let code = await_exit(&spawned.pty);
    spawned.pty.terminate().unwrap();
    let text = String::from_utf8_lossy(&output.recv_timeout(Duration::from_secs(10)).unwrap())
        .into_owned();
    assert_eq!(code, 0, "{text:?}");
    fs::remove_dir(dir).unwrap();
    text.lines()
        .filter_map(|line| line.rfind("VT ").map(|start| &line[start + 3..]))
        .collect::<Vec<_>>()
        .join(" ")
}

#[test]
fn observe_color_queries_at_the_conpty_boundary() {
    // The child sends OSC 10/11/4 queries and DA1, then reports its VT input.
    // Only the CSI reply path is asserted; whether ConPTY forwards the queries
    // and their OSC replies depends on the Windows console host, so observe it.
    let dir = scratch();
    let mut spawned = native::spawn(&command("--color-queries", None), &dir, 80, 24).unwrap();
    let (ready, output) = collect_until(spawned.output, b"VT_READY");
    ready
        .recv_timeout(Duration::from_secs(5))
        .expect("color query fixture was not ready");
    for reply in [
        &b"\x1b]4;1;rgb:cdcd/3131/3131\x1b\\"[..],
        b"\x1b]11;rgb:0c0c/0c0c/0c0c\x07",
        b"\x1b[?62c",
    ] {
        spawned.input.write_all(reply).unwrap();
        std::thread::sleep(Duration::from_millis(200));
    }
    spawned.input.write_all(b"q").unwrap();
    let code = await_exit(&spawned.pty);
    spawned.pty.terminate().unwrap();
    let bytes = output.recv_timeout(Duration::from_secs(10)).unwrap();
    fs::remove_dir(dir).unwrap();
    let text = String::from_utf8_lossy(&bytes);
    assert_eq!(code, 0, "{text:?}");
    let input: String = text
        .lines()
        .filter_map(|line| line.rfind("VT ").map(|start| &line[start + 3..]))
        .collect::<Vec<_>>()
        .join(" ");
    assert!(input.contains("1B 5B 3F 36 32 63"), "{input}");
    for (label, query) in [
        ("OSC 10", "\x1b]10;?"),
        ("OSC 11", "\x1b]11;?"),
        ("OSC 4", "\x1b]4;1;?"),
    ] {
        eprintln!("{label} query reached the host: {}", text.contains(query));
    }
    eprintln!("OSC reply reached the child: {}", input.contains("1B 5D"));
    eprintln!("child VT input: {input}");
}

#[test]
fn pasted_line_feeds_cross_conpty_as_ctrl_j() {
    // For console record readers ConPTY consumes the paste markers and turns a
    // pasted LF into Ctrl+Enter. The browser therefore sends each LF of a
    // Win32-mode bracketed paste as a Ctrl+J key, which arrives as a newline
    // key for record readers and as 0x0A between the markers for VT readers.
    let line_feed = paste_records(b"\x1b[200~a\nb\x1b[201~q");
    assert!(
        line_feed.contains("KEY 1 17 0 8 | KEY 1 13 10 8 | KEY 0 13 10 8 | KEY 0 17 0 0"),
        "{line_feed}"
    );
    let paste: &[u8] = b"\x1b[200~a\x1b[74;36;10;1;8;1_\x1b[74;36;10;0;8;1_b\x1b[201~q";
    assert_eq!(
        paste_records(paste),
        "KEY 1 65 97 0 | KEY 0 65 97 0 | KEY 1 74 10 8 | KEY 0 74 10 8 \
         | KEY 1 66 98 0 | KEY 0 66 98 0 | KEY 1 81 113 0"
    );
    let vt = paste_vt(paste);
    assert!(
        vt.contains("1B 5B 32 30 30 7E 61 0A 62 1B 5B 32 30 31 7E 71"),
        "{vt}"
    );
}

#[test]
fn observe_classic_mouse_bytes_in_vt_input_mode() {
    let dir = scratch();
    let cases = [
        (
            "ascii X10",
            b"\x1b[M \x7eH".as_slice(),
            Some(b"\x1b[M \x7eHq".as_slice()),
        ),
        ("raw X10", b"\x1b[M \x80H".as_slice(), None),
        ("UTF-8 X10", b"\x1b[M \xc2\x80H".as_slice(), None),
        (
            "SGR",
            b"\x1b[<0;96;40M".as_slice(),
            Some(b"\x1b[<0;96;40Mq".as_slice()),
        ),
    ];
    for (label, report, expected) in cases {
        // x=94 is ASCII in classic X10; x=96 needs a byte >=0x80. The
        // ConPTY UTF-8 boundary may transform the latter differently across
        // Windows versions, so only observe its bytes. SGR stays ASCII.
        let mut spawned = native::spawn(&command("--mouse-vt", None), &dir, 120, 50).unwrap();
        let lines = collect_lines(spawned.output);
        let ready = lines.recv_timeout(Duration::from_secs(5)).unwrap();
        assert!(ready.contains("VT_READY"), "{label} fixture was not ready");
        spawned.input.write_all(report).unwrap();
        spawned.input.write_all(b"q").unwrap();
        let until = Instant::now() + Duration::from_secs(3);
        let mut observed = Vec::new();
        while Instant::now() < until {
            match lines.recv_timeout(Duration::from_millis(100)) {
                Ok(line) => {
                    if let Some(start) = line.rfind("VT ") {
                        for part in line[start + 3..].split_whitespace() {
                            observed.push(u8::from_str_radix(part, 16).unwrap());
                        }
                    }
                    if observed.ends_with(b"q") {
                        break;
                    }
                }
                Err(mpsc::RecvTimeoutError::Disconnected) => break,
                Err(mpsc::RecvTimeoutError::Timeout) => {}
            }
        }
        assert!(
            observed.ends_with(b"q"),
            "{label} marker missing: {observed:02X?}"
        );
        if let Some(expected) = expected {
            assert_eq!(observed, expected, "{label}");
        } else {
            eprintln!("{label} observed ConPTY bytes: {observed:02X?}");
        }
        assert_eq!(await_exit(&spawned.pty), 0, "{label}");
        spawned.pty.terminate().unwrap();
    }
    fs::remove_dir(dir).unwrap();
}

fn assert_sgr_mouse(command_line: &str, dir: &Path) {
    let mut spawned = native::spawn(command_line, dir, 80, 24).unwrap();
    let lines = collect_lines(spawned.output);
    let ready = lines.recv_timeout(Duration::from_secs(5)).unwrap();
    assert!(ready.contains("MOUSE_RECORDS_READY"));
    spawned
        .input
        .write_all(b"\x1b[<0;5;3M\x1b[<64;5;3Mq")
        .unwrap();
    let until = Instant::now() + Duration::from_secs(3);
    let mut seen = Vec::new();
    while Instant::now() < until {
        match lines.recv_timeout(Duration::from_millis(100)) {
            Ok(line) => {
                if let Some(start) = line.find("MOUSE ").or_else(|| line.find("KEY ")) {
                    seen.push(line[start..].to_string());
                }
                if seen.last().is_some_and(|line| line == "KEY 1 81 113") {
                    break;
                }
            }
            Err(mpsc::RecvTimeoutError::Disconnected) => break,
            Err(mpsc::RecvTimeoutError::Timeout) => {}
        }
    }
    let mouse = seen
        .iter()
        .filter_map(|line| {
            let mut parts = line.split_whitespace();
            if parts.next()? != "MOUSE" {
                return None;
            }
            Some((
                parts.next()?.parse::<i16>().ok()?,
                parts.next()?.parse::<i16>().ok()?,
                parts.next()?.parse::<u32>().ok()?,
                parts.next()?.parse::<u32>().ok()?,
            ))
        })
        .collect::<Vec<_>>();
    assert!(
        mouse
            .iter()
            .any(|&(x, y, buttons, flags)| x == 4 && y == 2 && buttons & 1 != 0 && flags == 0),
        "SGR press did not become a Win32 mouse record: {seen:?}"
    );
    assert!(
        mouse.iter().any(|&(x, y, buttons, flags)| x == 4
            && y == 2
            && flags == 4
            && ((buttons >> 16) as i16).unsigned_abs() >= 120),
        "SGR wheel did not become a Win32 mouse wheel record: {seen:?}"
    );
    assert!(seen.iter().any(|line| line == "KEY 1 81 113"));
    assert_eq!(await_exit(&spawned.pty), 0);
    spawned.pty.terminate().unwrap();
}

#[test]
fn sgr_mouse_reports_become_win32_input_records() {
    let dir = scratch();
    assert_sgr_mouse(&command("--mouse-records", None), &dir);
    fs::remove_dir(dir).unwrap();
}

#[test]
fn isolated_wrapper_preserves_console_for_direct_and_cmd_children() {
    let dir = scratch();
    let wrapper = env!("CARGO_BIN_EXE_isolated_cli");
    let direct = format!(
        "\"{wrapper}\" \"{}\" \"{}\" --mouse-records",
        dir.display(),
        fixture()
    );
    assert_sgr_mouse(&direct, &dir);
    let via_cmd = format!(
        "\"{wrapper}\" \"{}\" cmd.exe /d /c \"{}\" --mouse-records",
        dir.display(),
        fixture()
    );
    assert_sgr_mouse(&via_cmd, &dir);
    let resolved = dir.canonicalize().unwrap();
    assert!(resolved.starts_with(std::env::temp_dir().canonicalize().unwrap()));
    assert!(
        dir.file_name()
            .unwrap()
            .to_string_lossy()
            .starts_with("webterminal-native-")
    );
    fs::remove_dir_all(resolved).unwrap();
}
