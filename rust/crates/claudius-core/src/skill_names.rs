//! The name rules of the Skills page: `lib/shared/skill-names.ts`
//! (`isEngineShownName`, `isEngineOfferableName`: the bundled 2.1.299
//! engine's `wMo` / `Rj` predicates), `visualizeHiddenNameUnicode` from
//! `lib/shared/invisible-unicode.ts`, and the folder-name rule of
//! `lib/server/skills.ts` (`isValidSkillDirName`).
//!
//! The TS rules are `u`-flag regexes over Unicode properties. Here they are
//! written out over the same properties from ICU4X's compiled data
//! (`icu_properties`), which is Unicode 17 like node 22's ICU 78, so a
//! code point the regex crate's Unicode 16 tables call unassigned still
//! reads as V8 reads it. Strings are JS strings: a lone surrogate is a
//! [`js_string`] stand-in and counts as the surrogate code point (`Cs`).
//! Replayed against node over every code point and a few hundred names in
//! `tests/skills_hooks_golden.rs`.

use icu_properties::props::{
    DefaultIgnorableCodePoint, GeneralCategory, GeneralCategoryGroup, Script, SoftDotted,
};
use icu_properties::{CodePointMapData, CodePointSetData};

use crate::js_string;

/// The engine's own wording, verbatim, for the "not offered" refusal.
pub const ENGINE_NAME_RULE_MESSAGE: &str = "a name may not hold hidden, direction-changing or blank-like characters, < or >, or be over 256 characters";

/// Engine cap, in UTF-16 code units (it compares `name.length`).
pub const MAX_ENGINE_NAME_LENGTH: usize = 256;

/// The JS code points of `s` (`for (const c of s)`): a stand-in is its
/// surrogate.
fn code_points(s: &str) -> Vec<u32> {
    s.chars()
        .map(|c| js_string::lone_unit(c).map_or(c as u32, u32::from))
        .collect()
}

fn gc(cp: u32) -> GeneralCategory {
    CodePointMapData::<GeneralCategory>::new().get32(cp)
}

fn in_group(cp: u32, group: GeneralCategoryGroup) -> bool {
    group.contains(gc(cp))
}

/// `\p{L}`, `\p{M}`, `\p{N}`.
fn is_letter(cp: u32) -> bool {
    in_group(cp, GeneralCategoryGroup::Letter)
}
fn is_m(cp: u32) -> bool {
    in_group(cp, GeneralCategoryGroup::Mark)
}
fn is_number(cp: u32) -> bool {
    in_group(cp, GeneralCategoryGroup::Number)
}

/// `\p{Default_Ignorable_Code_Point}`.
fn is_default_ignorable(cp: u32) -> bool {
    CodePointSetData::new::<DefaultIgnorableCodePoint>().contains32(cp)
}

/// `\p{Soft_Dotted}`.
fn is_soft_dotted(cp: u32) -> bool {
    CodePointSetData::new::<SoftDotted>().contains32(cp)
}

fn script(cp: u32) -> Script {
    CodePointMapData::<Script>::new().get32(cp)
}

/// `\p{Cc}\p{Cf}\p{Cs}\p{Co}\p{Cn}`.
fn is_other(cp: u32) -> bool {
    matches!(
        gc(cp),
        GeneralCategory::Control
            | GeneralCategory::Format
            | GeneralCategory::Surrogate
            | GeneralCategory::PrivateUse
            | GeneralCategory::Unassigned
    )
}

/// `(?! )\p{Zs}`: a space separator other than the plain space.
fn is_odd_space(cp: u32) -> bool {
    cp != 0x20 && gc(cp) == GeneralCategory::SpaceSeparator
}

/// The object replacement character and its format-like kin.
const BLANK_LIKE: [u32; 5] = [0xFFFC, 0x1D159, 0x13441, 0x13442, 0x16FE4];

/// `HIDDEN_OR_ANGLE_RE`'s class.
fn hidden_or_angle(cp: u32) -> bool {
    is_other(cp) || matches!(cp, 0x2028 | 0x2029 | 0x2800 | 0x3C | 0x3E) || is_default_ignorable(cp)
}

/// `MARK`: `[\p{M}\u{1160}-\u{11FF}\u{D7B0}-\u{D7FF}]`.
fn is_mark(cp: u32) -> bool {
    is_m(cp) || (0x1160..=0x11FF).contains(&cp) || (0xD7B0..=0xD7FF).contains(&cp)
}

/// `BLANK_LIKE_RE.test(name)`.
fn blank_like(cps: &[u32]) -> bool {
    cps.iter()
        .any(|&cp| is_odd_space(cp) || BLANK_LIKE.contains(&cp))
        || cps.first() == Some(&0x20)
        || cps.last() == Some(&0x20)
}

/// `MARK_ABUSE_RE.test(name)`: a mark with no letter, digit or mark before
/// it; nine marks in a row; a dot above (U+0307) among the marks after a
/// soft-dotted letter; a mark right after a dotless i or j; or a mark that
/// isn't `Inherited` on a Latin / Common base (through any marks between).
fn mark_abuse(cps: &[u32]) -> bool {
    let n = cps.len();
    for i in 0..n {
        let c = cps[i];
        if is_mark(c) {
            // `(?<![\p{L}\p{N}\p{M}])MARK`
            if i == 0 || {
                let p = cps[i - 1];
                !(is_letter(p) || is_number(p) || is_m(p))
            } {
                return true;
            }
            // `MARK{9}`
            if i + 9 <= n && cps[i..i + 9].iter().all(|&x| is_mark(x)) {
                return true;
            }
            // `(?<=[\p{sc=Latin}\p{sc=Common}]MARK*)(?!\p{sc=Inherited})MARK`
            if script(c) != Script::Inherited {
                let mut j = i;
                while j > 0 {
                    j -= 1;
                    let s = script(cps[j]);
                    if s == Script::Latin || s == Script::Common {
                        return true;
                    }
                    if !is_mark(cps[j]) {
                        break;
                    }
                }
            }
        }
        // `\p{Soft_Dotted}\p{M}*\u{0307}`
        if is_soft_dotted(c) {
            for &x in &cps[i + 1..] {
                if x == 0x307 {
                    return true;
                }
                if !is_m(x) {
                    break;
                }
            }
        }
        // `[\u{0131}\u{0237}]\p{M}`
        if (c == 0x131 || c == 0x237) && cps.get(i + 1).is_some_and(|&x| is_m(x)) {
            return true;
        }
    }
    false
}

/// `COLON_SPACING_RE.test(name)`: a space next to a `:`, or a `:` (or a
/// space) at either end.
fn colon_spacing(name: &str) -> bool {
    name.starts_with(' ')
        || name.contains(": ")
        || name.contains(" :")
        || name.ends_with(' ')
        || name.starts_with(':')
        || name.ends_with(':')
}

/// `isEngineShownName(name)`: non-empty, at most 256 UTF-16 units, no
/// hidden / direction-changing / blank-like characters, no `<` `>`, no
/// double space, no misplaced or piled-up combining marks.
pub fn is_engine_shown_name(name: &str) -> bool {
    let len = js_string::len16(name);
    if len == 0 || len > MAX_ENGINE_NAME_LENGTH {
        return false;
    }
    let cps = code_points(name);
    !cps.iter().any(|&cp| hidden_or_angle(cp))
        && !blank_like(&cps)
        && !name.contains("  ")
        && !mark_abuse(&cps)
}

/// `isEngineOfferableName(name)`: the base rule, plus no space beside a
/// `:` and no leading or trailing `:`.
pub fn is_engine_offerable_name(name: &str) -> bool {
    is_engine_shown_name(name) && !colon_spacing(name)
}

/// `HIDDEN_NAME_CHAR_RE`'s match.
fn hidden_name_char(cp: u32) -> bool {
    is_other(cp)
        || matches!(cp, 0x2028 | 0x2029 | 0x2800)
        || BLANK_LIKE.contains(&cp)
        || is_default_ignorable(cp)
        || is_odd_space(cp)
}

/// `visualizeHiddenNameUnicode(text)`: every character the engine treats as
/// hidden or blank-like as `‹U+XXXX›` (upper-case hex, at least four
/// digits), and how many there were.
pub fn visualize_hidden_name_unicode(text: &str) -> (String, usize) {
    let mut out = String::with_capacity(text.len());
    let mut count = 0;
    for c in text.chars() {
        let cp = js_string::lone_unit(c).map_or(c as u32, u32::from);
        if hidden_name_char(cp) {
            count += 1;
            out.push_str(&format!("\u{2039}U+{cp:04X}\u{203A}"));
        } else {
            out.push(c);
        }
    }
    (out, count)
}

/// `isValidSkillDirName(name)`: `/^(?!\.)[\p{L}\p{M}\p{N}_.\-]+$/u`, so
/// letters, marks and digits of any script plus `_ . -`, not starting with
/// a dot.
pub fn is_valid_skill_dir_name(name: &str) -> bool {
    let cps = code_points(name);
    !cps.is_empty()
        && cps[0] != u32::from(b'.')
        && cps.iter().all(|&cp| {
            matches!(cp, 0x5F | 0x2E | 0x2D) || is_letter(cp) || is_m(cp) || is_number(cp)
        })
}

/// Which of the properties the rules read hold for `cp`, as the bits the
/// golden recorder writes (tests only).
#[doc(hidden)]
pub fn property_bits(cp: u32) -> u32 {
    let flags = [
        is_letter(cp),
        is_m(cp),
        is_number(cp),
        gc(cp) == GeneralCategory::Control,
        gc(cp) == GeneralCategory::Format,
        gc(cp) == GeneralCategory::Surrogate,
        gc(cp) == GeneralCategory::PrivateUse,
        gc(cp) == GeneralCategory::Unassigned,
        is_default_ignorable(cp),
        gc(cp) == GeneralCategory::SpaceSeparator,
        is_soft_dotted(cp),
        script(cp) == Script::Latin,
        script(cp) == Script::Common,
        script(cp) == Script::Inherited,
    ];
    flags
        .iter()
        .enumerate()
        .fold(0, |acc, (i, &on)| acc | (u32::from(on) << i))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names() {
        assert!(is_valid_skill_dir_name("caf\u{e9}-x_1.2"));
        assert!(is_valid_skill_dir_name("\u{4e2d}\u{6587}"));
        for bad in ["", ".x", "a b", "a/b", "a:b", "..", "a\u{fffd}"] {
            assert!(!is_valid_skill_dir_name(bad), "{bad:?}");
        }
        assert!(is_engine_offerable_name("deploy"));
        assert!(!is_engine_offerable_name("deploy\u{3164}"));
        assert!(!is_engine_shown_name(&"a".repeat(257)));
        assert!(is_engine_shown_name(&"a".repeat(256)));
        // Unicode 17 (node 22's ICU 78): a Sidetic letter is assigned.
        assert!(is_letter(0x10940));
        assert_eq!(
            visualize_hidden_name_unicode("a\u{3164}b\u{a0}"),
            (
                "a\u{2039}U+3164\u{203A}b\u{2039}U+00A0\u{203A}".to_owned(),
                2
            )
        );
    }
}
