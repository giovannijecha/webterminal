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

GitHub Actions runs the required `Commit attribution` and `Windows checks`
jobs on the maintainer's native Windows runner. Each job uses a fresh checkout;
checks queue while the maintainer's PC is offline. The commands are documented
in [development and verification](docs/DEVELOPMENT.md).

## Build and run

In PowerShell, from this repository's root:

```powershell
cargo build --locked --offline
cargo run --locked --offline
```

The server prints `Webterminal listening at http://127.0.0.1:4183/` when ready.
Open that address and choose **New terminal** (or press N). The launcher asks
for a folder, starting from your configured start folder: type a full path,
pick a recent folder, or choose **Browse** to navigate. It also offers the
workspace and, when installed, Claude Code, Codex or Jecode to start inside
the new PowerShell. Select **Open terminal**, then type `pwd` to check the
working directory. New terminals run `powershell.exe -NoLogo -NoProfile`;
PowerShell profiles are skipped. Press Ctrl+C in the server console to stop
the server and its sessions, or use **Stop server** in the sidebar's server
options menu.

To choose a different port, starting directory or settings file:

```powershell
cargo run --locked --offline -- --port 4185 --cwd . --config C:\temp\settings.json
```

`--cwd` must name an existing directory. The server binds only to `127.0.0.1`.
An occupied port produces an error without stopping its owner. `--help` lists
all options.

## Using Webterminal

The sidebar lists the views and, below them, each workspace with its
terminals; on narrow screens it becomes a drawer. Ctrl+K or / opens search and
commands, and ? lists the keyboard shortcuts.

- **Terminals** shows the selected workspace: one pane, two side by side, one
  large plus two stacked, or a grid of four. Maximize a pane from its header,
  or drag a header to reorder panes or onto a workspace in the sidebar to move
  the terminal. Narrow screens show one pane with a switcher. **New workspace**
  adds an empty one; rename workspaces and terminals from their menus, or a
  terminal by clicking its title.
- Each terminal has its own process, directory, screen, and scrollback.
  Closing a browser tab leaves sessions running while the server remains
  open; closing a terminal ends it and its child processes, and closing a
  workspace closes all of its terminals. Terminals idle at their shell close
  at once; Webterminal asks first only while a program still runs in one.
  Names and order are shared across browser views while the server runs.
- A second browser view can observe a session. **Take control** transfers its
  keyboard input and terminal size from the current controller. Reconnecting
  restores a screen and history snapshot before input is enabled.
- **Overview** lists every terminal with search, filters, sorting and a
  confirmed bulk close.
- **Needs you** collects permission requests and questions reported by Claude
  Code started from the launcher, unread replies, and failed terminals. Codex
  reports completed turns and replies, but not permission requests; check its
  terminal for prompts. Answer Claude Code from the controlling view or in its
  terminal. Ctrl+Shift+A jumps to the next item.
- **Reader** renders Markdown: text you paste, terminal clipboard writes that
  look like prose, and replies reported by Claude Code and Codex. With
  **Follow clipboard** on, it checks the system clipboard about once a second
  while the window has focus, skipping short single-line copies and text
  Webterminal copied itself. Each document has an outline, search and
  per-block copy. Documents stay in the browser tab's memory until reload.
- **Processes** shows the processes running inside each terminal, with
  Interrupt and Close terminal; Webterminal never kills a single process.
- Drag to select text. Use **Find** or Ctrl+Shift+F to search retained history,
  and Ctrl+Shift+C to copy. Paste uses the browser clipboard; supported
  terminal clipboard writes ask for confirmation. Alt shortcuts such as Alt+V
  reach the program, while Ctrl+V stays the browser paste.
- Drop files from the desktop onto a terminal you control to paste their
  paths, as native terminals do. Each file is first uploaded to a staging
  folder owned by that terminal under `%TEMP%\webterminal-uploads\`, at most 64
  files of 1 GiB each per drop. **Dropped files** lists the staged copies with
  progress, Retry, Cancel and Remove. Staged copies are removed when the
  terminal closes or the server stops; a later server removes those left by a
  crash.
- **Settings** holds the start folder, terminal font size, terminal colors and
  notification choices, shared by every view and saved in
  `~/.webterminal/settings.json`; **Themes & Appearance** previews them.
  Notices stay in the Dock until dismissed; browser notifications are
  requested only when you turn them on.

The server serves only its embedded browser assets, not files from the chosen
working directory. Session content and history are not written to transcripts;
they disappear when the server stops. Dropped-file copies and temporary
per-session Claude Code bridge settings are written under `%TEMP%` and removed
when their session ends. The browser keeps recent folders in local storage,
and the selected workspace, collapsed sidebar groups, the Settings tab and
muted terminals only for the tab's session.

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
data is covered by Unicode License v3 and the Nunito font by the SIL Open Font
License 1.1; see [third-party notices](THIRD_PARTY_NOTICES.md).
