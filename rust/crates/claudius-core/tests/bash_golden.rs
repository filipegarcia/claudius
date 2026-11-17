//! Replays the `scenarios` of `fixtures/bash_golden.json` (recorded by
//! `rust/scripts/bash-golden.mjs` from the TS `BashSession`) against
//! [`BashSession`]: the same steps on one shell each, with the same env, and
//! every command must settle the same way (`$TMP` for the cwd, outputs over
//! 1000 UTF-16 units summarized as {len, head, tail}). A `gone` step polls
//! the pids its command printed, which is how the SIGKILL escalation shows
//! (CC 2.1.300): a background job that ignores SIGTERM is gone anyway, and
//! the pids are rewritten to `<pid>` because they aren't deterministic. The
//! route half of the fixture is replayed by `claudius-server/tests/bash.rs`.
#![cfg(unix)]

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use claudius_core::bash_mode::{BashExecResult, BashSession};
use serde_json::{Value, json};
use tokio::task::JoinHandle;

fn fixture() -> Value {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/bash_golden.json");
    serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap()
}

/// Where Rust answers differently on purpose: (scenario, label, nth result
/// with that label) → what Rust records. TS never answers a command still
/// queued at `dispose()`; Rust answers it like a call after the dispose.
fn deviation(scenario: &str, label: &str) -> Option<Value> {
    (scenario == "dispose" && label == "b").then(|| {
        json!({"stdout": "", "stderr": "BashSession destroyed", "exitCode": -1, "truncated": false, "timedOut": false})
    })
}

/// The recorder's `summarize`: JS lengths and slices are UTF-16 units.
fn summarize(s: String) -> Value {
    let units: Vec<u16> = s.encode_utf16().collect();
    if units.len() <= 1000 {
        return json!(s);
    }
    json!({
        "len": units.len(),
        "head": String::from_utf16_lossy(&units[..20]),
        "tail": String::from_utf16_lossy(&units[units.len() - 20..]),
    })
}

fn record(r: BashExecResult, base: &str) -> Value {
    let norm = |s: String| summarize(s.replace(base, "$TMP"));
    json!({
        "stdout": norm(r.stdout),
        "stderr": norm(r.stderr),
        "exitCode": r.exit_code,
        "truncated": r.truncated,
        "timedOut": r.timed_out,
    })
}

fn timeout_of(step: &Value, i: usize) -> Duration {
    step[i].as_u64().map_or(
        claudius_core::bash_mode::DEFAULT_TIMEOUT,
        Duration::from_millis,
    )
}

/// The recorder's `gone` step: read the pids `from`'s stdout printed, blank
/// them out of that recorded result, then poll until none is alive or the
/// time is up.
async fn gone(results: &mut [Value], from: &str, within: Duration) -> Value {
    let src = results
        .iter_mut()
        .find(|r| r["label"] == from)
        .expect("a result to read pids from");
    let stdout = src["result"]["stdout"].as_str().expect("text").to_owned();
    let pids: Vec<u32> = stdout
        .split_whitespace()
        .map(|p| p.parse().expect("a pid"))
        .collect();
    assert!(!pids.is_empty(), "no pids in {stdout:?}");
    // One `<pid>` per run of digits, as the recorder's `/\d+/g`.
    let mut blanked = String::new();
    let mut digits = false;
    for c in stdout.chars() {
        if c.is_ascii_digit() {
            if !digits {
                blanked.push_str("<pid>");
            }
        } else {
            blanked.push(c);
        }
        digits = c.is_ascii_digit();
    }
    src["result"]["stdout"] = json!(blanked);
    let deadline = std::time::Instant::now() + within;
    while pids.iter().any(|&p| alive(p)) && std::time::Instant::now() < deadline {
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    json!({"gone": !pids.iter().any(|&p| alive(p)), "pids": pids.len()})
}

async fn replay(sc: Value) -> (String, Vec<Value>) {
    let name = sc["name"].as_str().unwrap().to_owned();
    let tmp = tempfile::tempdir().unwrap();
    let base = tmp.path().canonicalize().unwrap();
    let base_s = base.display().to_string();
    let cwd = if sc["cwd"] == "missing" {
        base.join("missing")
    } else {
        base.clone()
    };
    let bash = Arc::new(BashSession::with_env(
        &cwd.display().to_string(),
        vec![
            ("PATH".into(), "/usr/bin:/bin".into()),
            ("HOME".into(), base_s.clone()),
        ],
    ));
    let mut started: HashMap<String, JoinHandle<BashExecResult>> = HashMap::new();
    let mut results = Vec::new();
    for step in sc["steps"].as_array().unwrap() {
        let op = step[0].as_str().unwrap();
        let label = step[1].as_str().map(str::to_owned);
        match op {
            "start" => {
                let fut = bash.exec(step[2].as_str().unwrap(), timeout_of(step, 3));
                started.insert(label.unwrap(), tokio::spawn(fut));
            }
            "await" => {
                let label = label.unwrap();
                let within = Duration::from_millis(step[2].as_u64().unwrap());
                let handle = started.get_mut(&label).unwrap();
                let got = match tokio::time::timeout(within, handle).await {
                    Ok(r) => record(r.unwrap(), &base_s),
                    Err(_) => json!("pending"),
                };
                results.push(json!({"label": label, "result": got}));
            }
            "exec" => {
                let r = bash
                    .exec(step[2].as_str().unwrap(), timeout_of(step, 3))
                    .await;
                results.push(json!({"label": label.unwrap(), "result": record(r, &base_s)}));
            }
            "sleep" => tokio::time::sleep(Duration::from_millis(step[1].as_u64().unwrap())).await,
            "dispose" => bash.dispose(),
            "gone" => {
                let from = step[2].as_str().unwrap().to_owned();
                let within = Duration::from_millis(step[3].as_u64().unwrap());
                let result = gone(&mut results, &from, within).await;
                results.push(json!({"label": label.unwrap(), "result": result}));
            }
            _ => panic!("{name}: unknown step {op}"),
        }
    }
    bash.dispose();
    (name, results)
}

#[tokio::test(flavor = "multi_thread")]
async fn scenarios_settle_like_the_ts_bash_session() {
    let fx = fixture();
    let scenarios = fx["scenarios"].as_array().unwrap().clone();
    assert!(scenarios.len() >= 10);
    let runs: Vec<_> = scenarios
        .iter()
        .cloned()
        .map(|s| tokio::spawn(replay(s)))
        .collect();
    let mut failures = Vec::new();
    for (run, sc) in runs.into_iter().zip(&scenarios) {
        let (name, got) = run.await.unwrap();
        let want = sc["results"].as_array().unwrap();
        if got.len() != want.len() {
            failures.push(format!(
                "{name}: {} results, want {}",
                got.len(),
                want.len()
            ));
            continue;
        }
        for (g, w) in got.iter().zip(want) {
            let label = w["label"].as_str().unwrap();
            let expected = deviation(&name, label).unwrap_or_else(|| w["result"].clone());
            if g["label"] != w["label"] || g["result"] != expected {
                failures.push(format!(
                    "{name}/{label}\n  ts:   {expected}\n  rust: {}",
                    g["result"]
                ));
            }
        }
    }
    assert!(failures.is_empty(), "{}", failures.join("\n"));
}

fn alive(pid: u32) -> bool {
    std::process::Command::new("kill")
        .args(["-0", &pid.to_string()])
        .stderr(std::process::Stdio::null())
        .status()
        .is_ok_and(|s| s.success())
}

/// A timeout SIGTERMs the shell's whole process group (it leads one, like
/// Node's `detached: true`), so a job it started dies with it; the next
/// command gets a fresh shell.
#[tokio::test(flavor = "multi_thread")]
async fn a_timeout_kills_the_process_group() {
    let tmp = tempfile::tempdir().unwrap();
    let dir = tmp.path().display().to_string();
    let bash = BashSession::with_env(&dir, vec![("PATH".into(), "/usr/bin:/bin".into())]);
    let r = bash
        .exec(
            "sleep 30 & echo $! $$; sleep 30",
            Duration::from_millis(500),
        )
        .await;
    assert!(r.timed_out, "{r:?}");
    let pids: Vec<u32> = r
        .stdout
        .split_whitespace()
        .map(|p| p.parse().unwrap())
        .collect();
    assert_eq!(pids.len(), 2, "{r:?}");
    let deadline = std::time::Instant::now() + Duration::from_secs(5);
    while pids.iter().any(|&p| alive(p)) {
        assert!(std::time::Instant::now() < deadline, "{pids:?} survived");
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    let r = bash.exec("echo $$", Duration::from_secs(5)).await;
    assert_ne!(r.stdout, pids[1].to_string());
    assert_eq!(r.exit_code, 0);
}
