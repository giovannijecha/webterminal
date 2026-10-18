//! `POST /api/bridge?session=` receives one program event from the bridge
//! helper. Only the helper holding the session's token is accepted; browser
//! requests, which always name an origin, are refused.
use super::http::{self, Request};
use crate::{
    bridge::{Outcome, PAYLOAD_LIMIT, REQUEST_WAIT},
    session::Registry,
};
use std::io::{self, Read};
use std::net::TcpStream;
use std::time::{Duration, Instant};

pub(super) fn handle(stream: &mut TcpStream, req: &Request, registry: &Registry) -> io::Result<()> {
    let (session, payload) = match receive(stream, req, registry) {
        Ok(event) => event,
        Err((status, error)) => {
            return http::response(stream, status, "text/plain; charset=utf-8", &error);
        }
    };
    let body = match registry.bridge.report(&session, &payload) {
        Ok(Outcome::Respond(body)) => body,
        Ok(Outcome::Wait(id)) => {
            let body = registry
                .bridge
                .wait(&id, Instant::now() + REQUEST_WAIT, || {
                    helper_waiting(stream)
                });
            if http::response(stream, "200 OK", "application/json", &body).is_err()
                && !body.is_empty()
            {
                registry.bridge.undelivered(&id);
            }
            return Ok(());
        }
        Err(error) => {
            return http::response(
                stream,
                "400 Bad Request",
                "text/plain; charset=utf-8",
                &error,
            );
        }
    };
    http::response(stream, "200 OK", "application/json", &body)
}

fn receive(
    stream: &mut TcpStream,
    req: &Request,
    registry: &Registry,
) -> Result<(String, String), (&'static str, String)> {
    let forbidden = |text: &str| ("403 Forbidden", text.to_owned());
    if req
        .headers
        .keys()
        .any(|name| name == "origin" || name.starts_with("sec-fetch-"))
    {
        return Err(forbidden("Program events come only from the bridge helper"));
    }
    let session = req.path[http::HOOK.len()..]
        .strip_prefix("session=")
        .filter(|id| id.len() <= 32 && id.bytes().all(|b| b.is_ascii_alphanumeric()))
        .ok_or_else(|| ("400 Bad Request", "Invalid bridge session".to_owned()))?;
    let token = req
        .headers
        .get("x-webterminal-token")
        .map(String::as_str)
        .unwrap_or_default();
    if !registry.bridge.authenticate(session, token) {
        return Err(forbidden("Bridge token rejected"));
    }
    let length = req
        .headers
        .get("content-length")
        .and_then(|value| value.parse::<usize>().ok())
        .filter(|length| *length <= PAYLOAD_LIMIT)
        .ok_or_else(|| {
            (
                "413 Content Too Large",
                "Program event too large".to_owned(),
            )
        })?;
    let mut body = req.extra.clone();
    if body.len() > length {
        return Err(("400 Bad Request", "Body exceeds Content-Length".into()));
    }
    stream
        .set_read_timeout(Some(Duration::from_secs(5)))
        .map_err(|e| ("400 Bad Request", e.to_string()))?;
    let mut rest = vec![0; length - body.len()];
    stream
        .read_exact(&mut rest)
        .map_err(|_| ("400 Bad Request", "Incomplete program event".to_owned()))?;
    body.extend_from_slice(&rest);
    let payload = String::from_utf8(body)
        .map_err(|_| ("400 Bad Request", "Event must be UTF-8".to_owned()))?;
    Ok((session.to_owned(), payload))
}

/// True while the helper still waits: a closed connection means the
/// program stopped waiting, for example after an answer in the terminal.
fn helper_waiting(stream: &TcpStream) -> bool {
    if stream.set_nonblocking(true).is_err() {
        return false;
    }
    let mut probe = [0; 1];
    let waiting = match stream.peek(&mut probe) {
        Ok(0) => false,
        Ok(_) => true,
        Err(e) => e.kind() == io::ErrorKind::WouldBlock,
    };
    stream.set_nonblocking(false).is_ok() && waiting
}
