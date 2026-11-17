//! `workspace_relocate.rs` (G09), replayed against what
//! `rust/scripts/workspace-relocate-golden.mjs` recorded from the real
//! `lib/server/workspace-relocate.ts` (`tests/fixtures/workspace_relocate_golden.json`,
//! its `core` scenarios): each scenario's setup ops and calls in order on a
//! fresh world (a temp root with `$ROOT/home` as the home dir), checking
//! each call's result or thrown error (name, message) as JSON text, and
//! every watched path it changed (kind, mode, UTF-8 text or bytes, symlink
//! target, and a `.claudius.db` as a dump of its tables). A scenario that
//! needs enforced permissions runs only where a `chmod 0` directory is
//! unreadable.
//!
//! The route groups of the same fixture replay on the real binary in
//! `claudius-server/tests/workspace_relocate.rs`.
#![cfg(unix)]

#[path = "common_wsrel/mod.rs"]
mod common_wsrel;

use std::path::PathBuf;

use claudius_core::db;
use claudius_core::workspace_relocate as reloc;
use claudius_core::{js_string, paths};
use common_wsrel::{World, changes, perm_enforced, runs_here, str_of};
use serde_json::{Value, json};

/// One recorded call: its result, or what it threw as `{name, message}`.
fn call(w: &World, args: &[Value]) -> (&'static str, Value) {
    let arg = |i: usize| w.abs(str_of(&args[i]));
    let got = match str_of(&args[0]) {
        "list" => {
            // `{live: [...]}`: the recorder's `isLive`; `{live: null}` is
            // `{}` (opts without `isLive`), and no third argument at all is
            // the plain call.
            let live: Option<Vec<String>> = args.get(2).map(|o| {
                o["live"]
                    .as_array()
                    .map(|a| a.iter().map(|v| str_of(v).to_owned()).collect())
                    .unwrap_or_default()
            });
            let is_live = move |id: &str| live.as_ref().is_some_and(|l| l.iter().any(|x| x == id));
            // `{live: null}` is the TS `{}`: no `isLive`, so no filter —
            // the same as no third argument at all.
            let opts: Option<&dyn Fn(&str) -> bool> = match args.get(2) {
                Some(o) if !o["live"].is_null() => Some(&is_live),
                _ => None,
            };
            reloc::list_workspace_session_ids(&arg(1), opts)
                .map(|ids| Value::Array(ids.iter().map(reloc::SessionKey::to_json).collect()))
        }
        "relocate" => {
            reloc::relocate_workspace_sessions(&arg(1), &arg(2)).map(|r| Value::Object(r.to_json()))
        }
        other => panic!("unknown call {other}"),
    };
    match got {
        Ok(v) => ("result", w.deep_rel(&v)),
        Err(t) => (
            "threw",
            json!({"name": t.name(), "message": w.rel(t.message())}),
        ),
    }
}

/// Every root a scenario's calls and `sql` ops name: their cached DB
/// handles are closed around it (the recorder's `closeAll()`).
fn roots_of(w: &World, sc: &Value) -> Vec<String> {
    let mut roots = Vec::new();
    for st in sc["steps"].as_array().unwrap() {
        if let Some(args) = st["call"].as_array() {
            // The call's roots; a `list`'s third argument is its options.
            roots.extend(args[1..].iter().filter_map(Value::as_str).map(|a| w.abs(a)));
        }
        for op in st["setup"].as_array().into_iter().flatten() {
            if let Some(r) = op["root"].as_str() {
                roots.push(w.abs(r));
            }
        }
    }
    roots
}

/// The one test of this binary: `homedir()` can be pinned only once.
#[test]
fn core_scenarios_match_the_ts() {
    // The recorder ran under umask 022.
    unsafe { libc::umask(0o022) };
    let w = World::new();
    assert!(paths::set_home_override(PathBuf::from(format!(
        "{}/home",
        w.root
    ))));
    let perm = perm_enforced();
    let fx = common_wsrel::fixture();
    let (mut ran, mut calls) = (0, 0);
    for sc in fx["core"].as_array().unwrap() {
        if !runs_here(sc, perm) {
            continue;
        }
        let name = str_of(&sc["name"]);
        let roots = roots_of(&w, sc);
        for r in &roots {
            db::close_db(r);
        }
        w.build(&[]);
        let mut prev = w.snapshot(&[]);
        for (i, st) in sc["steps"].as_array().unwrap().iter().enumerate() {
            if let Some(ops) = st["setup"].as_array() {
                for op in ops {
                    w.apply(op);
                }
                continue;
            }
            let args = st["call"].as_array().unwrap();
            let (key, got) = call(&w, args);
            let want = st
                .get(key)
                .unwrap_or_else(|| panic!("{name} #{i} {args:?}: got {key} {got}, want {st}"));
            // As JSON text: `JSON.stringify` prints 2**53 as an integer.
            let (got, want) = (js_string::stringify(&got), js_string::stringify(want));
            assert_eq!(got, want, "{name} #{i} {args:?}: {key} differs");
            let cur = w.snapshot(&[]);
            let ch = changes(&prev, &cur);
            assert_eq!(
                ch,
                st["changes"],
                "{name} #{i} {args:?}: changes differ\n got: {}\nwant: {}",
                serde_json::to_string_pretty(&ch).unwrap(),
                serde_json::to_string_pretty(&st["changes"]).unwrap()
            );
            prev = cur;
            calls += 1;
        }
        for r in &roots {
            db::close_db(r);
        }
        ran += 1;
    }
    assert!(
        ran >= 14 && calls >= 60,
        "only {ran} scenarios ({calls} calls) ran"
    );
    eprintln!("{ran} scenarios, {calls} calls replayed");
}
