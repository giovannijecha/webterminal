//! `POST /api/upload?id=&view=&epoch=&name=` stages one dropped file for the
//! view that controls the session and replies with the registered copy.
use super::http::{self, Request};
use crate::{
    json,
    session::Registry,
    uploads::{StagedCopy, UploadError},
};
use std::collections::BTreeMap;
use std::io;
use std::net::TcpStream;
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
        Ok(copy) => http::response(
            stream,
            "200 OK",
            "application/json",
            &format!(
                "{{\"path\":{},\"id\":{},\"name\":{},\"size\":{}}}",
                json::quote(&copy.path.to_string_lossy()),
                json::quote(&copy.id),
                json::quote(&copy.name),
                copy.size
            ),
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
) -> Result<StagedCopy, (&'static str, String)> {
    let bad = |error: String| ("400 Bad Request", error);
    let gone = || {
        (
            "410 Gone",
            "Terminal session closed during the upload".to_string(),
        )
    };
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
    let pending = registry
        .uploads
        .receive(id, name, length, &req.extra, stream)
        .map_err(|error| match error {
            UploadError::Full => ("507 Insufficient Storage", error.to_string()),
            UploadError::Closed => gone(),
            UploadError::Failed(error) => bad(format!("Upload failed: {error}")),
        })?;
    // The body is complete: the copy is listed only if the same view still
    // controls a live session. Returning early drops and deletes `pending`.
    if registry.get(id).is_err() {
        return Err(gone());
    }
    session
        .with_control(view, epoch, || Ok(pending.commit()))
        .map_err(|_| {
            (
                "409 Conflict",
                "Control changed during upload; the copy was discarded".into(),
            )
        })?
        .map_err(|_| gone())
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
