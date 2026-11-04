//! The customization store (`claudius_core::customizations`) against
//! `fixtures/customizations_golden.json`, recorded by
//! `rust/scripts/customizations-golden.mjs` from the real
//! `lib/server/customizations-store.ts` and `computeDiff`.
//!
//! `store` is replayed in order in a fresh temp root laid out as the
//! recorder's (home, live): the same file-system steps, then every call
//! with the recorded arguments, the clock pinned to the recorded time and
//! `randomUUID` fed the recorder's seeded bytes (the first 16 of sha256
//! `customizations-golden-<n>`). Each call must resolve to the same JSON
//! text (or throw the same message), and leave the same `index.json` bytes
//! and `.claudius` tree, changed exactly where the recording changed them.
//! `sha1` checks the hash (in memory and streamed from a file) across
//! block and buffer boundaries.
//!
//! One recorded call differs on purpose ([`expected_difference`]).
#![cfg(unix)]

use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicI64, AtomicUsize, Ordering};

use claudius_core::customizations::{
    self, DiffError, Store, hash_file, hash_file_or_null, list_source_files, sha1_hex,
};
use claudius_core::{js_string, node_fs, runtime_dir};
use serde_json::{Map, Value, json};
use sha2::{Digest, Sha256};

fn fixture() -> Value {
    let path =
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/customizations_golden.json");
    // Lone-surrogate escapes: serde_json would refuse them.
    js_string::parse(&std::fs::read_to_string(path).unwrap()).unwrap()
}

fn str_of(v: &Value) -> &str {
    v.as_str().unwrap_or_else(|| panic!("not a string: {v}"))
}

fn hex(b: &[u8]) -> String {
    b.iter().map(|x| format!("{x:02x}")).collect()
}

fn unhex(s: &str) -> Vec<u8> {
    (0..s.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&s[i..i + 2], 16).unwrap())
        .collect()
}

/// The recorder's generated contents: byte `i` is `(i * 31 + seed) & 255`.
fn pattern(len: usize, seed: usize) -> Vec<u8> {
    (0..len).map(|i| ((i * 31 + seed) & 255) as u8).collect()
}

/// The recorder's `randomUUID()` bytes for call `n`.
fn seeded(n: usize) -> [u8; 16] {
    let h = Sha256::digest(format!("customizations-golden-{n}").as_bytes());
    h[..16].try_into().unwrap()
}

/// chmod every directory under `dir` back to 0755 (so the temp root goes).
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
    tmp: tempfile::TempDir,
    root: String,
}

impl Drop for World {
    fn drop(&mut self) {
        unlock(self.tmp.path());
    }
}

impl World {
    fn new() -> World {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().canonicalize().unwrap();
        for d in ["home", "config", "project", "live"] {
            std::fs::create_dir_all(root.join(d)).unwrap();
        }
        let root = root.to_str().unwrap().to_owned();
        World { tmp, root }
    }

    fn real(&self, s: &str) -> String {
        s.replace("$ROOT", &self.root)
    }

    /// The recorder's `realBytes`: every `$ROOT` (as bytes) replaced.
    fn real_bytes(&self, raw: &[u8]) -> Vec<u8> {
        let (needle, mut out, mut at) = (b"$ROOT", Vec::new(), 0);
        while let Some(i) = raw[at..].windows(needle.len()).position(|w| w == needle) {
            out.extend_from_slice(&raw[at..at + i]);
            out.extend_from_slice(self.root.as_bytes());
            at += i + needle.len();
        }
        out.extend_from_slice(&raw[at..]);
        out
    }

    fn fake(&self, s: &str) -> String {
        s.replace(&self.root, "$ROOT")
            .replace(&format!(".{}.", std::process::id()), ".$PID.")
    }

    fn claudius(&self) -> PathBuf {
        Path::new(&self.root).join("home/.claude/.claudius")
    }

    fn index(&self) -> PathBuf {
        self.claudius().join("customizations/index.json")
    }

    fn store_root(&self) -> String {
        format!("{}/home/.claude/.claudius/customizations", self.root)
    }

    /// The recorder's `applyFs`.
    fn apply(&self, s: &Value) {
        let p = self.real(str_of(&s["path"]));
        let parent = || std::fs::create_dir_all(Path::new(&p).parent().unwrap()).unwrap();
        match str_of(&s["act"]) {
            "write" => {
                parent();
                let bytes = if let Some(g) = s["gen"].as_array() {
                    pattern(
                        g[0].as_u64().unwrap() as usize,
                        g[1].as_u64().unwrap() as usize,
                    )
                } else if let Some(h) = s["hex"].as_str() {
                    self.real_bytes(&unhex(h))
                } else {
                    // `writeFileSync(path, string)`: lone surrogates as U+FFFD.
                    js_string::lossy(&self.real(str_of(&s["text"])))
                        .into_owned()
                        .into_bytes()
                };
                std::fs::write(&p, bytes).unwrap();
            }
            "mkdir" => std::fs::create_dir_all(&p).unwrap(),
            "rm" => node_fs::rm_recursive_force(&p).unwrap(),
            "symlink" => {
                parent();
                std::os::unix::fs::symlink(self.real(str_of(&s["target"])), &p).unwrap();
            }
            "chmod" => {
                let mode = s["mode"].as_u64().unwrap() as u32;
                std::fs::set_permissions(&p, std::fs::Permissions::from_mode(mode)).unwrap();
            }
            other => panic!("fs act {other}"),
        }
    }

    /// The recorder's `tree()`: nested names, "d!" an unreadable dir,
    /// "l>target", "f!" an unreadable file, "index" index.json, else the
    /// file's hex (up to 32 bytes) or `sha256:<hex>:<len>`.
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
                Ok(b) if b.len() <= 32 => json!(hex(&b)),
                Ok(b) => json!(format!("sha256:{}:{}", hex(&Sha256::digest(&b)), b.len())),
                Err(_) => json!("f!"),
            };
        }
        let Ok(rd) = std::fs::read_dir(path) else {
            return json!("d!");
        };
        let mut out = Map::new();
        for e in rd {
            let name = e.unwrap().file_name().to_string_lossy().into_owned();
            out.insert(self.fake(&name), self.tree(&path.join(&name)));
        }
        Value::Object(out)
    }

    fn snapshot(&self) -> (Option<Vec<u8>>, Value) {
        (
            std::fs::read(self.index()).ok(),
            self.tree(&self.claudius()),
        )
    }
}

/// The one recorded call this port answers differently on purpose:
/// `computeDiff("../escape")` names `<root>/../escape/src`, outside the
/// store, which TS walks and hashes; the port refuses it.
fn expected_difference(step: &Value) -> bool {
    step["fn"] == "computeDiff" && step["args"] == json!(["../escape"])
}

/// The JSON text of a call's outcome: `Ok(None)` is `undefined`.
type Outcome = Result<Option<Value>, String>;

fn call(store: &Store, live: &str, f: &str, args: &[Value]) -> Outcome {
    let s = |i: usize| str_of(&args[i]).to_owned();
    let opt = |v: anyhow::Result<Option<Value>>| v.map(|c| Some(c.unwrap_or(Value::Null)));
    let res: anyhow::Result<Option<Value>> = match f {
        "listCustomizations" => store.list_customizations().map(|v| Some(json!(v))),
        "getCustomization" => opt(store.get_customization(&s(0))),
        "createCustomizationRecord" => store
            .create_customization_record(str_of(&args[0]["name"]))
            .map(Some),
        "updateCustomizationRecord" => opt(store.update_customization_record(&s(0), &args[1])),
        "setCustomizationDescription" => {
            opt(store.set_customization_description(&s(0), &s(1), &s(2)))
        }
        "setCustomizationDescriptionManual" => {
            opt(store.set_customization_description_manual(&s(0), &s(1)))
        }
        "deleteCustomizationRecord" => store
            .delete_customization_record(&s(0))
            .map(|b| Some(json!(b))),
        "upsertCustomizationRecord" => store.upsert_customization_record(&args[0]).map(|()| None),
        "stripCustomizationWorkspaceIds" => store
            .strip_customization_workspace_ids()
            .map(|n| Some(json!(n))),
        "listPublishes" => {
            let id = args.first().map(|_| s(0));
            store.list_publishes(id.as_deref()).map(|v| Some(json!(v)))
        }
        "activePublishesOrdered" => store.active_publishes_ordered().map(|v| Some(json!(v))),
        "recordPublish" => store.record_publish(&args[0]).map(|()| None),
        "markPublishReverted" => {
            let reason = args.get(1).map(|_| s(1));
            opt(store.mark_publish_reverted(&s(0), reason.as_deref()))
        }
        "newPublishId" => Ok(Some(json!(store.new_publish_id()))),
        "computeDiff" => {
            return match store.compute_diff(&s(0), live) {
                Ok(v) => Ok(Some(v)),
                Err(DiffError::Fs(e)) => Err(e.message),
                Err(DiffError::Outside) => Err("<outside>".into()),
            };
        }
        other => panic!("no store function {other}"),
    };
    res.map_err(|e| e.to_string())
}

#[test]
fn store_matches_the_ts_store() {
    let fx = fixture();
    let w = World::new();
    let clock = Arc::new(AtomicI64::new(0));
    let uuids = Arc::new(AtomicUsize::new(0));
    let store = {
        let (clock, uuids) = (clock.clone(), uuids.clone());
        Store::new(w.store_root())
            .with_clock(Arc::new(move || clock.load(Ordering::SeqCst)))
            .with_random(Arc::new(move |buf: &mut [u8]| {
                let b = seeded(uuids.fetch_add(1, Ordering::SeqCst));
                buf.copy_from_slice(&b[..buf.len()]);
            }))
    };
    let live = w.real(str_of(&fx["live"]));
    assert_eq!(
        runtime_dir::live_source_dir_for(Some(&format!(" {live}\t")), String::new),
        live,
        "the recorder's CLAUDIUS_LIVE_SOURCE, trimmed"
    );

    let (mut calls, mut differences) = (0, 0);
    let mut last = w.snapshot();
    for (i, step) in fx["store"].as_array().unwrap().iter().enumerate() {
        if step["op"] == "fs" {
            w.apply(step);
            last = w.snapshot();
            continue;
        }
        calls += 1;
        clock.store(step["clock"].as_i64().unwrap(), Ordering::SeqCst);
        let args: Value = js_string::parse(&w.real(&js_string::stringify(&step["args"]))).unwrap();
        let f = str_of(&step["fn"]);
        let got = call(&store, &live, f, args.as_array().unwrap());
        let ctx = format!(
            "store step {i} {f}({})",
            js_string::stringify(&step["args"])
        );
        if expected_difference(step) {
            differences += 1;
            assert_eq!(got, Err("<outside>".into()), "{ctx}");
        } else if let Some(want) = step.get("threw") {
            assert_eq!(
                got.map_err(|e| w.fake(&e)),
                Err(str_of(want).to_owned()),
                "{ctx}"
            );
        } else if step.get("void").is_some() {
            assert_eq!(got, Ok(None), "{ctx}");
        } else {
            let text = got
                .unwrap_or_else(|e| panic!("{ctx}: threw {e}"))
                .map(|v| w.fake(&js_string::stringify(&v)));
            assert_eq!(text.as_deref(), Some(str_of(&step["result"])), "{ctx}");
        }
        let now = w.snapshot();
        if now.0 != last.0 {
            let text = now
                .0
                .as_ref()
                .map(|b| json!(w.fake(&String::from_utf8_lossy(b))));
            assert_eq!(
                step.get("index"),
                Some(&text.unwrap_or(Value::Null)),
                "{ctx}: index"
            );
        } else {
            assert_eq!(step.get("index"), None, "{ctx}: index unchanged");
        }
        if now.1 != last.1 {
            assert_eq!(step.get("tree"), Some(&now.1), "{ctx}: tree");
        } else {
            assert_eq!(step.get("tree"), None, "{ctx}: tree unchanged");
        }
        last = now;
    }
    assert_eq!((calls, differences), (176, 1));
    assert_eq!(
        uuids.load(Ordering::SeqCst),
        13,
        "one randomUUID per created record and publish id"
    );
}

#[test]
fn sha1_matches_node_streamed_or_not() {
    let fx = fixture();
    let dir = tempfile::tempdir().unwrap();
    for v in fx["sha1"].as_array().unwrap() {
        let (len, seed) = (
            v["len"].as_u64().unwrap() as usize,
            v["seed"].as_u64().unwrap() as usize,
        );
        let bytes = pattern(len, seed);
        assert_eq!(sha1_hex(&bytes), str_of(&v["hex"]), "len {len}");
        let p = dir.path().join(format!("f{len}"));
        std::fs::write(&p, &bytes).unwrap();
        let p = p.to_str().unwrap();
        assert_eq!(
            hash_file(p).unwrap(),
            str_of(&v["hex"]),
            "streamed, len {len}"
        );
    }
}

#[test]
fn hash_and_walk_errors_are_nodes() {
    let dir = tempfile::tempdir().unwrap();
    let d = dir.path().canonicalize().unwrap();
    let d = d.to_str().unwrap();
    let missing = format!("{d}/missing");
    assert_eq!(hash_file_or_null(&missing).unwrap(), None);
    assert_eq!(
        hash_file(&missing).unwrap_err().message,
        format!("ENOENT: no such file or directory, open '{missing}'")
    );
    assert_eq!(
        hash_file(d).unwrap_err().message,
        "EISDIR: illegal operation on a directory, read"
    );
    // A missing root is an empty tree; a file root a scandir error.
    assert_eq!(list_source_files(&missing).unwrap(), Vec::<String>::new());
    std::fs::write(format!("{d}/f"), "x").unwrap();
    assert_eq!(
        list_source_files(&format!("{d}/f")).unwrap_err().message,
        format!("ENOTDIR: not a directory, scandir '{d}/f'")
    );
    // JS sort: UTF-16 code units, so an astral name sorts before U+FFFD.
    std::fs::create_dir(format!("{d}/t")).unwrap();
    for n in ["\u{fffd}", "\u{1f600}", "a", "B"] {
        std::fs::write(format!("{d}/t/{n}"), "").unwrap();
    }
    assert_eq!(
        list_source_files(&format!("{d}/t")).unwrap(),
        ["B", "a", "\u{1f600}", "\u{fffd}"]
    );
}

#[test]
fn ids_leaving_the_root_are_refused() {
    let dir = tempfile::tempdir().unwrap();
    let base = dir.path().canonicalize().unwrap();
    let root = base.join("customizations");
    std::fs::create_dir_all(root.join("a")).unwrap();
    std::fs::create_dir_all(base.join("escape/src")).unwrap();
    std::fs::write(base.join("escape/src/x"), "x").unwrap();
    let store = Store::new(root.to_str().unwrap());
    let live = base.to_str().unwrap();
    for id in ["../escape", "x/..", "x/../", ".", "", "a/../.."] {
        assert!(
            matches!(
                store.remove_customization_dir(id),
                Err(customizations::RemoveError::Outside(_))
            ),
            "{id:?}"
        );
        assert!(root.join("a").is_dir() && base.join("escape/src/x").is_file());
    }
    assert_eq!(
        store.compute_diff("../escape", live),
        Err(DiffError::Outside)
    );
    assert_eq!(store.compute_diff("a/../..", live), Err(DiffError::Outside));
    // A leading `/` doesn't reset a join: still inside.
    std::fs::create_dir_all(root.join("etc/src")).unwrap();
    assert!(store.compute_diff("/etc", live).is_ok());
    store.remove_customization_dir("/etc").unwrap();
    assert!(!root.join("etc").exists());
    store.remove_customization_dir("a/").unwrap();
    assert!(!root.join("a").exists() && root.is_dir());
}
