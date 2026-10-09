use super::{Terminal, ops::color, screen::Style};

impl Terminal {
    pub(super) fn sgr_bytes(&mut self, data: &[u8]) {
        let mut ordinary = Vec::new();
        for part in data.split(|&b| b == b';') {
            if part.contains(&b':') {
                if !ordinary.is_empty() {
                    self.sgr(&ordinary);
                    ordinary.clear();
                }
                let sub: Vec<usize> = part
                    .split(|&b| b == b':')
                    .take(8)
                    .map(|item| {
                        item.iter()
                            .take_while(|b| b.is_ascii_digit())
                            .fold(0usize, |n, b| {
                                n.saturating_mul(10).saturating_add((b - b'0') as usize)
                            })
                            .min(100_000)
                    })
                    .collect();
                match sub.first().copied().unwrap_or(0) {
                    4 => {
                        if sub.get(1) == Some(&0) {
                            self.style.attrs &= !8;
                        } else {
                            self.style.attrs |= 8;
                        }
                    }
                    code @ (38 | 48) => {
                        let value = match sub.get(1).copied() {
                            Some(5) if sub.len() >= 3 => Some(color(sub[2].min(255))),
                            Some(2) if sub.len() >= 5 => {
                                let rgb = &sub[sub.len() - 3..];
                                Some(format!(
                                    "#{:02x}{:02x}{:02x}",
                                    rgb[0].min(255),
                                    rgb[1].min(255),
                                    rgb[2].min(255)
                                ))
                            }
                            _ => None,
                        };
                        if let Some(value) = value {
                            if code == 38 {
                                self.style.fg = value;
                            } else {
                                self.style.bg = value;
                            }
                        }
                    }
                    code => self.sgr(&[code]),
                }
            } else {
                ordinary.push(
                    part.iter()
                        .take_while(|b| b.is_ascii_digit())
                        .fold(0usize, |n, b| {
                            n.saturating_mul(10).saturating_add((b - b'0') as usize)
                        })
                        .min(100_000),
                );
            }
        }
        if !ordinary.is_empty() {
            self.sgr(&ordinary);
        }
    }
    fn sgr(&mut self, p: &[usize]) {
        let values = if p.is_empty() { &[0][..] } else { p };
        let mut i = 0;
        while i < values.len() {
            match values[i] {
                0 => {
                    let link = std::mem::take(&mut self.style.link);
                    self.style = Style::default();
                    self.style.link = link;
                }
                1 => self.style.attrs |= 1,
                2 => self.style.attrs |= 2,
                3 => self.style.attrs |= 4,
                4 => self.style.attrs |= 8,
                5 | 6 => self.style.attrs |= 16,
                7 => self.style.attrs |= 32,
                8 => self.style.attrs |= 64,
                9 => self.style.attrs |= 128,
                22 => self.style.attrs &= !3,
                23 => self.style.attrs &= !4,
                24 => self.style.attrs &= !8,
                25 => self.style.attrs &= !16,
                27 => self.style.attrs &= !32,
                28 => self.style.attrs &= !64,
                29 => self.style.attrs &= !128,
                30..=37 => self.style.fg = color(values[i] - 30),
                40..=47 => self.style.bg = color(values[i] - 40),
                90..=97 => self.style.fg = color(values[i] - 90 + 8),
                100..=107 => self.style.bg = color(values[i] - 100 + 8),
                39 => self.style.fg = Style::default().fg,
                49 => self.style.bg = Style::default().bg,
                38 | 48 if i + 2 < values.len() => {
                    let foreground = values[i] == 38;
                    let value = if values[i + 1] == 5 {
                        i += 2;
                        Some(color(values[i].min(255)))
                    } else if values[i + 1] == 2 && i + 4 < values.len() {
                        let s = format!(
                            "#{:02x}{:02x}{:02x}",
                            values[i + 2].min(255),
                            values[i + 3].min(255),
                            values[i + 4].min(255)
                        );
                        i += 4;
                        Some(s)
                    } else {
                        None
                    };
                    if let Some(value) = value {
                        if foreground {
                            self.style.fg = value;
                        } else {
                            self.style.bg = value;
                        }
                    }
                }
                _ => {}
            }
            i += 1;
        }
    }
}
