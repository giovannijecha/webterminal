use super::{Terminal, charset, screen::PutOptions, unicode};

// A grapheme can contain arbitrarily many combining code points. Keep the
// terminal cell and its JSON representation bounded; subsequent joined code
// points are consumed without changing the displayed cluster.
pub(super) const MAX_CLUSTER_BYTES: usize = 128;

impl Terminal {
    pub(super) fn flush_utf8(&mut self) {
        if !self.utf8.is_empty() {
            self.utf8.clear();
            self.print_char('\u{fffd}');
        }
    }

    pub(super) fn print_byte(&mut self, b: u8) {
        self.utf8.push(b);
        while let Some(&first) = self.utf8.first() {
            let wanted = match first {
                0..=0x7f => 1,
                0xc2..=0xdf => 2,
                0xe0..=0xef => 3,
                0xf0..=0xf4 => 4,
                _ => 0,
            };
            if wanted == 0 {
                self.utf8.remove(0);
                self.print_char('\u{fffd}');
                continue;
            }
            if let Some(invalid) = self.utf8[1..self.utf8.len().min(wanted)]
                .iter()
                .position(|b| b & 0xc0 != 0x80)
            {
                self.utf8.drain(..invalid + 1);
                self.print_char('\u{fffd}');
                continue;
            }
            if self.utf8.len() < wanted {
                break;
            }
            match std::str::from_utf8(&self.utf8[..wanted]) {
                Ok(s) => {
                    let ch = s.chars().next().unwrap_or('\u{fffd}');
                    self.utf8.drain(..wanted);
                    self.print_char(ch);
                }
                Err(_) => {
                    self.utf8.remove(0);
                    self.print_char('\u{fffd}');
                }
            }
        }
    }

    pub(super) fn print_ascii(&mut self, byte: u8) {
        let options = PutOptions {
            width: 1,
            cols: self.cols,
            wrap: self.modes.wrap,
            insert: self.modes.insert,
            record: !self.alternate,
        };
        let mut buf = [0; 1];
        buf[0] = byte;
        let glyph = std::str::from_utf8(&buf).expect("ASCII byte");
        let style = self.style.clone();
        self.active_mut().put(glyph, &style, options);
        self.last_printed = true;
        self.last_ascii = true;
    }

    pub(super) fn print_char(&mut self, ch: char) {
        let ch = if (if self.shift_g1 {
            self.g1_dec
        } else {
            self.g0_dec
        }) && ch.is_ascii()
        {
            charset::special(ch).unwrap_or(ch)
        } else {
            ch
        };
        if self.last_printed {
            let prior = self.active().last_cluster().map(str::to_owned);
            if let Some(mut prior) = prior
                && unicode::joins(&prior, ch)
            {
                if prior.len() + ch.len_utf8() > MAX_CLUSTER_BYTES {
                    return;
                }
                prior.push(ch);
                let options = PutOptions {
                    width: unicode::width(&prior),
                    cols: self.cols,
                    wrap: self.modes.wrap,
                    insert: self.modes.insert,
                    record: !self.alternate,
                };
                if self.active_mut().append_cluster(ch, options.width, options) {
                    self.last_ascii = false;
                    return;
                }
            }
        }
        let width = unicode::width(&ch.to_string());
        let glyph = if width > self.cols {
            "\u{fffd}".to_owned()
        } else {
            ch.to_string()
        };
        let width = width.min(self.cols);
        let cols = self.cols;
        let wrap = self.modes.wrap;
        let insert = self.modes.insert;
        let style = self.style.clone();
        let record = !self.alternate;
        self.active_mut().put(
            &glyph,
            &style,
            PutOptions {
                width,
                cols,
                wrap,
                insert,
                record,
            },
        );
        self.last_printed = true;
        self.last_ascii = ch.is_ascii();
    }
}
