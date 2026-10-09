#![cfg(windows)]

use std::fs;
use std::path::PathBuf;
use std::process::Command;
use std::time::{SystemTime, UNIX_EPOCH};

struct FixtureRoot(PathBuf);
impl FixtureRoot {
    fn new() -> Self {
        let stamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root = std::env::temp_dir().join(format!(
            "webterminal-isolation-{}-{stamp}",
            std::process::id()
        ));
        fs::create_dir(&root).unwrap();
        Self(root)
    }
}
impl Drop for FixtureRoot {
    fn drop(&mut self) {
        let temp = std::env::temp_dir().canonicalize().unwrap();
        let target = self.0.canonicalize().unwrap();
        assert!(target.starts_with(&temp));
        assert!(
            target
                .file_name()
                .unwrap()
                .to_string_lossy()
                .starts_with("webterminal-isolation-")
        );
        fs::remove_dir_all(target).unwrap();
    }
}

#[test]
fn isolated_launcher_replaces_profile_and_drops_dummy_api_keys() {
    let root = FixtureRoot::new();
    let personal = root.0.join("personal-fixture");
    let target = root.0.join("target-profile");
    fs::create_dir(&personal).unwrap();
    fs::create_dir(&target).unwrap();
    let sentinels = [
        ".codex/auth.json",
        ".claude/.credentials.json",
        ".jecode/config.json",
        "AppData/Roaming/fixture-credential.json",
    ];
    for name in sentinels {
        let path = personal.join(name);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(&path, b"owned dummy credential fixture").unwrap();
    }
    let mut command = Command::new(env!("CARGO_BIN_EXE_isolated_cli"));
    command
        .arg(&target)
        .arg(env!("CARGO_BIN_EXE_native_fixture"))
        .arg("--verify-isolation")
        .arg(&target);
    for key in [
        "USERPROFILE",
        "HOME",
        "APPDATA",
        "CODEX_HOME",
        "CLAUDE_CONFIG_DIR",
        "JECODE_HOME",
    ] {
        command.env(key, &personal);
    }
    for key in ["OPENAI_API_KEY", "ANTHROPIC_API_KEY", "OPENROUTER_API_KEY"] {
        command.env(key, "DUMMY_FIXTURE_VALUE");
    }
    command.env("WEBTERMINAL_PARENT_ONLY", "DUMMY_FIXTURE_VALUE");
    let result = command.output().unwrap();
    assert!(
        result.status.success(),
        "isolated launcher or child fixture failed"
    );
    assert_eq!(result.stdout, b"ISOLATION_OK\n");
    assert!(
        result.stderr.is_empty(),
        "isolated fixture wrote unexpected diagnostics"
    );
    for name in sentinels {
        assert!(personal.join(name).is_file());
        assert!(!target.join(name).exists());
    }
}
