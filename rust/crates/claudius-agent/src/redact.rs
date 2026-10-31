//! The SDK's secret redaction, `up()`. It masks bearer/basic credentials,
//! API keys and tokens before the SDK quotes text it doesn't control: the
//! CLI's stderr in an exit error (`formatStderrTail`), and the stderr buffer
//! each time it's trimmed.
//!
//! [`SDK_PATTERNS`] holds the SDK's patterns verbatim (`[...pVe, ...fVe]` in
//! sdk.mjs, as JS regex sources). [`translate`] turns each into `fancy-regex`
//! syntax with JS semantics: `\b`, `\w` and `\d` are ASCII-only, `\s` is JS
//! whitespace, and the non-unicode `i` flag folds ASCII letters only (so no
//! `ſ` for `s` or Kelvin sign for `k`). The patterns are fixed. Nothing here
//! ever compiles input.

use std::borrow::Cow;
use std::sync::LazyLock;

use fancy_regex::Regex;

/// `[source, flags, replacement]` for each pattern `up()` applies, in order.
/// `tests/redact_golden.rs` fails when the installed SDK's list differs.
pub const SDK_PATTERNS: [[&str; 3]; 18] = [
    [
        r"\bBearer\s+(?=[A-Za-z0-9._~+/=-](?:[A-Za-z0-9._~+/=-]|%[0-9A-Fa-f]{2}){7})[A-Za-z0-9._~+/=-](?:[A-Za-z0-9._~+/=-]+|%[0-9A-Fa-f]{2})*",
        "gi",
        "Bearer <token>",
    ],
    [r"(:\s*)Basic\s+[A-Za-z0-9+/=]{8,}", "gi", "$1Basic <token>"],
    [
        r"(?:\bsk-ant-[A-Za-z0-9_-]{8,}|sk-ant-(?=[A-Za-z0-9_-]{0,64}?(?=[A-Za-z0-9]{8})(?=[A-Za-z0-9]{0,64}[0-9])(?=[A-Za-z0-9]{0,64}[A-Za-z]))[A-Za-z0-9_-]{8,})",
        "g",
        "<token>",
    ],
    [
        r"(?:\bsk-(?:proj|svcacct|admin)-[A-Za-z0-9_-]{20,}|sk-(?:proj|svcacct|admin)-(?=[A-Za-z0-9_-]{0,64}?(?=[A-Za-z0-9]{20})(?=[A-Za-z0-9]{0,64}[0-9])(?=[A-Za-z0-9]{0,64}[A-Za-z]))[A-Za-z0-9_-]{20,})",
        "g",
        "<token>",
    ],
    [r"\bsk-[A-Za-z0-9_-]{20,}", "g", "<token>"],
    [
        r"(^|[^A-Za-z0-9+])(?:AKIA|ASIA|ABIA|ACCA|A3T[A-Z0-9])[A-Z0-9]{16}(?![A-Za-z0-9+=])",
        "g",
        "$1<token>",
    ],
    [
        r"(?:\bgh[opusr]_[A-Za-z0-9]{20,}|gh[opusr]_(?=[A-Za-z0-9]{0,64}[0-9])[A-Za-z0-9]{20,})",
        "g",
        "<token>",
    ],
    [r"github_pat_[A-Za-z0-9_]{82,}", "g", "<token>"],
    [r"sq0(?:atp|csp)-[A-Za-z0-9_-]{22,}", "g", "<token>"],
    [
        r"(^|[^A-Za-z0-9+/])EAAA[A-Za-z0-9+/=%_-]{56,}",
        "g",
        "$1<token>",
    ],
    [
        r"(?:\bgl(?:pat|dt|rt|ft|soat|oas|agent|ptt|cbt|imt|ffct)-[A-Za-z0-9_=-]{20,}(?:\.[0-9a-z]{9})?|gl(?:pat|dt|rt|ft|soat|oas|agent|ptt|cbt|imt|ffct)-(?=[A-Za-z0-9_=-]{0,64}[0-9])[A-Za-z0-9_=-]{20,}(?:\.[0-9a-z]{9})?)",
        "g",
        "<token>",
    ],
    [
        r"(?:\b(?:xox[abe-z](?:\.xox[a-z])?|xapp|xwfp)-(?=[A-Za-z0-9+/=%_-]{0,64}[0-9])[A-Za-z0-9+/=%_-]{10,}|(?:xox[abe-z](?:\.xox[a-z])?|xapp|xwfp)-(?=[0-9])[A-Za-z0-9+/=%_-]{10,})",
        "gi",
        "<token>",
    ],
    [
        r"(?:\bxox[cd]-[A-Za-z0-9+/=%_-]{10,}|xox[cd]-(?=[A-Za-z0-9+/=%_-]{0,64}[0-9])[A-Za-z0-9+/=%_-]{16,})",
        "gi",
        "<token>",
    ],
    [
        r"hooks\.slack\.com\/(?:services|workflows|triggers)\/[A-Za-z0-9/_-]+",
        "gi",
        "hooks.slack.com/<redacted>",
    ],
    [
        r"(?<![A-Za-z0-9_-])(?=[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{10}[A-Za-z0-9_-]*\.[A-Za-z0-9_-]{10}[A-Za-z0-9_-]*)((?:[A-Za-z0-9_-]*?-)??)ey[A-Za-z0-9_-]{10}[A-Za-z0-9_-]*\.[A-Za-z0-9_-]{10}[A-Za-z0-9_-]*\.[A-Za-z0-9_-]{10}[A-Za-z0-9_-]*",
        "g",
        "$1<jwt>",
    ],
    [
        r"(^|[^A-Za-z0-9+_-])AIza[A-Za-z0-9_-]{35}(?![A-Za-z0-9+=_-])",
        "g",
        "$1<token>",
    ],
    [
        r"(^|[^A-Za-z0-9+_-])GOCSPX-[A-Za-z0-9_-]{28}(?![A-Za-z0-9+=_-])",
        "g",
        "$1<token>",
    ],
    [
        r"(^|[^A-Za-z0-9+_-])[sr]k_(?:live|test|prod)_(?=[A-Za-z0-9]{0,64}[0-9])[A-Za-z0-9]{24,}(?![A-Za-z0-9+=_-])",
        "g",
        "$1<token>",
    ],
];

/// What a failed match turns the whole text into. A pattern can only fail at
/// runtime by exceeding the backtracking limit; masking everything then
/// keeps a secret from slipping through.
pub const REDACTION_FAILED: &str = "<redacted>";

/// JS `\s` (and `String.prototype.trim`'s set): WhiteSpace plus
/// LineTerminator. Unlike Unicode `White_Space`, it has U+FEFF and lacks
/// U+0085.
const JS_SPACE: &[(char, char)] = &[
    ('\t', '\r'),
    (' ', ' '),
    ('\u{a0}', '\u{a0}'),
    ('\u{1680}', '\u{1680}'),
    ('\u{2000}', '\u{200a}'),
    ('\u{2028}', '\u{2029}'),
    ('\u{202f}', '\u{202f}'),
    ('\u{205f}', '\u{205f}'),
    ('\u{3000}', '\u{3000}'),
    ('\u{feff}', '\u{feff}'),
];
const JS_WORD: &[(char, char)] = &[('0', '9'), ('A', 'Z'), ('_', '_'), ('a', 'z')];
const JS_DIGIT: &[(char, char)] = &[('0', '9')];
/// JS `.` without the `s` flag: anything but a line terminator.
const JS_NOT_DOT: &[(char, char)] = &[('\n', '\n'), ('\r', '\r'), ('\u{2028}', '\u{2029}')];

struct Compiled {
    re: Regex,
    replacement: String,
}

static COMPILED: LazyLock<Vec<Compiled>> = LazyLock::new(|| {
    SDK_PATTERNS
        .iter()
        .map(|[source, flags, replacement]| Compiled {
            re: Regex::new(&translate(source, flags)).expect("SDK redaction pattern"),
            replacement: translate_replacement(replacement),
        })
        .collect()
});

/// `up(text)`: every pattern in order, each replacing all its matches in the
/// previous one's output.
pub fn redact(text: &str) -> String {
    let mut out = Cow::Borrowed(text);
    for c in COMPILED.iter() {
        match c.re.try_replacen(&out, 0, c.replacement.as_str()) {
            Ok(Cow::Borrowed(_)) => {}
            Ok(Cow::Owned(s)) => out = Cow::Owned(s),
            Err(e) => {
                tracing::warn!("stderr redaction failed ({e}); masking all of it");
                return REDACTION_FAILED.to_owned();
            }
        }
    }
    out.into_owned()
}

/// A JS regex source (no `u`/`v` flag) as `fancy-regex` syntax with the same
/// meaning. Supports what redaction patterns use: groups and look-around,
/// classes, quantifiers (greedy and lazy), `^`/`$`, `.`, and the escapes
/// `\b \s \S \w \W \d \D` plus escaped punctuation. Panics on anything else,
/// so an SDK bump that needs more fails loudly in tests.
pub fn translate(source: &str, flags: &str) -> String {
    for f in flags.chars() {
        assert!(matches!(f, 'g' | 'i'), "unsupported JS regex flag {f:?}");
    }
    let fold = flags.contains('i');
    let chars: Vec<char> = source.chars().collect();
    let mut out = String::new();
    let mut i = 0;
    while i < chars.len() {
        let c = chars[i];
        i += 1;
        match c {
            '\\' => {
                let e = *chars.get(i).expect("dangling backslash");
                i += 1;
                match e {
                    'b' => out.push_str(
                        "(?:(?<![0-9A-Z_a-z])(?=[0-9A-Z_a-z])|(?<=[0-9A-Z_a-z])(?![0-9A-Z_a-z]))",
                    ),
                    'B' => out.push_str(
                        "(?:(?<![0-9A-Z_a-z])(?![0-9A-Z_a-z])|(?<=[0-9A-Z_a-z])(?=[0-9A-Z_a-z]))",
                    ),
                    's' | 'S' | 'w' | 'W' | 'd' | 'D' => {
                        out.push_str(&class(&[], &[e], e.is_ascii_uppercase(), false))
                    }
                    e if e.is_ascii_punctuation() => push_literal(&mut out, e),
                    e => panic!("unsupported JS regex escape \\{e}"),
                }
            }
            '[' => {
                let negated = chars.get(i) == Some(&'^');
                if negated {
                    i += 1;
                }
                let mut ranges = Vec::new();
                let mut shorthands = Vec::new();
                loop {
                    let c = *chars.get(i).expect("unterminated class");
                    i += 1;
                    let lo = match c {
                        ']' => break,
                        '\\' => {
                            let e = chars[i];
                            i += 1;
                            if matches!(e, 's' | 'S' | 'w' | 'W' | 'd' | 'D') {
                                assert!(
                                    e.is_ascii_lowercase(),
                                    "negated shorthand \\{e} in a class"
                                );
                                shorthands.push(e);
                                continue;
                            }
                            assert!(e.is_ascii_punctuation(), "unsupported class escape \\{e}");
                            e
                        }
                        c => c,
                    };
                    if chars.get(i) == Some(&'-') && chars.get(i + 1).is_some_and(|c| *c != ']') {
                        let mut hi = chars[i + 1];
                        i += 2;
                        if hi == '\\' {
                            hi = chars[i];
                            i += 1;
                            assert!(hi.is_ascii_punctuation(), "unsupported class escape \\{hi}");
                        }
                        assert!(lo <= hi, "bad class range {lo}-{hi}");
                        ranges.push((lo, hi));
                    } else {
                        ranges.push((lo, lo));
                    }
                }
                assert!(
                    !(negated && fold),
                    "negated class under the i flag isn't supported"
                );
                out.push_str(&class(&ranges, &shorthands, negated, fold));
            }
            '.' => out.push_str(&class(JS_NOT_DOT, &[], true, false)),
            c if fold && c.is_ascii_alphabetic() => {
                out.push_str(&class(&[(c, c)], &[], false, true))
            }
            // Group syntax, quantifiers, alternation and anchors read the
            // same in both dialects; letters and digits are literals.
            c if c.is_ascii_alphanumeric() || "()?:=!<|*+{},^$-_%/~ \"'#&;@`".contains(c) => {
                out.push(c)
            }
            c if c.is_ascii() => panic!("unexpected {c:?} in a JS regex source"),
            c => push_literal(&mut out, c),
        }
    }
    out
}

/// A JS replacement string (`$1`, `$&`, `$$`) in `fancy-regex` syntax.
pub fn translate_replacement(js: &str) -> String {
    let mut out = String::new();
    let mut chars = js.chars().peekable();
    while let Some(c) = chars.next() {
        if c != '$' {
            out.push(c);
            continue;
        }
        match chars.peek().copied() {
            Some('$') => {
                chars.next();
                out.push_str("$$");
            }
            Some('&') => {
                chars.next();
                out.push_str("${0}");
            }
            Some(d @ '1'..='9') => {
                chars.next();
                out.push_str(&format!("${{{d}}}"));
            }
            Some(e) if matches!(e, '`' | '\'' | '<') || e.is_ascii_digit() => {
                panic!("unsupported JS replacement ${e}")
            }
            // Any other `$` is literal.
            _ => out.push_str("$$"),
        }
    }
    out
}

fn push_literal(out: &mut String, c: char) {
    out.push_str(&format!("\\x{{{:x}}}", c as u32));
}

/// A class over `ranges` plus shorthand sets, every member hex-escaped (so
/// no `-`, `&&` or `~~` is ever read as class syntax). `fold` adds the other
/// case of each ASCII letter.
fn class(ranges: &[(char, char)], shorthands: &[char], negated: bool, fold: bool) -> String {
    let mut all: Vec<(char, char)> = ranges.to_vec();
    for s in shorthands {
        all.extend_from_slice(match s.to_ascii_lowercase() {
            's' => JS_SPACE,
            'w' => JS_WORD,
            'd' => JS_DIGIT,
            _ => unreachable!(),
        });
    }
    if fold {
        let mut extra = Vec::new();
        for &(lo, hi) in &all {
            for (a, b, shift) in [('a', 'z', -32i32), ('A', 'Z', 32)] {
                let (l, h) = (lo.max(a), hi.min(b));
                if l <= h {
                    let swap = |c: char| char::from_u32((c as i32 + shift) as u32).unwrap();
                    extra.push((swap(l), swap(h)));
                }
            }
        }
        all.extend(extra);
    }
    let mut out = String::from(if negated { "[^" } else { "[" });
    for (lo, hi) in all {
        push_literal(&mut out, lo);
        if hi != lo {
            out.push('-');
            push_literal(&mut out, hi);
        }
    }
    out.push(']');
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_pattern_compiles() {
        assert_eq!(COMPILED.len(), SDK_PATTERNS.len());
    }

    #[test]
    fn js_semantics() {
        let t = |src: &str, flags: &str, text: &str| {
            Regex::new(&translate(src, flags))
                .unwrap()
                .is_match(text)
                .unwrap()
        };
        // `\b` is an ASCII word boundary.
        assert!(t(r"\bx", "g", "éx"));
        assert!(!t(r"\bx", "g", "_x"));
        assert!(t(r"x\b", "g", "xé"));
        // `\s` is JS whitespace: BOM yes, NEL no.
        assert!(t(r"a\sb", "g", "a\u{feff}b"));
        assert!(!t(r"a\sb", "g", "a\u{85}b"));
        // The non-unicode `i` flag folds ASCII letters only.
        assert!(t("Basic", "gi", "bASIC"));
        assert!(!t("s", "gi", "\u{17f}"));
        assert!(!t("k", "gi", "\u{212a}"));
        assert!(t("[abe-z]", "gi", "Q"));
        assert!(!t("[abe-z]", "gi", "C"));
        assert!(t(r"[\w-]", "g", "-"));
        assert!(!t(r"[\w-]", "g", "é"));
        // Class syntax that would mean set operations in Rust is literal.
        assert!(t("[~~]", "g", "~"));
        assert!(t("[a&&b]", "g", "&"));
        assert!(t(r"\/", "g", "/"));
        assert!(!t(".", "g", "\u{2028}"));
        assert!(t(".", "g", "\u{85}"));
    }

    #[test]
    #[should_panic(expected = "unsupported JS regex escape")]
    fn unknown_escapes_fail_loudly() {
        translate(r"\1", "g");
    }

    #[test]
    #[should_panic(expected = "unsupported JS regex flag")]
    fn unknown_flags_fail_loudly() {
        translate("a", "gu");
    }

    #[test]
    fn js_replacements() {
        assert_eq!(translate_replacement("$1<token>"), "${1}<token>");
        assert_eq!(translate_replacement("a$$b$&c$"), "a$$b${0}c$$");
        assert_eq!(translate_replacement("$x"), "$$x");
    }

    #[test]
    fn redacts_like_up() {
        assert_eq!(
            redact("Authorization: bearer abcdefgh12 and sk-ant-api03-abcdefgh1234"),
            "Authorization: Bearer <token> and <token>"
        );
        assert_eq!(redact("no secrets"), "no secrets");
    }
}
