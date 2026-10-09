//! Strict small HTTP reader and embedded asset routing.
use crate::{json, session::Registry};
use std::{
    collections::BTreeMap,
    io::{self, Read, Write},
    net::TcpStream,
    path::PathBuf,
    time::{Duration, Instant},
};
pub(super) struct Request {
    pub path: String,
    pub headers: BTreeMap<String, String>,
    pub extra: Vec<u8>,
}
pub(super) fn request(stream: &mut TcpStream) -> io::Result<Request> {
    stream.set_read_timeout(Some(Duration::from_secs(2)))?;
    let mut data = Vec::new();
    let start = Instant::now();
    loop {
        if start.elapsed() > Duration::from_secs(3) {
            return Err(io::Error::new(
                io::ErrorKind::TimedOut,
                "HTTP header timeout",
            ));
        }
        let mut buffer = [0; 4096];
        let n = stream.read(&mut buffer)?;
        if n == 0 {
            return Err(io::Error::new(
                io::ErrorKind::UnexpectedEof,
                "Incomplete HTTP request",
            ));
        }
        data.extend_from_slice(&buffer[..n]);
        if data.len() > 16_384 {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "HTTP header too large",
            ));
        }
        if let Some(end) = data.windows(4).position(|p| p == b"\r\n\r\n") {
            let header = std::str::from_utf8(&data[..end]).map_err(|_| {
                io::Error::new(io::ErrorKind::InvalidData, "Invalid HTTP header encoding")
            })?;
            let mut lines = header.split("\r\n");
            let line = lines
                .next()
                .unwrap_or_default()
                .split(' ')
                .collect::<Vec<_>>();
            if line.len() != 3
                || line[0] != "GET"
                || line[2] != "HTTP/1.1"
                || !line[1].starts_with('/')
            {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidData,
                    "Only HTTP/1.1 GET is supported",
                ));
            }
            let path = line[1].to_string();
            let mut headers = BTreeMap::new();
            for line in lines {
                let (name, value) = line.split_once(':').ok_or_else(|| {
                    io::Error::new(io::ErrorKind::InvalidData, "Invalid HTTP header")
                })?;
                if !name.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')
                    || name.is_empty()
                    || value.chars().any(|c| c.is_control() && c != '\t')
                {
                    return Err(io::Error::new(
                        io::ErrorKind::InvalidData,
                        "Invalid HTTP header",
                    ));
                }
                if headers
                    .insert(name.to_ascii_lowercase(), value.trim().to_string())
                    .is_some()
                {
                    return Err(io::Error::new(
                        io::ErrorKind::InvalidData,
                        "Duplicate HTTP header",
                    ));
                }
            }
            if headers.contains_key("transfer-encoding")
                || headers.get("content-length").is_some_and(|v| v != "0")
            {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidData,
                    "Request bodies are not accepted",
                ));
            }
            return Ok(Request {
                path,
                headers,
                extra: data[end + 4..].to_vec(),
            });
        }
    }
}
pub(super) fn response(
    stream: &mut TcpStream,
    status: &str,
    mime: &str,
    body: &str,
) -> io::Result<()> {
    write!(
        stream,
        "HTTP/1.1 {status}\r\nContent-Type: {mime}\r\nContent-Length: {}\r\nConnection: close\r\nCache-Control: no-store\r\nX-Content-Type-Options: nosniff\r\nReferrer-Policy: no-referrer\r\nContent-Security-Policy: default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; font-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'\r\n\r\n{body}",
        body.len()
    )
}
pub(super) fn serve(stream: &mut TcpStream, path: &str, registry: &Registry) -> io::Result<()> {
    let asset = match path {
        "/" | "/index.html" => Some((
            "text/html; charset=utf-8",
            include_str!("../../assets/index.html"),
        )),
        "/style.css" => Some((
            "text/css; charset=utf-8",
            include_str!("../../assets/style.css"),
        )),
        "/app.js" => Some((
            "text/javascript; charset=utf-8",
            include_str!("../../assets/app.js"),
        )),
        "/input.js" => Some((
            "text/javascript; charset=utf-8",
            include_str!("../../assets/input.js"),
        )),
        "/render.js" => Some((
            "text/javascript; charset=utf-8",
            include_str!("../../assets/render.js"),
        )),
        "/updates.js" => Some((
            "text/javascript; charset=utf-8",
            include_str!("../../assets/updates.js"),
        )),
        "/workbench.js" => Some((
            "text/javascript; charset=utf-8",
            include_str!("../../assets/workbench.js"),
        )),
        "/pane.js" => Some((
            "text/javascript; charset=utf-8",
            include_str!("../../assets/pane.js"),
        )),
        "/workspace.js" => Some((
            "text/javascript; charset=utf-8",
            include_str!("../../assets/workspace.js"),
        )),
        "/menus.js" => Some((
            "text/javascript; charset=utf-8",
            include_str!("../../assets/menus.js"),
        )),
        "/notices.js" => Some((
            "text/javascript; charset=utf-8",
            include_str!("../../assets/notices.js"),
        )),
        "/directory.js" => Some((
            "text/javascript; charset=utf-8",
            include_str!("../../assets/directory.js"),
        )),
        _ => None,
    };
    if let Some((mime, body)) = asset {
        return response(stream, "200 OK", mime, body);
    }
    if path == "/api/sessions" {
        return response(stream, "200 OK", "application/json", &registry.list_json());
    }
    if path == "/api/info" {
        return response(
            stream,
            "200 OK",
            "application/json",
            &format!(
                "{{\"cwd\":{},\"shell\":{}}}",
                json::quote(&registry.cwd.to_string_lossy()),
                json::quote(&registry.shell)
            ),
        );
    }
    if let Some(path) = path.strip_prefix("/api/directories?path=") {
        return match directories(path) {
            Ok(body) => response(stream, "200 OK", "application/json", &body),
            Err(e) => response(
                stream,
                "400 Bad Request",
                "application/json",
                &format!("{{\"error\":{}}}", json::quote(&e)),
            ),
        };
    }
    response(
        stream,
        "404 Not Found",
        "text/plain; charset=utf-8",
        "Webterminal asset not found",
    )
}
fn directories(encoded: &str) -> Result<String, String> {
    let path = PathBuf::from(decode_path(encoded)?)
        .canonicalize()
        .map_err(|e| format!("Cannot open directory: {e}"))?;
    if !path.is_dir() {
        return Err("Expected a directory".into());
    }
    let mut children = Vec::new();
    for entry in path.read_dir().map_err(|e| e.to_string())?.take(4097) {
        let entry = entry.map_err(|e| e.to_string())?;
        if entry.file_type().map_err(|e| e.to_string())?.is_dir() {
            children.push((
                entry.file_name().to_string_lossy().into_owned(),
                entry.path(),
            ));
        }
    }
    children.sort_by_key(|(name, _)| name.to_lowercase());
    let dirs = children
        .iter()
        .map(|(name, path)| {
            format!(
                "{{\"name\":{},\"path\":{}}}",
                json::quote(name),
                json::quote(&path.to_string_lossy())
            )
        })
        .collect::<Vec<_>>()
        .join(",");
    Ok(format!(
        "{{\"path\":{},\"parent\":{},\"directories\":[{dirs}]}}",
        json::quote(&path.to_string_lossy()),
        path.parent()
            .map(|p| json::quote(&p.to_string_lossy()))
            .unwrap_or_else(|| "null".into())
    ))
}
fn decode_path(s: &str) -> Result<String, String> {
    if s.len() > 8192 {
        return Err("Directory path too long".into());
    }
    let mut bytes = Vec::new();
    let mut i = 0;
    while i < s.len() {
        let b = s.as_bytes()[i];
        if b == b'%' {
            let pair = s.get(i + 1..i + 3).ok_or("Invalid path encoding")?;
            bytes.push(u8::from_str_radix(pair, 16).map_err(|_| "Invalid path encoding")?);
            i += 3;
        } else {
            bytes.push(b);
            i += 1;
        }
    }
    let path = String::from_utf8(bytes).map_err(|_| "Invalid path UTF-8")?;
    if path.contains('\0') {
        return Err("Invalid directory path".into());
    }
    Ok(path)
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn directory_encoding_is_strict() {
        assert_eq!(
            decode_path("C%3A%5Ctest%20%E6%97%A5").unwrap(),
            "C:\\test 日"
        );
        for s in ["%", "%GG", "%FF", "%00"] {
            assert!(decode_path(s).is_err());
        }
    }
}
