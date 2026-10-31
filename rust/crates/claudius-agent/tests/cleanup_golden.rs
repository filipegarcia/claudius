//! Replays `fixtures/cleanup_golden.json` (recorded by
//! `rust/scripts/cleanup-golden.mjs` from the real TS SDK) against
//! [`Query`]: the same fake-CLI script and the same steps, and every control
//! request, `initialize` and the message stream must settle the same way
//! once the CLI is gone, dying, or the host aborted (`close()`, the SDK's
//! `abortController.abort()`).
//!
//! Steps (see the recorder): `request` starts `background_tasks`, `settle`
//! waits for it, `init` records `initialization_result()`, `drain` reads the
//! stream to its end, `until_result` up to the first `result`, `next` one
//! message, `abort`, `sleep`. An outcome is `{ok}` or `{error: message}`; the
//! stream's end is `{ok: null}` or `{error}`. A case with `exe` runs that
//! shell script as the CLI.
#![cfg(unix)]

use std::collections::HashMap;
use std::future::{Future, poll_fn};
use std::path::PathBuf;
use std::task::Poll;
use std::time::Duration;

use claudius_agent::{AgentError, Options, Query};
use serde_json::{Map, Value, json};
use tokio::task::JoinHandle;

fn fixture() -> Value {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/cleanup_golden.json");
    serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap()
}

fn outcome<T: Into<Value>>(r: Result<T, AgentError>) -> Value {
    match r {
        Ok(v) => json!({"ok": v.into()}),
        Err(e) => json!({"error": e.to_string()}),
    }
}

/// What the recorder captures for one case, from the Rust side.
async fn replay(case: Value, settle: Duration) -> (String, Value) {
    let name = case["name"].as_str().unwrap().to_owned();
    let tmp = tempfile::tempdir().unwrap();
    // A case's own shell-script CLI, or the fake.
    let cli = match case["exe"].as_str() {
        Some(exe) => {
            use std::os::unix::fs::PermissionsExt;
            let cli = tmp.path().join("cli");
            std::fs::write(&cli, exe).unwrap();
            std::fs::set_permissions(&cli, std::fs::Permissions::from_mode(0o755)).unwrap();
            cli
        }
        None => PathBuf::from(env!("CARGO_BIN_EXE_claudius-fake-claude")),
    };
    let opts = Options {
        path_to_claude_code_executable: Some(cli),
        cwd: Some(tmp.path().to_path_buf()),
        env: Some(
            [
                ("PATH".to_owned(), "/usr/bin:/bin".to_owned()),
                ("HOME".to_owned(), tmp.path().display().to_string()),
                ("FAKE_CLAUDE_SCRIPT".to_owned(), case["script"].to_string()),
            ]
            .into_iter()
            .collect(),
        ),
        ..Default::default()
    };
    let mut q = match case["mode"].as_str().unwrap() {
        "single" => Query::spawn_prompt("hi", opts).await,
        _ => Query::spawn(opts).await,
    }
    .unwrap_or_else(|e| panic!("{name}: spawn: {e}"));
    let h = q.handle();
    let mut out = Map::new();
    let mut started: HashMap<String, JoinHandle<Value>> = HashMap::new();
    let mut ended = false;
    for step in case["steps"].as_array().unwrap() {
        let op = step[0].as_str().unwrap();
        let arg = &step[1];
        match op {
            "request" => {
                let h = h.clone();
                let mut req = Box::pin(async move { outcome(h.background_tasks(None).await) });
                // Drive it here up to its wait for the reply, so its write has
                // been issued before the next step, as with the SDK's
                // synchronous `transport.write`; only then hand it to a task.
                // A spawned task alone may run after the next step's write.
                let task = match poll_fn(|cx| Poll::Ready(req.as_mut().poll(cx))).await {
                    Poll::Ready(v) => tokio::spawn(async move { v }),
                    Poll::Pending => tokio::spawn(req),
                };
                started.insert(arg.as_str().unwrap().to_owned(), task);
            }
            "settle" => {
                let label = arg.as_str().unwrap();
                let task = started.remove(label).unwrap();
                let got = match tokio::time::timeout(settle, task).await {
                    Ok(r) => r.unwrap(),
                    Err(_) => json!("pending"),
                };
                out.insert(label.to_owned(), got);
            }
            "init" => {
                let got = match tokio::time::timeout(settle, h.initialization_result()).await {
                    Ok(r) => outcome(r.map(|_| "initialized")),
                    Err(_) => json!("pending"),
                };
                out.insert("init".to_owned(), got);
            }
            "drain" | "until_result" | "next" => {
                while !ended {
                    match tokio::time::timeout(Duration::from_secs(20), q.next())
                        .await
                        .unwrap_or_else(|_| panic!("{name}: the stream never ended"))
                    {
                        None => {
                            ended = true;
                            out.insert("stream".to_owned(), json!({"ok": null}));
                        }
                        Some(Err(e)) => {
                            ended = true;
                            out.insert("stream".to_owned(), json!({"error": e.to_string()}));
                        }
                        Some(Ok(m)) => {
                            if op == "next" || (op == "until_result" && m["type"] == "result") {
                                break;
                            }
                        }
                    }
                }
            }
            "abort" => h.close().await,
            "sleep" => tokio::time::sleep(Duration::from_millis(arg.as_u64().unwrap())).await,
            _ => panic!("{name}: unknown step {op}"),
        }
    }
    h.close().await;
    (name, Value::Object(out))
}

#[tokio::test(flavor = "multi_thread")]
async fn requests_at_and_after_cleanup_settle_like_the_sdk() {
    let fx = fixture();
    let settle = Duration::from_millis(fx["settleMs"].as_u64().unwrap());
    let cases = fx["cases"].as_array().unwrap().clone();
    assert!(cases.len() >= 21, "fixture has only {} cases", cases.len());
    let runs = cases
        .iter()
        .cloned()
        .map(|c| tokio::spawn(replay(c, settle)))
        .collect::<Vec<_>>();
    let mut failures = Vec::new();
    for (run, case) in runs.into_iter().zip(&cases) {
        let (name, got) = run.await.unwrap();
        if got != case["want"] {
            failures.push(format!("{name}\n  sdk:  {}\n  rust: {got}", case["want"]));
        }
    }
    assert!(failures.is_empty(), "{}", failures.join("\n"));
}
