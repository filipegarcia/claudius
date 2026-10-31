//! Replays `fixtures/spinner_tips_golden.json`, recorded by
//! `rust/scripts/spinner-tips-golden.mjs` from the real TS source:
//! `normalizeSpinnerTipsOverride`, `mergeSpinnerTipsFile`, the
//! `spinnerTipsConfig` block of `start()` (after `readSettings`) and the
//! `selectTips` call behind `subscribe()`'s `tips` event. Each case's
//! settings.json and files are recreated under a temp `$HOME`, read through
//! `settings::read_settings_js`, and every stage is compared as `JSON.stringify`
//! text. `joins` replays the `~/` expansion against odd home dirs.
#![cfg(unix)]

use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};

use claudius_agent::js;
use claudius_core::events::DEFAULT_TIPS;
use claudius_core::settings::{self, Scope};
use claudius_core::spinner_tips::{
    SPINNER_TIPS_FILE_MAX_BYTES, SpinnerTipsConfig, SpinnerTipsOverride, expand_tips_file,
    merge_spinner_tips_file, normalize_spinner_tips_override,
};
use claudius_core::{events, paths};
use serde_json::Value;

fn fixture() -> Value {
    let path =
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/spinner_tips_golden.json");
    serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap()
}

/// Where Rust knowingly differs from the recording, and what it does instead.
enum Known {
    /// `json_parse` reads an out-of-range number as `null` (a
    /// `serde_json::Value` has no `Infinity`): the `priority` TS keeps (and
    /// `JSON.stringify` writes as `null`) is dropped.
    InfinityDropped,
    /// serde_json rejects a file `JSON.parse` takes: the inline tips stay.
    FileIgnored,
}

const KNOWN: &[(&str, Known, &str)] = &[
    (
        "settings 1e400 priority",
        Known::InfinityDropped,
        "JSON.parse reads 1e400 as Infinity, a number; json_parse reads it as null",
    ),
    (
        "file lone surrogate",
        Known::FileIgnored,
        "a lone-surrogate escape is valid for JSON.parse, not serde_json",
    ),
    (
        "file 1e400 priority",
        Known::FileIgnored,
        "JSON.parse reads 1e400 as Infinity; serde_json refuses the number",
    ),
    (
        "file nested 200 deep",
        Known::FileIgnored,
        "serde_json stops at 128 levels of nesting",
    ),
];

struct Home {
    _root: tempfile::TempDir,
    home: PathBuf,
    text: String,
}

/// One temp `$HOME` for the binary (`paths::set_home_override` is
/// process-wide and first-call-wins).
fn home() -> &'static Home {
    static H: std::sync::OnceLock<Home> = std::sync::OnceLock::new();
    H.get_or_init(|| {
        let root = tempfile::tempdir().unwrap();
        let home = root.path().canonicalize().unwrap().join("home");
        std::fs::create_dir(&home).unwrap();
        assert!(paths::set_home_override(home.clone()));
        let text = home.to_str().unwrap().to_owned();
        assert_eq!(serde_json::to_string(&text).unwrap(), format!("\"{text}\""));
        Home {
            _root: root,
            home,
            text,
        }
    })
}

fn hex(s: &str) -> Vec<u8> {
    (0..s.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&s[i..i + 2], 16).unwrap())
        .collect()
}

fn wipe(home: &Path) {
    for e in std::fs::read_dir(home).unwrap() {
        let p = e.unwrap().path();
        if p.is_dir() && !p.is_symlink() {
            std::fs::remove_dir_all(&p).unwrap();
        } else {
            std::fs::remove_file(&p).unwrap();
        }
    }
}

/// Writes the case's settings.json and files; `false` when a file the case
/// needs unreadable can still be read (running as root).
fn write_case(h: &Home, c: &Value) -> bool {
    let fill = |s: &str| s.replace("$HOME", &h.text);
    let settings = match (&c["settings"], &c["settingsHex"]) {
        (Value::String(s), _) => Some(fill(s).into_bytes()),
        (_, Value::String(x)) => Some(hex(x)),
        _ => None,
    };
    if let Some(body) = settings {
        std::fs::create_dir_all(h.home.join(".claude")).unwrap();
        std::fs::write(h.home.join(".claude/settings.json"), body).unwrap();
    }
    let mut ok = true;
    for f in c["files"].as_array().into_iter().flatten() {
        let p = h.home.join(f["path"].as_str().unwrap());
        std::fs::create_dir_all(p.parent().unwrap()).unwrap();
        if f["dir"] == true {
            std::fs::create_dir(&p).unwrap();
        } else if let Some(target) = f["symlink"].as_str() {
            std::os::unix::fs::symlink(fill(target), &p).unwrap();
        } else {
            let mut body = match f["hex"].as_str() {
                Some(x) => hex(x),
                None => f["text"].as_str().unwrap().as_bytes().to_vec(),
            };
            if let Some(n) = f["padTo"].as_u64() {
                body.resize(n as usize, b' ');
            }
            std::fs::write(&p, body).unwrap();
            if let Some(mode) = f["mode"].as_u64() {
                std::fs::set_permissions(&p, std::fs::Permissions::from_mode(mode as u32)).unwrap();
                ok &= std::fs::read(&p).is_err();
            }
        }
    }
    ok
}

/// `JSON.stringify` text with the temp home spelled `$HOME` again.
fn text(h: &Home, v: Option<Value>) -> Value {
    v.map_or(Value::Null, |v| {
        Value::String(js::stringify(&v).replace(&h.text, "$HOME"))
    })
}

#[test]
fn replays_the_ts_recording() {
    let fx = fixture();
    let h = home();
    assert_eq!(fx["maxBytes"], SPINNER_TIPS_FILE_MAX_BYTES);
    let defaults = fx["defaultTips"].as_str().unwrap();
    assert_eq!(js::stringify(&DEFAULT_TIPS), defaults, "DEFAULT_TIPS");
    let inner = &defaults[1..defaults.len() - 1];
    let expand = |t: &Value| match t {
        Value::String(s) => Value::String(s.replace("\"$DEFAULT_TIPS\"", inner)),
        v => v.clone(),
    };

    let cases = fx["cases"].as_array().unwrap();
    let mut checked = 0;
    let mut known_seen = 0;
    for c in cases {
        let name = c["name"].as_str().unwrap();
        wipe(&h.home);
        if !write_case(h, c) {
            eprintln!("skipped {name:?}: its unreadable file is readable here (root?)");
            continue;
        }
        // `readSettings(…).catch(() => ({}))`, as `start()` reads it.
        let user = settings::read_settings_js(Scope::User, "/")
            .unwrap_or_else(|_| Some(Default::default()));
        let Some(user) = user else {
            // `start()` throws reading `spinnerTipsEnabled` off a `null` file.
            let msg = settings::null_property_error("spinnerTipsEnabled");
            assert_eq!(
                c["config"],
                serde_json::json!({"throws": msg}).to_string(),
                "{name:?}"
            );
            for k in ["normalized", "merged", "tips"] {
                assert_eq!(c[k], Value::Null, "{name:?}: {k}");
            }
            checked += 1;
            continue;
        };
        let normalized = normalize_spinner_tips_override(user.get("spinnerTipsOverride"));
        let merged = merge_spinner_tips_file(normalized.clone(), &h.home);
        let config = SpinnerTipsConfig::from_settings(&user, &paths::home_dir());
        let got = [
            (
                "normalized",
                text(h, normalized.as_ref().map(SpinnerTipsOverride::to_json)),
            ),
            (
                "merged",
                text(h, merged.as_ref().map(SpinnerTipsOverride::to_json)),
            ),
            ("config", text(h, Some(config.to_json()))),
            ("tips", text(h, Some(config.tips()))),
        ];
        let want = |k: &str| {
            if k == "tips" {
                expand(&c[k])
            } else {
                c[k].clone()
            }
        };
        if let Some((_, known, why)) = KNOWN.iter().find(|(n, ..)| *n == name) {
            known_seen += 1;
            assert_ne!(
                got[3].1,
                want("tips"),
                "{name:?} is listed as a known difference but matches: drop it from KNOWN"
            );
            match known {
                Known::InfinityDropped => {
                    for (k, v) in &got {
                        let want = want(k).as_str().unwrap().replace(",\"priority\":null", "");
                        assert_eq!(*v, Value::String(want), "{name:?}: {k}: {why}");
                    }
                }
                Known::FileIgnored => {
                    assert_eq!(got[0].1, want("normalized"), "{name:?}: normalized");
                    let mut inline = normalized.clone().unwrap();
                    inline.tips_file = None;
                    assert_eq!(merged.as_ref(), Some(&inline), "{name:?}: {why}");
                    assert_eq!(config.over.as_ref(), Some(&inline), "{name:?}");
                }
            }
            continue;
        }
        for (k, v) in &got {
            assert_eq!(*v, want(k), "{name:?}: {k}");
        }
        checked += 1;
    }
    wipe(&h.home);
    assert_eq!(
        known_seen,
        KNOWN.len(),
        "a KNOWN case is missing from the fixture"
    );
    assert!(checked >= 110, "only {checked} cases matched");
}

#[test]
fn replays_the_home_expansion() {
    let fx = fixture();
    let joins = fx["joins"].as_array().unwrap();
    assert!(joins.len() > 200);
    for j in joins {
        let (home, tips_file) = (j["home"].as_str().unwrap(), j["tipsFile"].as_str().unwrap());
        let want = (j["absolute"] == true).then(|| j["expanded"].as_str().unwrap().to_owned());
        assert_eq!(
            expand_tips_file(tips_file, home),
            want,
            "{home:?} + {tips_file:?}"
        );
    }
}

#[test]
fn select_tips_without_an_override_is_the_catalog() {
    assert_eq!(events::select_tips(None, None), *DEFAULT_TIPS);
    assert_eq!(events::select_tips(Some(true), None), *DEFAULT_TIPS);
    assert_eq!(
        events::select_tips(Some(false), None),
        serde_json::json!([])
    );
}
