#![cfg(windows)]
use std::process::Command;

fn run(mode: &str) -> String {
    let output = Command::new(env!("CARGO_BIN_EXE_color_fixture"))
        .arg(mode)
        .env("TERM", "dumb")
        .env_remove("COLORTERM")
        .env("TERM_PROGRAM", "noninteractive-fixture-host")
        .env("NO_COLOR", "1")
        .env("CLICOLOR", "0")
        .env("CLICOLOR_FORCE", "0")
        .env("FORCE_COLOR", "0")
        .env("WEBTERMINAL_COLOR_FIXTURE", "owned café 界")
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    String::from_utf8(output.stdout).unwrap()
}

#[test]
fn conpty_advertises_its_colors_independently_of_server_stdio() {
    let text = run("--host");
    assert!(text.contains("COLOR_ENABLED=true"), "{text:?}");
    assert!(text.contains("TERM=xterm-256color"), "{text:?}");
    assert!(text.contains("COLORTERM=truecolor"), "{text:?}");
    assert!(text.contains("TERM_PROGRAM=Webterminal"), "{text:?}");
    assert!(text.contains("FIXTURE_MARKER=owned café 界"), "{text:?}");
    assert!(
        text.contains("INDEXED_RED") && text.contains("\x1b["),
        "{text:?}"
    );
    assert!(text.contains("PARENT_ENV_UNCHANGED"), "{text:?}");
}

#[test]
fn program_can_disable_colors_inside_its_terminal() {
    let text = run("--host-user-no-color");
    assert!(text.contains("COLOR_ENABLED=false"), "{text:?}");
    assert!(text.contains("PLAIN_OUTPUT"), "{text:?}");
    assert!(!text.contains("INDEXED_RED"), "{text:?}");
    assert!(text.contains("PARENT_ENV_UNCHANGED"), "{text:?}");
}
