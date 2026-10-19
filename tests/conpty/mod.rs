//! ConPTY helpers shared by the native test targets.
use crate::native;
use std::fs;
use std::io::{BufRead, BufReader, Read};
use std::path::{Path, PathBuf};
use std::sync::mpsc;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

pub fn fixture() -> &'static str {
    env!("CARGO_BIN_EXE_native_fixture")
}
pub fn command(mode: &str, extra: Option<&Path>) -> String {
    match extra {
        Some(path) => format!("\"{}\" {mode} \"{}\"", fixture(), path.display()),
        None => format!("\"{}\" {mode}", fixture()),
    }
}
pub fn scratch() -> PathBuf {
    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let dir =
        std::env::temp_dir().join(format!("webterminal-native-{}-{stamp}", std::process::id()));
    fs::create_dir(&dir).unwrap();
    dir
}
pub fn await_exit(pty: &native::Pty) -> u32 {
    let until = Instant::now() + Duration::from_secs(10);
    loop {
        if let Some(code) = pty.exit_code().unwrap() {
            return code;
        }
        assert!(Instant::now() < until, "fixture did not exit");
        std::thread::sleep(Duration::from_millis(10));
    }
}
pub fn collect(mut output: fs::File) -> mpsc::Receiver<Vec<u8>> {
    let (tx, rx) = mpsc::channel();
    std::thread::spawn(move || {
        let mut bytes = Vec::new();
        output.read_to_end(&mut bytes).unwrap();
        let _ = tx.send(bytes);
    });
    rx
}
pub fn collect_until(
    mut output: fs::File,
    marker: &'static [u8],
) -> (mpsc::Receiver<()>, mpsc::Receiver<Vec<u8>>) {
    assert!(!marker.is_empty());
    let (ready_tx, ready_rx) = mpsc::channel();
    let (output_tx, output_rx) = mpsc::channel();
    std::thread::spawn(move || {
        let mut bytes = Vec::new();
        let mut ready = Some(ready_tx);
        let mut chunk = [0; 4096];
        loop {
            let read = output.read(&mut chunk).unwrap();
            if read == 0 {
                break;
            }
            let previous = bytes.len();
            bytes.extend_from_slice(&chunk[..read]);
            if ready.is_some()
                && bytes[previous.saturating_sub(marker.len() - 1)..]
                    .windows(marker.len())
                    .any(|window| window == marker)
            {
                let _ = ready.take().unwrap().send(());
            }
        }
        let _ = output_tx.send(bytes);
    });
    (ready_rx, output_rx)
}
pub fn collect_lines(output: fs::File) -> mpsc::Receiver<String> {
    let (tx, rx) = mpsc::channel();
    std::thread::spawn(move || {
        for line in BufReader::new(output).lines() {
            if tx.send(line.unwrap()).is_err() {
                break;
            }
        }
    });
    rx
}
