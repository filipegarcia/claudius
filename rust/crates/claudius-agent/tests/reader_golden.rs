//! Replays `fixtures/reader_golden.json` (recorded by
//! `rust/scripts/reader-golden.mjs` from the real TS SDK) against
//! [`Query::spawn_prompt`]. Each case is one scripted single-user turn. The
//! messages yielded, the error the stream ends with, and
//! `supported_commands()` once it's over must all match. That covers the
//! reader's `sdk_host_only` drop, the error-result swap for exit errors,
//! `commands_changed`, and the transport's decoding, line splitting, stderr
//! tail and signal names.

#[path = "support/test_bins.rs"]
mod test_bins;

use std::path::PathBuf;
use std::time::Duration;

use claudius_agent::{Options, Query, js};
use serde_json::{Value, json};

fn fixture() -> Value {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/reader_golden.json");
    serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap()
}

/// The recorder's `describe(msg)`.
fn describe(m: &Value) -> String {
    let Value::Object(o) = m else {
        return format!("value:{}", js::stringify(m));
    };
    let ty = js::to_string(o.get("type"));
    let kind = match o.get("subtype").filter(|s| js::truthy(s)) {
        Some(st) => format!("{ty}/{}", js::to_string(Some(st))),
        None => ty,
    };
    match o.get("subtype").and_then(Value::as_str) {
        Some("session_state_changed") => format!("{kind}:{}", js::to_string(o.get("state"))),
        Some("status") => format!(
            "{kind}:{}",
            o.get("status").map_or("undefined".into(), js::stringify)
        ),
        _ => kind,
    }
}

/// What the recorder captures for one case, from the Rust side.
async fn replay(case: Value) -> (String, Vec<String>) {
    let name = case["name"].as_str().unwrap().to_owned();
    let tmp = tempfile::tempdir().unwrap();
    let opts = Options {
        path_to_claude_code_executable: Some(test_bins::private_copy(env!(
            "CARGO_BIN_EXE_claudius-fake-claude"
        ))),
        cwd: Some(tmp.path().to_path_buf()),
        env: Some(
            [
                ("PATH", "/usr/bin:/bin".to_owned()),
                ("HOME", tmp.path().display().to_string()),
                ("FAKE_CLAUDE_SCRIPT", case["script"].to_string()),
            ]
            .into_iter()
            .map(|(k, v)| (k.to_owned(), v))
            .collect(),
        ),
        ..Default::default()
    };
    let mut q = Query::spawn_prompt("go", opts).await.unwrap();
    let mut yielded = Vec::new();
    let mut error = Value::Null;
    loop {
        match tokio::time::timeout(Duration::from_secs(20), q.next())
            .await
            .unwrap_or_else(|_| panic!("{name}: the stream never ended"))
        {
            None => break,
            Some(Ok(m)) => yielded.push(describe(&m)),
            Some(Err(e)) => {
                error = json!(e.to_string());
                // The stream ends with its error.
                assert!(q.next().await.is_none(), "{name}: more after the error");
                break;
            }
        }
    }
    let commands = q.handle().supported_commands().await.unwrap();
    let mut failures = Vec::new();
    let mut check = |what: &str, want: &Value, got: Value| {
        if js::stringify(want) != js::stringify(&got) {
            failures.push(format!(
                "{name}: {what}\n  sdk:  {}\n  rust: {}",
                js::stringify(want),
                js::stringify(&got)
            ));
        }
    };
    check("yielded", &case["yielded"], json!(yielded));
    check("error", &case["error"], error);
    check("supportedCommands()", &case["commands"], commands);
    (name, failures)
}

#[tokio::test(flavor = "multi_thread")]
async fn reader_matches_the_sdk() {
    let fx = fixture();
    let cases: Vec<Value> = fx["cases"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|c| c["os"].as_str().is_none_or(|os| os == std::env::consts::OS))
        .cloned()
        .collect();
    assert!(cases.len() >= 40, "fixture has only {} cases", cases.len());
    let runs = cases
        .into_iter()
        .map(|c| tokio::spawn(replay(c)))
        .collect::<Vec<_>>();
    let mut failures = Vec::new();
    for run in runs {
        failures.extend(run.await.unwrap().1);
    }
    assert!(failures.is_empty(), "{}", failures.join("\n"));
}

/// The recorder runs on macOS; the cases tagged `"os": "macos"` hold there.
#[test]
fn fixture_os_tags_use_rust_names() {
    for c in fixture()["cases"].as_array().unwrap() {
        if let Some(os) = c["os"].as_str() {
            assert_eq!(os, "macos", "{}: os tag {os}", c["name"]);
        }
    }
}

#[cfg(unix)]
#[test]
fn signal_names_follow_node() {
    use claudius_agent::{AgentError, signal_name};
    assert_eq!(signal_name(libc::SIGTERM), Some("SIGTERM"));
    assert_eq!(signal_name(libc::SIGKILL), Some("SIGKILL"));
    assert_eq!(signal_name(libc::SIGSYS), Some("SIGSYS"));
    assert_eq!(signal_name(libc::SIGIO), Some("SIGIO"));
    assert_eq!(signal_name(0), None);
    assert_eq!(signal_name(64), None);
    #[cfg(target_os = "macos")]
    {
        assert_eq!(signal_name(libc::SIGINFO), Some("SIGINFO"));
        assert_eq!(signal_name(libc::SIGEMT), None);
    }
    #[cfg(target_os = "linux")]
    {
        assert_eq!(signal_name(libc::SIGPWR), Some("SIGPWR"));
        assert_eq!(signal_name(libc::SIGSTKFLT), Some("SIGSTKFLT"));
        assert_eq!(signal_name(libc::SIGRTMIN()), None);
    }
    let e = AgentError::ProcessKilled {
        signal: libc::SIGHUP,
        stderr: String::new(),
    };
    assert_eq!(
        e.to_string(),
        "Claude Code process terminated by signal SIGHUP"
    );
}
