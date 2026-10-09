#![cfg(windows)]
mod support;

use std::io::{Read, Write};
use std::net::{SocketAddr, TcpStream};
use std::sync::{Arc, Barrier};
use std::thread;
use std::time::Duration;
use support::{Harness, Socket, shell};
use webterminal::json;

const CLIENTS: usize = 8;
const REQUESTS_PER_CLIENT: usize = 30;
const PATHS: [&str; 4] = ["/app.js", "/style.css", "/render.js", "/api/info"];

fn complete_get(port: u16, path: &str, delay: Duration) -> Result<(), String> {
    let addr = SocketAddr::from(([127, 0, 0, 1], port));
    let mut stream = TcpStream::connect_timeout(&addr, Duration::from_secs(3))
        .map_err(|e| format!("connect: {e}"))?;
    stream
        .set_read_timeout(Some(Duration::from_secs(3)))
        .map_err(|e| e.to_string())?;
    stream
        .set_write_timeout(Some(Duration::from_secs(3)))
        .map_err(|e| e.to_string())?;
    if !delay.is_zero() {
        thread::sleep(delay);
    }
    write!(
        stream,
        "GET {path} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nConnection: close\r\n\r\n"
    )
    .map_err(|e| format!("write: {e}"))?;
    let mut bytes = Vec::new();
    stream
        .read_to_end(&mut bytes)
        .map_err(|e| format!("read after {} bytes: {e}", bytes.len()))?;
    let end = bytes
        .windows(4)
        .position(|part| part == b"\r\n\r\n")
        .ok_or_else(|| format!("no complete headers ({} bytes)", bytes.len()))?;
    let head = std::str::from_utf8(&bytes[..end]).map_err(|e| format!("header encoding: {e}"))?;
    if !head.starts_with("HTTP/1.1 200 OK\r\n") {
        return Err(format!(
            "status: {}",
            head.lines().next().unwrap_or("empty")
        ));
    }
    let length = head
        .lines()
        .find_map(|line| {
            line.to_ascii_lowercase()
                .strip_prefix("content-length: ")
                .and_then(|value| value.parse::<usize>().ok())
        })
        .ok_or_else(|| "missing Content-Length".to_string())?;
    let body = &bytes[end + 4..];
    if body.len() != length {
        return Err(format!("body length {} != {length}", body.len()));
    }
    let expected: Option<&[u8]> = match path {
        "/app.js" => Some(include_bytes!("../assets/app.js")),
        "/style.css" => Some(include_bytes!("../assets/style.css")),
        "/render.js" => Some(include_bytes!("../assets/render.js")),
        _ => None,
    };
    if expected.is_some_and(|asset| body != asset) {
        return Err("asset body mismatch".into());
    }
    if path == "/api/info" && !body.starts_with(b"{\"cwd\":") {
        return Err("invalid info body".into());
    }
    Ok(())
}

fn create(socket: &mut Socket, cwd: &std::path::Path) -> String {
    socket.send(&format!(
        "{{\"op\":\"create\",\"cwd\":{},\"cols\":80,\"rows\":24}}",
        json::quote(&cwd.to_string_lossy())
    ));
    json::parse(&socket.recv_type("created"))
        .unwrap()
        .field("id")
        .unwrap()
        .to_string()
}
fn attach(socket: &mut Socket, id: &str) {
    socket.send(&format!(
        "{{\"op\":\"attach\",\"id\":{},\"cols\":80,\"rows\":24}}",
        json::quote(id)
    ));
    let snapshot = socket.recv_type("snapshot");
    assert!(snapshot.contains(&format!("\"id\":{}", json::quote(id))));
}

#[test]
fn complete_http_assets_during_session_output_and_reconnect() {
    let app = Harness::new(shell("--flood", None));
    assert!(app.request("/api/info", "").starts_with("HTTP/1.1 200"));
    let start = Arc::new(Barrier::new(CLIENTS + 1));
    let failures = thread::scope(|scope| {
        let handles: Vec<_> = (0..CLIENTS)
            .map(|worker| {
                let start = Arc::clone(&start);
                let port = app.port;
                scope.spawn(move || {
                    start.wait();
                    let mut failures = Vec::new();
                    for index in 0..REQUESTS_PER_CLIENT {
                        let path = PATHS[(worker + index) % PATHS.len()];
                        if let Err(error) = complete_get(port, path, Duration::ZERO) {
                            failures
                                .push(format!("client {worker} request {index} {path}: {error}"));
                        }
                    }
                    failures
                })
            })
            .collect();
        start.wait();
        let mut first = app.socket();
        let one = create(&mut first, &app.cwd);
        let mut second = app.socket();
        let two = create(&mut second, &app.cwd);
        assert_ne!(one, two);
        drop(first);
        drop(second);
        let mut reconnect_one = app.socket();
        attach(&mut reconnect_one, &one);
        let mut reconnect_two = app.socket();
        attach(&mut reconnect_two, &two);
        handles
            .into_iter()
            .flat_map(|handle| handle.join().unwrap())
            .collect::<Vec<_>>()
    });
    assert!(
        failures.is_empty(),
        "HTTP stress failures ({} total): {}",
        failures.len(),
        failures
            .iter()
            .take(5)
            .cloned()
            .collect::<Vec<_>>()
            .join(" | ")
    );
}

#[test]
fn accepted_http_socket_can_send_after_connection() {
    let app = Harness::new(shell("--emit", None));
    assert!(app.request("/api/info", "").starts_with("HTTP/1.1 200"));
    // A nonblocking accepted stream may be read before these request bytes
    // arrive; ordinary HTTP clients are allowed to connect before writing.
    complete_get(app.port, "/app.js", Duration::from_millis(50)).unwrap();
}
