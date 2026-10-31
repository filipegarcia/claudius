//! Replays the `refnames` half of `fixtures/git_branches_golden.json`,
//! recorded by `rust/scripts/git-branches-golden.mjs` from the real
//! `lib/server/git.ts`: the private `isValidRefName`, sliced out of the
//! source, on names at every rule's edge (a leading `-`, JS whitespace and
//! what isn't, the 255-unit limit in UTF-16 units, `..`, `@{`, `.lock`,
//! controls). (The `steps` half, the routes on real repos, replays in
//! `claudius-server/tests/git_branches.rs`.)

use std::path::PathBuf;

use claudius_agent::js;
use claudius_core::git::is_valid_ref_name;
use serde_json::Value;

fn fixture() -> Value {
    let path =
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/git_branches_golden.json");
    js::json_parse(&std::fs::read_to_string(path).unwrap()).unwrap()
}

#[test]
fn ref_names_match_ts() {
    let fx = fixture();
    let cases = fx["refnames"].as_array().unwrap();
    let mut failures = vec![];
    for c in cases {
        let name = c["name"].as_str().unwrap();
        let want = c["got"].as_bool().unwrap();
        if is_valid_ref_name(name) != want {
            failures.push(format!("{name:?}: want {want}"));
        }
    }
    assert!(failures.is_empty(), "{}", failures.join("\n"));
    assert!(cases.len() >= 95, "{}", cases.len());
    // Both answers are in the fixture, many times over.
    let valid = cases.iter().filter(|c| c["got"] == true).count();
    assert!(valid >= 30 && cases.len() - valid >= 30, "{valid}");
}
