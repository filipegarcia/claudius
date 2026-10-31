//! Replays `tests/fixtures/sandbox_merge.json`: the SDK's own `CZ()` sandbox
//! merge, lifted from `sdk.mjs` and run over edge cases by
//! `rust/scripts/sandbox-merge-golden.mjs`. Every case must produce the same
//! flag map (order included) and byte-identical `--settings` JSON, or the
//! same error.

use claudius_agent::sandbox::merge_into_args;
use indexmap::IndexMap;
use serde_json::Value;

fn flag_map(v: &Value) -> IndexMap<String, Option<String>> {
    v.as_object()
        .expect("args is an object")
        .iter()
        .map(|(k, v)| (k.clone(), v.as_str().map(str::to_owned)))
        .collect()
}

#[test]
fn sandbox_merge_matches_the_sdk() {
    let raw = std::fs::read_to_string(
        std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/sandbox_merge.json"),
    )
    .unwrap();
    let fixture: Value = serde_json::from_str(&raw).unwrap();
    let cases = fixture["cases"].as_array().unwrap();
    assert!(cases.len() >= 40, "fixture lost cases");
    let mut failures = Vec::new();
    for case in cases {
        let name = case["name"].as_str().unwrap();
        let mut args = flag_map(&case["args"]);
        let got = merge_into_args(&mut args, &case["sandbox"]);
        let expected = &case["result"];
        match (got, expected.get("error")) {
            (Ok(()), None) => {
                let want = flag_map(&expected["args"]);
                let (got, want): (Vec<_>, Vec<_>) =
                    (args.into_iter().collect(), want.into_iter().collect());
                if got != want {
                    failures.push(format!("{name}:\n  got  {got:?}\n  want {want:?}"));
                }
            }
            (Err(e), Some(msg)) => {
                let msg = msg.as_str().unwrap();
                if !e.to_string().contains(msg) {
                    failures.push(format!("{name}: error {e} != {msg}"));
                }
            }
            (got, _) => failures.push(format!("{name}: got {got:?}, want {expected}")),
        }
    }
    assert!(failures.is_empty(), "{}", failures.join("\n"));
}
