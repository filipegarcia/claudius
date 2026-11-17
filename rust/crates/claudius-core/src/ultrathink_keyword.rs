//! `lib/shared/ultrathink-keyword.ts` (CC 2.1.311): the engine's quote- and
//! path-aware keyword finder, which gates the per-turn "deeper reasoning"
//! reminder (`session::ultrathink_reminder_body`).
//!
//! Everything here runs on UTF-16 code units, like the TS: the span scan
//! indexes `text[i]`, the regex is a non-`u` `/\bultrathink\b/gi` (ASCII
//! `\b` and ASCII-only case folding), and `isWordChar` is `/[\p{L}\p{N}_]/u`
//! over one unit — so a lone surrogate (half an astral character) is never a
//! word character. The properties come from ICU4X (Unicode 17, like node
//! 22's ICU 78), as in [`crate::skill_names`].
//!
//! Replayed against the TS in `tests/reminders_golden.rs`.

use icu_properties::CodePointMapData;
use icu_properties::props::{GeneralCategory, GeneralCategoryGroup};

use crate::js_string;

/// `SPAN_CLOSERS`: opener → closer of a span the keyword is ignored in.
fn span_closer(unit: u16) -> Option<u16> {
    let pair = |open: u8, close: u8| (unit == u16::from(open)).then(|| u16::from(close));
    pair(b'`', b'`')
        .or_else(|| pair(b'"', b'"'))
        .or_else(|| pair(b'<', b'>'))
        .or_else(|| pair(b'{', b'}'))
        .or_else(|| pair(b'[', b']'))
        .or_else(|| pair(b'(', b')'))
        .or_else(|| pair(b'\'', b'\''))
}

/// `/[\p{L}\p{N}_]/u` on one UTF-16 unit: a surrogate half matches nothing.
fn is_word_unit(unit: Option<u16>) -> bool {
    let Some(u) = unit else { return false };
    if u == u16::from(b'_') {
        return true;
    }
    if (0xD800..0xE000).contains(&u) {
        return false;
    }
    let gc = CodePointMapData::<GeneralCategory>::new().get32(u32::from(u));
    GeneralCategoryGroup::Letter.contains(gc) || GeneralCategoryGroup::Number.contains(gc)
}

/// `/\w/` of a non-`u` regex: `[A-Za-z0-9_]`, for the `\b` tests.
fn is_ascii_word(unit: Option<u16>) -> bool {
    let Some(u) = unit else { return false };
    u < 128 && ((u as u8).is_ascii_alphanumeric() || u as u8 == b'_')
}

/// `KeywordMatch`: UTF-16 unit offsets into the scanned text.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct KeywordMatch {
    pub start: usize,
    pub end: usize,
}

/// `findKeyword(text, keyword)`. `keyword` must be plain lowercase ASCII (it
/// is one of this module's constants, never user input).
pub fn find_keyword(text: &str, keyword: &str) -> Vec<KeywordMatch> {
    if !js_string::to_lower(text).contains(keyword) {
        return Vec::new();
    }
    if text.starts_with('/') {
        return Vec::new();
    }
    let units = js_string::units(text);
    let at = |i: usize| units.get(i).copied();
    // `i - 1` at i = 0 is `text[-1]`, i.e. `undefined`.
    let before = |i: usize| if i == 0 { None } else { at(i - 1) };

    // Pass 1 — quoted / bracketed spans.
    let mut spans: Vec<(usize, usize)> = Vec::new();
    let mut opener: Option<u16> = None;
    let mut span_start = 0usize;
    for (i, &ch) in units.iter().enumerate() {
        if let Some(open) = opener {
            // A nested `[` restarts the bracket span (`[[x]]` → the inner).
            if open == u16::from(b'[') && ch == u16::from(b'[') {
                span_start = i;
                continue;
            }
            if Some(ch) != span_closer(open) {
                continue;
            }
            if open == u16::from(b'\'') && is_word_unit(at(i + 1)) {
                continue;
            }
            spans.push((span_start, i + 1));
            opener = None;
        } else {
            // `<` only opens before `/[a-zA-Z/]/`.
            let tag_open = ch == u16::from(b'<')
                && at(i + 1).is_some_and(|n| {
                    n < 128 && ((n as u8).is_ascii_alphabetic() || n == u16::from(b'/'))
                });
            let quote_open = ch == u16::from(b'\'') && !is_word_unit(before(i));
            let plain_open =
                ch != u16::from(b'<') && ch != u16::from(b'\'') && span_closer(ch).is_some();
            if tag_open || quote_open || plain_open {
                opener = Some(ch);
                span_start = i;
            }
        }
    }

    // Pass 2 — whole-word matches outside those spans, not part of a path.
    // `\bultrathink\b` of a non-`u` `gi` regex, scanned by hand: the keyword
    // is ASCII, so folding is ASCII and matches can't overlap.
    let kw: Vec<u8> = keyword.as_bytes().to_vec();
    let mut out = Vec::new();
    let mut si = 0usize;
    let mut i = 0usize;
    while i + kw.len() <= units.len() {
        let hit = kw.iter().enumerate().all(|(k, want)| {
            let u = units[i + k];
            u < 128 && (u as u8).to_ascii_lowercase() == *want
        });
        if !hit {
            i += 1;
            continue;
        }
        let start = i;
        let end = i + kw.len();
        i = end;
        if is_ascii_word(before(start)) || is_ascii_word(at(end)) {
            continue;
        }
        // The spans are sorted and non-overlapping, so one forward pointer
        // is enough (TS's own linear check).
        while si < spans.len() && spans[si].1 <= start {
            si += 1;
        }
        if si < spans.len() && start >= spans[si].0 {
            continue;
        }
        let bef = before(start);
        let aft = at(end);
        let is = |u: Option<u16>, c: u8| u == Some(u16::from(c));
        if is(bef, b'/') || is(bef, b'\\') || is(bef, b'-') {
            continue;
        }
        if is(aft, b'/') || is(aft, b'\\') || is(aft, b'-') || is(aft, b'?') {
            continue;
        }
        if is(aft, b'.') && is_word_unit(at(end + 1)) {
            continue;
        }
        out.push(KeywordMatch { start, end });
    }
    out
}

/// `hasUltrathinkKeyword(text, pastes)`: each paste is collapsed back to the
/// `[Pasted text]` placeholder the engine scans, so a keyword that only
/// appears inside pasted text doesn't count — and quotes or a leading `/`
/// inside a paste can't hide one the user typed. Non-string entries never
/// reach here (the caller keeps strings only), and an empty one is skipped.
pub fn has_ultrathink_keyword(text: &str, pastes: &[String]) -> bool {
    if !js_string::to_lower(text).contains("ultrathink") {
        return false;
    }
    let mut scan = text.to_owned();
    for p in pastes {
        if p.is_empty() {
            continue;
        }
        scan = split_join(&scan, p, "[Pasted text]");
    }
    !find_keyword(&scan, "ultrathink").is_empty()
}

/// `s.split(sep).join(with)` for a non-empty `sep`, on UTF-16 units like
/// JS: a paste that is half of a surrogate pair splits that pair.
fn split_join(s: &str, sep: &str, with: &str) -> String {
    let (hay, needle) = (js_string::units(s), js_string::units(sep));
    let with = js_string::units(with);
    let mut out = Vec::with_capacity(hay.len());
    let mut i = 0;
    while i < hay.len() {
        if hay[i..].starts_with(&needle) {
            out.extend_from_slice(&with);
            i += needle.len();
        } else {
            out.push(hay[i]);
            i += 1;
        }
    }
    js_string::from_units(&out)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn hit(text: &str) -> bool {
        has_ultrathink_keyword(text, &[])
    }

    #[test]
    fn plain_prose_matches() {
        assert!(hit("ultrathink"));
        assert!(hit("ULTRATHINK"));
        assert!(hit("please Ultrathink. now"));
        assert!(hit("$ultrathink$"));
        assert!(!hit("ultrathinking"));
        assert!(!hit(""));
    }

    #[test]
    fn quoted_and_bracketed_spans_are_skipped() {
        assert!(!hit("(ultrathink)"));
        assert!(!hit("`ultrathink`"));
        assert!(!hit("\"ultrathink\""));
        assert!(!hit("[ultrathink]"));
        assert!(!hit("{ultrathink}"));
        // `<b>` is its own span, so what follows it is prose.
        assert!(hit("<b>ultrathink</b>"));
        assert!(!hit("<ultrathink>"));
        // An opener that never closes pushes no span (TS only records a
        // span once it sees the closer), so the keyword still counts.
        assert!(hit("(ultrathink"));
        // `[[x]]` restarts at the inner bracket.
        assert!(!hit("[[ultrathink]]"));
        // `<` only opens before a letter or `/`.
        assert!(hit("1 < 2 ultrathink"));
        // A span that closes before the keyword doesn't cover it.
        assert!(hit("(quoted) ultrathink"));
    }

    #[test]
    fn apostrophes_in_words_open_nothing() {
        assert!(hit("don't ultrathink"));
        assert!(hit("it's ultrathink"));
        // A `'` after a word character opens nothing.
        assert!(hit("x'ultrathink'y"));
        assert!(!hit("'ultrathink'"));
    }

    #[test]
    fn paths_and_flags_are_skipped() {
        assert!(!hit("docs/ultrathink.md"));
        assert!(!hit("--ultrathink-mode"));
        assert!(!hit("ultrathink?"));
        assert!(!hit("C:\\ultrathink\\x"));
        // A trailing `.` not followed by a word character is prose.
        assert!(hit("ultrathink."));
    }

    #[test]
    fn a_slash_prefixed_prompt_never_matches() {
        assert!(!hit("/compact ultrathink"));
    }

    #[test]
    fn pastes_collapse_to_the_placeholder() {
        assert!(!has_ultrathink_keyword(
            "look: ultrathink",
            &["ultrathink".to_owned()]
        ));
        assert!(has_ultrathink_keyword(
            "ultrathink and look: paste",
            &["paste".to_owned()]
        ));
        // A paste's own quotes can't hide a typed keyword.
        assert!(has_ultrathink_keyword(
            "(x) ultrathink",
            &["(x)".to_owned()]
        ));
        assert!(!has_ultrathink_keyword("x", &["".to_owned()]));
        // A paste that is half of a surrogate pair splits it, as in JS.
        let lo = js_string::lone(0xDE00);
        assert!(!has_ultrathink_keyword(
            "\u{1F600}ultrathink",
            &[format!("{lo}ultrathink")]
        ));
    }

    #[test]
    fn lone_surrogates_are_not_word_characters() {
        let hi = js_string::lone(0xD83D);
        let text = format!("{hi}ultrathink{hi}");
        assert!(hit(&text));
    }
}
