use std::{env, path::PathBuf, process::ExitCode};
use webterminal::{
    native,
    server::{Config, Server},
};

const HELP: &str = "Webterminal - a local browser terminal for Windows

Usage: webterminal [--port PORT] [--cwd DIRECTORY] [--shell COMMAND]

Options:
  --port PORT        Loopback HTTP/WebSocket port (default 4183)
  --cwd DIRECTORY    Initial working directory (default current directory)
  --shell COMMAND    Server-wide program override for development checks
  -h, --help         Show this help
  -V, --version      Show the package version

Open http://127.0.0.1:4183/ in a browser. Ports 4173 and 4174 are
reserved by this build. Ctrl+C stops owned sessions and the server.
Browser closure disconnects views; Close terminal ends a session.
Requires Windows 10 version 1809 or later and ConPTY.
New terminals run Windows PowerShell with -NoLogo -NoProfile.
";

fn main() -> ExitCode {
    match run() {
        Ok(()) => ExitCode::SUCCESS,
        Err(e) => {
            eprintln!("Webterminal: {e}");
            ExitCode::FAILURE
        }
    }
}
fn run() -> Result<(), String> {
    let mut args = env::args_os().skip(1);
    let mut config = Config {
        port: 4183,
        cwd: env::current_dir().map_err(|e| e.to_string())?,
        shell: "powershell.exe -NoLogo -NoProfile".into(),
    };
    while let Some(arg) = args.next() {
        match arg.to_str() {
            Some("--help" | "-h") => {
                print!("{HELP}");
                return Ok(());
            }
            Some("--version" | "-V") => {
                println!("webterminal {}", env!("CARGO_PKG_VERSION"));
                return Ok(());
            }
            Some("--port") => {
                let value = args.next().ok_or("--port requires a value")?;
                config.port = value
                    .to_str()
                    .and_then(|v| v.parse::<u16>().ok())
                    .filter(|p| *p != 0)
                    .ok_or("--port must be 1..65535")?;
            }
            Some("--cwd") => {
                config.cwd = PathBuf::from(args.next().ok_or("--cwd requires a directory")?)
            }
            Some("--shell") => {
                config.shell = args
                    .next()
                    .ok_or("--shell requires a command")?
                    .into_string()
                    .map_err(|_| "--shell must be Unicode")?
            }
            _ => return Err("Unsupported arguments. Run webterminal --help.".into()),
        }
    }
    config.cwd = config
        .cwd
        .canonicalize()
        .map_err(|e| format!("Cannot open initial directory: {e}"))?;
    if !config.cwd.is_dir() {
        return Err("Initial working directory must be a directory".into());
    }
    native::install_shutdown_handler().map_err(|e| e.to_string())?;
    let server = Server::bind(config).map_err(|e| e.to_string())?;
    println!("Webterminal listening at http://127.0.0.1:{}/", server.port);
    server.run().map_err(|e| e.to_string())
}
