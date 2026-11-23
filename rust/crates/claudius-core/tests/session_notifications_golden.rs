//! Replays `fixtures/session_notifications_golden.json`, recorded by
//! `rust/scripts/session-notifications-golden.mjs` from the real
//! `new Session({id, cwd})` of `lib/server/session.ts` against the fake CLI
//! on the real notification bus and DB layer (S31).
//!
//! The same scenarios run here through [`Session`] against the same fake
//! CLI and scripts, with the same workspaces.json (one workspace per
//! scenario, with its `defaults.notifications`), on the process's
//! [`NotificationBus::global`], which every session feeds. After each step
//! (and the bus's queued calls and coalesced flushes) the scenario
//! database's notifications rows, the bus's `notification` events for the
//! scenario's workspace and the last `state` event's counts must equal the
//! recording. Row ids, request ids and times are random in both, so they
//! are compared as the recorder wrote them: ids as `$N<k>` / `$R<k>` in order
//! of first appearance, times as `"$T"`.

#[path = "../../claudius-agent/tests/support/test_bins.rs"]
mod test_bins;

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, OnceLock};
use std::time::{Duration, Instant};

use claudius_core::db::{Mode, open_db};
use claudius_core::notification_bus::{NotificationBus, StreamEvent};
use claudius_core::notifications_db::{self as ndb, PrefsPatch};
use claudius_core::session::{
    PermissionDecision, PlanDecision, RuntimeOptions, SendOptions, Session, SessionOptions,
    Subscription,
};
use claudius_core::{js_num, paths};
use rusqlite::types::ValueRef;
use serde_json::{Map, Value, json};

fn fixture() -> Value {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("tests/fixtures/session_notifications_golden.json");
    serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap()
}

struct Env {
    root: PathBuf,
    fake: PathBuf,
    _dir: tempfile::TempDir,
}

/// One private home (workspaces.json, the per-project databases) and config
/// dir for this binary, and the fake CLI built.
fn env() -> &'static Env {
    static E: OnceLock<Env> = OnceLock::new();
    E.get_or_init(|| {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().canonicalize().unwrap();
        let home = root.join("home");
        std::fs::create_dir_all(home.join(".claude/.claudius")).unwrap();
        // No feedback nudge (its roll is random), as in the recorder.
        std::fs::write(
            home.join(".claude/settings.json"),
            "{\n  \"feedbackSurveyRate\": 0\n}\n",
        )
        .unwrap();
        assert!(paths::set_home_override(home));
        assert!(paths::set_config_dir_override(root.join("config")));
        let fake = test_bins::fake_claude();
        Env {
            root,
            fake,
            _dir: dir,
        }
    })
}

const PROMPT_TYPES: [&str; 4] = [
    "permission_request",
    "ask_user_question",
    "plan_approval_request",
    "mcp_elicitation_request",
];

fn is_init(e: &Value) -> bool {
    e["type"] == "sdk" && e["message"]["type"] == "system" && e["message"]["subtype"] == "init"
}

/// (results, prompts) in the session's buffer.
fn counts(s: &Session) -> (usize, usize) {
    let buf = s.buffer_snapshot();
    let results = buf
        .iter()
        .filter(|e| e["type"] == "sdk" && e["message"]["type"] == "result")
        .count();
    let prompts = buf
        .iter()
        .filter(|e| PROMPT_TYPES.contains(&e["type"].as_str().unwrap_or("")))
        .count();
    (results, prompts)
}

async fn wait_for(what: &str, mut pred: impl FnMut() -> bool) {
    let start = Instant::now();
    while !pred() {
        assert!(
            start.elapsed() < Duration::from_secs(15),
            "timed out waiting for {what}"
        );
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
}

async fn wait_step(s: &Session, wait: &str, before: (usize, usize), what: &str) {
    match wait {
        "init" => wait_for(what, || s.buffer_snapshot().iter().any(is_init)).await,
        "result" => wait_for(what, || counts(s).0 > before.0).await,
        "prompt" => wait_for(what, || counts(s).1 > before.1).await,
        "done" => wait_for(what, || s.is_done()).await,
        "none" => {}
        other => panic!("unknown wait {other}"),
    }
}

/// The recorder's `$N<k>` / `$R<k>` / `"$T"` normalizer, one per scenario.
#[derive(Default)]
struct Norm {
    ids: Vec<String>,
    reqs: Vec<String>,
}

impl Norm {
    fn tag(list: &mut Vec<String>, prefix: &str, v: &Value) -> Value {
        let Some(s) = v.as_str() else {
            return v.clone();
        };
        let i = match list.iter().position(|x| x == s) {
            Some(i) => i,
            None => {
                list.push(s.to_owned());
                list.len() - 1
            }
        };
        json!(format!("{prefix}{i}"))
    }

    fn time(v: &Value) -> Value {
        if v.is_null() {
            Value::Null
        } else {
            json!("$T")
        }
    }

    fn map(&mut self, v: &Value, keys: [&str; 4]) -> Value {
        let mut m = v.as_object().unwrap().clone();
        let [id, req, created, read] = keys;
        for (k, f) in [(id, 0), (req, 1), (created, 2), (read, 2)] {
            let Some(x) = m.get(k).cloned() else { continue };
            let y = match f {
                0 => Self::tag(&mut self.ids, "$N", &x),
                1 => Self::tag(&mut self.reqs, "$R", &x),
                _ => Self::time(&x),
            };
            m.insert(k.to_owned(), y);
        }
        Value::Object(m)
    }

    fn row(&mut self, r: &Value) -> Value {
        self.map(r, ["id", "request_id", "created_at", "read_at"])
    }

    fn env(&mut self, n: &Value) -> Value {
        self.map(n, ["id", "requestId", "createdAt", "readAt"])
    }
}

/// The notifications rows as better-sqlite3's `.all()` hands them to JS.
fn read_rows(cwd: &str) -> Vec<Value> {
    let path = paths::db_path(cwd);
    if !path.exists() {
        return Vec::new();
    }
    let c =
        rusqlite::Connection::open_with_flags(&path, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)
            .unwrap();
    let mut st = c
        .prepare("SELECT * FROM notifications ORDER BY rowid")
        .unwrap();
    let names: Vec<String> = st.column_names().iter().map(|s| (*s).to_owned()).collect();
    st.query_map([], |r| {
        let mut m = Map::new();
        for (i, name) in names.iter().enumerate() {
            let v = match r.get_ref(i)? {
                ValueRef::Null => Value::Null,
                ValueRef::Integer(n) => json!(n),
                ValueRef::Real(f) => js_num(f),
                ValueRef::Text(t) => json!(String::from_utf8_lossy(t)),
                ValueRef::Blob(_) => panic!("a blob in {name}"),
            };
            m.insert(name.clone(), v);
        }
        Ok(Value::Object(m))
    })
    .unwrap()
    .collect::<rusqlite::Result<_>>()
    .unwrap()
}

fn session_options(e: &Env, id: &str, cwd: &str, script: Option<&str>) -> SessionOptions {
    let mut envmap = HashMap::new();
    envmap.insert("PATH".to_owned(), std::env::var("PATH").unwrap_or_default());
    if let Some(script) = script {
        envmap.insert("FAKE_CLAUDE_SCRIPT".to_owned(), script.to_owned());
    }
    SessionOptions {
        id: Some(id.to_owned()),
        cwd: Some(cwd.to_owned()),
        runtime: RuntimeOptions {
            claude_bin: Some(e.fake.clone()),
            env_override: Some(envmap),
        },
        ..SessionOptions::default()
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn session_bus_calls_match_the_ts_recording() {
    let fx = fixture();
    let e = env();
    let root = e.root.display().to_string();
    let workspaces = fx["workspacesJson"]
        .as_str()
        .unwrap()
        .replace("$ROOT", &root);
    std::fs::write(paths::claudius_root().join("workspaces.json"), workspaces).unwrap();
    let mut bus = NotificationBus::global().subscribe();

    let mut failures = Vec::new();
    for (i, sc) in fx["scenarios"].as_array().unwrap().iter().enumerate() {
        let name = sc["name"].as_str().unwrap();
        let id = sc["id"].as_str().unwrap();
        let cwd = format!("{root}/p/{i}");
        std::fs::create_dir_all(&cwd).unwrap();
        let ws_id = format!("wks_s31_{i}");
        let script = sc["script"].as_str();
        let mut norm = Norm::default();
        let mut session: Option<Arc<Session>> = None;
        let mut tabs: HashMap<String, Subscription> = HashMap::new();
        for (k, rec) in sc["steps"].as_array().unwrap().iter().enumerate() {
            let step = rec["step"].as_array().unwrap();
            let op = step[0].as_str().unwrap();
            let what = format!("{name} #{k} {}", rec["step"]);
            while bus.rx.try_recv().is_ok() {}
            let before = session.as_deref().map_or((0, 0), counts);
            match op {
                "seed" => {
                    let db = open_db(&cwd, Mode::ReadWrite).unwrap();
                    for sql in step[1].as_array().unwrap() {
                        let sql = sql.as_str().unwrap().replace("$ID", id);
                        db.with(|c| c.execute(&sql, [])).unwrap();
                    }
                }
                "start" => {
                    let s = Session::new(session_options(e, id, &cwd, script)).unwrap();
                    s.start().await;
                    wait_step(&s, step[1].as_str().unwrap(), (0, 0), &what).await;
                    session = Some(s);
                }
                "subscribe" => {
                    let s = session.as_ref().unwrap();
                    tabs.insert(step[1].as_str().unwrap().into(), s.subscribe(None, None));
                }
                "unsubscribe" => {
                    tabs.remove(step[1].as_str().unwrap());
                }
                "send" => {
                    let s = session.as_ref().unwrap();
                    s.send_input(step[1].as_str().unwrap(), &[], SendOptions::default());
                    wait_step(s, step[2].as_str().unwrap(), before, &what).await;
                }
                "answer" => {
                    let s = session.as_ref().unwrap();
                    let prompts: Vec<Value> = s
                        .buffer_snapshot()
                        .into_iter()
                        .filter(|e| PROMPT_TYPES.contains(&e["type"].as_str().unwrap_or("")))
                        .collect();
                    let ev = &prompts[step[1].as_u64().unwrap() as usize];
                    let rid = ev["requestId"].as_str().unwrap();
                    let d = &step[2];
                    let answered = if let Some(p) = d.get("perm") {
                        let dec: PermissionDecision = serde_json::from_value(p.clone()).unwrap();
                        s.resolve_permission(rid, dec)
                    } else if let Some(a) = d.get("ask") {
                        s.submit_ask_answer(rid, a.as_array().unwrap())
                    } else if let Some(p) = d.get("plan") {
                        let dec: PlanDecision = serde_json::from_value(p.clone()).unwrap();
                        s.resolve_plan(rid, dec)
                    } else {
                        let el = &d["elicit"];
                        let content = el.get("content").cloned();
                        s.resolve_elicitation(rid, el["action"].as_str().unwrap(), content)
                    };
                    assert!(answered, "{what}: not pending");
                    wait_step(s, step[3].as_str().unwrap(), before, &what).await;
                }
                "gate" => {
                    let s = session.as_ref().unwrap();
                    std::fs::write(format!("{cwd}/{}", step[1].as_str().unwrap()), "").unwrap();
                    wait_step(s, step[2].as_str().unwrap(), before, &what).await;
                }
                "broadcast" => session.as_ref().unwrap().broadcast(step[1].clone()),
                "rename" => session
                    .as_ref()
                    .unwrap()
                    .rename(step[1].as_str().unwrap())
                    .await
                    .unwrap(),
                "mute" => {
                    let patch = PrefsPatch {
                        blocked: step[1]["blocked"].as_bool(),
                        snooze_until: None,
                    };
                    ndb::set_session_prefs(&cwd, id, &patch).unwrap();
                }
                "end" => {
                    tabs.clear();
                    session.as_ref().unwrap().end().await;
                }
                other => panic!("unknown step {other}"),
            }
            // Trailing broadcasts (the status after a result), then the
            // session's queued bus calls, then the coalesced flushes.
            tokio::time::sleep(Duration::from_millis(150)).await;
            if let Some(s) = &session {
                s.notifications_settled().await;
            }
            tokio::time::sleep(Duration::from_millis(40)).await;

            let rows: Vec<Value> = read_rows(&cwd).iter().map(|r| norm.row(r)).collect();
            let mut envs = Vec::new();
            let mut state = Value::Null;
            while let Ok(ev) = bus.rx.try_recv() {
                match ev {
                    StreamEvent::Notification(row) => {
                        let n = row.to_json();
                        if n["workspaceId"] == ws_id.as_str() {
                            envs.push(
                                json!({"type": "notification", "notification": norm.env(&n)}),
                            );
                        }
                    }
                    StreamEvent::State(st) if st.workspace_id == ws_id => {
                        state =
                            json!({"totalUnread": st.total_unread, "perSession": st.per_session});
                    }
                    StreamEvent::State(_) => {}
                }
            }
            // As text: the key order (columns, the envelope, perSession) counts.
            let got = json!({"rows": rows, "envs": envs, "state": state}).to_string();
            let want = json!({"rows": rec["rows"], "envs": rec["envs"], "state": rec["state"]})
                .to_string();
            if got != want {
                failures.push(format!("{what}\n  got:  {got}\n  want: {want}"));
            }
        }
    }
    assert!(
        failures.is_empty(),
        "{} of the recorded steps differ:\n{}",
        failures.len(),
        failures.join("\n")
    );
}
