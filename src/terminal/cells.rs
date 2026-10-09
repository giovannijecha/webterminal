//! Terminal cells and immutable identities for ordered rendering updates.
use std::sync::atomic::{AtomicU64, Ordering};

pub const FG: &str = "#d4d4d4";
pub const BG: &str = "#121314";
static NEXT_LINE: AtomicU64 = AtomicU64::new(1);

pub struct PutOptions {
    pub width: usize,
    pub cols: usize,
    pub wrap: bool,
    pub insert: bool,
    pub record: bool,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Style {
    pub fg: String,
    pub bg: String,
    pub attrs: u16,
    pub link: String,
}

impl Default for Style {
    fn default() -> Self {
        Self {
            fg: FG.into(),
            bg: BG.into(),
            attrs: 0,
            link: String::new(),
        }
    }
}
impl Style {
    pub fn erase(&self) -> Self {
        Self {
            fg: FG.into(),
            bg: self.bg.clone(),
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
}

#[derive(Clone, Debug)]
pub struct Line {
    pub revision: u64,
    pub wrapped: bool,
    pub cells: Vec<Cell>,
}

impl Line {
    pub fn new(cols: usize) -> Self {
        Self {
            revision: NEXT_LINE.fetch_add(1, Ordering::Relaxed),
            wrapped: false,
            cells: vec![Cell::empty(); cols],
        }
    }
    pub fn filled(cols: usize, style: &Style) -> Self {
        Self {
            revision: NEXT_LINE.fetch_add(1, Ordering::Relaxed),
            wrapped: false,
            cells: vec![Cell::blank(style); cols],
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
}
