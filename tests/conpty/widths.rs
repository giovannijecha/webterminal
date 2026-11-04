use crate::conpty::{await_exit, collect, command, scratch};
use crate::native;
use std::fs;
use std::time::Duration;

#[test]
fn conpty_symbol_family_widths() {
    let dir = scratch();
    let spawned = native::spawn(&command("--widths", None), &dir, 80, 24).unwrap();
    let output = collect(spawned.output);
    assert_eq!(await_exit(&spawned.pty), 0);
    spawned.pty.terminate().unwrap();
    let bytes = output.recv_timeout(Duration::from_secs(10)).unwrap();
    let text = String::from_utf8(bytes).unwrap();
    fs::remove_dir(dir).unwrap();
    for (start, end) in [
        (0x2630, 0x2637),
        (0x268a, 0x268f),
        (0x4dc0, 0x4dff),
        (0x1d300, 0x1d356),
        (0x1d360, 0x1d376),
    ] {
        for code in start..=end {
            assert!(text.contains(&format!("WIDTH U+{code:04X}=1")), "{text:?}");
        }
    }
}
