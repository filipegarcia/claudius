//! Ties the port to one SDK version. `rust/scripts/sdk-diff.sh` compares the
//! installed SDK with `rust/scripts/sdk-snapshot.json`; this keeps that
//! snapshot, `claudius_agent::SDK_VERSION` and every SDK-recorded fixture on
//! the same version. It also makes every env rule in the snapshot a decision:
//! either mirrored by `Options::to_env` / `Query`, or listed in
//! [`NOT_MIRRORED`] with the reason. A rule that `--update` adds after an SDK
//! bump fails here until it's classified.

use std::path::{Path, PathBuf};

use serde_json::Value;

/// Env variables the SDK's `query()` / `ProcessTransport` touch that the Rust
/// host mirrors (`Options::to_env`, `Query::spawn`).
const MIRRORED: &[&str] = &[
    "CLAUDE_AGENT_SDK_DISABLE_MCP_MANIFESTS",
    "CLAUDE_AGENT_SDK_VERSION",
    "CLAUDE_CODE_AGENT_PROGRESS_SUMMARIES",
    "CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING",
    "CLAUDE_CODE_ENTRYPOINT",
    "CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS",
    "CLAUDE_CODE_QUESTION_EXTENDED",
    "CLAUDE_CODE_QUESTION_OPTIONAL_DESCRIPTIONS",
    "CLAUDE_CODE_QUESTION_PREVIEW_FORMAT",
    "CLAUDE_CODE_SDK_READS_SESSION_STATE",
    "DEBUG",
    "DEBUG_CLAUDE_AGENT_SDK",
    "NODE_OPTIONS",
];

/// Env variables the SDK touches that the Rust host doesn't, and why.
const NOT_MIRRORED: &[(&str, &str)] = &[
    (
        "CLAUDE_CODE_SDK_HAS_OAUTH_REFRESH",
        "set only with the undeclared `getOAuthToken` callback, which Claudius doesn't pass",
    ),
    (
        "CLAUDE_CODE_SDK_HAS_HOST_AUTH_REFRESH",
        "set only with the undeclared `getHostAuthToken` callback, which Claudius doesn't pass",
    ),
    (
        "CLAUDE_CONFIG_DIR",
        "set from `query()`'s internal `resumeConfigDir` parameter, not from an option",
    ),
    (
        "CLAUDE_CODE_SDK_READS_STARTUP_MARKS",
        "set only under `query()`'s internal `readsStartupMarks` parameter, which only \
         `startup()` / `prewarm()` pass (`startupMarkReached()` then decorates their \
         initialize-timeout error). A plain `query()`, Claudius's only entry point, leaves \
         it unset, as the 0.3.312 golden wire fixtures show",
    ),
    (
        "CLAUDE_SECURESTORAGE_CONFIG_DIR",
        "set beside `CLAUDE_CONFIG_DIR` from `resumeConfigDir`, on Windows only",
    ),
    (
        "TRACEPARENT",
        "OpenTelemetry context propagation; a no-op without a registered tracer, and the Rust host has none",
    ),
    (
        "TRACESTATE",
        "OpenTelemetry context propagation, as `TRACEPARENT`",
    ),
];

fn rust_dir() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../..")
}

fn snapshot() -> Value {
    let raw = std::fs::read_to_string(rust_dir().join("scripts/sdk-snapshot.json")).unwrap();
    serde_json::from_str(&raw).unwrap()
}

#[test]
fn snapshot_is_on_sdk_version() {
    assert_eq!(
        snapshot()["sdkVersion"],
        claudius_agent::SDK_VERSION,
        "rust/scripts/sdk-snapshot.json is from another SDK; run rust/scripts/sdk-diff.sh"
    );
}

/// Fixtures still recorded on an older SDK, with the task that owns the
/// re-record. Their recorders read the current `lib/` as well as the SDK, so
/// re-recording them on this SDK would bake in TS drift another task is
/// porting. A fixture that is no longer stale fails too, so the list can't
/// rot.
const PENDING_RERECORD: &[(&str, &str)] = &[];

/// Every fixture recorded from the SDK (a top-level `sdkVersion`) must come
/// from the mirrored version; re-record the stale ones after a bump, or list
/// them in [`PENDING_RERECORD`] with the task that will.
///
/// A fixture `serde_json` can't parse is skipped, not failed, so a lone
/// surrogate escape in test data hides it from this check:
/// `scheduler_golden.json` (`\ud800`) and R04's `session_callbacks_golden.json`
/// are invisible here (both are on 0.3.312).
#[test]
fn recorded_fixtures_are_on_sdk_version() {
    let mut stale = Vec::new();
    let mut seen = 0;
    let crates = rust_dir().join("crates");
    let mut dirs: Vec<PathBuf> = std::fs::read_dir(&crates)
        .unwrap()
        .map(|e| e.unwrap().path().join("tests/fixtures"))
        .filter(|p| p.is_dir())
        .collect();
    while let Some(dir) = dirs.pop() {
        for entry in std::fs::read_dir(&dir).unwrap() {
            let path = entry.unwrap().path();
            if path.is_dir() {
                dirs.push(path);
                continue;
            }
            if path.extension().is_none_or(|e| e != "json") {
                continue;
            }
            let Ok(Value::Object(doc)) =
                serde_json::from_str::<Value>(&std::fs::read_to_string(&path).unwrap())
            else {
                continue;
            };
            if let Some(version) = doc.get("sdkVersion") {
                seen += 1;
                let name = path.file_name().unwrap().to_string_lossy().into_owned();
                if version != claudius_agent::SDK_VERSION {
                    stale.push((name, format!("{} ({version})", path.display())));
                }
            }
        }
    }
    let unexplained: Vec<&str> = stale
        .iter()
        .filter(|(name, _)| !PENDING_RERECORD.iter().any(|(f, _)| f == name))
        .map(|(_, shown)| shown.as_str())
        .collect();
    assert!(
        unexplained.is_empty(),
        "fixtures from another SDK, and not listed in PENDING_RERECORD:\n{}",
        unexplained.join("\n")
    );
    // An entry whose fixture is current (or gone) is stale itself.
    let rotted: Vec<&str> = PENDING_RERECORD
        .iter()
        .filter(|(f, _)| !stale.iter().any(|(name, _)| name == f))
        .map(|(f, _)| *f)
        .collect();
    assert!(
        rotted.is_empty(),
        "PENDING_RERECORD entries whose fixture is no longer stale: {rotted:?}"
    );
    assert!(seen >= 7, "found only {seen} recorded fixtures");
}

#[test]
fn every_snapshot_env_rule_is_classified() {
    let snap = snapshot();
    let mut names: Vec<&str> = snap["env"]
        .as_object()
        .unwrap()
        .values()
        .flat_map(|rules| rules.as_object().unwrap().keys().map(String::as_str))
        .collect();
    names.sort_unstable();
    names.dedup();
    let unclassified: Vec<&str> = names
        .iter()
        .copied()
        .filter(|n| !MIRRORED.contains(n) && !NOT_MIRRORED.iter().any(|(k, _)| k == n))
        .collect();
    assert!(
        unclassified.is_empty(),
        "env rules neither mirrored nor explained: {unclassified:?}"
    );
    // Entries for variables the SDK no longer touches are stale.
    let stale: Vec<&str> = MIRRORED
        .iter()
        .copied()
        .chain(NOT_MIRRORED.iter().map(|(k, _)| *k))
        .filter(|k| !names.contains(k))
        .collect();
    assert!(
        stale.is_empty(),
        "classified but not in the snapshot: {stale:?}"
    );
}
