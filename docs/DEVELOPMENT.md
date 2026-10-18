# Development and verification

Webterminal is one Cargo package with no external crates. Rust owns the
terminal, sessions and server; embedded HTML, CSS and JavaScript provide the
browser interface without a frontend build step. The product contract is in
[SPEC.md](../SPEC.md), and supported terminal behavior is in
[TERMINAL.md](TERMINAL.md).

## Build and checks

From the repository root in PowerShell, install Rust 1.95.0 for
`x86_64-pc-windows-gnullvm` and LLVM-MinGW with `clang` on `PATH`.
`rust-toolchain.toml` pins Rust, and `.cargo/config.toml` selects static CRT
linkage. Run:

```powershell
cargo build --locked --offline
cargo fmt --all -- --check
cargo clippy --locked --offline --all-targets -- -D warnings
cargo test --locked --offline
cargo run --locked --offline -- --help
```

The build creates `target/debug/webterminal.exe`; `--help` prints the options
and exits. `--offline` does not install the toolchain or linker. See
[README.md](../README.md) to start the server and open a terminal.

The browser checks use Node.js 24 and an installed Google Chrome. With
the executable and its fixture binaries built, run these from the repository
root in PowerShell:

```powershell
$env:WEBTERMINAL_TEST_BIN_DIR = "$PWD\target\debug"
node --test tests/browser.mjs tests/reader.mjs tests/upload.mjs tests/workbench-flows.mjs
node tests/browser-runtime.mjs
node tests/browser-e2e.mjs
node tests/workbench-browser.mjs
node tests/colors-browser.mjs current
node tests/shells-browser.mjs
node tests/workspace-browser.mjs
```

Each command reports success or exits with an error. The browser probes start
their own server and use disposable Chrome profiles and local fixtures. They
write temporary files under ignored `target/` or `.tmp/`. Set
`WEBTERMINAL_TEST_BIN_DIR` to another directory of matching executables when
testing an isolated build. `WEBTERMINAL_TEST_REDUCED_MOTION=1` makes
`browser-runtime.mjs` also check its reduced-motion cursor behavior.
`node tests/performance-browser.mjs` is an optional local fixture measurement,
not a production CLI benchmark.

Rust tests exercise terminal parsing, rendering state, sessions, ConPTY
ownership, transport, settings, file staging and program-bridge rules. The
JavaScript and Chrome checks exercise browser input and rendering, workspaces,
the launcher, reader, settings, file views and narrow layouts. These checks use
owned fixtures; they do not prove authenticated CLI use.

## Optional installed-CLI probes

The CLI probes require the corresponding installed executables and use
disposable profiles. `tests/cli-api-browser.mjs` gives Codex and Claude Code
fixed responses from an owned loopback API. Jecode probes use local drafts and
commands. Set the executable paths in PowerShell before running a probe:

```powershell
$env:WEBTERMINAL_JECODE_EXE = 'C:\path\to\jecode.exe'
node tests/cli-browser.mjs
node tests/drop-browser.mjs

$env:WEBTERMINAL_CODEX_EXE = 'C:\path\to\codex.exe'
$env:WEBTERMINAL_CLAUDE_EXE = 'C:\path\to\claude.exe'
node tests/cli-api-browser.mjs
```

Replace the sample paths with actual installed executables. Pass `codex` or
`claude` to `cli-api-browser.mjs` to probe just one. For the drop probe, set
`WEBTERMINAL_DROP_FILE_ONLY=1` to check the staged path without sending Alt+V,
or `WEBTERMINAL_DROP_POWERSHELL=1` to launch Jecode inside PowerShell and check
path quoting. These probes do not cover authentication, live provider replies,
tool execution or long conversations.

## Native and local boundaries

The Windows boundary in [native.rs](../src/native.rs) and its submodules uses
ConPTY and Kernel32 for the console and process lifecycle, plus ntdll's
`NtQueryInformationProcess` for parent IDs in process snapshots. Unsafe Rust
stays in that boundary. A child joins a private Windows Job Object before it
resumes; closing its terminal or the server tears down only owned descendants.
Output draining continues without browser viewers. The Processes view reads
only each session's Job Object, with a bounded snapshot of at most 64 process
IDs; it does not enumerate or terminate arbitrary system processes.

The server binds to numeric loopback `127.0.0.1` and serves its embedded assets
and API on one origin. It validates Host and Origin on control requests and
does not serve working-directory files. Session screens and history live in
memory. Shared settings are saved atomically in
`~/.webterminal/settings.json`; the persistent lock serializes revisions
between server processes. An invalid settings file is preserved as
`settings.invalid.json` when a valid replacement is saved.

Dropped files are copied to per-session staging under the system temporary
directory. Uploads require the controlling view and its current control epoch;
closing a session removes its copies. Startup cleanup removes only staging
directories marked and owned by Webterminal. Originals are never modified.

Claude Code receives per-invocation hook settings in a temporary file; Codex
receives a per-invocation `notify` override. The helper posts events through
the token-protected loopback `/api/bridge` endpoint. These adapters do not read
CLI credentials or change either program's own configuration.

The Windows checks recorded on 2026-10-18 used Rust 1.95.0, Node 24.18.0 and
headless Chrome 155. Cargo checks, JavaScript module tests and the listed
browser suites passed with local fixtures, including the reduced-motion run.
Earlier isolated Jecode, Codex and Claude Code probes opened their text
interfaces; authenticated provider sessions remain unverified. Edge, Firefox,
physical IME input and browser clipboard permission prompts have not been
manually validated. Known ConPTY and Codex paste limits are in
[TERMINAL.md](TERMINAL.md).
