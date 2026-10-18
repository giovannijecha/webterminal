#![cfg(windows)]
#![allow(dead_code)]
//! The program bridge end to end. An owned fixture copied as `claude.exe`
//! stands in for Claude Code, so no real program, profile or credential is
//! involved. The server runs as a child process with its own PATH and TEMP.
mod support;

use std::fs;
use std::io::{self, BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use support::{Socket, TIMEOUT, fixture};
use webterminal::json::{self, Value};

const BASH: &str = r#"{"hook_event_name":"PermissionRequest","session_id":"c1","tool_name":"Bash","tool_input":{"command":"npm test","description":"Run tests"}}"#;
const WRITE: &str = r#"{"hook_event_name":"PermissionRequest","session_id":"c1","tool_name":"Write","tool_input":{"file_path":"notes.txt","content":"hi"}}"#;
const WRITE_RAN: &str = r#"{"hook_event_name":"PostToolUse","session_id":"c1","tool_name":"Write","tool_input":{"file_path":"notes.txt","content":"hi"},"tool_use_id":"toolu_1"}"#;

struct Server {
    child: Child,
    port: u16,
    root: PathBuf,
}
impl Server {
    fn start() -> Self {
        let stamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root = std::env::temp_dir().join(format!(
            "webterminal-bridge-test-{}-{stamp}",
            std::process::id()
        ));
        for folder in ["bin", "work", "temp"] {
            fs::create_dir_all(root.join(folder)).unwrap();
        }
        fs::copy(fixture(), root.join("bin/claude.exe")).unwrap();
        let system = PathBuf::from(std::env::var_os("SystemRoot").unwrap()).join("System32");
        let path = std::env::join_paths([
            root.join("bin"),
            system.join(r"WindowsPowerShell\v1.0"),
            system,
        ])
        .unwrap();
        let port = TcpListener::bind("127.0.0.1:0")
            .unwrap()
            .local_addr()
            .unwrap()
            .port();
        let mut child = Command::new(env!("CARGO_BIN_EXE_webterminal"))
            .arg("--port")
            .arg(port.to_string())
            .arg("--cwd")
            .arg(root.join("work"))
            .arg("--config")
            .arg(root.join("temp/settings.json"))
            .env("PATH", path)
            .env("TEMP", root.join("temp"))
            .env("TMP", root.join("temp"))
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .unwrap();
        let mut stdout = BufReader::new(child.stdout.take().unwrap());
        let mut line = String::new();
        stdout.read_line(&mut line).unwrap();
        thread::spawn(move || io::copy(&mut stdout, &mut io::sink()));
        assert!(line.contains(&format!("127.0.0.1:{port}")), "{line}");
        Self { child, port, root }
    }
    /// The first request in `state`, as (id, revision).
    fn request(&self, state: &str) -> (String, i64) {
        let until = Instant::now() + TIMEOUT;
        loop {
            let response = http(
                self.port,
                &format!(
                    "GET /api/agents HTTP/1.1\r\nHost: 127.0.0.1:{}\r\nConnection: close\r\n\r\n",
                    self.port
                ),
            );
            let body = response.split_once("\r\n\r\n").unwrap().1;
            let agents = json::parse(body).unwrap();
            let found = agents
                .get("requests")
                .and_then(Value::array)
                .unwrap_or_default()
                .iter()
                .find(|r| r.field("state").ok() == Some(state))
                .map(|r| {
                    (
                        r.field("id").unwrap().to_owned(),
                        r.integer("revision").unwrap(),
                    )
                });
            if let Some(found) = found {
                return found;
            }
            assert!(Instant::now() < until, "no {state} request in {body}");
            thread::sleep(Duration::from_millis(20));
        }
    }
}
impl Drop for Server {
    fn drop(&mut self) {
        // Only the server this test started; normally it already stopped.
        if self.child.try_wait().ok().flatten().is_none() {
            let _ = self.child.kill();
            let _ = self.child.wait();
        }
        let temp = std::env::temp_dir().canonicalize().unwrap();
        if let Ok(root) = self.root.canonicalize() {
            assert!(root.starts_with(&temp));
            let until = Instant::now() + TIMEOUT;
            while fs::remove_dir_all(&root).is_err() && Instant::now() < until {
                thread::sleep(Duration::from_millis(20));
            }
        }
    }
}

fn http(port: u16, request: &str) -> String {
    let mut stream = TcpStream::connect(("127.0.0.1", port)).unwrap();
    stream.set_read_timeout(Some(TIMEOUT * 2)).unwrap();
    stream.write_all(request.as_bytes()).unwrap();
    let mut response = String::new();
    stream.read_to_string(&mut response).unwrap();
    response
}
/// Posts one program event the way the bridge helper does.
fn report(port: u16, session: &str, token: &str, extra: &str, event: &str) -> String {
    http(
        port,
        &format!(
            "POST /api/bridge?session={session} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nX-Webterminal-Token: {token}\r\n{extra}Content-Length: {}\r\nConnection: close\r\n\r\n{event}",
            event.len()
        ),
    )
}
/// Reports from another thread, which waits like a helper for the answer.
fn waiting(port: u16, session: &str, token: &str, event: &'static str) -> JoinHandle<String> {
    let (session, token) = (session.to_owned(), token.to_owned());
    thread::spawn(move || report(port, &session, &token, "", event))
}
fn status(response: &str) -> &str {
    response.lines().next().unwrap_or_default()
}

#[test]
fn bridge_requests_are_answered_once_by_the_controller() {
    let mut server = Server::start();
    let port = server.port;
    let mut owner = Socket::connect(port);
    owner.send(&format!(
        "{{\"op\":\"create\",\"cwd\":{},\"cols\":80,\"rows\":24,\"program\":\"claude\"}}",
        json::quote(&server.root.join("work").to_string_lossy())
    ));
    let id = json::parse(&owner.recv_type("created"))
        .unwrap()
        .field("id")
        .unwrap()
        .to_owned();
    let snapshot = owner.recv_matching(|text| {
        text.starts_with("{\"type\":\"snapshot\"") && text.contains(&format!("\"id\":\"{id}\""))
    });
    let epoch = json::parse(&snapshot).unwrap().integer("epoch").unwrap();

    // The adapter settings name this session and hold its bridge token.
    let owners = server.root.join("temp/webterminal-bridge");
    let directory = fs::read_dir(&owners)
        .unwrap()
        .next()
        .unwrap()
        .unwrap()
        .path();
    let settings =
        fs::read_to_string(directory.join(format!("{id}-claude-settings.json"))).unwrap();
    let settings = json::parse(&settings).unwrap();
    let groups = settings
        .get("hooks")
        .unwrap()
        .get("PermissionRequest")
        .unwrap();
    let hook = &groups.array().unwrap()[0]
        .get("hooks")
        .unwrap()
        .array()
        .unwrap()[0];
    let args = hook.get("args").unwrap().array().unwrap();
    assert_eq!(args[4].string(), Some(id.as_str()));
    let token = args[6].string().unwrap().to_owned();

    // Only the helper holding this session's token may report.
    let forged = "0".repeat(token.len());
    assert!(status(&report(port, &id, &forged, "", BASH)).contains("403"));
    let origin = format!("Origin: http://127.0.0.1:{port}\r\n");
    assert!(status(&report(port, &id, &token, &origin, BASH)).contains("403"));
    assert!(status(&report(port, "s999", &token, "", BASH)).contains("403"));

    let allowed = waiting(port, &id, &token, BASH);
    let (request, revision) = server.request("waiting");
    let answer = |answer: &str| {
        format!(
            "{{\"op\":\"respond\",\"id\":{},\"revision\":{revision},\"epoch\":{epoch},\"answer\":\"{answer}\"}}",
            json::quote(&request)
        )
    };
    // A view that does not control the terminal cannot answer.
    let mut observer = Socket::connect(port);
    observer.send(&answer("deny"));
    assert!(observer.recv_type("error").contains("Control changed"));
    owner.send(&answer("allow"));
    owner.recv_type("responded");
    let delivered = allowed.join().unwrap();
    assert!(
        delivered.ends_with(r#"{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow"}}}"#),
        "{delivered}"
    );
    owner.send(&answer("deny"));
    assert!(owner.recv_type("error").contains("already answered"));

    // A request answered in the terminal is retired by the tool run.
    let retired = waiting(port, &id, &token, WRITE);
    server.request("waiting");
    assert!(status(&report(port, &id, &token, "", WRITE_RAN)).contains("200"));
    let released = retired.join().unwrap();
    assert!(
        released.starts_with("HTTP/1.1 200") && released.ends_with("\r\n\r\n"),
        "{released}"
    );

    // Stopping needs explicit confirmation; the server then releases the
    // adapter settings and exits.
    owner.send("{\"op\":\"stop-server\"}");
    assert!(owner.recv_type("error").contains("confirmation"));
    owner.send("{\"op\":\"stop-server\",\"confirmed\":true}");
    owner.recv_type("server-stopping");
    let until = Instant::now() + TIMEOUT;
    let exit = loop {
        if let Some(status) = server.child.try_wait().unwrap() {
            break status;
        }
        assert!(Instant::now() < until, "server did not stop");
        thread::sleep(Duration::from_millis(20));
    };
    assert!(exit.success());
    assert!(!directory.exists());
}

#[test]
fn stop_server_sends_ack_and_close_before_process_exit() {
    for _ in 0..12 {
        let mut server = Server::start();
        let mut view = Socket::connect(server.port);
        view.send(r#"{"op":"stop-server","confirmed":true}"#);
        view.recv_type("server-stopping");
        assert_eq!(view.recv_close(), 1001);
        let until = Instant::now() + TIMEOUT;
        loop {
            if let Some(exit) = server.child.try_wait().unwrap() {
                assert!(exit.success());
                break;
            }
            assert!(Instant::now() < until, "server did not exit after close");
            thread::sleep(Duration::from_millis(10));
        }
    }
}
