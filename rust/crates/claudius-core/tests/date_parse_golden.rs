//! [`date_parse`] against node 22's own `Date.parse` (V8's `DateParser`:
//! the ES date-time format, then the legacy fallback), recorded by
//! `rust/scripts/date-parse-golden.mjs` into
//! `tests/fixtures/date_parse_golden.json` under the fixture's `TZ`:
//! hand-written forms and edges, what `Date`'s own formatters print, and
//! seeded token soups, field templates and mutations.
use claudius_core::js_date::date_parse;
use serde_json::Value;

#[test]
fn date_parse_matches_node() {
    let fx: Value = serde_json::from_str(include_str!("fixtures/date_parse_golden.json")).unwrap();
    // SAFETY: the only test in this binary, and nothing has read the
    // environment (or jiff's cached system zone) yet.
    unsafe { std::env::set_var("TZ", fx["tz"].as_str().unwrap()) };
    let cases = fx["cases"].as_array().unwrap();
    assert!(cases.len() > 10_000, "{} strings", cases.len());
    let mut failures = Vec::new();
    for c in cases {
        let s = c[0].as_str().unwrap();
        let want = c[1].as_i64();
        let got = date_parse(s);
        if got != want {
            failures.push(format!("{s:?}: node {want:?}, port {got:?}"));
        }
    }
    let parsed = cases.iter().filter(|c| !c[1].is_null()).count();
    assert!(parsed > 4_000, "only {parsed} strings parse");
    assert!(
        failures.is_empty(),
        "{} of {} differ:\n{}",
        failures.len(),
        cases.len(),
        failures[..failures.len().min(60)].join("\n")
    );
}
