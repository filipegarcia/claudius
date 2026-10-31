//! Replays `fixtures/session_search_golden.json`, recorded by
//! `rust/scripts/session-search-golden.mjs` from the real
//! `app/api/sessions/search/route.ts` (node 22, ICU 78.3, Unicode 17):
//! * `canon`: for every UTF-16 unit, the units the route's escaped `gi`
//!   regex matches in a two-byte string of all 65 536 units and in a
//!   one-byte string of the 256 Latin-1 units, against the classes
//!   [`canonicalize`] makes;
//! * `pure`: the route's match + snippet block on 1 940 text / query pairs
//!   (index and `JSON.stringify(snippet)`) through [`find`] and [`snippet`];
//! * `steps`: every recorded request through [`respond`] on the rebuilt
//!   folders (status and body byte for byte).
#![cfg(unix)]

#[path = "common_search/mod.rs"]
mod common_search;

use std::collections::HashMap;

use claudius_agent::js;
use claudius_core::session_search::{SNIPPET_RADIUS, canonicalize, find, respond, snippet};
use common_search::{build, fixture, needs_perms, perms_enforced};
use serde_json::Value;

fn units(v: &Value) -> Vec<u16> {
    v.as_str().unwrap().encode_utf16().collect()
}

fn list(v: &Value) -> Vec<u16> {
    v.as_array()
        .unwrap()
        .iter()
        .map(|u| u.as_u64().unwrap() as u16)
        .collect()
}

#[test]
fn every_unit_matches_what_v8_matches() {
    let fx = fixture();
    assert_eq!(fx["radius"], SNIPPET_RADIUS);
    let mut classes: HashMap<u16, Vec<u16>> = HashMap::new();
    for u in 0..=u16::MAX {
        classes.entry(canonicalize(u)).or_default().push(u);
    }
    let recorded = |key: &str| -> HashMap<u16, Vec<u16>> {
        fx["canon"][key]
            .as_array()
            .unwrap()
            .iter()
            .map(|e| (e[0].as_u64().unwrap() as u16, list(&e[1])))
            .collect()
    };
    let (two, one) = (recorded("twoByte"), recorded("oneByte"));
    let mut failures = Vec::new();
    for u in 0..=u16::MAX {
        let class = &classes[&canonicalize(u)];
        let want_two = two.get(&u).cloned().unwrap_or_else(|| vec![u]);
        if *class != want_two {
            failures.push(format!(
                "U+{u:04X} two-byte: V8 {want_two:04X?}, Rust {class:04X?}"
            ));
        }
        let latin: Vec<u16> = class.iter().copied().filter(|&d| d < 0x100).collect();
        let want_one = one
            .get(&u)
            .cloned()
            .unwrap_or_else(|| if u < 0x100 { vec![u] } else { vec![] });
        if latin != want_one {
            failures.push(format!(
                "U+{u:04X} one-byte: V8 {want_one:04X?}, Rust {latin:04X?}"
            ));
        }
    }
    assert!(
        failures.is_empty(),
        "{} units differ:\n{}",
        failures.len(),
        failures.join("\n")
    );
    assert!(two.len() > 2000 && !one.is_empty());
}

#[test]
fn matches_and_snippets_follow_the_route() {
    let fx = fixture();
    let cases = fx["pure"].as_array().unwrap();
    let mut failures = Vec::new();
    for c in cases {
        let (text, q) = (units(&c["text"]), units(&c["q"]));
        let got = find(&text, &q).map(|i| {
            let mut s = String::new();
            js::stringify_utf16(&snippet(&text, i, q.len()), &mut s);
            serde_json::json!({"index": i, "snippet": s})
        });
        let got = got.unwrap_or(Value::Null);
        if got != c["got"] {
            failures.push(format!(
                "{:?} in {:?}\n  want {}\n  got  {got}",
                c["q"], c["text"], c["got"]
            ));
        }
    }
    assert!(
        failures.is_empty(),
        "{} of {} cases differ:\n{}",
        failures.len(),
        cases.len(),
        failures.join("\n")
    );
    assert!(cases.len() >= 1900);
    let hits = cases.iter().filter(|c| !c["got"].is_null()).count();
    assert!(hits > 600 && hits < cases.len() - 300, "{hits} hits");
}

#[test]
fn the_route_answers_like_the_ts() {
    let fx = fixture();
    let home = tempfile::tempdir().unwrap();
    let home_str = home.path().to_str().unwrap().to_owned();
    let _built = build(home.path(), &fx);
    let perms = perms_enforced();
    let steps = fx["steps"].as_array().unwrap();
    let (mut failures, mut skipped) = (Vec::new(), 0);
    for s in steps {
        if !perms && needs_perms(&fx, s) {
            skipped += 1;
            continue;
        }
        let p = &s["params"];
        let (status, body) = respond(
            &home_str,
            p["q"].as_str(),
            p["dir"].as_str(),
            p["limit"].as_str(),
        );
        let want = &s["got"];
        assert_eq!(want["type"], "application/json", "{s}");
        if want["status"] != status || want["body"] != body.as_str() {
            failures.push(format!(
                "{}\n  want {} {}\n  got  {status} {body}",
                s["query"], want["status"], want["body"]
            ));
        }
    }
    assert!(
        failures.is_empty(),
        "{} of {} steps differ:\n{}",
        failures.len(),
        steps.len(),
        failures.join("\n")
    );
    assert!(steps.len() >= 140);
    if skipped > 0 {
        eprintln!("{skipped} steps skipped: this disk doesn't enforce modes");
    }
}
