//! `lib/server/mcp.ts` against what `rust/scripts/mcp-config-golden.mjs`
//! recorded from the real TS (`fixtures/mcp_config_golden.json`): every
//! `findConfigWhitespaceWarnings` config (the warnings in order, or what it
//! threw), and the prototype names `key in servers` also finds. The route
//! groups are replayed against the binary by
//! `claudius-server/tests/mcp_config.rs`.

use claudius_core::mcp_config::{
    ARRAY_PROTOTYPE_KEYS, OBJECT_PROTOTYPE_KEYS, find_config_whitespace_warnings,
};
use serde_json::Value;

fn fixture() -> Value {
    serde_json::from_str(include_str!("fixtures/mcp_config_golden.json")).unwrap()
}

fn strings(v: &Value) -> Vec<String> {
    v.as_array()
        .unwrap()
        .iter()
        .map(|s| s.as_str().unwrap().to_owned())
        .collect()
}

#[test]
fn whitespace_warnings_match_the_ts() {
    let fx = fixture();
    let cases = fx["warnings"].as_array().unwrap();
    let mut flagged = 0;
    for case in cases {
        let config = &case["config"];
        let got = find_config_whitespace_warnings(config);
        match case.get("threw") {
            // V8's `TypeError`, word for word.
            Some(why) => match got {
                Err(e) => assert_eq!(e.to_string(), why.as_str().unwrap(), "{config}"),
                Ok(w) => panic!("{config}: TS threw {why}, Rust gave {w:?}"),
            },
            None => {
                let want = strings(&case["warnings"]);
                flagged += usize::from(!want.is_empty());
                assert_eq!(got.unwrap(), want, "{config}");
            }
        }
    }
    assert!(cases.len() >= 70, "{} configs", cases.len());
    assert!(flagged >= 40, "{flagged} configs with warnings");
}

#[test]
fn prototype_names_match_node() {
    let fx = fixture();
    assert_eq!(strings(&fx["protoNames"]["object"]), OBJECT_PROTOTYPE_KEYS);
    assert_eq!(strings(&fx["protoNames"]["array"]), ARRAY_PROTOTYPE_KEYS);
}
