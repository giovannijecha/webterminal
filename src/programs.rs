//! Optional programs launched inside the fixed Windows PowerShell base shell.
//! Availability is an exact `PATH` lookup; nothing runs until a user launches it.
use std::env;
use std::ffi::OsStr;
use std::path::{Path, PathBuf};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Program {
    Claude,
    Codex,
    Jecode,
}
pub const PROGRAMS: [Program; 3] = [Program::Claude, Program::Codex, Program::Jecode];
const PATH_ENTRY_LIMIT: usize = 256;

impl Program {
    pub fn parse(id: &str) -> Option<Self> {
        PROGRAMS.into_iter().find(|program| program.id() == id)
    }
    pub fn id(self) -> &'static str {
        match self {
            Self::Claude => "claude",
            Self::Codex => "codex",
            Self::Jecode => "jecode",
        }
    }
    pub fn label(self) -> &'static str {
        match self {
            Self::Claude => "Claude Code",
            Self::Codex => "Codex",
            Self::Jecode => "Jecode",
        }
    }
    fn executable(self) -> &'static str {
        match self {
            Self::Claude => "claude.exe",
            Self::Codex => "codex.exe",
            Self::Jecode => "jecode.exe",
        }
    }
}

/// Finds `<program>.exe` in absolute `PATH` directories, in order.
pub fn locate(program: Program, path: Option<&OsStr>) -> Option<PathBuf> {
    let path = path?;
    env::split_paths(path)
        .take(PATH_ENTRY_LIMIT)
        .filter(|directory| directory.is_absolute())
        .map(|directory| directory.join(program.executable()))
        .find(|candidate| candidate.is_file())
}

/// True when `shell` starts Windows PowerShell, the only base shell that
/// can host an optional program and return to its prompt afterwards.
pub fn hosts_programs(shell: &str) -> bool {
    let program = shell.split_whitespace().next().unwrap_or_default();
    let name = program.trim_matches('"').rsplit(['\\', '/']).next();
    name.is_some_and(|name| name.eq_ignore_ascii_case("powershell.exe"))
}

/// Builds `shell -NoExit -Command "& '<exe>' '<arg>'…"`. Every value is a
/// PowerShell single-quoted literal, so no client text reaches the parser.
pub fn launch_command(shell: &str, exe: &Path, args: &[String]) -> Result<String, String> {
    if !hosts_programs(shell) {
        return Err("Programs need the default Windows PowerShell base shell".into());
    }
    let mut script = format!("& {}", literal(&exe.to_string_lossy())?);
    for arg in args {
        script.push(' ');
        script.push_str(&literal(arg)?);
    }
    Ok(format!("{shell} -NoExit -Command \"{script}\""))
}

fn literal(value: &str) -> Result<String, String> {
    if value.contains(['"', '\0', '\r', '\n']) {
        return Err("Program arguments cannot contain quotes or line breaks".into());
    }
    Ok(format!("'{}'", value.replace('\'', "''")))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn launch_commands_quote_every_value_as_a_literal() {
        let shell = "powershell.exe -NoLogo -NoProfile";
        let command = launch_command(
            shell,
            Path::new(r"C:\Users\O'Neil\bin\claude.exe"),
            &["--settings".into(), r"C:\Temp\a b\s1.json".into()],
        )
        .unwrap();
        assert_eq!(
            command,
            r#"powershell.exe -NoLogo -NoProfile -NoExit -Command "& 'C:\Users\O''Neil\bin\claude.exe' '--settings' 'C:\Temp\a b\s1.json'""#
        );
        assert!(launch_command(shell, Path::new("x.exe"), &["a\"b".into()]).is_err());
        assert!(launch_command("cmd.exe /k", Path::new("x.exe"), &[]).is_err());
        assert!(hosts_programs(
            r#""C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe" -NoLogo"#
        ));
    }

    #[test]
    fn lookup_uses_absolute_path_entries_only() {
        let root = env::temp_dir().join(format!("webterminal-programs-{}", std::process::id()));
        let bin = root.join("bin");
        fs::create_dir_all(&bin).unwrap();
        fs::write(bin.join("codex.exe"), b"").unwrap();
        let path = env::join_paths([PathBuf::from("relative"), bin.clone()]).unwrap();
        assert_eq!(
            locate(Program::Codex, Some(&path)),
            Some(bin.join("codex.exe"))
        );
        assert_eq!(locate(Program::Claude, Some(&path)), None);
        assert_eq!(locate(Program::Codex, None), None);
        assert_eq!(Program::parse("jecode"), Some(Program::Jecode));
        assert_eq!(Program::parse("cmd"), None);
        fs::remove_dir_all(root).unwrap();
    }
}
