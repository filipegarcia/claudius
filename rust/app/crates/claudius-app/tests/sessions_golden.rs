//! Replays `tests/fixtures/sessions_page_golden.json`, recorded from the TS
//! by `rust/scripts/sessions-page-golden.mjs`: `parseSessionQuery`,
//! `scoreSession` and the page's ranking, `toLowerCase`, the older-session
//! search and the page size, the page's `fmtRelative` / `fmtBytes`, and
//! the en-US `toLocale*String` forms (recorded in UTC).

use chrono::Utc;
use claudius_app::sessions::search::{
    self, OLDER_SEARCH_STEP, OlderSearchInput, SESSION_PAGE_SIZE, SearchFields,
};
use serde_json::Value;

fn golden() -> Value {
    serde_json::from_str(include_str!("fixtures/sessions_page_golden.json")).unwrap()
}

fn section(g: &Value, name: &str) -> Vec<Value> {
    let cases = g["sections"][name].as_array().unwrap().clone();
    assert!(!cases.is_empty(), "{name}");
    cases
}

fn opt<'a>(v: &'a Value, k: &str) -> Option<&'a str> {
    v.get(k).and_then(Value::as_str)
}

fn fields(v: &Value) -> SearchFields<'_> {
    SearchFields {
        custom_title: opt(v, "customTitle"),
        claudius_title: opt(v, "claudiusTitle"),
        first_prompt: opt(v, "firstPrompt"),
        session_id: opt(v, "sessionId").unwrap(),
    }
}

#[test]
fn parse_matches_the_ts() {
    let g = golden();
    for c in section(&g, "parse") {
        let raw = c["raw"].as_str().unwrap();
        let got = search::parse_session_query(raw);
        assert_eq!(got.text, c["out"]["text"].as_str().unwrap(), "{raw:?}");
        assert_eq!(
            got.names_only,
            c["out"]["namesOnly"].as_bool().unwrap(),
            "{raw:?}"
        );
    }
}

#[test]
fn score_matches_the_ts() {
    let g = golden();
    for c in section(&g, "score") {
        let q = c["q"].as_str().unwrap();
        let names_only = c["namesOnly"].as_bool().unwrap();
        let got = search::score_session(fields(&c["fields"]), q, names_only);
        let want = c["out"].as_u64().map(|n| n as u32);
        assert_eq!(got, want, "{} {q:?} {names_only}", c["fields"]);
    }
}

#[test]
fn lowercase_matches_the_ts() {
    let g = golden();
    for c in section(&g, "lower") {
        let raw = c["raw"].as_str().unwrap();
        assert_eq!(search::js_lower(raw), c["out"].as_str().unwrap(), "{raw:?}");
    }
}

#[test]
fn rank_matches_the_page() {
    let g = golden();
    for c in section(&g, "rank") {
        let sessions = c["sessions"].as_array().unwrap();
        let filter = c["filter"].as_str().unwrap();
        let got: Vec<&str> = search::rank(
            sessions.iter().collect(),
            filter,
            |s: &Value| fields(s),
            |_| None,
        )
        .into_iter()
        .map(|s| opt(s, "sessionId").unwrap())
        .collect();
        let want: Vec<&str> = c["out"]
            .as_array()
            .unwrap()
            .iter()
            .map(|v| v.as_str().unwrap())
            .collect();
        assert_eq!(got, want, "{filter:?}");
    }
}

#[test]
fn a_transcript_hit_ranks_below_every_field_and_never_in_names_only() {
    let items = [("title-hit", "fix login"), ("body-only", "unrelated")];
    let run = |q: &str| -> Vec<&str> {
        search::rank(
            items.iter().collect(),
            q,
            |(id, t)| SearchFields {
                custom_title: Some(t),
                session_id: id,
                ..Default::default()
            },
            |(id, _)| (*id == "body-only").then_some(search::CONTENT_MATCH),
        )
        .into_iter()
        .map(|(id, _)| *id)
        .collect()
    };
    assert_eq!(run("login"), ["title-hit", "body-only"]);
    assert_eq!(run("n:login"), ["title-hit"]);
    assert_eq!(run("zzz"), ["body-only"]);
}

#[test]
fn older_search_matches_the_ts() {
    let g = golden();
    for c in section(&g, "older") {
        let i = &c["input"];
        let input = OlderSearchInput {
            query: i["query"].as_str().unwrap(),
            match_count: i["matchCount"].as_u64().unwrap() as usize,
            loaded_count: i["loadedCount"].as_u64().unwrap() as usize,
            has_more: i["hasMore"].as_bool().unwrap(),
            loading: i["loading"].as_bool().unwrap(),
            failed: i["failed"].as_bool().unwrap_or(false),
            ceiling: i["ceiling"].as_u64().unwrap() as u32,
        };
        assert_eq!(
            search::older_search_state(&input).as_str(),
            c["out"].as_str().unwrap(),
            "{i}"
        );
    }
    for c in section(&g, "ceiling") {
        let got = search::next_older_search_ceiling(
            c["ceiling"].as_u64().unwrap() as u32,
            c["loaded"].as_u64().unwrap() as usize,
        );
        assert_eq!(u64::from(got), c["out"].as_u64().unwrap(), "{c}");
    }
    for c in section(&g, "hasMore") {
        let got = search::has_more_sessions(
            c["returned"].as_u64().unwrap() as usize,
            c["limit"].as_i64().unwrap(),
        );
        assert_eq!(got, c["out"].as_bool().unwrap(), "{c}");
    }
    for c in section(&g, "constants") {
        let want = c["out"].as_u64().unwrap();
        match c["name"].as_str().unwrap() {
            "SESSION_PAGE_SIZE" => assert_eq!(u64::from(SESSION_PAGE_SIZE), want),
            "OLDER_SEARCH_STEP" => assert_eq!(u64::from(OLDER_SEARCH_STEP), want),
            other => panic!("{other}"),
        }
    }
}

#[test]
fn row_labels_match_the_page() {
    let g = golden();
    let now = g["now"].as_f64().unwrap();
    for c in section(&g, "relative") {
        let ms = c["ms"].as_f64().unwrap();
        let got = search::fmt_relative_with(ms, now, |ms| search::locale_date(&Utc, ms));
        assert_eq!(got, c["out"].as_str().unwrap(), "{ms}");
    }
    for c in section(&g, "bytes") {
        let got = search::fmt_bytes(c["n"].as_f64());
        assert_eq!(got, c["out"].as_str().unwrap(), "{}", c["n"]);
    }
}

#[test]
fn locale_forms_match_the_ts() {
    let g = golden();
    for c in section(&g, "localeString") {
        let ms = c["ms"].as_f64().unwrap();
        assert_eq!(
            search::locale_string(&Utc, ms),
            c["out"].as_str().unwrap(),
            "{ms}"
        );
    }
    for c in section(&g, "localeDate") {
        let ms = c["ms"].as_f64().unwrap();
        assert_eq!(
            search::locale_date(&Utc, ms),
            c["out"].as_str().unwrap(),
            "{ms}"
        );
    }
    for c in section(&g, "localeNumber") {
        let n = c["n"].as_i64().unwrap();
        assert_eq!(search::locale_number(n), c["out"].as_str().unwrap(), "{n}");
    }
    assert_eq!(search::locale_string(&Utc, f64::NAN), "Invalid Date");
    assert_eq!(search::locale_date(&Utc, f64::INFINITY), "Invalid Date");
    assert_eq!(search::locale_number(-1234), "-1,234");
}

#[test]
fn js_whitespace_is_not_rusts() {
    assert_eq!(search::js_trim("\u{feff} a \u{feff}"), "a");
    assert_eq!(search::js_trim("\u{85}a\u{85}"), "\u{85}a\u{85}");
    assert_eq!(search::js_trim_start("\u{2028}\u{3000}x "), "x ");
    assert_eq!(search::utf16_len("a\u{1f680}"), 3);
    assert_eq!(search::fmt_bytes(Some(f64::NAN)), "\u{2014}");
    assert_eq!(search::fmt_bytes(None), "\u{2014}");
}
