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
The normal build includes only the application. Development fixtures and their
integration tests require the `fixtures` Cargo feature; see
[development and verification](docs/DEVELOPMENT.md).

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
pick a recent folder, or choose **Browse** to navigate, and the destination
workspace. Select **Open terminal**, then type `pwd` to check the working
directory; run any installed program by typing its command. **Split** in the
workspace toolbar opens another PowerShell next to the focused terminal, in
its folder or one you choose. New terminals run
`powershell.exe -NoLogo -NoProfile`;
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

Webterminal is a desktop interface with a dark theme. The sidebar holds the
server menu, search, the Overview, Processes and Dropped files pages and the
workspace list; Settings is the gear in its footer, next to the connection
status. Ctrl+K or / opens search and commands, and ? lists the keyboard
shortcuts.

- **Workspaces** open from the sidebar and show their terminals together: one
  pane, two side by side, one large plus two stacked, or a grid of four.
  Maximize a pane from its header, or drag a header to reorder panes or onto a
  workspace in the sidebar to move the terminal. **New workspace** adds an
  empty one; rename workspaces and terminals from their menus, or a terminal
  by clicking its title.
- Each terminal has its own process, directory, screen, and scrollback.
  Closing a browser tab leaves sessions running while the server remains
  open; closing a terminal ends it and its child processes, and closing a
  workspace closes all of its terminals. Terminals idle at their shell, an
  empty workspace and a workspace of idle terminals close at once.
  Webterminal asks first while a program runs beyond its shell, or when a
  workspace's terminals have changed since the view last saw them. It checks
  exact targets before closing; terminals opened meanwhile in another view are
  never closed silently, and Cancel keeps everything running. Commands running
  entirely inside PowerShell are not detected by the busy check; see
  [terminal behavior](docs/TERMINAL.md).
  Names and order are shared across browser views while the server runs.
- A second browser view can observe a session. **Take control** transfers its
  keyboard input and terminal size from the current controller. Reconnecting
  restores a screen and history snapshot before input is enabled.
- **Overview** summarizes terminals, workspaces, running and failed sessions,
  and lists every terminal with search, status filters, sorting and a
  confirmed bulk close.
- **Processes** shows each terminal's process count and, expanded, its process
  tree. Search by process name or PID opens the matching tree with its parent
  context. Interrupt reaches only a terminal you control; **Take control**
  opens the owning terminal and transfers input and size to this view.
  Close terminal stops its owned tree; Webterminal never kills a single process.
- Drag to select text. Use **Find** or Ctrl+Shift+F to search retained history,
  and Ctrl+Shift+C to copy. Paste uses the browser clipboard; supported
  terminal clipboard writes ask for confirmation. Alt shortcuts such as Alt+V
  reach the program, while Ctrl+V stays the browser paste.
- Drop files from the desktop onto a terminal you control to paste their
  paths, as native terminals do. Each file is first uploaded to a staging
  folder owned by that terminal under `%TEMP%\webterminal-uploads\`, at most 64
  files of 1 GiB each per drop. **Dropped files** lists the staged copies with
  progress, Retry, Cancel and Remove, and shows the selected copy's details
  beside the list. Staged copies are removed when the
  terminal closes or the server stops; a later server removes those left by a
  crash.
- **Settings** has General (starting folder, address, shell, settings file),
  Terminal (font size and Dark or Light terminal colors, with a live preview)
  and About tabs. Settings are shared by every view and saved in
  `~/.webterminal/settings.json`. Terminal colors never change the dark
  interface. Notification choices saved by earlier versions are ignored and
  dropped on the next save.
- Results appear as toasts at the bottom right. Successes disappear after
  about four seconds, errors stay until you close them, and pointing at or
  focusing a toast keeps it open; Escape closes the focused one. Toasts never
  take focus from the terminal or cover anything outside their cards.
  Repeated errors share a counter. The tray scrolls after three cards and
  retains 64 distinct errors; further errors leave a visible summary of older
  details that were replaced.
  Webterminal shows no browser or system notifications.

The server serves only its embedded browser assets, not files from the chosen
working directory. Session content and history are not written to transcripts;
they disappear when the server stops. Dropped-file copies are written under
`%TEMP%` and removed when their session ends. The browser keeps recent folders
in local storage, and the selected workspace and the Settings tab only for the
tab's session.

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
