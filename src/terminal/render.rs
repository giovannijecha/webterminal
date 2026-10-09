use super::{Terminal, charset, screen::PutOptions, unicode};

// A grapheme can contain arbitrarily many combining code points. Keep the
// terminal cell and its JSON representation bounded; subsequent joined code
// points are consumed without changing the displayed cluster.
pub(super) const MAX_CLUSTER_BYTES: usize = 128;

impl Terminal {
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
    }
}
