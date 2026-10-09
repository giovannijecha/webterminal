//! `POST /api/upload?id=&view=&epoch=&name=` stages one dropped file for the
//! view that controls the session and replies with its local path.
use super::http::{self, Request};
use crate::{json, session::Registry};
use std::collections::BTreeMap;
use std::io;
use std::net::TcpStream;
use std::path::PathBuf;
use std::time::Duration;

// A stalled browser transfer releases its connection and partial file.
const IDLE: Duration = Duration::from_secs(30);

pub(super) fn handle(
    stream: &mut TcpStream,
    req: &Request,
    registry: &Registry,
    origin: &str,
) -> io::Result<()> {
    // Uploads come only from the page's own fetch, which always names its origin.
    let result = if req.headers.get("origin").map(String::as_str) == Some(origin) {
        receive(stream, req, registry)
    } else {
        Err(("403 Forbidden", "Same-origin upload required".into()))
    };
    match result {
        Ok(path) => http::response(
            stream,
            "200 OK",
            "application/json",
            &format!("{{\"path\":{}}}", json::quote(&path.to_string_lossy())),
        ),
        Err((status, error)) => http::response(
            stream,
            status,
            "application/json",
            &format!("{{\"error\":{}}}", json::quote(&error)),
        ),
    }
}

fn receive(
    stream: &mut TcpStream,
    req: &Request,
    registry: &Registry,
) -> Result<PathBuf, (&'static str, String)> {
    let bad = |error: String| ("400 Bad Request", error);
    let query = query(&req.path[http::UPLOAD.len()..]).map_err(bad)?;
    let field = |name: &str| {
        query
            .get(name)
            .map(String::as_str)
            .ok_or_else(|| bad(format!("Upload needs {name}")))
    };
    let (id, view, name) = (field("id")?, field("view")?, field("name")?);
    let epoch = field("epoch")?
        .parse::<i64>()
        .map_err(|_| bad("Invalid upload epoch".into()))?;
    let length = req
        .headers
        .get("content-length")
        .and_then(|value| value.parse::<u64>().ok())
        .ok_or_else(|| ("411 Length Required", "Upload needs Content-Length".into()))?;
    if length > crate::uploads::FILE_LIMIT {
        return Err((
            "413 Content Too Large",
            "Dropped files are limited to 1 GiB each".into(),
        ));
    }
    let session = registry.get(id).map_err(|error| ("404 Not Found", error))?;
    session
        .check_control(view, epoch)
        .map_err(|error| ("409 Conflict", error))?;
    stream
        .set_read_timeout(Some(IDLE))
        .map_err(|error| bad(error.to_string()))?;
    let path = registry
        .uploads
        .receive(id, name, length, &req.extra, stream)
        .map_err(|error| bad(format!("Upload failed: {error}")))?;
    if registry.get(id).is_err() {
        registry.uploads.discard(&path);
        return Err((
            "410 Gone",
            "Terminal session closed during the upload".into(),
        ));
    }
    Ok(path)
}

fn query(text: &str) -> Result<BTreeMap<String, String>, String> {
    let mut fields = BTreeMap::new();
    for pair in text.split('&') {
        let (key, value) = pair.split_once('=').ok_or("Invalid upload query")?;
        let value = http::decode_path(value).map_err(|_| "Invalid upload query")?;
        if fields.insert(key.to_string(), value).is_some() {
            return Err("Duplicate upload query field".into());
        }
    }
    Ok(fields)
}
