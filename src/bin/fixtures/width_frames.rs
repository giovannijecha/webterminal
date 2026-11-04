//! Owned redraw scenario shared by emulator, ConPTY and browser regressions.

pub fn header(cols: usize) -> String {
    let text = "Sidebar chiara su desktop, ☰ a scomparsa su mobile";
    format!("{text}{}|", " ".repeat(cols - text.chars().count() - 1))
}

pub fn answer(cols: usize) -> String {
    "ASK USER: Keep every word of this long answer in order without stale status lines. "
        .chars()
        .cycle()
        .take(cols * 2 + 13)
        .collect()
}

pub fn footer(cols: usize) -> String {
    let text = "Footer: Enter accepts / Esc cancels / ☰ menu";
    format!(
        "{text}{}WAIT |",
        " ".repeat(cols - text.chars().count() - 6)
    )
}

pub fn draw(cols: usize) -> String {
    format!(
        "\x1b[2J\x1b[H{}\r\n{}\r\nThinking\r\n{}",
        header(cols),
        answer(cols),
        footer(cols)
    )
}

pub fn work() -> &'static str {
    "\x1b[5;1H\x1b[2KWorking\x1b[5;8H"
}

pub fn done(cols: usize) -> String {
    format!("\x1b[5;1H\x1b[2KDone\x1b[6;{}HREADY|\x1b[5;5H", cols - 5)
}
