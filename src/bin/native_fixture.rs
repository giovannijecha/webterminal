//! Owned ConPTY test child. It never reads credentials or contacts a service.
use std::fs::OpenOptions;
use std::io::{self, BufRead, Write};
use std::os::windows::fs::OpenOptionsExt;
use std::process::{Command, ExitCode};
use std::time::Duration;

#[path = "../native/input_records.rs"]
mod input_records;
#[allow(dead_code)]
#[path = "../native.rs"]
mod native;

fn main() -> ExitCode {
    match std::env::args().nth(1).as_deref() {
        Some("--emit") => {
            print!("READY café 👩‍💻\r\n\x1b[31mRED\x1b[0m\r\n");
            io::stdout().flush().expect("flush fixture output");
            ExitCode::SUCCESS
        }
        Some("--echo") => {
            println!("READY");
            io::stdout().flush().expect("flush fixture prompt");
            let mut line = String::new();
            io::stdin()
                .lock()
                .read_line(&mut line)
                .expect("read fixture input");
            println!("ECHO:{}", line.trim_end_matches(['\r', '\n']));
            ExitCode::SUCCESS
        }
        Some("--records") => {
            print!("\x1b[?9001h");
            io::stdout().flush().expect("request Win32 input mode");
            input_records::verify_two_keys().expect("inspect console input records");
            ExitCode::SUCCESS
        }
        Some("--mouse-vt") => {
            input_records::inspect_mouse_vt().expect("inspect VT mouse bytes");
            ExitCode::SUCCESS
        }
        Some("--mouse-records") => {
            input_records::inspect_mouse_records().expect("inspect Win32 mouse records");
            ExitCode::SUCCESS
        }
        Some("--verify-isolation") => {
            if verify_isolation() {
                println!("ISOLATION_OK");
                ExitCode::SUCCESS
            } else {
                eprintln!("ISOLATION_FAILED");
                ExitCode::FAILURE
            }
        }
        Some("--flood") => {
            let block = vec![b'X'; 8192];
            let mut out = io::stdout().lock();
            for _ in 0..128 {
                out.write_all(&block).expect("write fixture output");
            }
            out.write_all(b"\r\nFLOOD_END\r\n")
                .expect("write end marker");
            ExitCode::SUCCESS
        }
        Some("--hold") => loop {
            std::thread::sleep(Duration::from_secs(1));
        },
        Some("--hold-lock") => {
            let path = std::env::args_os().nth(2).expect("lock path");
            let _lock = OpenOptions::new()
                .write(true)
                .create(true)
                .truncate(true)
                .share_mode(0)
                .open(path)
                .expect("exclusive marker");
            loop {
                std::thread::sleep(Duration::from_secs(1));
            }
        }
        Some("--tree") => {
            let path = std::env::args_os().nth(2).expect("lock path");
            let mut child = Command::new(std::env::current_exe().expect("fixture executable"))
                .arg("--hold-lock")
                .arg(path)
                .spawn()
                .expect("spawn owned fixture child");
            println!("CHILD:{}", child.id());
            io::stdout().flush().expect("flush child PID");
            child.wait().expect("wait for owned fixture child");
            ExitCode::FAILURE
        }
        Some("--host-loss") => {
            let path = std::env::args_os().nth(2).expect("lock path");
            let exe = std::env::current_exe().expect("fixture executable");
            let cwd = exe.parent().expect("fixture directory");
            let command = format!(
                "\"{}\" --tree \"{}\"",
                exe.display(),
                std::path::Path::new(&path).display()
            );
            let spawned = native::spawn(&command, cwd, 80, 24).expect("spawn hosted fixture");
            let _drain = std::thread::spawn(move || {
                let mut output = spawned.output;
                let _ = io::copy(&mut output, &mut io::sink());
            });
            for _ in 0..200 {
                if std::path::Path::new(&path).exists() {
                    std::process::exit(0);
                }
                std::thread::sleep(Duration::from_millis(10));
            }
            ExitCode::FAILURE
        }
        Some("--exit") => ExitCode::from(42),
        _ => {
            eprintln!(
                "Usage: native_fixture --emit|--echo|--records|--mouse-vt|--mouse-records|--verify-isolation|--flood|--hold|--tree|--host-loss|--exit"
            );
            ExitCode::FAILURE
        }
    }
}

fn verify_isolation() -> bool {
    let Some(expected) = std::env::args_os().nth(2) else {
        return false;
    };
    let Ok(profile) = std::path::PathBuf::from(expected).canonicalize() else {
        return false;
    };
    let paths = [
        ("USERPROFILE", profile.clone()),
        ("HOME", profile.clone()),
        ("APPDATA", profile.join("AppData/Roaming")),
        ("LOCALAPPDATA", profile.join("AppData/Local")),
        ("TEMP", profile.join("Temp")),
        ("TMP", profile.join("Temp")),
        ("CODEX_HOME", profile.join(".codex")),
        ("JECODE_HOME", profile.join(".jecode")),
        ("CLAUDE_CONFIG_DIR", profile.join(".claude")),
        ("XDG_CONFIG_HOME", profile.join(".config")),
    ];
    if !paths.iter().all(|(name, path)| {
        std::env::var_os(name).is_some_and(|value| {
            std::path::PathBuf::from(value)
                .canonicalize()
                .is_ok_and(|actual| actual.as_path() == path.as_path())
        })
    }) {
        return false;
    }
    if [
        "OPENAI_API_KEY",
        "ANTHROPIC_API_KEY",
        "OPENROUTER_API_KEY",
        "WEBTERMINAL_PARENT_ONLY",
    ]
    .iter()
    .any(|name| std::env::var_os(name).is_some())
    {
        return false;
    }
    for name in [
        ".codex/auth.json",
        ".claude/.credentials.json",
        ".jecode/config.json",
        "AppData/Roaming/fixture-credential.json",
    ] {
        if profile.join(name).exists() {
            return false;
        }
    }
    true
}
