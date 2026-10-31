//! The disk side of `fixtures/account_oauth_golden.json` (recorded by
//! `rust/scripts/account-oauth-golden.mjs`): a case's world (`files`), the
//! recorder's tree snapshot and its `$W` / `$PID` placeholders, and the
//! request bodies with their `$FLOWn` / `$STATEn` stand-ins. Shared with
//! claudius-server's `tests/accounts_oauth.rs` (`#[path]`).
#![allow(dead_code)] // each test binary uses a different subset

use std::collections::BTreeMap;
use std::os::unix::fs::PermissionsExt;
use std::path::Path;

use serde_json::{Value, json};

pub fn fixture() -> Value {
    serde_json::from_str(include_str!("../fixtures/account_oauth_golden.json")).unwrap()
}

pub fn hex(s: &str) -> Vec<u8> {
    (0..s.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&s[i..i + 2], 16).unwrap())
        .collect()
}

/// `$W` in a fixture value, as the world's path.
pub fn fill(w: &str, v: &Value) -> Value {
    serde_json::from_str(&v.to_string().replace("$W", w)).unwrap()
}

/// The recorder's `sub`: the world and this pid as placeholders.
pub fn sub(w: &str, s: &str) -> String {
    s.replace(w, "$W")
        .replace(&format!(".{}.", std::process::id()), ".$PID.")
}

/// A step's request body: `bodyHex`, or `body` with `$FLOWn` / `$STATEn`
/// replaced by the n-th started flow's `(flowId, state)`.
pub fn request_body(step: &Value, flows: &[(String, String)]) -> Vec<u8> {
    if let Some(h) = step["bodyHex"].as_str() {
        return hex(h);
    }
    fill_flows(step["body"].as_str().unwrap(), flows).into_bytes()
}

/// `$FLOWn` / `$STATEn` replaced (longest index first, so `$FLOW1` doesn't
/// eat `$FLOW10`).
pub fn fill_flows(s: &str, flows: &[(String, String)]) -> String {
    let mut out = s.to_owned();
    for (n, (flow, state)) in flows.iter().enumerate().rev() {
        out = out
            .replace(&format!("$FLOW{n}"), flow)
            .replace(&format!("$STATE{n}"), state);
    }
    assert!(
        !out.contains("$FLOW") && !out.contains("$STATE"),
        "a placeholder before its start: {s}"
    );
    out
}

/// Make everything under `p` deletable again.
pub fn unlock(p: &Path) {
    let Ok(st) = std::fs::symlink_metadata(p) else {
        return;
    };
    if st.file_type().is_symlink() {
        return;
    }
    let mode = if st.is_dir() { 0o700 } else { 0o600 };
    let _ = std::fs::set_permissions(p, std::fs::Permissions::from_mode(mode));
    if st.is_dir()
        && let Ok(rd) = std::fs::read_dir(p)
    {
        for e in rd.flatten() {
            unlock(&e.path());
        }
    }
}

/// The recorder's `buildFiles` under `w` (`files` already holds `$W`).
pub fn build(w: &str, files: &Value) {
    let files = fill(w, files);
    let Some(entries) = files.as_object() else {
        return;
    };
    for (rel, spec) in entries {
        let p = format!("{w}/{rel}");
        if spec["delete"] == true {
            unlock(Path::new(&p));
            let _ = std::fs::remove_dir_all(&p).or_else(|_| std::fs::remove_file(&p));
            continue;
        }
        std::fs::create_dir_all(Path::new(&p).parent().unwrap()).unwrap();
        if spec["dir"] == true {
            std::fs::create_dir_all(&p).unwrap();
        } else if let Some(target) = spec["symlink"].as_str() {
            std::os::unix::fs::symlink(target, &p).unwrap();
        } else if let Some(h) = spec["hex"].as_str() {
            std::fs::write(&p, hex(h)).unwrap();
        } else {
            std::fs::write(&p, spec["text"].as_str().unwrap()).unwrap();
        }
    }
    for (rel, spec) in entries.iter().rev() {
        if let Some(m) = spec["mode"].as_str()
            && spec["delete"] != true
        {
            let mode = u32::from_str_radix(m, 8).unwrap();
            std::fs::set_permissions(format!("{w}/{rel}"), std::fs::Permissions::from_mode(mode))
                .unwrap();
        }
    }
}

/// The recorder's `tree` of `w`, minus the top-level names in `skip`.
pub fn tree(w: &str, skip: &[&str]) -> BTreeMap<String, Value> {
    let mut out = BTreeMap::new();
    walk(w, "", skip, &mut out);
    out
}

fn walk(w: &str, rel: &str, skip: &[&str], out: &mut BTreeMap<String, Value>) {
    let dir = if rel.is_empty() {
        w.to_owned()
    } else {
        format!("{w}/{rel}")
    };
    let Ok(rd) = std::fs::read_dir(&dir) else {
        return;
    };
    let mut names: Vec<String> = rd
        .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
        .collect();
    names.sort();
    for name in names {
        if rel.is_empty() && skip.contains(&name.as_str()) {
            continue;
        }
        let r = if rel.is_empty() {
            name
        } else {
            format!("{rel}/{name}")
        };
        let full = format!("{w}/{r}");
        let st = std::fs::symlink_metadata(&full).unwrap();
        let m = format!("{:o}", st.permissions().mode() & 0o777);
        if st.file_type().is_symlink() {
            let to = std::fs::read_link(&full).unwrap().display().to_string();
            out.insert(r, json!({"t": "l", "to": sub(w, &to)}));
        } else if st.is_dir() {
            out.insert(r.clone(), json!({"t": "d", "m": m}));
            walk(w, &r, skip, out);
        } else {
            let entry = match std::fs::read(&full) {
                Err(_) => json!({"t": "f", "m": m}),
                Ok(b) => match String::from_utf8(b) {
                    Ok(x) => json!({"t": "f", "m": m, "x": x}),
                    Err(e) => {
                        let h: String = e.as_bytes().iter().map(|b| format!("{b:02x}")).collect();
                        json!({"t": "f", "m": m, "h": h})
                    }
                },
            };
            out.insert(r, entry);
        }
    }
}

/// A recorded tree as a map.
pub fn recorded_tree(v: &Value) -> BTreeMap<String, Value> {
    v.as_object()
        .unwrap()
        .iter()
        .map(|(k, v)| (k.clone(), v.clone()))
        .collect()
}

// ---- known differences ------------------------------------------------------------

/// Where Rust knowingly differs: in case `name`, every expected string (the
/// answers, the bodies handed to fetch and seen on the wire, file texts)
/// reads with `from` replaced by `to`. Request bodies and scripted
/// responses stay as recorded.
pub const REPLACE: &[(&str, &str, &str, &str)] = &[
    (
        "divergent: a lone surrogate in the code",
        "\\ud800",
        "\u{fffd}",
        "js::json_parse reads a lone-surrogate escape as U+FFFD, so the token request carries U+FFFD where TS sends the lone surrogate (JSON.stringify writes it as `\\ud800`)",
    ),
    (
        "divergent: expires_in past the f64 range",
        ",\n      \"expiresAt\": null",
        "",
        "js::json_parse reads 1e400 as null, which isn't a number, so no expiresAt is stored; TS reads Infinity, a number, and stores `\"expiresAt\": null`",
    ),
];

/// Steps replayed with their own expectation: `(case, step, fields that
/// replace the recorded ones, reason)`.
pub const OVERRIDE: &[(&str, usize, &str, &str)] = &[(
    "divergent: a body nested past 128 levels",
    0,
    r#"{"got": {"status": 400, "type": "application/json", "body": "{\"error\":\"invalid JSON\"}"}, "rng": [], "pending": 0}"#,
    "serde_json stops at 128 levels of nesting, so the body is `invalid JSON` and no flow starts; V8 parses it and starts one",
)];

fn replace_leaves(v: &mut Value, from: &str, to: &str) {
    match v {
        Value::String(s) => *s = s.replace(from, to),
        Value::Array(a) => a.iter_mut().for_each(|x| replace_leaves(x, from, to)),
        Value::Object(o) => o.values_mut().for_each(|x| replace_leaves(x, from, to)),
        _ => {}
    }
}

/// The case as Rust should replay it: [`REPLACE`] on every expectation,
/// [`OVERRIDE`] on its steps.
pub fn expected_case(case: &Value) -> Value {
    let name = case["name"].as_str().unwrap();
    let mut case = case.clone();
    for (_, from, to, _) in REPLACE.iter().filter(|r| r.0 == name) {
        for step in case["steps"].as_array_mut().unwrap() {
            for k in ["got", "out", "throws", "tree", "wire"] {
                if let Some(v) = step.get_mut(k) {
                    replace_leaves(v, from, to);
                }
            }
            for f in step["fetches"].as_array_mut().into_iter().flatten() {
                replace_leaves(&mut f["body"], from, to);
            }
        }
    }
    for (_, i, patch, _) in OVERRIDE.iter().filter(|o| o.0 == name) {
        let patch: Value = serde_json::from_str(patch).unwrap();
        let step = &mut case["steps"][*i];
        for (k, v) in patch.as_object().unwrap() {
            step[k] = v.clone();
        }
        if step["rng"] == json!([]) {
            step.as_object_mut().unwrap().remove("rng");
        }
    }
    case
}

/// Every listed difference still names a recorded case and still changes it.
pub fn check_known_differences(fixture: &Value) {
    let cases = fixture["cases"].as_array().unwrap();
    let find = |name: &str| {
        cases
            .iter()
            .find(|c| c["name"] == name)
            .unwrap_or_else(|| panic!("stale entry: no case {name:?}"))
    };
    for (name, from, _, _) in REPLACE {
        let case = find(name);
        assert_ne!(
            &expected_case(case),
            case,
            "stale REPLACE {name:?} ({from:?})"
        );
    }
    for (name, i, _, _) in OVERRIDE {
        let case = find(name);
        assert!(case["steps"].get(*i).is_some(), "stale OVERRIDE {name:?}");
        assert_ne!(&expected_case(case), case, "stale OVERRIDE {name:?}");
    }
}
