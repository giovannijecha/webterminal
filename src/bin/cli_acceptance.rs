//! Manual TUI acceptance with disposable profiles. Only a loopback fixture
//! receives submitted text; Jecode is restricted to drafts and local commands.
use std::{
    env, fs,
    io::{Read, Write},
    net::{SocketAddr, TcpStream},
    path::PathBuf,
    thread,
    time::{Duration, Instant},
};
#[path = "cli_acceptance/probe.rs"]
mod cli_acceptance_probe;
use cli_acceptance_probe::Probe;

fn main() {
    if let Err(error) = run() {
        eprintln!("CLI acceptance: {error}");
        std::process::exit(1);
    }
}
fn run() -> Result<(), String> {
    let mut args = env::args().skip(1);
    let kind = args
        .next()
        .ok_or("Usage: cli_acceptance jecode|codex|claude PROFILE EXECUTABLE [FIXTURE_ORIGIN]")?;
    if !matches!(kind.as_str(), "jecode" | "codex" | "claude") {
        return Err("Unknown CLI fixture".into());
    }
    let profile = PathBuf::from(args.next().ok_or("Disposable profile required")?);
    let exe = args.next().ok_or("Explicit executable required")?;
    let origin = args.next();
    if args.next().is_some() {
        return Err("Unexpected argument".into());
    }
    let target = env::current_exe()
        .map_err(|e| e.to_string())?
        .parent()
        .ok_or("Binary parent")?
        .parent()
        .ok_or("Target parent")?
        .canonicalize()
        .map_err(|e| e.to_string())?;
    fs::create_dir_all(&profile).map_err(|e| e.to_string())?;
    let profile = profile.canonicalize().map_err(|e| e.to_string())?;
    if !profile.starts_with(&target) || profile == target {
        return Err("Acceptance profiles must be inside this build's target directory".into());
    }
    let wrapper = env::current_exe()
        .map_err(|e| e.to_string())?
        .with_file_name("isolated_cli.exe");
    let mut parts = vec![
        wrapper.to_string_lossy().into_owned(),
        profile.to_string_lossy().into_owned(),
    ];
    if kind != "jecode" {
        let url = origin
            .as_ref()
            .ok_or("Codex/Claude require a loopback fixture origin")?;
        let port = url
            .strip_prefix("http://127.0.0.1:")
            .and_then(|p| p.parse::<u16>().ok())
            .filter(|p| *p != 0)
            .ok_or("Fixture must be http://127.0.0.1:PORT")?;
        if url != &format!("http://127.0.0.1:{port}") {
            return Err("Noncanonical fixture origin".into());
        }
        parts.extend(["--fixture-api".into(), url.clone()]);
    }
    parts.push(exe);
    match kind.as_str() {
        "jecode" => {
            let directory = profile.join(".jecode");
            fs::create_dir_all(&directory).map_err(|e| e.to_string())?;
            let path = directory.join("config.json");
            if path.exists() {
                return Err("Use a fresh Jecode fixture profile".into());
            }
            fs::write(path, r#"{"openrouter":{"api_key":"webterminal-isolated-fixture-key","model":"fixture/model"}}"#)
                .map_err(|e| e.to_string())?;
        }
        "codex" => {
            parts.extend(
                [
                    "--no-daemon",
                    "--strict-config",
                    "-m",
                    "fixture-model",
                    "-s",
                    "read-only",
                    "-a",
                    "never",
                ]
                .map(str::to_owned),
            );
            for value in [
                "model_provider=\"local_fixture\"".to_owned(),
                "model_providers.local_fixture.name=\"Local fixture\"".to_owned(),
                format!(
                    "model_providers.local_fixture.base_url=\"{}/v1\"",
                    origin.as_ref().unwrap()
                ),
                "model_providers.local_fixture.wire_api=\"responses\"".to_owned(),
                "model_providers.local_fixture.requires_openai_auth=false".to_owned(),
                "model_providers.local_fixture.supports_websockets=false".to_owned(),
                "model_providers.local_fixture.request_max_retries=0".to_owned(),
                "model_providers.local_fixture.stream_max_retries=0".to_owned(),
                "web_search=\"disabled\"".to_owned(),
                "check_for_update_on_startup=false".to_owned(),
                "analytics.enabled=false".to_owned(),
                "history.persistence=\"none\"".to_owned(),
            ] {
                parts.extend(["-c".into(), value]);
            }
        }
        "claude" => parts.extend(
            [
                "--bare",
                "--restricted",
                "--tools",
                "",
                "--strict-mcp-config",
                "--model",
                "fixture-model",
            ]
            .map(str::to_owned),
        ),
        _ => unreachable!(),
    }
    let command = parts.iter().map(|s| quote(s)).collect::<Vec<_>>().join(" ");
    let mut probe = Probe::new(&command, &profile)?;
    thread::sleep(Duration::from_secs(3));
    println!("INITIAL_SCREEN:\n{}", probe.screen()?);
    if kind == "claude" && probe.screen()?.contains("Choose the text style") {
        probe.key(13, 28, 13, 0)?;
        thread::sleep(Duration::from_secs(1));
        println!("AFTER_THEME:\n{}", probe.screen()?);
    }
    if kind == "claude" && probe.screen()?.contains("Detected a custom API key") {
        // This is the inert key supplied explicitly by isolated_cli for its
        // numeric-loopback fixture, never a personal API credential.
        probe.key(38, 72, 0, 0)?;
        probe.key(13, 28, 13, 0)?;
        thread::sleep(Duration::from_secs(1));
        println!("AFTER_FIXTURE_KEY:\n{}", probe.screen()?);
    }
    if kind == "claude"
        && probe.screen()?.contains("Security notes:")
        && probe.screen()?.contains("Press Enter to continue")
    {
        probe.key(13, 28, 13, 0)?;
        thread::sleep(Duration::from_secs(1));
        println!("AFTER_SECURITY_NOTES:\n{}", probe.screen()?);
    }
    if kind == "claude"
        && probe.screen()?.contains("Accessing workspace:")
        && probe.screen()?.contains("Yes, I trust this folder")
    {
        // Only the disposable directory verified above is used as the CWD;
        // --bare, --restricted and --tools "" keep this fixture text-only.
        probe.key(40, 80, 0, 0)?;
        probe.key(13, 28, 13, 0)?;
        thread::sleep(Duration::from_secs(1));
        println!("AFTER_WORKSPACE_TRUST:\n{}", probe.screen()?);
    }
    let screen = probe.screen()?;
    if screen.to_lowercase().contains("terms of service") {
        return Err("Onboarding requires terms acceptance; probe stopped".into());
    }
    if kind == "codex" && screen.contains("Trust this folder?") {
        // The folder and all its fixtures were created for this test. The
        // read-only policy and fixed loopback provider remain in effect.
        // The provider can only return text and never tool calls.
        probe.key(13, 28, 13, 0)?;
        thread::sleep(Duration::from_secs(1));
        println!("AFTER_FOLDER_TRUST:\n{}", probe.screen()?);
    }
    if kind == "codex" && probe.screen()?.contains("Set up the Codex agent sandbox") {
        // Escape cancels this optional first-run menu. Never select a setup
        // action: the probe must not provision Windows permissions or accounts.
        probe.key(27, 1, 27, 0)?;
        thread::sleep(Duration::from_secs(1));
        println!("AFTER_SANDBOX_CANCEL:\n{}", probe.screen()?);
    }
    let marker = match kind.as_str() {
        "jecode" => "Ask anything",
        "codex" => "fixture-model",
        _ => "fixture-model",
    };
    probe.wait(marker, Duration::from_secs(12))?;
    println!("READY_SCREEN:\n{}", probe.screen()?);
    println!("WIN32_INPUT_MODE:{}", probe.win32()?);
    if kind == "jecode" {
        exercise_jecode(&mut probe)?;
    } else {
        exercise_local_api(&mut probe, &kind, origin.as_ref().unwrap())?;
    }
    println!("ACCEPTANCE:{kind}:PASS");
    Ok(())
}

fn exercise_jecode(p: &mut Probe) -> Result<(), String> {
    // An Enter event with an empty draft cannot call the hardcoded provider.
    let before = p.screen()?;
    p.key(13, 28, 13, 16)?;
    thread::sleep(Duration::from_millis(150));
    if p.screen()? == before {
        return Err("Shift+Enter did not change the empty composer".into());
    }
    p.key(32, 57, 0, 8)?;
    p.key(67, 46, 3, 8)?;
    p.wait("Ask anything", Duration::from_secs(2))?;
    p.text("draft caf\u{e9} \u{1f469}\u{200d}\u{1f4bb}")?;
    p.wait(
        "draft caf\u{e9} \u{1f469}\u{200d}\u{1f4bb}",
        Duration::from_secs(2),
    )?;
    // Jecode groups quick printable console records into a paste burst. Let
    // that burst finish before exercising a separate Backspace key event.
    thread::sleep(Duration::from_millis(120));
    p.key(8, 14, 8, 0)?;
    let end = Instant::now() + Duration::from_secs(2);
    while p.screen()?.contains("\u{1f469}\u{200d}\u{1f4bb}") {
        if Instant::now() >= end {
            return Err("Backspace did not remove the emoji grapheme".into());
        }
        thread::sleep(Duration::from_millis(20));
    }
    p.text("X")?;
    p.wait("draft caf\u{e9} X", Duration::from_secs(2))?;
    println!("PASS Unicode draft and Backspace editing");
    p.resize(100, 30)?;
    p.wait("draft caf\u{e9} X", Duration::from_secs(2))?;
    p.key(67, 46, 3, 8)?;
    p.wait("Ask anything", Duration::from_secs(2))?;
    p.text("\x1b[200~first caf\u{e9}\nsecond \u{1f469}\u{200d}\u{1f4bb}\x1b[201~")?;
    p.wait("first caf\u{e9}", Duration::from_secs(2))?;
    p.wait("second", Duration::from_secs(2))?;
    println!("PASS multiline bracketed paste stays in draft");
    p.key(67, 46, 3, 8)?;
    p.wait("Ask anything", Duration::from_secs(2))?;
    p.text("/")?;
    p.wait("Commands", Duration::from_secs(2))?;
    p.key(27, 1, 27, 0)?;
    p.key(67, 46, 3, 8)?;
    p.key(112, 59, 0, 0)?;
    p.wait("Commands and controls", Duration::from_secs(2))?;
    println!("PASS local commands and help menu");
    p.key(27, 1, 27, 0)?;
    p.text("/resume")?;
    p.key(13, 28, 13, 0)?;
    p.wait("Resume", Duration::from_secs(2))?;
    println!("PASS local resume menu");
    p.key(27, 1, 27, 0)?;
    p.key(81, 16, 17, 8)?;
    p.wait_exit(Duration::from_secs(3))?;
    println!("MODEL_PROMPTS_SUBMITTED:0");
    Ok(())
}
fn exercise_local_api(p: &mut Probe, kind: &str, origin: &str) -> Result<(), String> {
    let initial_submissions = fixture_submissions(origin)?;
    // Modified keys on an empty composer must leave the TUI usable. Some
    // clients insert a newline; others treat these as local shortcuts.
    p.key(13, 28, 13, 16)?;
    p.key(32, 57, 0, 8)?;
    p.wait("fixture-model", Duration::from_secs(2))?;
    if !p.still_running()? {
        return Err("Modified empty-composer keys exited the CLI".into());
    }
    println!("PASS empty Shift+Enter and Ctrl+Space");
    println!("EMPTY_MODIFIERS_SCREEN:\n{}", p.screen()?);
    // Codex inserts an empty line for Shift+Enter. Remove it before the
    // slash command so the command begins at the start of the draft.
    p.key(8, 14, 8, 0)?;
    // Open, navigate and dismiss a local command picker without submitting.
    p.text("/")?;
    p.wait("/", Duration::from_secs(2))?;
    thread::sleep(Duration::from_millis(200));
    println!("LOCAL_MENU_OPEN:\n{}", p.screen()?);
    p.key(40, 80, 0, 0)?;
    p.key(27, 1, 27, 0)?;
    println!("LOCAL_MENU_DISMISSED:\n{}", p.screen()?);
    // Escape closes the picker but Claude retains the slash draft. Backspace
    // removes that single character before the ordinary Unicode message.
    p.key(8, 14, 8, 0)?;
    p.wait("fixture-model", Duration::from_secs(2))?;
    // The draft has Unicode and an emoji grapheme, then a separate Backspace
    // checks whether the CLI receives the editing key after the paste burst.
    p.text("Webterminal local fixture draft caf\u{e9} \u{1f469}\u{200d}\u{1f4bb}")?;
    p.wait("draft caf\u{e9}", Duration::from_secs(2))?;
    thread::sleep(Duration::from_millis(150));
    p.key(8, 14, 8, 0)?;
    p.wait("draft caf\u{e9}", Duration::from_secs(2))?;
    p.resize(100, 30)?;
    p.wait("draft caf\u{e9}", Duration::from_secs(2))?;
    println!("PASS Unicode draft editing and 100x30 resize");
    p.key(13, 28, 13, 0)?;
    p.wait(
        "Webterminal local fixture response.",
        Duration::from_secs(15),
    )?;
    thread::sleep(Duration::from_millis(300));
    let first_submissions = fixture_submissions(origin)?;
    if first_submissions <= initial_submissions {
        return Err("First explicit Enter did not reach the fixture".into());
    }
    println!(
        "PASS first actual CLI streamed loopback fixture response ({} POST)",
        first_submissions - initial_submissions
    );
    // LF is the newline inside a bracketed paste. CR is a distinct Enter
    // input event for the Windows CLIs and could submit the draft early.
    p.text("\x1b[200~first caf\u{e9}\nsecond \u{1f469}\u{200d}\u{1f4bb}\x1b[201~")?;
    p.wait("first caf\u{e9}", Duration::from_secs(2))?;
    p.wait("second", Duration::from_secs(2))?;
    thread::sleep(Duration::from_millis(500));
    if fixture_submissions(origin)? != first_submissions {
        return Err("Bracketed paste submitted before Enter".into());
    }
    println!("PASS bracketed multiline LF paste remains in draft");
    p.key(13, 28, 13, 0)?;
    p.wait_count(
        "Webterminal local fixture response.",
        2,
        Duration::from_secs(15),
    )?;
    let second_submissions = fixture_submissions(origin)?;
    if second_submissions <= first_submissions {
        return Err("Second explicit Enter did not reach the fixture".into());
    }
    println!(
        "PASS second actual CLI streamed loopback fixture response ({} POST)",
        second_submissions - first_submissions
    );
    println!("AFTER_FIXTURE_TURNS:\n{}", p.screen()?);
    if kind == "codex" {
        p.text("/quit")?;
        p.wait("/quit", Duration::from_secs(2))?;
        thread::sleep(Duration::from_millis(250));
        p.key(13, 28, 13, 0)?;
    } else {
        for _ in 0..3 {
            p.key(67, 46, 3, 8)?;
            thread::sleep(Duration::from_millis(500));
        }
    }
    p.wait_exit(Duration::from_secs(5))?;
    println!("REAL_MODEL_PROMPTS_SUBMITTED:0");
    Ok(())
}

fn fixture_submissions(origin: &str) -> Result<usize, String> {
    let port: u16 = origin
        .strip_prefix("http://127.0.0.1:")
        .ok_or("Fixture origin was not validated")?
        .parse()
        .map_err(|e: std::num::ParseIntError| e.to_string())?;
    let address = SocketAddr::from(([127, 0, 0, 1], port));
    let mut stream =
        TcpStream::connect_timeout(&address, Duration::from_secs(2)).map_err(|e| e.to_string())?;
    stream
        .set_read_timeout(Some(Duration::from_secs(2)))
        .map_err(|e| e.to_string())?;
    let request = format!(
        "GET /fixture/status HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nConnection: close\r\n\r\n"
    );
    stream
        .write_all(request.as_bytes())
        .map_err(|e| e.to_string())?;
    let mut response = Vec::new();
    stream
        .take(1024)
        .read_to_end(&mut response)
        .map_err(|e| e.to_string())?;
    let response = String::from_utf8(response).map_err(|e| e.to_string())?;
    let (header, body) = response
        .split_once("\r\n\r\n")
        .ok_or("Fixture status did not have an HTTP body")?;
    if !header.starts_with("HTTP/1.1 200 OK\r\n") {
        return Err(format!("Fixture status failed: {header}"));
    }
    let value = webterminal::json::parse(body)?;
    let count = |name| {
        value
            .get(name)
            .and_then(webterminal::json::Value::number)
            .ok_or_else(|| format!("Fixture status lacks {name}"))
    };
    usize::try_from(count("responses")? + count("messages")?).map_err(|e| e.to_string())
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
