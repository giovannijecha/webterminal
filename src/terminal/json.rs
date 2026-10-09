use super::{
    Terminal,
    screen::{Cell, Line},
};

pub fn string(out: &mut String, value: &str) {
    out.push('"');
    for ch in value.chars() {
        match ch {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if c < ' ' => out.push_str(&format!("\\u{:04x}", c as u32)),
            c => out.push(c),
        }
    }
    out.push('"');
}

fn string_len(value: &str) -> usize {
    2 + value
        .chars()
        .map(|ch| match ch {
            '"' | '\\' | '\n' | '\r' | '\t' => 2,
            c if c < ' ' => 6,
            c => c.len_utf8(),
        })
        .sum::<usize>()
}

pub(super) fn line_len(l: &Line) -> usize {
    let mut len = if l.wrapped {
        "{\"wrapped\":true,\"cells\":[".len()
    } else {
        "{\"wrapped\":false,\"cells\":[".len()
    } + "]}".len();
    for (i, c) in l.cells.iter().enumerate() {
        len += usize::from(i != 0)
            + 2 // brackets
            + 5 // separators
            + string_len(&c.text)
            + c.width.to_string().len()
            + string_len(&c.style.fg)
            + string_len(&c.style.bg)
            + c.style.attrs.to_string().len()
            + string_len(&c.style.link);
    }
    len
}

fn cell(out: &mut String, c: &Cell) {
    out.push('[');
    string(out, &c.text);
    out.push(',');
    out.push_str(&c.width.to_string());
    out.push(',');
    string(out, &c.style.fg);
    out.push(',');
    string(out, &c.style.bg);
    out.push(',');
    out.push_str(&c.style.attrs.to_string());
    out.push(',');
    string(out, &c.style.link);
    out.push(']');
}

pub(super) fn line(out: &mut String, l: &Line) {
    out.push_str("{\"wrapped\":");
    out.push_str(if l.wrapped { "true" } else { "false" });
    out.push_str(",\"cells\":[");
    for (i, c) in l.cells.iter().enumerate() {
        if i > 0 {
            out.push(',');
        }
        cell(out, c);
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
