//! Session reminders (S21), replayed against the TS recording in
//! `tests/fixtures/reminders_golden.json` (`rust/scripts/reminders-golden.mjs`):
//! - the bodies (`wrapReminder`, ultrathink, date-change, linter-modified-file,
//!   the fixed ones, plan re-entry) and the two queues' semantics;
//! - `scenarios`: a real `Session` on the fake CLI walked through the ops TS
//!   ran on its own `Session` (prompts, CLI messages, results, the
//!   `PostToolUse` / `PreToolUse` hook callbacks, plan prompts, file changes
//!   mid-turn and between turns, session state, mode switches). Every user
//!   message the CLI got must carry the content TS queued, byte for byte,
//!   every hook reply must match, and so must the `cwd_changed` broadcasts.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, OnceLock};
use std::time::Duration;

use chrono::NaiveDate;
use claudius_core::reminders::{
    ReminderQueue, date_change_reminder_body, linter_modified_reminder_body, local_date_key,
    wrap_reminder,
};
use claudius_core::session::{
    self, PlanDecision, RuntimeOptions, SendOptions, Session, SessionOptions, Subscription,
};
use claudius_core::session_manager::SessionManager;
use claudius_core::{paths, sessions_db};
use serde_json::{Map, Value, json};

fn fixture() -> &'static Value {
    static F: OnceLock<Value> = OnceLock::new();
    F.get_or_init(|| serde_json::from_str(include_str!("fixtures/reminders_golden.json")).unwrap())
}

fn cases(key: &str, min: usize) -> &'static [Value] {
    let v = fixture()[key].as_array().unwrap();
    assert!(v.len() >= min, "{key}: {}", v.len());
    v
}

fn str_of(v: &Value) -> &str {
    v.as_str().unwrap()
}

#[test]
fn the_wrapper_matches() {
    for c in cases("wrap", 5) {
        assert_eq!(wrap_reminder(str_of(&c["body"])), str_of(&c["xml"]));
    }
}

#[test]
fn the_ultrathink_scan_matches() {
    let mut matched = 0;
    for c in cases("ultrathink", 20) {
        let text = str_of(&c["text"]);
        let got = session::ultrathink_reminder_body(text);
        matched += usize::from(got.is_some());
        assert_eq!(got, c["body"].as_str(), "{text:?}");
    }
    assert!(matched >= 10, "{matched}");
}

/// A recorded `[year, month, day]`.
fn date(v: &Value) -> NaiveDate {
    let n = |i: usize| v[i].as_i64().unwrap();
    NaiveDate::from_ymd_opt(n(0) as i32, n(1) as u32, n(2) as u32).unwrap()
}

#[test]
fn the_date_change_body_matches() {
    for c in cases("dates", 45) {
        let d = date(&c["date"]);
        assert_eq!(local_date_key(d), str_of(&c["key"]), "{}", c["date"]);
        assert_eq!(
            date_change_reminder_body(str_of(&c["prev"]), d).as_deref(),
            c["body"].as_str(),
            "{} after {}",
            c["date"],
            c["prev"]
        );
    }
}

#[test]
fn the_linter_body_matches() {
    for c in cases("linter", 5) {
        let paths: Vec<&str> = c["paths"].as_array().unwrap().iter().map(str_of).collect();
        assert_eq!(
            linter_modified_reminder_body(&paths).as_deref(),
            c["body"].as_str(),
            "{paths:?}"
        );
    }
}

#[test]
fn the_fixed_bodies_match() {
    let c = &fixture()["constants"];
    assert_eq!(
        session::midturn_inject_reminder_body(),
        str_of(&c["midturnInject"])
    );
    assert_eq!(
        session::auto_mode_exit_reminder_body(),
        str_of(&c["autoModeExit"])
    );
    assert_eq!(
        session::verify_plan_reminder_body(),
        str_of(&c["verifyPlan"])
    );
    for p in cases("plans", 4) {
        assert_eq!(
            session::plan_mode_reentry_reminder_body(str_of(&p["prior"])),
            str_of(&p["body"])
        );
    }
}

/// `queueReminder` & co. on two hosts that share an id: each its own pair
/// of queues.
#[test]
fn the_queues_match() {
    let mut hosts: HashMap<String, (ReminderQueue, ReminderQueue)> = HashMap::new();
    for c in cases("queues", 20) {
        let op = c["op"].as_array().unwrap();
        let (next, mid) = hosts.entry(str_of(&op[1]).to_owned()).or_default();
        let got = match str_of(&op[0]) {
            "q" => {
                next.push(str_of(&op[3]));
                Value::Null
            }
            "m" => {
                mid.push(str_of(&op[3]));
                Value::Null
            }
            "take" => next.take().map_or(Value::Null, Value::from),
            "takeMid" => mid.take().map_or(Value::Null, Value::from),
            "count" => {
                assert_eq!(next.is_empty(), c["result"] == 0, "{}", c["op"]);
                json!(next.len())
            }
            "countMid" => {
                assert_eq!(mid.is_empty(), c["result"] == 0, "{}", c["op"]);
                json!(mid.len())
            }
            o => panic!("unknown op {o}"),
        };
        assert_eq!(got, c["result"], "{}", c["op"]);
    }
}

// ─────────────────────────────── scenarios ───────────────────────────────

/// One isolated `$HOME` + config dir per test binary, and the fake CLI built.
fn fake() -> &'static PathBuf {
    static E: OnceLock<(tempfile::TempDir, PathBuf)> = OnceLock::new();
    &E.get_or_init(|| {
        let root = tempfile::tempdir().unwrap();
        let home = root.path().join("home");
        let config = root.path().join("config");
        std::fs::create_dir_all(&home).unwrap();
        std::fs::create_dir_all(&config).unwrap();
        assert!(paths::set_home_override(home));
        assert!(paths::set_config_dir_override(config));
        let cargo = std::env::var("CARGO").unwrap_or_else(|_| "cargo".into());
        let st = std::process::Command::new(cargo)
            .args([
                "build",
                "-q",
                "-p",
                "claudius-agent",
                "--bin",
                "claudius-fake-claude",
            ])
            .current_dir(env!("CARGO_MANIFEST_DIR"))
            .status()
            .unwrap();
        assert!(st.success());
        let bin = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../target/debug/claudius-fake-claude");
        (root, bin)
    })
    .1
}

/// `$ROOT` → `root` in every string.
fn sub(v: &Value, root: &str) -> Value {
    match v {
        Value::String(s) => Value::String(s.replace("$ROOT", root)),
        Value::Array(a) => Value::Array(a.iter().map(|x| sub(x, root)).collect()),
        Value::Object(o) => {
            Value::Object(o.iter().map(|(k, x)| (k.clone(), sub(x, root))).collect())
        }
        v => v.clone(),
    }
}

/// One prompt and what the CLI does in its turn.
#[derive(Default)]
struct Turn {
    /// Test-side ops since the previous turn ended.
    before: Vec<Value>,
    text: String,
    slash: bool,
    steps: Vec<Value>,
    /// The plan decisions, in prompt order.
    plans: Vec<PlanDecision>,
    /// No `result`: the next prompt arrives mid-turn.
    open: bool,
}

/// Split a scenario's ops into turns: what runs between a `send` and its
/// `end` (or the next `send`) is the CLI's, the rest the test's.
fn turns(ops: &[Value], root: &str) -> (Vec<Turn>, Vec<Value>) {
    let mut out = vec![];
    let mut before = vec![];
    let mut cur: Option<Turn> = None;
    for op in ops {
        let op = sub(op, root);
        let a = op.as_array().unwrap();
        let hook = |event: &str| {
            json!({"$control": {"subtype": "hook_callback", "callback_id": format!("$HOOK:{event}"),
                "input": a[1], "tool_use_id": a[1].get("tool_use_id").cloned().unwrap_or(json!("toolu_x"))}})
        };
        match (str_of(&a[0]), cur.as_mut()) {
            ("send", _) => {
                if let Some(mut t) = cur.take() {
                    t.open = true;
                    out.push(t);
                }
                cur = Some(Turn {
                    before: std::mem::take(&mut before),
                    text: str_of(&a[1]).to_owned(),
                    slash: a.get(2).is_some_and(|o| o["slash"] == true),
                    ..Default::default()
                });
            }
            ("end", Some(_)) => out.push(cur.take().unwrap()),
            ("post", Some(t)) => t.steps.push(hook("PostToolUse")),
            ("pre", Some(t)) => t.steps.push(hook("PreToolUse")),
            ("emit", Some(t)) => {
                t.steps.push(a[1].clone());
                // Hooks are served as they're read, messages queue for the
                // consume loop: let it catch up first.
                t.steps.push(json!({"$delay_ms": 150}));
            }
            ("plan", Some(t)) => {
                t.steps.push(
                    json!({"$control": {"subtype": "can_use_tool", "tool_name": "ExitPlanMode",
                    "input": a[1], "tool_use_id": "toolu_plan"}}),
                );
                t.plans.push(serde_json::from_value(a[2].clone()).unwrap());
            }
            ("write" | "rm" | "mkdir" | "chmod", Some(t)) => t.steps.push(json!({"$fs": op})),
            ("write" | "rm" | "mkdir" | "chmod" | "state" | "mode", None) => before.push(op),
            (o, t) => panic!("{o} with a turn open: {}", t.is_some()),
        }
    }
    if let Some(mut t) = cur {
        t.open = true;
        out.push(t);
    }
    (out, before)
}

/// A test-side op.
async fn run_op(s: &Session, op: &Value) {
    let a = op.as_array().unwrap();
    let path = || str_of(&a[1]);
    match str_of(&a[0]) {
        "write" => match &a[2] {
            Value::String(text) => std::fs::write(path(), text).unwrap(),
            bytes => {
                let bytes: Vec<u8> = serde_json::from_value(bytes.clone()).unwrap();
                std::fs::write(path(), bytes).unwrap()
            }
        },
        "rm" => {
            let _ = std::fs::remove_dir_all(path()).or_else(|_| std::fs::remove_file(path()));
        }
        "mkdir" => std::fs::create_dir_all(path()).unwrap(),
        "chmod" => {
            use std::os::unix::fs::PermissionsExt;
            let mode = a[2].as_u64().unwrap() as u32;
            std::fs::set_permissions(path(), std::fs::Permissions::from_mode(mode)).unwrap();
        }
        "state" => {
            let patch: Map<String, Value> = a[1].as_object().unwrap().clone();
            sessions_db::merge_session_state(&s.cwd, &s.id, patch).unwrap();
        }
        "mode" => s.set_permission_mode(str_of(&a[1]), false).await,
        o => panic!("unknown op {o}"),
    }
}

async fn next(sub: &mut Subscription, seen: &[Value]) -> Value {
    tokio::time::timeout(Duration::from_secs(20), sub.recv())
        .await
        .unwrap_or_else(|_| panic!("event timeout after {seen:#?}"))
        .expect("stream closed")
}

const MARK: &str = "[[steps done]]";

/// Read events until the turn is over (running, then idle; already running
/// when sent mid-turn) or, for an open one, its steps are (the marker
/// text); answer its plan prompts on the way and keep the `cwd_changed`
/// paths.
async fn finish(
    s: &Session,
    sub: &mut Subscription,
    turn: &mut Turn,
    mid_turn: bool,
    cwds: &mut Vec<String>,
) {
    let mut plans = std::mem::take(&mut turn.plans).into_iter();
    let mut running = mid_turn;
    let mut seen = vec![];
    loop {
        let ev = next(sub, &seen).await;
        seen.push(ev.clone());
        match ev["type"].as_str().unwrap_or("") {
            "cwd_changed" => cwds.push(str_of(&ev["cwd"]).to_owned()),
            "plan_approval_request" => {
                let decision = plans.next().expect("an unscripted plan prompt");
                assert!(s.resolve_plan(str_of(&ev["requestId"]), decision));
            }
            "turn_status" if ev["status"] == "running" => running = true,
            "turn_status" if running && !turn.open && ev["status"] == "idle" => break,
            "sdk" if turn.open && ev["message"]["message"]["content"][0]["text"] == MARK => break,
            _ => {}
        }
    }
    assert!(plans.next().is_none(), "a plan decision left over");
}

async fn replay(case: &Value) {
    let name = str_of(&case["name"]);
    let cwd = tempfile::tempdir().unwrap();
    let root = cwd.path().canonicalize().unwrap().display().to_string();
    let (mut turns, trailing) = turns(case["ops"].as_array().unwrap(), &root);
    let script_turns: Vec<Value> = turns
        .iter()
        .map(|t| {
            let token = &t.text[t.text.find("[[").unwrap()..=t.text.find("]]").unwrap() + 1];
            let mut steps = t.steps.clone();
            if t.open {
                steps.push(json!({"$text": MARK}));
            }
            json!({"match": token, "steps": steps, "result": if t.open { json!(false) } else { Value::Null }})
        })
        .collect();
    // Absent `result`: the default success.
    let script_turns: Vec<Value> = script_turns
        .into_iter()
        .map(|mut t| {
            if t["result"].is_null() {
                t.as_object_mut().unwrap().remove("result");
            }
            t
        })
        .collect();
    let log = cwd.path().join("stdin.log");
    let mut env: HashMap<String, String> = HashMap::new();
    env.insert("PATH".into(), std::env::var("PATH").unwrap_or_default());
    env.insert("FAKE_CLAUDE_LOG".into(), log.display().to_string());
    env.insert(
        "FAKE_CLAUDE_SCRIPT".into(),
        json!({"turns": script_turns}).to_string(),
    );
    let mgr = Arc::new(SessionManager::default());
    let s = mgr
        .create(SessionOptions {
            cwd: Some(root.clone()),
            runtime: RuntimeOptions {
                claude_bin: Some(fake().clone()),
                env_override: Some(env),
            },
            ..Default::default()
        })
        .await
        .expect("create");
    let mut sub = s.subscribe(None, None);
    let mut cwds = vec![];
    let mut mid_turn = false;
    for t in &mut turns {
        for op in &t.before {
            run_op(&s, op).await;
        }
        let opts = SendOptions {
            slash: t.slash,
            ..Default::default()
        };
        s.send_input(&t.text, &[], opts);
        finish(&s, &mut sub, t, mid_turn, &mut cwds).await;
        mid_turn = t.open;
    }
    for op in &trailing {
        run_op(&s, op).await;
    }
    let lines: Vec<Value> = std::fs::read_to_string(&log)
        .unwrap()
        .lines()
        .filter_map(|l| serde_json::from_str(l).ok())
        .collect();
    let sent: Vec<Value> = lines
        .iter()
        .filter(|m| m["type"] == "user")
        .map(|m| Value::String(str_of(&m["message"]["content"]).replace(&root, "$ROOT")))
        .collect();
    assert_eq!(&Value::Array(sent), &case["sent"], "{name}: the prompts");
    let hooks: Vec<Value> = lines
        .iter()
        .filter(|m| m["type"] == "control_response")
        .map(|m| &m["response"]["response"])
        .filter(|r| r.get("continue").is_some())
        .map(|r| serde_json::from_str(&r.to_string().replace(&root, "$ROOT")).unwrap())
        .collect();
    assert_eq!(
        &Value::Array(hooks),
        &case["hooks"],
        "{name}: the hook replies"
    );
    // The plan prompts' answers, without the `toolUseID` the SDK adds.
    let plan_replies: Vec<Value> = lines
        .iter()
        .filter(|m| m["type"] == "control_response")
        .filter_map(|m| m["response"]["response"].as_object())
        .filter(|r| r.contains_key("behavior"))
        .map(|r| {
            let mut r = r.clone();
            r.remove("toolUseID");
            Value::Object(r)
        })
        .collect();
    assert_eq!(
        &Value::Array(plan_replies),
        &case["planReplies"],
        "{name}: the plan replies"
    );
    let cwds: Vec<Value> = cwds
        .iter()
        .map(|c| Value::String(c.replace(&root, "$ROOT")))
        .collect();
    assert_eq!(&Value::Array(cwds), &case["cwds"], "{name}: cwd_changed");
    mgr.remove(&s.id).await;
}

#[tokio::test]
async fn scenarios_match_the_ts_session() {
    for case in cases("scenarios", 10) {
        replay(case).await;
    }
}
