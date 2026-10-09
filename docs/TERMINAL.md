# Terminal behavior

Webterminal runs a local HTTP/WebSocket server and renders terminal state owned by
Rust. The browser handles presentation and input; it does not emulate the
terminal screen. Browser assets are embedded in the executable.

## Sessions and views

Each session has a separate ID, working directory, ConPTY process tree, screen,
and history. Two sessions may use the same directory. A browser view attaches
to a session and receives a complete screen, history, and mode snapshot before
ordered updates. A dropped connection or page refresh detaches the view without
ending the session. Closing a terminal from the workbench ends its process tree;
stopping the server ends all sessions.

One view controls a session's input and size at a time. Other views observe
until **Take control** transfers both. Input sequence numbers and control
epochs reject duplicate or stale input after reconnects and tab switches.
Pending browser input is discarded on disconnect or when switching sessions.
Updates are coalesced about every 16 ms. Slow viewers are disconnected rather
than allowed to accumulate unbounded output; they can reconnect for a fresh
snapshot.

Rust owns workspace membership, workspace and pane order, and custom names.
Each workspace shows up to four panes; narrow screens show one at a time with
a pane switcher. Workspace selection is stored per browser tab in
`sessionStorage`; font size and the Reader's Follow clipboard choice use
Webterminal-specific `localStorage` keys. Server state, including workspaces,
custom names and history, does not survive a server restart.

Closing a terminal or workspace asks for confirmation only while a program runs
beyond its shell. Workspace confirmation is checked against the sessions that
were present when the dialog opened; membership changes from another view cannot
silently add new targets to a confirmed close.

The Reader renders copied Markdown through DOM nodes, keeping at most 20
documents of 512 KiB each in browser memory. Terminal clipboard writes that look
like prose become Reader documents automatically; replacing the system clipboard
still requires confirmation. Follow clipboard reads only while enabled and the
view is focused, and skips short single-line copies and text copied by
Webterminal itself. Reader documents disappear on reload.

## Text-terminal coverage

- Incremental UTF-8 and bounded ESC/CSI/OSC/DCS parsing, malformed-input
  recovery, cursor and scrolling operations, tabs, wrapping, primary and
  alternate screens, and shell-history reflow on resize.
- Standard, 256-color, and RGB appearance; text attributes, cursor visibility
  and shape, DEC special graphics, terminal titles, safe OSC 8 hyperlinks,
  status/cursor/mode/size replies, and selected DECRQSS replies.
- Unicode 17.0.0 grapheme segmentation and cell-width policy. East Asian
  Wide/Fullwidth and emoji presentation occupy two cells; ambiguous characters
  occupy one. Combining marks and emoji sequences follow the policy in
  [`unicode.rs`](../src/terminal/unicode.rs). Actual glyph appearance depends on
  installed fonts.
- Application cursor/keypad modes, negotiated Win32 input mode for modified
  Windows keys, bracketed paste, mouse button/motion/wheel reporting, focus
  reporting, and synchronized output with bounded recovery.

Selection, search, and copy operate on the retained history and screen.
Selection freezes the displayed frame while Rust continues to drain the
process output. Ordinary shell paste uses CR for newlines; bracketed paste
uses LF within its delimiters. Hold Shift to select or scroll locally while
an application captures the mouse. OSC 52 clipboard writes require Webterminal
confirmation and browser permission; terminal clipboard reads are unsupported.
A file drop uploads files one at a time and pastes each successful staged path
through the same paste path, separated by spaces. Earlier files remain usable
if a later upload fails. PowerShell receives single-quoted paths with embedded
apostrophes doubled; other server-wide program overrides retain double quotes.
With a `cmd.exe` override, paths containing `%` or `!` are rejected because
CMD may expand them as environment variables.
Alt-modified keys, including Alt+V, are sent to the program; Webterminal never
reads the clipboard for them.

## Bounds

| Resource | Limit |
| --- | --- |
| Sessions / network connections | 32 sessions; 64 concurrent connections |
| Workspaces / panes | 16 workspaces; at most four sessions per workspace |
| Geometry | 2–300 columns; 1–120 rows |
| Shell history | At most 1,000 rows, 100,000 cells, and 3 MiB serialized; oldest rows are discarded |
| Grapheme text | 128 UTF-8 bytes per cell |
| OSC 8 URL | 256 UTF-8 bytes |
| Parser control string | 4,096 bytes |
| Input | 32 queued messages of at most 64 KiB each; browser pending input capped at 1 MiB |
| WebSocket message / snapshot | 128 KiB input messages; terminal state under the 32 MiB snapshot ceiling |
| Output delivery | About 16 ms between coalesced updates; blocked network writes time out after 500 ms |
| Dropped files | 64 per drop, 1 GiB each, uploaded one at a time; a transfer idle for 30 s is abandoned |

Longer control strings and links are discarded. Extra grapheme-joining text
beyond a cell's limit is dropped. Alternate-screen content does not enter shell
history. A terminal that overwhelms the bounded query-response input queue is
terminated rather than blocking its output reader indefinitely.

## Known limits

Classic X10 mouse reports are limited to coordinates 1–95 because higher raw
bytes are corrupted by ConPTY's UTF-8 input; SGR mouse reports cover the full
supported geometry. Raw 8-bit C1 controls, graphics/SIXEL, arbitrary DCS
extensions, bidirectional layout and contextual shaping, and OSC 52 clipboard
reads are unsupported. Some browser or operating-system shortcuts may escape
capture even in fullscreen mode. Keyboard Lock depends on browser support and
permission.

The browser asks for incremental updates. A missing or invalid update base
disables input until a fresh attachment restores the projection. Legacy views
without `updates:true` receive full snapshots. The transport and terminal
implementations are in [`server.rs`](../src/server.rs),
[`session.rs`](../src/session.rs), and [`terminal.rs`](../src/terminal.rs).
