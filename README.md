# Webterminal

Webterminal is a local Windows terminal in your browser. A Rust server starts real
PowerShell sessions through ConPTY and keeps the terminal screen and scrollback
in memory. Open several terminals, place them in two groups, and return to a
running session after refreshing or closing the browser tab.

It runs independently of coding agents. If a CLI is installed, launch it from
PowerShell as you would in another terminal.

## Requirements

- Windows 10 version 1809 / Windows Server 2019 or newer, with ConPTY.
- Rust 1.95.0 for `x86_64-pc-windows-gnullvm` (pinned in
  `rust-toolchain.toml`) and LLVM-MinGW with `clang` on `PATH` to build.
- A modern browser. The automated browser checks use Chrome; Edge and Firefox
  have not been manually validated.

Webterminal has no Cargo dependencies, npm packages, or frontend build step.

## Build and run

In PowerShell, from this repository's root:

```powershell
cargo build --locked --offline
cargo run --locked --offline
```

The server prints `Webterminal listening at http://127.0.0.1:4183/` when ready.
Open that address, choose **New terminal** or **+**, select a directory, and
choose **Open terminal**. New terminals run `powershell.exe -NoLogo -NoProfile`;
PowerShell profiles are skipped. For example, type `pwd` to see the selected
directory. Press Ctrl+C in the server console to stop the server and its
sessions.

To choose a different port or starting directory:

```powershell
cargo run --locked --offline -- --port 4185 --cwd .
```

`--cwd` must name an existing directory. The server binds only to `127.0.0.1`;
ports 4173 and 4174 are reserved by this build. An occupied port
produces an error without stopping its owner. `--help` lists all options.

## Using the workbench

- Each terminal has its own process, directory, screen, and scrollback. Multiple
  terminals can use the same directory. Closing a browser tab leaves sessions
  running while the server remains open; **Close terminal** ends the selected
  session and its child processes.
- Split the workbench into two groups, then move or reorder terminal tabs with
  the tab menu, drag and drop, or keyboard commands. Rename a terminal with F2
  or a double-click. Names and order are shared across browser views while the
  server runs; the group layout belongs to each browser tab.
- A second browser view can observe a session. **Take control** transfers its
  keyboard input and terminal size from the current controller. Reconnecting
  restores a screen and history snapshot before input is enabled.
- Drag to select text. Use **Find** or Ctrl+Shift+F to search retained history,
  and Ctrl+Shift+C to copy. Paste uses the browser clipboard; supported
  terminal clipboard writes ask for confirmation.

The server serves only its embedded browser assets, not files from the chosen
working directory. Session content and history are not written to transcripts;
they disappear when the server stops. Browser storage holds font size and
per-tab layout preferences.

## Compatibility and limits

Webterminal supports common VT text-terminal behavior, including alternate screens,
256/RGB colors, Unicode graphemes, bracketed paste, mouse reporting, and
modified Windows keys. It retains at most 1,000 history rows and allows up to
32 sessions and two visible groups. See [terminal behavior](docs/TERMINAL.md)
for precise limits and unsupported sequences.

Native and browser fixtures exercise the terminal, and isolated checks have
opened the Jecode, Codex, and Claude interfaces. Authenticated use, live provider
streaming and tool execution, and long CLI conversations have not been
validated. See [development and verification](docs/DEVELOPMENT.md) for what was
checked and how to run the local test suites. [SPEC.md](SPEC.md) records the
design contract.

## License

Project code is licensed under MIT; see [LICENSE](LICENSE). Unicode property
data is covered by Unicode License v3; see [third-party notices](THIRD_PARTY_NOTICES.md).
