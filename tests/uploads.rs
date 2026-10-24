#![cfg(windows)]
mod support;

use std::io::{Read, Write};
use std::net::TcpStream;
use std::path::{Path, PathBuf};
use std::thread;
use std::time::{Duration, Instant};
use support::{Harness, Socket, shell};
use webterminal::json::{self, Value};

fn session(app: &Harness, socket: &mut Socket) -> (String, i64) {
    socket.send(&format!(
        "{{\"op\":\"create\",\"cwd\":{},\"cols\":80,\"rows\":24}}",
        json::quote(&app.cwd.to_string_lossy())
    ));
    let id = json::parse(&socket.recv_type("created"))
        .unwrap()
        .field("id")
        .unwrap()
        .to_string();
    let snapshot = socket.recv_matching(|text| {
        text.starts_with("{\"type\":\"snapshot\"") && text.contains(&format!("\"id\":\"{id}\""))
    });
    let epoch = json::parse(&snapshot).unwrap().integer("epoch").unwrap();
    (id, epoch)
}
fn encode(value: &str) -> String {
    value
        .bytes()
        .map(|b| match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'.' | b'_' => (b as char).to_string(),
            _ => format!("%{b:02X}"),
        })
        .collect()
}
fn target(id: &str, view: &str, epoch: i64, name: &str) -> String {
    format!(
        "/api/upload?id={}&view={}&epoch={epoch}&name={}",
        encode(id),
        encode(view),
        encode(name)
    )
}
/// Sends a raw upload; `declared` may exceed the bytes actually sent.
fn post(app: &Harness, path: &str, origin: bool, declared: usize, body: &[u8]) -> String {
    let mut stream = TcpStream::connect(("127.0.0.1", app.port)).unwrap();
    stream
        .set_read_timeout(Some(Duration::from_secs(8)))
        .unwrap();
    let origin = if origin {
        format!("Origin: http://127.0.0.1:{}\r\n", app.port)
    } else {
        String::new()
    };
    let head = format!(
        "POST {path} HTTP/1.1\r\nHost: 127.0.0.1:{}\r\n{origin}Content-Type: application/octet-stream\r\nContent-Length: {declared}\r\n\r\n",
        app.port
    );
    stream.write_all(head.as_bytes()).unwrap();
    let _ = stream.write_all(body);
    let mut response = Vec::new();
    let _ = stream.read_to_end(&mut response);
    String::from_utf8_lossy(&response).into_owned()
}
fn reply(response: &str) -> Value {
    json::parse(response.split("\r\n\r\n").nth(1).unwrap()).unwrap()
}
fn staged(response: &str) -> PathBuf {
    PathBuf::from(reply(response).field("path").unwrap())
}
/// Opens an upload that has sent only `sent` of its `declared` body bytes.
fn start_upload(app: &Harness, path: &str, declared: usize, sent: usize) -> TcpStream {
    let mut upload = TcpStream::connect(("127.0.0.1", app.port)).unwrap();
    upload
        .set_read_timeout(Some(Duration::from_secs(8)))
        .unwrap();
    write!(
        upload,
        "POST {path} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nOrigin: http://127.0.0.1:{port}\r\nContent-Length: {declared}\r\n\r\n",
        port = app.port
    )
    .unwrap();
    upload.write_all(&vec![7; sent]).unwrap();
    upload
}
fn wait_started(folder: &Path) {
    let until = Instant::now() + Duration::from_secs(8);
    while entries(folder) == 0 {
        assert!(Instant::now() < until, "upload did not start");
        thread::sleep(Duration::from_millis(20));
    }
}
fn finish(mut upload: TcpStream, rest: usize) -> String {
    upload.write_all(&vec![7; rest]).unwrap();
    let mut response = Vec::new();
    let _ = upload.read_to_end(&mut response);
    String::from_utf8_lossy(&response).into_owned()
}
fn entries(folder: &Path) -> usize {
    std::fs::read_dir(folder).map_or(0, |entries| entries.count())
}
fn root(app: &Harness) -> PathBuf {
    std::env::temp_dir()
        .join("webterminal-uploads")
        .join(format!("{}-{}", std::process::id(), app.port))
}
fn wait_gone(path: &Path) {
    let until = Instant::now() + Duration::from_secs(8);
    while path.exists() {
        assert!(Instant::now() < until, "{} was not removed", path.display());
        thread::sleep(Duration::from_millis(20));
    }
}

#[test]
fn the_controlling_view_stages_exact_bytes_until_its_session_closes() {
    let mut app = Harness::new(shell("--echo", None));
    let mut socket = app.socket();
    let (id, epoch) = session(&app, &mut socket);
    let view = socket.view.clone();
    let bytes = (0..=255u8).cycle().take(200_000).collect::<Vec<_>>();
    let response = post(
        &app,
        &target(&id, &view, epoch, "report 日本.pdf"),
        true,
        bytes.len(),
        &bytes,
    );
    assert!(response.starts_with("HTTP/1.1 200"), "{response}");
    let copy = reply(&response);
    assert_eq!(copy.field("id"), Ok("f1"));
    assert_eq!(copy.field("name"), Ok("report 日本.pdf"));
    assert_eq!(copy.integer("size"), Ok(bytes.len() as i64));
    let path = staged(&response);
    assert_eq!(path.file_name().unwrap(), "report 日本.pdf");
    assert!(path.starts_with(root(&app).join(&id)), "{}", path.display());
    assert_eq!(std::fs::read(&path).unwrap(), bytes);

    let second = staged(&post(
        &app,
        &target(&id, &view, epoch, "a:b.txt"),
        true,
        2,
        b"ok",
    ));
    assert_eq!(second.file_name().unwrap(), "a_b.txt");

    socket.send(&format!("{{\"op\":\"close\",\"id\":{}}}", json::quote(&id)));
    wait_gone(&root(&app).join(&id));
    app.stop();
    assert!(!root(&app).exists());
    assert!(!root(&app).with_extension("lock").exists());
}

#[test]
fn uploads_are_fenced_like_input_and_bounded() {
    let app = Harness::new(shell("--echo", None));
    let mut socket = app.socket();
    let (id, epoch) = session(&app, &mut socket);
    let view = socket.view.clone();
    let ok = target(&id, &view, epoch, "f.bin");
    let cases = [
        (post(&app, &ok, false, 1, b"x"), "403"),
        (
            post(&app, &target(&id, "v0", epoch, "f"), true, 1, b"x"),
            "409",
        ),
        (
            post(&app, &target(&id, &view, epoch + 1, "f"), true, 1, b"x"),
            "409",
        ),
        (
            post(&app, &target("s999", &view, epoch, "f"), true, 1, b"x"),
            "404",
        ),
        (post(&app, &ok, true, (1 << 30) + 1, b""), "413"),
        (post(&app, "/api/upload?id=s1", true, 1, b"x"), "400"),
        (post(&app, "/api/sessions?x=1", true, 1, b"x"), "400"),
    ];
    for (response, status) in cases {
        assert!(
            response.starts_with(&format!("HTTP/1.1 {status}")),
            "expected {status}: {response}"
        );
    }
    // Other routes still refuse request bodies.
    let get = app.request("/api/sessions", "Content-Length: 3\r\n");
    assert!(get.starts_with("HTTP/1.1 400"), "{get}");
    let staged = root(&app).join(&id);
    let count = std::fs::read_dir(&staged).map_or(0, |entries| entries.count());
    assert_eq!(count, 0, "rejected uploads must not stage files");
}

#[test]
fn a_stalled_transfer_does_not_block_input_and_leaves_no_partial_file() {
    let app = Harness::new(shell("--echo", None));
    let mut socket = app.socket();
    let (id, epoch) = session(&app, &mut socket);
    let path = target(&id, &socket.view, epoch, "partial.bin");
    let upload = start_upload(&app, &path, 1_000_000, 4096);
    let folder = root(&app).join(&id);
    wait_started(&folder);
    // Terminal input and output keep flowing while the transfer is open.
    socket.send(&format!(
        "{{\"op\":\"input\",\"id\":{},\"epoch\":{epoch},\"seq\":1,\"data\":\"AFTER\\r\"}}",
        json::quote(&id)
    ));
    socket.recv_matching(|text| {
        json::parse(text).is_ok_and(|value| screen(&value).contains("ECHO:AFTER"))
    });
    // The browser went away mid-transfer: the partial file is removed.
    drop(upload);
    let until = Instant::now() + Duration::from_secs(8);
    while entries(&folder) > 0 {
        assert!(Instant::now() < until, "partial upload remained");
        thread::sleep(Duration::from_millis(20));
    }
}

#[test]
fn control_changing_mid_transfer_discards_the_copy() {
    let app = Harness::new(shell("--echo", None));
    let mut owner = app.socket();
    let (id, epoch) = session(&app, &mut owner);
    let mut other = app.socket();
    other.send(&format!(
        "{{\"op\":\"attach\",\"id\":{},\"cols\":80,\"rows\":24}}",
        json::quote(&id)
    ));
    let folder = root(&app).join(&id);
    let upload = start_upload(
        &app,
        &target(&id, &owner.view, epoch, "late.bin"),
        10_000,
        4096,
    );
    wait_started(&folder);

    other.send(&format!(
        "{{\"op\":\"claim\",\"id\":{},\"cols\":80,\"rows\":24}}",
        json::quote(&id)
    ));
    let claimed = format!("\"controller\":{}", json::quote(&other.view));
    let snapshot = other.recv_matching(|text| {
        text.starts_with("{\"type\":\"snapshot\"") && text.contains(&claimed)
    });
    let response = finish(upload, 10_000 - 4096);
    assert!(response.starts_with("HTTP/1.1 409"), "{response}");
    assert_eq!(
        reply(&response).field("error"),
        Ok("Control changed during upload; the copy was discarded")
    );
    assert_eq!(entries(&folder), 0, "a discarded copy must leave no file");

    // The new controller stages normally; the discarded ID is not reused.
    let epoch = json::parse(&snapshot).unwrap().integer("epoch").unwrap();
    let response = post(
        &app,
        &target(&id, &other.view, epoch, "late.bin"),
        true,
        2,
        b"ok",
    );
    assert!(response.starts_with("HTTP/1.1 200"), "{response}");
    assert_eq!(reply(&response).field("id"), Ok("f2"));
    assert_eq!(entries(&folder), 1);
}

#[test]
fn a_session_closed_mid_transfer_keeps_no_copy() {
    let app = Harness::new(shell("--echo", None));
    let mut socket = app.socket();
    let (id, epoch) = session(&app, &mut socket);
    let folder = root(&app).join(&id);
    let upload = start_upload(
        &app,
        &target(&id, &socket.view, epoch, "gone.bin"),
        10_000,
        4096,
    );
    wait_started(&folder);

    socket.send(&format!("{{\"op\":\"close\",\"id\":{}}}", json::quote(&id)));
    let until = Instant::now() + Duration::from_secs(8);
    while app.request("/api/sessions", "").contains(&json::quote(&id)) {
        assert!(Instant::now() < until, "session did not close");
        thread::sleep(Duration::from_millis(20));
    }
    let response = finish(upload, 10_000 - 4096);
    assert!(response.starts_with("HTTP/1.1 410"), "{response}");
    wait_gone(&folder);
}

fn screen(value: &Value) -> String {
    let mut text = String::new();
    let Some(Value::Array(lines)) = value.get("terminal").and_then(|v| v.get("screen")) else {
        return text;
    };
    for line in lines {
        if let Some(Value::Array(runs)) = line.get("runs") {
            for run in runs {
                let Value::Array(parts) = run else { continue };
                match &parts[4] {
                    Value::String(part) => text.push_str(part),
                    Value::Array(cells) => {
                        for cell in cells {
                            if let Value::Array(parts) = cell
                                && let Some(part) = parts.first().and_then(Value::string)
                            {
                                text.push_str(part);
                            }
                        }
                    }
                    _ => {}
                }
            }
        }
        text.push('\n');
    }
    text
}
