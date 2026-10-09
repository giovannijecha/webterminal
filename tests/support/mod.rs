use std::fs;
use std::io::{self, Read, Write};
use std::net::TcpStream;
use std::path::{Path, PathBuf};
use std::sync::{
    Arc,
    atomic::{AtomicBool, Ordering},
};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use webterminal::server::{Config, Server};

const TIMEOUT: Duration = Duration::from_secs(8);

pub fn fixture() -> &'static str {
    env!("CARGO_BIN_EXE_native_fixture")
}
pub fn shell(mode: &str, path: Option<&Path>) -> String {
    match path {
        Some(path) => format!("\"{}\" {mode} \"{}\"", fixture(), path.display()),
        None => format!("\"{}\" {mode}", fixture()),
    }
}
pub struct Harness {
    pub port: u16,
    pub cwd: PathBuf,
    stop: Arc<AtomicBool>,
    runner: Option<JoinHandle<io::Result<()>>>,
}
impl Harness {
    pub fn new(shell: String) -> Self {
        let stamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let cwd = std::env::temp_dir().join(format!(
            "webterminal-transport-{}-{stamp}",
            std::process::id()
        ));
        fs::create_dir(&cwd).unwrap();
        let server = Server::bind(Config {
            port: 0,
            cwd: cwd.clone(),
            shell,
        })
        .unwrap();
        let port = server.port;
        let stop = server.shutdown_signal();
        let runner = Some(thread::spawn(move || server.run()));
        Self {
            port,
            cwd,
            stop,
            runner,
        }
    }
    pub fn stop(&mut self) {
        self.stop.store(true, Ordering::SeqCst);
        if let Some(runner) = self.runner.take() {
            match runner.join() {
                Ok(Ok(())) => {}
                other if thread::panicking() => eprintln!("server cleanup failed: {other:?}"),
                other => panic!("server cleanup failed: {other:?}"),
            }
        }
    }
    pub fn request(&self, path: &str, headers: &str) -> String {
        self.raw_http(&format!(
            "GET {path} HTTP/1.1\r\nHost: 127.0.0.1:{}\r\n{headers}\r\n",
            self.port
        ))
    }
    pub fn raw_http(&self, request: &str) -> String {
        let mut stream = TcpStream::connect(("127.0.0.1", self.port)).unwrap();
        stream.set_read_timeout(Some(TIMEOUT)).unwrap();
        stream.write_all(request.as_bytes()).unwrap();
        let mut response = String::new();
        stream.read_to_string(&mut response).unwrap();
        response
    }
    pub fn socket(&self) -> Socket {
        Socket::connect(self.port)
    }
}
impl Drop for Harness {
    fn drop(&mut self) {
        self.stop();
        let temp = std::env::temp_dir().canonicalize().unwrap();
        let resolved = self.cwd.canonicalize().unwrap();
        assert!(resolved.starts_with(&temp));
        assert!(
            self.cwd
                .file_name()
                .unwrap()
                .to_string_lossy()
                .starts_with("webterminal-transport-")
        );
        // Windows can retain a fixture's working-directory handle briefly
        // after its job is terminated. Keep cleanup bounded and report any
        // persistent error without causing a second panic during unwinding.
        let until = Instant::now() + TIMEOUT;
        loop {
            match fs::remove_dir_all(&resolved) {
                Ok(()) => break,
                Err(_) if Instant::now() < until => thread::sleep(Duration::from_millis(20)),
                Err(error) if thread::panicking() => {
                    eprintln!("test directory cleanup failed: {error}");
                    break;
                }
                Err(error) => panic!("test directory cleanup failed: {error}"),
            }
        }
    }
}

pub struct Socket {
    stream: TcpStream,
    pending: Vec<u8>,
    mask: u32,
    last_sent: String,
    last_received: String,
}
impl Socket {
    fn connect(port: u16) -> Self {
        let mut stream = TcpStream::connect(("127.0.0.1", port)).unwrap();
        stream
            .set_read_timeout(Some(Duration::from_millis(200)))
            .unwrap();
        stream.set_write_timeout(Some(TIMEOUT)).unwrap();
        write!(stream, "GET /ws HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nOrigin: http://127.0.0.1:{port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n").unwrap();
        let mut pending = Vec::new();
        let until = Instant::now() + TIMEOUT;
        while !pending.windows(4).any(|part| part == b"\r\n\r\n") {
            assert!(Instant::now() < until, "WebSocket handshake timeout");
            let mut buf = [0; 4096];
            match stream.read(&mut buf) {
                Ok(0) => panic!("WebSocket handshake closed"),
                Ok(n) => pending.extend_from_slice(&buf[..n]),
                Err(e)
                    if e.kind() == io::ErrorKind::WouldBlock
                        || e.kind() == io::ErrorKind::TimedOut => {}
                Err(e) => panic!("WebSocket handshake failed: {e}"),
            }
        }
        let end = pending
            .windows(4)
            .position(|part| part == b"\r\n\r\n")
            .unwrap()
            + 4;
        let head = String::from_utf8(pending.drain(..end).collect()).unwrap();
        assert!(head.starts_with("HTTP/1.1 101"), "{head}");
        assert!(
            head.contains("Sec-WebSocket-Accept: s3pPLMBiTxaQ9kYGzzhZRbK+xOo="),
            "{head}"
        );
        let mut socket = Self {
            stream,
            pending,
            mask: 0,
            last_sent: "handshake".into(),
            last_received: String::new(),
        };
        socket.recv_type("hello");
        socket
    }
    pub fn send(&mut self, json: &str) {
        self.last_sent = json.chars().take(180).collect();
        let data = json.as_bytes();
        let mut frame = vec![0x81];
        match data.len() {
            0..=125 => frame.push(0x80 | data.len() as u8),
            126..=65535 => {
                frame.push(0xfe);
                frame.extend_from_slice(&(data.len() as u16).to_be_bytes());
            }
            _ => {
                frame.push(0xff);
                frame.extend_from_slice(&(data.len() as u64).to_be_bytes());
            }
        }
        self.mask = self.mask.wrapping_add(0x9e37_79b9);
        let mask = self.mask.to_be_bytes();
        frame.extend_from_slice(&mask);
        frame.extend(data.iter().enumerate().map(|(i, b)| b ^ mask[i % 4]));
        self.stream.write_all(&frame).unwrap_or_else(|e| {
            panic!(
                "WebSocket send failed: {e}; last command: {}",
                self.last_sent
            )
        });
    }
    pub fn recv_type(&mut self, kind: &str) -> String {
        self.recv_matching(|text| text.starts_with(&format!("{{\"type\":\"{kind}\"")))
    }
    pub fn recv_matching(&mut self, predicate: impl Fn(&str) -> bool) -> String {
        let until = Instant::now() + TIMEOUT;
        loop {
            let text = self.read_text(until);
            self.last_received = text.chars().take(180).collect();
            if predicate(&text) {
                return text;
            }
        }
    }
    fn read_text(&mut self, until: Instant) -> String {
        loop {
            let head = self.take(2, until);
            let opcode = head[0] & 15;
            assert_eq!(head[0] & 0x80, 0x80, "fragmented server frame");
            assert_eq!(head[1] & 0x80, 0, "server frame must not be masked");
            let size = match head[1] & 127 {
                126 => u16::from_be_bytes(self.take(2, until).try_into().unwrap()) as usize,
                127 => u64::from_be_bytes(self.take(8, until).try_into().unwrap()) as usize,
                n => n as usize,
            };
            assert!(size < 32 * 1024 * 1024, "unbounded server frame");
            let payload = self.take(size, until);
            match opcode {
                1 => return String::from_utf8(payload).unwrap(),
                9 => continue,
                _ => panic!("unexpected server frame opcode: {opcode}"),
            }
        }
    }
    fn take(&mut self, count: usize, until: Instant) -> Vec<u8> {
        while self.pending.len() < count {
            assert!(
                Instant::now() < until,
                "WebSocket frame timeout; sent: {}; received: {}",
                self.last_sent,
                self.last_received
            );
            let mut buf = [0; 16_384];
            match self.stream.read(&mut buf) {
                Ok(0) => panic!(
                    "WebSocket connection closed; sent: {}; received: {}",
                    self.last_sent, self.last_received
                ),
                Ok(n) => self.pending.extend_from_slice(&buf[..n]),
                Err(e)
                    if e.kind() == io::ErrorKind::WouldBlock
                        || e.kind() == io::ErrorKind::TimedOut => {}
                Err(e) => panic!(
                    "WebSocket read failed: {e}; sent: {}; received: {}",
                    self.last_sent, self.last_received
                ),
            }
        }
        self.pending.drain(..count).collect()
    }
}
