// Assemble an immutable rendering projection of Rust's ordered session updates.
// This module does not interpret terminal output or maintain terminal modes.
export function mergeUpdate(previous, message) {
  if (!previous || message.id !== previous.id || message.base !== previous.seq ||
      message.seq <= previous.seq || message.epoch < previous.epoch) return null;
  const change = message.terminal;
  if (!change || !Number.isInteger(change.cols) || !Number.isInteger(change.rows)) return null;
  let history = change.history ?? previous.terminal.history;
  let screen = change.screen ?? previous.terminal.screen;
  if (change.historyChanges) {
    const {drop, keep, append} = change.historyChanges;
    const old = previous.terminal.history;
    if (!Number.isInteger(drop) || !Number.isInteger(keep) || drop < 0 || keep < 0 ||
        drop + keep > old.length || !Array.isArray(append) || keep + append.length > 1000) return null;
    history = old.slice(drop, drop + keep).concat(append);
  }
  if (change.screenChanges) {
    if (!Array.isArray(change.screenChanges) || change.cols !== previous.terminal.cols ||
        change.rows !== previous.terminal.rows) return null;
    screen = screen.slice();
    for (const entry of change.screenChanges) {
      if (!Array.isArray(entry) || entry.length !== 2) return null;
      const [index, line] = entry;
      if (!Number.isInteger(index) || index < 0 || index >= screen.length || !line) return null;
      screen[index] = line;
    }
  }
  if (!Array.isArray(history) || !Array.isArray(screen) || screen.length !== change.rows) return null;
  const terminal = {...previous.terminal, ...change, history, screen};
  delete terminal.historyChanges;
  delete terminal.screenChanges;
  return {...message, type:'snapshot', terminal};
}
