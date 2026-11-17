//! Boot-time customization work against the TS: replays the `startup`
//! section of `claudius-server/tests/fixtures/customization_actions_golden.json`
//! (recorded by `rust/scripts/customization-actions-golden.mjs` from the
//! real `lib/server/customizations-startup.ts`) on
//! [`claudius_core::customizations_startup`].
//!
//! Each recorded call must leave the same `index.json` bytes, `.claudius`
//! tree and live tree, changed exactly where the recording changed them:
//! the stale publishes auto-reverted (through the fixture's fake `node` and
//! the live tree's `bin/claudius-revert`, which is what writes
//! `revert.log`) and marked `stale_at_upgrade`, the legacy `workspaceId`s
//! stripped and the `kind: "customization"` workspace deleted.
//!
//! Times move: a recorded `revertedAt` / `updatedAt` is this run's clock,
//! so both sides' index text is compared with every ms timestamp written
//! `$T` (checked to be a time inside the run). The TS console lines the
//! calls write are recorded too, but this replay only asserts the effects:
//! the Rust side logs them through `tracing`, which a library test doesn't
//! capture.
#![cfg(unix)]

use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};

use claudius_core::customizations::Store;
use claudius_core::customizations_startup::{
    reconcile_customization_workspaces, run_customizations_upgrade_check,
};
use claudius_core::customize_runtime::is_running_inside_customization_mirror_for;
use claudius_core::{js_string, node_fs, now_ms, paths};
use serde_json::{Map, Value, json};

fn fixture() -> Value {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../claudius-server/tests/fixtures/customization_actions_golden.json");
    js_string::parse(&std::fs::read_to_string(path).unwrap()).unwrap()
}

fn str_of(v: &Value) -> &str {
    v.as_str().unwrap_or_else(|| panic!("not a string: {v}"))
}

fn unlock(dir: &Path) {
    let Ok(m) = std::fs::symlink_metadata(dir) else {
        return;
    };
    if !m.is_dir() {
        return;
    }
    let _ = std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o755));
    if let Ok(rd) = std::fs::read_dir(dir) {
        for e in rd.flatten() {
            unlock(&e.path());
        }
    }
}

struct World {
    root: String,
    node: String,
}

impl World {
    fn real(&self, s: &str) -> String {
        s.replace("$ROOT", &self.root)
    }

    fn fake(&self, s: &str) -> String {
        s.replace(&self.node, "$NODE").replace(&self.root, "$ROOT")
    }

    fn path(&self, rel: &str) -> PathBuf {
        Path::new(&self.root).join(rel)
    }

    fn index(&self) -> PathBuf {
        self.path("home/.claude/.claudius/customizations/index.json")
    }

    fn apply(&self, s: &Value) {
        let p = self.real(str_of(&s["path"]));
        match str_of(&s["act"]) {
            "write" => {
                std::fs::create_dir_all(Path::new(&p).parent().unwrap()).unwrap();
                std::fs::write(&p, self.real(str_of(&s["text"]))).unwrap();
            }
            "mkdir" => std::fs::create_dir_all(&p).unwrap(),
            "rm" => node_fs::rm_recursive_force(&p).unwrap(),
            "chmod" => {
                let mode = s["mode"].as_u64().unwrap() as u32;
                std::fs::set_permissions(&p, std::fs::Permissions::from_mode(mode)).unwrap();
            }
            other => panic!("fs act {other}"),
        }
    }

    /// The recorder's `tree()`.
    fn tree(&self, path: &Path) -> Value {
        let Ok(st) = std::fs::symlink_metadata(path) else {
            return Value::Null;
        };
        if st.file_type().is_symlink() {
            let target = std::fs::read_link(path).unwrap();
            return json!(format!("l>{}", self.fake(&target.to_string_lossy())));
        }
        if path == self.index() && st.is_file() {
            return json!("index");
        }
        if !st.is_dir() {
            return match std::fs::read(path) {
                Ok(b) => {
                    let masked = self.fake(&String::from_utf8_lossy(&b));
                    if masked.len() <= 2000 {
                        json!(masked)
                    } else {
                        json!(format!(
                            "sha256:{}:{}",
                            claudius_core::asset_store::sha256_hex(masked.as_bytes()),
                            masked.len()
                        ))
                    }
                }
                Err(_) => json!("f!"),
            };
        }
        let Ok(rd) = std::fs::read_dir(path) else {
            return json!("d!");
        };
        let mut names: Vec<String> = rd
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        names.sort();
        let mut out = Map::new();
        for name in names {
            out.insert(self.fake(&name), self.tree(&path.join(&name)));
        }
        Value::Object(out)
    }

    fn snapshot(&self) -> (Option<String>, Value, Value) {
        (
            std::fs::read(self.index())
                .ok()
                .map(|b| self.fake(&String::from_utf8_lossy(&b))),
            self.tree(&self.path("home/.claude/.claudius")),
            self.tree(&self.path("live")),
        )
    }
}

/// Every ms timestamp as `$T`: a 13-digit run of digits. The recording's are
/// the pinned clock's, this run's the real one.
fn mask_times(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut rest = s;
    while let Some(at) = rest.find(|c: char| c.is_ascii_digit()) {
        out.push_str(&rest[..at]);
        let digits: String = rest[at..]
            .chars()
            .take_while(char::is_ascii_digit)
            .collect();
        if digits.len() == 13 {
            out.push_str("$T");
        } else {
            out.push_str(&digits);
        }
        rest = &rest[at + digits.len()..];
    }
    out.push_str(rest);
    out
}

fn text(v: &Value) -> String {
    mask_times(&js_string::stringify(v))
}

/// The workspace store's rolling backup is named after the clock.
fn mask_bak(v: &Value) -> Value {
    match v {
        Value::Object(m) => Value::Object(
            m.iter()
                .map(|(k, v)| {
                    let k = if k.starts_with("workspaces.json.bak.") {
                        "workspaces.json.bak.*".to_owned()
                    } else {
                        k.clone()
                    };
                    (k, mask_bak(v))
                })
                .collect(),
        ),
        other => other.clone(),
    }
}

#[test]
fn startup_matches_the_ts() {
    let fx = fixture();
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path().canonicalize().unwrap();
    for d in ["home", "live", "fakebin"] {
        std::fs::create_dir_all(root.join(d)).unwrap();
    }
    // The fixture's `node` stand-in, which runs the live tree's revert
    // script; the child reads `HOME`, so this process's must be the temp one.
    let node = root.join("fakebin/node");
    std::fs::write(&node, str_of(&fx["fakes"]["node"])).unwrap();
    std::fs::set_permissions(&node, std::fs::Permissions::from_mode(0o755)).unwrap();
    // The recorded world has HOME at `<root>/home`.
    let home = root.join("home");
    // SAFETY: this test binary runs one test, before any thread reads it.
    unsafe {
        std::env::set_var("HOME", &home);
    }
    assert!(paths::set_home_override(home.clone()));
    let w = World {
        root: root.to_str().unwrap().to_owned(),
        node: node.to_string_lossy().into_owned(),
    };
    let live = w.path("live").to_string_lossy().into_owned();
    let store = Store::from_env();
    assert_eq!(
        store.root(),
        w.path("home/.claude/.claudius/customizations")
            .to_string_lossy()
    );

    let rt = tokio::runtime::Runtime::new().unwrap();
    let t_begin = now_ms();
    let mut last = w.snapshot();
    let mut calls = 0;
    for (i, step) in fx["startup"].as_array().unwrap().iter().enumerate() {
        if str_of(&step["op"]) == "fs" {
            w.apply(step);
            last = w.snapshot();
            continue;
        }
        calls += 1;
        let fn_name = str_of(&step["fn"]);
        let ctx = format!("startup step {i} {fn_name}");
        match fn_name {
            "runCustomizationsUpgradeCheck" => {
                rt.block_on(run_customizations_upgrade_check(&store, &live, &w.node))
                    .unwrap_or_else(|e| panic!("{ctx}: {e}"));
            }
            "reconcileCustomizationWorkspaces" => {
                reconcile_customization_workspaces(&store, &live);
            }
            "isRunningInsideCustomizationMirror" => {
                let got = is_running_inside_customization_mirror_for(&live, store.root());
                assert_eq!(json!(got).to_string(), str_of(&step["result"]), "{ctx}");
            }
            other => panic!("unknown call {other}"),
        }
        let now = w.snapshot();
        match step.get("index") {
            None => assert_eq!(
                now.0.as_deref().map(mask_times),
                last.0.as_deref().map(mask_times),
                "{ctx}: index unchanged"
            ),
            Some(Value::Null) => assert_eq!(now.0, None, "{ctx}: index gone"),
            Some(want) => assert_eq!(
                mask_times(now.0.as_deref().expect("an index")),
                mask_times(&w.real(str_of(want)).replace(&w.root, "$ROOT")),
                "{ctx}: index"
            ),
        }
        for (key, got, before) in [("tree", &now.1, &last.1), ("live", &now.2, &last.2)] {
            match step.get(key) {
                None => assert_eq!(
                    text(&mask_bak(got)),
                    text(&mask_bak(before)),
                    "{ctx}: {key} unchanged"
                ),
                Some(want) => {
                    assert_eq!(text(&mask_bak(got)), text(&mask_bak(want)), "{ctx}: {key}")
                }
            }
        }
        last = now;
    }
    assert!(now_ms() >= t_begin);
    assert_eq!(calls, 7);

    // `run_customizations_startup()` on this process's own store, live dir
    // and launcher: the upgrade check, then the reconcile.
    // SAFETY: as above; nothing has read either variable yet.
    unsafe {
        std::env::set_var("CLAUDIUS_LIVE_SOURCE", format!(" {live}\t"));
        std::env::set_var(
            "PATH",
            format!("{}:/usr/bin:/bin", root.join("fakebin").display()),
        );
    }
    let claudius = w.path("home/.claude/.claudius");
    let _ = std::fs::remove_file(claudius.join("revert.log"));
    let ws = json!({
        "version": 1,
        "activeId": "wks_a",
        "workspaces": [
            {"id": "wks_a", "name": "a", "rootPath": live},
            {"id": "wks_z", "name": "z", "rootPath": "/x", "kind": "customization"},
        ],
    });
    std::fs::write(
        claudius.join("workspaces.json"),
        js_string::stringify_pretty(&ws),
    )
    .unwrap();
    let index = json!({
        "version": 1,
        "customizations": [{"id": "cust_z", "name": "z", "workspaceId": "wks_z"}],
        "publishes": [{"id": "pub_z", "customizationId": "cust_z", "publishedAt": 1,
                       "revertedAt": null, "baseHash": "stale", "files": []}],
    });
    std::fs::write(w.index(), js_string::stringify_pretty(&index)).unwrap();
    rt.block_on(claudius_core::customizations_startup::run_customizations_startup())
        .unwrap();
    let after = js_string::parse(&std::fs::read_to_string(w.index()).unwrap()).unwrap();
    assert_eq!(after["customizations"][0].get("workspaceId"), None);
    assert_eq!(after["publishes"][0]["revertReason"], "stale_at_upgrade");
    assert!(after["publishes"][0]["revertedAt"].as_i64().unwrap() >= t_begin);
    assert_eq!(
        std::fs::read_to_string(claudius.join("revert.log")).unwrap(),
        "r:pub_z\n"
    );
    let ws = js_string::parse(&std::fs::read_to_string(claudius.join("workspaces.json")).unwrap())
        .unwrap();
    assert_eq!(ws["workspaces"].as_array().unwrap().len(), 1);
    assert_eq!(ws["workspaces"][0]["id"], "wks_a");
    unlock(tmp.path());
}
