use super::{Terminal, unicode};

#[path = "../bin/fixtures/width_frames.rs"]
mod frames;

const SYMBOL_RANGES: [(u32, u32); 5] = [
    (0x2630, 0x2637),
    (0x268a, 0x268f),
    (0x4dc0, 0x4dff),
    (0x1d300, 0x1d356),
    (0x1d360, 0x1d376),
];

#[test]
fn conpty_symbol_families_use_one_cell_without_changing_other_widths() {
    for (start, end) in SYMBOL_RANGES {
        for code in start..=end {
            let ch = char::from_u32(code).unwrap();
            assert_eq!(unicode::width(&ch.to_string()), 1, "U+{code:04X}");
            assert_eq!(unicode::width(&format!("{ch}\u{301}")), 1);
        }
    }
    for narrow in ["A", "·", "☯", "☸", "⚉", "⚐", "𝍗", "𝍟", "𝍷", "☰\u{fe0e}"] {
        assert_eq!(unicode::width(narrow), 1, "{narrow}");
    }
    for wide in ["界", "䶿", "一", "Ａ", "🙂", "⌚", "👩‍💻", "☰\u{fe0f}"] {
        assert_eq!(unicode::width(wide), 2, "{wide}");
    }
}

#[test]
fn conpty_symbols_wrap_only_after_filling_the_last_cell() {
    for (start, end) in SYMBOL_RANGES {
        for code in start..=end {
            let ch = char::from_u32(code).unwrap();
            for cols in [1, 2, 80, 144, 145] {
                let mut t = Terminal::new(cols, 2);
                t.feed("x".repeat(cols - 1).as_bytes());
                // Split the UTF-8 and combining mark across transport chunks.
                for byte in format!("{ch}\u{301}").bytes() {
                    t.feed(&[byte]);
                }
                let cell = &t.active().lines[0].cells[cols - 1];
                assert_eq!(cell.text, format!("{ch}\u{301}"), "U+{code:04X}, {cols}");
                assert_eq!(cell.width, 1);
                assert_eq!((t.active().x, t.active().y), (cols - 1, 0));
                assert!(t.active().wrap_pending);
                assert!(t.primary.history.is_empty());

                t.feed(b"!");
                assert!(t.active().lines[0].wrapped);
                assert_eq!(t.active().lines[1].cells[0].text, "!");
                assert_eq!((t.active().x, t.active().y), (1.min(cols - 1), 1));
                assert_eq!(t.active().wrap_pending, cols == 1);
                assert!(t.primary.history.is_empty());
            }
        }
    }
}

#[test]
fn conpty_width_redraw_keeps_answer_status_and_footer_aligned() {
    for cols in [80, 144, 145] {
        for chunk_size in [1, 7, 4096] {
            let mut t = Terminal::new(cols, 10);
            let draw = frames::draw(cols);
            for chunk in draw.as_bytes().chunks(chunk_size) {
                t.feed(chunk);
            }
            assert_frame(&t, cols, "Thinking", false);
            t.feed(frames::work().as_bytes());
            assert_frame(&t, cols, "Working", false);
            t.feed(frames::done(cols).as_bytes());
            assert_frame(&t, cols, "Done", true);
            assert_eq!((t.active().x, t.active().y), (4, 4));
            assert!(!t.active().wrap_pending);
        }
    }
}

fn assert_frame(t: &Terminal, cols: usize, status: &str, done: bool) {
    let lines: Vec<String> = t
        .active()
        .lines
        .iter()
        .map(|line| {
            line.cells
                .iter()
                .filter(|c| c.width != 0)
                .map(|c| c.text.as_str())
                .collect()
        })
        .collect();
    assert_eq!(lines[0], frames::header(cols));
    let answer = frames::answer(cols);
    for (index, chunk) in answer.as_bytes().chunks(cols).enumerate() {
        assert_eq!(
            lines[index + 1].trim_end(),
            std::str::from_utf8(chunk).unwrap().trim_end()
        );
    }
    assert_eq!(lines[4].trim_end(), status);
    let mut footer = frames::footer(cols);
    if done {
        footer.replace_range(footer.len() - 6.., "READY|");
    }
    assert_eq!(lines[5], footer);
    assert!(lines[6..].iter().all(|line| line.trim().is_empty()));
    assert!(t.primary.history.is_empty());
    assert!(
        t.active()
            .lines
            .iter()
            .all(|line| line.cells.iter().all(|c| c.width == 1))
    );
}
