//! Owned, bounded VT-style text terminal core. No native or browser dependency.
mod appearance;
mod cells;
mod charset;
mod json;
mod ops;
mod palette;
mod queries;
mod render;
mod screen;
mod unicode;
mod updates;

pub use palette::TerminalPalette;
pub use palette::palettes_json;
pub use screen::HISTORY_LIMIT;
pub use updates::SnapshotBaseline;

use screen::{Screen, Style};

const MAX_CONTROL: usize = 4096;
const MAX_COLS: usize = 300;
const MAX_ROWS: usize = 120;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Event {
    Bell,
    Clipboard(String),
}

#[derive(Clone, Debug)]
pub struct Modes {
    pub app_cursor: bool,
    pub app_keypad: bool,
    pub bracketed_paste: bool,
    pub mouse: u16,
    pub mouse_sgr: bool,
    pub focus: bool,
    pub win32: bool,
    pub insert: bool,
    pub origin: bool,
    pub wrap: bool,
}
impl Default for Modes {
    fn default() -> Self {
        Self {
            app_cursor: false,
            app_keypad: false,
            bracketed_paste: false,
            mouse: 0,
            mouse_sgr: false,
            focus: false,
            win32: false,
            insert: false,
            origin: false,
            wrap: true,
        }
    }
}

#[derive(Clone, Default)]
enum ParseState {
    #[default]
    Ground,
    Escape,
    EscapeIgnore,
    EscapeCharset(bool),
    Csi(Vec<u8>),
    CsiIgnore,
    Osc(Vec<u8>, bool),
    Dcs(Vec<u8>, bool),
    IgnoreString(usize, bool),
}

#[derive(Clone)]
pub struct Terminal {
    pub(crate) cols: usize,
    pub(crate) rows: usize,
    pub(crate) primary: Screen,
    alternate_screen: Screen,
    pub(crate) alternate: bool,
    pub(crate) modes: Modes,
    pub(crate) title: String,
    pub(crate) cursor_visible: bool,
    pub(crate) cursor_shape: String,
    style: Style,
    saved_style: Style,
    tabs: Vec<bool>,
    state: ParseState,
    utf8: Vec<u8>,
    events: Vec<Event>,
    synchronized: bool,
    sync_bytes: usize,
    last_printed: bool,
    last_ascii: bool,
    g0_dec: bool,
    g1_dec: bool,
    shift_g1: bool,
    saved_charset: (bool, bool, bool),
    palette: TerminalPalette,
}

/// Immutable point-in-time terminal state for serialization after releasing
/// the session lock. Cell vectors are shared until the live terminal writes.
pub struct TerminalProjection(Terminal);

impl TerminalProjection {
    pub fn snapshot_json(&self) -> String {
        self.0.snapshot_json()
    }
    pub fn snapshot_update(&self, baseline: &mut SnapshotBaseline) -> String {
        self.0.snapshot_update(baseline)
    }
}

impl Terminal {
    pub fn projection(&self) -> TerminalProjection {
        TerminalProjection(self.clone())
    }
    pub fn new(cols: usize, rows: usize) -> Self {
        let cols = cols.clamp(1, MAX_COLS);
        let rows = rows.clamp(1, MAX_ROWS);
        Self {
            cols,
            rows,
            primary: Screen::new(cols, rows),
            alternate_screen: Screen::new(cols, rows),
            alternate: false,
            modes: Modes::default(),
            title: String::new(),
            cursor_visible: true,
            cursor_shape: "block".into(),
            style: Style::default(),
            saved_style: Style::default(),
            tabs: (0..cols).map(|x| x % 8 == 0).collect(),
            state: ParseState::Ground,
            utf8: Vec::new(),
            events: Vec::new(),
            synchronized: false,
            sync_bytes: 0,
            last_printed: false,
            last_ascii: false,
            g0_dec: false,
            g1_dec: false,
            shift_g1: false,
            saved_charset: (false, false, false),
            palette: TerminalPalette::DARK,
        }
    }
    pub(crate) fn active(&self) -> &Screen {
        if self.alternate {
            &self.alternate_screen
        } else {
            &self.primary
        }
    }
    fn active_mut(&mut self) -> &mut Screen {
        if self.alternate {
            &mut self.alternate_screen
        } else {
            &mut self.primary
        }
    }
    pub fn snapshot_json(&self) -> String {
        json::snapshot(self)
    }
    pub fn snapshot_update(&self, baseline: &mut SnapshotBaseline) -> String {
        updates::snapshot(self, baseline)
    }
    pub fn title(&self) -> &str {
        &self.title
    }
    /// Colors reported by OSC 10/11; the browser owns rendering of defaults.
    pub fn set_theme_colors(&mut self, fg: [u8; 3], bg: [u8; 3]) {
        self.palette.foreground = fg;
        self.palette.background = bg;
    }
    /// Sets default and ANSI 0..15 colors reported to terminal programs.
    pub fn set_palette(&mut self, palette: TerminalPalette) {
        self.palette = palette;
    }
    pub fn synchronized(&self) -> bool {
        self.synchronized
    }
    pub fn expire_sync(&mut self) {
        self.synchronized = false;
        self.sync_bytes = 0;
    }
    pub fn take_events(&mut self) -> Vec<Event> {
        std::mem::take(&mut self.events)
    }
    pub fn resize(&mut self, cols: usize, rows: usize) {
        let cols = cols.clamp(1, MAX_COLS);
        let rows = rows.clamp(1, MAX_ROWS);
        if self.cols == cols && self.rows == rows {
            return;
        }
        self.primary.resize_primary(cols, rows);
        self.alternate_screen.resize_simple(cols, rows);
        let old_tab_count = self.tabs.len();
        self.tabs.resize_with(cols, || false);
        for i in old_tab_count..cols {
            if i % 8 == 0 {
                self.tabs[i] = true;
            }
        }
        self.cols = cols;
        self.rows = rows;
        self.last_printed = false;
    }
    pub fn feed(&mut self, bytes: &[u8]) -> Vec<u8> {
        let mut response = Vec::new();
        for &b in bytes {
            if self.synchronized {
                self.sync_bytes += 1;
                if self.sync_bytes > 1_000_000 {
                    self.expire_sync();
                }
            }
            self.byte(b, &mut response);
        }
        response
    }
    fn byte(&mut self, b: u8, response: &mut Vec<u8>) {
        let state = std::mem::take(&mut self.state);
        let graphic = matches!(&state, ParseState::Ground) && b >= 0x20 && b != 0x7f;
        self.state = match state {
            ParseState::Ground => match b {
                0x1b => {
                    self.flush_utf8();
                    ParseState::Escape
                }
                0x07 => {
                    self.flush_utf8();
                    self.events.push(Event::Bell);
                    ParseState::Ground
                }
                0x08 => {
                    self.flush_utf8();
                    let s = self.active_mut();
                    s.x = s.x.saturating_sub(1);
                    s.wrap_pending = false;
                    ParseState::Ground
                }
                0x09 => {
                    self.flush_utf8();
                    self.tab();
                    ParseState::Ground
                }
                0x0a..=0x0c => {
                    self.flush_utf8();
                    self.linefeed();
                    ParseState::Ground
                }
                0x0d => {
                    self.flush_utf8();
                    let s = self.active_mut();
                    s.x = 0;
                    s.wrap_pending = false;
                    ParseState::Ground
                }
                0x0e => {
                    self.flush_utf8();
                    self.shift_g1 = true;
                    ParseState::Ground
                }
                0x0f => {
                    self.flush_utf8();
                    self.shift_g1 = false;
                    ParseState::Ground
                }
                0x00..=0x1f | 0x7f => {
                    self.flush_utf8();
                    ParseState::Ground
                }
                _ => {
                    if b.is_ascii()
                        && self.utf8.is_empty()
                        && !(if self.shift_g1 {
                            self.g1_dec
                        } else {
                            self.g0_dec
                        })
                        && (self.last_ascii || !self.last_printed)
                    {
                        self.print_ascii(b);
                    } else {
                        self.print_byte(b);
                    }
                    ParseState::Ground
                }
            },
            ParseState::Escape => match b {
                b'[' => ParseState::Csi(Vec::new()),
                b']' => ParseState::Osc(Vec::new(), false),
                b'P' => ParseState::Dcs(Vec::new(), false),
                b'X' | b'^' | b'_' => ParseState::IgnoreString(0, false),
                b'(' => ParseState::EscapeCharset(false),
                b')' => ParseState::EscapeCharset(true),
                b'*' | b'+' | b'#' | b'%' | b' ' => ParseState::EscapeIgnore,
                b'7' => {
                    self.save_cursor();
                    ParseState::Ground
                }
                b'8' => {
                    self.restore_cursor();
                    ParseState::Ground
                }
                b'D' => {
                    self.linefeed();
                    ParseState::Ground
                }
                b'E' => {
                    self.linefeed();
                    self.active_mut().x = 0;
                    ParseState::Ground
                }
                b'M' => {
                    let cols = self.cols;
                    let erase = self.style.erase();
                    self.active_mut().reverse_index(cols, &erase);
                    ParseState::Ground
                }
                b'H' => {
                    let x = self.active().x;
                    self.tabs[x] = true;
                    ParseState::Ground
                }
                b'=' => {
                    self.modes.app_keypad = true;
                    ParseState::Ground
                }
                b'>' => {
                    self.modes.app_keypad = false;
                    ParseState::Ground
                }
                b'Z' => {
                    response.extend_from_slice(b"\x1b[?1;2c");
                    ParseState::Ground
                }
                b'c' => {
                    let palette = self.palette;
                    *self = Self::new(self.cols, self.rows);
                    self.set_palette(palette);
                    ParseState::Ground
                }
                0x1b => ParseState::Escape,
                _ => ParseState::Ground,
            },
            ParseState::EscapeIgnore => {
                if b == 0x1b {
                    ParseState::Escape
                } else {
                    ParseState::Ground
                }
            }
            ParseState::EscapeCharset(g1) => {
                if b == 0x1b {
                    ParseState::Escape
                } else {
                    if g1 {
                        self.g1_dec = b == b'0';
                    } else {
                        self.g0_dec = b == b'0';
                    }
                    ParseState::Ground
                }
            }
            ParseState::Csi(mut data) => match b {
                0x1b => ParseState::Escape,
                0x18 | 0x1a => ParseState::Ground,
                0x40..=0x7e => {
                    self.csi(&data, b, response);
                    ParseState::Ground
                }
                0x20..=0x3f if data.len() < MAX_CONTROL => {
                    data.push(b);
                    ParseState::Csi(data)
                }
                0x20..=0x3f => ParseState::CsiIgnore,
                _ => ParseState::Ground,
            },
            ParseState::CsiIgnore => match b {
                0x1b => ParseState::Escape,
                0x40..=0x7e | 0x18 | 0x1a => ParseState::Ground,
                _ => ParseState::CsiIgnore,
            },
            ParseState::Osc(mut data, escaped) => {
                if escaped {
                    if b == b'\\' {
                        self.osc(&data, response);
                        ParseState::Ground
                    } else if b == 0x1b {
                        ParseState::Osc(data, true)
                    } else if data.len() + 2 <= MAX_CONTROL {
                        data.push(0x1b);
                        data.push(b);
                        ParseState::Osc(data, false)
                    } else {
                        ParseState::IgnoreString(0, false)
                    }
                } else {
                    match b {
                        0x07 => {
                            self.osc(&data, response);
                            ParseState::Ground
                        }
                        0x1b => ParseState::Osc(data, true),
                        0x18 | 0x1a => ParseState::Ground,
                        _ if data.len() < MAX_CONTROL => {
                            data.push(b);
                            ParseState::Osc(data, false)
                        }
                        _ => ParseState::IgnoreString(0, false),
                    }
                }
            }
            ParseState::IgnoreString(len, escaped) => {
                if (escaped && b == b'\\') || b == 0x07 || b == 0x18 || b == 0x1a {
                    ParseState::Ground
                } else {
                    ParseState::IgnoreString(len.saturating_add(1), b == 0x1b)
                }
            }
            ParseState::Dcs(mut data, escaped) => {
                if escaped && b == b'\\' {
                    self.dcs(&data, response);
                    ParseState::Ground
                } else if b == 0x18 || b == 0x1a {
                    ParseState::Ground
                } else if data.len() < MAX_CONTROL {
                    if escaped {
                        data.push(0x1b);
                    }
                    if b == 0x1b {
                        ParseState::Dcs(data, true)
                    } else {
                        data.push(b);
                        ParseState::Dcs(data, false)
                    }
                } else {
                    ParseState::IgnoreString(0, b == 0x1b)
                }
            }
        };
        if !graphic {
            self.last_printed = false;
            self.last_ascii = false;
        }
    }
    fn linefeed(&mut self) {
        let cols = self.cols;
        let record = !self.alternate;
        let erase = self.style.erase();
        self.active_mut().index(cols, record, &erase);
    }
    fn tab(&mut self) {
        let x = self.active().x;
        let next = ((x + 1)..self.cols)
            .find(|&i| self.tabs[i])
            .unwrap_or(self.cols - 1);
        let s = self.active_mut();
        s.x = next;
        s.wrap_pending = false;
    }
    fn save_cursor(&mut self) {
        let s = self.active_mut();
        s.saved = (s.x, s.y);
        self.saved_style = self.style.clone();
        self.saved_charset = (self.g0_dec, self.g1_dec, self.shift_g1);
    }
    fn restore_cursor(&mut self) {
        let (cols, rows) = (self.cols, self.rows);
        let s = self.active_mut();
        s.x = s.saved.0.min(cols - 1);
        s.y = s.saved.1.min(rows - 1);
        s.wrap_pending = false;
        self.style = self.saved_style.clone();
        (self.g0_dec, self.g1_dec, self.shift_g1) = self.saved_charset;
    }
}

#[cfg(test)]
mod json_tests;
#[cfg(test)]
mod reflow_tests;
#[cfg(test)]
mod tests;
#[cfg(test)]
mod updates_tests;
