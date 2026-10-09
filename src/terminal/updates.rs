//! Per-view rendering baselines contain only bounded row identities, never cells.
use super::{Terminal, json};

#[derive(Default)]
pub struct SnapshotBaseline {
    cols: usize,
    pub(super) history: Vec<u64>,
    pub(super) screen: Vec<u64>,
}

pub(super) fn snapshot(t: &Terminal, baseline: &mut SnapshotBaseline) -> String {
    let first = baseline.cols == 0;
    let history: Vec<u64> = t.primary.history.iter().map(|line| line.revision).collect();
    let screen: Vec<u64> = t.active().lines.iter().map(|line| line.revision).collect();
    let mut out = json::metadata(t);
    if first {
        out.push_str(",\"history\":[");
        for (index, line) in t.primary.history.iter().enumerate() {
            if index != 0 {
                out.push(',');
            }
            json::line(&mut out, line);
        }
        out.push(']');
    } else if history != baseline.history {
        // Retain the longest old contiguous range matching the new prefix.
        // This handles bounded head eviction, appended rows, joins and reflow.
        let (mut drop, mut keep) = (0, 0);
        for start in 0..baseline.history.len() {
            let count = baseline.history[start..]
                .iter()
                .zip(&history)
                .take_while(|(old, new)| old == new)
                .count();
            if count > keep {
                (drop, keep) = (start, count);
            }
        }
        out.push_str(&format!(
            ",\"historyChanges\":{{\"drop\":{drop},\"keep\":{keep},\"append\":["
        ));
        for (index, line) in t.primary.history.iter().skip(keep).enumerate() {
            if index != 0 {
                out.push(',');
            }
            json::line(&mut out, line);
        }
        out.push_str("]}");
    }
    let full_screen = first || baseline.cols != t.cols || baseline.screen.len() != screen.len();
    out.push_str(if full_screen {
        ",\"screen\":["
    } else {
        ",\"screenChanges\":["
    });
    let mut separator = false;
    for (index, line) in t.active().lines.iter().enumerate() {
        if !full_screen && baseline.screen[index] == line.revision {
            continue;
        }
        if separator {
            out.push(',');
        }
        separator = true;
        if !full_screen {
            out.push_str(&format!("[{index},"));
        }
        json::line(&mut out, line);
        if !full_screen {
            out.push(']');
        }
    }
    out.push_str("]}");
    baseline.cols = t.cols;
    baseline.history = history;
    baseline.screen = screen;
    out
}
