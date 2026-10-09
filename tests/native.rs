#![cfg(windows)]
#![allow(dead_code)]
#[path = "../src/native.rs"]
mod native;

use std::fs::{self, OpenOptions};
use std::io::{BufRead, BufReader, Read, Write};
use std::os::windows::fs::OpenOptionsExt;
use std::path::{Path, PathBuf};
use std::process::{Child, Command};
use std::sync::mpsc;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

fn fixture() -> &'static str {
    env!("CARGO_BIN_EXE_native_fixture")
}
fn command(mode: &str, extra: Option<&Path>) -> String {
    match extra {
        Some(path) => format!("\"{}\" {mode} \"{}\"", fixture(), path.display()),
        None => format!("\"{}\" {mode}", fixture()),
    }
}
fn scratch() -> PathBuf {
    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let dir =
        std::env::temp_dir().join(format!("webterminal-native-{}-{stamp}", std::process::id()));
    fs::create_dir(&dir).unwrap();
    dir
}
fn await_exit(pty: &native::Pty) -> u32 {
    let until = Instant::now() + Duration::from_secs(10);
    loop {
        if let Some(code) = pty.exit_code().unwrap() {
            return code;
        }
        assert!(Instant::now() < until, "fixture did not exit");
        std::thread::sleep(Duration::from_millis(10));
    }
}
fn collect(mut output: fs::File) -> mpsc::Receiver<Vec<u8>> {
    let (tx, rx) = mpsc::channel();
    std::thread::spawn(move || {
        let mut bytes = Vec::new();
        output.read_to_end(&mut bytes).unwrap();
        let _ = tx.send(bytes);
    });
    rx
}
fn collect_lines(output: fs::File) -> mpsc::Receiver<String> {
    let (tx, rx) = mpsc::channel();
    std::thread::spawn(move || {
        for line in BufReader::new(output).lines() {
            if tx.send(line.unwrap()).is_err() {
                break;
            }
        }
    });
    rx
}
fn await_unlock(path: &Path) {
    let until = Instant::now() + Duration::from_secs(10);
    loop {
        match OpenOptions::new().read(true).share_mode(0).open(path) {
            Ok(_) => return,
            Err(_) if Instant::now() < until => std::thread::sleep(Duration::from_millis(10)),
            Err(error) => panic!("owned descendant retained marker: {error}"),
        }
    }
}

struct GuardedChild(Child);
impl Drop for GuardedChild {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

#[test]
fn conpty_utf8_vt_resize_and_exit() {
    let dir = scratch();
    let spawned = native::spawn(&command("--emit", None), &dir, 80, 24).unwrap();
    let output = collect(spawned.output);
    assert_ne!(spawned.pty.process_id(), 0);
    spawned.pty.resize(100, 30).unwrap();
    let code = await_exit(&spawned.pty);
    spawned.pty.terminate().unwrap();
    let bytes = output.recv_timeout(Duration::from_secs(10)).unwrap();
    let text = String::from_utf8(bytes).unwrap();
    assert_eq!(code, 0, "{text:?}");
    assert!(text.contains("café 👩‍💻"), "{text:?}");
    assert!(
        text.contains("\x1b[31m") && text.contains("RED"),
        "{text:?}"
    );
    fs::remove_dir(dir).unwrap();
}

#[test]
fn conpty_input_and_full_output_drain() {
    let dir = scratch();
    let mut echo = native::spawn(&command("--echo", None), &dir, 80, 24).unwrap();
    let echo_output = collect(echo.output);
    echo.input.write_all(b"native-input\r").unwrap();
    assert_eq!(await_exit(&echo.pty), 0);
    echo.pty.terminate().unwrap();
    let text =
        String::from_utf8(echo_output.recv_timeout(Duration::from_secs(10)).unwrap()).unwrap();
    assert!(text.contains("ECHO:native-input"), "{text:?}");

    let flood = native::spawn(&command("--flood", None), &dir, 80, 24).unwrap();
    let flood_output = collect(flood.output);
    assert_eq!(await_exit(&flood.pty), 0);
    flood.pty.terminate().unwrap();
    let bytes = flood_output.recv_timeout(Duration::from_secs(10)).unwrap();
    assert!(bytes.ends_with(b"FLOOD_END\r\n") || bytes.windows(9).any(|part| part == b"FLOOD_END"));
    fs::remove_dir(dir).unwrap();
}

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

#[test]
fn missing_executable_returns_without_blocking_conpty_teardown() {
    let dir = scratch();
    let missing = dir.join("webterminal-missing-executable.exe");
    assert!(!missing.exists());
    let command = format!("\"{}\"", missing.display());
    let work_dir = dir.clone();
    let (tx, rx) = mpsc::channel();
    let worker = std::thread::spawn(move || {
        let result = native::spawn(&command, &work_dir, 80, 24).map(|spawned| {
            let _ = spawned.pty.terminate();
        });
        let _ = tx.send(result);
    });
    let result = rx
        .recv_timeout(Duration::from_secs(3))
        .expect("missing executable blocked ConPTY startup or teardown");
    worker.join().unwrap();
    assert_eq!(result.unwrap_err().kind(), std::io::ErrorKind::NotFound);
    fs::remove_dir(dir).unwrap();
}

#[test]
fn termination_kills_descendants_and_server_loss_closes_job() {
    let dir = scratch();
    let unrelated_marker = dir.join("unrelated.lock");
    let mut unrelated = GuardedChild(
        Command::new(fixture())
            .arg("--hold-lock")
            .arg(&unrelated_marker)
            .spawn()
            .unwrap(),
    );
    let until = Instant::now() + Duration::from_secs(10);
    while !unrelated_marker.exists() {
        assert!(
            Instant::now() < until,
            "unrelated fixture did not open marker"
        );
        std::thread::sleep(Duration::from_millis(10));
    }
    let marker = dir.join("owned.lock");
    let spawned = native::spawn(&command("--tree", Some(&marker)), &dir, 80, 24).unwrap();
    let _output = collect(spawned.output);
    let until = Instant::now() + Duration::from_secs(10);
    while !marker.exists() {
        assert!(Instant::now() < until, "fixture child did not open marker");
        std::thread::sleep(Duration::from_millis(10));
    }
    assert!(
        OpenOptions::new()
            .read(true)
            .share_mode(0)
            .open(&marker)
            .is_err()
    );
    spawned.pty.terminate().unwrap();
    await_unlock(&marker);
    assert!(
        OpenOptions::new()
            .read(true)
            .share_mode(0)
            .open(&unrelated_marker)
            .is_err()
    );

    let second = dir.join("abnormal.lock");
    let status = Command::new(fixture())
        .arg("--host-loss")
        .arg(&second)
        .status()
        .unwrap();
    assert!(status.success());
    await_unlock(&second);
    assert!(
        OpenOptions::new()
            .read(true)
            .share_mode(0)
            .open(&unrelated_marker)
            .is_err()
    );
    unrelated.0.kill().unwrap();
    unrelated.0.wait().unwrap();
    await_unlock(&unrelated_marker);
    fs::remove_dir_all(dir).unwrap();
}
