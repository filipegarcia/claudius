//! `collate`, `node_path`, `tcc_protected` and `fs_list` against what
//! `rust/scripts/fs-list-golden.mjs` recorded from node 22 and the real TS
//! (`fixtures/fs_list_golden.json`):
//! * `localeCompare` over a matrix of hand-picked strings, seeded random
//!   pairs and stable sorts with ties;
//! * node's posix `path` functions, with the process cwd at `/` as it was
//!   for the recorder (this binary's other tests use absolute paths only);
//! * `categorizeTccPath` / `isHiddenHomeSubpath` for darwin, linux, win32;
//! * every `GET /api/fs/list` step the recorder kept the `listFs` call of
//!   (the recorded `cwd`, `q` and `limit`), on a rebuilt tree, for both
//!   recorded platforms: a 200's entries, and that a walk the TS answered
//!   `Search failed: …` for fails here too (CC 2.1.301). Steps after a scenario's first
//!   successful POST are left to claudius-server's `tests/fs_routes.rs`,
//!   which replays the creates too.
#![cfg(unix)]

mod common_fs;

use std::cmp::Ordering;

use claudius_agent::js;
use claudius_core::collate::locale_compare;
use claudius_core::fs_list::{FsEntry, list_fs_in};
use claudius_core::node_path;
use claudius_core::tcc_protected::{categorize_tcc_path, is_hidden_home_subpath};
use common_fs::{Tree, can_replay, check, fixture, got, probe_disk};
use serde_json::{Value, json};

fn sign(o: Ordering) -> char {
    match o {
        Ordering::Less => '-',
        Ordering::Equal => '0',
        Ordering::Greater => '+',
    }
}

fn strs(v: &Value) -> Vec<String> {
    v.as_array()
        .unwrap()
        .iter()
        .map(|s| s.as_str().unwrap().to_owned())
        .collect()
}

#[test]
fn locale_compare_matches_v8() {
    let fx = fixture();
    let c = &fx["collate"];
    let base = strs(&c["base"]);
    let mut failures = vec![];
    for (i, row) in c["matrix"].as_array().unwrap().iter().enumerate() {
        let row: Vec<char> = row.as_str().unwrap().chars().collect();
        for (j, want) in row.iter().enumerate() {
            let got = sign(locale_compare(&base[i], &base[j]));
            if got != *want {
                failures.push(format!(
                    "{:?} vs {:?}: want {want} got {got}",
                    base[i], base[j]
                ));
            }
        }
    }
    let pairs = c["pairs"].as_array().unwrap();
    for p in pairs {
        let (a, b) = (p[0].as_str().unwrap(), p[1].as_str().unwrap());
        let want = p[2].as_str().unwrap().chars().next().unwrap();
        let got = sign(locale_compare(a, b));
        if got != want {
            failures.push(format!("{a:?} vs {b:?}: want {want} got {got}"));
        }
    }
    for s in c["sorts"].as_array().unwrap() {
        let mut v = strs(&s["input"]);
        v.sort_by(|a, b| locale_compare(a, b));
        if v != strs(&s["sorted"]) {
            failures.push(format!(
                "sort of {:?}\n  want {:?}\n  got  {v:?}",
                s["input"], s["sorted"]
            ));
        }
    }
    assert!(
        failures.is_empty(),
        "{} differ:\n{}",
        failures.len(),
        failures.join("\n")
    );
    assert!(base.len() > 90 && pairs.len() >= 1500);
}

#[test]
fn node_path_matches_node() {
    // The recorder ran these with `process.cwd()` at `/`.
    std::env::set_current_dir("/").unwrap();
    let fx = fixture();
    let p = &fx["paths"];
    let mut failures = vec![];
    let mut n = 0;
    let mut expect = |what: &str, args: &Value, want: &Value, got: Value| {
        n += 1;
        if *want != got {
            failures.push(format!("{what}({args}): want {want} got {got}"));
        }
    };
    for c in p["resolve"].as_array().unwrap() {
        let args = strs(&c[0]);
        let args: Vec<&str> = args.iter().map(String::as_str).collect();
        expect("resolve", &c[0], &c[1], json!(node_path::resolve(&args)));
    }
    for c in p["join"].as_array().unwrap() {
        let args = strs(&c[0]);
        let args: Vec<&str> = args.iter().map(String::as_str).collect();
        expect("join", &c[0], &c[1], json!(node_path::join(&args)));
    }
    for c in p["normalize"].as_array().unwrap() {
        expect(
            "normalize",
            &c[0],
            &c[1],
            json!(node_path::normalize(c[0].as_str().unwrap())),
        );
    }
    for c in p["dirname"].as_array().unwrap() {
        expect(
            "dirname",
            &c[0],
            &c[1],
            json!(node_path::dirname(c[0].as_str().unwrap())),
        );
    }
    for c in p["isAbsolute"].as_array().unwrap() {
        expect(
            "isAbsolute",
            &c[0],
            &c[1],
            json!(node_path::is_absolute(c[0].as_str().unwrap())),
        );
    }
    for c in p["relative"].as_array().unwrap() {
        let (f, t) = (c[0].as_str().unwrap(), c[1].as_str().unwrap());
        expect(
            "relative",
            &json!([f, t]),
            &c[2],
            json!(node_path::relative(f, t)),
        );
    }
    assert!(
        failures.is_empty(),
        "{} differ:\n{}",
        failures.len(),
        failures.join("\n")
    );
    assert!(n > 1000, "{n} cases");
}

#[test]
fn tcc_helpers_match_ts() {
    let fx = fixture();
    let mut failures = vec![];
    for c in fx["tcc"]["categorize"].as_array().unwrap() {
        let (a, h, p) = (
            c[0].as_str().unwrap(),
            c[1].as_str().unwrap(),
            c[2].as_str().unwrap(),
        );
        let got = json!(categorize_tcc_path(a, h, p));
        if got != c[3] {
            failures.push(format!(
                "categorize({a:?}, {h:?}, {p}): want {} got {got}",
                c[3]
            ));
        }
    }
    for c in fx["tcc"]["hidden"].as_array().unwrap() {
        let (r, p) = (c[0].as_str().unwrap(), c[1].as_str().unwrap());
        let got = json!(is_hidden_home_subpath(r, p));
        if got != c[2] {
            failures.push(format!("hidden({r:?}, {p}): want {} got {got}", c[2]));
        }
    }
    assert!(
        failures.is_empty(),
        "{} differ:\n{}",
        failures.len(),
        failures.join("\n")
    );
}

#[test]
fn list_fs_matches_ts() {
    let fx = fixture();
    let disk = probe_disk();
    let mut failures = vec![];
    let (mut replayed, mut skipped) = (0, 0);
    for s in fx["scenarios"].as_array().unwrap() {
        if !can_replay(&fx, s, disk) {
            skipped += 1;
            continue;
        }
        for platform in ["darwin", "linux"] {
            let tree = Tree::new();
            tree.apply(&s["ops"]);
            let home = tree.root.join("home").to_str().unwrap().to_owned();
            for step in s["steps"][platform].as_array().unwrap() {
                let want = got(s, step);
                if step["method"] == "POST" && want["status"] == 200 {
                    break;
                }
                if step["route"] != "list" || step["args"].is_null() {
                    continue;
                }
                // The trusted cwd the route resolved.
                let cwd = tree.sub(step["args"]["cwd"].as_str().unwrap());
                let cwd = cwd.as_str();
                let q = step["args"]["q"].as_str().unwrap();
                let limit = js::to_number(step["args"]["limit"].as_str().unwrap());
                let listed = list_fs_in(&home, platform, cwd, q, limit);
                if want["status"] != 200 {
                    // CC 2.1.301: a cwd the walk can't read fails it. The
                    // route's wording is pinned in claudius-server's
                    // `tests/fs_routes.rs`.
                    if listed.is_ok() {
                        failures.push(format!(
                            "{} [{platform}] {}: want the walk to fail ({}), it didn't",
                            s["name"], step["label"], want["body"]
                        ));
                    }
                    continue;
                }
                let entries: Vec<Value> = listed.unwrap().iter().map(FsEntry::to_json).collect();
                let text = tree.unsub(&js::stringify(&json!({ "cwd": cwd, "entries": entries })));
                replayed += 1;
                if let Err(e) = check(want, 200, Some("application/json"), &text) {
                    failures.push(format!("{} [{platform}] {}: {e}", s["name"], step["label"]));
                }
            }
        }
    }
    assert!(
        failures.is_empty(),
        "{} of {replayed} differ:\n{}",
        failures.len(),
        failures.join("\n")
    );
    assert!(
        replayed >= 140,
        "{replayed} replayed, {skipped} scenarios skipped"
    );
}
