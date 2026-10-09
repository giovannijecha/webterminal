//! Manual acceptance probe. It uses disposable profiles and never submits a model prompt.
use std::{
    env, fs,
    io::{Read, Write},
    path::PathBuf,
    sync::{Arc, Mutex, mpsc},
    thread,
    time::{Duration, Instant},
};
use webterminal::{
    json::{self, Value},
    native,
    terminal::Terminal,
};

fn main() {
    if let Err(e) = run() {
        eprintln!("CLI probe: {e}");
        std::process::exit(1);
    }
}
fn run() -> Result<(), String> {
    let mut args = env::args_os().skip(1);
    let profile = PathBuf::from(
        args.next()
            .ok_or("Usage: cli_probe PROFILE EXECUTABLE [ARGS]")?,
    );
    let exe = args.next().ok_or("Executable required")?;
    fs::create_dir_all(&profile).map_err(|e| e.to_string())?;
    let profile = profile.canonicalize().map_err(|e| e.to_string())?;
    let wrapper = env::current_exe()
        .map_err(|e| e.to_string())?
        .with_file_name("isolated_cli.exe");
    let mut command = format!(
        "{} {} {}",
        quote(&wrapper.to_string_lossy()),
        quote(&profile.to_string_lossy()),
        quote(&exe.to_string_lossy())
    );
    for arg in args {
        command.push(' ');
        command.push_str(&quote(&arg.to_string_lossy()));
    }
    let spawned = native::spawn(&command, &profile, 80, 24).map_err(|e| e.to_string())?;
    let pty = spawned.pty;
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
    let (out_terminal, out_sender) = (terminal.clone(), sender.clone());
    let mut output = spawned.output;
    let reader = thread::spawn(move || {
        let mut bytes = [0; 8192];
        let mut count = 0;
        while let Ok(n) = output.read(&mut bytes) {
            if n == 0 {
                break;
            }
            count += n;
            let response = out_terminal.lock().unwrap().feed(&bytes[..n]);
            if !response.is_empty() {
                let _ = out_sender.try_send(response);
            }
        }
        count
    });
    thread::sleep(Duration::from_secs(3));
    let mut initial = terminal.lock().unwrap().snapshot_json();
    let mut state = json::parse(&initial)?;
    let ready_deadline = Instant::now() + Duration::from_secs(10);
    while screen_text(&state).contains("Checking connectivity") && Instant::now() < ready_deadline {
        thread::sleep(Duration::from_millis(100));
        initial = terminal.lock().unwrap().snapshot_json();
        state = json::parse(&initial)?;
    }
    let win32 = state.get("modes").and_then(|m| m.get("win32")) == Some(&Value::Bool(true));
    println!("INITIAL_SCREEN:\n{}", screen_text(&state));
    println!("WIN32_INPUT_MODE:{win32}");
    let setup = screen_text(&state).contains("Jecode setup");
    if setup {
        // Do not insert navigation sequences into a hidden credential field.
        println!("MENU_CHECK:SKIPPED_SETUP_INPUT");
    } else {
        let arrows = if win32 {
            b"\x1b[40;80;0;1;256;1_\x1b[40;80;0;0;256;1_".as_slice()
        } else {
            b"\x1b[B".as_slice()
        };
        let _ = sender.try_send(arrows.to_vec());
        thread::sleep(Duration::from_millis(400));
        let after = terminal.lock().unwrap().snapshot_json();
        println!("MENU_FRAME_CHANGED:{}", initial != after);
    }
    let interrupt = if setup {
        b"/cancel\r".as_slice()
    } else if win32 {
        b"\x1b[67;46;3;1;8;1_\x1b[67;46;3;0;8;1_".as_slice()
    } else {
        b"\x03".as_slice()
    };
    let _ = sender.try_send(interrupt.to_vec());
    if screen_text(&state).contains("Welcome to Claude Code") {
        for _ in 0..2 {
            thread::sleep(Duration::from_millis(500));
            let _ = sender.try_send(interrupt.to_vec());
        }
        println!("INTERRUPTS_SENT:3");
    }
    let deadline = Instant::now() + Duration::from_secs(3);
    let mut code = None;
    while Instant::now() < deadline {
        code = pty.exit_code().map_err(|e| e.to_string())?;
        if code.is_some() {
            break;
        }
        thread::sleep(Duration::from_millis(25));
    }
    println!("NORMAL_EXIT:{code:?}");
    if code.is_none() {
        let final_state = json::parse(&terminal.lock().unwrap().snapshot_json())?;
        println!("FINAL_SCREEN:\n{}", screen_text(&final_state));
    }
    pty.terminate().map_err(|e| e.to_string())?;
    drop(sender);
    println!(
        "DRAINED_BYTES:{}",
        reader.join().map_err(|_| "Output reader failed")?
    );
    println!("MODEL_PROMPTS_SUBMITTED:0");
    Ok(())
}
fn quote(text: &str) -> String {
    let mut out = String::from("\"");
    let mut slashes = 0;
    for ch in text.chars() {
        if ch == '\\' {
            slashes += 1;
            continue;
        }
        if ch == '"' {
            out.push_str(&"\\".repeat(slashes * 2 + 1));
        } else {
            out.push_str(&"\\".repeat(slashes));
        }
        slashes = 0;
        out.push(ch);
    }
    out.push_str(&"\\".repeat(slashes * 2));
    out.push('"');
    out
}
fn screen_text(state: &Value) -> String {
    let mut out = String::new();
    if let Some(Value::Array(lines)) = state.get("screen") {
        for line in lines {
            let mut row = String::new();
            if let Some(Value::Array(cells)) = line.get("cells") {
                for cell in cells {
                    if let Value::Array(parts) = cell
                        && parts.get(1).and_then(Value::number) != Some(0)
                        && let Some(text) = parts.first().and_then(Value::string)
                    {
                        row.push_str(text);
                    }
                }
            }
            if !row.trim_end().is_empty() {
                out.push_str(row.trim_end());
                out.push('\n');
            }
        }
    }
    out
}
