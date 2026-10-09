# Development and verification

Webterminal is one Cargo package with no external crates. The runtime is Rust plus
embedded HTML, CSS, and JavaScript; there is no frontend build step. Windows
ConPTY and process ownership are implemented through the documented Kernel32
boundary in [`native.rs`](../src/native.rs) and its submodules. The terminal
parser and session registry are independent of browser rendering.

## Prerequisites and checks

From the repository root in PowerShell, use Rust 1.95.0 for
`x86_64-pc-windows-gnullvm` and LLVM-MinGW (`clang` on `PATH`).
`rust-toolchain.toml` pins the toolchain; `.cargo/config.toml` selects static
CRT linkage. The core checks are:

```powershell
cargo build --locked --offline
cargo fmt --all -- --check
cargo clippy --locked --offline --all-targets -- -D warnings
cargo test --locked --offline
cargo run --locked --offline -- --help
```

The `--help` invocation exits after printing the options. A successful build
produces `target/debug/webterminal.exe`. These checks require an installed pinned
toolchain and linker; `--offline` does not install either one.

Node 24 and Chrome are optional test tools. With a built executable, the
browser and module suites can be run from the repository root:

```powershell
$env:WEBTERMINAL_TEST_BIN_DIR = "$PWD\target\debug"
node --test tests/browser.mjs tests/reader.mjs
node tests/browser-runtime.mjs
node tests/browser-e2e.mjs
node tests/workbench-browser.mjs
node tests/colors-browser.mjs current
node tests/shells-browser.mjs
node tests/workspace-browser.mjs
```

The browser probes create disposable profiles and fixtures under ignored
`target/` or `.tmp/`; they use local processes and do not contact model providers.
`WEBTERMINAL_TEST_BIN_DIR` points at a directory containing matching Webterminal and
fixture executables, which also permits testing an alternate build without
replacing a running server. The optional performance harness is
`tests/performance-browser.mjs`; it measures owned fixtures rather than a
production CLI session.

Optional CLI probes need installed executables. Set `WEBTERMINAL_JECODE_EXE` to
the Jecode executable for `node tests/cli-browser.mjs`. Set both
`WEBTERMINAL_CODEX_EXE` and `WEBTERMINAL_CLAUDE_EXE` for
`node tests/cli-api-browser.mjs`, or pass `codex` or `claude` to probe only
one. These probes use disposable profiles. Codex and Claude receive fixed
responses from an owned loopback API; Jecode uses local drafts and commands.
They do not establish compatibility with authenticated provider sessions.
Do not run them against personal credentials or live providers as an acceptance
shortcut.

## What has been exercised

The 2026-10-09 publication checks passed the Cargo gates and JavaScript module
tests, including regressions for Reader reads canceled by a Follow change or
focus loss, and workspace close confirmations invalidated by another view.
Chrome checks cover shared workspaces with up to four simultaneous panes,
independent input, pane limits, rename/reorder/move, reconnection, the folder
picker, Reader Markdown rendering and mobile layouts. These use owned fixtures;
they do not establish authenticated CLI compatibility.

Earlier Windows checks recorded in the project exercised the Cargo gates,
Rust parser and transport fixtures, native ConPTY lifecycle, PowerShell and
`cmd.exe` sessions, browser rendering and input, and isolated Jecode, Codex,
and Claude interfaces. They used Windows build 10.0.26300, Rust 1.95.0,
Chrome 154.0.8037.93, and Node 24.18.0. Those versions describe the recorded
environment, not a minimum browser or Node requirement for the runtime.

Rust fixtures cover parsing across chunk boundaries, malformed input,
Unicode/graphemes, screen modes, reflow, bounded history, snapshot/update
equivalence, WebSocket framing, session ownership, reconnect and control
transfer, port collisions, and Host/Origin rejection. Native checks cover
ConPTY output, input, resize, modified keys, a large output flood, process
exit, owned descendant cleanup, and an unrelated process left alive.
Earlier Chrome probes exercised the embedded UI with real ConPTY sessions, the
folder picker, the previous two-group layout, selection and copy, search,
clipboard dialogs, menus, reconnect, and mobile-width layouts. Clipboard
permission outcomes in those UI checks were stubbed; synthetic composition
events do not prove hardware IME behavior.

Isolated Jecode, Codex, and Claude checks opened their main text interfaces
and exercised editing, modified keys, multiline drafts, resize, reload, and
normal exit. Codex and Claude also received fixed local streamed replies.
Authenticated use, real provider streaming and tool execution, cancellation
during a provider response, and long conversations remain unverified. One
optional Jecode browser startup failed before its composer and passed on a
diagnostic rerun; its cause remains unknown. Edge/Firefox, physical IME,
browser clipboard permission prompts, and browser-reserved shortcuts have not
been manually validated.

## Performance evidence

One isolated debug-build Chrome/ConPTY probe measured 100 acknowledged inputs
while an owned child redrew 24 TUI rows every 16 ms. After the earlier
PowerShell-only workspace update, median/p95 end-to-end latency was 54.4/73.3 ms,
with 2.7 ms median render work. This is a single-machine fixture measurement, not a
guarantee for multiple live panes or authenticated CLIs. The harness and generated
raw reports live under ignored `target/` when run locally.

## Local boundary

The server binds to numeric loopback `127.0.0.1`, sharing one HTTP/WebSocket
origin. It checks Host and WebSocket Origin, rejects cross-site requests, and
serves only embedded assets with a self-only Content Security Policy. The
directory picker lists directory names but does not serve their files. The
native boundary starts each child suspended, assigns it to a private Windows
Job Object, and resumes it; closing a session or server tears down owned
descendants. Terminal transcripts and server configuration are not persisted.

The design requirements are in [`SPEC.md`](../SPEC.md), and supported terminal
behavior and bounds are in [`TERMINAL.md`](TERMINAL.md).
