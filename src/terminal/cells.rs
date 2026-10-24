//! Terminal cells and immutable identities for ordered rendering updates.
use std::ops::{Deref, DerefMut};
use std::sync::{
    Arc,
    atomic::{AtomicU64, Ordering},
};

// Each revision is a global line-change token. JSON clients compare it as a
// number; reaching JavaScript's exact-integer limit would require over 2^53
// line mutations in one server process.
static NEXT_LINE: AtomicU64 = AtomicU64::new(1);

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum Color {
    #[default]
    Default,
    Indexed(u8),
    Rgb(u8, u8, u8),
}

impl Color {
    pub fn rgb(self, default: [u8; 3]) -> [u8; 3] {
        match self {
            Self::Default => default,
            Self::Indexed(index) => {
                if index < 16 {
                    return super::palette::TerminalPalette::DARK.ansi[index as usize];
                }
                if index < 232 {
                    let n = index - 16;
                    let component = |v| if v == 0 { 0 } else { 55 + v * 40 };
                    return [component(n / 36), component((n / 6) % 6), component(n % 6)];
                }
                let gray = 8 + (index - 232) * 10;
                [gray, gray, gray]
            }
            Self::Rgb(r, g, b) => [r, g, b],
        }
    }

    #[cfg(test)]
    pub fn css(self, default: [u8; 3]) -> String {
        let [r, g, b] = self.rgb(default);
        format!("#{r:02x}{g:02x}{b:02x}")
    }
}

pub struct PutOptions {
    pub width: usize,
    pub cols: usize,
    pub wrap: bool,
    pub insert: bool,
    pub record: bool,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Style {
    pub fg: Color,
    pub bg: Color,
    pub attrs: u16,
    pub link: String,
}

impl Default for Style {
    fn default() -> Self {
        Self {
            fg: Color::Default,
            bg: Color::Default,
            attrs: 0,
            link: String::new(),
        }
    }
}
impl Style {
    pub fn erase(&self) -> Self {
        Self {
            fg: Color::Default,
            bg: self.bg,
            attrs: 0,
            link: String::new(),
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Cell {
    pub text: String,
    pub width: u8,
    pub style: Style,
}

impl Cell {
    pub fn blank(style: &Style) -> Self {
        Self {
            text: " ".into(),
            width: 1,
            style: style.clone(),
        }
    }
    pub fn empty() -> Self {
        Self::blank(&Style::default())
    }
    /// What a blank cell paints and where it links, or `None` for other cells.
    pub fn blank_paint(&self) -> Option<(Color, u16, Color, &str)> {
        if self.text != " " || self.width != 1 {
            return None;
        }
        let style = &self.style;
        let (fg, bg) = if style.attrs & 32 != 0 {
            (style.bg, style.fg)
        } else {
            (style.fg, style.bg)
        };
        let marks = style.attrs & (8 | 16 | 128);
        let decoration = marks & (8 | 128) != 0;
        let paint_attrs = marks
            | if decoration {
                style.attrs & (2 | 64)
            } else {
                0
            };
        Some((
            bg,
            paint_attrs,
            if decoration { fg } else { Color::Default },
            &style.link,
        ))
    }
}

#[derive(Clone, Debug)]
pub struct Line {
    pub revision: u64,
    pub wrapped: bool,
    pub cells: SharedCells,
}

/// Cloning a line for a snapshot shares its cells until either copy is edited.
#[derive(Clone, Debug)]
pub struct SharedCells(Arc<Vec<Cell>>);

impl Deref for SharedCells {
    type Target = Vec<Cell>;
    fn deref(&self) -> &Self::Target {
        &self.0
    }
}
impl DerefMut for SharedCells {
    fn deref_mut(&mut self) -> &mut Self::Target {
        Arc::make_mut(&mut self.0)
    }
}
impl<'a> IntoIterator for &'a SharedCells {
    type Item = &'a Cell;
    type IntoIter = std::slice::Iter<'a, Cell>;
    fn into_iter(self) -> Self::IntoIter {
        self.0.iter()
    }
}
impl<'a> IntoIterator for &'a mut SharedCells {
    type Item = &'a mut Cell;
    type IntoIter = std::slice::IterMut<'a, Cell>;
    fn into_iter(self) -> Self::IntoIter {
        Arc::make_mut(&mut self.0).iter_mut()
    }
}

impl Line {
    pub fn new(cols: usize) -> Self {
        Self {
            revision: NEXT_LINE.fetch_add(1, Ordering::Relaxed),
            wrapped: false,
            cells: SharedCells(Arc::new(vec![Cell::empty(); cols])),
        }
    }
    pub fn filled(cols: usize, style: &Style) -> Self {
        Self {
            revision: NEXT_LINE.fetch_add(1, Ordering::Relaxed),
            wrapped: false,
            cells: SharedCells(Arc::new(vec![Cell::blank(style); cols])),
        }
    }
    pub fn touch(&mut self) {
        self.revision = NEXT_LINE.fetch_add(1, Ordering::Relaxed);
    }
    pub fn repair(&mut self) {
        self.touch();
        for x in 0..self.cells.len() {
            if self.cells[x].width == 0 && (x == 0 || self.cells[x - 1].width != 2) {
                self.cells[x] = Cell::empty();
            }
            if self.cells[x].width == 2
                && (x + 1 >= self.cells.len() || self.cells[x + 1].width != 0)
            {
                self.cells[x] = Cell::empty();
            }
        }
    }

    pub fn repair_at(&mut self, start: usize, end: usize) {
        self.touch();
        for x in start.saturating_sub(1)..end.saturating_add(1).min(self.cells.len()) {
            if self.cells[x].width == 0 && (x == 0 || self.cells[x - 1].width != 2) {
                self.cells[x] = Cell::empty();
            }
            if self.cells[x].width == 2
                && (x + 1 >= self.cells.len() || self.cells[x + 1].width != 0)
            {
                self.cells[x] = Cell::empty();
            }
        }
    }
}
