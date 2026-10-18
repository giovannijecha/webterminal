//! `webterminal bridge --port P --session S --token T [EVENT]`: forwards one
//! program event to the local server and prints the server's answer.
//!
//! Claude Code passes the event on standard input; Codex passes it as the
//! last argument, and then standard input is never read. The helper always
//! exits successfully and prints nothing on any failure, so the program
//! continues with its own terminal prompt.
use super::{PAYLOAD_LIMIT, REQUEST_WAIT};
use std::ffi::OsString;
use std::io::{self, Read, Write};
use std::net::TcpStream;
use std::time::Duration;

const ANSWER_LIMIT: u64 = 4 << 20;

pub fn run(args: impl Iterator<Item = OsString>) {
    if let Some(answer) = forward(args) {
        let mut stdout = io::stdout().lock();
        let _ = stdout.write_all(answer.as_bytes());
        let _ = stdout.flush();
    }
}

fn forward(args: impl Iterator<Item = OsString>) -> Option<String> {
    let (mut port, mut session, mut token, mut event) = (None, None, None, None);
    let mut args = args.map(|arg| arg.into_string().ok());
    while let Some(arg) = args.next() {
        match arg?.as_str() {
            "--port" => port = args.next()??.parse::<u16>().ok(),
            "--session" => session = args.next()?,
            "--token" => token = args.next()?,
            other => event = Some(other.to_owned()),
        }
    }
    let (port, session, token) = (port?, session?, token?);
    if !session.bytes().all(|b| b.is_ascii_alphanumeric()) || token.contains(['\r', '\n']) {
        return None;
    }
    let event = match event {
        Some(event) => event,
        None => {
            let mut input = String::new();
            io::stdin()
                .lock()
                .take(PAYLOAD_LIMIT as u64 + 1)
                .read_to_string(&mut input)
                .ok()?;
            input
        }
    };
    if event.len() > PAYLOAD_LIMIT {
        return None;
    }
    let mut stream = TcpStream::connect(("127.0.0.1", port)).ok()?;
    stream
        .set_write_timeout(Some(Duration::from_secs(5)))
        .ok()?;
    // The server answers a request within its own wait limit.
    stream
        .set_read_timeout(Some(REQUEST_WAIT + Duration::from_secs(30)))
        .ok()?;
    write!(
        stream,
        "POST /api/bridge?session={session} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nX-Webterminal-Token: {token}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
        event.len()
    )
    .ok()?;
    stream.write_all(event.as_bytes()).ok()?;
    let mut response = Vec::new();
    stream.take(ANSWER_LIMIT).read_to_end(&mut response).ok()?;
    let response = String::from_utf8(response).ok()?;
    let (head, body) = response.split_once("\r\n\r\n")?;
    head.starts_with("HTTP/1.1 200 ").then(|| body.to_owned())
}
