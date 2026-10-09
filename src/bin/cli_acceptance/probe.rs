//! Bounded ConPTY driver for disposable CLI acceptance runs.
use std::{
    io::{Read, Write},
    path::Path,
    sync::{Arc, Mutex, mpsc},
    thread,
    time::{Duration, Instant},
};
use webterminal::{
    json::{self, Value},
    native,
    terminal::Terminal,
};

pub(super) struct Probe {
    pty: Arc<native::Pty>,
    terminal: Arc<Mutex<Terminal>>,
    sender: mpsc::SyncSender<Vec<u8>>,
    reader: Option<thread::JoinHandle<usize>>,
}
impl Probe {
    pub(super) fn new(command: &str, cwd: &Path) -> Result<Self, String> {
        let spawned = native::spawn(command, cwd, 80, 24).map_err(|e| e.to_string())?;
        let terminal = Arc::new(Mutex::new(Terminal::new(80, 24)));
        let (sender, receiver) = mpsc::sync_channel::<Vec<u8>>(32);
        let mut input = spawned.input;
        thread::spawn(move || {
            while let Ok(data) = receiver.recv() {
                if input.write_all(&data).is_err() {
                    break;
                }
            }
        });
        let (state, queries) = (terminal.clone(), sender.clone());
        let mut output = spawned.output;
        let reader = thread::spawn(move || {
            let mut bytes = [0; 16384];
            let mut count = 0;
            while let Ok(n) = output.read(&mut bytes) {
                if n == 0 {
                    break;
                }
                count += n;
                let response = state.lock().unwrap().feed(&bytes[..n]);
                if !response.is_empty() {
                    let _ = queries.try_send(response);
                }
            }
            count
        });
        Ok(Self {
            pty: spawned.pty,
            terminal,
            sender,
            reader: Some(reader),
        })
    }
    fn state(&self) -> Result<Value, String> {
        json::parse(&self.terminal.lock().unwrap().snapshot_json())
    }
    pub(super) fn screen(&self) -> Result<String, String> {
        let mut text = String::new();
        if let Some(Value::Array(lines)) = self.state()?.get("screen") {
            for line in lines {
                if let Some(Value::Array(cells)) = line.get("cells") {
                    for cell in cells {
                        if let Value::Array(parts) = cell
                            && parts.get(1).and_then(Value::number) != Some(0)
                            && let Some(s) = parts.first().and_then(Value::string)
                        {
                            text.push_str(s);
                        }
                    }
                }
                text.push('\n');
            }
        }
        Ok(text)
    }
    pub(super) fn win32(&self) -> Result<bool, String> {
        Ok(self.state()?.get("modes").and_then(|m| m.get("win32")) == Some(&Value::Bool(true)))
    }
    pub(super) fn still_running(&self) -> Result<bool, String> {
        Ok(self.pty.exit_code().map_err(|e| e.to_string())?.is_none())
    }
    pub(super) fn text(&self, text: &str) -> Result<(), String> {
        self.sender
            .try_send(text.as_bytes().to_vec())
            .map_err(|e| e.to_string())
    }
    pub(super) fn key(&self, vk: u16, scan: u16, ch: u16, mods: u16) -> Result<(), String> {
        if self.win32()? {
            self.text(&format!(
                "\x1b[{vk};{scan};{ch};1;{mods};1_\x1b[{vk};{scan};{ch};0;{mods};1_"
            ))
        } else {
            Err("Actual CLI did not negotiate required Win32 input".into())
        }
    }
    pub(super) fn resize(&self, cols: u16, rows: u16) -> Result<(), String> {
        self.terminal
            .lock()
            .unwrap()
            .resize(cols as usize, rows as usize);
        self.pty.resize(cols, rows).map_err(|e| e.to_string())?;
        thread::sleep(Duration::from_millis(300));
        println!("RESIZED:{cols}x{rows}");
        Ok(())
    }
    pub(super) fn wait(&self, marker: &str, timeout: Duration) -> Result<(), String> {
        let end = Instant::now() + timeout;
        loop {
            let screen = self.screen()?;
            if screen.contains(marker) {
                return Ok(());
            }
            if screen.to_lowercase().contains("terms of service") {
                return Err("Terms acceptance required; stopped".into());
            }
            if Instant::now() >= end {
                return Err(format!("Missing {marker:?}; screen:\n{screen}"));
            }
            thread::sleep(Duration::from_millis(20));
        }
    }
    pub(super) fn wait_count(
        &self,
        marker: &str,
        count: usize,
        timeout: Duration,
    ) -> Result<(), String> {
        let end = Instant::now() + timeout;
        loop {
            let screen = self.screen()?;
            if screen.matches(marker).count() >= count {
                return Ok(());
            }
            if Instant::now() >= end {
                return Err(format!(
                    "Missing {count} copies of {marker:?}; screen:\n{screen}"
                ));
            }
            thread::sleep(Duration::from_millis(20));
        }
    }
    pub(super) fn wait_exit(&self, timeout: Duration) -> Result<(), String> {
        let end = Instant::now() + timeout;
        while Instant::now() < end {
            if let Some(code) = self.pty.exit_code().map_err(|e| e.to_string())? {
                println!("EXIT:{code}");
                return Ok(());
            }
            thread::sleep(Duration::from_millis(20));
        }
        Err(format!("CLI did not exit; screen:\n{}", self.screen()?))
    }
}
impl Drop for Probe {
    fn drop(&mut self) {
        let _ = self.pty.terminate();
        if let Some(reader) = self.reader.take() {
            let _ = reader.join();
        }
    }
}
