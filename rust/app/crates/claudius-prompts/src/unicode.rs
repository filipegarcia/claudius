//! `lib/shared/invisible-unicode.ts`, the parts the cards use: the
//! permission card shows hidden / bidi characters as `‹U+XXXX›` tokens
//! (`visualizeInvisibleUnicode`, and the wider name set for the MCP badge,
//! claudius-core's `visualize_hidden_name_unicode`), and the ask's paste
//! into "Other" strips them (`stripInvisibleUnicode`).

use claudius_core::js_string;

/// `INVISIBLE_UNICODE_RE` (invisible-unicode.ts:55): zero-width space, word
/// joiner, BOM, the bidi embeddings / overrides / isolates and the tag
/// block. A lone surrogate is never in it.
pub fn is_invisible(c: char) -> bool {
    if js_string::lone_unit(c).is_some() {
        return false;
    }
    matches!(
        c as u32,
        0x200B | 0x2060 | 0xFEFF | 0x202A..=0x202E | 0x2066..=0x2069 | 0xE0001 | 0xE0020..=0xE007F
    )
}

/// `BIDI_CONTROL_RE` (invisible-unicode.ts:59).
fn is_bidi_control(c: char) -> bool {
    matches!(c as u32, 0x202A..=0x202E | 0x2066..=0x2069)
}

/// `‹U+XXXX›`: upper-case hex, at least four digits (`visualizeMatches`).
fn token(cp: u32) -> String {
    format!("\u{2039}U+{cp:04X}\u{203A}")
}

/// `visualizeInvisibleUnicode(text)` (invisible-unicode.ts:153): the text
/// with each invisible character as its token, and how many there were.
pub fn visualize_invisible_unicode(text: &str) -> (String, usize) {
    let mut out = String::with_capacity(text.len());
    let mut count = 0;
    for c in text.chars() {
        if is_invisible(c) {
            count += 1;
            out.push_str(&token(c as u32));
        } else {
            out.push(c);
        }
    }
    (out, count)
}

/// U+16910 BAMUM LETTER PHASE-D NGKEURI: `HIDDEN_NAME_CHAR_RE` lists it
/// (CC 2.1.321, invisible-unicode.ts:170), claudius-core's set predates it.
const BAMUM_NGKEURI: char = '\u{16910}';

/// `visualizeHiddenNameUnicode(text)` (invisible-unicode.ts:178):
/// claudius-core's port of the set, plus [`BAMUM_NGKEURI`].
pub fn visualize_hidden_name_unicode(text: &str) -> (String, usize) {
    let mut out = String::with_capacity(text.len());
    let mut count = 0;
    for part in text.split_inclusive(BAMUM_NGKEURI) {
        let (head, bamum) = match part.strip_suffix(BAMUM_NGKEURI) {
            Some(h) => (h, true),
            None => (part, false),
        };
        let (v, n) = claudius_core::skill_names::visualize_hidden_name_unicode(head);
        out.push_str(&v);
        count += n;
        if bamum {
            out.push_str(&token(BAMUM_NGKEURI as u32));
            count += 1;
        }
    }
    (out, count)
}

/// What [`strip_invisible_unicode`] returns.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Stripped {
    pub cleaned: String,
    pub removed_count: usize,
    pub bidi_count: usize,
}

/// `stripInvisibleUnicode(text)` (invisible-unicode.ts:67).
pub fn strip_invisible_unicode(text: &str) -> Stripped {
    let mut cleaned = String::with_capacity(text.len());
    let (mut removed_count, mut bidi_count) = (0, 0);
    for c in text.chars() {
        if is_invisible(c) {
            removed_count += 1;
            if is_bidi_control(c) {
                bidi_count += 1;
            }
        } else {
            cleaned.push(c);
        }
    }
    Stripped {
        cleaned,
        removed_count,
        bidi_count,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn visualize_invisible_unicode_tokens_each_hidden_char() {
        let (v, n) = visualize_invisible_unicode("a\u{200B}b\u{202E}c\u{E0041}\u{200D}");
        assert_eq!(
            v,
            "a\u{2039}U+200B\u{203A}b\u{2039}U+202E\u{203A}c\u{2039}U+E0041\u{203A}\u{200D}"
        );
        assert_eq!(n, 3);
        // ZWNJ / ZWJ stay (emoji, Persian).
        assert_eq!(visualize_invisible_unicode("\u{200C}\u{200D}").1, 0);
        // The range edges.
        for c in [
            '\u{2060}',
            '\u{FEFF}',
            '\u{202A}',
            '\u{2066}',
            '\u{2069}',
            '\u{E0001}',
            '\u{E0020}',
            '\u{E007F}',
        ] {
            assert!(is_invisible(c), "{:X}", c as u32);
        }
        for c in [
            '\u{2029}',
            '\u{2065}',
            '\u{206A}',
            '\u{E0000}',
            '\u{E0002}',
            '\u{E0080}',
            '\u{202F}',
        ] {
            assert!(!is_invisible(c), "{:X}", c as u32);
        }
        assert!(!is_invisible(js_string::lone(0xD800)));
    }

    #[test]
    fn visualize_hidden_name_unicode_adds_the_bamum_letter() {
        assert_eq!(
            visualize_hidden_name_unicode("a\u{16910}b\u{3164}\u{16910}"),
            (
                "a\u{2039}U+16910\u{203A}b\u{2039}U+3164\u{203A}\u{2039}U+16910\u{203A}".to_owned(),
                3
            )
        );
        assert_eq!(
            visualize_hidden_name_unicode("plain"),
            ("plain".to_owned(), 0)
        );
    }

    #[test]
    fn strip_invisible_unicode_counts_bidi_apart() {
        let s = strip_invisible_unicode("x\u{2066}y\u{200B}z\u{202A}");
        assert_eq!(
            s,
            Stripped {
                cleaned: "xyz".into(),
                removed_count: 3,
                bidi_count: 2
            }
        );
    }
}
