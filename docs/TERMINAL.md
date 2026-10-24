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
Each workspace shows up to four panes at once. Workspace selection is stored
per browser tab in
`sessionStorage`, and recent launcher folders in a Webterminal-specific
`localStorage` key. Font size and terminal colors are server settings in
`~/.webterminal/settings.json`. Server state, including workspaces, custom
names and history, does not survive a server restart.

Closing a terminal or workspace asks for confirmation while a program runs
beyond its shell. The browser first sends a close without confirmation, naming
the session IDs it observed for a workspace. The server closes idle targets
only if that set still matches. Otherwise it answers `busy` with the current
targets and any sessions that still run a program, so the view can review them.
The server checks the target set and removes the workspace under the same lock;
terminals added by another view are never closed silently. A changed set is
reviewed again or refused for a retry, and Cancel leaves all sessions running.

The busy check counts processes in the terminal's owned job. A PowerShell
command running entirely inside the shell process, such as `Start-Sleep`, cannot
be distinguished from an idle shell by this check.

## Text-terminal coverage

- Incremental UTF-8 and bounded ESC/CSI/OSC/DCS parsing, malformed-input
  recovery, cursor and scrolling operations, tabs, wrapping, primary and
  alternate screens, and shell-history reflow on resize. Reflow treats a row's
  trailing blanks of one visible paint as fill: background bands and blank
  colored rows span the new width without adding rows, while default padding
  is dropped.
- Standard, 256-color, and RGB appearance; text attributes, cursor visibility
  and shape, DEC special graphics, terminal titles, safe OSC 8 hyperlinks,
  status/cursor/mode/size replies, and selected DECRQSS replies.
  Default colors and ANSI 0–15 follow the terminal theme, including Settings
  previews and color-query replies. Indexed colors 16–255 and explicit RGB
  retain their values. CSI `21t` title reporting is ignored so output-controlled
  titles cannot be returned as program input.
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

Starting a process in a working directory beyond Windows' `MAX_PATH` limit can
fail even when the folder picker can list that directory. Keep the selected
path within the [process current-directory limit](https://learn.microsoft.com/en-us/windows/win32/api/winbase/nf-winbase-setcurrentdirectory).

Classic X10 mouse reports are limited to coordinates 1–95 because higher raw
bytes are corrupted by ConPTY's UTF-8 input; SGR mouse reports cover the full
supported geometry. Raw 8-bit C1 controls, graphics/SIXEL, arbitrary DCS
extensions, bidirectional layout and contextual shaping, and OSC 52 clipboard
reads are unsupported. Some browser or operating-system shortcuts may escape
capture even in fullscreen mode. Keyboard Lock depends on browser support and
permission.

With inbox conhost 10.0.26100.1 on Windows 11 build 26300, the console host
swallows OSC 10/11 default-color queries: they never reach Webterminal's
output and receive no reply. An OSC 4 palette query does reach Webterminal,
which answers it, but conhost drops OSC replies, whether terminated by ST or
BEL, before the program reads its input; CSI replies pass through. Programs
therefore see no color replies with this inbox conhost. Webterminal cannot
supply these replies through the supported
[CreatePseudoConsole interface](https://learn.microsoft.com/en-us/windows/console/createpseudoconsole)
in that environment; this requires a conhost change or a different console host.
An earlier probe of the same
sequences under Windows Terminal 1.24.12741.0 received color replies. An
isolated Codex 0.163.0 run in Webterminal lacked gray user-message and
composer bands; that these missing replies cause it is likely but unverified.
`cargo test --locked --offline --features fixtures --test native_input observe_color_queries -- --nocapture`
reproduces the observation.

For programs that read console key records, such as Codex 0.163.0, ConPTY
consumes the bracketed-paste delimiters and delivers each pasted LF as
Ctrl+Enter; Codex dropped such a newline at the start of a paste and joined the
lines. Replacing LF with CR could submit a prompt during the paste. In Win32
input mode, Webterminal therefore sends each LF of a bracketed paste as the
Ctrl+J key it stands for: record readers receive a newline key, and VT input
readers still receive LF between the delimiters. The native input tests and
the optional CLI probes check both.
The observed key-event behavior is consistent with
[Windows Terminal's event synthesis](https://github.com/microsoft/terminal/blob/v1.24.12741.0/src/interactivity/base/EventSynthesis.cpp)
and [the Windows input parser pinned by Codex](https://github.com/openai-oss-forks/crossterm/blob/ed1cdab335221515706178d68495bba2aed1924f/src/event/sys/windows/parse.rs).

The browser asks for incremental updates. A missing or invalid update base
disables input until a fresh attachment restores the projection. Diagnostic
attachments without `updates:true` can receive full snapshots; the embedded UI
always uses updates. Both forms carry immutable row revision IDs and style runs:
`[foreground, background, attributes, hyperlink, payload]`. A color is `null`
for a default, an integer for a palette index or a hex RGB string. Payload is
an ASCII string or an array of `[grapheme, width]` pairs. The server captures
shared immutable cells under the session lock and serializes after releasing
it. Session lists are cached by revision; title-only list updates publish at
most four times per second, while structural changes publish on the next tick.
The browser defers offscreen row painting without removing selectable history.
The transport and terminal
implementations are in [`server.rs`](../src/server.rs),
[`session.rs`](../src/session.rs), and [`terminal.rs`](../src/terminal.rs).
