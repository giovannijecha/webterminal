use std::collections::VecDeque;

pub use super::cells::{BG, Cell, FG, Line, PutOptions, Style};
pub const HISTORY_LIMIT: usize = 1000;
pub const HISTORY_CELL_LIMIT: usize = 100_000;
pub const HISTORY_JSON_LIMIT: usize = 3 * 1024 * 1024;

#[derive(Clone, Debug)]
pub struct Screen {
    pub lines: Vec<Line>,
    pub history: VecDeque<Line>,
    history_json_bytes: usize,
    pub x: usize,
    pub y: usize,
    pub wrap_pending: bool,
    pub top: usize,
    pub bottom: usize,
    pub saved: (usize, usize),
}

impl Screen {
    pub fn new(cols: usize, rows: usize) -> Self {
        Self {
            lines: vec![Line::new(cols); rows],
            history: VecDeque::new(),
            history_json_bytes: 0,
            x: 0,
            y: 0,
            wrap_pending: false,
            top: 0,
            bottom: rows - 1,
            saved: (0, 0),
        }
    }
    fn trim_history(&mut self, cols: usize) {
        while self.history.len() > HISTORY_LIMIT.min(HISTORY_CELL_LIMIT / cols)
            || self.history_json_bytes + self.history.len().saturating_sub(1) > HISTORY_JSON_LIMIT
        {
            if let Some(line) = self.history.pop_front() {
                self.history_json_bytes -= super::json::line_len(&line);
            }
        }
    }
    fn push_history(&mut self, line: Line, cols: usize) {
        self.history_json_bytes += super::json::line_len(&line);
        self.history.push_back(line);
        self.trim_history(cols);
    }
    fn recount_history(&mut self, cols: usize) {
        self.history_json_bytes = self.history.iter().map(super::json::line_len).sum();
        self.trim_history(cols);
    }
    pub fn clear_history(&mut self) {
        self.history.clear();
        self.history_json_bytes = 0;
    }
    pub fn scroll_up(
        &mut self,
        top: usize,
        bottom: usize,
        count: usize,
        cols: usize,
        record: bool,
        style: &Style,
    ) {
        for _ in 0..count.min(bottom - top + 1) {
            let old = self.lines.remove(top);
            if record && top == 0 {
                self.push_history(old, cols);
            }
            self.lines.insert(bottom, Line::filled(cols, style));
        }
    }
    pub fn scroll_down(
        &mut self,
        top: usize,
        bottom: usize,
        count: usize,
        cols: usize,
        style: &Style,
    ) {
        for _ in 0..count.min(bottom - top + 1) {
            self.lines.remove(bottom);
            self.lines.insert(top, Line::filled(cols, style));
        }
    }
    pub fn index(&mut self, cols: usize, record: bool, style: &Style) {
        if self.y == self.bottom {
            self.scroll_up(self.top, self.bottom, 1, cols, record, style);
        } else if self.y + 1 < self.lines.len() {
            self.y += 1;
        }
        self.wrap_pending = false;
    }
    pub fn reverse_index(&mut self, cols: usize, style: &Style) {
        if self.y == self.top {
            self.scroll_down(self.top, self.bottom, 1, cols, style);
        } else {
            self.y = self.y.saturating_sub(1);
        }
        self.wrap_pending = false;
    }
    pub fn put(&mut self, text: &str, style: &Style, options: PutOptions) {
        let PutOptions {
            width,
            cols,
            wrap,
            insert,
            record,
        } = options;
        if width == 0 || width > cols {
            return;
        }
        if self.wrap_pending || self.x + width > cols {
            if wrap {
                self.lines[self.y].touch();
                self.lines[self.y].wrapped = true;
                self.x = 0;
                self.index(cols, record, &style.erase());
            } else {
                self.x = cols - width;
            }
        }
        if insert {
            let line = &mut self.lines[self.y];
            for _ in 0..width {
                line.cells.insert(self.x, Cell::blank(&style.erase()));
                line.cells.pop();
            }
            line.repair();
        }
        let line = &mut self.lines[self.y];
        if self.x > 0 && line.cells[self.x].width == 0 {
            line.cells[self.x - 1] = Cell::empty();
        }
        if line.cells[self.x].width == 2 && self.x + 1 < cols {
            line.cells[self.x + 1] = Cell::empty();
        }
        if width == 2 && line.cells[self.x + 1].width == 2 && self.x + 2 < cols {
            line.cells[self.x + 2] = Cell::empty();
        }
        line.cells[self.x] = Cell {
            text: text.into(),
            width: width as u8,
            style: style.clone(),
        };
        if width == 2 {
            line.cells[self.x + 1] = Cell {
                text: String::new(),
                width: 0,
                style: style.clone(),
            };
        }
        line.repair();
        self.x += width;
        if self.x >= cols {
            self.x = cols - 1;
            self.wrap_pending = wrap;
        }
    }
    fn previous_position(&self) -> Option<(bool, usize, usize)> {
        let mut x = self.x;
        let mut y = self.y;
        if self.wrap_pending {
            x += 1;
        }
        let mut history = false;
        if x == 0 {
            if y == 0 {
                y = self.history.len().checked_sub(1)?;
                history = true;
            } else {
                y -= 1;
            }
            let line = if history {
                &self.history[y]
            } else {
                &self.lines[y]
            };
            if !line.wrapped {
                return None;
            }
            x = line.cells.len();
        }
        x -= 1;
        let line = if history {
            &self.history[y]
        } else {
            &self.lines[y]
        };
        if line.cells[x].width == 0 {
            if x == 0 {
                return None;
            }
            x -= 1;
        }
        if line.cells[x].text == " " {
            return None;
        }
        Some((history, y, x))
    }
    pub fn last_cluster(&self) -> Option<&str> {
        let (history, y, x) = self.previous_position()?;
        Some(if history {
            &self.history[y].cells[x].text
        } else {
            &self.lines[y].cells[x].text
        })
    }
    pub fn append_cluster(&mut self, ch: char, new_width: usize, options: PutOptions) -> bool {
        let history = self
            .previous_position()
            .is_some_and(|(history, _, _)| history);
        let cols = options.cols;
        let joined = self.append_cluster_inner(ch, new_width, options);
        if history && joined {
            // Joining the last cell of a wrapped history line is rare. Recount
            // here because that join may also move a newly wide cell onscreen.
            self.recount_history(cols);
        }
        joined
    }
    fn append_cluster_inner(&mut self, ch: char, new_width: usize, options: PutOptions) -> bool {
        let Some((history, y, x)) = self.previous_position() else {
            return false;
        };
        let line = if history {
            &mut self.history[y]
        } else {
            &mut self.lines[y]
        };
        line.touch();
        let cell = &mut line.cells[x];
        cell.text.push(ch);
        if cell.width as usize >= new_width || options.cols < 2 {
            return true;
        }
        if x + 1 < options.cols {
            cell.width = 2;
            let style = cell.style.clone();
            line.cells[x + 1] = Cell {
                text: String::new(),
                width: 0,
                style,
            };
            if !history && y == self.y {
                if self.wrap_pending {
                    return true;
                }
                self.x += 1;
                if self.x >= options.cols {
                    self.x = options.cols - 1;
                    self.wrap_pending = options.wrap;
                }
            }
            return true;
        }
        if !options.wrap {
            return true;
        }
        let moved = line.cells[x].clone();
        line.cells[x] = Cell::empty();
        if history {
            self.put(
                &moved.text,
                &moved.style,
                PutOptions {
                    width: 2,
                    ..options
                },
            );
        } else {
            self.x = options.cols - 1;
            self.y = y;
            self.wrap_pending = true;
            self.put(
                &moved.text,
                &moved.style,
                PutOptions {
                    width: 2,
                    ..options
                },
            );
        }
        true
    }
    pub fn erase_range(&mut self, y: usize, start: usize, end: usize, style: &Style) {
        let line = &mut self.lines[y];
        for x in start..end {
            line.cells[x] = Cell::blank(style);
        }
        line.repair();
    }
    pub fn resize_simple(&mut self, cols: usize, rows: usize) {
        for line in &mut self.lines {
            line.cells.resize_with(cols, Cell::empty);
            line.repair();
        }
        self.lines.resize_with(rows, || Line::new(cols));
        self.x = self.x.min(cols - 1);
        self.y = self.y.min(rows - 1);
        self.top = 0;
        self.bottom = rows - 1;
        self.wrap_pending = false;
    }
    /// Resizes like the console host behind ConPTY, which repaints its
    /// viewport at absolute positions right after: the top row stays
    /// anchored, the view scrolls only to keep the cursor visible, and growing
    /// never pulls history back. Any other policy duplicates or loses rows
    /// between history and the repainted screen.
    pub fn resize_primary(&mut self, cols: usize, rows: usize) {
        if cols == self.lines[0].cells.len() {
            let shift = (self.y + 1).saturating_sub(rows);
            self.history.extend(self.lines.drain(..shift));
            self.y -= shift;
            self.lines.resize_with(rows, || Line::new(cols));
        } else {
            let (mut all, top, (y, x)) = self.reflow(cols);
            let top = top.max((y + 1).saturating_sub(rows));
            all.resize_with(top + rows, || Line::new(cols));
            self.lines = all.split_off(top);
            self.history = all.into();
            (self.y, self.x) = (y - top, x);
        }
        self.recount_history(cols);
        self.x = self.x.min(cols - 1);
        self.y = self.y.min(rows - 1);
        self.top = 0;
        self.bottom = rows - 1;
        self.wrap_pending = false;
    }
    /// Rewraps history and screen to `cols`, returning the rows, the new index
    /// of the old top screen row and the cursor position.
    fn reflow(&mut self, cols: usize) -> (Vec<Line>, usize, (usize, usize)) {
        let old_cols = self.lines[0].cells.len();
        let top_line = self.history.len();
        let cursor_line = top_line + self.y;
        let cursor_x = self.x;
        let mut top = 0;
        let mut mapped_cursor = None;
        let all: Vec<Line> = self.history.drain(..).chain(self.lines.drain(..)).collect();
        let mut rebuilt = Vec::<Line>::new();
        let mut current = Line::new(cols);
        let mut x = 0;
        for (line_index, line) in all.into_iter().enumerate() {
            if line_index == top_line {
                top = rebuilt.len();
            }
            let used = line
                .cells
                .iter()
                .rposition(|c| c.text != " " && c.width != 0)
                .map_or(0, |i| i + 1);
            let used = if line.wrapped { old_cols } else { used };
            let mut i = 0;
            while i < used {
                if line_index == cursor_line && i >= cursor_x && mapped_cursor.is_none() {
                    mapped_cursor = Some((rebuilt.len(), x.min(cols - 1)));
                }
                let cell = &line.cells[i];
                let w = cell.width as usize;
                if w > 0 {
                    let placed_width = w.min(cols);
                    if x + placed_width > cols {
                        current.wrapped = true;
                        rebuilt.push(current);
                        current = Line::new(cols);
                        x = 0;
                    }
                    if w <= cols {
                        current.cells[x] = cell.clone();
                        if w == 2 {
                            current.cells[x + 1] = line.cells[i + 1].clone();
                        }
                        x += w;
                    } else {
                        current.cells[x] = Cell {
                            text: "\u{fffd}".into(),
                            width: 1,
                            style: cell.style.clone(),
                        };
                        x += 1;
                    }
                }
                i += w.max(1);
            }
            if line_index == cursor_line && mapped_cursor.is_none() {
                mapped_cursor = Some((
                    rebuilt.len(),
                    (x + cursor_x.saturating_sub(used)).min(cols - 1),
                ));
            }
            if !line.wrapped {
                rebuilt.push(current);
                current = Line::new(cols);
                x = 0;
            }
        }
        if x > 0 {
            rebuilt.push(current);
        }
        (rebuilt, top, mapped_cursor.unwrap_or((top, 0)))
    }
}
