//! Replays `tests/fixtures/managed_settings_golden.json`, recorded from the
//! real SDK's `resolveSettings()` by `rust/scripts/managed-settings-golden.mjs`.
//! Each case's managed dir and plist root are rebuilt in a temp dir and
//! resolved with `managed_settings::{read_mdm_tier | registry_policy,
//! file_tier, resolve}`. Registry cases feed the captured `reg query`
//! outputs to `registry_policy` (the recorder ran the SDK's win32 branch on
//! them), so they replay on every platform. WSL cases (`wsl: true`) also
//! stage the Windows managed folder (`win`) the SDK read through `/mnt/c`. The three managed keys, `policyOrigin`, the model policy
//! and the pricing must match the SDK. Values are compared through
//! `js::stringify`, so number forms and integer-key order count too. The
//! plist cases run on macOS only (the SDK reads plists only there, with
//! `/usr/bin/plutil`). Cases with a `remote` cache aren't staged at all: the
//! SDK ignores that cache, and their expected results show it.

use std::path::Path;

use claudius_agent::js;
use claudius_core::managed_settings::{self, ManagedModelPolicy, OsPolicy, RegRead};
use serde_json::{Value, json};

fn fixture() -> Vec<Value> {
    let raw = std::fs::read_to_string(
        Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/managed_settings_golden.json"),
    )
    .unwrap();
    let v: Value = serde_json::from_str(&raw).unwrap();
    v["cases"].as_array().unwrap().clone()
}

fn fixture_reg_calls() -> Value {
    let raw = std::fs::read_to_string(
        Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/managed_settings_golden.json"),
    )
    .unwrap();
    serde_json::from_str::<Value>(&raw).unwrap()["regCalls"].clone()
}

/// The bytes of a file spec: raw text, `{base64}`, or `{text, padTo}`
/// (padded with spaces to `padTo` bytes).
fn file_bytes(spec: &Value) -> Vec<u8> {
    if let Some(text) = spec.as_str() {
        return text.as_bytes().to_vec();
    }
    if let Some(b64) = spec["base64"].as_str() {
        return base64_decode(b64);
    }
    let text = spec["text"].as_str().unwrap();
    let pad = spec["padTo"].as_u64().unwrap() as usize - text.len();
    format!("{text}{}", " ".repeat(pad)).into_bytes()
}

/// One hive's captured `reg query` result, as `mw` would report it: a
/// non-zero exit (or no capture) fails, and output over the 2 MiB buffer
/// overflows.
fn reg_read(spec: &Value) -> RegRead {
    if spec.is_null() || spec["code"].as_i64().unwrap_or(0) != 0 {
        return RegRead::Failed;
    }
    let pad = spec["pad"].as_u64().unwrap_or(0) as usize;
    let out = format!("{}{}", spec["out"].as_str().unwrap(), " ".repeat(pad));
    if out.len() > managed_settings::REG_MAX_BUFFER {
        RegRead::Overflow
    } else {
        RegRead::Ok(out)
    }
}

/// Rebuild the case's plists under `<tmp>/mdm` (`user` in `<user>/`, `device`
/// at the root) and its managed dir under `<tmp>/managed`: `dirs`, then
/// `files` (raw text), then `symlinks`, the same order the recorder used.
fn stage(case: &Value, user: &str) -> tempfile::TempDir {
    let tmp = tempfile::tempdir().unwrap();
    let mdm = tmp.path().join("mdm");
    let plist = "com.anthropic.claudecode.plist";
    std::fs::create_dir_all(mdm.join(user)).unwrap();
    for (role, spec) in case["plists"].as_object().into_iter().flatten() {
        let path = match role.as_str() {
            "user" => mdm.join(user).join(plist),
            _ => mdm.join(plist),
        };
        if spec["dir"] == true {
            std::fs::create_dir(&path).unwrap();
        } else if let Some(b64) = spec["base64"].as_str() {
            std::fs::write(&path, base64_decode(b64)).unwrap();
        } else {
            std::fs::write(&path, spec["xml"].as_str().unwrap()).unwrap();
        }
        #[cfg(unix)]
        if let Some(mode) = spec["mode"].as_u64() {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(mode as u32)).unwrap();
        }
    }
    stage_tree(&tmp.path().join("managed"), case);
    stage_tree(&tmp.path().join("win"), &case["win"]);
    tmp
}

/// Rebuild one managed folder from a tree spec: `dirs`, then `files`, then
/// `symlinks`, the order the recorder used.
fn stage_tree(root: &Path, case: &Value) {
    std::fs::create_dir(root).unwrap();
    for d in case["dirs"].as_array().into_iter().flatten() {
        std::fs::create_dir_all(root.join(d.as_str().unwrap())).unwrap();
    }
    for (rel, spec) in case["files"].as_object().into_iter().flatten() {
        let path = root.join(rel);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, file_bytes(spec)).unwrap();
    }
    for (rel, target) in case["symlinks"].as_object().into_iter().flatten() {
        let path = root.join(rel);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        #[cfg(unix)]
        std::os::unix::fs::symlink(target.as_str().unwrap(), path).unwrap();
        #[cfg(not(unix))]
        let _ = (path, target);
    }
}

/// Undo a chmod so the temp dir can be removed.
fn unstage(tmp: &tempfile::TempDir, user: &str) {
    #[cfg(unix)]
    for dir in [tmp.path().join("mdm").join(user), tmp.path().join("mdm")] {
        use std::os::unix::fs::PermissionsExt;
        let path = dir.join("com.anthropic.claudecode.plist");
        if path.is_file() {
            let _ = std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o644));
        }
    }
    #[cfg(not(unix))]
    let _ = (tmp, user);
}

/// Standard base64 (the fixture's binary plists).
fn base64_decode(s: &str) -> Vec<u8> {
    let val = |c: u8| match c {
        b'A'..=b'Z' => c - b'A',
        b'a'..=b'z' => c - b'a' + 26,
        b'0'..=b'9' => c - b'0' + 52,
        b'+' => 62,
        b'/' => 63,
        _ => panic!("bad base64 byte {c}"),
    };
    let bytes: Vec<u8> = s.bytes().filter(|&c| c != b'=').collect();
    let mut out = Vec::with_capacity(bytes.len() * 3 / 4);
    for chunk in bytes.chunks(4) {
        let n = chunk
            .iter()
            .enumerate()
            .fold(0u32, |n, (i, &c)| n | (u32::from(val(c)) << (18 - 6 * i)));
        out.extend_from_slice(&n.to_be_bytes()[1..chunk.len()]);
    }
    out
}

fn policy_json(p: &ManagedModelPolicy) -> Value {
    json!({"deniedModels": p.denied_models, "availableModelsMatch": p.available_models_match})
}

#[test]
fn managed_source_matches_the_sdk() {
    let cases = fixture();
    assert!(cases.len() >= 100, "fixture lost cases");
    // A seeded remote-settings.json is ignored by the SDK host (A05c); the
    // Rust resolver has no remote tier, so these cases pin that it shouldn't.
    let remote = cases.iter().filter(|c| c.get("remote").is_some()).count();
    assert!(remote >= 5, "fixture lost the remote-cache cases");
    let wsl = cases.iter().filter(|c| c["wsl"] == true).count();
    assert!(wsl >= 40, "fixture lost the WSL cases");
    // Any name works for staging; it only has to match what the reader gets.
    let user = managed_settings::current_username().unwrap_or_else(|| "user".into());
    #[cfg(unix)]
    let root = unsafe { libc::geteuid() } == 0;
    #[cfg(not(unix))]
    let root = false;
    let mut failures = Vec::new();
    let mut ran = 0;
    for case in &cases {
        let name = case["name"].as_str().unwrap();
        let has_plists = case.get("plists").is_some();
        // Root can read a chmod 000 plist, unlike the recording user.
        let chmods = case["plists"]
            .as_object()
            .is_some_and(|p| p.values().any(|v| v.get("mode").is_some()));
        if (!cfg!(unix) && case.get("symlinks").is_some())
            || (has_plists && !cfg!(target_os = "macos"))
            || (chmods && root)
        {
            continue;
        }
        let tmp = stage(case, &user);
        let managed_dir = tmp.path().join("managed");
        // WSL cases: the recorder ran the SDK as if under WSL, with `Jn`
        // (the Windows managed folder under `/mnt/c`) at `<tmp>/win`.
        let win = tmp.path().join("win");
        let windows_dir = (case["wsl"] == true).then_some(win.as_path());
        let os = match case.get("registry") {
            Some(reg) => managed_settings::registry_policy(
                &reg_read(&reg["hklm"]),
                &reg_read(&reg["hkcu"]),
                &managed_dir,
                windows_dir,
            ),
            None => OsPolicy::plist(managed_settings::read_mdm_tier(
                &tmp.path().join("mdm"),
                Some(&user),
            )),
        };
        let file = managed_settings::file_tier(&os, &managed_dir, windows_dir);
        let resolved = managed_settings::resolve(&os, &file);
        unstage(&tmp, &user);
        ran += 1;
        let got = resolved
            .as_ref()
            .map(|m| m.settings.clone())
            .filter(|s| !s.is_empty());
        let got_json = got.clone().map_or(Value::Null, Value::Object);
        // The SDK reports an origin whenever the managed source has any key;
        // the projection can be empty then, so compare it only alongside keys.
        let got_origin = match (&got, &resolved) {
            (Some(_), Some(m)) => json!(m.origin),
            _ => Value::Null,
        };
        let want_origin = if case["managed"].is_null() {
            Value::Null
        } else {
            case["origin"].clone()
        };
        let checks = [
            ("managed", got_json, &case["managed"]),
            ("origin", got_origin, &want_origin),
            (
                "policy",
                policy_json(&managed_settings::model_policy_from(got.as_ref())),
                &case["policy"],
            ),
            (
                "pricing",
                managed_settings::model_pricing_from(got.as_ref()).unwrap_or(Value::Null),
                &case["pricing"],
            ),
        ];
        for (what, got, want) in checks {
            if js::stringify(&got) != js::stringify(want) {
                failures.push(format!(
                    "{name} {what}:\n    got  {}\n    want {}",
                    js::stringify(&got),
                    js::stringify(want)
                ));
            }
        }
    }
    assert!(failures.is_empty(), "{}", failures.join("\n"));
    let expected = if cfg!(target_os = "macos") {
        cases.len() - usize::from(root)
    } else {
        100
    };
    assert!(ran >= expected, "ran {ran} of {} cases", cases.len());
}

/// The SDK queried both hives with exactly `reg_query_args`.
#[test]
fn reg_query_argv_matches_the_sdk() {
    let want = json!([
        managed_settings::reg_query_args(managed_settings::HKCU_POLICY_KEY),
        managed_settings::reg_query_args(managed_settings::HKLM_POLICY_KEY),
    ]);
    assert_eq!(fixture_reg_calls(), want);
}
