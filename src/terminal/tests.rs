use super::{Event, Terminal};

fn texts(t: &Terminal) -> Vec<String> {
    t.active()
        .lines
        .iter()
        .map(|l| {
            l.cells
                .iter()
                .filter(|c| c.width != 0)
                .map(|c| c.text.as_str())
                .collect::<String>()
        })
        .collect()
}

#[test]
fn incremental_utf8_controls_and_recovery() {
    let mut t = Terminal::new(8, 2);
    t.feed(&[0xe4, 0xbd]);
    t.feed(&[0xa0, b'X', 0x1b, b'[', b'1']);
    t.feed(b"D!\x1b]2;Name\x1b");
    t.feed(b"\\");
    assert_eq!(texts(&t)[0], "你!     ");
    assert_eq!(t.title(), "Name");
    t.feed(&[0xff, b'A']);
    assert!(texts(&t)[0].contains('\u{fffd}'));
    t.feed(b"\x1b[9999999999999999999999999999999999999999999999999999Cz");
    assert_eq!(t.active().lines[0].cells.len(), 8);
    let mut t = Terminal::new(8, 1);
    t.feed(&[0xe2]);
    t.feed(b"A\r");
    assert_eq!(t.active().lines[0].cells[0].text, "\u{fffd}");
    assert_eq!(t.active().lines[0].cells[1].text, "A");
    t.feed(&[0xf0, 0x9f, b'B']);
    assert_eq!(t.active().lines[0].cells[0].text, "\u{fffd}");
    assert_eq!(t.active().lines[0].cells[1].text, "B");
}

#[test]
fn style_wide_grapheme_and_json() {
    let mut t = Terminal::new(10, 2);
    t.feed("e\u{301}界👩\u{200d}💻".as_bytes());
    assert_eq!(t.active().lines[0].cells[0].text, "e\u{301}");
    assert_eq!(t.active().lines[0].cells[1].width, 2);
    assert_eq!(t.active().lines[0].cells[3].text, "👩\u{200d}💻");
    t.feed(b"\x1b[1;38;2;1;2;3;48;5;196mA");
    let c = &t.active().lines[0].cells[5];
    assert_eq!(
        (&*c.style.fg, &*c.style.bg, c.style.attrs),
        ("#010203", "#ff0000", 1)
    );
    assert!(t.snapshot_json().contains("\"cursor\""));
}

#[test]
fn alternate_modes_queries_and_events() {
    let mut t = Terminal::new(5, 2);
    t.feed(b"base\x1b[?1049h\x1b[?1;25;1006;2004;2026h");
    assert!(t.alternate && t.synchronized());
    assert!(t.modes.app_cursor && t.modes.mouse_sgr && t.modes.bracketed_paste);
    assert_eq!(
        t.feed(b"\x1b[6n\x1b[18t\x1b[?9001$p\x1b[?2026$p"),
        b"\x1b[1;1R\x1b[8;2;5t\x1b[?9001;2$y\x1b[?2026;1$y"
    );
    t.feed(b"x\x07\x1b]52;c;SGk=\x07\x1b[?2026;1049l");
    assert!(!t.alternate && !t.synchronized());
    assert_eq!(texts(&t)[0], "base ");
    assert_eq!(
        t.take_events(),
        vec![Event::Bell, Event::Clipboard("SGk=".into())]
    );
}

#[test]
fn history_resize_and_scroll_region() {
    let mut t = Terminal::new(4, 2);
    t.feed(b"abcdEF\r\nGH");
    assert!(!t.primary.history.is_empty());
    t.resize(2, 2);
    assert_eq!(t.cols, 2);
    assert!(t.primary.history.iter().all(|l| l.cells.len() == 2));
    let mut t = Terminal::new(4, 3);
    t.feed(b"AAAA\r\nBBBB\r\nCCCC\x1b[2;3r\x1b[2;1H\x1b[L");
    assert_eq!(texts(&t)[0], "AAAA");
    assert_eq!(texts(&t)[1], "    ");
    let mut t = Terminal::new(8, 2);
    t.feed(b"abcdef");
    t.resize(3, 2);
    assert_eq!((t.active().x, t.active().y), (2, 0));
    assert_eq!(texts(&t), vec!["def", "   "]);
    assert_eq!(
        t.primary.history[0]
            .cells
            .iter()
            .map(|c| c.text.as_str())
            .collect::<String>(),
        "abc"
    );
    let mut t = Terminal::new(4, 3);
    t.feed(b"\x1b[2;2H");
    t.resize(4, 2);
    assert_eq!((t.active().x, t.active().y), (1, 0));
    t.resize(4, 3);
    assert_eq!((t.active().x, t.active().y), (1, 1));
    let mut t = Terminal::new(2, 2);
    t.feed("\u{754c}".as_bytes());
    t.resize(1, 2);
    assert!(texts(&t).iter().any(|line| line == "\u{fffd}"));
}

#[test]
fn bounded_history_and_control_string() {
    let mut t = Terminal::new(300, 1);
    for _ in 0..500 {
        t.feed(b"x\r\n");
    }
    assert!(t.primary.history.len() <= 333);
    t.feed(b"\x1bPgarbage\x1b\\ok");
    assert!(texts(&t)[0].starts_with("ok"));
    let oversized = format!("\x1b]2;{}\x07visible", "x".repeat(5000));
    t.feed(oversized.as_bytes());
    assert!(texts(&t)[0].contains("visible"));
    assert_eq!(t.title(), "");
}

#[test]
fn editing_wide_cells_and_links() {
    let mut t = Terminal::new(5, 1);
    t.feed("界".as_bytes());
    t.feed(b"\x1b[1G\x1b[1X");
    assert_eq!(t.active().lines[0].cells[0].width, 1);
    assert_eq!(t.active().lines[0].cells[1].width, 1);
    t.feed(b"\x1b]8;;https://example.test\x1b\\\x1b[0mL");
    assert_eq!(
        t.active().lines[0].cells[0].style.link,
        "https://example.test"
    );
    let mut narrow = Terminal::new(1, 1);
    narrow.feed("\u{754c}".as_bytes());
    assert_eq!(narrow.active().lines[0].cells[0].text, "\u{fffd}");
}

#[test]
fn unicode_property_graphemes_and_dynamic_width() {
    let cases = [
        ("e\u{301}", 1),
        ("ا\u{654}", 1),
        ("क\u{94d}ष", 1),
        ("한", 2),
        ("🇮🇹", 2),
        ("1️⃣", 2),
        ("©️", 2),
        ("👩🏽‍💻", 2),
    ];
    for (sample, width) in cases {
        let mut t = Terminal::new(20, 1);
        for chunk in sample.as_bytes().chunks(1) {
            t.feed(chunk);
        }
        assert_eq!(t.active().lines[0].cells[0].text, sample, "{sample:?}");
        assert_eq!(t.active().lines[0].cells[0].width, width, "{sample:?}");
    }
    let mut t = Terminal::new(2, 2);
    t.feed("x©️".as_bytes());
    assert_eq!(t.active().lines[1].cells[0].text, "©️");
    assert_eq!(t.active().lines[1].cells[0].width, 2);
    let mut t = Terminal::new(8, 1);
    t.feed("🇮🇹🇺".as_bytes());
    assert_eq!(t.active().lines[0].cells[0].text, "🇮🇹");
    assert_eq!(t.active().lines[0].cells[2].text, "🇺");
}

#[test]
fn colon_sgr_charset_queries_and_soft_reset() {
    let mut t = Terminal::new(12, 3);
    t.feed(b"\x1b[38:2::1:2:3;48:5:196;4:2mA");
    let c = &t.active().lines[0].cells[0];
    assert_eq!(
        (&*c.style.fg, &*c.style.bg, c.style.attrs),
        ("#010203", "#ff0000", 8)
    );
    t.feed(b"\x1b(0lqk\x1b(B\x1b)0\x0enq\x0fZ");
    assert_eq!(t.active().lines[0].cells[1].text, "┌");
    assert_eq!(t.active().lines[0].cells[2].text, "─");
    assert_eq!(t.active().lines[0].cells[3].text, "┐");
    assert_eq!(t.active().lines[0].cells[4].text, "┼");
    assert_eq!(t.active().lines[0].cells[6].text, "Z");
    t.feed(b"\x1b]2;Demo\x07\x1b[2;3r\x1b[4 q");
    assert_eq!(t.feed(b"\x1bP$qm\x1b\\\x1bP$qr\x1b\\\x1bP$q q\x1b\\\x1bP$qz\x1b\\"),
        b"\x1bP1$r0;4;38;2;1;2;3;48;2;255;0;0m\x1b\\\x1bP1$r2;3r\x1b\\\x1bP1$r4 q\x1b\\\x1bP0$r\x1b\\");
    assert_eq!(t.feed(b"\x1b[19t\x1b[21t\x1b]10;?\x07\x1b]4;1;?\x07"),
        b"\x1b[9;3;12t\x1b]lDemo\x1b\\\x1b]10;rgb:d4d4/d4d4/d4d4\x1b\\\x1b]4;1;rgb:cdcd/3131/3131\x1b\\");
    t.feed(b"\x1b[!p");
    assert_eq!(
        (
            t.active().top,
            t.active().bottom,
            t.active().x,
            t.active().y
        ),
        (0, 2, 0, 0)
    );
    assert_eq!(t.active().lines[0].cells[0].text, "A");
    assert!(!t.modes.app_cursor);
}

#[test]
fn erase_and_scroll_use_current_background_without_link_or_attrs() {
    let mut t = Terminal::new(3, 2);
    t.feed(b"\x1b[41;1m\x1b]8;;https://example.test\x1b\\abc\r\nxyz\x1b[1;1H\x1b[2K");
    let blank = &t.active().lines[0].cells[0];
    assert_eq!(
        (&*blank.style.bg, blank.style.attrs, &*blank.style.link),
        ("#cd3131", 0, "")
    );
    t.feed(b"\x1b[2;1H\r\n");
    let scrolled_blank = &t.active().lines[1].cells[0];
    assert_eq!(
        (&*scrolled_blank.style.bg, scrolled_blank.style.attrs),
        ("#cd3131", 0)
    );
}

#[test]
fn every_chunk_boundary_has_the_same_terminal_result() {
    let bytes = "start é👩\u{200d}💻\x1b[38:2::12:34:56m!\x1b]2;Chunks\x1b\\\
        \x1b]8;;https://example.test\x07L\x1b]8;;\x07\x1b]52;c;SGk=\x07\
        \x1b[?2026h\x1b[?1049hALT\x1b[6n\x1b[?1049l\x1b[?2026l\
        \x1bP$qm\x1b\\\x1b]10;?\x1b\\\x07"
        .as_bytes();
    let mut baseline = Terminal::new(40, 3);
    let expected_response = baseline.feed(bytes);
    let expected_events = baseline.take_events();
    let expected_snapshot = baseline.snapshot_json();
    assert!(expected_snapshot.contains("Chunks"));
    assert!(!expected_response.is_empty());
    assert!(expected_events.contains(&Event::Clipboard("SGk=".into())));
    for split in 1..bytes.len() {
        let mut t = Terminal::new(40, 3);
        let mut response = t.feed(&bytes[..split]);
        response.extend(t.feed(&bytes[split..]));
        assert_eq!(response, expected_response, "split {split}");
        assert_eq!(t.take_events(), expected_events, "split {split}");
        assert_eq!(t.snapshot_json(), expected_snapshot, "split {split}");
        assert_eq!(t.synchronized(), baseline.synchronized(), "split {split}");
    }
    let mut bytewise = Terminal::new(40, 3);
    let mut response = Vec::new();
    for b in bytes {
        response.extend(bytewise.feed(&[*b]));
    }
    assert_eq!(response, expected_response);
    assert_eq!(bytewise.take_events(), expected_events);
    assert_eq!(bytewise.snapshot_json(), expected_snapshot);
}

#[test]
fn region_editing_and_resize_keep_grapheme_cells_intact() {
    let mut t = Terminal::new(6, 3);
    t.feed("A界B\r\n1🇮🇹2\r\nXYZ".as_bytes());
    t.feed(b"\x1b[1;2H\x1b[@\x1b[2;2H\x1b[P\x1b[2;3r\x1b[2;1H\x1b[L");
    assert_eq!(texts(&t), vec!["A \u{754c}B ", "      ", "1 2   "]);
    for line in &t.active().lines {
        for (x, cell) in line.cells.iter().enumerate() {
            if cell.width == 0 {
                assert!(x > 0 && line.cells[x - 1].width == 2);
            }
            if cell.width == 2 {
                assert!(x + 1 < line.cells.len() && line.cells[x + 1].width == 0);
            }
        }
    }
    assert_eq!(t.active().lines[0].cells[0].text, "A");
    t.resize(4, 3);
    for line in t.primary.history.iter().chain(t.primary.lines.iter()) {
        for (x, cell) in line.cells.iter().enumerate() {
            if cell.width == 0 {
                assert!(x > 0 && line.cells[x - 1].width == 2);
            }
            if cell.width == 2 {
                assert!(x + 1 < line.cells.len() && line.cells[x + 1].width == 0);
            }
        }
    }
    assert_eq!(t.primary.lines.len(), 3);
    assert!(t.primary.history.len() <= 1000);
    let mut clusters = Terminal::new(6, 2);
    clusters.feed("A\u{1f1ee}\u{1f1f9}\u{1f469}\u{200d}\u{1f4bb}Z".as_bytes());
    clusters.resize(4, 3);
    let cells: Vec<_> = clusters
        .primary
        .history
        .iter()
        .chain(clusters.primary.lines.iter())
        .flat_map(|line| line.cells.iter())
        .filter(|cell| cell.width > 0)
        .collect();
    assert_eq!(
        cells
            .iter()
            .filter(|cell| cell.text == "\u{1f1ee}\u{1f1f9}" && cell.width == 2)
            .count(),
        1
    );
    assert_eq!(
        cells
            .iter()
            .filter(|cell| cell.text == "\u{1f469}\u{200d}\u{1f4bb}" && cell.width == 2)
            .count(),
        1
    );
}

#[test]
fn pathological_clusters_and_links_stay_bounded() {
    use super::screen::{HISTORY_JSON_LIMIT, Line, Style};

    let mut t = Terminal::new(300, 120);
    let overlong = format!("\x1b]8;;{}\x07x", "\u{e9}".repeat(129));
    t.feed(overlong.as_bytes());
    assert!(t.active().lines[0].cells[0].style.link.is_empty());

    let joined = format!("a{}Z", "\u{301}".repeat(100));
    let mut cluster = Terminal::new(4, 1);
    cluster.feed(joined.as_bytes());
    assert!(cluster.active().lines[0].cells[0].text.len() <= super::render::MAX_CLUSTER_BYTES);
    assert_eq!(cluster.active().lines[0].cells[1].text, "Z");

    // Quotes and backslashes double in JSON; Unicode combining marks consume
    // the full cell budget. This upper bound includes the largest screen,
    // retained history, metadata, and the session envelope.
    let mut worst_line = Line::new(300);
    let link = "\"\\".repeat(128);
    for cell in &mut worst_line.cells {
        cell.text = format!("\\{}", "\u{301}".repeat(63));
        cell.style = Style {
            link: link.clone(),
            ..Style::default()
        };
    }
    assert!(
        super::json::line_len(&worst_line) * 120 + HISTORY_JSON_LIMIT + 8192 < 32 * 1024 * 1024
    );

    let osc = format!("\x1b]8;;{link}\x07");
    t.feed(osc.as_bytes());
    let full_line = "x".repeat(300);
    for _ in 0..160 {
        t.feed(full_line.as_bytes());
        t.feed(b"\r\n");
    }
    let snapshot = t.snapshot_json();
    let history = snapshot
        .split_once("\"history\":[")
        .unwrap()
        .1
        .split_once("],\"screen\"")
        .unwrap()
        .0;
    let accounted = t
        .primary
        .history
        .iter()
        .map(super::json::line_len)
        .sum::<usize>()
        + t.primary.history.len().saturating_sub(1);
    assert_eq!(history.len(), accounted);
    assert!(history.len() <= HISTORY_JSON_LIMIT);
    assert!(snapshot.len() + 512 < 32 * 1024 * 1024);
    assert!(t.primary.history.len() < 40);

    t.resize(150, 120);
    let resized = t.snapshot_json();
    let resized_history = resized
        .split_once("\"history\":[")
        .unwrap()
        .1
        .split_once("],\"screen\"")
        .unwrap()
        .0;
    assert!(resized_history.len() <= HISTORY_JSON_LIMIT);
    assert!(resized.len() + 512 < 32 * 1024 * 1024);
    t.feed(b"\x1b[3J");
    assert!(t.primary.history.is_empty());
    assert!(t.snapshot_json().contains("\"history\":[]"));
}
