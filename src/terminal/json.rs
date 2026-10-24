use super::{
    Terminal,
    screen::{Cell, Color, Line},
};
use std::fmt::Write;

pub(super) trait JsonOut: Write {
    fn push(&mut self, c: char) {
        self.write_char(c).expect("JSON sink");
    }
    fn push_str(&mut self, s: &str) {
        self.write_str(s).expect("JSON sink");
    }
}
impl<T: Write> JsonOut for T {}

#[derive(Default)]
struct Count(usize);
impl Write for Count {
    fn write_str(&mut self, s: &str) -> std::fmt::Result {
        self.0 += s.len();
        Ok(())
    }
}

pub(super) fn string(out: &mut impl JsonOut, value: &str) {
    crate::json::write_string(out, value).expect("JSON sink");
}

fn color(out: &mut impl JsonOut, color: Color) {
    match color {
        Color::Default => out.push_str("null"),
        Color::Indexed(index) => {
            let _ = write!(out, "{index}");
        }
        Color::Rgb(r, g, b) => {
            let _ = write!(out, "\"#{r:02x}{g:02x}{b:02x}\"");
        }
    }
}

pub(super) fn line_len(line: &Line) -> usize {
    let mut out = Count::default();
    self::line(&mut out, line);
    out.0
}

fn ascii(cell: &Cell) -> bool {
    cell.width == 1 && cell.text.len() == 1 && (0x20..=0x7e).contains(&cell.text.as_bytes()[0])
}

pub(super) fn line(out: &mut impl JsonOut, line: &Line) {
    let _ = write!(
        out,
        "{{\"rev\":{},\"wrapped\":{},\"runs\":[",
        line.revision, line.wrapped
    );
    let mut index = 0;
    while index < line.cells.len() {
        let style = &line.cells[index].style;
        let simple = ascii(&line.cells[index]);
        let start = index;
        index += 1;
        while index < line.cells.len()
            && line.cells[index].style == *style
            && ascii(&line.cells[index]) == simple
        {
            index += 1;
        }
        if start != 0 {
            out.push(',');
        }
        out.push('[');
        color(out, style.fg);
        out.push(',');
        color(out, style.bg);
        let _ = write!(out, ",{},", style.attrs);
        string(out, &style.link);
        out.push(',');
        if simple {
            out.push('"');
            for cell in &line.cells[start..index] {
                match cell.text.as_bytes()[0] {
                    b'"' => out.push_str("\\\""),
                    b'\\' => out.push_str("\\\\"),
                    c => out.push(c as char),
                }
            }
            out.push('"');
        } else {
            out.push('[');
            for (offset, cell) in line.cells[start..index].iter().enumerate() {
                if offset != 0 {
                    out.push(',');
                }
                out.push('[');
                string(out, &cell.text);
                let _ = write!(out, ",{}]", cell.width);
            }
            out.push(']');
        }
        out.push(']');
    }
    out.push_str("]}");
}

pub(super) fn metadata(t: &Terminal) -> String {
    let mut out = format!(
        "{{\"cols\":{},\"rows\":{},\"cursor\":[{},{},{},",
        t.cols,
        t.rows,
        t.active().x,
        t.active().y,
        t.cursor_visible
    );
    string(&mut out, &t.cursor_shape);
    out.push_str("],\"title\":");
    string(&mut out, &t.title);
    out.push_str(if t.alternate {
        ",\"alternate\":true"
    } else {
        ",\"alternate\":false"
    });
    let m = &t.modes;
    out.push_str(&format!(",\"modes\":{{\"appCursor\":{},\"appKeypad\":{},\"bracketedPaste\":{},\"mouse\":{},\"mouseSgr\":{},\"focus\":{},\"win32\":{},\"insert\":{},\"origin\":{},\"wrap\":{}}}",
        m.app_cursor, m.app_keypad, m.bracketed_paste, m.mouse, m.mouse_sgr,
        m.focus, m.win32, m.insert, m.origin, m.wrap));
    out
}

pub fn snapshot(t: &Terminal) -> String {
    let mut out = metadata(t);
    out.push_str(",\"history\":[");
    for (i, l) in t.primary.history.iter().enumerate() {
        if i > 0 {
            out.push(',');
        }
        line(&mut out, l);
    }
    out.push_str("],\"screen\":[");
    for (i, l) in t.active().lines.iter().enumerate() {
        if i > 0 {
            out.push(',');
        }
        line(&mut out, l);
    }
    out.push_str("]}");
    out
}
