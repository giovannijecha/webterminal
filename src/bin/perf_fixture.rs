//! Bounded, original latency fixture; no user files, credentials or services.
use std::io::{self, BufRead, Write};

fn main() {
    print!("\x1b[3J\x1b[2J\x1b[HPERF_READY\r\n");
    io::stdout().flush().unwrap();
    for line in io::stdin().lock().lines() {
        let line = line.unwrap();
        if line == "history" {
            print!("\x1b[?1049l\x1b[3J\x1b[2J\x1b[H");
            for row in 0..600 {
                println!(
                    "{row:04} \x1b[36m{}\x1b[0m",
                    "Owned performance fixture output. ".repeat(2)
                );
            }
            print!("HISTORY_READY\x1b[2;1H");
        } else if line == "tui" {
            print!("\x1b[?1049h\x1b[2J\x1b[H");
            for row in 0..24 {
                print!(
                    "\x1b[{};1HTUI row {row:02}: {}",
                    row + 1,
                    "Fixed local application content. ".repeat(2)
                );
            }
            print!("\x1b[26;1HTUI_READY\x1b[2;1H");
        } else if let Some(sequence) = line.strip_prefix("probe:") {
            print!("\x1b[2;1H\x1b[2KACK:{sequence}\x1b[4;1H");
        } else if line == "stream" {
            print!("\x1b[?1049h\x1b[2J\x1b[HSTREAM_READY\x1b[4;1H");
            std::thread::spawn(|| {
                for tick in 0..3000 {
                    let mut block = String::new();
                    for row in 6..30 {
                        block.push_str(&format!(
                            "\x1b[{row};1H\x1b[36mTick {tick:04} row {row:02}: {}\x1b[0m",
                            "Owned output. ".repeat(4)
                        ));
                    }
                    block.push_str("\x1b[4;1H");
                    let mut output = io::stdout().lock();
                    if output.write_all(block.as_bytes()).is_err() || output.flush().is_err() {
                        break;
                    }
                    drop(output);
                    std::thread::sleep(std::time::Duration::from_millis(16));
                }
            });
        } else if line == "quit" {
            break;
        }
        io::stdout().flush().unwrap();
    }
}
