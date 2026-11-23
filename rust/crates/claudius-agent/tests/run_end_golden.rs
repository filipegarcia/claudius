//! Replays `fixtures/run_end_golden.json` (recorded by
//! `rust/scripts/run-end-golden.mjs` from the real TS SDK) against
//! [`Query::spawn_prompt`]: the same fake-CLI script, the same options, and
//! the fake's `$FAKE_CLAUDE_EVENTS` must show stdin closing at the same
//! point among the script's marks. The user line written and the messages
//! yielded must match too. Plus the SDK's ceiling-env parser, value by value,
//! and [`oneshot`].

#[path = "support/test_bins.rs"]
mod test_bins;

use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use claudius_agent::{
    CanUseTool, ElicitationRequest, HookMatcher, McpServerConfig, OnElicitation, Options,
    PermissionResult, Query, ToolDef, ToolOutput, ToolPermissionContext, ToolServer, hook_fn, js,
    oneshot, run_end_ceiling_ms,
};
use indexmap::IndexMap;
use serde_json::{Value, json};

fn fixture() -> Value {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/run_end_golden.json");
    serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap()
}

fn fake_bin() -> PathBuf {
    test_bins::private_copy(env!("CARGO_BIN_EXE_claudius-fake-claude"))
}

struct Allow;

#[async_trait]
impl CanUseTool for Allow {
    async fn can_use_tool(
        &self,
        _tool: &str,
        input: Value,
        _ctx: ToolPermissionContext,
    ) -> Option<PermissionResult> {
        Some(PermissionResult::allow(input))
    }
}

struct Decline;

#[async_trait]
impl OnElicitation for Decline {
    async fn on_elicitation(&self, _req: ElicitationRequest) -> Option<Value> {
        Some(json!({"action": "decline"}))
    }
}

/// The recorder's `options(spec)`, in Rust.
fn options(spec: &Value, env: Vec<(String, String)>) -> Options {
    let mut o = Options {
        path_to_claude_code_executable: Some(fake_bin()),
        env: Some(env.into_iter().collect()),
        ..Default::default()
    };
    if spec["canUseTool"] == true {
        o.can_use_tool = Some(Arc::new(Allow));
    }
    if spec["onElicitation"] == true {
        o.on_elicitation = Some(Arc::new(Decline));
    }
    if let Some(n) = spec["hooks"].as_u64() {
        let matchers = if n > 0 {
            vec![HookMatcher::new(hook_fn(|_, _| async {
                json!({"continue": true})
            }))]
        } else {
            vec![]
        };
        o.hooks = IndexMap::from([("PreToolUse".to_owned(), matchers)]);
    }
    if spec["mcp"] == true {
        let tool = ToolDef::new(
            "echo",
            "Echo",
            json!({"type": "object", "properties": {"msg": {"type": "string"}}, "required": ["msg"]}),
            |args| async move { ToolOutput::text(js::to_string(args.get("msg"))) },
        );
        o.mcp_servers.insert(
            "srv".into(),
            McpServerConfig::Sdk(Arc::new(ToolServer::new("srv", "1.0.0", vec![tool]))),
        );
    }
    o.verbatim_prompts = spec["verbatimPrompts"] == true;
    o
}

fn json_lines(path: &std::path::Path) -> Vec<Value> {
    std::fs::read_to_string(path)
        .unwrap_or_default()
        .lines()
        .map(|l| serde_json::from_str(l).unwrap())
        .collect()
}

/// What the recorder captures for one case, from the Rust side.
async fn replay(case: Value) -> (String, Vec<String>) {
    let name = case["name"].as_str().unwrap().to_owned();
    let tmp = tempfile::tempdir().unwrap();
    let log = tmp.path().join("stdin.log");
    let events = tmp.path().join("events.log");
    let mut env: Vec<(String, String)> = vec![
        ("PATH".into(), "/usr/bin:/bin".into()),
        ("HOME".into(), tmp.path().display().to_string()),
        ("FAKE_CLAUDE_LOG".into(), log.display().to_string()),
        ("FAKE_CLAUDE_EVENTS".into(), events.display().to_string()),
        ("FAKE_CLAUDE_SCRIPT".into(), case["script"].to_string()),
    ];
    if let Some(extra) = case["spec"]["env"].as_object() {
        env.extend(
            extra
                .iter()
                .map(|(k, v)| (k.clone(), v.as_str().unwrap().to_owned())),
        );
    }
    let mut opts = options(&case["spec"], env);
    opts.cwd = Some(tmp.path().to_path_buf());
    let mut q = Query::spawn_prompt("go", opts).await.unwrap();
    let mut yielded = Vec::new();
    let mut follow_up = case["spec"]["followUp"].as_str();
    loop {
        match tokio::time::timeout(Duration::from_secs(20), q.next())
            .await
            .unwrap_or_else(|_| panic!("{name}: the stream never ended"))
        {
            None => break,
            Some(Ok(m)) => {
                yielded.push(match m["subtype"].as_str() {
                    Some(st) => format!("{}/{st}", m["type"].as_str().unwrap()),
                    None => m["type"].as_str().unwrap().to_owned(),
                });
                // The recorder's `streamInput` of one more prompt.
                if m["type"] == "result"
                    && let Some(text) = follow_up.take()
                {
                    let msg = json!({"type": "user", "session_id": "", "message": {"role": "user", "content": text}, "parent_tool_use_id": null});
                    q.handle().send_user_message(&msg).await.unwrap();
                }
            }
            Some(Err(e)) => panic!("{name}: {e}"),
        }
    }
    let mut failures = Vec::new();
    let got_events: Vec<Value> = json_lines(&events)
        .into_iter()
        .map(|e| {
            if e["eof"] == true {
                json!("eof")
            } else {
                e["mark"].clone()
            }
        })
        .collect();
    if Value::Array(got_events.clone()) != case["events"] {
        failures.push(format!(
            "{name}: stdin closed at the wrong point\n  sdk:  {}\n  rust: {}",
            case["events"],
            Value::Array(got_events)
        ));
    }
    let users: Vec<Value> = json_lines(&log)
        .into_iter()
        .filter(|m| m["type"] == "user")
        .collect();
    let (want, got) = (
        js::stringify(&case["userLines"]),
        js::stringify(&Value::Array(users)),
    );
    if want != got {
        failures.push(format!("{name}: user lines\n  sdk:  {want}\n  rust: {got}"));
    }
    if json!(yielded) != case["yielded"] {
        failures.push(format!(
            "{name}: yielded\n  sdk:  {}\n  rust: {}",
            case["yielded"],
            json!(yielded)
        ));
    }
    (name, failures)
}

#[tokio::test(flavor = "multi_thread")]
async fn single_turn_run_end_matches_the_sdk() {
    let fx = fixture();
    let cases = fx["cases"].as_array().unwrap().clone();
    assert!(cases.len() >= 19, "fixture has only {} cases", cases.len());
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

#[test]
fn ceiling_env_parses_like_the_sdk() {
    let fx = fixture();
    let mut failures = Vec::new();
    for row in fx["ceilingTable"].as_array().unwrap() {
        let raw = row["raw"].as_str();
        let want = row["ceiling"].as_f64().unwrap();
        let got = run_end_ceiling_ms(raw);
        if got != want {
            failures.push(format!("{raw:?}: sdk {want}, rust {got}"));
        }
    }
    assert!(failures.is_empty(), "{}", failures.join("\n"));
}

#[tokio::test]
async fn oneshot_returns_the_first_result_and_closes() {
    let tmp = tempfile::tempdir().unwrap();
    let pid_file = tmp.path().join("pid");
    // `running` + a callback: the run doesn't end at the result, so only
    // oneshot's close stops the CLI.
    let script = json!({"turns": [{"steps": [
        {"type": "system", "subtype": "session_state_changed", "state": "running"},
        {"$text": "first"},
    ], "result": {"result": "subject line"}}]});
    let mut opts = Options {
        path_to_claude_code_executable: Some(fake_bin()),
        cwd: Some(tmp.path().to_path_buf()),
        can_use_tool: Some(Arc::new(Allow)),
        verbatim_prompts: true,
        ..Default::default()
    };
    opts.env = Some(
        [
            ("PATH", "/usr/bin:/bin".to_owned()),
            ("FAKE_CLAUDE_SCRIPT", script.to_string()),
            ("FAKE_CLAUDE_PID", pid_file.display().to_string()),
        ]
        .into_iter()
        .map(|(k, v)| (k.to_owned(), v))
        .collect(),
    );
    let result = tokio::time::timeout(Duration::from_secs(10), oneshot("hi", opts))
        .await
        .expect("oneshot hung")
        .unwrap()
        .expect("a result");
    assert_eq!(result["type"], "result");
    assert_eq!(result["subtype"], "success");
    assert_eq!(result["result"], "subject line");
    // The CLI is gone once oneshot returns (killed, like the SDK's cleanup).
    #[cfg(unix)]
    assert_gone(&pid_file).await;
}

#[cfg(unix)]
async fn assert_gone(pid_file: &std::path::Path) {
    let pid: i32 = std::fs::read_to_string(pid_file).unwrap().parse().unwrap();
    let mut alive = true;
    for _ in 0..50 {
        // SAFETY: signal 0 only probes whether the pid exists.
        alive = unsafe { libc::kill(pid, 0) } == 0;
        if !alive {
            break;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    assert!(
        !alive,
        "fake CLI {pid} still running after oneshot returned"
    );
}

#[tokio::test]
async fn oneshot_without_a_result_is_none() {
    let tmp = tempfile::tempdir().unwrap();
    let script =
        json!({"turns": [{"steps": [{"$text": "no result"}, {"$exit": 0}], "result": false}]});
    let opts = Options {
        path_to_claude_code_executable: Some(fake_bin()),
        cwd: Some(tmp.path().to_path_buf()),
        env: Some(
            [
                ("PATH".to_owned(), "/usr/bin:/bin".to_owned()),
                ("FAKE_CLAUDE_SCRIPT".to_owned(), script.to_string()),
            ]
            .into_iter()
            .collect(),
        ),
        ..Default::default()
    };
    assert_eq!(oneshot("hi", opts).await.unwrap(), None);
}
