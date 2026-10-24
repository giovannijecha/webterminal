//! Terminal-owned default colors and the sixteen theme-sensitive ANSI colors.
use std::fmt::Write;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct TerminalPalette {
    pub foreground: [u8; 3],
    pub background: [u8; 3],
    pub ansi: [[u8; 3]; 16],
}

impl TerminalPalette {
    pub const DARK: Self = Self {
        foreground: [204, 204, 204],
        background: [30, 30, 30],
        ansi: [
            [0, 0, 0],
            [205, 49, 49],
            [13, 188, 121],
            [229, 229, 16],
            [36, 114, 200],
            [188, 63, 188],
            [17, 168, 205],
            [229, 229, 229],
            [102, 102, 102],
            [241, 76, 76],
            [35, 209, 139],
            [245, 245, 67],
            [59, 142, 234],
            [214, 112, 214],
            [41, 184, 219],
            [255, 255, 255],
        ],
    };

    pub const LIGHT: Self = Self {
        foreground: [39, 39, 42],
        background: [251, 251, 251],
        ansi: [
            [0, 0, 0],
            [163, 21, 21],
            [16, 124, 16],
            [121, 94, 0],
            [4, 81, 165],
            [138, 38, 125],
            [0, 108, 112],
            [85, 85, 85],
            [89, 89, 89],
            [197, 15, 31],
            [15, 110, 59],
            [122, 100, 0],
            [0, 90, 158],
            [160, 0, 160],
            [0, 119, 128],
            [118, 118, 118],
        ],
    };

    pub(crate) fn indexed(self, index: u8) -> [u8; 3] {
        if index < 16 {
            self.ansi[index as usize]
        } else {
            super::cells::Color::Indexed(index).rgb([0, 0, 0])
        }
    }
}

fn css(out: &mut String, [r, g, b]: [u8; 3]) {
    let _ = write!(out, "\"#{r:02x}{g:02x}{b:02x}\"");
}

fn palette_json(palette: TerminalPalette) -> String {
    let mut out = String::from("{\"fg\":");
    css(&mut out, palette.foreground);
    out.push_str(",\"bg\":");
    css(&mut out, palette.background);
    out.push_str(",\"ansi\":[");
    for (index, rgb) in palette.ansi.into_iter().enumerate() {
        if index != 0 {
            out.push(',');
        }
        css(&mut out, rgb);
    }
    out.push_str("]}");
    out
}

/// Static theme palettes for the browser's initial `hello` message.
pub fn palettes_json() -> String {
    format!(
        "{{\"dark\":{},\"light\":{}}}",
        palette_json(TerminalPalette::DARK),
        palette_json(TerminalPalette::LIGHT)
    )
}
