use super::{Terminal, TerminalPalette, palettes_json};
use crate::json::{self, Value};

#[test]
fn compact_runs_preserve_color_kind_widths_and_json_escapes() {
    let mut t = Terminal::new(12, 2);
    t.feed("ab\"\\\x1b[31mR\x1b[38;5;196mI\x1b[38;2;1;2;3m中".as_bytes());
    let snapshot = json::parse(&t.snapshot_json()).unwrap();
    let Value::Array(lines) = snapshot.get("screen").unwrap() else {
        panic!()
    };
    let line = &lines[0];
    assert!(line.integer("rev").unwrap() > 0);
    let Value::Array(runs) = line.get("runs").unwrap() else {
        panic!()
    };
    let Value::Array(default) = &runs[0] else {
        panic!()
    };
    assert_eq!(default[0], Value::Null);
    assert_eq!(default[4], Value::String("ab\"\\".into()));
    let Value::Array(indexed) = &runs[1] else {
        panic!()
    };
    assert_eq!(indexed[0], Value::Number(1));
    let Value::Array(rgb) = &runs[3] else {
        panic!()
    };
    assert_eq!(rgb[0], Value::String("#010203".into()));
    let Value::Array(wide) = &rgb[4] else {
        panic!()
    };
    assert_eq!(wide.len(), 2);
    assert_eq!(
        wide[0],
        Value::Array(vec![Value::String("中".into()), Value::Number(2)])
    );
    assert_eq!(
        wide[1],
        Value::Array(vec![Value::String("".into()), Value::Number(0)])
    );
}

#[test]
fn theme_queries_survive_reset_and_title_is_not_reflected() {
    let mut t = Terminal::new(10, 2);
    t.set_theme_colors([1, 2, 3], [250, 251, 252]);
    t.feed(b"\x1b]2;safe\x1b[31m\x1b[2J\x07");
    assert!(t.feed(b"\x1b[21t").is_empty());
    assert_eq!(
        t.feed(b"\x1b]10;?\x07\x1b]11;?\x07"),
        b"\x1b]10;rgb:0101/0202/0303\x1b\\\x1b]11;rgb:fafa/fbfb/fcfc\x1b\\"
    );
    t.feed(b"\x1bc");
    assert_eq!(
        t.feed(b"\x1b]11;?\x07"),
        b"\x1b]11;rgb:fafa/fbfb/fcfc\x1b\\"
    );
}

#[test]
fn palette_queries_follow_theme_and_keep_extended_colors_fixed() {
    let mut t = Terminal::new(10, 2);
    assert_eq!(
        t.feed(b"\x1b]4;1;?;16;?\x07"),
        b"\x1b]4;1;rgb:cdcd/3131/3131\x1b\\\x1b]4;16;rgb:0000/0000/0000\x1b\\"
    );
    t.set_palette(TerminalPalette::LIGHT);
    assert_eq!(
        t.feed(b"\x1b]4;1;?;16;?\x07"),
        b"\x1b]4;1;rgb:a3a3/1515/1515\x1b\\\x1b]4;16;rgb:0000/0000/0000\x1b\\"
    );
    assert_eq!(
        t.feed(b"\x1b]10;?\x07\x1b]11;?\x07"),
        b"\x1b]10;rgb:2727/2727/2a2a\x1b\\\x1b]11;rgb:fbfb/fbfb/fbfb\x1b\\"
    );
    t.feed(b"\x1bc");
    assert_eq!(
        t.feed(b"\x1b]4;1;?\x07"),
        b"\x1b]4;1;rgb:a3a3/1515/1515\x1b\\"
    );
}

#[test]
fn published_palettes_match_the_core_colors() {
    let palettes = json::parse(&palettes_json()).unwrap();
    for (name, palette) in [
        ("dark", TerminalPalette::DARK),
        ("light", TerminalPalette::LIGHT),
    ] {
        let value = palettes.get(name).unwrap();
        let Value::Array(ansi) = value.get("ansi").unwrap() else {
            panic!()
        };
        assert_eq!(ansi.len(), 16);
        assert_eq!(
            value.field("fg").unwrap(),
            format!(
                "#{:02x}{:02x}{:02x}",
                palette.foreground[0], palette.foreground[1], palette.foreground[2]
            )
        );
        assert_eq!(
            value.field("bg").unwrap(),
            format!(
                "#{:02x}{:02x}{:02x}",
                palette.background[0], palette.background[1], palette.background[2]
            )
        );
        for (index, color) in palette.ansi.into_iter().enumerate() {
            assert_eq!(
                ansi[index],
                Value::String(format!("#{:02x}{:02x}{:02x}", color[0], color[1], color[2]))
            );
        }
    }
}
