use super::{
    Event, Modes, Terminal,
    screen::{Color, Style},
};

fn rgb_reply([r, g, b]: [u8; 3]) -> String {
    format!("rgb:{r:02x}{r:02x}/{g:02x}{g:02x}/{b:02x}{b:02x}")
}

impl Terminal {
    pub(super) fn osc(&mut self, bytes: &[u8], response: &mut Vec<u8>) {
        let Ok(value) = std::str::from_utf8(bytes) else {
            return;
        };
        let Some((command, payload)) = value.split_once(';') else {
            return;
        };
        match command {
            "0" | "2" => self.title = payload.chars().take(512).filter(|&c| c >= ' ').collect(),
            "8" => {
                if let Some((_, url)) = payload.split_once(';') {
                    // A shortened URL may point elsewhere. Reject it whole.
                    let mut link = String::new();
                    for ch in url.chars().filter(|&c| c >= ' ') {
                        if link.len() + ch.len_utf8() > 256 {
                            link.clear();
                            break;
                        }
                        link.push(ch);
                    }
                    self.style.link = link;
                }
            }
            "52" => {
                if let Some((_, data)) = payload.split_once(';')
                    && data != "?"
                    && data.len() <= 3072
                    && data
                        .bytes()
                        .all(|b| b.is_ascii_alphanumeric() || b == b'+' || b == b'/' || b == b'=')
                {
                    self.events.push(Event::Clipboard(data.into()));
                }
            }
            "4" => {
                let mut parts = payload.split(';');
                for _ in 0..32 {
                    let Some(index) = parts.next().and_then(|n| n.parse::<usize>().ok()) else {
                        break;
                    };
                    let Some(spec) = parts.next() else { break };
                    if index < 256 && spec == "?" {
                        response.extend_from_slice(
                            format!(
                                "\x1b]4;{index};{}\x1b\\",
                                rgb_reply(self.palette.indexed(index as u8))
                            )
                            .as_bytes(),
                        );
                    }
                }
            }
            "10" | "11" | "12" if payload == "?" => {
                let rgb = if command == "11" {
                    self.palette.background
                } else {
                    self.palette.foreground
                };
                response.extend_from_slice(
                    format!("\x1b]{command};{}\x1b\\", rgb_reply(rgb)).as_bytes(),
                );
            }
            _ => {}
        }
    }

    pub(super) fn dcs(&self, bytes: &[u8], response: &mut Vec<u8>) {
        let Some(request) = bytes.strip_prefix(b"$q") else {
            return;
        };
        let status = match request {
            b"m" => Some(self.sgr_status()),
            b"r" => {
                let s = self.active();
                Some(format!("{};{}r", s.top + 1, s.bottom + 1))
            }
            b" q" => {
                let shape = match self.cursor_shape.as_str() {
                    "underline" => 4,
                    "bar" => 6,
                    _ => 2,
                };
                Some(format!("{shape} q"))
            }
            _ => None,
        };
        if let Some(status) = status {
            response.extend_from_slice(format!("\x1bP1$r{status}\x1b\\").as_bytes());
        } else {
            response.extend_from_slice(b"\x1bP0$r\x1b\\");
        }
    }

    fn sgr_status(&self) -> String {
        let a = self.style.attrs;
        let mut p = vec!["0".to_owned()];
        for (bit, code) in [
            (1, 1),
            (2, 2),
            (4, 3),
            (8, 4),
            (16, 5),
            (32, 7),
            (64, 8),
            (128, 9),
        ] {
            if a & bit != 0 {
                p.push(code.to_string());
            }
        }
        if self.style.fg != Color::Default {
            p.push(format!(
                "38;2;{}",
                rgb_components(self.style.fg, self.palette)
            ));
        }
        if self.style.bg != Color::Default {
            p.push(format!(
                "48;2;{}",
                rgb_components(self.style.bg, self.palette)
            ));
        }
        format!("{}m", p.join(";"))
    }

    pub(super) fn soft_reset(&mut self) {
        self.modes = Modes::default();
        self.style = Style::default();
        self.saved_style = Style::default();
        self.g0_dec = false;
        self.g1_dec = false;
        self.shift_g1 = false;
        self.saved_charset = (false, false, false);
        self.cursor_visible = true;
        self.cursor_shape = "block".into();
        self.synchronized = false;
        self.sync_bytes = 0;
        self.last_printed = false;
        let rows = self.rows;
        let s = self.active_mut();
        s.x = 0;
        s.y = 0;
        s.saved = (0, 0);
        s.wrap_pending = false;
        s.top = 0;
        s.bottom = rows - 1;
    }
}

fn rgb_components(color: Color, palette: super::TerminalPalette) -> String {
    let [r, g, b] = match color {
        Color::Indexed(index) => palette.indexed(index),
        other => other.rgb(palette.foreground),
    };
    format!("{r};{g};{b}")
}
