#![cfg(windows)]
mod support;

use std::fs::{self, OpenOptions};
use std::os::windows::fs::OpenOptionsExt;
use std::process::{Child, Command};
use std::thread;
use std::time::{Duration, Instant};
use support::{Harness, fixture, shell};
use webterminal::json::{self, Value};

fn parsed(text: &str) -> Value {
    json::parse(text).unwrap()
}
fn created(socket: &mut support::Socket, cwd: &std::path::Path) -> String {
    socket.send(&format!(
        "{{\"op\":\"create\",\"cwd\":{},\"cols\":80,\"rows\":24}}",
        json::quote(&cwd.to_string_lossy())
    ));
    parsed(&socket.recv_type("created"))
        .field("id")
        .unwrap()
        .to_string()
}
fn attach(socket: &mut support::Socket, id: &str) {
    socket.send(&format!(
        "{{\"op\":\"attach\",\"id\":{},\"cols\":80,\"rows\":24}}",
        json::quote(id)
    ));
}
fn input(socket: &mut support::Socket, id: &str, epoch: i64, seq: i64, data: &str) {
    socket.send(&format!(
        "{{\"op\":\"input\",\"id\":{},\"epoch\":{epoch},\"seq\":{seq},\"data\":{}}}",
        json::quote(id),
        json::quote(data)
    ));
}
fn snapshot(text: &str, id: &str) -> Option<Value> {
    if text.len() > 131_072 {
        return None;
    }
    let value = json::parse(text).ok()?;
    if value.field("type").ok()? == "snapshot" && value.field("id").ok()? == id {
        Some(value)
    } else {
        None
    }
}
fn text_on_screen(value: &Value) -> String {
    let mut result = String::new();
    let Some(Value::Array(lines)) = value.get("terminal").and_then(|v| v.get("screen")) else {
        return result;
    };
    for line in lines {
        if let Some(Value::Array(cells)) = line.get("cells") {
            for cell in cells {
                if let Value::Array(parts) = cell
                    && let Some(text) = parts.first().and_then(Value::string)
                {
                    result.push_str(text);
                }
            }
        }
        result.push('\n');
    }
    result
}
fn wait_snapshot(
    socket: &mut support::Socket,
    id: &str,
    predicate: impl Fn(&Value) -> bool,
) -> Value {
    parsed(&socket.recv_matching(|text| snapshot(text, id).is_some_and(|value| predicate(&value))))
}
fn wait_file(path: &std::path::Path) {
    let until = Instant::now() + Duration::from_secs(8);
    while !path.exists() {
        assert!(Instant::now() < until, "fixture marker was not created");
        thread::sleep(Duration::from_millis(10));
    }
}
fn wait_unlock(path: &std::path::Path) {
    let until = Instant::now() + Duration::from_secs(8);
    loop {
        if OpenOptions::new()
            .read(true)
            .share_mode(0)
            .open(path)
            .is_ok()
        {
            return;
        }
        assert!(Instant::now() < until, "fixture marker remained locked");
        thread::sleep(Duration::from_millis(10));
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
fn same_origin_and_owned_assets_are_enforced() {
    let app = Harness::new(shell("--emit", None));
    fs::write(app.cwd.join("private.txt"), "PRIVATE_FILE_MARKER").unwrap();
    let index = app.request("/", "");
    assert!(index.starts_with("HTTP/1.1 200"));
    assert!(index.contains("Content-Security-Policy:"));
    for path in ["/private.txt", "/../SPEC.md", "/SPEC.md"] {
        let response = app.request(path, "");
        assert!(response.starts_with("HTTP/1.1 404"), "{path}: {response}");
        assert!(!response.contains("PRIVATE_FILE_MARKER"));
    }
    let foreign_host = app.raw_http("GET /api/sessions HTTP/1.1\r\nHost: evil.example\r\n\r\n");
    assert!(foreign_host.starts_with("HTTP/1.1 403"));
    let foreign_origin = app.request("/api/sessions", "Origin: http://evil.example\r\n");
    assert!(foreign_origin.starts_with("HTTP/1.1 403"));
    let cross_site = app.request("/api/sessions", "Sec-Fetch-Site: cross-site\r\n");
    assert!(cross_site.starts_with("HTTP/1.1 403"));
    let handshake = format!(
        "GET /ws HTTP/1.1\r\nHost: 127.0.0.1:{}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n",
        app.port
    );
    assert!(app.raw_http(&handshake).starts_with("HTTP/1.1 403"));
    assert!(
        app.raw_http(&handshake.replace(
            "Upgrade: websocket",
            "Origin: http://evil.example\r\nUpgrade: websocket"
        ))
        .starts_with("HTTP/1.1 403")
    );
    let mut socket = app.socket();
    socket.send("{\"op\":\"list\"}");
    assert_eq!(
        parsed(&socket.recv_type("sessions")).field("type").unwrap(),
        "sessions"
    );
}

#[test]
fn independent_sessions_and_control_transfer() {
    let app = Harness::new(shell("--hold", None));
    let mut owner = app.socket();
    let first = created(&mut owner, &app.cwd);
    let first_state = wait_snapshot(&mut owner, &first, |_| true);
    let first_epoch = first_state.integer("epoch").unwrap();
    let mut second_owner = app.socket();
    let second = created(&mut second_owner, &app.cwd);
    let second_state = wait_snapshot(&mut second_owner, &second, |_| true);
    let second_epoch = second_state.integer("epoch").unwrap();
    assert_ne!(first, second);
    assert_eq!(first_epoch, 1);
    assert_eq!(second_epoch, 1);

    let mut observer = app.socket();
    attach(&mut observer, &first);
    let observed = wait_snapshot(&mut observer, &first, |_| true);
    assert_eq!(observed.integer("epoch").unwrap(), first_epoch);
    input(&mut observer, &first, first_epoch, 1, "echo WRONG\r");
    assert!(observer.recv_type("error").contains("Control changed"));
    observer.send(&format!(
        "{{\"op\":\"resize\",\"id\":{},\"epoch\":{first_epoch},\"cols\":90,\"rows\":30}}",
        json::quote(&first)
    ));
    assert!(observer.recv_type("error").contains("Control changed"));
    owner.send(&format!(
        "{{\"op\":\"release\",\"id\":{}}}",
        json::quote(&first)
    ));
    let released = wait_snapshot(&mut owner, &first, |v| {
        v.integer("epoch").unwrap() > first_epoch
    });
    observer.send(&format!(
        "{{\"op\":\"claim\",\"id\":{},\"cols\":90,\"rows\":30}}",
        json::quote(&first)
    ));
    let claimed = wait_snapshot(&mut observer, &first, |v| {
        v.integer("epoch").unwrap() > released.integer("epoch").unwrap()
    });
    let epoch = claimed.integer("epoch").unwrap();
    assert_eq!(
        claimed.get("terminal").unwrap().integer("cols").unwrap(),
        90
    );
    wait_snapshot(&mut owner, &first, |v| v.integer("epoch").unwrap() >= epoch);
    input(&mut owner, &first, first_epoch, 1, "echo WRONG\r");
    assert!(owner.recv_type("error").contains("Control changed"));
    input(&mut observer, &first, first_epoch, 1, "echo WRONG\r");
    assert!(observer.recv_type("error").contains("Control changed"));
    input(&mut observer, &first, epoch, 1, "a");
    input(&mut observer, &first, epoch, 1, "b");
    assert!(observer.recv_type("error").contains("Duplicate"));
    observer.send(&format!(
        "{{\"op\":\"close\",\"id\":{}}}",
        json::quote(&first)
    ));
    let list = observer.recv_matching(|text| {
        text.starts_with("{\"type\":\"sessions\"")
            && !text.contains(&format!("\"id\":{}", json::quote(&first)))
    });
    assert!(list.contains(&format!("\"id\":{}", json::quote(&second))));

    second_owner.send(&format!(
        "{{\"op\":\"resize\",\"id\":{},\"epoch\":{second_epoch},\"cols\":100,\"rows\":30}}",
        json::quote(&second)
    ));
    let second_state = wait_snapshot(&mut second_owner, &second, |v| {
        v.get("terminal").unwrap().integer("cols").unwrap() == 100
    });
    assert_eq!(second_state.get("alive"), Some(&Value::Bool(true)));
    second_owner.send(&format!(
        "{{\"op\":\"close\",\"id\":{}}}",
        json::quote(&second)
    ));
}

#[test]
fn normal_exit_preserves_final_output_and_status() {
    let app = Harness::new(shell("--echo", None));
    let mut socket = app.socket();
    let id = created(&mut socket, &app.cwd);
    let initial = wait_snapshot(&mut socket, &id, |_| true);
    let epoch = initial.integer("epoch").unwrap();
    input(&mut socket, &id, epoch, 1, "DONE\r");
    let exited = wait_snapshot(&mut socket, &id, |v| {
        v.get("alive") == Some(&Value::Bool(false)) && text_on_screen(v).contains("ECHO:DONE")
    });
    assert_eq!(exited.get("exitCode"), Some(&Value::Number(0)));
}

#[test]
fn tagged_attachment_is_acknowledged_before_its_fresh_snapshot() {
    let app = Harness::new(shell("--echo", None));
    let mut owner = app.socket();
    let id = created(&mut owner, &app.cwd);
    let initial = wait_snapshot(&mut owner, &id, |_| true);
    owner.send(&format!(
        "{{\"op\":\"release\",\"id\":{}}}",
        json::quote(&id)
    ));
    let released = wait_snapshot(&mut owner, &id, |v| {
        v.get("controller") == Some(&Value::Null)
    });
    let released_epoch = released.integer("epoch").unwrap();
    assert!(released_epoch > initial.integer("epoch").unwrap());

    let mut next = app.socket();
    next.send(&format!(
        "{{\"op\":\"attach\",\"id\":{},\"request\":0,\"cols\":90,\"rows\":30}}",
        json::quote(&id)
    ));
    assert!(next.recv_type("error").contains("request must be positive"));
    let response = app.request("/api/sessions", "");
    let sessions = parsed(response.split("\r\n\r\n").nth(1).unwrap());
    let Value::Array(entries) = sessions.get("sessions").unwrap() else {
        panic!("sessions array")
    };
    assert_eq!(entries[0].get("controller"), Some(&Value::Null));

    next.send(&format!(
        "{{\"op\":\"attach\",\"id\":{},\"request\":42,\"cols\":90,\"rows\":30}}",
        json::quote(&id)
    ));
    let ack = parsed(&next.recv_matching(|text| {
        assert!(
            snapshot(text, &id).is_none(),
            "snapshot preceded attachment acknowledgement"
        );
        text.starts_with("{\"type\":\"attached\"")
    }));
    assert_eq!(ack.field("id").unwrap(), id);
    assert_eq!(ack.integer("request").unwrap(), 42);
    let attached = wait_snapshot(&mut next, &id, |v| {
        v.integer("epoch").unwrap() > released_epoch
    });
    assert_eq!(
        attached.get("terminal").unwrap().integer("cols").unwrap(),
        90
    );
    let epoch = attached.integer("epoch").unwrap();
    input(&mut next, &id, epoch, 1, "ACKNOWLEDGED\r");
    wait_snapshot(&mut next, &id, |v| {
        text_on_screen(v).contains("ECHO:ACKNOWLEDGED")
    });
}

#[test]
fn windows_cmd_waits_for_prompt_and_accepts_edited_unicode_input() {
    let app = Harness::new("cmd.exe /d /q".into());
    let mut socket = app.socket();
    let id = created(&mut socket, &app.cwd);
    let ready = wait_snapshot(&mut socket, &id, |v| {
        let screen = text_on_screen(v);
        screen.contains('>') && screen.contains("webterminal-transport-")
    });
    let epoch = ready.integer("epoch").unwrap();

    input(&mut socket, &id, epoch, 1, "echo CMD_ASCII_RESULT\r");
    wait_snapshot(&mut socket, &id, |v| {
        text_on_screen(v).matches("CMD_ASCII_RESULT").count() >= 2
    });

    input(&mut socket, &id, epoch, 2, "echo CMD_UNICODE_cafx\u{7f}é\r");
    wait_snapshot(&mut socket, &id, |v| {
        text_on_screen(v).matches("CMD_UNICODE_café").count() >= 2
    });

    input(&mut socket, &id, epoch, 3, "exit\r");
    let exited = wait_snapshot(&mut socket, &id, |v| {
        v.get("alive") == Some(&Value::Bool(false))
    });
    assert_eq!(exited.get("exitCode"), Some(&Value::Number(0)));
}

#[test]
fn disconnected_and_slow_viewers_do_not_stop_console_drain() {
    let app = Harness::new(shell("--emit", None));
    let mut first = app.socket();
    let id = created(&mut first, &app.cwd);
    drop(first);
    let mut reconnected = app.socket();
    attach(&mut reconnected, &id);
    let restored = wait_snapshot(&mut reconnected, &id, |v| {
        text_on_screen(v).contains("café") && v.get("alive") == Some(&Value::Bool(false))
    });
    assert_eq!(restored.get("alive"), Some(&Value::Bool(false)));
    drop(reconnected);

    let flood = Harness::new(shell("--flood", None));
    let mut source = flood.socket();
    let flood_id = created(&mut source, &flood.cwd);
    let mut slow = flood.socket();
    attach(&mut slow, &flood_id);
    // Keep the observer connected without reading its large snapshots.
    drop(source);
    let until = Instant::now() + Duration::from_secs(8);
    while !flood
        .request("/api/sessions", "")
        .contains("\"alive\":false")
    {
        assert!(
            Instant::now() < until,
            "flood fixture did not exit while viewer was slow"
        );
        thread::sleep(Duration::from_millis(20));
    }
    let mut late = flood.socket();
    attach(&mut late, &flood_id);
    let snapshot = late.recv_type("snapshot");
    assert!(snapshot.contains("\"alive\":false"));
    assert!(snapshot.contains("\"history\":"));
    assert!(snapshot.len() < 32 * 1024 * 1024);
}

#[test]
fn stopping_server_releases_only_its_owned_processes() {
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let unrelated_dir = std::env::temp_dir().join(format!(
        "webterminal-transport-unrelated-{}-{stamp}",
        std::process::id(),
    ));
    fs::create_dir(&unrelated_dir).unwrap();
    let unrelated_marker = unrelated_dir.join("unrelated.lock");
    let mut unrelated = GuardedChild(
        Command::new(fixture())
            .arg("--hold-lock")
            .arg(&unrelated_marker)
            .spawn()
            .unwrap(),
    );
    wait_file(&unrelated_marker);
    let owned_marker = unrelated_dir.join("owned.lock");
    let mut app = Harness::new(shell("--hold-lock", Some(&owned_marker)));
    let mut socket = app.socket();
    let _id = created(&mut socket, &app.cwd);
    wait_file(&owned_marker);
    app.stop();
    wait_unlock(&owned_marker);
    assert!(
        OpenOptions::new()
            .read(true)
            .share_mode(0)
            .open(&unrelated_marker)
            .is_err()
    );
    unrelated.0.kill().unwrap();
    unrelated.0.wait().unwrap();
    wait_unlock(&unrelated_marker);
    let resolved = unrelated_dir.canonicalize().unwrap();
    assert!(resolved.starts_with(std::env::temp_dir().canonicalize().unwrap()));
    assert!(
        unrelated_dir
            .file_name()
            .unwrap()
            .to_string_lossy()
            .starts_with("webterminal-transport-unrelated-")
    );
    fs::remove_dir_all(&resolved).unwrap();
}
