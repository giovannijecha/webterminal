//! Scripted TUI driver for hook-bridge acceptance with disposable profiles.
//! It runs one CLI through `isolated_cli` inside ConPTY and executes a small
//! line script, printing timestamped screens so external hook logs can be
//! correlated with what the TUI showed. Only the loopback `api_fixture` may
//! serve model requests; login, terms and sandbox-provisioning screens stop
//! the run untouched (`onboard` only dismisses sandbox setup with Escape).
//!
//! Script steps, one per line (`#` starts a comment; `${PROFILE}`, `${WORK}`
//! and `${SCRIPT_DIR}` expand to absolute paths):
//!
//! ```text
//! onboard SECS MARKER[|MARKER]   handle known first-run screens until a marker shows
//! wait SECS TEXT                 wait until the screen contains TEXT
//! gone SECS TEXT                 wait until the screen no longer contains TEXT
//! choose SECS TEXT               move the menu cursor to the TEXT line, press Enter
//! log SECS PATH COUNT TEXT       wait until file PATH contains TEXT COUNT times
//! type TEXT                      send TEXT as typed input
//! key NAME [NAME]                enter esc up down left right tab shift-tab f2
//!                                backspace space ctrl-c, or a digit 0-9
//! sleep MS                       pause
//! screen LABEL                   print the current screen
//! watch SECS MS LABEL            print the screen whenever it changes
//! write PATH TEXT                replace a file (for example a hook control file)
//! if TEXT :: STEP                run STEP only when the screen contains TEXT
//! exit SECS                      wait for the CLI to exit
//! ```
use std::{
    env, fs,
    path::{Path, PathBuf},
    thread,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
// The acceptance driver's ConPTY wrapper; this tool uses a subset of it.
#[allow(dead_code)]
#[path = "cli_acceptance/probe.rs"]
mod cli_acceptance_probe;
use cli_acceptance_probe::Probe;

const USAGE: &str =
    "Usage: bridge_probe PROFILE SCRIPT [--fixture-api http://127.0.0.1:PORT] EXECUTABLE [ARGS]";
/// Marks a directory created by this tool, so reruns never adopt a real home.
const PROFILE_MARKER: &str = ".bridge-probe-profile";
const COLS: u16 = 100;
const ROWS: u16 = 30;

fn main() {
    if let Err(error) = run() {
        eprintln!("Bridge probe: {error}");
        std::process::exit(1);
    }
}

fn run() -> Result<(), String> {
    let mut args = env::args().skip(1);
    let profile = disposable_profile(Path::new(&args.next().ok_or(USAGE)?))?;
    let script_path = PathBuf::from(args.next().ok_or(USAGE)?);
    let rest = args.collect::<Vec<_>>();
    if rest.is_empty() || (rest[0] == "--fixture-api" && rest.len() < 3) {
        return Err(USAGE.into());
    }
    let script = fs::read_to_string(&script_path).map_err(|e| e.to_string())?;
    let script_dir = fs::canonicalize(&script_path)
        .map(|path| ordinary(path.parent().unwrap_or(Path::new("."))))
        .map_err(|e| e.to_string())?;
    let work = profile.join("work");
    fs::create_dir_all(&work).map_err(|e| e.to_string())?;
    let wrapper = env::current_exe()
        .map_err(|e| e.to_string())?
        .with_file_name("isolated_cli.exe");
    let mut parts = vec![path_text(&wrapper), path_text(&profile)];
    parts.extend(rest);
    let command = parts.iter().map(|s| quote(s)).collect::<Vec<_>>().join(" ");
    let clock = Clock(Instant::now());
    clock.say(&format!("COMMAND {command}"));
    let probe = Probe::new(&command, &work)?;
    probe.resize(COLS, ROWS)?;
    let vars = [
        ("${PROFILE}", path_text(&profile)),
        ("${WORK}", path_text(&work)),
        ("${SCRIPT_DIR}", path_text(&script_dir)),
    ];
    for (number, line) in script.lines().enumerate() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let line = vars.iter().fold(line.to_owned(), |text, (name, value)| {
            text.replace(name, value)
        });
        if let Err(error) = step(&probe, &clock, &line) {
            clock.say(&format!("FAILED line {}: {line}", number + 1));
            print_screen(&clock, "FAILURE", &probe.screen()?);
            return Err(error);
        }
    }
    clock.say("SCRIPT COMPLETE");
    // Dropping the probe terminates the job object, including hook children.
    Ok(())
}

/// Wall-clock and elapsed time on every line, matching hook-log epochs.
struct Clock(Instant);

impl Clock {
    fn say(&self, text: &str) {
        let epoch = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis();
        let elapsed = self.0.elapsed().as_secs_f64();
        println!("[{epoch} +{elapsed:.2}s] {text}");
    }
}

fn step(probe: &Probe, clock: &Clock, line: &str) -> Result<(), String> {
    let (verb, rest) = line.split_once(' ').unwrap_or((line, ""));
    let (first, tail) = rest.split_once(' ').unwrap_or((rest, ""));
    let seconds = || -> Result<Duration, String> {
        first
            .parse::<u64>()
            .map(Duration::from_secs)
            .map_err(|_| format!("Expected seconds, got {first:?}"))
    };
    clock.say(&format!("STEP {line}"));
    match verb {
        "onboard" => onboard(probe, clock, seconds()?, tail),
        "wait" => wait_for(probe, seconds()?, |screen| screen.contains(tail)),
        "gone" => wait_for(probe, seconds()?, |screen| !screen.contains(tail)),
        "choose" => {
            wait_for(probe, seconds()?, |screen| screen.contains(tail))?;
            guard(probe)?;
            choose(probe, tail)
        }
        "log" => {
            let mut fields = tail.splitn(3, ' ');
            let (path, count, text) = (fields.next(), fields.next(), fields.next());
            let (Some(path), Some(count), Some(text)) = (path, count, text) else {
                return Err("log SECS PATH COUNT TEXT".into());
            };
            let count = count.parse::<usize>().map_err(|e| e.to_string())?;
            let end = Instant::now() + seconds()?;
            loop {
                let found = fs::read_to_string(path).unwrap_or_default();
                if found.matches(text).count() >= count {
                    return Ok(());
                }
                if Instant::now() >= end {
                    return Err(format!("{path} lacks {count} x {text:?}"));
                }
                thread::sleep(Duration::from_millis(50));
            }
        }
        "type" => guard(probe).and_then(|()| probe.text(rest)),
        "key" => rest.split_whitespace().try_for_each(|name| {
            guard(probe)?;
            press(probe, name)?;
            thread::sleep(Duration::from_millis(60));
            Ok(())
        }),
        "sleep" => {
            let ms = rest.parse::<u64>().map_err(|e| e.to_string())?;
            thread::sleep(Duration::from_millis(ms));
            Ok(())
        }
        "screen" => {
            print_screen(clock, rest, &probe.screen()?);
            Ok(())
        }
        "watch" => {
            let (period, label) = tail.split_once(' ').unwrap_or((tail, ""));
            let period = period.parse::<u64>().map_err(|e| e.to_string())?;
            let end = Instant::now() + seconds()?;
            let mut last = String::new();
            while Instant::now() < end {
                let screen = compact(&probe.screen()?);
                if screen != last {
                    print_screen(clock, label, &screen);
                    last = screen;
                }
                thread::sleep(Duration::from_millis(period));
            }
            Ok(())
        }
        "write" => fs::write(first, tail).map_err(|e| format!("{first}: {e}")),
        "if" => match rest.split_once(" :: ") {
            Some((text, inner)) if probe.screen()?.contains(text) => step(probe, clock, inner),
            Some(_) => Ok(()),
            None => Err("if TEXT :: STEP".into()),
        },
        "exit" => probe.wait_exit(seconds()?),
        _ => Err(format!("Unknown step {verb:?}")),
    }
}

/// Lowercase text of screens a script must never answer: authentication,
/// terms, and Codex's Windows sandbox provisioning, which can ask for
/// Administrator rights and may appear late, after the hooks review.
const FORBIDDEN: [&str; 5] = [
    "terms of service",
    "select login method",
    "set up the codex agent sandbox",
    "couldn't set up your sandbox",
    "administrator permissions",
];

/// Checked immediately before each scripted input. Only `onboard` may answer
/// the sandbox screen, and only with Escape.
fn guard(probe: &Probe) -> Result<(), String> {
    let screen = probe.screen()?.to_lowercase();
    match FORBIDDEN.iter().find(|text| screen.contains(*text)) {
        Some(text) => Err(format!("Refusing input on a {text:?} screen")),
        None => Ok(()),
    }
}

/// Answers only the first-run screens known to be safe in a disposable
/// profile: theme, the inert fixture API key, security notes, folder trust
/// for the owned work directory, and dismissing Codex sandbox setup.
fn onboard(probe: &Probe, clock: &Clock, timeout: Duration, markers: &str) -> Result<(), String> {
    let markers = markers.split('|').collect::<Vec<_>>();
    let end = Instant::now() + timeout;
    loop {
        let screen = probe.screen()?;
        let lower = screen.to_lowercase();
        if lower.contains("terms of service") || lower.contains("select login method") {
            return Err("Authentication or terms screen; stopped without input".into());
        }
        if markers.iter().any(|marker| screen.contains(marker)) {
            print_screen(clock, "ONBOARD READY", &screen);
            return Ok(());
        }
        let action = if screen.contains("Choose the text style") {
            Some(("theme", None))
        } else if screen.contains("Detected a custom API key") {
            // isolated_cli supplies only its inert loopback fixture key.
            Some(("fixture API key", Some("Yes")))
        } else if screen.contains("Security notes:") && screen.contains("Press Enter to continue") {
            Some(("security notes", None))
        } else if screen.contains("Yes, I trust this folder") {
            Some(("workspace trust", Some("Yes, I trust this folder")))
        } else if screen.contains("Trust this folder?") {
            Some(("codex folder trust", None))
        } else {
            None
        };
        if let Some((name, option)) = action {
            print_screen(clock, &format!("ONBOARD {name}"), &screen);
            match option {
                Some(option) => choose(probe, option)?,
                None => press(probe, "enter")?,
            }
            thread::sleep(Duration::from_millis(800));
        } else if screen.contains("Set up the Codex agent sandbox") {
            // Never provision Windows permissions or accounts from a probe.
            print_screen(clock, "ONBOARD codex sandbox setup (Escape)", &screen);
            press(probe, "esc")?;
            thread::sleep(Duration::from_millis(800));
        }
        if Instant::now() >= end {
            return Err(format!("Onboarding did not reach {markers:?}"));
        }
        thread::sleep(Duration::from_millis(100));
    }
}

/// Moves a list cursor (`❯` or `›`) to the line containing `option`, then
/// presses Enter. It refuses to confirm when the cursor never reaches it.
fn choose(probe: &Probe, option: &str) -> Result<(), String> {
    for _ in 0..12 {
        let screen = probe.screen()?;
        let lines = screen.lines().collect::<Vec<_>>();
        let target = lines.iter().position(|line| line.contains(option));
        // A prompt glyph may also start the composer line; use the nearest.
        let cursor = (0..lines.len())
            .filter(|&index| {
                let line = lines[index].trim_start();
                line.starts_with('❯') || line.starts_with('›') || line.starts_with('>')
            })
            .min_by_key(|&index| index.abs_diff(target.unwrap_or(index)));
        match (cursor, target) {
            (Some(cursor), Some(target)) if cursor == target => return press(probe, "enter"),
            (Some(cursor), Some(target)) => {
                press(probe, if target > cursor { "down" } else { "up" })?
            }
            _ => return Err(format!("No menu cursor or option {option:?}")),
        }
        thread::sleep(Duration::from_millis(200));
    }
    Err(format!("Cursor did not reach {option:?}"))
}

fn press(probe: &Probe, name: &str) -> Result<(), String> {
    // Windows virtual-key code, scan code, character and modifier state.
    let (vk, scan, ch, mods) = match name {
        "enter" => (13, 28, 13, 0),
        "esc" => (27, 1, 27, 0),
        "up" => (38, 72, 0, 0),
        "down" => (40, 80, 0, 0),
        "left" => (37, 75, 0, 0),
        "right" => (39, 77, 0, 0),
        "tab" => (9, 15, 9, 0),
        "shift-tab" => (9, 15, 9, 16),
        "backspace" => (8, 14, 8, 0),
        "space" => (32, 57, 32, 0),
        "ctrl-c" => (67, 46, 3, 8),
        "f2" => (113, 60, 0, 0),
        digit if digit.len() == 1 && digit.as_bytes()[0].is_ascii_digit() => {
            let code = u16::from(digit.as_bytes()[0]);
            let scan = if code == u16::from(b'0') {
                11
            } else {
                code - 47
            };
            (code, scan, code, 0)
        }
        _ => return Err(format!("Unknown key {name:?}")),
    };
    probe.key(vk, scan, ch, mods)
}

fn wait_for(probe: &Probe, timeout: Duration, done: impl Fn(&str) -> bool) -> Result<(), String> {
    let end = Instant::now() + timeout;
    loop {
        let screen = probe.screen()?;
        if done(&screen) {
            return Ok(());
        }
        if screen.to_lowercase().contains("terms of service") {
            return Err("Terms screen; stopped without input".into());
        }
        if Instant::now() >= end {
            return Err("Timed out".into());
        }
        thread::sleep(Duration::from_millis(40));
    }
}

/// Screen text without trailing spaces or blank-line runs.
fn compact(screen: &str) -> String {
    let mut out = String::new();
    let mut blank = false;
    for line in screen.lines().map(str::trim_end) {
        if line.is_empty() {
            blank = true;
            continue;
        }
        if blank && !out.is_empty() {
            out.push('\n');
        }
        blank = false;
        out.push_str(line);
        out.push('\n');
    }
    out
}

fn print_screen(clock: &Clock, label: &str, screen: &str) {
    clock.say(&format!("SCREEN {label}"));
    for line in compact(screen).lines() {
        println!("  | {line}");
    }
}

/// Creates or reuses a directory this tool marked as disposable.
fn disposable_profile(path: &Path) -> Result<PathBuf, String> {
    if path.exists() {
        if !path.join(PROFILE_MARKER).is_file() {
            return Err("Profile exists but was not created by bridge_probe".into());
        }
    } else {
        fs::create_dir_all(path).map_err(|e| e.to_string())?;
        fs::write(
            path.join(PROFILE_MARKER),
            "Disposable bridge_probe profile\n",
        )
        .map_err(|e| e.to_string())?;
    }
    fs::canonicalize(path)
        .map(|path| ordinary(&path))
        .map_err(|e| e.to_string())
}

/// Drops the verbatim `\\?\` prefix so children see an ordinary DOS path.
fn ordinary(path: &Path) -> PathBuf {
    let text = path.to_string_lossy();
    match text.strip_prefix(r"\\?\") {
        Some(rest) if rest.as_bytes().get(1) == Some(&b':') => PathBuf::from(rest),
        _ => path.to_path_buf(),
    }
}

fn path_text(path: &Path) -> String {
    path.to_string_lossy().into_owned()
}

/// Quotes one argument for the Windows command line (CommandLineToArgvW rules).
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
