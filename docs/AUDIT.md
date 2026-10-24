# October 24 audit verification

The supplied audit was checked against revision `a87a4e5` and corrected locally
on Windows with the pinned Rust 1.95.0 toolchain. Estimates of allocations,
megabytes and real CLI throughput in the original report were not measurements.

## Implemented corrections

| Area | Result |
| --- | --- |
| Session publication | Registry lists are cached by structural/title revision. Title-only updates publish at most every 250 ms; structural changes publish immediately on the next transport tick. Unchanged output does not rebuild workspace chrome or resize panes. |
| Snapshot locks | A COW projection captures immutable row cells and matching session metadata under the lock; JSON serialization runs after releasing it. Readers can continue while a view serializes. |
| Lifecycle | Shell creation runs outside the registry lock with reserved capacity and shutdown rechecks. Single close checks busy state atomically with removal. Process exit uses a blocking native wait. |
| Terminal printing | Typed default/indexed/RGB colors remove per-cell color strings. ASCII bypasses Unicode classification; ordinary writes repair only affected cells. Structural editing retains full row repair. |
| History | Wire-size accounting uses the actual serializer with a counting sink, without temporary strings. Existing row, cell and byte limits remain bounded. |
| Wire and cache | Lines carry unique revision IDs and styled runs. ASCII runs carry strings; other runs preserve grapheme text and explicit widths. Browser cache keys use revisions, and search results are cached per immutable row/query. |
| Transport and disk | WebSocket header/payload use vectored writes. Temporary payloads no longer force a disk sync; staging ownership markers remain durable. Static assets revalidate with ETags, while API responses remain uncached. |
| Colors | Rust publishes both palettes in `hello`. Default and ANSI 0–15 colors follow the selected theme in terminals, previews and OSC replies. Explicit RGB and indexed 16–255 stay unchanged. |
| Rendering | Offscreen row painting is deferred with `content-visibility`. Common connecting box/block glyphs paint to cell edges; cell overflow allows accents and fallback glyphs. Search and scrollbars follow the theme. Cursor repaints preserve the blink clock. |
| Input and chrome | IME composition is visible and anchored to the terminal cursor. Unchanged status live-region text is not rewritten. Disabled menu options are skipped by keyboard navigation. |
| Error feedback | Four errors no longer silently evict the first. Repeated errors coalesce, the tray scrolls, and a persistent summary accounts for overflow beyond 64 distinct errors. |
| Folder navigation | The 4096 limit counts directories rather than all entries. Responses expose truncation and skipped unreadable entries; the browser displays both. |
| Protocol safety | CSI `21t` never returns output-controlled titles as program input. Create and attach share safe-integer request validation. |
| Cleanup | Removed unused CLI probes, duplicate native-module compilation, JSON quoting, icon/name/shell/paste helpers and redundant module paths. Fixture binaries and dependent tests require the `fixtures` feature. Server paths share ordinary DOS/UNC conversion. `hello` publishes validation and capacity limits. |

ETag responses retain the representation length on 304 and accept weak/list
validators, following [RFC 9110](https://www.rfc-editor.org/rfc/rfc9110.html#section-8.6).
Visible rows avoid paint containment so glyphs can overflow their line box.
An intersection observer enables painting deferral outside the viewport, where
[CSS paint containment](https://www.w3.org/TR/css-contain-2/#paint-containment)
can safely clip ink.

## Findings that did not justify deletion or a larger rewrite

- `/api/files` is a product contract, and identity/settings/session HTTP routes
  support diagnostics and acceptance checks. Their absence from a particular UI
  path does not make them unused.
- Full-snapshot attachments remain an explicit diagnostic/reference path. The
  embedded browser uses ordered updates; there are no separately shipped legacy
  browser assets.
- Earlier notification settings have a documented migration contract. Rejecting
  the retired per-terminal `profile` field remains useful input validation.
- APIs used by tests, including process identity and shutdown signaling, protect
  native ownership and transport behavior. Non-Windows stubs permit portable core
  checks and explicitly reject unsupported native operations.
- Windows virtual-key encoding retains `keyCode` because the negotiated Win32
  input protocol needs those values. The sibling Unicode-data module still needs
  its explicit path.
- The bounded synchronous socket/accept ticks remain. Revision checks eliminate
  repeated idle list serialization; this change does not claim a notification-only
  server or zero idle wakeups. Browser history still has DOM rows, preserving
  native selection; painting deferral is not full DOM virtualization.

## Comparable browser measurements

`node tests/performance-browser.mjs LABEL` uses an owned ConPTY child and
headless Chrome 155, with a debug build, one pane and the same input stream.
Each workload excludes eight warm-up inputs and records 100 inputs. Baseline
was measured before edits at `a87a4e5`; the final run includes visible-row ink
preservation. Earlier optimized runs confirmed the same payload sizes.

| Workload | Median update bytes, before → after | Median render ms, before → after | Median input-to-paint ms, before → after |
| --- | --- | --- | --- |
| Empty shell | 8335 → 842 | 0.9 → 1.2 | 48.5 → 43.0 |
| Shell with 563 retained history rows | 8337 → 885 | 3.8 → 3.3 | 48.5 → 48.5 |
| Alternate-screen TUI | 8336 → 847 | 1.0 → 1.2 | 48.5 → 54.3 |

Median update payloads fell about 89–90%. The run does not demonstrate a stable
end-to-end latency improvement. Rendering figures vary by workload; these are
fixture results, not production CLI throughput or sustained four-pane load.

## Verification and limits

The production build, formatting, all-feature Clippy, 112 Rust tests with the
fixture feature and 66 JavaScript checks passed. Chrome acceptance covers runtime input
and rendering, reduced motion, terminal reconnect/control, default PowerShell,
colors/reflow, workspaces and workbench flows. New regressions cover COW snapshot
consistency, color identity and replies, disabled title reporting, cursor blink,
IME positioning, directory truncation and ETag responses.

The current commands are in [DEVELOPMENT.md](DEVELOPMENT.md). This task did not
run authenticated Jecode/Codex/Claude sessions, provider streaming, physical IME
candidate windows, screen readers, Edge or Firefox. The CI commands were updated
for the fixture feature; no remote workflow, commit, push or publication was run.
