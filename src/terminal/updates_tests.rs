use super::{SnapshotBaseline, Terminal};
use crate::json::{self, Value};

fn array(value: &Value) -> &[Value] {
    let Value::Array(values) = value else {
        panic!("Expected an array")
    };
    values
}

fn apply(previous: Option<Value>, update: &str) -> Value {
    let Value::Object(mut next) = json::parse(update).unwrap() else {
        panic!("Expected terminal")
    };
    let Some(Value::Object(previous)) = previous else {
        return Value::Object(next);
    };
    let mut history = array(&previous["history"]).to_vec();
    let mut screen = array(&previous["screen"]).to_vec();
    if let Some(changes) = next.remove("historyChanges") {
        let drop = changes.integer("drop").unwrap() as usize;
        let keep = changes.integer("keep").unwrap() as usize;
        history = history[drop..drop + keep].to_vec();
        history.extend_from_slice(array(changes.get("append").unwrap()));
    }
    if let Some(changes) = next.remove("screenChanges") {
        for change in array(&changes) {
            let pair = array(change);
            screen[pair[0].number().unwrap() as usize] = pair[1].clone();
        }
    }
    next.entry("history".into())
        .or_insert(Value::Array(history));
    next.entry("screen".into()).or_insert(Value::Array(screen));
    Value::Object(next)
}

fn check(t: &Terminal, baseline: &mut SnapshotBaseline, previous: &mut Option<Value>) {
    let update = t.snapshot_update(baseline);
    let actual = apply(previous.take(), &update);
    let expected = json::parse(&t.snapshot_json()).unwrap();
    assert_eq!(
        actual, expected,
        "Incremental projection differs from Rust's full snapshot"
    );
    *previous = Some(actual);
}

#[test]
fn updates_match_full_state_across_edits_buffers_resize_and_reset() {
    let mut terminal = Terminal::new(12, 4);
    let mut baseline = SnapshotBaseline::default();
    let mut previous = None;
    check(&terminal, &mut baseline, &mut previous);
    for output in [
        "hello\r\nworld",
        "\x1b[1;3H\x1b[31;44;1mZ\x1b[0m",
        "\x1b[2@\x1b[P\x1b[X",
        "\x1b[2;1H\x1b[L\x1b[M",
        "\x1b[3;1H\x1b[K",
        "\x1b[?25l\x1b]2;Owned title\x07",
        "\x1b[?1049h\x1b[2Jalternate\x1b[?2004h",
        "\x1b[?1049l",
        "\x1b[4;1Hwrapped-long-linee",
        "\u{301}🙂👩\u{200d}💻",
        "\x1b[1;1H\x1b[2J",
        "\x1b[?25h\x1b[5 q",
    ] {
        terminal.feed(output.as_bytes());
        check(&terminal, &mut baseline, &mut previous);
    }
    for index in 0..55 {
        terminal.feed(format!("\r\n{index:03} fixture").as_bytes());
        check(&terminal, &mut baseline, &mut previous);
    }
    for (cols, rows) in [(8, 6), (8, 2), (8, 7), (16, 4)] {
        terminal.resize(cols, rows);
        check(&terminal, &mut baseline, &mut previous);
    }
    for output in ["\x1b[3J", "\x1bc", "after reset"] {
        terminal.feed(output.as_bytes());
        check(&terminal, &mut baseline, &mut previous);
    }
}

#[test]
fn history_eviction_and_archived_grapheme_joins_remain_exact() {
    let mut terminal = Terminal::new(2, 2);
    let mut baseline = SnapshotBaseline::default();
    let mut previous = None;
    check(&terminal, &mut baseline, &mut previous);
    // Force a grapheme join into a wrapped, archived line.
    terminal.feed(b"abcdE");
    terminal.primary.x = 0;
    terminal.primary.y = 0;
    check(&terminal, &mut baseline, &mut previous);
    terminal.feed("\u{301}".as_bytes());
    assert_eq!(terminal.primary.history[0].cells[1].text, "b\u{301}");
    check(&terminal, &mut baseline, &mut previous);
    for index in 0..1020 {
        terminal.feed(format!("\r\n{:02}", index % 100).as_bytes());
        check(&terminal, &mut baseline, &mut previous);
    }
    assert_eq!(terminal.primary.history.len(), 1000);
    terminal.feed(b"\x1b[3J");
    check(&terminal, &mut baseline, &mut previous);
}

#[test]
fn view_baselines_are_small_independent_and_restore_full_history() {
    let mut terminal = Terminal::new(80, 24);
    for index in 0..600 {
        terminal.feed(format!("{index:04} owned output\r\n").as_bytes());
    }
    let mut first = SnapshotBaseline::default();
    assert_eq!(
        terminal.snapshot_update(&mut first),
        terminal.snapshot_json()
    );
    terminal.feed(b"\x1b[2;1HONE");
    let update = terminal.snapshot_update(&mut first);
    assert!(
        update.len() < 4000,
        "Unchanged history must not be serialized again"
    );
    assert!(!update.contains("\"history\":"));
    let mut observer = SnapshotBaseline::default();
    assert_eq!(
        terminal.snapshot_update(&mut observer),
        terminal.snapshot_json()
    );
    assert!(
        terminal
            .snapshot_update(&mut first)
            .contains("\"screenChanges\":[]")
    );
    assert!(first.history.len() <= 1000 && first.screen.len() <= 120);
}
