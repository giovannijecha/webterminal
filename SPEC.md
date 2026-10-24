# Webterminal contract

## Status and purpose

Product requirements for a local Windows browser terminal. The runtime is
implemented; [README.md](README.md) describes current behavior, while
[development notes](docs/DEVELOPMENT.md) record verification and remaining gaps.

Support interactive Jecode, Codex and Claude without changing their behavior,
handling their authentication or making them dependencies of Webterminal itself.
The initial release aims for a complete modern text-terminal experience.
Additional platforms and graphics protocols are later scope.

## Architecture

Keep one Cargo package with cohesive responsibilities:

- **Native console boundary:** original integration with the Windows
  [ConPTY APIs](https://learn.microsoft.com/en-us/windows/console/creating-a-pseudoconsole-session)
  for process launch, input, output, resize and teardown. Document availability
  and ownership. Keep unsafe operations, if necessary, inside this boundary.
- **Terminal core:** Rust owns incremental decoding, terminal modes, screen
  buffers, cursor, styles, Unicode cell layout and bounded shell scrollback.
- **Session registry:** Rust owns independent session IDs, working directories,
  native resources, lifecycle, viewers, exclusive input/geometry control and
  workspace organization.
- **Transport:** a small local HTTP/WebSocket server serves only owned browser
  assets and exchanges bounded, ordered session updates and input events.
- **Browser:** original HTML/CSS/JavaScript handles layout, rendering, selection,
  search, clipboard interaction and keyboard/composition events.

Keep terminal core independent of native APIs and rendering so protocol
behavior can be verified using original deterministic fixtures. Choose
rendering details from measured behavior; do not add a framework or bundler.

## Sessions and views

- A session has its own ID, working directory, processes, geometry, screen,
  modes and scrollback. A path is not a session ID; multiple sessions may use
  the same directory and run different programs.
- New terminals start Windows PowerShell with `-NoLogo -NoProfile` directly.
  Do not present per-terminal shell choices. A trusted server-wide program
  override can support owned development fixtures.
- The launcher asks for a folder and a destination workspace, then starts that
  PowerShell. Programs such as Claude Code, Codex or Jecode run when the user
  types their command; Webterminal does not discover, launch, configure or
  report on them, and works with none installed.
- Sessions are organized in workspaces. A workspace has an ID, an optional
  user-assigned name and an ordered list of at most four sessions; every
  session belongs to exactly one workspace. Rust owns workspaces, their order,
  membership and pane order, and optional session names. These survive view
  reconnection and are shared by all views while the server runs. At least one
  workspace always exists; a new workspace starts empty.
- Renaming, reordering and moving retain session identity and processes. An
  empty custom name restores the program's dynamic title (sessions) or the
  default label (workspaces).
- A view is a browser attachment to one session. Browser tab closure,
  connection loss or refresh detaches the view without terminating the session.
- The UI is a desktop workbench with a dark interface. A sidebar holds the
  server menu, search, the Overview, Processes and Dropped files pages, the
  workspace list and, in its footer, the connection status and Settings
  (General, Terminal and About tabs). The workspace page shows every session
  of the selected workspace at once, in a layout derived from its count: one
  full pane, two side by side, three as one large and two stacked, four as a
  grid. A pane can be maximized and restored. An unknown page falls back to
  the workspace page. The selected
  view, workspace and focused pane are view-local; each visible attachment
  keeps its own control and geometry fencing, and reading metadata never takes
  control.
- Limits are four sessions per workspace, 16 workspaces and 32 sessions.
- The UI provides a new-workspace action, a new-terminal launcher for the
  selected workspace, a working-directory selector and explicit close actions
  for sessions and workspaces. Overview lists every session with filters,
  search and sorting; a bulk close always asks first and targets exactly the
  confirmed session IDs. Closing a session ends it and its owned process tree;
  closing a workspace closes all of its sessions.
- A session is busy while its owned job contains a process beyond its shell.
  Commands running entirely inside the shell process are not detected by this
  check. Idle sessions, an empty workspace or a workspace of idle sessions
  close at once. Every workspace close names the session IDs the view observed;
  the server checks that set under the same lock as removal, even for idle
  targets. Busy sessions or changed workspace membership require review and
  confirmation of the current targets. Sessions added by another view are never
  closed silently, and Cancel leaves everything running.
  Closing the browser leaves sessions available while the server remains alive.
- A workspace name is optional; new workspaces open with their default label.
- A command palette, scoped menus and a shortcut list expose the same actions.
  None of them intercepts terminal keys while closed.
- Processes lists only processes in Webterminal-owned session jobs, from a
  bounded snapshot. A process search exposes matching descendants with their
  parent context. Its actions are Interrupt terminal, sent through the
  controlling view's input path, Take control, which opens and attaches the
  owning terminal before transferring input and geometry, and Close terminal;
  there is no per-PID kill.
- At most one view controls input and geometry for a session. Other attached
  views observe; control transfer must not allow competing input or resize.
  The server rechecks control when an action runs. Input, interrupt, resize,
  and dropped-file staging and removal belong to the controlling view.
  Creating, renaming, moving, reordering and closing
  terminals or workspaces, saving settings and stopping the server are shared
  by all views and need confirmation of their exact targets where they
  destroy work.
- On attachment or reconnection, deliver a consistent screen, mode and
  history snapshot followed by ordered updates. A slow viewer must not grow
  queues without bound or block console draining.
- Keep browser selection, search and viewport position separate from session
  state. Shell scrollback and application-controlled alternate-screen scrolling
  have distinct behavior.
- Stopping the server tears down only resources and processes it owns. A view
  can stop it only after an explicit confirmation.
  Surviving a server restart is not an initial guarantee.
- Feedback appears as in-page toasts at the bottom right. They never resize a
  terminal, take focus or catch the pointer outside their cards. Successes
  expire after about four seconds and toasts with an action after about eight;
  errors stay until dismissed, and hovering or focusing a toast holds it.
  The tray scrolls beyond three cards, coalesces repeated errors and retains
  64 distinct errors. Any older details replaced at that bound remain accounted
  for in a persistent overflow summary.
  Field validation and save conflicts stay in their forms. Webterminal sends
  no browser or system notifications.

## Network and data boundaries

Use `127.0.0.1:4183` by default, with HTTP and WebSocket on the same port.
Make the port configurable and fail clearly if the requested port is occupied.
The actual bind is the final availability check.

Validate Host and Origin for terminal control. Do not expose arbitrary working
directory content on the terminal origin. Configuration, when needed, belongs
under `~/.webterminal/`; sessions and bounded history initially remain in memory.
Never inspect CLI credentials or change another application's files or processes.

Dropped files use a same-origin `POST /api/upload`. It requires the page's
Origin, the controlling view and its current control epoch, and a Content-Length
of at most 1 GiB. The body streams on its
own connection into a session-owned folder under the system temporary
directory, so terminal I/O continues. Incomplete transfers, and transfers idle
for 30 seconds, leave nothing behind; staging is removed with its session, at
shutdown, or by the next server after a crash. The browser then pastes the
staged paths as quoted, space-separated text. Webterminal does not interpret
the files or depend on the program that receives them.

Staged copies form a bounded registry with server-owned IDs, listed by
`GET /api/files` and removed one copy at a time by ID; originals are never
touched and file bytes are never served. A copy whose control changed during
the transfer is discarded, and a cancelled or late upload never pastes. The
browser shows real progress, Retry for files it still holds and Cancel.

Settings are shared by all views and stored atomically at
`~/.webterminal/settings.json`: start folder for new terminals, terminal font
size and terminal light/dark defaults. Terminal colors never change the dark
interface. A save names
the revision it edits; a save based on an older revision is refused so no
view silently overwrites another. A malformed file falls back to defaults
with a visible problem, and the next save keeps it as `settings.invalid.json`.
The `notifications` object written by earlier versions is ignored without
invalidating the file, and the next save omits it.
A save that cannot be written fails without changing the stored settings.

## Terminal compatibility

Use protocol specifications as references, not copied implementations.
The [xterm control-sequence reference](https://invisible-island.net/xterm/ctlseqs/ctlseqs.html)
defines many of the relevant terminal behaviors. Advertise capabilities only
when implemented; consume unsupported sequences without corrupting visible text.

| Family | Initial compatibility requirement |
| --- | --- |
| Parsing | Incremental UTF-8 and control sequences across arbitrary chunk boundaries; bounded parameters and control strings; recovery after malformed input. |
| Screen | Cursor movement and save/restore, erase, insert/delete, tab stops, wrap modes, scrolling regions, primary and alternate buffers. |
| Appearance | Standard and 256-color palettes, RGB, text attributes, cursor visibility and shape, configurable font size and browser zoom. |
| Unicode | Combining marks, grapheme clusters, emoji and wide characters with a documented cell-width policy and consistent selection. |
| Keyboard | Navigation and function keys, Ctrl/Alt/Shift combinations, application input modes, key repeats and text composition. |
| Paste and clipboard | Bracketed multiline paste, correct newline handling, selection and copy, plus supported terminal clipboard requests within browser capabilities. |
| Mouse and focus | Mouse button, movement and wheel reporting when requested; focus reports; a clear way to select text while applications capture the mouse. |
| Queries and metadata | Appropriate terminal identity, status, cursor and mode responses; title, hyperlinks and size reports. |
| Frame updates | Synchronized output where available, ordered updates and bounded recovery from incomplete synchronization. |
| History and resize | Bounded, searchable shell scrollback, correct wrapping and resize, preserved alternate-screen behavior and stable reconnect snapshots. |

Preserve modified Windows keys such as `Shift+Enter` and `Ctrl+Space`, including
the negotiated [Win32 input mode](https://github.com/microsoft/terminal/blob/main/doc/specs/%234999%20-%20Improved%20keyboard%20handling%20in%20Conpty.md).
A multiline paste keeps its line breaks and never submits: in Win32 input mode
each pasted line feed is sent as the Ctrl+J key it stands for, because ConPTY
would deliver a bare line feed as Ctrl+Enter. Line feeds never become carriage
returns inside a bracketed paste.
Unicode layout needs explicit policy: [grapheme segmentation](https://www.unicode.org/reports/tr29/)
and [East Asian Width](https://www.unicode.org/reports/tr11/) are references,
not a complete ready-made terminal-width implementation.

Some shortcuts remain reserved by the browser or operating system. Optional
fullscreen [Keyboard Lock](https://developer.chrome.com/docs/capabilities/web-apis/keyboard-lock)
may improve capture where supported and permitted. Document demonstrated limits
rather than claiming exact native-terminal equivalence.

## Acceptance evidence

Use isolated directories, owned fixtures and standard-library checks. Do not
send test prompts to live model services or exercise personal credentials
without explicit authorization for that test.

- Start multiple independent sessions, including two in the same directory;
  switching or closing one must not affect another application.
- Verify terminal editing, modified keys, Unicode, multiline paste, selections,
  application menus, mouse interaction and normal CLI exit with the target
  CLIs. Record versions and distinguish fixtures from actual interactive checks.
- Exercise resize, alternate screens and reconnect while output is active.
  Input must not submit twice or reach an unintended session.
- Prove exclusive control across multiple viewers, ordered snapshot/update
  delivery and bounded behavior for slow or disconnected viewers.
- Verify native teardown and ownership on normal exit, session termination
  and server loss without affecting unrelated processes.
- Run concurrently with another local application, and check port collision
  handling and rejection of foreign Host/Origin values on terminal control
  endpoints.
- Check browser behavior in the chosen Windows browsers, including focus,
  composition, clipboard permissions and keyboard interception.

The Cargo checks in [development notes](docs/DEVELOPMENT.md) do not establish
runtime compatibility on their own. Keep the product documentation aligned
with implemented and verified behavior.
