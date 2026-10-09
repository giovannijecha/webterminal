//! Loopback-only HTTP/WebSocket service with bounded connections and messages.
mod http;
mod upload;
use crate::{
    json, native,
    session::{self, Registry, WorkspaceClose},
    terminal::SnapshotBaseline,
    uploads::Uploads,
    websocket::{self, Decoder, Message},
};
use std::collections::BTreeMap;
use std::io::{self, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::PathBuf;
use std::sync::{
    Arc,
    atomic::{AtomicBool, AtomicUsize, Ordering},
};
use std::thread;
use std::time::{Duration, Instant};

const PUBLISH_INTERVAL: Duration = Duration::from_millis(16);

pub struct Config {
    pub port: u16,
    pub cwd: PathBuf,
    pub shell: String,
}
pub struct Server {
    listener: TcpListener,
    registry: Arc<Registry>,
    stop: Arc<AtomicBool>,
    pub port: u16,
}
impl Server {
    pub fn bind(config: Config) -> io::Result<Self> {
        if [4173, 4174].contains(&config.port) {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "Ports 4173 and 4174 are reserved by this build",
            ));
        }
        let listener = TcpListener::bind(("127.0.0.1", config.port)).map_err(|e| {
            io::Error::new(
                e.kind(),
                format!(
                    "Cannot bind 127.0.0.1:{}: {e}. No existing process was stopped.",
                    config.port
                ),
            )
        })?;
        listener.set_nonblocking(true)?;
        let port = listener.local_addr()?.port();
        Ok(Self {
            listener,
            registry: Arc::new(Registry::new(
                config.cwd,
                config.shell,
                Uploads::temporary(format!("{}-{port}", std::process::id())),
            )),
            stop: Arc::new(AtomicBool::new(false)),
            port,
        })
    }
    pub fn shutdown_signal(&self) -> Arc<AtomicBool> {
        self.stop.clone()
    }
    pub fn run(self) -> io::Result<()> {
        let active = Arc::new(AtomicUsize::new(0));
        while !self.stop.load(Ordering::Relaxed) && !native::shutdown_requested() {
            match self.listener.accept() {
                Ok((stream, _)) => {
                    if active.fetch_add(1, Ordering::Relaxed) >= 64 {
                        active.fetch_sub(1, Ordering::Relaxed);
                        drop(stream);
                        continue;
                    }
                    let (registry, stop, count, port) = (
                        self.registry.clone(),
                        self.stop.clone(),
                        active.clone(),
                        self.port,
                    );
                    thread::spawn(move || {
                        let _guard = ConnectionCount(count);
                        let _ = connection(stream, port, registry, stop);
                    });
                }
                Err(e) if e.kind() == io::ErrorKind::WouldBlock => {
                    thread::sleep(Duration::from_millis(10))
                }
                Err(e) => {
                    self.stop.store(true, Ordering::Relaxed);
                    self.registry.shutdown();
                    return Err(e);
                }
            }
        }
        self.stop.store(true, Ordering::Relaxed);
        self.registry.shutdown();
        Ok(())
    }
}
struct ConnectionCount(Arc<AtomicUsize>);
impl Drop for ConnectionCount {
    fn drop(&mut self) {
        self.0.fetch_sub(1, Ordering::Relaxed);
    }
}
struct ViewGuard {
    registry: Arc<Registry>,
    view: String,
}
struct Attachment {
    revision: u64,
    event_seq: u64,
    baseline: Option<SnapshotBaseline>,
}
impl Attachment {
    fn new(updates: bool, event_seq: u64) -> Self {
        Self {
            revision: 0,
            event_seq,
            baseline: updates.then(SnapshotBaseline::default),
        }
    }
}
impl Drop for ViewGuard {
    fn drop(&mut self) {
        self.registry.detach_view(&self.view);
    }
}

fn connection(
    mut stream: TcpStream,
    port: u16,
    registry: Arc<Registry>,
    stop: Arc<AtomicBool>,
) -> io::Result<()> {
    // Windows accepted sockets inherit the nonblocking listener's mode.
    // Request and frame readers use bounded blocking I/O on their own thread.
    stream.set_nonblocking(false)?;
    stream.set_write_timeout(Some(Duration::from_millis(500)))?;
    stream.set_nodelay(true)?;
    let req = match http::request(&mut stream) {
        Ok(r) => r,
        Err(error) => {
            return http::response(
                &mut stream,
                "400 Bad Request",
                "text/plain; charset=utf-8",
                &format!("Invalid HTTP request: {error}"),
            );
        }
    };
    let host = format!("127.0.0.1:{port}");
    let origin = format!("http://{host}");
    if req.headers.get("host") != Some(&host)
        || req.headers.get("origin").is_some_and(|v| v != &origin)
        || req
            .headers
            .get("sec-fetch-site")
            .is_some_and(|v| v == "cross-site")
    {
        return http::response(
            &mut stream,
            "403 Forbidden",
            "text/plain; charset=utf-8",
            "Foreign Host or Origin rejected",
        );
    }
    if req.path == "/ws" {
        let valid = req
            .headers
            .get("upgrade")
            .is_some_and(|v| v.eq_ignore_ascii_case("websocket"))
            && req.headers.get("connection").is_some_and(|v| {
                v.split(',')
                    .any(|p| p.trim().eq_ignore_ascii_case("upgrade"))
            });
        let key = req
            .headers
            .get("sec-websocket-key")
            .and_then(|v| websocket::accept_key(v));
        if !valid
            || req.headers.get("sec-websocket-version").map(String::as_str) != Some("13")
            || req.headers.get("origin") != Some(&origin)
            || key.is_none()
        {
            return http::response(
                &mut stream,
                "403 Forbidden",
                "text/plain; charset=utf-8",
                "Valid same-origin WebSocket handshake required",
            );
        }
        write!(
            stream,
            "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: {}\r\n\r\n",
            key.unwrap()
        )?;
        socket_loop(stream, registry, stop, &req.extra)
    } else if req.upload {
        upload::handle(&mut stream, &req, &registry, &origin)
    } else {
        http::serve(&mut stream, &req.path, &registry)
    }
}
fn socket_loop(
    mut stream: TcpStream,
    registry: Arc<Registry>,
    stop: Arc<AtomicBool>,
    initial: &[u8],
) -> io::Result<()> {
    stream.set_read_timeout(Some(Duration::from_millis(8)))?;
    let view = session::new_view();
    let _guard = ViewGuard {
        registry: registry.clone(),
        view: view.clone(),
    };
    websocket::send_text(
        &mut stream,
        &format!(
            "{{\"type\":\"hello\",\"view\":{},\"cwd\":{},\"shell\":{}}}",
            json::quote(&view),
            json::quote(&registry.cwd.to_string_lossy()),
            json::quote(&registry.shell)
        ),
    )?;
    let mut decoder = Decoder::default();
    decoder.push(initial)?;
    let mut attached: BTreeMap<String, Attachment> = BTreeMap::new();
    let mut last_list = String::new();
    let mut last_frame = Instant::now();
    let mut last_ping = Instant::now();
    let mut last_publish = Instant::now() - PUBLISH_INTERVAL;
    while !stop.load(Ordering::Relaxed) {
        let mut buffer = [0; 16384];
        match stream.read(&mut buffer) {
            Ok(0) => break,
            Ok(n) => {
                decoder.push(&buffer[..n])?;
                last_frame = Instant::now();
            }
            Err(e)
                if [
                    io::ErrorKind::WouldBlock,
                    io::ErrorKind::TimedOut,
                    io::ErrorKind::Interrupted,
                ]
                .contains(&e.kind()) => {}
            Err(e) => return Err(e),
        }
        let mut count = 0;
        while let Some(message) = decoder.next()? {
            count += 1;
            if count > 128 {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidData,
                    "Too many WebSocket messages",
                ));
            }
            match message {
                Message::Close => {
                    websocket::write_frame(&mut stream, 8, &[])?;
                    return Ok(());
                }
                Message::Ping(data) => websocket::write_frame(&mut stream, 10, &data)?,
                Message::Text(text) => match json::parse(&text) {
                    Ok(command) => {
                        match command_action(&command, &registry, &view, &mut attached) {
                            Ok(Some(reply)) => websocket::send_text(&mut stream, &reply)?,
                            Ok(None) => {}
                            Err(error) => websocket::send_text(
                                &mut stream,
                                &command_error(&error, Some(&command)),
                            )?,
                        }
                    }
                    Err(error) => websocket::send_text(&mut stream, &command_error(&error, None))?,
                },
            }
        }
        if last_publish.elapsed() >= PUBLISH_INTERVAL {
            let list = registry.list_json();
            if list != last_list {
                websocket::send_text(&mut stream, &list)?;
                last_list = list;
            }
            attached.retain(|id, _| registry.get(id).is_ok());
            for (id, attachment) in &mut attached {
                if let Ok(session) = registry.get(id) {
                    if let Some((seq, snapshot)) =
                        session.snapshot(attachment.revision, attachment.baseline.as_mut())
                    {
                        if snapshot.len() > 32 * 1024 * 1024 {
                            return Err(io::Error::new(
                                io::ErrorKind::InvalidData,
                                "Terminal snapshot limit exceeded",
                            ));
                        }
                        websocket::send_text(&mut stream, &snapshot)?;
                        attachment.revision = seq;
                    }
                    for (seq, event) in session.events(attachment.event_seq) {
                        websocket::send_text(&mut stream, &event)?;
                        attachment.event_seq = seq;
                    }
                }
            }
            last_publish = Instant::now();
        }
        if last_ping.elapsed() > Duration::from_secs(20) {
            websocket::write_frame(&mut stream, 9, b"webterminal")?;
            last_ping = Instant::now();
        }
        if last_frame.elapsed() > Duration::from_secs(65) {
            break;
        }
    }
    Ok(())
}
fn command_action(
    command: &json::Value,
    registry: &Registry,
    view: &str,
    attached: &mut BTreeMap<String, Attachment>,
) -> Result<Option<String>, String> {
    let op = command.field("op")?;
    match op {
        "list" => return Ok(Some(registry.list_json())),
        "create" => {
            let request = create_request(command)?;
            let updates = wants_updates(command)?;
            let size = session::geometry(command)?;
            if command.get("profile").is_some() {
                return Err("Per-terminal shell selection is not supported".into());
            }
            let workspace = match command.get("workspace") {
                None => None,
                Some(value) => Some(value.string().ok_or("Workspace must be a workspace ID")?),
            };
            let (session, workspace) = registry.create(
                &PathBuf::from(command.field("cwd")?),
                size.0,
                size.1,
                view,
                workspace,
            )?;
            attached.insert(session.id.clone(), Attachment::new(updates, 0));
            return Ok(Some(format!(
                "{{\"type\":\"created\",\"id\":{},\"workspace\":{}{}}}",
                json::quote(&session.id),
                json::quote(&workspace),
                request_field(request),
            )));
        }
        "create-workspace" => {
            let request = create_request(command)?;
            let id = registry.create_workspace()?;
            return Ok(Some(format!(
                "{{\"type\":\"workspace-created\",\"id\":{}{}}}",
                json::quote(&id),
                request_field(request),
            )));
        }
        "rename-workspace" => {
            registry.rename_workspace(command.field("id")?, command.field("name")?)?;
            return Ok(None);
        }
        "close-workspace" => {
            let id = command.field("id")?;
            let confirmed = confirmed_targets(command)?;
            match registry.close_workspace(id, confirmed.as_deref())? {
                WorkspaceClose::Busy { sessions, targets } => {
                    return Ok(Some(format!(
                        "{{\"type\":\"busy\",\"op\":\"close-workspace\",\"id\":{},\"sessions\":{},\"targets\":{}}}",
                        json::quote(id),
                        json_ids(&sessions),
                        json_ids(&targets)
                    )));
                }
                WorkspaceClose::Closed => {}
            }
            attached.retain(|id, _| registry.get(id).is_ok());
            return Ok(None);
        }
        "order-workspaces" => {
            let Some(json::Value::Array(values)) = command.get("ids") else {
                return Err("Order must be an array of workspace IDs".into());
            };
            let ids = values
                .iter()
                .map(|value| {
                    value
                        .string()
                        .map(str::to_owned)
                        .ok_or("Order must be an array of workspace IDs".into())
                })
                .collect::<Result<Vec<_>, String>>()?;
            registry.order_workspaces(&ids)?;
            return Ok(None);
        }
        "move" => {
            let position = command.integer("position")?;
            if position < 0 {
                return Err("Position must not be negative".into());
            }
            registry.move_session(
                command.field("id")?,
                command.field("workspace")?,
                position as usize,
            )?;
            return Ok(None);
        }
        _ => {}
    }
    let id = command.field("id")?;
    let session = registry.get(id)?;
    match op {
        "rename" => registry.rename(id, command.field("name")?)?,
        "attach" => {
            let updates = wants_updates(command)?;
            let request = if command.get("request").is_some() {
                let number = command.integer("request")?;
                if number <= 0 {
                    return Err("Attachment request must be positive".into());
                }
                Some(number)
            } else {
                None
            };
            session.attach(view, session::geometry(command)?)?;
            let event_seq = attached
                .get(id)
                .map_or_else(|| session.latest_event(), |old| old.event_seq);
            attached.insert(id.into(), Attachment::new(updates, event_seq));
            if let Some(request) = request {
                return Ok(Some(format!(
                    "{{\"type\":\"attached\",\"id\":{},\"request\":{request}}}",
                    json::quote(id)
                )));
            }
        }
        "detach" => {
            session.detach(view);
            attached.remove(id);
        }
        "claim" => session.claim(view, session::geometry(command)?)?,
        "release" => session.release(view)?,
        "close" => {
            let busy = session.busy().then(|| id.to_owned()).into_iter().collect();
            if let Some(reply) = busy_reply(command, op, id, busy) {
                return Ok(Some(reply));
            }
            registry.close(id)?;
            attached.remove(id);
        }
        "input" => session.send_input(
            view,
            command.integer("epoch")?,
            command.integer("seq")?,
            command.field("data")?,
        )?,
        "resize" => session.resize(view, command.integer("epoch")?, session::geometry(command)?)?,
        _ => return Err("Unknown terminal operation".into()),
    }
    Ok(None)
}

/// Closing a running program needs the client to confirm and resend with
/// `force`; terminals idle at their shell close at once.
fn busy_reply(command: &json::Value, op: &str, id: &str, busy: Vec<String>) -> Option<String> {
    if busy.is_empty() || matches!(command.get("force"), Some(json::Value::Bool(true))) {
        return None;
    }
    Some(format!(
        "{{\"type\":\"busy\",\"op\":{},\"id\":{},\"sessions\":{}}}",
        json::quote(op),
        json::quote(id),
        json_ids(&busy)
    ))
}

fn json_ids(ids: &[String]) -> String {
    format!(
        "[{}]",
        ids.iter()
            .map(|id| json::quote(id))
            .collect::<Vec<_>>()
            .join(",")
    )
}

fn confirmed_targets(command: &json::Value) -> Result<Option<Vec<String>>, String> {
    let forced = match command.get("force") {
        None | Some(json::Value::Bool(false)) => false,
        Some(json::Value::Bool(true)) => true,
        _ => return Err("Workspace force must be a boolean".into()),
    };
    if !forced {
        if command.get("confirmed").is_some() {
            return Err("Workspace confirmation requires force".into());
        }
        return Ok(None);
    }
    let Some(json::Value::Array(values)) = command.get("confirmed") else {
        return Err("Workspace force requires confirmed session IDs".into());
    };
    if values.len() > 4 {
        return Err("Workspace confirmation has too many session IDs".into());
    }
    let mut confirmed = Vec::with_capacity(values.len());
    for value in values {
        let id = value
            .string()
            .ok_or("Workspace confirmation must contain session IDs")?;
        if confirmed.iter().any(|existing| existing == id) {
            return Err("Workspace confirmation contains duplicate session IDs".into());
        }
        confirmed.push(id.to_owned());
    }
    Ok(Some(confirmed))
}

const MAX_SAFE_REQUEST: i64 = 9_007_199_254_740_991;

fn valid_request(command: &json::Value) -> Option<i64> {
    command
        .get("request")
        .and_then(json::Value::number)
        .filter(|value| (1..=MAX_SAFE_REQUEST).contains(value))
}

fn create_request(command: &json::Value) -> Result<Option<i64>, String> {
    if command.get("request").is_none() {
        return Ok(None);
    }
    valid_request(command)
        .map(Some)
        .ok_or_else(|| "Create request must be a positive safe integer".into())
}

fn request_field(request: Option<i64>) -> String {
    request.map_or_else(String::new, |value| format!(",\"request\":{value}"))
}

fn command_error(error: &str, command: Option<&json::Value>) -> String {
    let mut reply = format!("{{\"type\":\"error\",\"message\":{}", json::quote(error));
    if let Some(command) = command {
        if let Some(op) = command.get("op").and_then(json::Value::string) {
            reply.push_str(&format!(",\"op\":{}", json::quote(op)));
        }
        if let Some(request) = valid_request(command) {
            reply.push_str(&format!(",\"request\":{request}"));
        }
    }
    reply.push('}');
    reply
}

fn wants_updates(command: &json::Value) -> Result<bool, String> {
    match command.get("updates") {
        Some(json::Value::Bool(value)) => Ok(*value),
        None => Ok(false),
        _ => Err("Updates must be a boolean".into()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn reserved_and_occupied_ports_never_replace_an_owner() {
        for port in [4173, 4174] {
            assert!(
                Server::bind(Config {
                    port,
                    cwd: PathBuf::from("."),
                    shell: "cmd.exe /d /q".into()
                })
                .is_err()
            );
        }
        let occupied = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let port = occupied.local_addr().unwrap().port();
        assert!(
            Server::bind(Config {
                port,
                cwd: PathBuf::from("."),
                shell: "cmd.exe /d /q".into()
            })
            .is_err()
        );
        assert!(TcpStream::connect(("127.0.0.1", port)).is_ok());
    }
}
