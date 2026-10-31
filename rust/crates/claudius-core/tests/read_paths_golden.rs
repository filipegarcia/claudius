//! Read-path extraction parity (S18): `extract_read_paths` replayed against
//! what `lib/shared/read-tool-paths.ts` returned for each message shape
//! (`rust/scripts/read-paths-golden.mjs`).

use claudius_core::read_paths::extract_read_paths;
use serde_json::Value;

#[test]
fn extract_read_paths_matches() {
    let cases: Vec<Value> =
        serde_json::from_str(include_str!("fixtures/read_paths_golden.json")).unwrap();
    assert!(cases.len() >= 25);
    let mut found = 0;
    for c in &cases {
        let want: Vec<String> = serde_json::from_value(c["paths"].clone()).unwrap();
        found += want.len();
        assert_eq!(extract_read_paths(&c["message"]), want, "{}", c["name"]);
    }
    assert!(found >= 10, "{found}");
}
