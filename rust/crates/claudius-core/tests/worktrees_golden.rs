//! The `parse` half of `fixtures/worktrees_fork_golden.json` (recorded by
//! `rust/scripts/worktrees-fork-golden.mjs` from the real TS): `parsePorcelain`
//! (`lib/server/worktrees.ts`) on crafted `git worktree list --porcelain`
//! texts, and `forkSlug`, `forkWorktreeIds` and `worktreeFailureReason`
//! (`lib/shared/fork-worktree.ts`) on crafted ids and stderr, each compared
//! as its `JSON.stringify` text. The routes over them are replayed in
//! `claudius-server/tests/worktrees_fork.rs`.

use std::path::PathBuf;

use claudius_agent::js;
use claudius_core::fork_worktrees::{fork_slug, fork_worktree_ids, worktree_failure_reason};
use claudius_core::js_string;
use claudius_core::worktrees::parse_porcelain;
use serde_json::Value;

fn fixture() -> Value {
    let path =
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/worktrees_fork_golden.json");
    js_string::parse(&std::fs::read_to_string(path).unwrap()).unwrap()
}

fn cases(f: &Value, key: &str) -> Vec<Value> {
    let list = f["parse"][key].as_array().unwrap().clone();
    assert!(!list.is_empty(), "no {key} cases");
    list
}

#[test]
fn porcelain_parses_as_the_ts_does() {
    for case in cases(&fixture(), "porcelain") {
        let text = case["text"].as_str().unwrap();
        let parsed = parse_porcelain(text)
            .into_iter()
            .map(Value::Object)
            .collect();
        assert_eq!(
            js::stringify(&Value::Array(parsed)),
            case["out"].as_str().unwrap(),
            "{text:?}"
        );
    }
}

#[test]
fn failure_reasons_match_the_ts() {
    for case in cases(&fixture(), "reasons") {
        let stderr = case["stderr"].as_str().unwrap();
        assert_eq!(
            js_string::stringify(&Value::String(worktree_failure_reason(stderr))),
            case["out"].as_str().unwrap(),
            "{stderr:?}"
        );
    }
}

#[test]
fn slugs_and_ids_match_the_ts() {
    for case in cases(&fixture(), "slugs") {
        let id = case["id"].as_str().unwrap();
        assert_eq!(fork_slug(id), case["slug"].as_str().unwrap(), "{id:?}");
        let (branch, dir_name) = fork_worktree_ids(id);
        assert_eq!(branch, case["ids"]["branch"].as_str().unwrap(), "{id:?}");
        assert_eq!(dir_name, case["ids"]["dirName"].as_str().unwrap(), "{id:?}");
    }
}
