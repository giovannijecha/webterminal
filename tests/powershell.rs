#![cfg(windows)]
#[allow(dead_code)]
mod support;

use std::fs;
use support::{Harness, Socket};
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

fn wait_screen(socket: &mut Socket, id: &str, predicate: impl Fn(&[String]) -> bool) -> Value {
    json::parse(&socket.recv_matching(|text| {
        let Ok(snapshot) = json::parse(text) else {
            return false;
        };
        snapshot.field("type") == Ok("snapshot")
            && snapshot.field("id") == Ok(id)
            && predicate(&screen_lines(&snapshot))
    }))
    .unwrap()
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

fn win32_keys(command: &str) -> String {
    let mut result = String::new();
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
        result.push_str(&format!("\x1b[{vk};{scan};{unicode};1;0;1_"));
        result.push_str(&format!("\x1b[{vk};{scan};{unicode};0;0;1_"));
    }
    result
}

fn command(socket: &mut Socket, id: &str, epoch: i64, seq: i64, mode: &Value, text: &str) {
    let win32 = mode
        .get("terminal")
        .and_then(|terminal| terminal.get("modes"))
        .and_then(|modes| modes.get("win32"))
        == Some(&Value::Bool(true));
    let data = if win32 {
        win32_keys(text)
    } else {
        format!("{text}\r")
    };
    socket.send(&format!(
        "{{\"op\":\"input\",\"id\":{},\"epoch\":{epoch},\"seq\":{seq},\"data\":{}}}",
        json::quote(id),
        json::quote(&data)
    ));
}

#[test]
fn windows_powershell_accepts_ls_clear_and_pwd_in_selected_directory() {
    let wrapper = env!("CARGO_BIN_EXE_isolated_cli");
    let powershell = std::path::PathBuf::from(std::env::var_os("SystemRoot").unwrap())
        .join("System32/WindowsPowerShell/v1.0/powershell.exe");
    let app = Harness::new(format!(
        "\"{wrapper}\" \"isolated-profile\" \"{}\" -NoLogo -NoProfile -NoExit -Command \"if (Get-Module PSReadLine) {{ Set-PSReadLineOption -HistorySaveStyle SaveNothing }}\"",
        powershell.display()
    ));
    let marker = "webterminal-powershell-listing.txt";
    fs::write(app.cwd.join(marker), "owned test content").unwrap();
    let mut socket = app.socket();
    let id = create(&mut socket, &app);
    let ready = wait_screen(&mut socket, &id, |lines| {
        lines
            .iter()
            .any(|line| line.contains("PS ") && line.contains('>'))
    });
    let epoch = ready.integer("epoch").unwrap();

    command(&mut socket, &id, epoch, 1, &ready, "ls");
    let listed = wait_screen(&mut socket, &id, |lines| {
        lines.iter().any(|line| line.contains(marker))
    });

    command(&mut socket, &id, epoch, 2, &listed, "clear");
    let cleared = wait_screen(&mut socket, &id, |lines| {
        !lines.iter().any(|line| line.contains(marker))
    });
    assert!(!screen_lines(&cleared).join("\n").contains(marker));

    command(&mut socket, &id, epoch, 3, &cleared, "pwd");
    let cwd = app.cwd.to_string_lossy();
    let location = wait_screen(&mut socket, &id, |lines| {
        lines.iter().any(|line| line.trim() == "Path")
            && lines.iter().any(|line| line.trim() == cwd)
    });
    assert!(!screen_lines(&location).join("\n").contains(marker));
}
