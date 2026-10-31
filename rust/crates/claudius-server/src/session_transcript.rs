//! `GET /api/sessions/:id/transcript` and `GET /api/sessions/:id/search`:
//! ports of `app/api/sessions/[id]/transcript/route.ts` (a page of the
//! session's messages older than a cursor, for "scroll up to load older")
//! and `app/api/sessions/[id]/search/route.ts` (an in-session search).
//!
//! Both read the transcript with `getSessionMessages`
//! ([`sessions_store::messages`]), from `?dir=` or else the live session's
//! cwd. That reader never throws (a missing file, a bad id or a read error
//! is `[]`), so the TS `catch → 500 {error}` branches can't be reached.
//!
//! Search is a literal, case-insensitive substring match: the query is never
//! compiled as a regex (CLAUDE.md's ReDoS rule). It runs on UTF-16 units and
//! JS `toLowerCase`, as the TS does: the match index is taken in the lower-
//! cased text and applied to the original, so a character whose lower case
//! is longer (`İ` → `i̇`) shifts the snippet window, and a window edge can
//! split a surrogate pair. The response is written by hand so such a lone
//! surrogate prints as `JSON.stringify` prints it (`"\ud83d"`).

use axum::extract::{Path, RawQuery, State};
use axum::http::{StatusCode, header};
use axum::response::{IntoResponse, Response};
use claudius_agent::js;
use claudius_core::{log, sessions_store};
use serde_json::Value;

use crate::AppState;
use crate::body::thrown;

/// UTF-16 units of context on each side of the first match.
const SNIPPET_RADIUS: usize = 60;
const ELLIPSIS: u16 = 0x2026;

/// `new URL(req.url).searchParams.get(key)`: the value of the first pair
/// named `key`, both form-urlencoded (`+` is a space, `%XX` is a byte, a
/// malformed `%` stays literal, and the bytes decode as UTF-8 with U+FFFD for
/// invalid sequences).
pub fn search_param(query: Option<&str>, key: &str) -> Option<String> {
    query?
        .split('&')
        .filter(|pair| !pair.is_empty())
        .find_map(|pair| {
            let (k, v) = pair.split_once('=').unwrap_or((pair, ""));
            (form_decode(k) == key).then(|| form_decode(v))
        })
}

fn form_decode(s: &str) -> String {
    let b = s.as_bytes();
    let hex = |i: usize| b.get(i).and_then(|c| char::from(*c).to_digit(16));
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        match (b[i], hex(i + 1), hex(i + 2)) {
            (b'+', ..) => out.push(b' '),
            (b'%', Some(hi), Some(lo)) => {
                out.push((hi * 16 + lo) as u8);
                i += 2;
            }
            (c, ..) => out.push(c),
        }
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// `Math.min(200, Math.max(1, Number(raw ?? "50") || 50))`. It can be
/// fractional (`2.5`), which both routes observe.
pub fn page_limit(raw: Option<&str>) -> f64 {
    let n = js::to_number(raw.unwrap_or("50"));
    let n = if n.is_nan() || n == 0.0 { 50.0 } else { n };
    n.clamp(1.0, 200.0)
}

/// `searchParams.get("dir") || undefined`, else the live session's cwd.
fn project_dir(app: &AppState, id: &str, query: Option<&str>) -> Option<String> {
    search_param(query, "dir")
        .filter(|d| !d.is_empty())
        .or_else(|| app.mgr.get(id).map(|s| s.cwd.clone()))
}

/// [`sessions_store::messages`] off the async runtime.
async fn read_messages(
    id: String,
    dir: Option<String>,
    include_system: bool,
) -> Option<Vec<Value>> {
    tokio::task::spawn_blocking(move || {
        sessions_store::messages(&id, dir.as_deref(), include_system)
    })
    .await
    .ok()
}

fn json_text(status: StatusCode, body: String) -> Response {
    (status, [(header::CONTENT_TYPE, "application/json")], body).into_response()
}

// ───────────────────────────────── transcript ────────────────────────────────

/// The page `[start, end)` of `all` ending just before the message whose
/// `uuid` is `before` (or at the end), and `hasMore`. `None` when `before`
/// isn't there. With a fractional `limit` the TS `start` is fractional:
/// `slice` truncates it while `hasMore` (`start > 0`) does not.
pub fn page(all: &[Value], before: Option<&str>, limit: f64) -> Option<(usize, usize, bool)> {
    let end = match before {
        Some(b) => all
            .iter()
            .position(|m| m.get("uuid").and_then(Value::as_str) == Some(b))?,
        None => all.len(),
    };
    let start = (end as f64 - limit).max(0.0);
    Some((start as usize, end, start > 0.0))
}

pub async fn transcript(
    State(app): State<AppState>,
    Path(id): Path<String>,
    RawQuery(query): RawQuery,
) -> Response {
    let query = query.as_deref();
    let before = search_param(query, "before").filter(|b| !b.is_empty());
    let limit = page_limit(search_param(query, "limit").as_deref());
    let dir = project_dir(&app, &id, query);
    let Some(all) = read_messages(id, dir, true).await else {
        return thrown();
    };
    let Some((start, end, has_more)) = page(&all, before.as_deref(), limit) else {
        return json_text(
            StatusCode::BAD_REQUEST,
            r#"{"error":"before uuid not found"}"#.into(),
        );
    };
    let mut body = String::from(r#"{"messages":["#);
    for (i, m) in all[start..end].iter().enumerate() {
        if i > 0 {
            body.push(',');
        }
        body.push_str(&js::stringify(m));
    }
    body.push_str(r#"],"hasMore":"#);
    body.push_str(if has_more { "true}" } else { "false}" });
    json_text(StatusCode::OK, body)
}

// ─────────────────────────────────── search ──────────────────────────────────

/// One `SearchHit`; `snippet` is UTF-16 since it can hold a lone surrogate.
#[derive(Debug, Clone, PartialEq)]
pub struct Hit {
    pub message_uuid: Value,
    pub role: &'static str,
    pub snippet: Vec<u16>,
    pub score: usize,
}

/// `lower.indexOf(needle)` over UTF-16 units.
fn index_of(haystack: &[u16], needle: &[u16]) -> Option<usize> {
    if needle.is_empty() {
        return Some(0);
    }
    haystack.windows(needle.len()).position(|w| w == needle)
}

fn is_space(unit: u16) -> bool {
    // Every JS whitespace character is in the BMP; a surrogate never is one.
    char::from_u32(u32::from(unit)).is_some_and(js::is_whitespace)
}

/// The TS snippet for the first match of `needle` (lower-cased, UTF-16) in
/// `haystack`: the window's text with `/\s+/g` runs as one space, trimmed,
/// and `…` on each side the window doesn't reach an end of. `None` when there
/// is no match.
pub fn snippet(haystack: &str, needle: &[u16]) -> Option<Vec<u16>> {
    let lower: Vec<u16> = haystack.to_lowercase().encode_utf16().collect();
    let index = index_of(&lower, needle)?;
    let text: Vec<u16> = haystack.encode_utf16().collect();
    let start = index.saturating_sub(SNIPPET_RADIUS);
    let end = (index + needle.len() + SNIPPET_RADIUS).min(text.len());
    let mut out = Vec::new();
    if start > 0 {
        out.push(ELLIPSIS);
    }
    let mut gap = false;
    let body_start = out.len();
    for &u in text.get(start..end).unwrap_or_default() {
        if is_space(u) {
            gap = true;
            continue;
        }
        if gap && out.len() > body_start {
            out.push(u16::from(b' '));
        }
        gap = false;
        out.push(u);
    }
    if end < text.len() {
        out.push(ELLIPSIS);
    }
    Some(out)
}

/// The search loop over `getSessionMessages(id, { dir })`: user and
/// assistant turns whose `stringifyContent(message.content)` matches, in
/// order, stopping once `hits.length >= limit`. `None` where the TS throws
/// (a turn with a missing or `null` `message`, or a `null` content block),
/// which Next turns into an empty 500.
pub fn search_hits(all: &[Value], query: &str, limit: f64) -> Option<Vec<Hit>> {
    let needle: Vec<u16> = query.to_lowercase().encode_utf16().collect();
    let mut hits = Vec::new();
    for m in all {
        let role = match m.get("type").and_then(Value::as_str) {
            Some("user") => "user",
            Some("assistant") => "assistant",
            _ => continue,
        };
        // `(m.message as { content?: unknown }).content`
        let message = m.get("message").filter(|v| !v.is_null())?;
        let haystack = sessions_store::try_stringify_content(message.get("content"))?;
        if haystack.is_empty() {
            continue;
        }
        let Some(snippet) = snippet(&haystack, &needle) else {
            continue;
        };
        hits.push(Hit {
            message_uuid: m.get("uuid").cloned().unwrap_or(Value::Null),
            role,
            snippet,
            score: hits.len(),
        });
        if hits.len() as f64 >= limit {
            break;
        }
    }
    Some(hits)
}

/// `JSON.stringify` of a UTF-16 string ([`js::stringify_utf16`]).
pub use claudius_agent::js::stringify_utf16 as utf16_json;

/// `JSON.stringify({ hits })`.
pub fn hits_json(hits: &[Hit]) -> String {
    let mut out = String::from(r#"{"hits":["#);
    for (i, h) in hits.iter().enumerate() {
        if i > 0 {
            out.push(',');
        }
        out.push_str(r#"{"messageUuid":"#);
        out.push_str(&js::stringify(&h.message_uuid));
        out.push_str(r#","role":""#);
        out.push_str(h.role);
        out.push_str(r#"","snippet":"#);
        utf16_json(&h.snippet, &mut out);
        out.push_str(&format!(r#","score":{}}}"#, h.score));
    }
    out.push_str("]}");
    out
}

pub async fn search(
    State(app): State<AppState>,
    Path(id): Path<String>,
    RawQuery(query): RawQuery,
) -> Response {
    let query = query.as_deref();
    let q = search_param(query, "q").unwrap_or_default();
    let limit = page_limit(search_param(query, "limit").as_deref());
    let dir = project_dir(&app, &id, query);
    if js::trim(&q).is_empty() {
        return json_text(StatusCode::OK, r#"{"hits":[]}"#.into());
    }
    let Some(all) = read_messages(id.clone(), dir, false).await else {
        return thrown();
    };
    match search_hits(&all, &q, limit) {
        Some(hits) => json_text(StatusCode::OK, hits_json(&hits)),
        None => {
            tracing::error!(
                target: log::API,
                "[api/sessions/{id}/search] TypeError: a turn without a message or with a null content block"
            );
            thrown()
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn u(s: &str) -> Vec<u16> {
        s.encode_utf16().collect()
    }

    #[test]
    fn search_params_are_first_wins_and_form_decoded() {
        let q = Some("limit=2&limit=5&q=a+b%2Bc&x&%71=late&dir=&bad=%ZZ%4&bom=%EF%BB%BF%FF");
        assert_eq!(search_param(q, "limit").as_deref(), Some("2"));
        assert_eq!(search_param(q, "q").as_deref(), Some("a b+c"));
        assert_eq!(search_param(q, "x").as_deref(), Some(""));
        assert_eq!(search_param(q, "dir").as_deref(), Some(""));
        assert_eq!(search_param(q, "bad").as_deref(), Some("%ZZ%4"));
        assert_eq!(search_param(q, "bom").as_deref(), Some("\u{feff}\u{fffd}"));
        assert_eq!(search_param(q, "LIMIT"), None);
        assert_eq!(search_param(None, "q"), None);
        assert_eq!(search_param(Some("%71=x"), "q").as_deref(), Some("x"));
        assert_eq!(search_param(Some("&&q=1&"), "q").as_deref(), Some("1"));
        assert_eq!(search_param(Some("q=a=b"), "q").as_deref(), Some("a=b"));
    }

    #[test]
    fn limit_coercion_matches_math_min_max() {
        for (raw, want) in [
            (None, 50.0),
            (Some(""), 50.0),
            (Some("0"), 50.0),
            (Some("-0"), 50.0),
            (Some("abc"), 50.0),
            (Some("inf"), 50.0),
            (Some("1_0"), 50.0),
            (Some("-1"), 1.0),
            (Some("-Infinity"), 1.0),
            (Some("0.5"), 1.0),
            (Some("2.5"), 2.5),
            (Some(" 3 "), 3.0),
            (Some("+4"), 4.0),
            (Some("1e1"), 10.0),
            (Some("0x2"), 2.0),
            (Some("0b11"), 3.0),
            (Some("0o7"), 7.0),
            (Some("999"), 200.0),
            (Some("Infinity"), 200.0),
            (Some("1e400"), 200.0),
            (Some(".5e1"), 5.0),
            (Some("5."), 5.0),
        ] {
            assert_eq!(page_limit(raw), want, "{raw:?}");
        }
    }

    #[test]
    fn to_number_grammar() {
        for s in [
            "0x",
            "-0x1",
            "1e",
            "1e+",
            ".",
            "+",
            "e5",
            "1.2.3",
            "Infinityx",
            "NaN",
            "0x1g",
        ] {
            assert!(js::to_number(s).is_nan(), "{s:?}");
        }
        assert_eq!(js::to_number(" \t"), 0.0, "blank is 0, not NaN");
        assert_eq!(js::to_number("\u{feff}\u{a0}12\u{3000}"), 12.0);
        assert!(js::to_number("\u{85}1").is_nan(), "NEL isn't JS whitespace");
        assert_eq!(js::to_number("0XfF"), 255.0);
        assert_eq!(js::to_number("-.5"), -0.5);
        assert_eq!(js::to_number("1E-2"), 0.01);
        assert_eq!(
            js::to_number("0x1fffffffffffff1"),
            0x1fffffffffffff1_u64 as f64,
            "rounded once"
        );
    }

    #[test]
    fn page_edges() {
        let all: Vec<Value> = (1..=5).map(|i| json!({"uuid": format!("u{i}")})).collect();
        assert_eq!(page(&all, None, 50.0), Some((0, 5, false)));
        assert_eq!(page(&all, None, 2.0), Some((3, 5, true)));
        assert_eq!(page(&all, None, 5.0), Some((0, 5, false)));
        assert_eq!(page(&all, None, 2.5), Some((2, 5, true)));
        assert_eq!(page(&all, Some("u4"), 2.5), Some((0, 3, true)), "start 0.5");
        assert_eq!(page(&all, Some("u3"), 2.5), Some((0, 2, false)));
        assert_eq!(page(&all, Some("u1"), 1.0), Some((0, 0, false)));
        assert_eq!(page(&all, Some("u9"), 1.0), None);
        assert_eq!(page(&[], None, 1.0), Some((0, 0, false)));
        assert_eq!(
            page(&[json!({"uuid": 1})], Some("1"), 1.0),
            None,
            "strict equality"
        );
    }

    #[test]
    fn snippets_follow_the_lower_cased_index() {
        let s = |h: &str, n: &str| {
            snippet(h, &u(&n.to_lowercase())).map(|v| String::from_utf16_lossy(&v))
        };
        assert_eq!(s("Hello World", "WORLD").as_deref(), Some("Hello World"));
        assert_eq!(s("Hello", "x"), None);
        let long = format!("{} Mid {}", "a".repeat(70), "b".repeat(70));
        let want = format!("…{} Mid {}…", "a".repeat(59), "b".repeat(59));
        assert_eq!(s(&long, "mid").as_deref(), Some(want.as_str()));
        // `İ` lower-cases to two units, so the window lands 3 units late.
        let drift = format!("{}x{}", "İ".repeat(3), "z".repeat(100));
        let want = format!("İİİx{}…", "z".repeat(63));
        assert_eq!(s(&drift, "x").as_deref(), Some(want.as_str()));
        // Past the end of the original: an empty body between the dots.
        let far = format!("{}q", "İ".repeat(100));
        assert_eq!(s(&far, "q").as_deref(), Some("…"));
        // Whitespace runs collapse (JS `\s`: not NEL, but BOM and NBSP), then trim.
        assert_eq!(
            s(" \t a\u{a0}\u{feff} b\u{85}c\u{2028} ", "b").as_deref(),
            Some("a b\u{85}c")
        );
    }

    #[test]
    fn lone_surrogates_and_escapes_serialize_like_json_stringify() {
        let cut = snippet(&format!("😀{}N", "y".repeat(59)), &u("n")).unwrap();
        assert_eq!(cut[0], ELLIPSIS);
        assert_eq!(cut[1], 0xde00, "the low half of 😀");
        let mut out = String::new();
        utf16_json(&cut[..3], &mut out);
        assert_eq!(out, "\"…\\ude00y\"");
        let mut out = String::new();
        utf16_json(&u("\"\\\u{1}\u{8}\u{c}\r\n\t\u{7f}\u{2028}é😀"), &mut out);
        assert_eq!(out, "\"\\\"\\\\\\u0001\\b\\f\\r\\n\\t\u{7f}\u{2028}é😀\"");
        assert_eq!(snippet("😀NEEDLE", &u("needle")).map(|v| v.len()), Some(8));
    }

    #[test]
    fn hits_stop_at_the_limit_and_throw_like_the_ts() {
        let turn = |ty: &str, uuid: &str, content: Value| json!({"type": ty, "uuid": uuid, "message": {"content": content}});
        let all = vec![
            turn("user", "a", json!("hit one")),
            json!({"type": "system", "uuid": "s", "message": {"content": "hit system"}}),
            turn(
                "assistant",
                "b",
                json!([{"type": "text", "text": "HIT two"}]),
            ),
            turn("user", "c", json!("miss")),
            turn("user", "d", json!("hit three")),
        ];
        let hits = search_hits(&all, "Hit", 50.0).unwrap();
        assert_eq!(
            hits.iter().map(|h| (h.role, h.score)).collect::<Vec<_>>(),
            [("user", 0), ("assistant", 1), ("user", 2)]
        );
        assert_eq!(search_hits(&all, "hit", 2.0).unwrap().len(), 2);
        assert_eq!(search_hits(&all, "hit", 2.5).unwrap().len(), 3);
        // A `.*` query is a literal, not a pattern.
        assert!(search_hits(&all, ".*", 50.0).unwrap().is_empty());
        let mut holed = all.clone();
        holed.insert(1, json!({"type": "assistant", "uuid": "h"}));
        assert_eq!(search_hits(&holed, "hit", 50.0), None);
        assert_eq!(
            search_hits(&holed, "hit", 1.0).unwrap().len(),
            1,
            "stops first"
        );
        holed[1] = turn("user", "n", json!([null]));
        assert_eq!(search_hits(&holed, "zzz", 50.0), None);
        holed[1] = json!({"type": "user", "uuid": "m", "message": "bare"});
        assert_eq!(search_hits(&holed, "bare", 50.0).unwrap().len(), 0);
        assert_eq!(
            hits_json(&search_hits(&all, "one", 50.0).unwrap()),
            r#"{"hits":[{"messageUuid":"a","role":"user","snippet":"hit one","score":0}]}"#
        );
    }
}
