//! Unicode 17.0.0 text-cell policy.
//!
//! Grapheme boundaries follow UAX #29 GB3–GB13 with pinned property data from
//! `GraphemeBreakProperty.txt`, `DerivedCoreProperties.txt` (InCB), and
//! `emoji-data.txt`. Width uses UAX #11 F/W and Emoji_Presentation from the
//! Unicode Character Database. Sources:
//! https://www.unicode.org/Public/17.0.0/ucd/auxiliary/GraphemeBreakProperty.txt
//! https://www.unicode.org/Public/17.0.0/ucd/DerivedCoreProperties.txt
//! https://www.unicode.org/Public/17.0.0/ucd/EastAsianWidth.txt
//! https://www.unicode.org/Public/17.0.0/ucd/emoji/emoji-data.txt
//!
//! Ambiguous-width characters occupy one cell. A cluster takes the maximum
//! base width (one or two), with emoji variation, keycap, RI flag pair, and
//! pictographic ZWJ clusters occupying two. Standalone combining marks take
//! one cell so the stream remains visible. Width is capped to the viewport;
//! a two-cell cluster on a one-column terminal becomes U+FFFD.

#[path = "unicode_data.rs"]
mod data;

fn has(ranges: &[(u32, u32)], c: u32) -> bool {
    let i = ranges.partition_point(|&(start, _)| start <= c);
    i > 0 && c <= ranges[i - 1].1
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Break {
    Other,
    Cr,
    Lf,
    Control,
    Extend,
    Zwj,
    Ri,
    Prepend,
    Spacing,
    L,
    V,
    T,
    Lv,
    Lvt,
}

fn property(ch: char) -> Break {
    let c = ch as u32;
    if has(data::GCB_CR, c) {
        Break::Cr
    } else if has(data::GCB_LF, c) {
        Break::Lf
    } else if has(data::GCB_CONTROL, c) {
        Break::Control
    } else if has(data::GCB_EXTEND, c) {
        Break::Extend
    } else if has(data::GCB_ZWJ, c) {
        Break::Zwj
    } else if has(data::GCB_REGIONAL_INDICATOR, c) {
        Break::Ri
    } else if has(data::GCB_PREPEND, c) {
        Break::Prepend
    } else if has(data::GCB_SPACINGMARK, c) {
        Break::Spacing
    } else if has(data::GCB_L, c) {
        Break::L
    } else if has(data::GCB_V, c) {
        Break::V
    } else if has(data::GCB_T, c) {
        Break::T
    } else if has(data::GCB_LV, c) {
        Break::Lv
    } else if has(data::GCB_LVT, c) {
        Break::Lvt
    } else {
        Break::Other
    }
}

fn pictographic(ch: char) -> bool {
    has(data::EMOJI_EXTENDED_PICTOGRAPHIC, ch as u32)
}
fn incb_consonant(ch: char) -> bool {
    has(data::INCB_CONSONANT, ch as u32)
}
fn incb_extend(ch: char) -> bool {
    has(data::INCB_EXTEND, ch as u32)
}
fn incb_linker(ch: char) -> bool {
    has(data::INCB_LINKER, ch as u32)
}

pub fn joins(previous: &str, next: char) -> bool {
    let Some(last) = previous.chars().last() else {
        return false;
    };
    let a = property(last);
    let b = property(next);
    if a == Break::Cr && b == Break::Lf {
        return true;
    }
    if matches!(a, Break::Cr | Break::Lf | Break::Control)
        || matches!(b, Break::Cr | Break::Lf | Break::Control)
    {
        return false;
    }
    if a == Break::L && matches!(b, Break::L | Break::V | Break::Lv | Break::Lvt) {
        return true;
    }
    if matches!(a, Break::Lv | Break::V) && matches!(b, Break::V | Break::T) {
        return true;
    }
    if matches!(a, Break::Lvt | Break::T) && b == Break::T {
        return true;
    }
    if matches!(b, Break::Extend | Break::Zwj | Break::Spacing) || a == Break::Prepend {
        return true;
    }
    if incb_consonant(next) {
        let mut linked = false;
        for ch in previous.chars().rev() {
            if incb_linker(ch) {
                linked = true;
            } else if !incb_extend(ch) {
                if linked && incb_consonant(ch) {
                    return true;
                }
                break;
            }
        }
    }
    if a == Break::Zwj && pictographic(next) {
        for ch in previous.chars().rev().skip(1) {
            if property(ch) == Break::Extend {
                continue;
            }
            if pictographic(ch) {
                return true;
            }
            break;
        }
    }
    if a == Break::Ri && b == Break::Ri {
        return previous
            .chars()
            .rev()
            .take_while(|&ch| property(ch) == Break::Ri)
            .count()
            % 2
            == 1;
    }
    false
}

pub fn width(cluster: &str) -> usize {
    let mut width = 0;
    let mut emoji = false;
    let mut text_presentation = false;
    let mut ri_count = 0;
    let mut keycap = false;
    let mut pictographic_zwj = false;
    let mut pictographic_seen = false;
    let mut base_seen = false;
    for ch in cluster.chars() {
        let c = ch as u32;
        if c == 0xfe0f {
            emoji = true;
        }
        if c == 0xfe0e {
            text_presentation = true;
        }
        if c == 0x20e3 {
            keycap = true;
        }
        if c == 0x200d && pictographic_seen {
            pictographic_zwj = true;
        }
        if pictographic(ch) {
            pictographic_seen = true;
        }
        if property(ch) == Break::Ri {
            ri_count += 1;
        }
        if !matches!(property(ch), Break::Extend | Break::Zwj | Break::Spacing) {
            base_seen = true;
            let wide = has(data::EAW_F, c)
                || has(data::EAW_W, c)
                || (has(data::EMOJI_EMOJI_PRESENTATION, c) && !text_presentation);
            width = width.max(if wide { 2 } else { 1 });
        }
    }
    if !base_seen {
        return 1;
    }
    if emoji || keycap || ri_count >= 2 || pictographic_zwj {
        width = 2;
    }
    if text_presentation && !emoji && width == 2 && !keycap && ri_count < 2 {
        width = 1;
    }
    width.max(1)
}
