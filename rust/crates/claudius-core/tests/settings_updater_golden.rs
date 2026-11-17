//! Replays `fixtures/settings_updater_golden.json`, recorded by
//! `rust/scripts/settings-updater-golden.mjs` from the real TS: the updater
//! half of the settings backup, now over `claudius_core::updater::settings`
//! (D27c).
//!
//! * `files`: `settings_export::build_export_bundle`'s
//!   `system.updaterSettings` over each hand-written `updater.json` (odd
//!   types, unparsable text, number text, ±Infinity, lone surrogates, 140
//!   levels of nesting, odd keys, invalid UTF-8, a directory, symlinks), then
//!   `settings_import::start_import` with every knob and with `{}` over the
//!   same file.
//! * `bundles`: `start_import` over one baseline file with each odd
//!   `system.updaterSettings` value.
//!
//! Each case's world is rebuilt under a temp `$HOME`; the progress is
//! compared as `JSON.stringify` text (the import id as `$IMP`, the temp root
//! as `$ROOT`), the export block likewise, and `updater.json` afterwards as
//! the recorder reads it: missing, a directory, a symlink (its target and
//! the text through it) or a file (its mode and text, or bytes).
#![cfg(unix)]

use std::os::unix::fs::PermissionsExt;
use std::path::PathBuf;
use std::sync::{Mutex, MutexGuard, OnceLock};

use claudius_agent::js;
use claudius_core::{paths, settings_export, settings_import};
use serde_json::{Map, Value, json};

fn fixture() -> &'static Value {
    static F: OnceLock<Value> = OnceLock::new();
    F.get_or_init(|| {
        let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("tests/fixtures/settings_updater_golden.json");
        serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap()
    })
}

/// Where Rust knowingly differs from the recording: in `section`'s case
/// `label`, `field` (`export`, or the text of `after`) reads as the TS text
/// with `from` replaced by `to`.
const KNOWN: &[(&str, &str, &str, &str, &str, &str)] = &[
    (
        "files",
        "lone surrogates in the knobs",
        "export",
        "\\udc00",
        "\u{fffd}",
        "the bundle has U+FFFD for a lone surrogate, as for every other file it carries (js::stringify can't write the escape)",
    ),
    (
        "files",
        "lone surrogates in the knobs",
        "export",
        "\\ud800",
        "\u{fffd}",
        "as above",
    ),
    (
        "bundles",
        "lone surrogates",
        "after",
        "\\ud800",
        "\u{fffd}",
        "the import reads its session with js::json_parse, so a lone surrogate in the bundle is U+FFFD (PORT_PLAN Known gaps, Settings backup)",
    ),
    (
        "bundles",
        "lone surrogates",
        "after",
        "\\udfff",
        "\u{fffd}",
        "as above",
    ),
];

/// The TS `text` as Rust gives it: `KNOWN`'s replacements for this field
/// applied, each of which must change it.
fn expected(section: &str, label: &str, field: &str, text: &str) -> String {
    let mut out = text.to_owned();
    for (s, l, f, from, to, why) in KNOWN {
        if (*s, *l, *f) == (section, label, field) {
            assert!(
                out.contains(from),
                "{section} / {label}: KNOWN {from:?} isn't in the recorded {field} ({why})"
            );
            out = out.replace(from, to);
        }
    }
    out
}

struct World {
    _dir: tempfile::TempDir,
    root: PathBuf,
}

/// One temp `$HOME` for the binary (the override is process-wide and
/// first-call-wins). Cases share it, so they run one at a time.
fn world() -> (&'static World, MutexGuard<'static, ()>) {
    static W: OnceLock<World> = OnceLock::new();
    static SERIAL: Mutex<()> = Mutex::new(());
    let w = W.get_or_init(|| {
        // As the recorder's child: files are created 0o644.
        // SAFETY: `umask` only sets the process's file-creation mask.
        unsafe { libc::umask(0o022) };
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().canonicalize().unwrap();
        assert!(paths::set_home_override(root.join("home")));
        assert!(paths::set_config_dir_override(root.join("config")));
        World { _dir: dir, root }
    });
    (w, SERIAL.lock().unwrap_or_else(|e| e.into_inner()))
}

const P: &str = "home/.claude/.claudius/updater.json";

impl World {
    fn root_text(&self) -> String {
        self.root.display().to_string()
    }

    fn abs(&self, text: &str) -> String {
        text.replace("$ROOT", &self.root_text())
    }

    /// The recorder's `normalize`: the temp root and the import id.
    fn normalize(&self, text: &str) -> String {
        let text = text.replace(&self.root_text(), "$ROOT");
        regex::Regex::new("imp_[0-9a-f]{16}")
            .unwrap()
            .replace_all(&text, "$$IMP")
            .into_owned()
    }

    /// `buildWorld()` then the case's ops.
    fn set_up(&self, ops: &Value) {
        for d in ["home", "extra", "config", "nowhere"] {
            let _ = std::fs::remove_dir_all(self.root.join(d));
        }
        std::fs::create_dir_all(self.root.join("home/.claude/.claudius")).unwrap();
        std::fs::create_dir(self.root.join("extra")).unwrap();
        std::fs::create_dir(self.root.join("config")).unwrap();
        std::fs::write(
            self.root.join("home/.claude/.claudius/workspaces.json"),
            "{\"version\":1,\"workspaces\":[]}\n",
        )
        .unwrap();
        for op in ops.as_array().unwrap() {
            let path = self.root.join(op[1].as_str().unwrap());
            match op[0].as_str().unwrap() {
                "write" => std::fs::write(&path, self.abs(op[2].as_str().unwrap())).unwrap(),
                "bytes" => {
                    let bytes: Vec<u8> = op[2]
                        .as_array()
                        .unwrap()
                        .iter()
                        .map(|b| b.as_u64().unwrap() as u8)
                        .collect();
                    std::fs::write(&path, bytes).unwrap();
                }
                "mkdir" => std::fs::create_dir(&path).unwrap(),
                "symlink" => {
                    std::os::unix::fs::symlink(self.abs(op[2].as_str().unwrap()), &path).unwrap()
                }
                "chmod" => std::fs::set_permissions(
                    &path,
                    std::fs::Permissions::from_mode(op[2].as_u64().unwrap() as u32),
                )
                .unwrap(),
                other => panic!("unknown op {other}"),
            }
        }
    }

    /// The recorder's `entry()`: `updater.json` as it is now.
    fn entry(&self) -> Value {
        let abs = self.root.join(P);
        let Ok(st) = std::fs::symlink_metadata(&abs) else {
            return Value::Null;
        };
        let content = |mut out: Map<String, Value>| {
            if let Ok(buf) = std::fs::read(&abs) {
                match String::from_utf8(buf) {
                    Ok(text) => out.insert("text".into(), json!(self.normalize(&text))),
                    Err(e) => out.insert("bytes".into(), json!(e.into_bytes())),
                };
            }
            Value::Object(out)
        };
        let mut out = Map::new();
        if st.file_type().is_symlink() {
            out.insert("kind".into(), json!("symlink"));
            let target = std::fs::read_link(&abs).unwrap();
            out.insert(
                "target".into(),
                json!(self.normalize(&target.display().to_string())),
            );
            content(out)
        } else if st.is_dir() {
            out.insert("kind".into(), json!("dir"));
            Value::Object(out)
        } else {
            out.insert("kind".into(), json!("file"));
            out.insert("mode".into(), json!(st.permissions().mode() & 0o777));
            content(out)
        }
    }

    fn exported(&self) -> Value {
        match settings_export::build_export_bundle(0) {
            Ok(bundle) => json!(js::stringify(&bundle["system"]["updaterSettings"])),
            Err(e) => json!({"threw": self.normalize(&format!("{}: {}", e.name, e.message))}),
        }
    }

    /// `startImport(JSON.parse(bundle))`: the progress and `updater.json`.
    fn imported(&self, bundle: &str) -> (Value, Value) {
        let parsed = js::json_parse(bundle).unwrap();
        assert!(settings_import::validate_bundle(&parsed), "{bundle}");
        let got = match settings_import::start_import(&parsed) {
            Ok(progress) => json!(self.normalize(&js::stringify(&progress))),
            Err(e) => json!({"threw": self.normalize(&format!("{}: {}", e.name, e.message))}),
        };
        (got, self.entry())
    }
}

/// `after` as Rust should leave it: the recorded entry with `KNOWN` applied
/// to its text.
fn expected_after(section: &str, label: &str, after: &Value) -> Value {
    let mut after = after.clone();
    if let Some(text) = after.get("text").and_then(Value::as_str) {
        let text = expected(section, label, "after", text);
        after["text"] = json!(text);
    }
    after
}

/// Every mismatch, so one run lists them all.
#[derive(Default)]
struct Diffs(Vec<String>);

impl Diffs {
    fn check(&mut self, got: &Value, want: &Value, what: String) {
        if got != want {
            self.0.push(format!("{what}:\n   got {got}\n  want {want}"));
        }
    }

    fn assert_none(self) {
        assert!(
            self.0.is_empty(),
            "{} mismatches:\n{}",
            self.0.len(),
            self.0.join("\n")
        );
    }
}

#[test]
fn the_export_and_import_match_the_ts_over_each_file() {
    let (w, _guard) = world();
    let files = fixture()["files"].as_array().unwrap();
    assert!(files.len() >= 30, "only {} files", files.len());
    let mut diffs = Diffs::default();
    for case in files {
        let label = case["label"].as_str().unwrap();
        w.set_up(&case["setup"]);
        let want = match &case["export"] {
            Value::String(s) => json!(expected("files", label, "export", s)),
            v => v.clone(),
        };
        diffs.check(
            &w.exported(),
            &want,
            format!("export over the file with {label}"),
        );
        for (i, imp) in case["imports"].as_array().unwrap().iter().enumerate() {
            w.set_up(&case["setup"]);
            let (got, after) = w.imported(imp["bundle"].as_str().unwrap());
            diffs.check(
                &got,
                &imp["got"],
                format!("import {i} over the file with {label}"),
            );
            diffs.check(
                &after,
                &expected_after("files", label, &imp["after"]),
                format!("updater.json after import {i} over the file with {label}"),
            );
        }
    }
    diffs.assert_none();
}

#[test]
fn the_import_matches_the_ts_for_each_updater_block() {
    let (w, _guard) = world();
    let baseline = json!([["write", P, fixture()["baseline"]]]);
    let bundles = fixture()["bundles"].as_array().unwrap();
    assert!(bundles.len() >= 50, "only {} bundles", bundles.len());
    let mut diffs = Diffs::default();
    for case in bundles {
        let label = case["label"].as_str().unwrap();
        w.set_up(&baseline);
        let (got, after) = w.imported(case["bundle"].as_str().unwrap());
        diffs.check(&got, &case["got"], format!("import with {label}"));
        diffs.check(
            &after,
            &expected_after("bundles", label, &case["after"]),
            format!("updater.json after the import with {label}"),
        );
    }
    diffs.assert_none();
}

#[test]
fn every_known_difference_is_a_recorded_case() {
    for (section, label, field, ..) in KNOWN {
        let cases = fixture()[*section].as_array().unwrap();
        assert!(
            cases.iter().any(|c| c["label"] == *label),
            "KNOWN names {section} / {label}, which isn't recorded"
        );
        assert!(["export", "after"].contains(field), "{field}");
    }
}
