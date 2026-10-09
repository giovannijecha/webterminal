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
- The UI shows workspaces as tabs and every session of the selected workspace
  at once, in a layout derived from its count: one full pane, two side by
  side, three as one large and two stacked, four as a grid. Narrow screens show
  one pane at a time with a pane switcher. The selected workspace and focused
  pane are view-local; each visible attachment keeps its own control and
  geometry fencing.
- The UI provides a new-workspace action, a new-terminal action for the
  selected workspace, a working-directory selector and explicit close actions
  for sessions and workspaces. Closing a session ends it and its owned process
  tree; closing a workspace closes all of its sessions. Confirmation is
  required only while a session runs a program beyond its shell. A workspace
  confirmation applies to the sessions present when it was requested; changes
  from another view must be checked before closing any session.
  Closing the browser leaves sessions available while the server remains alive.
- A workspace name is optional; new workspaces open with their default label.
- The Reader is a view-local side panel that renders Markdown copied from
  terminals: pasted text, terminal clipboard writes that look like prose, and,
  when the user enables it, the browser clipboard polled while the view has
  focus. It keeps a bounded set of documents in browser memory only, never on the
  server, and renders text through DOM nodes rather than HTML parsing.
- At most one view controls input and geometry for a session. Other attached
  views observe; control transfer must not allow competing input or resize.
- On attachment or reconnection, deliver a consistent screen, mode and
  history snapshot followed by ordered updates. A slow viewer must not grow
  queues without bound or block console draining.
- Keep browser selection, search and viewport position separate from session
  state. Shell scrollback and application-controlled alternate-screen scrolling
  have distinct behavior.
- Stopping the server tears down only resources and processes it owns.
  Surviving a server restart is not an initial guarantee.

## Network and data boundaries

Use `127.0.0.1:4183` by default, with HTTP and WebSocket on the same port.
Make the port configurable, reserve ports `4173` and `4174` for local
coexistence, and fail clearly if the requested port is occupied. The actual
bind is the final availability check.

Validate Host and Origin for terminal control. Do not expose arbitrary working
directory content on the terminal origin. Configuration, when needed, belongs
under `~/.webterminal/`; sessions and bounded history initially remain in memory.
Never inspect CLI credentials or change another application's files or processes.

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
