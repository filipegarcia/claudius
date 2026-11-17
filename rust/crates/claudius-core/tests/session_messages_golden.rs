//! Replays `rust/scripts/session-messages-golden.mjs`: the SDK 0.3.312
//! changes to its session readers, recorded from the real SDK.
//!
//! - `getSessionMessages` over each recorded transcript, with and without
//!   system messages, against [`transcript::session_messages`], compared as
//!   `JSON.stringify` text: a task-notification `origin` keeps `taskKind`
//!   only as `"mcp-task"`, and the "session ended" interrupt text is a reply.
//! - The SDK's macOS git-stub check (`PD`, run on a fake fs) against
//!   [`git_stub::is_git_stub_with`].
//! - `getSessionMessages` over transcript files as written (I14b), against
//!   [`sessions_store::messages`]: the lookup, [`transcript::read_file`]
//!   (the whole file, decoded lossily) and the pipeline.

use std::collections::HashMap;

use claudius_agent::js;
use claudius_core::git_stub::{self, Probe, StubFs};
use claudius_core::{paths, sessions_store, transcript};
use serde_json::Value;

fn fixture() -> Value {
    let path = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/tests/fixtures/session_messages_golden.json"
    );
    serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap()
}

#[test]
fn messages_match_the_sdk() {
    let fx = fixture();
    let cases = fx["cases"].as_array().unwrap();
    assert!(cases.len() >= 13, "{} cases", cases.len());
    let mut diffs = Vec::new();
    for case in cases {
        let name = case["name"].as_str().unwrap();
        let text = case["transcript"].as_str().unwrap();
        for (field, include_system) in [("withoutSystem", false), ("withSystem", true)] {
            let got = js::stringify(&Value::Array(transcript::session_messages(
                text,
                include_system,
            )));
            let want = case[field].as_str().unwrap();
            if got != want {
                diffs.push(format!("{name} {field}:\n  SDK:  {want}\n  Rust: {got}"));
            }
        }
    }
    assert!(diffs.is_empty(), "{}", diffs.join("\n"));
}

/// A probe's staged fs: `exists`, `stat` / `lstat` states and `apps`.
struct FakeFs<'a>(&'a Value);

fn state(v: &Value, path: &str) -> Probe {
    match v.get(path).and_then(Value::as_str) {
        Some("present") => Probe::Present,
        Some("error") => Probe::Error,
        _ => Probe::Missing,
    }
}

impl StubFs for FakeFs<'_> {
    fn exists(&self, path: &str) -> bool {
        self.0["exists"]
            .as_array()
            .unwrap()
            .iter()
            .any(|p| p.as_str() == Some(path))
    }
    fn stat(&self, path: &str) -> Probe {
        state(&self.0["stat"], path)
    }
    fn lstat(&self, path: &str) -> Probe {
        state(&self.0["lstat"], path)
    }
    fn read_dir(&self, path: &str) -> Option<Vec<String>> {
        match &self.0["apps"] {
            Value::Array(names) if path == "/Applications" => Some(
                names
                    .iter()
                    .map(|n| n.as_str().unwrap().to_owned())
                    .collect(),
            ),
            _ => None,
        }
    }
}

#[test]
fn git_stub_matches_the_sdk() {
    let fx = fixture();
    let probes = fx["gitStub"].as_array().unwrap();
    assert!(probes.len() >= 30, "{} probes", probes.len());
    let mut seen: HashMap<bool, usize> = HashMap::new();
    for p in probes {
        let name = p["name"].as_str().unwrap();
        let env = |k: &str| p["env"].get(k).and_then(Value::as_str);
        let got = git_stub::is_git_stub_with(
            p["platform"] == "darwin",
            env("PATH"),
            env("DEVELOPER_DIR"),
            &FakeFs(p),
        );
        assert_eq!(got, p["stub"].as_bool().unwrap(), "{name}");
        *seen.entry(got).or_default() += 1;
    }
    // Both verdicts are exercised.
    assert!(seen.len() == 2, "{seen:?}");
}

fn unhex(hex: &str) -> Vec<u8> {
    (0..hex.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&hex[i..i + 2], 16).unwrap())
        .collect()
}

/// `getSessionMessages(id, {includeSystemMessages})` over each recorded
/// transcript file, written as recorded under `<config>/projects/`: the SDK
/// reads the whole file and decodes each `\n`-split line lossily (invalid
/// UTF-8 is U+FFFD, a bad byte between tokens drops its line), skips bytes
/// up to 0x20 before a record, and answers `[]` for an empty file, a
/// directory, an unreadable file or a dangling link, never a throw.
#[cfg(unix)]
#[test]
fn file_reads_match_the_sdk() {
    use std::os::unix::fs::PermissionsExt;
    let fx = fixture();
    let files = fx["files"].as_array().unwrap();
    assert!(files.len() >= 15, "{} files", files.len());
    let root = tempfile::tempdir().unwrap();
    assert!(paths::set_config_dir_override(root.path().join("config")));
    let dir = root.path().join("config/projects/golden-files");
    std::fs::create_dir_all(&dir).unwrap();
    // SAFETY: geteuid has no preconditions.
    let as_root = unsafe { libc::geteuid() } == 0;
    let (mut diffs, mut empty) = (Vec::new(), 0);
    for f in files {
        let name = f["name"].as_str().unwrap();
        let id = f["sessionId"].as_str().unwrap();
        let path = dir.join(format!("{id}.jsonl"));
        if let Some(hex) = f["hex"].as_str() {
            std::fs::write(&path, unhex(hex)).unwrap();
        } else if f["dir"] == true {
            std::fs::create_dir(&path).unwrap();
            std::fs::write(path.join("inside"), "x").unwrap();
        } else {
            let link = f["symlink"].as_str().unwrap();
            if let Some(hex) = f["targetHex"].as_str() {
                std::fs::write(dir.join(link), unhex(hex)).unwrap();
            }
            std::os::unix::fs::symlink(link, &path).unwrap();
        }
        if let Some(mode) = f["mode"].as_u64() {
            if as_root {
                continue; // root reads a mode-0 file
            }
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(mode as u32)).unwrap();
        }
        for (field, include_system) in [("withoutSystem", false), ("withSystem", true)] {
            let got = js::stringify(&Value::Array(sessions_store::messages(
                id,
                None,
                include_system,
            )));
            let want = f[field].as_str().unwrap();
            empty += usize::from(want == "[]");
            if got != want {
                diffs.push(format!("{name} {field}:\n  SDK:  {want}\n  Rust: {got}"));
            }
        }
    }
    assert!(diffs.is_empty(), "{}", diffs.join("\n"));
    // Both outcomes are exercised: messages, and the failures read as none.
    assert!(empty >= 8, "{empty}");
}
