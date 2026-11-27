//! The Sessions page's pure rules, ported from the TS:
//! `lib/shared/session-search.ts` (the ranked name search),
//! `lib/shared/session-search-older.ts` (what a no-match search does next),
//! `lib/shared/session-pagination.ts` (the page size), and the page's own
//! `fmtRelative` / `fmtBytes`, with the en-US `toLocale*String` forms the
//! one-session page prints. `tests/sessions_golden.rs` replays the TS
//! recording (`rust/scripts/sessions-page-golden.mjs`).

use chrono::{DateTime, Datelike as _, TimeZone, Timelike as _};

/// `SESSION_PAGE_SIZE`: the first page, and each "Load more".
pub const SESSION_PAGE_SIZE: u32 = 200;

/// `OLDER_SEARCH_STEP`: how many sessions a no-match search auto-loads
/// before asking to go on.
pub const OLDER_SEARCH_STEP: u32 = SESSION_PAGE_SIZE * 5;

/// JS `WhiteSpace` + `LineTerminator`: what `trim()` strips and `\s`
/// matches (not Rust's `White_Space`: U+FEFF is in, U+0085 out).
pub fn is_js_space(c: char) -> bool {
    matches!(
        c,
        '\u{9}' | '\u{a}' | '\u{b}' | '\u{c}' | '\u{d}' | ' ' | '\u{a0}' | '\u{1680}' | '\u{2000}'
            ..='\u{200a}'
                | '\u{2028}'
                | '\u{2029}'
                | '\u{202f}'
                | '\u{205f}'
                | '\u{3000}'
                | '\u{feff}'
    )
}

/// `String.prototype.trim`.
pub fn js_trim(s: &str) -> &str {
    s.trim_matches(is_js_space)
}

/// `String.prototype.trimStart`.
pub fn js_trim_start(s: &str) -> &str {
    s.trim_start_matches(is_js_space)
}

/// `String.prototype.toLowerCase` (the full mappings, final sigma
/// included, as V8's).
pub fn js_lower(s: &str) -> String {
    s.to_lowercase()
}

/// `s.length`: UTF-16 units.
pub fn utf16_len(s: &str) -> usize {
    s.encode_utf16().count()
}

/// `parseSessionQuery`'s answer.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ParsedQuery {
    pub text: String,
    /// A leading `n:` (any case): names only.
    pub names_only: bool,
}

/// `parseSessionQuery(raw)`: trimmed; a leading `n:` (`/^n:\s*/i`) means
/// names only and is cut with the space after it.
pub fn parse_session_query(raw: &str) -> ParsedQuery {
    let trimmed = js_trim(raw);
    let mut chars = trimmed.chars();
    let prefixed = matches!(chars.next(), Some('n' | 'N')) && chars.next() == Some(':');
    if prefixed {
        return ParsedQuery {
            text: trimmed[2..].trim_start_matches(is_js_space).to_owned(),
            names_only: true,
        };
    }
    ParsedQuery {
        text: trimmed.to_owned(),
        names_only: false,
    }
}

/// The fields a session is ranked on (`SessionSearchFields`).
#[derive(Clone, Copy, Debug, Default)]
pub struct SearchFields<'a> {
    pub custom_title: Option<&'a str>,
    pub claudius_title: Option<&'a str>,
    pub first_prompt: Option<&'a str>,
    pub session_id: &'a str,
}

const TITLE_EXACT: u32 = 100;
const TITLE_PREFIX: u32 = 80;
const TITLE_SUBSTR: u32 = 60;
const PROMPT_SUBSTR: u32 = 40;
const ID_SUBSTR: u32 = 20;
/// The page's score for a transcript-body match (below any field match).
pub const CONTENT_MATCH: u32 = 10;

fn title_score(title: Option<&str>, q: &str) -> u32 {
    let Some(title) = title.filter(|t| !t.is_empty()) else {
        return 0;
    };
    let t = js_lower(title);
    if t == q {
        TITLE_EXACT
    } else if t.starts_with(q) {
        TITLE_PREFIX
    } else if t.contains(q) {
        TITLE_SUBSTR
    } else {
        0
    }
}

/// `scoreSession(fields, q, namesOnly)` for a lowercased, non-empty `q`:
/// the best tier (title exact 100, prefix 80, substring 60; first prompt
/// 40; id 20 unless names only), or `None`.
pub fn score_session(f: SearchFields<'_>, q: &str, names_only: bool) -> Option<u32> {
    let title = title_score(f.custom_title, q).max(title_score(f.claudius_title, q));
    if title > 0 {
        return Some(title);
    }
    if js_lower(f.first_prompt.unwrap_or_default()).contains(q) {
        return Some(PROMPT_SUBSTR);
    }
    if !names_only && js_lower(f.session_id).contains(q) {
        return Some(ID_SUBSTR);
    }
    None
}

/// The page's ranking: `items` that match `query` (parsed, lowered), best
/// first; a stable sort, so a tier keeps the list's order. An empty query
/// keeps everything as it is. `extra` scores what no field matches (the
/// transcript-body hit, outside names-only mode).
pub fn rank<'a, T: Copy + 'a>(
    items: Vec<T>,
    query: &str,
    fields: impl Fn(T) -> SearchFields<'a>,
    extra: impl Fn(T) -> Option<u32>,
) -> Vec<T> {
    let parsed = parse_session_query(query);
    let q = js_lower(&parsed.text);
    if q.is_empty() {
        return items;
    }
    let mut scored: Vec<(T, u32)> = items
        .into_iter()
        .filter_map(|it| {
            let score = score_session(fields(it), &q, parsed.names_only)
                .or_else(|| if parsed.names_only { None } else { extra(it) });
            score.map(|s| (it, s))
        })
        .collect();
    scored.sort_by_key(|s| std::cmp::Reverse(s.1));
    scored.into_iter().map(|(it, _)| it).collect()
}

/// `OlderSearchState`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum OlderSearch {
    /// No query, matches found, or the first load.
    Idle,
    /// Fetch the next page now.
    Load,
    /// A page is in flight while the query has no match.
    Searching,
    /// Stopped (the ceiling, or a failed fetch) with more possibly on disk.
    Capped,
    /// Everything is loaded and nothing matches.
    None,
}

impl OlderSearch {
    pub fn as_str(self) -> &'static str {
        match self {
            OlderSearch::Idle => "idle",
            OlderSearch::Load => "load",
            OlderSearch::Searching => "searching",
            OlderSearch::Capped => "capped",
            OlderSearch::None => "none",
        }
    }
}

/// `OlderSearchInput`.
#[derive(Clone, Debug, Default)]
pub struct OlderSearchInput<'a> {
    pub query: &'a str,
    pub match_count: usize,
    pub loaded_count: usize,
    pub has_more: bool,
    pub loading: bool,
    pub failed: bool,
    pub ceiling: u32,
}

/// `olderSearchState(input)`.
pub fn older_search_state(i: &OlderSearchInput<'_>) -> OlderSearch {
    if js_trim(i.query).is_empty() || i.match_count > 0 {
        return OlderSearch::Idle;
    }
    if i.loading {
        return if i.loaded_count > 0 {
            OlderSearch::Searching
        } else {
            OlderSearch::Idle
        };
    }
    if i.failed {
        return if i.loaded_count > 0 {
            OlderSearch::Capped
        } else {
            OlderSearch::Idle
        };
    }
    if !i.has_more {
        return OlderSearch::None;
    }
    if i.loaded_count as u64 >= u64::from(i.ceiling) {
        return OlderSearch::Capped;
    }
    OlderSearch::Load
}

/// `nextOlderSearchCeiling(ceiling, loadedCount)`.
pub fn next_older_search_ceiling(ceiling: u32, loaded_count: usize) -> u32 {
    let loaded = u32::try_from(loaded_count).unwrap_or(u32::MAX);
    ceiling.max(loaded).saturating_add(OLDER_SEARCH_STEP)
}

/// `hasMoreSessions(returned, requested)`: a full page back means more may
/// exist.
pub fn has_more_sessions(returned: usize, requested_limit: i64) -> bool {
    requested_limit > 0 && returned as i64 >= requested_limit
}

/// The page's `fmtRelative(ms)` against `now_ms`: `just now`, `5m ago`,
/// `3h ago`, then the date (`toLocaleDateString()`, which `date` writes).
pub fn fmt_relative_with(ms: f64, now_ms: f64, date: impl Fn(f64) -> String) -> String {
    let diff = now_ms - ms;
    if diff < 60_000. {
        "just now".into()
    } else if diff < 3_600_000. {
        format!("{}m ago", (diff / 60_000.).floor())
    } else if diff < 86_400_000. {
        format!("{}h ago", (diff / 3_600_000.).floor())
    } else {
        date(ms)
    }
}

/// [`fmt_relative_with`] in local time.
pub fn fmt_relative(ms: f64, now_ms: f64) -> String {
    fmt_relative_with(ms, now_ms, |ms| locale_date(&chrono::Local, ms))
}

/// `toFixed(1)` of `n / scale` (a power of two, so the quotient is exact):
/// the nearest tenth, a tie going up, as `toFixed` picks.
fn tenths(n: f64, scale: f64) -> String {
    let x = n / scale;
    let t = if n.fract() == 0. && n < 9.0e15 {
        // Exact: (n * 10 + scale / 2) / scale, floored.
        ((n * 10. + scale / 2.) / scale).floor()
    } else {
        (x * 10.).round()
    };
    format!("{}.{}", (t / 10.).floor(), t % 10.)
}

/// The page's `fmtBytes(n)`: `—` for none or 0, `512 B`, `1.3 KB`, `5.3 MB`.
pub fn fmt_bytes(n: Option<f64>) -> String {
    let Some(n) = n.filter(|n| *n != 0. && !n.is_nan()) else {
        return "\u{2014}".into();
    };
    if n < 1024. {
        format!("{n} B")
    } else if n < 1024. * 1024. {
        format!("{} KB", tenths(n, 1024.))
    } else {
        format!("{} MB", tenths(n, 1024. * 1024.))
    }
}

fn at<Tz: TimeZone>(tz: &Tz, ms: f64) -> Option<DateTime<Tz>> {
    if !ms.is_finite() {
        return None;
    }
    tz.timestamp_millis_opt(ms as i64).single()
}

/// `new Date(ms).toLocaleDateString()` in en-US: `11/26/2026`.
pub fn locale_date<Tz: TimeZone>(tz: &Tz, ms: f64) -> String {
    match at(tz, ms) {
        Some(d) => format!("{}/{}/{}", d.month(), d.day(), d.year()),
        None => "Invalid Date".into(),
    }
}

/// `new Date(ms).toLocaleString()` in en-US: `11/26/2026, 8:00:00 PM`.
pub fn locale_string<Tz: TimeZone>(tz: &Tz, ms: f64) -> String {
    let Some(d) = at(tz, ms) else {
        return "Invalid Date".into();
    };
    let (pm, h) = d.hour12();
    format!(
        "{}/{}/{}, {h}:{:02}:{:02} {}",
        d.month(),
        d.day(),
        d.year(),
        d.minute(),
        d.second(),
        if pm { "PM" } else { "AM" }
    )
}

/// A whole number's `toLocaleString()` in en-US: `12,345`.
pub fn locale_number(n: i64) -> String {
    let digits = n.unsigned_abs().to_string();
    let mut out = String::new();
    for (i, c) in digits.chars().enumerate() {
        if i > 0 && (digits.len() - i).is_multiple_of(3) {
            out.push(',');
        }
        out.push(c);
    }
    if n < 0 {
        out.insert(0, '-');
    }
    out
}
