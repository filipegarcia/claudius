//! Replays the `parsers` half of `fixtures/git_golden.json`, recorded by
//! `rust/scripts/git-golden.mjs` from the real `lib/server/git.ts`: the
//! private `parseBranchHeader` and the two regex tests (`/^Binary files /m`,
//! `gitShow`'s missing-blob test) sliced out of the source, the exported
//! `parsePorcelainV1Z`, and the message `execFile` throws for a NUL byte in
//! an argument. Results are compared as `JSON.stringify` text. (The `steps`
//! half, the routes on real repos, replays in
//! `claudius-server/tests/git_routes.rs`.)

use std::path::PathBuf;

use claudius_agent::js;
use claudius_core::git::{
    has_binary_line, is_missing_blob, node_inspect_string, parse_branch_header,
    parse_porcelain_v1_z,
};
use claudius_core::js_num;
use serde_json::{Map, Value, json};

fn fixture() -> Value {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/git_golden.json");
    // `js::json_parse`: the fixture holds a lone surrogate (an inspect cut).
    js::json_parse(&std::fs::read_to_string(path).unwrap()).unwrap()
}

fn cases<'a>(fx: &'a Value, group: &str) -> &'a [Value] {
    fx["parsers"][group].as_array().unwrap()
}

#[test]
fn branch_headers_match_ts() {
    let fx = fixture();
    let mut failures = vec![];
    for c in cases(&fx, "headers") {
        let line = c["line"].as_str().unwrap();
        let h = parse_branch_header(line);
        let mut o = Map::new();
        if let Some(b) = h.branch {
            o.insert("branch".into(), json!(b));
        }
        if let Some(a) = h.ahead {
            o.insert("ahead".into(), js_num(a));
        }
        if let Some(b) = h.behind {
            o.insert("behind".into(), js_num(b));
        }
        let got = js::stringify(&Value::Object(o));
        if got != js::stringify(&c["got"]) {
            failures.push(format!("{line:?}: want {} got {got}", c["got"]));
        }
    }
    assert!(failures.is_empty(), "{}", failures.join("\n"));
    assert!(cases(&fx, "headers").len() >= 70);
}

#[test]
fn porcelain_matches_ts() {
    let fx = fixture();
    let mut failures = vec![];
    for c in cases(&fx, "porcelain") {
        let buf = c["buf"].as_str().unwrap();
        let got: Vec<Value> = parse_porcelain_v1_z(buf)
            .iter()
            .map(|f| f.to_json())
            .collect();
        let got = js::stringify(&json!(got));
        if got != js::stringify(&c["got"]) {
            failures.push(format!("{buf:?}: want {} got {got}", c["got"]));
        }
    }
    assert!(failures.is_empty(), "{}", failures.join("\n"));
    assert!(cases(&fx, "porcelain").len() >= 20);
}

#[test]
fn regex_tests_match_ts() {
    let fx = fixture();
    let mut failures = vec![];
    for (group, f) in [
        ("binary", has_binary_line as fn(&str) -> bool),
        ("missing", is_missing_blob),
    ] {
        for c in cases(&fx, group) {
            let text = c["text"].as_str().unwrap();
            if Value::Bool(f(text)) != c["got"] {
                failures.push(format!("{group} {text:?}: want {}", c["got"]));
            }
        }
    }
    assert!(failures.is_empty(), "{}", failures.join("\n"));
    let hits = |g| cases(&fx, g).iter().filter(|c| c["got"] == true).count();
    assert!(hits("binary") >= 6 && hits("missing") >= 6);
}

#[test]
fn nul_argument_messages_match_node() {
    let fx = fixture();
    let mut failures = vec![];
    let mut cut_pair = 0;
    for c in cases(&fx, "inspect") {
        let arg = c["arg"].as_str().unwrap();
        let got = format!(
            "The argument 'args[1]' must be a string without null bytes. Received {}",
            node_inspect_string(arg)
        );
        let mut want = c["got"].as_str().unwrap().to_owned();
        // The 128-unit cut through a surrogate pair leaves JS a lone half
        // (read here as U+FFFD); Rust drops it.
        if want.ends_with("\u{fffd}...") {
            cut_pair += 1;
            want = want.replace("\u{fffd}...", "...");
        }
        if got != want {
            failures.push(format!("{arg:?}:\n  want {want:?}\n  got  {got:?}"));
        }
    }
    assert!(failures.is_empty(), "{}", failures.join("\n"));
    assert_eq!(cut_pair, 1);
}
