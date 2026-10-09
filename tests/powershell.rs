#![cfg(windows)]
#[allow(dead_code)]
mod support;

use std::cell::RefCell;
use std::fs;
use std::panic::{AssertUnwindSafe, catch_unwind, resume_unwind};
use std::time::Duration;
use support::{Harness, Socket, TIMEOUT};
use webterminal::json::{self, Value};

fn screen_lines(snapshot: &Value) -> Vec<String> {
    let Value::Array(lines) = snapshot
        .get("terminal")
        .and_then(|terminal| terminal.get("screen"))
        .unwrap()
    else {
        panic!("Expected terminal screen");
    };
    lines
        .iter()
        .map(|line| {
            let Value::Array(cells) = line.get("cells").unwrap() else {
                panic!("Expected terminal cells");
            };
            cells
                .iter()
                .filter_map(|cell| {
                    let Value::Array(parts) = cell else {
                        panic!("Expected terminal cell");
                    };
                    parts.first().and_then(Value::string)
                })
                .collect()
        })
        .collect()
}

fn wait_screen(
    socket: &mut Socket,
    id: &str,
    stage: &str,
    predicate: impl Fn(&[String]) -> bool,
) -> Value {
    wait_screen_with_timeout(socket, id, stage, TIMEOUT, predicate)
}

fn wait_screen_with_timeout(
    socket: &mut Socket,
    id: &str,
    stage: &str,
    timeout: Duration,
    predicate: impl Fn(&[String]) -> bool,
) -> Value {
    let last_snapshot = RefCell::new(String::from("no matching snapshot received"));
    let last_error = RefCell::new(None);
    let result = catch_unwind(AssertUnwindSafe(|| {
        socket.recv_matching_with_timeout(timeout, |text| {
            let Ok(snapshot) = json::parse(text) else {
                return false;
            };
            if snapshot.field("type") == Ok("error") {
                *last_error.borrow_mut() = Some(text.chars().take(512).collect::<String>());
            }
            if snapshot.field("type") != Ok("snapshot") || snapshot.field("id") != Ok(id) {
                return false;
            }
            let lines = screen_lines(&snapshot);
            let visible: Vec<_> = lines
                .iter()
                .map(|line| line.trim_end())
                .filter(|line| !line.is_empty())
                .collect();
            let screen: String = format!("{visible:?}").chars().take(4096).collect();
            *last_snapshot.borrow_mut() = format!(
                "PowerShell {stage}: seq={:?} epoch={:?} alive={:?} title={:?} cursor={:?} win32={:?} screen={screen}",
                snapshot.get("seq"),
                snapshot.get("epoch"),
                snapshot.get("alive"),
                snapshot.get("terminal").and_then(|terminal| terminal.get("title")),
                snapshot.get("terminal").and_then(|terminal| terminal.get("cursor")),
                snapshot
                    .get("terminal")
                    .and_then(|terminal| terminal.get("modes"))
                    .and_then(|modes| modes.get("win32")),
            );
            predicate(&lines)
        })
    }));
    match result {
        Ok(text) => json::parse(&text).unwrap(),
        Err(cause) => {
            eprintln!(
                "{}; last server error: {:?}",
                last_snapshot.borrow(),
                last_error.borrow()
            );
            resume_unwind(cause);
        }
    }
}

fn create(socket: &mut Socket, app: &Harness) -> String {
    socket.send(&format!(
        "{{\"op\":\"create\",\"cwd\":{},\"cols\":120,\"rows\":30}}",
        json::quote(&app.cwd.to_string_lossy())
    ));
    json::parse(&socket.recv_type("created"))
        .unwrap()
        .field("id")
        .unwrap()
        .into()
}

fn win32_keys(command: &str) -> Vec<String> {
    let mut result = Vec::new();
    for c in command.chars().chain(std::iter::once('\r')) {
        let (vk, scan, unicode) = match c {
            'a' => (65, 30, 97),
            'c' => (67, 46, 99),
            'd' => (68, 32, 100),
            'e' => (69, 18, 101),
            'l' => (76, 38, 108),
            'p' => (80, 25, 112),
            'r' => (82, 19, 114),
            's' => (83, 31, 115),
            'w' => (87, 17, 119),
            '\r' => (13, 28, 13),
            _ => panic!("Unexpected test command character: {c}"),
        };
        // Browser input sends a Win32 key down and up for negotiated input mode.
        result.push(format!("\x1b[{vk};{scan};{unicode};1;0;1_"));
        result.push(format!("\x1b[{vk};{scan};{unicode};0;0;1_"));
    }
    result
}

fn command(socket: &mut Socket, id: &str, epoch: i64, seq: &mut i64, mode: &Value, text: &str) {
    let win32 = mode
        .get("terminal")
        .and_then(|terminal| terminal.get("modes"))
        .and_then(|modes| modes.get("win32"))
        == Some(&Value::Bool(true));
    let inputs = if win32 {
        win32_keys(text)
    } else {
        vec![format!("{text}\r")]
    };
    for data in inputs {
        *seq += 1;
        socket.send(&format!(
            "{{\"op\":\"input\",\"id\":{},\"epoch\":{epoch},\"seq\":{seq},\"data\":{}}}",
            json::quote(id),
            json::quote(&data)
        ));
    }
}

#[test]
fn windows_powershell_accepts_ls_clear_and_pwd_in_selected_directory() {
    let wrapper = env!("CARGO_BIN_EXE_isolated_cli");
    let powershell = std::path::PathBuf::from(std::env::var_os("SystemRoot").unwrap())
        .join("System32/WindowsPowerShell/v1.0/powershell.exe");
    let bootstrap =
        "if (Get-Module PSReadLine) { Set-PSReadLineOption -HistorySaveStyle SaveNothing }";
    let app = Harness::new(format!(
        "\"{wrapper}\" \"isolated-profile\" \"{}\" -NoLogo -NoProfile -NoExit -Command \"{bootstrap}\"",
        powershell.display()
    ));
    let marker = "webterminal-powershell-listing.txt";
    fs::write(app.cwd.join(marker), "owned test content").unwrap();
    let mut socket = app.socket();
    let id = create(&mut socket, &app);
    let ready = wait_screen(&mut socket, &id, "ready", |lines| {
        lines
            .iter()
            .any(|line| line.contains("PS ") && line.contains('>'))
    });
    let epoch = ready.integer("epoch").unwrap();
    let mut seq = 0;

    command(&mut socket, &id, epoch, &mut seq, &ready, "ls");
    // The first native ls took 27.5 seconds on the Windows 2025 runner with
    // PSReadLine loaded; keep its allowance local to this acceptance step.
    let listed =
        wait_screen_with_timeout(&mut socket, &id, "ls", Duration::from_secs(45), |lines| {
            lines.iter().any(|line| line.contains(marker))
        });

    command(&mut socket, &id, epoch, &mut seq, &listed, "clear");
    let cleared = wait_screen(&mut socket, &id, "clear", |lines| {
        !lines.iter().any(|line| line.contains(marker))
    });
    assert!(!screen_lines(&cleared).join("\n").contains(marker));

    command(&mut socket, &id, epoch, &mut seq, &cleared, "pwd");
    let cwd = app.cwd.canonicalize().unwrap();
    let location = wait_screen(&mut socket, &id, "pwd", |lines| {
        lines.iter().any(|line| line.trim() == "Path")
            && lines.iter().any(|line| {
                let path = std::path::Path::new(line.trim());
                path.is_absolute() && path.canonicalize().is_ok_and(|resolved| resolved == cwd)
            })
    });
    assert!(!screen_lines(&location).join("\n").contains(marker));
}
