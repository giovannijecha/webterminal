//! Owned loopback Responses/Messages fixture for manual CLI terminal checks.
//! Request bodies are consumed only to enforce bounds; no request content is logged.
use std::collections::BTreeSet;
use std::io::{self, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

const HEADER_LIMIT: usize = 16 * 1024;
const BODY_LIMIT: usize = 2 * 1024 * 1024;
const CONNECTION_LIMIT: usize = 64;
const REQUEST_LIMIT: usize = 32;
const TEXT: &str = "Webterminal local fixture response.";

struct Request {
    method: String,
    path: String,
    host: String,
}

fn main() -> io::Result<()> {
    let listener = TcpListener::bind(("127.0.0.1", 0))?;
    let port = listener.local_addr()?.port();
    println!("http://127.0.0.1:{port}/v1");
    io::stdout().flush()?;
    let mut connections = 0;
    let mut requests = 0;
    let mut responses_submitted = 0usize;
    let mut messages_submitted = 0usize;
    while connections < CONNECTION_LIMIT && requests < REQUEST_LIMIT {
        let (mut stream, _) = listener.accept()?;
        connections += 1;
        stream.set_read_timeout(Some(Duration::from_secs(5)))?;
        stream.set_write_timeout(Some(Duration::from_secs(5)))?;
        let request = match read_request(&mut stream) {
            Ok(request) => request,
            Err(status) => {
                let _ = reply(&mut stream, status, "application/json", "{}");
                continue;
            }
        };
        requests += 1;
        let route = match request.path.as_str() {
            "/v1/responses" => "/v1/responses",
            "/v1/messages" => "/v1/messages",
            "/v1/messages/count_tokens" => "/v1/messages/count_tokens",
            "/v1/models" => "/v1/models",
            "/fixture/status" => "/fixture/status",
            _ => "<unknown>",
        };
        eprintln!("{} {route} #{requests}", request.method);
        if request.host != format!("127.0.0.1:{port}") {
            let _ = reply(&mut stream, "403 Forbidden", "application/json", "{}");
            continue;
        }
        let (status, mime, body) = match (request.method.as_str(), request.path.as_str()) {
            ("POST", "/v1/responses") => {
                responses_submitted += 1;
                ("200 OK", "text/event-stream", responses_stream())
            }
            ("POST", "/v1/messages") => {
                messages_submitted += 1;
                ("200 OK", "text/event-stream", messages_stream())
            }
            ("GET", "/fixture/status") => (
                "200 OK",
                "application/json",
                format!(
                    "{{\"responses\":{responses_submitted},\"messages\":{messages_submitted}}}"
                ),
            ),
            ("POST", "/v1/messages/count_tokens") => {
                ("200 OK", "application/json", r#"{"input_tokens":32}"#.into())
            }
            ("GET", "/v1/models") => (
                "200 OK",
                "application/json",
                r#"{"object":"list","data":[{"id":"fixture-model","object":"model","type":"model","created":1,"created_at":"2024-01-01T00:00:00Z","display_name":"Webterminal fixture","owned_by":"webterminal"}],"has_more":false,"first_id":"fixture-model","last_id":"fixture-model"}"#.into(),
            ),
            (_, "/v1/responses" | "/v1/messages" | "/v1/messages/count_tokens" | "/v1/models") => {
                ("405 Method Not Allowed", "application/json", "{}".into())
            }
            _ => ("404 Not Found", "application/json", "{}".into()),
        };
        let _ = reply(&mut stream, status, mime, &body);
    }
    Ok(())
}

fn read_request(stream: &mut TcpStream) -> Result<Request, &'static str> {
    let mut bytes = Vec::new();
    let end = loop {
        let mut buffer = [0; 4096];
        let n = stream
            .read(&mut buffer)
            .map_err(|_| "408 Request Timeout")?;
        if n == 0 {
            return Err("400 Bad Request");
        }
        bytes.extend_from_slice(&buffer[..n]);
        if let Some(end) = bytes.windows(4).position(|part| part == b"\r\n\r\n") {
            if end + 4 > HEADER_LIMIT {
                return Err("431 Request Header Fields Too Large");
            }
            break end;
        }
        if bytes.len() > HEADER_LIMIT {
            return Err("431 Request Header Fields Too Large");
        }
    };
    let header = std::str::from_utf8(&bytes[..end]).map_err(|_| "400 Bad Request")?;
    let mut lines = header.split("\r\n");
    let mut request_line = lines.next().unwrap_or_default().split(' ');
    let method = request_line.next().ok_or("400 Bad Request")?;
    let path = request_line.next().ok_or("400 Bad Request")?;
    let version = request_line.next().ok_or("400 Bad Request")?;
    if request_line.next().is_some()
        || version != "HTTP/1.1"
        || !path.starts_with('/')
        || !matches!(method, "GET" | "POST")
    {
        return Err("400 Bad Request");
    }
    let mut names = BTreeSet::new();
    let mut host = None;
    let mut length = None;
    for line in lines {
        let (name, value) = line.split_once(':').ok_or("400 Bad Request")?;
        if name.is_empty()
            || !name
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
            || value.chars().any(|ch| ch.is_control() && ch != '\t')
        {
            return Err("400 Bad Request");
        }
        let name = name.to_ascii_lowercase();
        if !names.insert(name.clone()) {
            return Err("400 Bad Request");
        }
        match name.as_str() {
            "host" => host = Some(value.trim().to_owned()),
            "content-length" => {
                length = Some(
                    value
                        .trim()
                        .parse::<usize>()
                        .map_err(|_| "400 Bad Request")?,
                );
            }
            "transfer-encoding" => return Err("501 Not Implemented"),
            "expect" => return Err("417 Expectation Failed"),
            _ => {}
        }
    }
    let length = match (method, length) {
        ("POST", None) => return Err("411 Length Required"),
        (_, value) => value.unwrap_or(0),
    };
    if length > BODY_LIMIT {
        return Err("413 Content Too Large");
    }
    let already = bytes.len() - end - 4;
    if already > length {
        return Err("400 Bad Request");
    }
    let mut remaining = length - already;
    while remaining > 0 {
        let mut buffer = [0; 4096];
        let count = remaining.min(buffer.len());
        let n = stream
            .read(&mut buffer[..count])
            .map_err(|_| "408 Request Timeout")?;
        if n == 0 {
            return Err("400 Bad Request");
        }
        remaining -= n;
    }
    Ok(Request {
        method: method.to_owned(),
        path: path.split('?').next().unwrap_or(path).to_owned(),
        host: host.ok_or("400 Bad Request")?,
    })
}

fn reply(stream: &mut TcpStream, status: &str, mime: &str, body: &str) -> io::Result<()> {
    let header = format!(
        "HTTP/1.1 {status}\r\nContent-Type: {mime}; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\nCache-Control: no-store\r\nX-Content-Type-Options: nosniff\r\n\r\n",
        body.len()
    );
    stream.write_all(header.as_bytes())?;
    stream.write_all(body.as_bytes())
}

fn push_event(body: &mut String, kind: &str, data: &str) {
    body.push_str("event: ");
    body.push_str(kind);
    body.push_str("\ndata: ");
    body.push_str(data);
    body.push_str("\n\n");
}

fn responses_stream() -> String {
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    let part =
        format!(r#"{{"type":"output_text","text":"{TEXT}","annotations":[],"logprobs":[]}}"#);
    let message = format!(
        r#"{{"id":"msg_webterminal_fixture","type":"message","role":"assistant","status":"completed","phase":"final_answer","content":[{part}]}}"#
    );
    let created = format!(
        r#"{{"id":"resp_webterminal_fixture","object":"response","created_at":{now},"status":"in_progress","model":"fixture-model","output":[],"usage":null}}"#
    );
    let completed = format!(
        r#"{{"id":"resp_webterminal_fixture","object":"response","created_at":{now},"completed_at":{now},"status":"completed","model":"fixture-model","output":[{message}],"usage":{{"input_tokens":1,"output_tokens":6,"total_tokens":7,"input_tokens_details":{{"cached_tokens":0}},"output_tokens_details":{{"reasoning_tokens":0}}}}}}"#
    );
    let mut body = String::new();
    push_event(
        &mut body,
        "response.created",
        &format!(r#"{{"type":"response.created","sequence_number":1,"response":{created}}}"#),
    );
    push_event(
        &mut body,
        "response.output_item.added",
        r#"{"type":"response.output_item.added","sequence_number":2,"output_index":0,"item":{"id":"msg_webterminal_fixture","type":"message","role":"assistant","status":"in_progress","phase":"final_answer","content":[]}}"#,
    );
    push_event(
        &mut body,
        "response.content_part.added",
        r#"{"type":"response.content_part.added","sequence_number":3,"item_id":"msg_webterminal_fixture","output_index":0,"content_index":0,"part":{"type":"output_text","text":"","annotations":[],"logprobs":[]}}"#,
    );
    push_event(
        &mut body,
        "response.output_text.delta",
        &format!(
            r#"{{"type":"response.output_text.delta","sequence_number":4,"item_id":"msg_webterminal_fixture","output_index":0,"content_index":0,"delta":"{TEXT}","logprobs":[]}}"#
        ),
    );
    push_event(
        &mut body,
        "response.output_text.done",
        &format!(
            r#"{{"type":"response.output_text.done","sequence_number":5,"item_id":"msg_webterminal_fixture","output_index":0,"content_index":0,"text":"{TEXT}","logprobs":[]}}"#
        ),
    );
    push_event(
        &mut body,
        "response.content_part.done",
        &format!(
            r#"{{"type":"response.content_part.done","sequence_number":6,"item_id":"msg_webterminal_fixture","output_index":0,"content_index":0,"part":{part}}}"#
        ),
    );
    push_event(
        &mut body,
        "response.output_item.done",
        &format!(
            r#"{{"type":"response.output_item.done","sequence_number":7,"output_index":0,"item":{message}}}"#
        ),
    );
    push_event(
        &mut body,
        "response.completed",
        &format!(r#"{{"type":"response.completed","sequence_number":8,"response":{completed}}}"#),
    );
    body.push_str("data: [DONE]\n\n");
    body
}

fn messages_stream() -> String {
    let mut body = String::new();
    push_event(
        &mut body,
        "message_start",
        r#"{"type":"message_start","message":{"id":"msg_webterminal_fixture","type":"message","role":"assistant","content":[],"model":"fixture-model","stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":32,"output_tokens":0}}}"#,
    );
    push_event(
        &mut body,
        "content_block_start",
        r#"{"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}"#,
    );
    push_event(
        &mut body,
        "content_block_delta",
        &format!(
            r#"{{"type":"content_block_delta","index":0,"delta":{{"type":"text_delta","text":"{TEXT}"}}}}"#
        ),
    );
    push_event(
        &mut body,
        "content_block_stop",
        r#"{"type":"content_block_stop","index":0}"#,
    );
    push_event(
        &mut body,
        "message_delta",
        r#"{"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null},"usage":{"output_tokens":6}}"#,
    );
    push_event(&mut body, "message_stop", r#"{"type":"message_stop"}"#);
    body
}
