//! Strict small HTTP reader and embedded asset routing.
use super::{Context, api};
use crate::json;
use std::{
    collections::BTreeMap,
    io::{self, Read, Write},
    net::TcpStream,
    path::PathBuf,
    time::{Duration, Instant},
};
pub(super) const UPLOAD: &str = "/api/upload?";
/// POST exists only to stage dropped files.
#[derive(Clone, Copy, PartialEq, Eq)]
pub(super) enum Route {
    Get,
    Upload,
}
pub(super) struct Request {
    pub route: Route,
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
            let route = match (line.first(), line.get(1)) {
                (Some(&"GET"), _) => Route::Get,
                (Some(&"POST"), Some(path)) if path.starts_with(UPLOAD) => Route::Upload,
                _ => Route::Get,
            };
            if line.len() != 3
                || (line[0] != "GET" && route == Route::Get)
                || line[2] != "HTTP/1.1"
                || !line[1].starts_with('/')
            {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidData,
                    "Only HTTP/1.1 GET and file uploads are supported",
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
                || (route == Route::Get && headers.get("content-length").is_some_and(|v| v != "0"))
            {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidData,
                    "Request bodies are not accepted",
                ));
            }
            return Ok(Request {
                route,
                path,
                headers,
                extra: data[end + 4..].to_vec(),
            });
        }
    }
}
const POLICY: &str = "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; font-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'";
pub(super) fn response(
    stream: &mut TcpStream,
    status: &str,
    mime: &str,
    body: &str,
) -> io::Result<()> {
    response_bytes(stream, status, mime, body.as_bytes())
}
fn response_bytes(stream: &mut TcpStream, status: &str, mime: &str, body: &[u8]) -> io::Result<()> {
    write!(
        stream,
        "HTTP/1.1 {status}\r\nContent-Type: {mime}\r\nContent-Length: {}\r\nConnection: close\r\nCache-Control: no-store\r\nX-Content-Type-Options: nosniff\r\nReferrer-Policy: no-referrer\r\nContent-Security-Policy: {POLICY}\r\n\r\n",
        body.len()
    )?;
    stream.write_all(body)
}
const SCRIPT: &str = "text/javascript; charset=utf-8";
const STYLE: &str = "text/css; charset=utf-8";
macro_rules! assets {
    ($(($route:literal, $mime:expr, $file:literal)),* $(,)?) => {
        &[$(($route, $mime, include_bytes!(concat!("../../assets/", $file)) as &[u8])),*]
    };
}
const ASSETS: &[(&str, &str, &[u8])] = assets![
    ("/index.html", "text/html; charset=utf-8", "index.html"),
    ("/style.css", STYLE, "style.css"),
    ("/shell.css", STYLE, "shell.css"),
    ("/terminal.css", STYLE, "terminal.css"),
    ("/overlays.css", STYLE, "overlays.css"),
    ("/inventory.css", STYLE, "inventory.css"),
    ("/files.css", STYLE, "files.css"),
    ("/system.css", STYLE, "system.css"),
    ("/favicon.svg", "image/svg+xml", "favicon.svg"),
    (
        "/fonts/nunito-latin.woff2",
        "font/woff2",
        "fonts/nunito-latin.woff2"
    ),
    (
        "/fonts/nunito-latin-ext.woff2",
        "font/woff2",
        "fonts/nunito-latin-ext.woff2"
    ),
    (
        "/fonts/NUNITO-LICENSE.txt",
        "text/plain; charset=utf-8",
        "fonts/NUNITO-LICENSE.txt"
    ),
    ("/app.js", SCRIPT, "app.js"),
    ("/model.js", SCRIPT, "model.js"),
    ("/connection.js", SCRIPT, "connection.js"),
    ("/dom.js", SCRIPT, "dom.js"),
    ("/ui.js", SCRIPT, "ui.js"),
    ("/overlays.js", SCRIPT, "overlays.js"),
    ("/actions.js", SCRIPT, "actions.js"),
    ("/launcher.js", SCRIPT, "launcher.js"),
    ("/transfers.js", SCRIPT, "transfers.js"),
    ("/sidebar.js", SCRIPT, "sidebar.js"),
    ("/workspace.js", SCRIPT, "workspace.js"),
    ("/palette.js", SCRIPT, "palette.js"),
    ("/pane.js", SCRIPT, "pane.js"),
    ("/input.js", SCRIPT, "input.js"),
    ("/render.js", SCRIPT, "render.js"),
    ("/updates.js", SCRIPT, "updates.js"),
    ("/common.js", SCRIPT, "common.js"),
    ("/upload.js", SCRIPT, "upload.js"),
    ("/directory.js", SCRIPT, "directory.js"),
    ("/overview.js", SCRIPT, "overview.js"),
    ("/toasts.js", SCRIPT, "toasts.js"),
    ("/processes.js", SCRIPT, "processes.js"),
    ("/files.js", SCRIPT, "files.js"),
    ("/settings.js", SCRIPT, "settings.js"),
    ("/preferences.js", SCRIPT, "preferences.js"),
];
pub(super) fn serve(stream: &mut TcpStream, path: &str, context: &Context) -> io::Result<()> {
    let route = if path == "/" { "/index.html" } else { path };
    if let Some((_, mime, body)) = ASSETS.iter().find(|(name, ..)| *name == route) {
        return response_bytes(stream, "200 OK", mime, body);
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
    if let Some(body) = api::get(path, context) {
        return response(stream, "200 OK", "application/json", &body);
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
pub(super) fn decode_path(s: &str) -> Result<String, String> {
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
