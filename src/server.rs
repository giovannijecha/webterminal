//! Loopback-only HTTP/WebSocket service with bounded connections and messages.
mod api;
mod commands;
mod hooks;
mod http;
mod upload;
use crate::{
    json, native,
    session::{self, Launch, Registry, unix_ms},
    settings::Store,
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
const SLOW_INTERVAL: Duration = Duration::from_millis(250);

pub struct Config {
    pub port: u16,
    pub cwd: PathBuf,
    pub shell: String,
    /// The user's settings file; tests pass a disposable path.
    pub settings: PathBuf,
    /// Executable that program adapters run to reach this server; without it
    /// programs start without activity reporting.
    pub helper: Option<PathBuf>,
}
/// What every connection of one server shares.
pub(crate) struct Context {
    pub registry: Registry,
    pub settings: Store,
    pub port: u16,
    /// Unix milliseconds when the server started.
    pub started: u64,
    pub stop: Arc<AtomicBool>,
}
impl Context {
    /// The folder new terminals open in: the saved start folder while it
    /// exists, otherwise the server's `--cwd`.
    fn start_folder(&self) -> PathBuf {
        self.settings
            .start_folder()
            .unwrap_or_else(|| self.registry.cwd.clone())
    }
}
pub struct Server {
    listener: TcpListener,
    context: Arc<Context>,
    pub port: u16,
}
impl Server {
    pub fn bind(config: Config) -> io::Result<Self> {
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
        let owner = format!("{}-{port}", std::process::id());
        let mut registry =
            Registry::new(config.cwd, config.shell, Uploads::temporary(owner.clone()));
        if let Some(helper) = config.helper {
            registry = registry.with_launch(Launch {
                port,
                helper,
                directory: std::env::temp_dir().join("webterminal-bridge").join(owner),
            });
        }
        Ok(Self {
            listener,
            context: Arc::new(Context {
                registry,
                settings: Store::open(config.settings),
                port,
                started: unix_ms(),
                stop: Arc::new(AtomicBool::new(false)),
            }),
            port,
        })
    }
    pub fn shutdown_signal(&self) -> Arc<AtomicBool> {
        self.context.stop.clone()
    }
    pub fn run(self) -> io::Result<()> {
        let active = Arc::new(AtomicUsize::new(0));
        let stop = &self.context.stop;
        while !stop.load(Ordering::Relaxed) && !native::shutdown_requested() {
            match self.listener.accept() {
                Ok((stream, _)) => {
                    if active.fetch_add(1, Ordering::Relaxed) >= 64 {
                        active.fetch_sub(1, Ordering::Relaxed);
                        drop(stream);
                        continue;
                    }
                    let (context, count) = (self.context.clone(), active.clone());
                    thread::spawn(move || {
                        let _guard = ConnectionCount(count);
                        let _ = connection(stream, context);
                    });
                }
                Err(e) if e.kind() == io::ErrorKind::WouldBlock => {
                    thread::sleep(Duration::from_millis(10))
                }
                Err(e) => {
                    stop.store(true, Ordering::Relaxed);
                    self.context.registry.shutdown();
                    return Err(e);
                }
            }
        }
        stop.store(true, Ordering::Relaxed);
        self.context.registry.shutdown();
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
    context: Arc<Context>,
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
        self.context.registry.detach_view(&self.view);
    }
}

fn connection(mut stream: TcpStream, context: Arc<Context>) -> io::Result<()> {
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
    let host = format!("127.0.0.1:{}", context.port);
    let origin = format!("http://{host}");
    // Opening the public entry page from a bookmark or another application
    // is navigation, not terminal control. API calls and embedding stay fenced.
    let entry_navigation = matches!(&req.route, http::Route::Get)
        && matches!(req.path.as_str(), "/" | "/index.html")
        && req.headers.get("sec-fetch-mode").map(String::as_str) == Some("navigate")
        && req.headers.get("sec-fetch-dest").map(String::as_str) == Some("document");
    if req.headers.get("host") != Some(&host)
        || req.headers.get("origin").is_some_and(|v| v != &origin)
        || req
            .headers
            .get("sec-fetch-site")
            .is_some_and(|v| v == "cross-site" && !entry_navigation)
    {
        return http::response(
            &mut stream,
            "403 Forbidden",
            "text/plain; charset=utf-8",
            "Foreign Host or Origin rejected",
        );
    }
    match req.route {
        http::Route::Upload => upload::handle(&mut stream, &req, &context.registry, &origin),
        http::Route::Hook => hooks::handle(&mut stream, &req, &context.registry),
        http::Route::Get if req.path == "/ws" => {
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
            socket_loop(stream, context.clone(), &req.extra)
        }
        http::Route::Get => http::serve(&mut stream, &req.path, &context),
    }
}

/// What one socket has already sent of the server-wide state.
#[derive(Default)]
struct Published {
    list: String,
    settings: Option<u64>,
    agents: Option<u64>,
    replies: u64,
    files: Option<u64>,
    slow: Option<Instant>,
}
impl Published {
    fn send(&mut self, stream: &mut TcpStream, context: &Context) -> io::Result<()> {
        let registry = &context.registry;
        let list = registry.list_json();
        if list != self.list {
            websocket::send_text(stream, &list)?;
            self.list = list;
        }
        let agents = registry.bridge.revision();
        if self.agents != Some(agents) {
            websocket::send_text(stream, &registry.bridge.json())?;
            self.agents = Some(agents);
        }
        // Replies already present at connect are marked so views can list
        // them without notifying again.
        let replayed = self.slow.is_none();
        for reply in registry.bridge.replies_after(self.replies) {
            websocket::send_text(
                stream,
                &format!(
                    "{{\"type\":\"reply\",\"seq\":{},\"id\":{},\"program\":{},\"label\":{},\"text\":{},\"at\":{},\"replayed\":{replayed}}}",
                    reply.seq,
                    json::quote(&reply.session),
                    json::quote(reply.program.id()),
                    json::quote(reply.program.label()),
                    json::quote(&reply.text),
                    reply.at
                ),
            )?;
            self.replies = reply.seq;
        }
        if self.slow.is_some_and(|at| at.elapsed() < SLOW_INTERVAL) {
            return Ok(());
        }
        self.slow = Some(Instant::now());
        let settings = context.settings.revision();
        if self.settings != Some(settings) {
            websocket::send_text(stream, &context.settings.json())?;
            self.settings = Some(settings);
        }
        let files = registry.uploads.changes();
        if self.files != Some(files) {
            websocket::send_text(stream, &registry.uploads.copies_json())?;
            self.files = Some(files);
        }
        Ok(())
    }
}

fn socket_loop(mut stream: TcpStream, context: Arc<Context>, initial: &[u8]) -> io::Result<()> {
    stream.set_read_timeout(Some(Duration::from_millis(8)))?;
    let view = session::new_view();
    let _guard = ViewGuard {
        context: context.clone(),
        view: view.clone(),
    };
    let registry = &context.registry;
    websocket::send_text(
        &mut stream,
        &format!(
            "{{\"type\":\"hello\",\"view\":{},\"cwd\":{},\"serverCwd\":{},\"shell\":{},\"pid\":{},\"port\":{},\"started\":{},\"version\":{}}}",
            json::quote(&view),
            json::quote(&context.start_folder().to_string_lossy()),
            json::quote(&registry.cwd.to_string_lossy()),
            json::quote(&registry.shell),
            std::process::id(),
            context.port,
            context.started,
            json::quote(env!("CARGO_PKG_VERSION"))
        ),
    )?;
    let mut decoder = Decoder::default();
    decoder.push(initial)?;
    let mut attached: BTreeMap<String, Attachment> = BTreeMap::new();
    let mut published = Published::default();
    let mut last_frame = Instant::now();
    let mut last_ping = Instant::now();
    let mut last_publish = Instant::now() - PUBLISH_INTERVAL;
    let stop = &context.stop;
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
                Message::Text(text) => {
                    let reply = match json::parse(&text) {
                        Ok(command) => {
                            match commands::action(&command, &context, &view, &mut attached) {
                                Ok(reply) => reply,
                                Err(error) => Some(commands::error(&error, Some(&command))),
                            }
                        }
                        Err(error) => Some(commands::error(&error, None)),
                    };
                    if let Some(reply) = reply {
                        if reply == "{\"type\":\"server-stopping\"}" {
                            let sent = websocket::send_text(&mut stream, &reply);
                            let closed = if sent.is_ok() {
                                websocket::write_frame(&mut stream, 8, &1001u16.to_be_bytes())
                            } else {
                                Ok(())
                            };
                            // A broken client does not cancel the requested stop.
                            stop.store(true, Ordering::Relaxed);
                            sent?;
                            return closed;
                        }
                        websocket::send_text(&mut stream, &reply)?;
                    }
                }
            }
        }
        if last_publish.elapsed() >= PUBLISH_INTERVAL {
            published.send(&mut stream, &context)?;
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
    if stop.load(Ordering::Relaxed) {
        // An expected stop closes cleanly, so views can tell it from a drop.
        let _ = websocket::write_frame(&mut stream, 8, &1001u16.to_be_bytes());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn occupied_ports_never_replace_an_owner() {
        let occupied = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let port = occupied.local_addr().unwrap().port();
        assert!(
            Server::bind(Config {
                port,
                cwd: PathBuf::from("."),
                shell: "cmd.exe /d /q".into(),
                settings: std::env::temp_dir().join("webterminal-unused-settings.json"),
                helper: None,
            })
            .is_err()
        );
        assert!(TcpStream::connect(("127.0.0.1", port)).is_ok());
    }

    #[test]
    fn stop_command_does_not_signal_shutdown_before_its_reply() {
        let server = Server::bind(Config {
            port: 0,
            cwd: PathBuf::from("."),
            shell: "powershell.exe -NoLogo -NoProfile".into(),
            settings: std::env::temp_dir().join("webterminal-unused-stop-settings.json"),
            helper: None,
        })
        .unwrap();
        let command = json::parse(r#"{"op":"stop-server","confirmed":true}"#).unwrap();
        let response =
            commands::action(&command, &server.context, "v1", &mut BTreeMap::new()).unwrap();
        assert_eq!(response.as_deref(), Some(r#"{"type":"server-stopping"}"#));
        assert!(!server.context.stop.load(Ordering::Relaxed));
    }
}
