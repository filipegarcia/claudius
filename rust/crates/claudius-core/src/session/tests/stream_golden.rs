//! S28: `broadcast()`, `captureSnapshotState()` and `captureTaskState()`
//! replayed against the real TS. The `broadcast` half of
//! `tests/fixtures/session_stream_golden.json`
//! (`rust/scripts/session-stream-golden.mjs`): scripted events through
//! [`Session::broadcast`] on a session that never starts. After each step,
//! what a live subscriber got and the captured state; after the last, the
//! replay buffer, the reminders, the task rows and the session's `state`.

use super::*;
use rusqlite::OptionalExtension as _;

/// Cases where the TS throws out of `broadcast()` and Rust carries on (the
/// first differing field is named). A stale entry fails the test.
const KNOWN: &[(&str, &str)] = &[
    // `(event.message).parent_tool_use_id` on a null / missing message
    // throws before the capture and the fan-out; only the dev-only
    // `dev-broadcast` route can send one.
    ("sdk message null", "step 0 threw"),
    ("sdk message missing", "step 0 threw"),
    // `commandNamesFromChanged` maps a non-array `commands` and throws; the
    // CLI always sends an array.
    ("commands not an array", "step 1 threw"),
    // PORT_PLAN gaps, Subagent (Task) persistence: the capture keeps only
    // the SDK's own types (a numeric `description`, a string flag, a
    // numeric `parent_tool_use_id`).
    ("task odd types", "step 0 state"),
];

fn fixture() -> Value {
    serde_json::from_str(include_str!(
        "../../../tests/fixtures/session_stream_golden.json"
    ))
    .unwrap()
}

/// The recorder's `norm`: clock-stamped numbers read `$NOW`.
fn norm(v: Value, key: Option<&str>) -> Value {
    match v {
        Value::Number(n)
            if matches!(key, Some("at" | "fetchedAt" | "todosAt"))
                && n.as_f64().is_some_and(|f| f >= 1e12) =>
        {
            json!("$NOW")
        }
        Value::Array(a) => Value::Array(a.into_iter().map(|x| norm(x, None)).collect()),
        Value::Object(o) => Value::Object(
            o.into_iter()
                .map(|(k, x)| {
                    let x = norm(x, Some(&k));
                    (k, x)
                })
                .collect(),
        ),
        v => v,
    }
}

/// Keys sorted, recursively (the recorder's `canon`).
fn canon(v: &Value) -> Value {
    match v {
        Value::Array(a) => Value::Array(a.iter().map(canon).collect()),
        Value::Object(o) => {
            let mut keys: Vec<&String> = o.keys().collect();
            keys.sort();
            Value::Object(
                keys.into_iter()
                    .map(|k| (k.clone(), canon(&o[k])))
                    .collect(),
            )
        }
        v => v.clone(),
    }
}

/// The recorder's `project`.
fn project(st: &State) -> Value {
    let at = st.latest_todos_at;
    let sorted = |set: &HashSet<String>| {
        let mut v: Vec<&String> = set.iter().collect();
        v.sort();
        json!(v)
    };
    let overrides: Map<String, Value> = st
        .manual_todo_overrides
        .iter()
        .map(|(k, v)| (k.clone(), json!(v)))
        .collect();
    let overrides: Map<String, Value> = js::own_keys_order(&overrides)
        .into_iter()
        .map(|(k, v)| (k.clone(), v.clone()))
        .collect();
    let tasks: Vec<Value> = st
        .task_meta
        .values()
        .map(|m| {
            let mut j = m.to_json();
            j.as_object_mut().unwrap().shift_remove("innerMessages");
            canon(&j)
        })
        .collect();
    let inner: std::collections::BTreeMap<&String, usize> =
        st.subagent_msgs.iter().map(|(k, v)| (k, v.len())).collect();
    json!({
        "prompt": st.latest_user_prompt,
        "todos": st.latest_todos,
        "todosAt": if at.is_finite() { crate::js_num(at) } else { json!(if at.is_nan() { "NaN" } else if at > 0.0 { "Infinity" } else { "-Infinity" }) },
        "pendingCreates": sorted(&st.pending_task_creates),
        "pendingLists": sorted(&st.pending_task_lists),
        "rebuiltFromTaskList": st.todos_rebuilt_from_task_list_this_turn,
        "toolUsesSinceTodoTouch": st.tool_uses_since_todo_touch,
        "firedMidTurn": st.fired_mid_turn_todo_reminder_this_turn,
        "turnsSinceTodoWrite": st.turns_since_todo_write,
        "overrides": overrides,
        "init": st.latest_init,
        "sdkModel": st.sdk_model,
        "denials": st.recent_denials,
        "lastCwd": st.last_cwd_broadcast,
        "tasks": tasks,
        "inner": inner,
        "status": st.status().as_str(),
        "backgroundTasks": st.background_tasks(),
    })
}

fn state_row(cwd: &str, id: &str) -> Value {
    let db = crate::db::open_db(cwd, crate::db::Mode::ReadWrite).unwrap();
    let row: Option<Option<String>> = db
        .with(|c| {
            c.query_row("SELECT state FROM sessions WHERE id = ?", [id], |r| {
                r.get(0)
            })
            .optional()
        })
        .unwrap();
    json!(row.flatten())
}

fn drain(rx: &mut mpsc::UnboundedReceiver<Value>) -> Vec<Value> {
    std::iter::from_fn(|| rx.try_recv().ok()).collect()
}

fn burst_event(i: u64) -> Value {
    json!({"type": "sdk", "message": {"type": "assistant", "message":
        {"role": "assistant", "content": [{"type": "text", "text": "hi"}]}}, "at": i})
}

/// Every case's differences, as `(case, where)` with the first difference
/// of each case; the strings are compared in full.
#[test]
fn broadcast_matches_ts() {
    let fx = fixture();
    let cwd = test_home().join("stream-golden").display().to_string();
    let mut diffs: Vec<(String, String)> = Vec::new();
    for case in fx["broadcast"].as_array().unwrap() {
        let name = case["name"].as_str().unwrap();
        let id = case["id"].as_str().unwrap();
        let s = Session::new(SessionOptions {
            id: Some(id.to_owned()),
            cwd: Some(cwd.clone()),
            ..Default::default()
        })
        .unwrap();
        let (tx, mut rx) = mpsc::unbounded_channel();
        s.with(|st| st.subs.push(Sub { id: u64::MAX, tx }));
        let mut first: Option<String> = None;
        let mut note = |what: String, got: String, want: String| {
            if got != want && first.is_none() {
                first = Some(what.clone());
                eprintln!("{name}: {what}\n  got:  {got}\n  want: {want}");
            }
        };
        let mut burst = None;
        for (i, step) in case["steps"].as_array().unwrap().iter().enumerate() {
            if let Some(set) = step.get("set") {
                s.with(|st| {
                    if let Some(r) = set.get("replaying") {
                        st.is_replaying = r == true;
                    }
                    if let Some(o) = set.get("overrides").and_then(Value::as_object) {
                        st.manual_todo_overrides = o
                            .iter()
                            .map(|(k, v)| (k.clone(), override_status_from(v).unwrap()))
                            .collect();
                    }
                    if let Some(at) = set.get("todosAt").and_then(Value::as_f64) {
                        st.latest_todos_at = at;
                    }
                    if let Some(f) = set.get("turnInFlight") {
                        st.turn_in_flight = f == true;
                    }
                });
            } else if let Some(b) = step.get("burst") {
                let n = b["count"].as_u64().unwrap();
                burst = Some(n);
                for i in 0..n {
                    s.broadcast(burst_event(i));
                }
            } else {
                s.broadcast(step["ev"].clone());
            }
            note(
                format!("step {i} threw"),
                "null".into(),
                step["threw"].to_string(),
            );
            let live = drain(&mut rx);
            let live = if step.get("burst").is_some() {
                json!(live.len())
            } else {
                norm(Value::Array(live), None)
            };
            note(
                format!("step {i} live"),
                live.to_string(),
                step["live"].to_string(),
            );
            let state = s.with(|st| norm(project(st), None));
            note(
                format!("step {i} state"),
                state.to_string(),
                step["state"].to_string(),
            );
        }
        let buffer = norm(Value::Array(s.buffer_snapshot()), None);
        let buffer = match burst {
            None => buffer,
            Some(_) => {
                let b = buffer.as_array().unwrap();
                json!({"length": b.len(), "head": b[..2], "tail": b[b.len() - 2..]})
            }
        };
        note(
            "buffer".into(),
            buffer.to_string(),
            case["buffer"].to_string(),
        );
        let (trimmed, mid, rem) = s.with(|st| {
            (
                st.buffer_trimmed,
                st.mid_turn_reminders.take(),
                st.reminders.take(),
            )
        });
        note(
            "bufferTrimmed".into(),
            json!(trimmed).to_string(),
            case["bufferTrimmed"].to_string(),
        );
        note(
            "midTurnReminders".into(),
            json!(mid).to_string(),
            case["midTurnReminders"].to_string(),
        );
        note(
            "reminders".into(),
            json!(rem).to_string(),
            case["reminders"].to_string(),
        );
        let mut rows = session_tasks_db::list_session_tasks(&cwd, id);
        rows.sort_by(|a, b| a.task_id.cmp(&b.task_id));
        let tasks: Vec<Value> = rows.iter().map(TaskEntry::to_json).collect();
        note(
            "tasksDb".into(),
            norm(json!(tasks), None).to_string(),
            case["tasksDb"].to_string(),
        );
        note(
            "stateRow".into(),
            state_row(&cwd, id).to_string(),
            case["stateRow"].to_string(),
        );
        if let Some(w) = first {
            diffs.push((name.to_owned(), w));
        }
    }
    let known: Vec<(String, String)> = KNOWN
        .iter()
        .map(|(a, b)| ((*a).to_owned(), (*b).to_owned()))
        .collect();
    assert_eq!(diffs, known);
}
