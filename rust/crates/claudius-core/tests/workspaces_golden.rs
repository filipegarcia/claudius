//! The pure helpers behind the workspace store, against
//! `tests/fixtures/workspaces_golden.json` (recorded by
//! `rust/scripts/workspaces-golden.mjs` from node 22 and the real TS):
//! `defaultLetterIcon`, `path.resolve` and `encodeURIComponent` /
//! `decodeURIComponent`. The store and its routes are replayed on the real
//! binary by `claudius-server/tests/workspaces.rs`.

use std::path::PathBuf;

use claudius_core::js_string::{self, decode_uri_component, encode_uri_component};
use claudius_core::node_path::resolve;
use claudius_core::workspaces::default_letter_icon;
use serde_json::Value;

fn fixture() -> Value {
    let path =
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/workspaces_golden.json");
    // The fixture holds lone-surrogate escapes, which serde_json refuses.
    js_string::parse(&std::fs::read_to_string(path).unwrap()).unwrap()
}

#[test]
fn letter_icons_match_ts() {
    let fx = fixture();
    let cases = fx["letters"].as_array().unwrap();
    assert!(cases.len() >= 300);
    let mut bad = vec![];
    for c in cases {
        let (name, id) = (c["name"].as_str().unwrap(), c["id"].as_str().unwrap());
        let got = js_string::stringify(&default_letter_icon(name, id));
        let want = js_string::stringify(&c["icon"]);
        if got != want {
            bad.push(format!("{name:?} {id:?}: {got} != {want}"));
        }
    }
    assert!(
        bad.is_empty(),
        "{} of {}:\n{}",
        bad.len(),
        cases.len(),
        bad.join("\n")
    );
}

#[test]
fn resolve_matches_node() {
    let fx = fixture();
    let (root, up) = ("/t/root", "/t");
    assert_eq!(fx["cwd"], "$ROOT/project");
    for c in fx["resolve"].as_array().unwrap() {
        let p = c["p"].as_str().unwrap();
        // `path.resolve(cwd, p)` is `path.resolve(p)` run from `cwd`.
        let out = resolve(&[&format!("{root}/project"), p]);
        let shown = if let Some(rest) = out.strip_prefix(root) {
            format!("$ROOT{rest}")
        } else if let Some(rest) = out.strip_prefix(up) {
            format!("$UP{rest}")
        } else {
            out
        };
        assert_eq!(shown, c["out"].as_str().unwrap(), "{p:?}");
    }
}

#[test]
fn uri_components_match_js() {
    let fx = fixture();
    for c in fx["uri"].as_array().unwrap() {
        let s = c["s"].as_str().unwrap();
        assert_eq!(
            encode_uri_component(s).as_deref(),
            c["enc"].as_str(),
            "enc {s:?}"
        );
        assert_eq!(
            decode_uri_component(s).as_deref(),
            c["dec"].as_str(),
            "dec {s:?}"
        );
    }
}
