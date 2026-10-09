use super::{
    Terminal,
    screen::{Cell, Screen},
};

fn params(data: &[u8]) -> (u8, Vec<usize>, u8) {
    let mut bytes = data;
    let private = if matches!(bytes.first(), Some(b'?' | b'>' | b'=')) {
        let c = bytes[0];
        bytes = &bytes[1..];
        c
    } else {
        0
    };
    let intermediate = bytes
        .iter()
        .copied()
        .find(|b| (0x20..=0x2f).contains(b))
        .unwrap_or(0);
    let values = bytes
        .split(|&b| b == b';')
        .take(32)
        .map(|part| {
            part.iter()
                .take_while(|b| b.is_ascii_digit())
                .fold(0usize, |n, b| {
                    n.saturating_mul(10).saturating_add((b - b'0') as usize)
                })
                .min(100_000)
        })
        .collect();
    (private, values, intermediate)
}
fn at(v: &[usize], i: usize, default: usize) -> usize {
    v.get(i).copied().filter(|&n| n != 0).unwrap_or(default)
}
pub(super) fn color(index: usize) -> String {
    const BASE: [&str; 16] = [
        "#000000", "#cd3131", "#0dbc79", "#e5e510", "#2472c8", "#bc3fbc", "#11a8cd", "#e5e5e5",
        "#666666", "#f14c4c", "#23d18b", "#f5f543", "#3b8eea", "#d670d6", "#29b8db", "#ffffff",
    ];
    if index < 16 {
        return BASE[index].into();
    }
    if index < 232 {
        let n = index - 16;
        let value = |v| if v == 0 { 0 } else { 55 + v * 40 };
        return format!(
            "#{:02x}{:02x}{:02x}",
            value(n / 36),
            value((n / 6) % 6),
            value(n % 6)
        );
    }
    let gray = 8 + (index.min(255) - 232) * 10;
    format!("#{gray:02x}{gray:02x}{gray:02x}")
}

impl Terminal {
    pub(super) fn csi(&mut self, data: &[u8], final_byte: u8, response: &mut Vec<u8>) {
        let (private, p, intermediate) = params(data);
        let n = at(&p, 0, 1).min(self.rows.max(self.cols));
        let cols = self.cols;
        let rows = self.rows;
        if private == 0 && intermediate == b'!' && final_byte == b'p' {
            self.soft_reset();
            return;
        }
        if private == 0 && intermediate == 0 && final_byte == b'm' {
            self.sgr_bytes(data);
            return;
        }
        if private == b'?' && intermediate == b'$' && final_byte == b'p' {
            let mode = p.first().copied().unwrap_or(0);
            let state = match mode {
                1 => Some(self.modes.app_cursor),
                6 => Some(self.modes.origin),
                7 => Some(self.modes.wrap),
                25 => Some(self.cursor_visible),
                47 | 1047 | 1049 => Some(self.alternate),
                1000 | 1002 | 1003 => Some(self.modes.mouse == mode as u16),
                1004 => Some(self.modes.focus),
                1006 => Some(self.modes.mouse_sgr),
                2004 => Some(self.modes.bracketed_paste),
                2026 => Some(self.synchronized),
                9001 => Some(self.modes.win32),
                _ => None,
            };
            response.extend_from_slice(
                format!(
                    "\x1b[?{};{}$y",
                    mode,
                    state.map_or(0, |on| if on { 1 } else { 2 })
                )
                .as_bytes(),
            );
            return;
        }
        if intermediate == b' ' && final_byte == b'q' {
            self.cursor_shape = match p.first().copied().unwrap_or(0) {
                3 | 4 => "underline",
                5 | 6 => "bar",
                _ => "block",
            }
            .into();
            return;
        }
        if intermediate != 0 {
            return;
        }
        match (private, final_byte) {
            (0, b'A') => {
                let s = self.active_mut();
                s.y = s.y.saturating_sub(n).max(s.top);
                s.wrap_pending = false;
            }
            (0, b'B') => {
                let s = self.active_mut();
                s.y = (s.y + n).min(s.bottom);
                s.wrap_pending = false;
            }
            (0, b'C') => {
                let s = self.active_mut();
                s.x = (s.x + n).min(cols - 1);
                s.wrap_pending = false;
            }
            (0, b'D') => {
                let s = self.active_mut();
                s.x = s.x.saturating_sub(n);
                s.wrap_pending = false;
            }
            (0, b'E') => {
                let s = self.active_mut();
                s.y = (s.y + n).min(s.bottom);
                s.x = 0;
                s.wrap_pending = false;
            }
            (0, b'F') => {
                let s = self.active_mut();
                s.y = s.y.saturating_sub(n).max(s.top);
                s.x = 0;
                s.wrap_pending = false;
            }
            (0, b'G' | b'`') => {
                let s = self.active_mut();
                s.x = n.saturating_sub(1).min(cols - 1);
                s.wrap_pending = false;
            }
            (0, b'd') => {
                let y = n.saturating_sub(1).min(rows - 1);
                let s = self.active_mut();
                s.y = y;
                s.wrap_pending = false;
            }
            (0, b'H' | b'f') => {
                let origin = self.modes.origin;
                let s = self.active_mut();
                let base = if origin { s.top } else { 0 };
                s.y = (base + at(&p, 0, 1) - 1).min(if origin { s.bottom } else { rows - 1 });
                s.x = (at(&p, 1, 1) - 1).min(cols - 1);
                s.wrap_pending = false;
            }
            (0, b'I') => {
                for _ in 0..n {
                    self.tab();
                }
            }
            (0, b'Z') => {
                for _ in 0..n {
                    let x = self.active().x;
                    let prior = (0..x).rev().find(|&i| self.tabs[i]).unwrap_or(0);
                    self.active_mut().x = prior;
                }
            }
            (0, b'J') => self.erase_display(p.first().copied().unwrap_or(0)),
            (0, b'K') => self.erase_line(p.first().copied().unwrap_or(0)),
            (0, b'X') => {
                let (x, y) = (self.active().x, self.active().y);
                let style = self.style.erase();
                self.active_mut()
                    .erase_range(y, x, (x + n).min(cols), &style);
            }
            (0, b'@') => {
                let style = self.style.erase();
                let s = self.active_mut();
                let line = &mut s.lines[s.y];
                for _ in 0..n.min(cols - s.x) {
                    line.cells.insert(s.x, Cell::blank(&style));
                    line.cells.pop();
                }
                line.repair();
                s.wrap_pending = false;
            }
            (0, b'P') => {
                let style = self.style.erase();
                let s = self.active_mut();
                let line = &mut s.lines[s.y];
                for _ in 0..n.min(cols - s.x) {
                    line.cells.remove(s.x);
                    line.cells.push(Cell::blank(&style));
                }
                line.repair();
                s.wrap_pending = false;
            }
            (0, b'L') => {
                let erase = self.style.erase();
                let s = self.active_mut();
                if s.y >= s.top && s.y <= s.bottom {
                    s.scroll_down(s.y, s.bottom, n, cols, &erase);
                }
            }
            (0, b'M') => {
                let record = false;
                let erase = self.style.erase();
                let s = self.active_mut();
                if s.y >= s.top && s.y <= s.bottom {
                    s.scroll_up(s.y, s.bottom, n, cols, record, &erase);
                }
            }
            (0, b'S') => {
                let record = !self.alternate;
                let erase = self.style.erase();
                let s = self.active_mut();
                s.scroll_up(s.top, s.bottom, n, cols, record, &erase);
            }
            (0, b'T') => {
                let erase = self.style.erase();
                let s = self.active_mut();
                s.scroll_down(s.top, s.bottom, n, cols, &erase);
            }
            (0, b'r') => {
                let top = at(&p, 0, 1).saturating_sub(1).min(rows - 1);
                let bottom = at(&p, 1, rows).saturating_sub(1).min(rows - 1);
                if top < bottom {
                    let s = self.active_mut();
                    s.top = top;
                    s.bottom = bottom;
                    s.x = 0;
                    s.y = 0;
                    s.wrap_pending = false;
                }
            }
            (0, b'g') => {
                if p.first().copied().unwrap_or(0) == 3 {
                    self.tabs.fill(false);
                } else {
                    let x = self.active().x;
                    self.tabs[x] = false;
                }
            }
            (0, b's') => self.save_cursor(),
            (0, b'u') => self.restore_cursor(),
            (0, b'h' | b'l') if p.contains(&4) => self.modes.insert = final_byte == b'h',
            (b'?', b'h' | b'l') => self.dec_modes(&p, final_byte == b'h'),
            (0, b'n') => match p.first().copied().unwrap_or(0) {
                5 => response.extend_from_slice(b"\x1b[0n"),
                6 => self.cursor_report(response, false),
                _ => {}
            },
            (b'?', b'n') if p.first().copied() == Some(6) => self.cursor_report(response, true),
            (0, b'c') if p.first().copied().unwrap_or(0) == 0 => {
                response.extend_from_slice(b"\x1b[?1;2c")
            }
            (b'>', b'c') => response.extend_from_slice(b"\x1b[>0;0;0c"),
            (0, b't') if p.first().copied() == Some(18) => {
                response.extend_from_slice(format!("\x1b[8;{};{}t", rows, cols).as_bytes())
            }
            (0, b't') if p.first().copied() == Some(19) => {
                response.extend_from_slice(format!("\x1b[9;{};{}t", rows, cols).as_bytes())
            }
            (0, b't') if p.first().copied() == Some(21) => {
                response.extend_from_slice(b"\x1b]l");
                response.extend_from_slice(self.title.as_bytes());
                response.extend_from_slice(b"\x1b\\");
            }
            _ => {}
        }
    }
    fn cursor_report(&self, response: &mut Vec<u8>, private: bool) {
        let s = self.active();
        let row = if self.modes.origin {
            s.y - s.top + 1
        } else {
            s.y + 1
        };
        response.extend_from_slice(
            format!(
                "\x1b[{}{};{}R",
                if private { "?" } else { "" },
                row,
                s.x + 1
            )
            .as_bytes(),
        );
    }
    fn erase_line(&mut self, mode: usize) {
        let (x, y) = (self.active().x, self.active().y);
        let (start, end) = match mode {
            0 => (x, self.cols),
            1 => (0, x + 1),
            2 => (0, self.cols),
            _ => return,
        };
        let style = self.style.erase();
        self.active_mut().erase_range(y, start, end, &style);
    }
    fn erase_display(&mut self, mode: usize) {
        if mode == 3 {
            self.primary.clear_history();
            return;
        }
        let (x, y) = (self.active().x, self.active().y);
        let style = self.style.erase();
        let cols = self.cols;
        let s = self.active_mut();
        for row in 0..s.lines.len() {
            let range = match mode {
                0 if row > y => Some((0, cols)),
                0 if row == y => Some((x, cols)),
                1 if row < y => Some((0, cols)),
                1 if row == y => Some((0, x + 1)),
                2 => Some((0, cols)),
                _ => None,
            };
            if let Some((a, b)) = range {
                s.erase_range(row, a, b, &style);
            }
        }
    }
    fn dec_modes(&mut self, p: &[usize], set: bool) {
        for &mode in p {
            match mode {
                1 => self.modes.app_cursor = set,
                6 => {
                    self.modes.origin = set;
                    let s = self.active_mut();
                    s.x = 0;
                    s.y = if set { s.top } else { 0 };
                }
                7 => self.modes.wrap = set,
                25 => self.cursor_visible = set,
                47 | 1047 => self.switch_alt(set, false),
                1049 => self.switch_alt(set, true),
                1000 | 1002 | 1003 => {
                    if set {
                        self.modes.mouse = mode as u16;
                    } else if self.modes.mouse == mode as u16 {
                        self.modes.mouse = 0;
                    }
                }
                1004 => self.modes.focus = set,
                1006 => self.modes.mouse_sgr = set,
                2004 => self.modes.bracketed_paste = set,
                2026 => {
                    self.synchronized = set;
                    self.sync_bytes = 0;
                }
                9001 => self.modes.win32 = set,
                _ => {}
            }
        }
    }
    fn switch_alt(&mut self, set: bool, save: bool) {
        if set && !self.alternate {
            if save {
                self.save_cursor();
            }
            self.alternate_screen = Screen::new(self.cols, self.rows);
            self.alternate = true;
        } else if !set && self.alternate {
            self.alternate = false;
            if save {
                self.restore_cursor();
            }
        }
    }
}
