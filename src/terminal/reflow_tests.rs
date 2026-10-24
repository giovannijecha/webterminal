use super::{Terminal, cells::Line};

#[test]
fn reflow_preserves_concealed_underline_transition_in_trailing_spaces() {
    let mut terminal = Terminal::new(4, 2);
    terminal.feed(b"\x1b[4m \x1b[8m   ");
    assert_eq!(terminal.primary.lines[0].cells[0].style.attrs, 8);
    assert_eq!(terminal.primary.lines[0].cells[1].style.attrs, 72);

    terminal.resize(6, 2);

    let line = &terminal.primary.lines[0];
    assert_eq!(line.cells[0].style.attrs, 8);
    assert!(line.cells[1..].iter().all(|cell| cell.style.attrs == 72));
}

fn text(line: &Line) -> String {
    line.cells
        .iter()
        .filter(|cell| cell.width != 0)
        .map(|cell| cell.text.as_str())
        .collect()
}

#[test]
fn reflow_keeps_styled_blank_bands_in_history_without_extra_rows() {
    fn paint(line: &super::cells::Line) -> String {
        let marks = line.cells.iter().map(|c| match c.style.bg {
            super::cells::Color::Default => '.',
            super::cells::Color::Rgb(48, 48, 48) => 'g',
            super::cells::Color::Rgb(0, 0, 160) => 'b',
            _ => '?',
        });
        marks.collect()
    }
    let mut t = Terminal::new(12, 3);
    t.feed(b"\x1b[48;2;48;48;48m> msg\x1b[K\x1b[0m\r\n");
    t.feed(b"\x1b[48;2;48;48;48m\x1b[K\x1b[0m\r\n");
    t.feed(b"x\x1b[48;2;0;0;160m   \x1b[0m\r\n");
    t.feed("\x1b[48;2;48;48;48m你\x1b[K\x1b[0m\r\ntail\r\n$ ".as_bytes());
    assert_eq!(t.primary.history.len(), 3);
    let cursor = (t.primary.x, t.primary.y);
    for cols in [16, 6, 12] {
        t.resize(cols, 3);
        let lines: Vec<_> = t.primary.history.iter().chain(&t.primary.lines).collect();
        let band = "g".repeat(cols);
        let chip = format!(".bbb{}", ".".repeat(cols - 4));
        assert_eq!(
            [lines[0], lines[1], lines[2], lines[3]].map(paint),
            [&*band, &band, &chip, &band],
            "cols {cols}"
        );
        assert_eq!(t.primary.history.len(), 3, "cols {cols}");
        assert_eq!(lines[0].cells[4].text, "g");
        let wide = &lines[3].cells;
        assert_eq!((&*wide[0].text, wide[1].width), ("你", 0));
        assert_eq!(text(&t.primary.lines[1]).trim_end(), "tail");
        assert_eq!((t.primary.x, t.primary.y), cursor, "cols {cols}");
    }
}

#[test]
fn reflow_preserves_faint_underline_transition_in_trailing_spaces() {
    let mut t = Terminal::new(4, 2);
    t.feed(b"\x1b[4m \x1b[2m   ");
    assert_eq!(t.primary.lines[0].cells[0].style.attrs, 8);
    assert_eq!(t.primary.lines[0].cells[1].style.attrs, 10);

    t.resize(6, 2);

    let line = &t.primary.lines[0];
    assert_eq!(line.cells[0].style.attrs, 8);
    assert!(line.cells[1..].iter().all(|cell| cell.style.attrs == 10));
}

#[test]
fn reflow_preserves_links_on_trailing_spaces() {
    let mut t = Terminal::new(4, 2);
    t.feed(b"\x1b]8;;https://example.test\x1b\\ \x1b]8;;\x1b\\   ");
    assert_eq!(
        t.primary.lines[0].cells[0].style.link,
        "https://example.test"
    );

    t.resize(6, 2);

    assert_eq!(
        t.primary.lines[0].cells[0].style.link,
        "https://example.test"
    );
    assert!(
        t.primary.lines[0].cells[1..]
            .iter()
            .all(|cell| cell.style.link.is_empty())
    );
}
