//! Replays `fixtures/close_timing_golden.json` (recorded by
//! `rust/scripts/close-timing-golden.mjs` from the real TS SDK) against
//! [`Query`]: how a query ends its CLI once the host is done with it (R13).
//!
//! Each case is a host path and a fake-CLI behaviour. Paths: `close` and
//! `abort` (the SDK's `Query.close()` and `abortController.abort()`, both
//! [`QueryHandle::close`] here), `return` (breaking out of `for await`,
//! [`QueryHandle::finish`]) and `throw` (a malformed `initialize` reply makes
//! the reader throw). Behaviours: the CLI exits at EOF (`eof`), dies by
//! SIGTERM (`term`), ignores both (`stubborn`), or exits 3.5 s after SIGTERM
//! (`term_late`). The fake logs when it saw EOF and SIGTERM; the exit comes
//! from [`QueryHandle::wait_exit`]. Times are bucketed like the recorder's,
//! from the call (the throw: from the CLI's EOF), and compared with the
//! order of events, the call's return (`resolved`) and the stream's end.
//! The fixture's `kills` (every `kill()` the SDK and Node made) aren't
//! observable from the CLI and aren't compared: the SDK's abort SIGTERMs
//! twice in one tick (a listed difference), and its SIGKILL timer calls
//! `kill()` on a CLI already dead by SIGTERM, which sends nothing.
#![cfg(unix)]

use std::path::PathBuf;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use claudius_agent::{ExitInfo, Options, Query, signal_name};
use serde_json::{Map, Value, json};

/// Where Rust differs from the SDK on purpose: `close()` is the abort here
/// (it's what a session's `end()` does), so after it the stream ends with
/// the abort's error, where the SDK's `Query.close()` ends it with none.
/// The time matches. The test fails once a case stops differing.
const CLOSE_STREAM_ERROR_GAP: &str = "close";

fn fixture() -> Value {
    let path =
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/close_timing_golden.json");
    serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap()
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_millis() as i64
}

/// The recorder's bucket label, or `off:<ms>` for a time between buckets.
fn bucket(buckets: &[Value], ms: i64) -> Value {
    for b in buckets {
        let (from, to) = (b[1].as_i64().unwrap(), b[2].as_i64().unwrap());
        if ms >= from && ms < to {
            return b[0].clone();
        }
    }
    json!(format!("off:{ms}"))
}

/// What the recorder captures for one case, from the Rust side (no `kills`).
async fn replay(case: Value, buckets: Vec<Value>) -> Value {
    let name = format!("{}/{}", case["path"], case["behavior"]);
    let path = case["path"].as_str().unwrap().to_owned();
    let tmp = tempfile::tempdir().unwrap();
    let times = tmp.path().join("times.log");
    let opts = Options {
        path_to_claude_code_executable: Some(PathBuf::from(env!(
            "CARGO_BIN_EXE_claudius-fake-claude"
        ))),
        cwd: Some(tmp.path().to_path_buf()),
        env: Some(
            [
                ("PATH".to_owned(), "/usr/bin:/bin".to_owned()),
                ("HOME".to_owned(), tmp.path().display().to_string()),
                ("FAKE_CLAUDE_TIMES".to_owned(), times.display().to_string()),
                ("FAKE_CLAUDE_SCRIPT".to_owned(), case["script"].to_string()),
            ]
            .into_iter()
            .collect(),
        ),
        ..Default::default()
    };
    let mut q = Query::spawn(opts)
        .await
        .unwrap_or_else(|e| panic!("{name}: spawn: {e}"));
    let h = q.handle();
    let exited = {
        let h = h.clone();
        tokio::spawn(async move {
            let info = h.wait_exit().await;
            (info, now_ms())
        })
    };
    let limit = Duration::from_secs(20);
    let mut t0 = None;
    let mut resolved = None;
    let mut stream_end = None;
    if path == "throw" {
        // system/init, then the throw.
        loop {
            match tokio::time::timeout(limit, q.next()).await {
                Ok(Some(Ok(_))) => {}
                Ok(Some(Err(e))) => {
                    stream_end = Some((json!(e.to_string()), now_ms()));
                    break;
                }
                Ok(None) => panic!("{name}: the stream ended without an error"),
                Err(_) => panic!("{name}: no error in {limit:?}"),
            }
        }
    } else {
        // system/init, then "ready".
        loop {
            match tokio::time::timeout(limit, q.next()).await {
                Ok(Some(Ok(m))) if m["type"] == "assistant" => break,
                Ok(Some(Ok(_))) => {}
                other => panic!("{name}: before \"ready\": {other:?}"),
            }
        }
        let start = now_ms();
        t0 = Some(start);
        match path.as_str() {
            "close" | "abort" => h.close().await,
            "return" => h.finish().await,
            p => panic!("unknown path {p}"),
        }
        resolved = Some(now_ms() - start);
        if path != "return" {
            stream_end = Some(match tokio::time::timeout(limit, q.next()).await {
                Ok(Some(Ok(m))) => panic!("{name}: a message after the call: {m}"),
                Ok(Some(Err(e))) => (json!(e.to_string()), now_ms()),
                Ok(None) => (Value::Null, now_ms()),
                Err(_) => panic!("{name}: the stream didn't end in {limit:?}"),
            });
        }
    }
    let (info, exit_ms) = tokio::time::timeout(limit, exited)
        .await
        .unwrap_or_else(|_| panic!("{name}: the CLI didn't exit in {limit:?}"))
        .unwrap();
    let seen: Vec<Value> = std::fs::read_to_string(&times)
        .unwrap_or_default()
        .lines()
        .filter(|l| !l.is_empty())
        .map(|l| serde_json::from_str(l).unwrap())
        .collect();
    let first = |event: &str| {
        seen.iter()
            .find(|e| e["event"] == event)
            .and_then(|e| e["ms"].as_i64())
    };
    let eof = first("eof").unwrap_or_else(|| panic!("{name}: the CLI never saw EOF"));
    let at = [
        ("eof", Some(eof)),
        ("sigterm", first("SIGTERM")),
        ("exit", Some(exit_ms)),
    ];
    let t0 = t0.unwrap_or(eof);
    let mut order: Vec<_> = at
        .iter()
        .filter_map(|(k, ms)| ms.map(|ms| (ms, *k)))
        .collect();
    order.sort_by_key(|(ms, _)| *ms);
    let when = |ms: Option<i64>| ms.map_or(Value::Null, |ms| bucket(&buckets, ms - t0));
    let mut exit = Map::new();
    match info {
        ExitInfo::Code(c) => exit.insert("code".into(), json!(c)),
        ExitInfo::Signal(s) => exit.insert("signal".into(), json!(signal_name(s))),
        ExitInfo::Unknown => exit.insert("unknown".into(), json!(true)),
    };
    exit.insert("at".into(), when(Some(exit_ms)));
    let mut out = json!({
        "eof": when(Some(eof)),
        "sigterm": when(first("SIGTERM")),
        "exit": exit,
        "order": order.iter().map(|(_, k)| *k).collect::<Vec<_>>(),
    });
    if let Some(r) = resolved {
        out["resolved"] = bucket(&buckets, r);
    }
    if let Some((error, ms)) = stream_end {
        out["streamEnd"] = json!({"error": error, "at": bucket(&buckets, ms - t0)});
    }
    out
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn close_timing_matches_the_sdk() {
    let f = fixture();
    assert_eq!(
        f["sdkVersion"],
        claudius_agent::SDK_VERSION,
        "re-record with rust/scripts/close-timing-golden.mjs"
    );
    let buckets = f["buckets"].as_array().unwrap().clone();
    let cases = f["cases"].as_array().unwrap().clone();
    assert_eq!(cases.len(), 16, "4 paths x 4 behaviours");
    // At once, like a recorder round: each case mostly sleeps.
    let runs: Vec<_> = cases
        .iter()
        .map(|c| tokio::spawn(replay(c.clone(), buckets.clone())))
        .collect();
    let mut mismatches = Vec::new();
    for (case, run) in cases.iter().zip(runs) {
        let name = format!("{}/{}", case["path"], case["behavior"]);
        let mut got = run.await.unwrap();
        let mut want = case["want"].clone();
        want.as_object_mut().unwrap().remove("kills");
        if case["path"] == CLOSE_STREAM_ERROR_GAP {
            let (w, g) = (&want["streamEnd"]["error"], &got["streamEnd"]["error"]);
            if w == g {
                mismatches.push(format!("{name}: stale gap, the stream's end matches ({g})"));
            }
            assert_eq!(
                *w,
                Value::Null,
                "{name}: the SDK's close() ends the stream cleanly"
            );
            got["streamEnd"]["error"] = w.clone();
        }
        if got != want {
            mismatches.push(format!("{name}:\n  want {want}\n  got  {got}"));
        }
    }
    assert!(mismatches.is_empty(), "{}", mismatches.join("\n"));
}

/// The fixture's own story, so a re-record that changes it is noticed:
/// SIGTERM 2 s after the call, SIGKILL 5 s after that, on every path.
#[test]
fn fixture_pins_the_two_timers() {
    let f = fixture();
    for case in f["cases"].as_array().unwrap() {
        let name = format!("{}/{}", case["path"], case["behavior"]);
        let w = &case["want"];
        let behavior = case["behavior"].as_str().unwrap();
        let kills: Vec<(&str, bool, &str)> = w["kills"]
            .as_array()
            .unwrap()
            .iter()
            .map(|k| {
                (
                    k["signal"].as_str().unwrap(),
                    k["sent"].as_bool().unwrap(),
                    k["at"].as_str().unwrap(),
                )
            })
            .collect();
        let term = ("SIGTERM", true, "2-3.5s");
        let doubled = case["path"] == "abort";
        let mut expect = match behavior {
            "eof" => vec![],
            "term" => vec![term, ("SIGKILL", false, "7-9s")],
            "stubborn" => vec![term, ("SIGKILL", true, "7-9s")],
            "term_late" => vec![term],
            b => panic!("unknown behaviour {b}"),
        };
        if doubled && !expect.is_empty() {
            expect.insert(1, term);
        }
        assert_eq!(kills, expect, "{name}");
    }
}

/// `oneshot` leaves like a TS one-shot's `return` out of `for await`: once
/// the CLI exited, or 2 s after the close when it ignores its EOF (it dies
/// at the SIGTERM then).
#[tokio::test]
async fn oneshot_waits_for_the_exit_like_return() {
    let tmp = tempfile::tempdir().unwrap();
    let script = json!({"on_eof": [{"$delay_ms": 60000}], "on_sigterm": "die"});
    let opts = Options {
        path_to_claude_code_executable: Some(PathBuf::from(env!(
            "CARGO_BIN_EXE_claudius-fake-claude"
        ))),
        cwd: Some(tmp.path().to_path_buf()),
        env: Some(
            [
                ("PATH".to_owned(), "/usr/bin:/bin".to_owned()),
                ("HOME".to_owned(), tmp.path().display().to_string()),
                ("FAKE_CLAUDE_SCRIPT".to_owned(), script.to_string()),
            ]
            .into_iter()
            .collect(),
        ),
        ..Default::default()
    };
    let started = std::time::Instant::now();
    let result = claudius_agent::oneshot("hi", opts).await.unwrap().unwrap();
    let took = started.elapsed();
    assert_eq!(result["result"], "echo:hi");
    assert!(
        took >= Duration::from_millis(1800) && took < Duration::from_millis(3500),
        "oneshot took {took:?}"
    );
}
