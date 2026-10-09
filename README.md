# Webterminal

[![CI](https://github.com/giovannijecha/webterminal/actions/workflows/CI.yml/badge.svg)](https://github.com/giovannijecha/webterminal/actions/workflows/CI.yml)

[Contributing](CONTRIBUTING.md) · [Security](SECURITY.md)

Webterminal is a local Windows terminal in your browser. A Rust server starts real
PowerShell sessions through ConPTY and keeps the terminal screen and scrollback
in memory. Open several terminals, organize them in workspaces, and return to a
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
Open that address, choose **Terminal** or **Open terminal**, select a directory, and
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

## Using workspaces

- Workspaces appear as tabs above the terminals. **Workspace** in the left
  rail adds an empty one, named `Workspace N` until you rename it with a
  double-click or F2. A workspace takes its first terminal's folder name when
  it has no custom name.
- **Terminal** opens a terminal in the selected workspace after you pick a
  folder; once a terminal is open it becomes **Split**, and its icon previews
  the next layout: one pane, two side by side, one large plus two stacked, or a
  grid of four. Drag a pane header to reorder panes, or onto another tab to
  move the terminal. Narrow screens show one pane with a switcher.
- Each terminal has its own process, directory, screen, and scrollback.
  Closing a browser tab leaves sessions running while the server remains
  open; closing a terminal ends it and its child processes, and closing a
  workspace closes all of its terminals. Terminals idle at their shell close
  at once; Webterminal asks first only while a program still runs in one. The
  pane dot pulses while an agent reports activity in its title. Names and
  order are shared across browser views while the server runs.
- A second browser view can observe a session. **Take control** transfers its
  keyboard input and terminal size from the current controller. Reconnecting
  restores a screen and history snapshot before input is enabled.
- Drag to select text. Use **Find** or Ctrl+Shift+F to search retained history,
  and Ctrl+Shift+C to copy. Paste uses the browser clipboard; supported
  terminal clipboard writes ask for confirmation.
- Drop files from the desktop onto a terminal you control to paste their
  paths, as native terminals do. Each file is first uploaded to a staging
  folder owned by that terminal under `%TEMP%\webterminal-uploads\`, at most 64
  files of 1 GiB each per drop. Staged copies are removed when the terminal
  closes or the server stops; a later server removes those left by a crash.
  Alt shortcuts such as Alt+V reach the program, while Ctrl+V stays the
  browser paste.
- **Reader** opens a side panel that renders Markdown, for example an agent
  reply copied with `/copy`. Paste with the panel button or Ctrl+V; terminal
  clipboard writes that look like prose are added automatically. With
  **Follow clipboard** on, the Reader checks the system clipboard about once
  a second while the window has focus and opens beside the terminal, without
  taking keyboard focus, when a reply arrives; it skips short single-line
  copies and text Webterminal copied itself. Each document has an
  outline, search and per-block copy. Documents stay in the browser tab's
  memory, at most 20, until reload.

The server serves only its embedded browser assets, not files from the chosen
working directory. Session content and history are not written to transcripts;
they disappear when the server stops. Dropped files are the only session data
written to disk, in the staging folder above. Browser storage holds font size, the
selected workspace and the Follow clipboard choice.

## Compatibility and limits

Webterminal supports common VT text-terminal behavior, including alternate screens,
256/RGB colors, Unicode graphemes, bracketed paste, mouse reporting, and
modified Windows keys. It retains at most 1,000 history rows and allows up to
32 sessions across at most 16 workspaces, with up to four panes per workspace.
See [terminal behavior](docs/TERMINAL.md)
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
