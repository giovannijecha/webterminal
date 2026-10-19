#![cfg(windows)]
#![allow(dead_code)]
mod conpty;
#[path = "../src/native.rs"]
mod native;

use conpty::{await_exit, collect, collect_lines, command, fixture, scratch};
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::os::windows::fs::OpenOptionsExt;
use std::path::Path;
use std::process::{Child, Command};
use std::sync::{Arc, mpsc};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

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

/// Terminates the session's job when a snapshot test finishes or panics.
struct OwnedSession(Arc<native::Pty>);
impl Drop for OwnedSession {
    fn drop(&mut self) {
        let _ = self.0.terminate();
    }
}
impl OwnedSession {
    fn end(self) {
        self.0.terminate().unwrap();
        await_exit(&self.0);
    }
}

fn snapshot_until(
    pty: &native::Pty,
    done: impl Fn(&native::ProcessList) -> bool,
) -> native::ProcessList {
    let until = Instant::now() + Duration::from_secs(10);
    loop {
        let list = pty.processes(native::PROCESS_LIMIT).unwrap();
        if done(&list) {
            return list;
        }
        assert!(Instant::now() < until, "snapshot did not settle: {list:?}");
        std::thread::sleep(Duration::from_millis(20));
    }
}

fn assert_fixture_image(process: &native::ProcessInfo) {
    let expected = Path::new(fixture()).file_name().unwrap().to_string_lossy();
    assert!(process.name.eq_ignore_ascii_case(&expected), "{process:?}");
    let path = process.path.as_deref().unwrap_or_default();
    assert!(path.ends_with(&process.name), "{process:?}");
}

/// Starts `--tree`: the root fixture spawns one `--hold-lock` child, which
/// joins the job at creation, and prints its PID. Returns once the child
/// holds `marker`, with the guard, the child PID and the output lines.
fn spawn_tree(marker: &Path, dir: &Path) -> (OwnedSession, u32, mpsc::Receiver<String>) {
    let spawned = native::spawn(&command("--tree", Some(marker)), dir, 80, 24).unwrap();
    let session = OwnedSession(spawned.pty);
    let lines = collect_lines(spawned.output);
    loop {
        let line = lines.recv_timeout(Duration::from_secs(10)).unwrap();
        if let Some(start) = line.find("CHILD:") {
            let digits = line[start + 6..].chars().take_while(char::is_ascii_digit);
            let child = digits.collect::<String>().parse().unwrap();
            let until = Instant::now() + Duration::from_secs(10);
            while !marker.exists() {
                assert!(Instant::now() < until, "fixture child did not open marker");
                std::thread::sleep(Duration::from_millis(10));
            }
            return (session, child, lines);
        }
    }
}

#[test]
fn process_snapshot_reports_only_the_root() {
    let dir = scratch();
    let before = SystemTime::now();
    let spawned = native::spawn(&command("--hold", None), &dir, 80, 24).unwrap();
    let session = OwnedSession(spawned.pty);
    let _output = collect(spawned.output);
    let list = snapshot_until(&session.0, |list| !list.processes.is_empty());
    assert_eq!(list.processes.len(), 1, "{list:?}");
    assert!(list.total >= 1 && !list.truncated, "{list:?}");
    let root = &list.processes[0];
    assert!(root.root && root.parent.is_none(), "{root:?}");
    assert_eq!(root.pid, session.0.process_id());
    assert_fixture_image(root);
    let started = UNIX_EPOCH + Duration::from_millis(root.started_ms.unwrap());
    let slack = Duration::from_secs(2);
    assert!(started + slack >= before && started <= SystemTime::now() + slack);
    session.end();
    fs::remove_dir(dir).unwrap();
}

#[test]
fn process_snapshot_links_children_and_empties_after_termination() {
    let dir = scratch();
    let marker = dir.join("child.lock");
    let (session, child, _lines) = spawn_tree(&marker, &dir);
    let root = session.0.process_id();
    let list = session.0.processes(native::PROCESS_LIMIT).unwrap();
    assert_eq!(list.processes.len(), 2, "{list:?}");
    assert!(list.total >= 2 && !list.truncated, "{list:?}");
    assert!(list.processes[0].root && list.processes[0].pid == root);
    let entry = &list.processes[1];
    assert_eq!((entry.pid, entry.parent), (child, Some(root)), "{entry:?}");
    assert_fixture_image(entry);
    assert!(entry.started_ms.unwrap() >= list.processes[0].started_ms.unwrap());
    session.0.terminate().unwrap();
    snapshot_until(&session.0, |list| list.processes.is_empty());
    await_unlock(&marker);
    session.end();
    fs::remove_dir_all(dir).unwrap();
}

#[test]
fn process_snapshot_limit_truncates_after_the_root() {
    let dir = scratch();
    let marker = dir.join("child.lock");
    let (session, _child, _lines) = spawn_tree(&marker, &dir);
    let list = session.0.processes(1).unwrap();
    assert_eq!(list.processes.len(), 1, "{list:?}");
    assert!(list.truncated && list.total >= 2, "{list:?}");
    assert!(list.processes[0].root && list.processes[0].parent.is_none());
    let empty = session.0.processes(0).unwrap();
    assert!(empty.processes.is_empty() && empty.truncated, "{empty:?}");
    session.end();
    await_unlock(&marker);
    fs::remove_dir_all(dir).unwrap();
}
