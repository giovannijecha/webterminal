//! Test-only launcher: disposable profiles and no real credentials.
use std::{
    env,
    ffi::{OsStr, OsString},
    fs,
    path::{Path, PathBuf},
    process::{Command, ExitCode},
};

const USAGE: &str =
    "Usage: isolated_cli PROFILE [--fixture-api http://127.0.0.1:PORT] EXECUTABLE [ARGS]";
const FIXTURE_KEY: &str = "webterminal-local-fixture-key";

struct Invocation {
    profile: PathBuf,
    exe: OsString,
    args: Vec<OsString>,
    fixture_api: Option<String>,
}

fn parse_invocation(args: impl IntoIterator<Item = OsString>) -> Result<Invocation, String> {
    let mut args = args.into_iter();
    let profile = PathBuf::from(args.next().ok_or(USAGE)?);
    let mut next = args.next().ok_or(USAGE)?;
    let fixture_api = if next == OsStr::new("--fixture-api") {
        let url = fixture_url(&args.next().ok_or("Fixture API URL required")?)?;
        next = args
            .next()
            .ok_or("An explicit executable path is required")?;
        Some(url)
    } else {
        None
    };
    Ok(Invocation {
        profile,
        exe: next,
        args: args.collect(),
        fixture_api,
    })
}

fn fixture_url(value: &OsStr) -> Result<String, String> {
    let text = value.to_str().ok_or("Fixture API URL must be ASCII")?;
    let port = text
        .strip_prefix("http://127.0.0.1:")
        .ok_or("Fixture API must use http://127.0.0.1:PORT")?;
    if port.is_empty() || !port.bytes().all(|b| b.is_ascii_digit()) {
        return Err("Fixture API must use a numeric loopback port without a path".into());
    }
    let number: u16 = port
        .parse()
        .map_err(|_| "Fixture API port must be 1 through 65535")?;
    if number == 0 || number.to_string() != port {
        return Err("Fixture API port must be canonical and nonzero".into());
    }
    Ok(text.into())
}

#[cfg(windows)]
fn ordinary_profile_path(path: &Path) -> PathBuf {
    use std::os::windows::ffi::{OsStrExt, OsStringExt};

    let encoded: Vec<u16> = path.as_os_str().encode_wide().collect();
    let prefix = [b'\\' as u16, b'\\' as u16, b'?' as u16, b'\\' as u16];
    if encoded.starts_with(&prefix) {
        if encoded.get(5) == Some(&(b':' as u16)) && encoded.get(6) == Some(&(b'\\' as u16)) {
            return OsString::from_wide(&encoded[4..]).into();
        }
        if encoded[4..].starts_with(&[b'U' as u16, b'N' as u16, b'C' as u16, b'\\' as u16]) {
            let mut unc = vec![b'\\' as u16, b'\\' as u16];
            unc.extend_from_slice(&encoded[8..]);
            return OsString::from_wide(&unc).into();
        }
    }
    path.to_path_buf()
}

#[cfg(not(windows))]
fn ordinary_profile_path(path: &Path) -> PathBuf {
    path.to_path_buf()
}

fn main() -> ExitCode {
    match run() {
        Ok(code) => ExitCode::from(code as u8),
        Err(e) => {
            eprintln!("Isolated CLI fixture: {e}");
            ExitCode::FAILURE
        }
    }
}
fn run() -> Result<i32, String> {
    let invocation = parse_invocation(env::args_os().skip(1))?;
    fs::create_dir_all(&invocation.profile).map_err(|e| e.to_string())?;
    // Windows canonicalize() returns a verbatim \\?\ path, but Windows
    // PowerShell's Add-Type rejects that spelling in TEMP/TMP. Keep the
    // canonical target while passing its ordinary DOS spelling to children.
    let profile = ordinary_profile_path(
        &invocation
            .profile
            .canonicalize()
            .map_err(|e| e.to_string())?,
    );
    for name in [
        "AppData/Roaming",
        "AppData/Local",
        "Temp",
        ".codex",
        ".claude",
        ".jecode",
        ".config",
    ] {
        fs::create_dir_all(profile.join(name)).map_err(|e| e.to_string())?;
    }
    let mut command = isolated_command(&invocation, &profile);
    let status = command.status().map_err(|e| e.to_string())?;
    Ok(status.code().unwrap_or(1))
}

fn isolated_command(invocation: &Invocation, profile: &Path) -> Command {
    let mut command = Command::new(&invocation.exe);
    command.args(&invocation.args).env_clear();
    for key in [
        "SystemRoot",
        "SystemDrive",
        "WINDIR",
        "PATH",
        "PATHEXT",
        "ComSpec",
        "ProgramFiles",
        "ProgramFiles(x86)",
        "ProgramW6432",
    ] {
        if let Some(value) = env::var_os(key) {
            command.env(key, value);
        }
    }
    command
        .env("USERPROFILE", profile)
        .env("HOME", profile)
        .env("APPDATA", profile.join("AppData/Roaming"))
        .env("LOCALAPPDATA", profile.join("AppData/Local"))
        .env("TEMP", profile.join("Temp"))
        .env("TMP", profile.join("Temp"))
        .env("CODEX_HOME", profile.join(".codex"))
        .env("JECODE_HOME", profile.join(".jecode"))
        .env("CLAUDE_CONFIG_DIR", profile.join(".claude"))
        .env("XDG_CONFIG_HOME", profile.join(".config"))
        .env("CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC", "1")
        .env("DISABLE_TELEMETRY", "1")
        .env("DISABLE_AUTOUPDATER", "1")
        .env("TERM", "xterm-256color")
        .env("COLORTERM", "truecolor");
    // Ordinary fixture launches have no API credential. The explicit option
    // gives the child only an inert key and its owned loopback API endpoint.
    if let Some(url) = &invocation.fixture_api {
        command
            .env("ANTHROPIC_BASE_URL", url)
            .env("ANTHROPIC_API_KEY", FIXTURE_KEY);
    }
    command
}

#[cfg(test)]
mod tests {
    use super::*;

    fn invocation(args: &[&str]) -> Result<Invocation, String> {
        parse_invocation(args.iter().map(OsString::from))
    }

    fn environment<'a>(command: &'a Command, name: &str) -> Option<&'a OsStr> {
        command
            .get_envs()
            .find(|(key, _)| *key == OsStr::new(name))
            .and_then(|(_, value)| value)
    }

    #[test]
    fn fixture_api_requires_exact_loopback_origin() {
        for bad in [
            "https://127.0.0.1:4183",
            "http://localhost:4183",
            "http://127.0.0.2:4183",
            "http://user@127.0.0.1:4183",
            "http://127.0.0.1:0",
            "http://127.0.0.1:65536",
            "http://127.0.0.1:04183",
            "http://127.0.0.1:4183/",
            "http://127.0.0.1:4183/path",
            "http://127.0.0.1:4183?key=value",
        ] {
            assert!(fixture_url(OsStr::new(bad)).is_err(), "{bad}");
        }
        assert_eq!(
            fixture_url(OsStr::new("http://127.0.0.1:4183")).unwrap(),
            "http://127.0.0.1:4183"
        );
    }

    #[test]
    fn fake_key_is_present_only_for_explicit_fixture_api() {
        let ordinary = invocation(&["profile", "fixture.exe", "--check"]).unwrap();
        assert_eq!(ordinary.args, ["--check"]);
        let command = isolated_command(&ordinary, Path::new("profile"));
        assert!(environment(&command, "ANTHROPIC_API_KEY").is_none());
        assert!(environment(&command, "ANTHROPIC_BASE_URL").is_none());

        let fixture = invocation(&[
            "profile",
            "--fixture-api",
            "http://127.0.0.1:4183",
            "fixture.exe",
            "--check",
        ])
        .unwrap();
        assert_eq!(fixture.args, ["--check"]);
        let command = isolated_command(&fixture, Path::new("profile"));
        assert_eq!(
            environment(&command, "ANTHROPIC_API_KEY"),
            Some(OsStr::new(FIXTURE_KEY))
        );
        assert_eq!(
            environment(&command, "ANTHROPIC_BASE_URL"),
            Some(OsStr::new("http://127.0.0.1:4183"))
        );
    }

    #[test]
    #[cfg(windows)]
    fn profile_environment_uses_windows_compatible_path_spelling() {
        assert_eq!(
            ordinary_profile_path(Path::new(r"\\?\C:\fixture\profile")),
            PathBuf::from(r"C:\fixture\profile")
        );
        assert_eq!(
            ordinary_profile_path(Path::new(r"\\?\UNC\server\share\profile")),
            PathBuf::from(r"\\server\share\profile")
        );
    }
}
