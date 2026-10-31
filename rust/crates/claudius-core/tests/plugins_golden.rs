//! `claudius_core::plugins` against what `rust/scripts/plugins-golden.mjs`
//! recorded from the real TS (`fixtures/plugins_golden.json`, `module`):
//! the pure helpers (`plugin_errors` rows, plugin subdirs, metadata merge,
//! `userConfig` schemas, option edits, marketplace-name lint, the redacted
//! marketplace views and the structural marketplace edits, `?force=`, the
//! 422 text), `listAvailable` over scripted `~/.claude` trees and
//! `enrichInstalled` over scripted plugin dirs. Each input is JSON text,
//! read here as `JSON.parse` reads it ([`js::json_parse`], with
//! [`db_agents::json_parse`] where Infinity matters), and each result is
//! compared as `JSON.stringify` text. The route groups are replayed against
//! the binary by `claudius-server/tests/plugins.rs`.

use std::os::unix::fs::{PermissionsExt, symlink};
use std::path::Path;

use claudius_agent::js;
use claudius_core::db_agents;
use claudius_core::plugins::{self, PluginsError};
use serde_json::{Map, Value, json};

fn fixture() -> Value {
    serde_json::from_str(include_str!("fixtures/plugins_golden.json")).unwrap()
}

/// `JSON.stringify` text of a result, `None` for `undefined`.
fn text(v: Option<Value>) -> Value {
    v.map_or(Value::Null, |v| Value::String(js::stringify(&v)))
}

/// Each `module.<name>` case: `run(plain, twin)` against the recorded `out`.
fn replay(name: &str, min: usize, run: impl Fn(&Value, &Value) -> Value) {
    let fx = fixture();
    let cases = fx["module"][name].as_array().unwrap();
    assert!(cases.len() >= min, "{name}: {} cases", cases.len());
    for case in cases {
        let input = case["in"].as_str().unwrap();
        let plain = js::json_parse(input).unwrap();
        let twin = db_agents::json_parse(input).unwrap();
        assert_eq!(run(&plain, &twin), case["out"], "{name}: {input}");
    }
}

fn str_of<'a>(v: &'a Value, k: &str) -> &'a str {
    v[k].as_str().unwrap()
}

#[test]
fn plugin_errors_match_the_ts() {
    replay("pluginErrors", 25, |v, _| {
        text(Some(Value::Array(plugins::plugin_error_array(
            v.get("plugin_errors"),
        ))))
    });
}

#[test]
fn plugin_subdirs_match_the_ts() {
    replay("subdirs", 30, |v, _| {
        // `null` (not `undefined`) when there's no subdir.
        let dir = plugins::plugin_subdir_from_source(v.get("source"));
        text(Some(dir.map_or(Value::Null, Value::String)))
    });
}

#[test]
fn plugin_meta_matches_the_ts() {
    replay("meta", 12, |v, _| {
        let m = plugins::merge_plugin_meta(v.get("entry"), v.get("manifest"));
        let mut o = Map::new();
        if let Some(d) = m.description {
            o.insert("description".into(), json!(d));
        }
        if let Some(d) = m.display_name {
            o.insert("displayName".into(), json!(d));
        }
        text(Some(Value::Object(o)))
    });
}

#[test]
fn user_config_matches_the_ts() {
    replay("userConfig", 15, |v, twin| {
        text(Some(Value::Array(plugins::parse_user_config(v, twin))))
    });
}

#[test]
fn set_option_matches_the_ts() {
    replay("setOption", 40, |v, _| {
        let next = plugins::set_plugin_option(
            v.get("configs"),
            str_of(v, "pluginId"),
            str_of(v, "name"),
            v.get("value"),
        );
        text(next.map(Value::Object))
    });
}

#[test]
fn marketplace_lint_matches_the_ts() {
    replay("lint", 60, |v, _| {
        let source = v.get("source").unwrap_or(&Value::Null);
        text(plugins::lint_marketplace_name(str_of(v, "name"), source).map(Value::String))
    });
}

#[test]
fn marketplace_views_match_the_ts() {
    replay("redact", 30, |v, _| {
        text(Some(Value::Object(plugins::redact_source(v.get("source")))))
    });
    replay("extra", 12, |v, _| {
        text(Some(Value::Array(plugins::read_extra_marketplaces(
            v.get("raw"),
        ))))
    });
    replay("policy", 8, |v, _| {
        text(Some(Value::Array(plugins::read_policy_marketplaces(
            v.get("raw"),
        ))))
    });
}

#[test]
fn marketplace_edits_match_the_ts() {
    replay("validate", 50, |v, _| {
        text(Some(
            match plugins::validate_add_source(v.get("source").unwrap_or(&Value::Null)) {
                Ok(()) => json!({"ok": true}),
                Err(e) => json!({"ok": false, "error": e}),
            },
        ))
    });
    replay("addExtra", 25, |v, _| {
        let source = v.get("source").unwrap_or(&Value::Null);
        text(Some(
            match plugins::add_extra_entry(v.get("raw"), str_of(v, "name"), source) {
                Ok(next) => json!({"ok": true, "value": next}),
                Err(e) => json!({"ok": false, "error": e}),
            },
        ))
    });
    replay("removeExtra", 15, |v, _| {
        text(plugins::remove_extra_entry(v.get("raw"), str_of(v, "name")))
    });
    replay("removePolicy", 15, |v, twin| {
        let index = v["index"]
            .as_f64()
            .or_else(|| db_agents::infinity(&twin["index"]))
            .unwrap();
        text(plugins::remove_policy_entry(v.get("raw"), index))
    });
}

#[test]
fn force_and_blocked_text_match_the_ts() {
    let fx = fixture();
    let force = fx["module"]["force"].as_array().unwrap();
    assert!(force.len() >= 10);
    for case in force {
        let got = plugins::is_force_reload(case["in"].as_str());
        assert_eq!(Value::Bool(got), case["out"], "{}", case["in"]);
    }
    for case in fx["module"]["blocked"].as_array().unwrap() {
        let got = plugins::plugin_settings_write_blocked_message(
            case["in"][0].as_str().unwrap(),
            case["in"][1].as_str().unwrap(),
        );
        assert_eq!(got, case["out"].as_str().unwrap());
    }
}

/// Run a recorded file operation under `base` (`$HOME` / `$ROOT` in a
/// symlink target or text stand for `base`).
fn apply(base: &Path, op: &Value, var: &str) {
    let b = base.to_str().unwrap();
    let p = base.join(str_of(op, "path"));
    match str_of(op, "op") {
        "write" => {
            std::fs::create_dir_all(p.parent().unwrap()).unwrap();
            let bytes: Vec<u8> = match op.get("bytes") {
                Some(b) => b
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|n| n.as_u64().unwrap() as u8)
                    .collect(),
                None => str_of(op, "text").replace(var, b).into_bytes(),
            };
            std::fs::write(&p, bytes).unwrap();
        }
        "mkdir" => std::fs::create_dir_all(&p).unwrap(),
        "symlink" => {
            std::fs::create_dir_all(p.parent().unwrap()).unwrap();
            symlink(str_of(op, "target").replace(var, b), &p).unwrap();
        }
        "chmod" => std::fs::set_permissions(
            &p,
            std::fs::Permissions::from_mode(op["mode"].as_u64().unwrap() as u32),
        )
        .unwrap(),
        other => panic!("unknown op {other}"),
    }
}

/// Make everything under `dir` removable again.
fn unlock(dir: &Path) {
    let Ok(meta) = std::fs::symlink_metadata(dir) else {
        return;
    };
    if meta.file_type().is_symlink() {
        return;
    }
    let _ = std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o755));
    if meta.is_dir() {
        for e in std::fs::read_dir(dir).into_iter().flatten().flatten() {
            unlock(&e.path());
        }
    }
}

#[test]
fn list_available_matches_the_ts() {
    let fx = fixture();
    let cases = fx["module"]["available"].as_array().unwrap();
    assert!(cases.len() >= 15);
    let mut listed = 0;
    for case in cases {
        let t = tempfile::tempdir().unwrap();
        let home = t.path().canonicalize().unwrap();
        for op in case["ops"].as_array().unwrap() {
            apply(&home, op, "$HOME");
        }
        let h = home.to_str().unwrap();
        let got = plugins::list_available_in(&format!("{h}/.claude"));
        let name = str_of(case, "name");
        match (&got, case.get("threw")) {
            (Ok(list), None) => {
                listed += usize::from(!list.is_empty());
                assert_eq!(
                    js::stringify(&Value::Array(list.clone())),
                    str_of(case, "out"),
                    "{name}"
                );
            }
            (Err(PluginsError::Io(e)), Some(why)) => {
                assert_eq!(
                    format!("Error: {e}").replace(h, "$HOME"),
                    why.as_str().unwrap(),
                    "{name}"
                );
            }
            (got, want) => panic!("{name}: TS {want:?}, Rust {got:?}"),
        }
        unlock(&home);
    }
    assert!(listed >= 10, "{listed} non-empty lists");
}

#[test]
fn enrich_installed_matches_the_ts() {
    let fx = fixture();
    let enrich = &fx["module"]["enrich"];
    let t = tempfile::tempdir().unwrap();
    let root = t.path().canonicalize().unwrap();
    let r = root.to_str().unwrap();
    for op in enrich["ops"].as_array().unwrap() {
        apply(&root, op, "$ROOT");
    }
    let cases = enrich["cases"].as_array().unwrap();
    assert!(cases.len() >= 20);
    for case in cases {
        let input = str_of(case, "in");
        let raw = js::json_parse(&input.replace("$ROOT", r)).unwrap();
        let got = plugins::enrich_installed(raw.as_array().unwrap());
        assert_eq!(
            js::stringify(&Value::Array(got)).replace(r, "$ROOT"),
            str_of(case, "out"),
            "{input}"
        );
    }
}
