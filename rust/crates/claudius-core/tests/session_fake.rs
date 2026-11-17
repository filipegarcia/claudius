//! Session-level behaviour against the scripted fake CLI
//! (`claudius-agent/src/bin/fake_claude.rs`).

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, OnceLock};
use std::time::Duration;

use claudius_core::session::{
    PermissionDecision, PlanDecision, RuntimeOptions, SendOptions, Session, SessionOptions,
    Subscription, TodoItemAction, TodosClearReason, TurnStatus,
};
use claudius_core::session_manager::SessionManager;
use claudius_core::{paths, sessions_db};
use serde_json::{Value, json};

struct Env {
    _root: tempfile::TempDir,
    fake: PathBuf,
    config: PathBuf,
}

/// One isolated `$HOME` + config dir per test binary, and the fake CLI built.
fn env() -> &'static Env {
    static E: OnceLock<Env> = OnceLock::new();
    E.get_or_init(|| {
        let root = tempfile::tempdir().unwrap();
        let home = root.path().join("home");
        let config = root.path().join("config");
        std::fs::create_dir_all(&home).unwrap();
        std::fs::create_dir_all(&config).unwrap();
        assert!(paths::set_home_override(home));
        assert!(paths::set_config_dir_override(config.clone()));
        let target = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../target/debug/claudius-fake-claude");
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
        Env {
            _root: root,
            fake: target,
            config,
        }
    })
}

struct Fixture {
    mgr: Arc<SessionManager>,
    cwd: tempfile::TempDir,
    log: PathBuf,
    argv: PathBuf,
}

fn fixture() -> Fixture {
    fixture_with(&[])
}

/// A fixture whose fake CLI gets extra env (e.g. `FAKE_CLAUDE_SCRIPT`).
fn fixture_with(extra_env: &[(&str, String)]) -> Fixture {
    let e = env();
    let cwd = tempfile::tempdir().unwrap();
    let log = cwd.path().join("fake.log");
    let argv = cwd.path().join("fake.argv");
    let mut envmap: HashMap<String, String> = HashMap::new();
    envmap.insert("PATH".into(), std::env::var("PATH").unwrap_or_default());
    envmap.insert("FAKE_CLAUDE_LOG".into(), log.display().to_string());
    envmap.insert("FAKE_CLAUDE_ARGV".into(), argv.display().to_string());
    for (k, v) in extra_env {
        envmap.insert((*k).into(), v.clone());
    }
    let mgr = Arc::new(SessionManager::default());
    *mgr.runtime.lock().unwrap() = RuntimeOptions {
        claude_bin: Some(e.fake.clone()),
        env_override: Some(envmap),
    };
    Fixture {
        mgr,
        cwd,
        log,
        argv,
    }
}

impl Fixture {
    fn cwd(&self) -> String {
        self.cwd
            .path()
            .canonicalize()
            .unwrap()
            .display()
            .to_string()
    }
    async fn create(&self, extra: SessionOptions) -> Arc<Session> {
        let opts = SessionOptions {
            cwd: Some(self.cwd()),
            ..extra
        };
        self.mgr.create(opts).await.expect("create")
    }
    fn log(&self) -> Vec<Value> {
        std::fs::read_to_string(&self.log)
            .unwrap_or_default()
            .lines()
            .filter_map(|l| serde_json::from_str(l).ok())
            .collect()
    }
}

async fn next(sub: &mut Subscription) -> Value {
    tokio::time::timeout(Duration::from_secs(10), sub.recv())
        .await
        .expect("event timeout")
        .expect("stream closed")
}

/// Read until `pred` matches; returns everything seen (inclusive).
async fn until(sub: &mut Subscription, pred: impl Fn(&Value) -> bool) -> Vec<Value> {
    let mut seen = vec![];
    loop {
        let ev = next(sub).await;
        let done = pred(&ev);
        seen.push(ev);
        if done {
            return seen;
        }
    }
}

fn is(t: &'static str) -> impl Fn(&Value) -> bool {
    move |e| e["type"] == t
}

fn assistant_text(e: &Value) -> Option<&str> {
    (e["type"] == "sdk" && e["message"]["type"] == "assistant")
        .then(|| e["message"]["message"]["content"][0]["text"].as_str())
        .flatten()
}

fn types(evs: &[Value]) -> Vec<String> {
    evs.iter()
        .map(|e| e["type"].as_str().unwrap_or("").to_owned())
        .collect()
}

#[tokio::test]
async fn subscribe_order_and_echo_turn() {
    let f = fixture();
    let s = f.create(SessionOptions::default()).await;
    {
        // Let the CLI's system/init land first so the snapshot is deterministic.
        let mut pre = s.subscribe(None, None);
        until(&mut pre, |e| {
            e["type"] == "sdk" && e["message"]["subtype"] == "init"
        })
        .await;
    }
    let mut sub = s.subscribe(None, Some("tab-1".into()));
    let head = until(&mut sub, is("holder_changed")).await;
    let t = types(&head);
    // replay (ready + init from start) → replay_done → snapshot → ready → mode → model → turn → usage → tips → holder
    let rd = t.iter().position(|x| x == "replay_done").unwrap();
    assert_eq!(
        &t[rd..],
        &[
            "replay_done",
            "session_snapshot",
            "ready",
            "mode_changed",
            "model_changed",
            "turn_status",
            "usage_snapshot",
            "tips",
            "holder_changed"
        ],
        "{t:?}"
    );
    assert!(t[..rd].contains(&"ready".to_owned()));
    assert_eq!(head[rd + 3]["mode"], "default");
    assert_eq!(head[rd + 5]["status"], "idle");
    assert_eq!(head.last().unwrap()["holderId"], "tab-1");
    assert!(
        head[rd + 7]["tips"]
            .as_array()
            .is_some_and(|a| !a.is_empty())
    );

    s.send_input("hello", &[], SendOptions::default());
    let turn = until(&mut sub, |e| {
        e["type"] == "turn_status" && e["status"] == "idle"
    })
    .await;
    let user = turn
        .iter()
        .find(|e| e["type"] == "sdk" && e["message"]["type"] == "user")
        .unwrap();
    assert_eq!(user["message"]["message"]["content"], "hello");
    assert!(user["at"].is_i64());
    assert!(
        turn.iter()
            .any(|e| e["type"] == "turn_status" && e["status"] == "running")
    );
    assert_eq!(turn.iter().find_map(assistant_text), Some("echo:hello"));
    // usage folded from the result
    let usage = until(&mut sub, is("usage_snapshot")).await;
    assert_eq!(usage.last().unwrap()["usage"]["numTurns"], json!(1));
    // persisted
    let u = sessions_db::get_session_usage(&f.cwd(), &s.id).unwrap();
    assert_eq!(u.num_turns, 1.0);
    // a late subscriber anchors on the prompt and sees lastUserPrompt
    let mut late = s.subscribe(Some(1), None);
    let head = until(&mut late, is("session_snapshot")).await;
    assert_eq!(head.last().unwrap()["lastUserPrompt"]["text"], "hello");
    let first_sdk = head.iter().find(|e| e["type"] == "sdk").unwrap();
    assert_eq!(
        first_sdk["message"]["type"], "user",
        "tail window anchors on the latest prompt"
    );
    // argv carried the new session id
    let argv = std::fs::read_to_string(&f.argv).unwrap();
    assert!(argv.contains(&format!("--session-id={}", s.id)), "{argv}");
    f.mgr.remove(&s.id).await;
}

#[tokio::test]
async fn permission_prompt_round_trip_and_late_replay() {
    let f = fixture();
    let s = f.create(SessionOptions::default()).await;
    let mut sub = s.subscribe(None, None);
    until(&mut sub, is("tips")).await;
    s.send_input("tool:ls", &[], SendOptions::default());
    let evs = until(&mut sub, is("permission_request")).await;
    let req = evs.last().unwrap().clone();
    assert_eq!(req["toolName"], "Bash");
    assert_eq!(req["toolUseId"], "toolu_1");
    assert_eq!(
        req["suggestedRules"],
        json!([{"toolName": "Bash", "ruleContent": "ls:*"}])
    );
    let st = until(&mut sub, is("turn_status")).await;
    assert_eq!(st.last().unwrap()["status"], "needs_input");

    // A second tab gets the live pending prompt after replay_done, once.
    let mut late = s.subscribe(None, None);
    let head = until(&mut late, is("permission_request")).await;
    let rd = head
        .iter()
        .position(|e| e["type"] == "replay_done")
        .unwrap();
    assert_eq!(
        head.iter()
            .filter(|e| e["type"] == "permission_request")
            .count(),
        1
    );
    assert!(head.len() - 1 > rd);

    let rid = req["requestId"].as_str().unwrap();
    assert!(s.resolve_permission(rid, PermissionDecision::AllowAlwaysSession));
    assert!(
        !s.resolve_permission(rid, PermissionDecision::AllowOnce),
        "second resolve is a no-op"
    );
    let evs = until(&mut sub, |e| assistant_text(e).is_some()).await;
    assert!(
        evs.iter()
            .any(|e| e["type"] == "prompt_settled" && e["requestId"] == rid)
    );
    assert_eq!(
        evs.iter().find_map(assistant_text),
        Some("permission:allow")
    );
    // wire check: addRules narrowed to the CLI suggestion, destination session
    let resp = f
        .log()
        .into_iter()
        .find(|m| m["type"] == "control_response" && m["response"]["request_id"] == "cli_1")
        .expect("permission response logged");
    let r = &resp["response"]["response"];
    assert_eq!(r["behavior"], "allow");
    assert_eq!(r["toolUseID"], "toolu_1");
    assert_eq!(r["updatedInput"], json!({"command": "ls"}));
    assert_eq!(
        r["updatedPermissions"],
        json!([{"type": "addRules", "behavior": "allow", "rules": [{"toolName": "Bash", "ruleContent": "ls:*"}], "destination": "session"}])
    );
    f.mgr.remove(&s.id).await;
}

#[tokio::test]
async fn ask_and_plan_prompts() {
    let f = fixture();
    let s = f.create(SessionOptions::default()).await;
    let mut sub = s.subscribe(None, None);
    until(&mut sub, is("tips")).await;

    s.send_input("ask:me", &[], SendOptions::default());
    let ask = until(&mut sub, is("ask_user_question"))
        .await
        .pop()
        .unwrap();
    assert_eq!(ask["questions"][0]["question"], "Pick?");
    assert!(s.submit_ask_answer(ask["requestId"].as_str().unwrap(), &[json!({"label": "B"})]));
    let evs = until(&mut sub, |e| assistant_text(e).is_some()).await;
    assert_eq!(
        evs.iter().find_map(assistant_text),
        Some(r#"ask:allow:{"Pick?":"B"}"#)
    );
    until(&mut sub, |e| {
        e["type"] == "turn_status" && e["status"] == "idle"
    })
    .await;

    s.send_input("plan:go", &[], SendOptions::default());
    let plan = until(&mut sub, is("plan_approval_request"))
        .await
        .pop()
        .unwrap();
    assert_eq!(plan["plan"], "1. do it");
    assert!(s.resolve_plan(
        plan["requestId"].as_str().unwrap(),
        PlanDecision::Accept {
            edited_plan: Some("2. edited".into())
        }
    ));
    let evs = until(&mut sub, |e| assistant_text(e).is_some()).await;
    assert!(
        evs.iter()
            .any(|e| e["type"] == "mode_changed" && e["mode"] == "acceptEdits")
    );
    assert_eq!(
        evs.iter().find_map(assistant_text),
        Some(r#"plan:allow:"2. edited""#)
    );
    assert_eq!(s.permission_mode(), "acceptEdits");
    let state = sessions_db::get_session_state(&f.cwd(), &s.id);
    assert_eq!(state["priorPlan"], "2. edited");
    f.mgr.remove(&s.id).await;
}

#[tokio::test]
async fn queue_drains_after_turn_ends() {
    let f = fixture();
    let s = f.create(SessionOptions::default()).await;
    let mut sub = s.subscribe(None, None);
    until(&mut sub, is("tips")).await;
    s.send_input("tool:pwd", &[], SendOptions::default());
    let req = until(&mut sub, is("permission_request"))
        .await
        .pop()
        .unwrap();
    let uuid = s
        .enqueue_message(&json!("second"), None, None, false, false, false)
        .unwrap();
    let q = until(&mut sub, is("queue:updated")).await.pop().unwrap();
    assert_eq!(q["queue"][0]["uuid"], uuid);
    assert_eq!(s.queue_length(), 1);
    s.resolve_permission(
        req["requestId"].as_str().unwrap(),
        PermissionDecision::Deny { message: None },
    );
    let evs = until(&mut sub, |e| assistant_text(e) == Some("echo:second")).await;
    let denied = evs.iter().find_map(assistant_text).unwrap();
    assert_eq!(denied, "permission:deny");
    assert!(
        evs.iter()
            .any(|e| e["type"] == "queue:updated" && e["queue"] == json!([]))
    );
    assert_eq!(s.queue_length(), 0);
    f.mgr.remove(&s.id).await;
}

/// S29a: a `text` that isn't a string (the `input` route passes a posted
/// one beside images) throws where V8 does, at its first string method
/// (`trim` for a slash send, else the ultrathink scan's `toLowerCase`),
/// after the turn was marked running.
#[tokio::test]
async fn a_text_that_isnt_a_string_throws_once_the_turn_runs() {
    let f = fixture();
    let s = f.create(SessionOptions::default()).await;
    let mut sub = s.subscribe(None, None);
    until(&mut sub, is("tips")).await;
    let slash = SendOptions {
        slash: true,
        ..Default::default()
    };
    assert_eq!(
        s.send_input_value(&json!(5), None, slash),
        Err("TypeError: text.trim is not a function".into())
    );
    assert_eq!(s.status(), TurnStatus::Running);
    let imgs = json!([{"data": "QQ==", "mediaType": "image/png"}]);
    assert_eq!(
        s.send_input_value(&json!(["a"]), Some(&imgs), SendOptions::default()),
        Err("TypeError: text.toLowerCase is not a function".into())
    );
    f.mgr.remove(&s.id).await;
}

#[tokio::test]
async fn end_drains_pending_prompts() {
    let f = fixture();
    let s = f.create(SessionOptions::default()).await;
    let mut sub = s.subscribe(None, None);
    until(&mut sub, is("tips")).await;
    s.send_input("tool:sleep", &[], SendOptions::default());
    let req = until(&mut sub, is("permission_request"))
        .await
        .pop()
        .unwrap();
    let pid = s.query_handle().and_then(|h| h.pid()).expect("cli pid");
    assert!(process_alive(pid));
    f.mgr.remove(&s.id).await;
    // end() waits for the CLI to exit — never orphaned, even mid-turn.
    assert!(
        !process_alive(pid),
        "CLI {pid} still running after remove()"
    );
    let evs = until(&mut sub, is("prompt_settled")).await;
    assert_eq!(evs.last().unwrap()["requestId"], req["requestId"]);
    assert!(s.is_done());
    assert!(f.mgr.get(&s.id).is_none());
}

fn process_alive(pid: u32) -> bool {
    std::process::Command::new("kill")
        .args(["-0", &pid.to_string()])
        .stderr(std::process::Stdio::null())
        .status()
        .is_ok_and(|s| s.success())
}

#[tokio::test]
async fn mode_model_interrupt() {
    let f = fixture();
    let s = f
        .create(SessionOptions {
            permission_mode: Some("acceptEdits".into()),
            ..Default::default()
        })
        .await;
    let mut sub = s.subscribe(None, None);
    let head = until(&mut sub, is("tips")).await;
    assert!(
        head.iter()
            .any(|e| e["type"] == "mode_changed" && e["mode"] == "acceptEdits")
    );
    s.set_permission_mode("plan", false).await;
    let ev = until(&mut sub, is("mode_changed")).await.pop().unwrap();
    assert_eq!(ev["mode"], "plan");
    assert!(f.log().iter().any(
        |m| m["request"]["subtype"] == "set_permission_mode" && m["request"]["mode"] == "plan"
    ));
    assert_eq!(s.interrupt().await, Vec::<String>::new());
    let restricted = f
        .create(SessionOptions {
            permission_mode: Some("bypassPermissions".into()),
            restricted_mode: Some(true),
            ..Default::default()
        })
        .await;
    assert_eq!(restricted.permission_mode(), "default");
    f.mgr.remove(&s.id).await;
    f.mgr.remove(&restricted.id).await;
}

#[tokio::test]
async fn resume_replays_transcript_from_disk() {
    let f = fixture();
    let cwd = f.cwd();
    let id = "5b0e3a1c-2a52-4c3e-9b0e-2f7f1a1c0b11";
    let dir = env()
        .config
        .join("projects")
        .join(paths::sdk_project_dir_name(&cwd));
    std::fs::create_dir_all(&dir).unwrap();
    let lines = [
        json!({"type":"user","uuid":"u1","parentUuid":null,"sessionId":id,"cwd":cwd,"timestamp":"2026-01-02T03:04:05.000Z",
               "message":{"role":"user","content":"earlier question"}}),
        json!({"type":"assistant","uuid":"a1","parentUuid":"u1","sessionId":id,"cwd":cwd,"timestamp":"2026-01-02T03:04:06.000Z",
               "message":{"role":"assistant","id":"msg_1","content":[{"type":"text","text":"earlier answer"}]}}),
    ];
    let body: String = lines.iter().map(|l| format!("{l}\n")).collect();
    std::fs::write(dir.join(format!("{id}.jsonl")), body).unwrap();

    let s = f.mgr.get_or_resume(id).await.expect("resumed from disk");
    assert_eq!(s.id, id);
    assert_eq!(s.cwd, cwd);
    let mut sub = s.subscribe(None, None);
    let head = until(&mut sub, is("replay_done")).await;
    let sdk: Vec<&Value> = head
        .iter()
        .filter(|e| e["type"] == "sdk" && e["message"]["uuid"].is_string())
        .collect();
    assert_eq!(sdk[0]["message"]["uuid"], "u1");
    assert_eq!(sdk[0]["at"], json!(1767323045000i64));
    assert_eq!(sdk[1]["message"]["uuid"], "a1");
    until(&mut sub, |e| {
        e["type"] == "sdk" && e["message"]["subtype"] == "init"
    })
    .await;
    let argv = std::fs::read_to_string(&f.argv).unwrap();
    assert!(argv.contains(&format!("--resume={id}")), "{argv}");
    // Same id again → the live session, not a second spawn.
    let again = f.mgr.get_or_resume(id).await.unwrap();
    assert!(Arc::ptr_eq(&s, &again));
    f.mgr.remove(id).await;
}

/// S23: titles from the legacy `session-titles.json` and from other writers
/// reach live sessions. A fresh session takes its id's legacy title as
/// stored (untrimmed) and migrates it into the row at start; the first
/// subscriber's fresh-title check trims it, adopts and broadcasts it. A title
/// another writer put in the row moves the session on the next subscribe:
/// broadcast to every open stream and `upsert_session` (only `last_seen_at`
/// shows it; the row's title stays). An unchanged title is echoed to the
/// new subscriber after its replay. A resumed session's legacy title beats
/// the transcript's custom title, and is trimmed at start (a fresh one is
/// not). Nothing writes the legacy file.
#[tokio::test]
async fn legacy_and_foreign_titles_reach_live_sessions() {
    use claudius_core::db::{Mode, open_db};
    let f = fixture();
    let cwd = f.cwd();
    let fresh_id = "6c1d4b2e-3b63-4d4f-8c1f-3a8f2b2d1c22";
    let resumed_id = "7d2e5c3f-4c74-4e5a-9d2a-4b9a3c3e2d33";
    let legacy = sessions_db::legacy_titles_path();
    std::fs::create_dir_all(legacy.parent().unwrap()).unwrap();
    let store = json!({"version": 1, "titles": {
        fresh_id: "  Legacy fresh  ",
        resumed_id: "  Legacy resumed  ",
    }});
    let bytes = serde_json::to_vec_pretty(&store).unwrap();
    std::fs::write(&legacy, &bytes).unwrap();
    let row = |id: &str| -> (Option<String>, i64) {
        open_db(&cwd, Mode::ReadWrite)
            .unwrap()
            .with(|c| {
                c.query_row(
                    "SELECT title, last_seen_at FROM sessions WHERE id = ?",
                    [id],
                    |r| Ok((r.get(0)?, r.get(1)?)),
                )
            })
            .unwrap()
    };
    let title_is =
        |t: &'static str| move |e: &Value| e["type"] == "session_title" && e["title"] == t;

    let s = f
        .create(SessionOptions {
            id: Some(fresh_id.into()),
            ..Default::default()
        })
        .await;
    assert_eq!(s.title().as_deref(), Some("  Legacy fresh  "));
    assert_eq!(row(fresh_id).0.as_deref(), Some("  Legacy fresh  "));
    let mut first = s.subscribe(None, None);
    let seen = until(&mut first, title_is("Legacy fresh")).await;
    assert!(
        seen.iter().any(title_is("  Legacy fresh  ")),
        "start() broadcast the stored title first: {seen:?}"
    );
    assert_eq!(s.title().as_deref(), Some("Legacy fresh"));
    assert_eq!(row(fresh_id).0.as_deref(), Some("  Legacy fresh  "));

    // Another writer renames it in the row.
    sessions_db::set_session_title(&cwd, fresh_id, "Renamed elsewhere").unwrap();
    open_db(&cwd, Mode::ReadWrite)
        .unwrap()
        .with(|c| {
            c.execute(
                "UPDATE sessions SET last_seen_at = 0 WHERE id = ?",
                [fresh_id],
            )
        })
        .unwrap();
    let _second = s.subscribe(None, None);
    until(&mut first, title_is("Renamed elsewhere")).await;
    assert_eq!(s.title().as_deref(), Some("Renamed elsewhere"));
    let upserted = async {
        while row(fresh_id).1 == 0 {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    };
    tokio::time::timeout(Duration::from_secs(10), upserted)
        .await
        .expect("the moved title is upserted");
    assert_eq!(row(fresh_id).0.as_deref(), Some("Renamed elsewhere"));

    let mut third = s.subscribe(None, None);
    until(&mut third, is("replay_done")).await;
    until(&mut third, title_is("Renamed elsewhere")).await;
    f.mgr.remove(fresh_id).await;

    let dir = env()
        .config
        .join("projects")
        .join(paths::sdk_project_dir_name(&cwd));
    std::fs::create_dir_all(&dir).unwrap();
    let lines = [
        json!({"type":"user","uuid":"u1","parentUuid":null,"sessionId":resumed_id,"cwd":cwd,"timestamp":"2026-01-02T03:04:05.000Z",
               "message":{"role":"user","content":"earlier question"}}),
        json!({"type":"custom-title","customTitle":"Transcript title","sessionId":resumed_id}),
    ];
    let body: String = lines.iter().map(|l| format!("{l}\n")).collect();
    std::fs::write(dir.join(format!("{resumed_id}.jsonl")), body).unwrap();
    let r = f.mgr.get_or_resume(resumed_id).await.expect("resumed");
    assert_eq!(r.title().as_deref(), Some("Legacy resumed"));
    assert_eq!(row(resumed_id).0.as_deref(), Some("  Legacy resumed  "));
    f.mgr.remove(resumed_id).await;

    assert_eq!(
        std::fs::read(&legacy).unwrap(),
        bytes,
        "the legacy file was written"
    );
    std::fs::remove_file(&legacy).unwrap();
}

/// S23: `Session::rename` on the titles the real `Session.prototype.rename`
/// was recorded with (`fixtures/session_titles_golden.json`, `rename`): JS
/// `trim()`, "title required" for what it empties, and on success the
/// adopted title and its `session_title` broadcast.
#[tokio::test]
async fn rename_matches_the_recorded_ts() {
    let path =
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/session_titles_golden.json");
    let golden: Value = serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
    let cases = golden["rename"].as_array().unwrap();
    assert!(!cases.is_empty());
    let f = fixture();
    let id = "8e3f6d40-5d85-4f6b-8e3b-5cab4d4f3e44";
    // A stored title makes the first subscribe's fresh-title check an echo,
    // so it is over before the renames start.
    sessions_db::set_session_title(&f.cwd(), id, "Seeded").unwrap();
    let s = f
        .create(SessionOptions {
            id: Some(id.into()),
            ..Default::default()
        })
        .await;
    let mut sub = s.subscribe(None, None);
    until(&mut sub, is("replay_done")).await;
    until(&mut sub, is("session_title")).await;
    for c in cases {
        let title = c["title"].as_str().unwrap();
        let before = s.title();
        let got = match s.rename(title).await {
            Ok(()) => json!({"ok": true}),
            Err(e) => json!({"ok": false, "error": e}),
        };
        let stringify = claudius_agent::js::stringify;
        assert_eq!(stringify(&got), c["result"].as_str().unwrap(), "{title:?}");
        let recorded: Value = serde_json::from_str(c["broadcasts"].as_str().unwrap()).unwrap();
        if got["ok"] == true {
            assert_eq!(
                stringify(&json!(s.title())),
                c["after"].as_str().unwrap(),
                "{title:?}"
            );
            let ev = until(&mut sub, is("session_title")).await.pop().unwrap();
            assert_eq!(json!([ev]), recorded, "{title:?}");
        } else {
            assert_eq!(s.title(), before, "{title:?}");
            assert_eq!(recorded, json!([]), "{title:?}");
        }
    }
    f.mgr.remove(id).await;
    // CC 2.1.309 (R05): the recorder's bare session has no query and no
    // transcript, so a rename that lands leaves its name in the pending
    // mirror (and a refused one leaves none); a session that never started
    // is the same here.
    for c in cases {
        let title = c["title"].as_str().unwrap();
        let idle = Session::new(SessionOptions {
            cwd: Some(f.cwd()),
            ..Default::default()
        })
        .unwrap();
        let _ = idle.rename(title).await;
        assert_eq!(
            claudius_agent::js::stringify(&json!(idle.pending_title_mirror())),
            c["mirror"].as_str().unwrap(),
            "{title:?}: the pending mirror"
        );
    }
}

/// S02: the live `init` seeds the applied effort from `get_settings`;
/// `set_effort` applies (and, unless "auto" or session-only, saves) the pick
/// and reports what the CLI settled on; a model switch refreshes it; a new
/// subscriber gets the latest value right after `model_changed`, never from
/// the buffer; of two quick refreshes only the later reply lands.
#[tokio::test]
async fn effort_is_applied_refreshed_and_re_emitted() {
    let f = fixture();
    let s = f.create(SessionOptions::default()).await;
    let mut sub = s.subscribe(None, None);
    let seen = until(&mut sub, is("effort_applied")).await;
    assert!(
        seen.iter()
            .any(|e| e["type"] == "sdk" && e["message"]["subtype"] == "init"),
        "refreshed after init: {seen:?}"
    );
    // The fake CLI applies no effort until a flag sets one.
    assert_eq!(seen.last().unwrap()["effort"], Value::Null);

    let applied = async |sub: &mut Subscription| {
        until(sub, is("effort_applied")).await.last().unwrap()["effort"].clone()
    };
    s.set_effort("high", false, false).await;
    assert_eq!(applied(&mut sub).await, "high");
    s.set_effort("max", true, true).await;
    assert_eq!(applied(&mut sub).await, "max");
    s.set_effort("auto", false, false).await;
    assert_eq!(applied(&mut sub).await, Value::Null);
    let writes: Vec<Value> = f
        .log()
        .into_iter()
        .map(|m| m["request"].clone())
        .filter(|r| {
            matches!(
                r["subtype"].as_str(),
                Some("apply_flag_settings" | "update_settings")
            )
        })
        .collect();
    assert_eq!(
        writes,
        vec![
            json!({"subtype": "apply_flag_settings", "settings": {"effortLevel": "high"}}),
            json!({"subtype": "update_settings", "source": "userSettings", "settings": {"effortLevel": "high"}}),
            // Session-only: applied live, not saved.
            json!({"subtype": "apply_flag_settings", "settings": {"effortLevel": "max", "ultracode": true}}),
            // "auto" clears the override and can't be saved.
            json!({"subtype": "apply_flag_settings", "settings": {"effortLevel": null}}),
        ]
    );

    s.set_effort("low", false, true).await;
    assert_eq!(applied(&mut sub).await, "low");
    // Re-picking the level in force still reports it: the client clears its
    // mirror on a pick and waits for this event.
    s.set_effort("low", false, true).await;
    assert_eq!(applied(&mut sub).await, "low");
    let mut late = s.subscribe(None, None);
    let head = until(&mut late, is("turn_status")).await;
    let t = types(&head);
    let at = |name: &str| t.iter().position(|x| x == name).unwrap();
    assert_eq!(
        t.iter().filter(|x| *x == "effort_applied").count(),
        1,
        "{t:?}"
    );
    assert_eq!(at("effort_applied"), at("model_changed") + 1, "{t:?}");
    assert_eq!(at("turn_status"), at("effort_applied") + 1, "{t:?}");
    assert_eq!(head[at("effort_applied")]["effort"], "low");
    drop(late);

    // A model switch refreshes it.
    s.set_model(Some("other-model".into()), "picker")
        .await
        .unwrap();
    let after = until(&mut sub, is("effort_applied")).await;
    assert!(
        after.iter().any(|e| e["type"] == "model_changed"),
        "{after:?}"
    );

    // Two refreshes back to back: the first reply is stale by the time it
    // lands, so exactly one `effort_applied` follows.
    s.broadcast(json!({"type": "model_changed", "model": "a", "source": "sdk"}));
    s.broadcast(json!({"type": "model_changed", "model": "b", "source": "sdk"}));
    until(&mut sub, is("effort_applied")).await;
    let extra = tokio::time::timeout(
        Duration::from_millis(800),
        until(&mut sub, is("effort_applied")),
    )
    .await;
    assert!(extra.is_err(), "stale reply landed: {extra:?}");
    f.mgr.remove(&s.id).await;
}

/// S01: another client appending to the session's JSONL (`claude --resume
/// <id>` in a terminal) reaches subscribers through the watcher, once each,
/// stamped with the transcript's time; `end()` stops the watcher.
#[tokio::test]
async fn agent_switch_needs_a_live_query_but_not_a_successful_apply() {
    // No query yet: `setAgent` returns before touching anything.
    let idle = Session::new(SessionOptions {
        agent: Some("planner".into()),
        ..Default::default()
    })
    .unwrap();
    idle.set_agent(Some("code-reviewer")).await;
    assert_eq!(idle.agent().as_deref(), Some("planner"));

    // A refused apply is swallowed: the switch is still recorded and told.
    let script = json!({"control": {"apply_flag_settings": {"$error": "unknown agent"}}});
    let f = fixture_with(&[("FAKE_CLAUDE_SCRIPT", script.to_string())]);
    let s = f
        .create(SessionOptions {
            agent: Some("planner".into()),
            ..Default::default()
        })
        .await;
    let mut sub = s.subscribe(None, None);
    let ready = until(&mut sub, is("ready")).await.pop().unwrap();
    assert_eq!(ready["agent"], "planner");
    s.set_agent(Some("code-reviewer")).await;
    assert_eq!(s.agent().as_deref(), Some("code-reviewer"));
    let ev = until(&mut sub, is("agent_changed")).await.pop().unwrap();
    assert_eq!(
        ev,
        json!({"type": "agent_changed", "agent": "code-reviewer"})
    );
    assert!(
        f.log().iter().any(|m| m["request"]
            == json!({"subtype": "apply_flag_settings", "settings": {"agent": "code-reviewer"}})),
        "the apply was sent"
    );
    // The CLI answered a control request, so its argv is on disk.
    let argv: Vec<String> =
        serde_json::from_str(&std::fs::read_to_string(&f.argv).unwrap()).unwrap();
    assert!(argv.contains(&"--agent=planner".into()), "{argv:?}");
    f.mgr.remove(&s.id).await;

    // An empty name is kept but reads as no agent: not in either `ready`.
    let s = f
        .create(SessionOptions {
            agent: Some(String::new()),
            ..Default::default()
        })
        .await;
    assert_eq!(s.agent().as_deref(), Some(""));
    let mut sub = s.subscribe(None, None);
    let mut readies: Vec<Value> = until(&mut sub, is("replay_done"))
        .await
        .into_iter()
        .filter(|e| e["type"] == "ready")
        .collect();
    readies.push(until(&mut sub, is("ready")).await.pop().unwrap());
    assert_eq!(readies.len(), 2, "the start's and the route's: {readies:?}");
    assert!(
        readies.iter().all(|r| r.get("agent").is_none()),
        "{readies:?}"
    );
    f.mgr.remove(&s.id).await;
}

#[tokio::test]
async fn external_transcript_writes_reach_subscribers() {
    let f = fixture();
    let cwd = f.cwd();
    let id = "7c1d2e3f-4a5b-4c6d-8e9f-0a1b2c3d4e5f";
    // The CLI's project dir exists by the time a session starts in practice
    // (it holds every earlier transcript); a missing one means no watcher.
    let dir = env()
        .config
        .join("projects")
        .join(paths::sdk_project_dir_name(&cwd));
    std::fs::create_dir_all(&dir).unwrap();
    let s = f
        .create(SessionOptions {
            id: Some(id.into()),
            ..Default::default()
        })
        .await;
    assert_eq!(s.id, id);
    assert!(s.wait_jsonl_watcher().await);
    let mut sub = s.subscribe(None, None);
    until(&mut sub, |e| {
        e["type"] == "sdk" && e["message"]["subtype"] == "init"
    })
    .await;

    let file = dir.join(format!("{id}.jsonl"));
    let append = |lines: &[Value]| {
        use std::io::Write;
        let mut fh = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&file)
            .unwrap();
        for l in lines {
            writeln!(fh, "{l}").unwrap();
        }
    };
    let external = |e: &Value| {
        e["type"] == "sdk"
            && e["message"]["uuid"]
                .as_str()
                .is_some_and(|u| u.starts_with('x'))
    };
    append(&[
        json!({"type":"user","uuid":"x1","parentUuid":null,"sessionId":id,"cwd":cwd,"timestamp":"2026-03-04T05:06:07.000Z",
               "message":{"role":"user","content":"from the terminal"}}),
        json!({"type":"assistant","uuid":"x2","parentUuid":"x1","sessionId":id,"cwd":cwd,
               "message":{"role":"assistant","id":"msg_x2","content":[{"type":"text","text":"terminal answer"}]}}),
    ]);
    let first = until(&mut sub, |e| external(e) && e["message"]["uuid"] == "x2").await;
    let got: Vec<&Value> = first.iter().filter(|e| external(e)).collect();
    assert_eq!(got.len(), 2, "{got:?}");
    assert_eq!(got[0]["message"]["uuid"], "x1");
    assert_eq!(got[0]["at"], json!(1772600767000i64));
    // No timestamp: carried forward from its turn.
    assert_eq!(got[1]["at"], json!(1772600767001i64));

    // A later write adds only the new line.
    append(&[
        json!({"type":"user","uuid":"x3","parentUuid":"x2","sessionId":id,"cwd":cwd,
                    "timestamp":"2026-03-04T05:07:00.000Z","message":{"role":"user","content":"again"}}),
    ]);
    let second = until(&mut sub, external).await;
    assert_eq!(second.last().unwrap()["message"]["uuid"], "x3");
    // Nothing else from disk follows.
    let quiet = tokio::time::timeout(Duration::from_millis(800), async {
        loop {
            let e = next(&mut sub).await;
            if external(&e) {
                return e;
            }
        }
    })
    .await;
    assert!(quiet.is_err(), "re-broadcast: {quiet:?}");

    f.mgr.remove(id).await;
    assert!(!s.watching_jsonl(), "end() stops the watcher");

    // Ended while its watch was still starting: the late watch is dropped.
    let id2 = "5b0e3a1c-2a52-4c3e-9b0e-2f7f1a1c0b2a";
    let u = f
        .create(SessionOptions {
            id: Some(id2.into()),
            ..Default::default()
        })
        .await;
    f.mgr.remove(id2).await;
    assert!(
        !u.wait_jsonl_watcher().await,
        "a stopped session stays unwatched"
    );

    // No project dir yet: the session runs without a watcher.
    let g = fixture();
    let t = g.create(SessionOptions::default()).await;
    assert!(!t.wait_jsonl_watcher().await);
    g.mgr.remove(&t.id).await;
}

/// A resync reads the transcript as the SDK's `getSessionMessages` does:
/// the whole file, each line decoded lossily, so a byte of invalid UTF-8
/// reads as U+FFFD instead of failing the read (I14b: it added nothing).
#[tokio::test]
async fn a_resync_reads_a_transcript_holding_invalid_utf8() {
    let f = fixture();
    let cwd = f.cwd();
    // No project dir at start: no watcher races the resync below.
    let s = f.create(SessionOptions::default()).await;
    assert!(!s.wait_jsonl_watcher().await);
    let mut sub = s.subscribe(None, None);
    until(&mut sub, |e| {
        e["type"] == "sdk" && e["message"]["subtype"] == "init"
    })
    .await;
    let dir = env()
        .config
        .join("projects")
        .join(paths::sdk_project_dir_name(&cwd));
    std::fs::create_dir_all(&dir).unwrap();
    let id = s.id.clone();
    let lines = [
        json!({"type":"user","uuid":"y1","parentUuid":null,"sessionId":id,"cwd":cwd,"timestamp":"2026-03-04T05:06:07.000Z",
               "message":{"role":"user","content":"bad @ byte"}}),
        json!({"type":"assistant","uuid":"y2","parentUuid":"y1","sessionId":id,"cwd":cwd,"timestamp":"2026-03-04T05:06:08.000Z",
               "message":{"role":"assistant","id":"msg_y2","content":[{"type":"text","text":"ok"}]}}),
    ];
    let mut bytes: Vec<u8> = lines
        .iter()
        .map(|l| format!("{l}\n"))
        .collect::<String>()
        .into_bytes();
    let at = bytes.iter().position(|&b| b == b'@').unwrap();
    bytes[at] = 0xff;
    std::fs::write(dir.join(format!("{id}.jsonl")), bytes).unwrap();
    assert_eq!(s.resync_from_disk(), 2);
    let got = until(&mut sub, |e| {
        e["type"] == "sdk" && e["message"]["uuid"] == "y2"
    })
    .await;
    let user = got.iter().find(|e| e["message"]["uuid"] == "y1").unwrap();
    assert_eq!(user["message"]["message"]["content"], "bad \u{fffd} byte");
    f.mgr.remove(&id).await;
}

/// One assistant message carrying `blocks`.
fn assistant_blocks(blocks: Value) -> Value {
    json!({"type": "assistant", "message": {"role": "assistant", "content": blocks}})
}

/// One user message carrying tool results.
fn tool_results(blocks: Value) -> Value {
    json!({"type": "user", "message": {"role": "user", "content": blocks}})
}

fn tool_use(id: &str, name: &str, input: Value) -> Value {
    json!({"type": "tool_use", "id": id, "name": name, "input": input})
}

/// Send `text` and wait for the turn to settle.
async fn turn(s: &Session, sub: &mut Subscription, text: &str) -> Vec<Value> {
    s.send_input(text, &[], SendOptions::default());
    let mut evs = until(sub, |e| {
        e["type"] == "turn_status" && e["status"] == "running"
    })
    .await;
    evs.extend(until(sub, |e| e["type"] == "turn_status" && e["status"] == "idle").await);
    evs
}

/// The to-do list in a late subscriber's post-replay `session_snapshot`.
async fn snapshot_todos(s: &Session) -> Value {
    late_snapshot(s)
        .await
        .get("todos")
        .cloned()
        .unwrap_or(Value::Null)
}

#[tokio::test]
async fn task_tools_drive_the_todo_snapshot() {
    let bash = |n: usize| {
        assistant_blocks(Value::Array(
            (0..n)
                .map(|i| tool_use(&format!("toolu_bash{i}"), "Bash", json!({"command": "ls"})))
                .collect(),
        ))
    };
    // Control requests are served as they're read, while messages queue for
    // the consume loop: give it a moment to catch up first.
    let settle = json!({"$delay_ms": 150});
    let pre_tool_use = json!({"$control": {"subtype": "hook_callback", "callback_id": "$HOOK:PreToolUse",
        "input": {"hook_event_name": "PreToolUse", "tool_name": "Bash", "tool_input": {}}, "tool_use_id": "toolu_z"}});
    let context = json!({"$text": "$LAST:/hookSpecificOutput/additionalContext"});
    let script = json!({"turns": [
        {"match": "plan", "steps": [
            assistant_blocks(json!([
                tool_use("toolu_a", "TaskCreate", json!({"subject": "Write tests", "activeForm": "Writing tests"})),
                tool_use("toolu_b", "TaskCreate", json!({"subject": "Ship"})),
                // Open throughout, so no turn ends all-done (and cleared).
                tool_use("toolu_k", "TaskCreate", json!({"subject": "Keep"})),
            ])),
            tool_results(json!([
                {"type": "tool_result", "tool_use_id": "toolu_a", "content": "Task #1 created successfully: Write tests"},
                {"type": "tool_result", "tool_use_id": "toolu_b", "content": [{"type": "text", "text": "{\"task\":{\"id\":\"2\"}}"}]},
                {"type": "tool_result", "tool_use_id": "toolu_k", "content": "Task #3 created successfully: Keep"},
            ])),
            assistant_blocks(json!([
                tool_use("toolu_c", "TaskUpdate", json!({"taskId": "1", "status": "completed"})),
                tool_use("toolu_d", "TaskUpdate", json!({"taskId": "2", "subject": "Ship it"})),
            ])),
        ]},
        // (Match keys the `todos-current` reminder riding each prompt can't
        // contain: the fake CLI matches on the whole message.)
        {"match": "drop-one", "steps": [
            assistant_blocks(json!([
                tool_use("toolu_e", "TaskCreate", json!({"subject": "Doomed"})),
                tool_use("toolu_f", "TaskUpdate", json!({"taskId": "2", "status": "deleted"})),
            ])),
            tool_results(json!([
                {"type": "tool_result", "tool_use_id": "toolu_e", "is_error": true, "content": "boom"},
            ])),
        ]},
        {"match": "rebuild", "steps": [
            assistant_blocks(json!([tool_use("toolu_g", "TaskList", json!({}))])),
            tool_results(json!([
                {"type": "tool_result", "tool_use_id": "toolu_g", "content": "#1 [completed] Write tests\n#7 [pending] From the store"},
            ])),
        ]},
        // 11 tool uses: one short of the threshold, so nothing yet.
        {"match": "grind", "steps": [bash(11), settle, pre_tool_use, context]},
        // The 12th fires it once; 12 more in the same turn don't refire;
        // a TaskUpdate re-arms it.
        // `sendInput` restarts the count: one more tool use isn't 12.
        {"match": "again", "steps": [
            bash(1), settle, pre_tool_use, context,
            bash(11), settle, pre_tool_use, context,
            bash(12), settle, pre_tool_use, context,
            assistant_blocks(json!([tool_use("toolu_h", "TaskUpdate", json!({"taskId": "7", "status": "in_progress"}))])),
            bash(12), settle, pre_tool_use, context,
        ]},
    ]});
    let f = fixture_with(&[("FAKE_CLAUDE_SCRIPT", script.to_string())]);
    let s = f.create(SessionOptions::default()).await;
    let mut sub = s.subscribe(None, None);

    turn(&s, &mut sub, "plan").await;
    assert_eq!(
        snapshot_todos(&s).await,
        json!([
            {"id": "1", "content": "Write tests", "status": "completed", "activeForm": "Writing tests"},
            {"id": "2", "content": "Ship it", "status": "pending"},
            {"id": "3", "content": "Keep", "status": "pending"},
        ])
    );
    turn(&s, &mut sub, "drop-one").await;
    assert_eq!(
        snapshot_todos(&s).await,
        json!([
            {"id": "1", "content": "Write tests", "status": "completed", "activeForm": "Writing tests"},
            {"id": "3", "content": "Keep", "status": "pending"},
        ]),
        "a failed TaskCreate leaves no entry; a deleted id goes"
    );
    turn(&s, &mut sub, "rebuild").await;
    let rebuilt = json!([
        {"id": "1", "content": "Write tests", "status": "completed"},
        {"id": "7", "content": "From the store", "status": "pending"},
    ]);
    assert_eq!(
        snapshot_todos(&s).await,
        rebuilt,
        "TaskList is the SDK's truth"
    );

    let texts = |evs: &[Value]| -> Vec<String> {
        evs.iter()
            .filter_map(assistant_text)
            .map(str::to_owned)
            .collect()
    };
    let body = format!(
        "<system-reminder>\n{}\n</system-reminder>\n\n",
        claudius_core::todos::todos_mid_turn_reminder_body(rebuilt.as_array().unwrap())
    );
    let grind = texts(&turn(&s, &mut sub, "grind").await);
    assert_eq!(grind[0], "null", "11 tool uses stay quiet: {grind:?}");
    let again = texts(&turn(&s, &mut sub, "again").await);
    assert_eq!(again[0], "null", "the count restarts per turn");
    let again = &again[1..];
    assert_eq!(again[0], body);
    assert_eq!(again[1], "null", "once per turn");
    let mut rearmed = rebuilt.clone();
    rearmed[1]["status"] = json!("in_progress");
    assert_eq!(
        again[2],
        format!(
            "<system-reminder>\n{}\n</system-reminder>\n\n",
            claudius_core::todos::todos_mid_turn_reminder_body(rearmed.as_array().unwrap())
        ),
        "a todo touch re-arms it"
    );
    f.mgr.remove(&s.id).await;
}

/// Turns `prefix i` for `i` in `range` over a list that keeps moving: after
/// every third the user completes the next of `ids`. That's progress (so
/// the turn-end no-progress clear never takes the list) without a TodoWrite
/// (so the stale-TodoWrite count keeps climbing).
async fn moving_turns(
    s: &Session,
    sub: &mut Subscription,
    prefix: &str,
    range: std::ops::RangeInclusive<usize>,
    ids: &mut impl Iterator<Item = String>,
) {
    for i in range {
        turn(s, sub, &format!("{prefix} {i}")).await;
        if i % 3 == 0 {
            let id = ids.next().unwrap();
            s.update_todo_item(&id, TodoItemAction::Complete).unwrap();
        }
    }
}

/// `n` pending items with ids `"1"`..`"n"`.
fn numbered_todos(n: usize) -> Value {
    (1..=n)
        .map(|i| json!({"id": i.to_string(), "content": format!("step {i}"), "status": "pending", "activeForm": "Stepping"}))
        .collect()
}

#[tokio::test]
async fn stale_todowrite_nudge_rides_every_fifteenth_silent_turn() {
    let todos = numbered_todos(7);
    let script = json!({"turns": [
        {"match": "write", "steps": [
            assistant_blocks(json!([tool_use("toolu_w", "TodoWrite", json!({"todos": todos}))])),
        ]},
        {"match": "empty", "steps": [
            assistant_blocks(json!([tool_use("toolu_e", "TodoWrite", json!({"todos": []}))])),
        ]},
    ]});
    let f = fixture_with(&[("FAKE_CLAUDE_SCRIPT", script.to_string())]);
    let s = f.create(SessionOptions::default()).await;
    let mut sub = s.subscribe(None, None);
    // The TodoWrite turn resets the counter its own prompt bumped.
    turn(&s, &mut sub, "write").await;
    // The 15th silent turn carries it and rearms the count, so the 16th
    // doesn't.
    let mut ids = (1..=7).map(|i| i.to_string());
    moving_turns(&s, &mut sub, "silent", 1..=16, &mut ids).await;
    // An empty list is nothing to nudge about.
    turn(&s, &mut sub, "empty").await;
    for i in 17..=31 {
        turn(&s, &mut sub, &format!("silent {i}")).await;
    }
    // The body lists the todos as they stood: 1-4 completed by then.
    let mut then = todos.as_array().unwrap().clone();
    for t in &mut then[..4] {
        t["status"] = json!("completed");
    }
    let nudge = claudius_core::todos::stale_todo_reminder_body(&then);
    let sent: Vec<(String, bool)> = f
        .log()
        .into_iter()
        .filter(|m| m["type"] == "user")
        .filter_map(|m| m["message"]["content"].as_str().map(str::to_owned))
        .map(|c| {
            let prompt = c.rsplit("\n\n").next().unwrap().to_owned();
            (
                prompt,
                c.contains("The TodoWrite tool hasn't been used recently."),
            )
        })
        .collect();
    let nudged: Vec<&str> = sent
        .iter()
        .filter(|(_, n)| *n)
        .map(|(p, _)| p.as_str())
        .collect();
    assert_eq!(nudged, vec!["silent 15"], "{sent:?}");
    let fifteenth = f
        .log()
        .into_iter()
        .filter_map(|m| m["message"]["content"].as_str().map(str::to_owned))
        .find(|c| c.ends_with("silent 15"))
        .unwrap();
    assert!(fifteenth.contains(&nudge), "the body lists the todos");
    f.mgr.remove(&s.id).await;
}

/// A late subscriber's post-replay `session_snapshot` (buffered ones, e.g.
/// a clear's empty list, replay before it).
async fn late_snapshot(s: &Session) -> Value {
    let mut late = s.subscribe(None, None);
    until(&mut late, is("replay_done")).await;
    until(&mut late, is("session_snapshot"))
        .await
        .pop()
        .unwrap()
}

#[tokio::test]
async fn clear_todos_persists_and_paints_empty() {
    let todos = json!([{"content": "a", "status": "pending"}]);
    let script = json!({"turns": [{"match": "write", "repeat": true, "steps": [
        assistant_blocks(json!([tool_use("toolu_w", "TodoWrite", json!({"todos": todos}))])),
    ]}]});
    let f = fixture_with(&[("FAKE_CLAUDE_SCRIPT", script.to_string())]);
    let s = f.create(SessionOptions::default()).await;
    let mut sub = s.subscribe(None, None);
    // (With `init` in, a snapshot is always sent.)
    until(&mut sub, |e| {
        e["type"] == "sdk" && e["message"]["subtype"] == "init"
    })
    .await;
    // No to-do activity yet: the snapshot leaves `todos` out entirely.
    assert!(late_snapshot(&s).await.get("todos").is_none());
    // A clear is activity: from then on the empty list is explicit.
    s.clear_todos(TodosClearReason::Manual);
    until(&mut sub, is("session_snapshot")).await;
    assert_eq!(late_snapshot(&s).await["todos"], json!([]));

    turn(&s, &mut sub, "write").await;
    assert_eq!(snapshot_todos(&s).await, todos);
    let before = claudius_core::now_ms();
    s.clear_todos(TodosClearReason::Manual);
    let ev = until(&mut sub, is("session_snapshot")).await.pop().unwrap();
    assert_eq!(
        ev,
        json!({"type": "session_snapshot", "todos": [], "todosStale": false})
    );
    // After a clear, the empty list is explicit.
    let snap = late_snapshot(&s).await;
    assert_eq!(
        (snap["todos"].clone(), snap["todosStale"].clone()),
        (json!([]), json!(false))
    );
    let cleared_at = sessions_db::get_session_state(&s.cwd, &s.id)["todosClearedAt"]
        .as_i64()
        .unwrap();
    assert!(cleared_at >= before);

    // Already empty: still broadcast (a client may show a rebuilt list),
    // but an automatic clear of nothing isn't announced.
    s.clear_todos(TodosClearReason::Stale);
    until(&mut sub, is("session_snapshot")).await;
    // A later write lands after the cutoff; an automatic clear of it is.
    turn(&s, &mut sub, "write").await;
    assert_eq!(snapshot_todos(&s).await, todos);
    s.clear_todos(TodosClearReason::Completed);
    let evs = until(&mut sub, is("todos_auto_cleared")).await;
    assert_eq!(
        evs.last().unwrap(),
        &json!({"type": "todos_auto_cleared", "reason": "completed", "count": 1})
    );
    let announced = s
        .buffer_snapshot()
        .iter()
        .filter(|e| e["type"] == "todos_auto_cleared")
        .count();
    assert_eq!(announced, 1, "manual and empty clears stay quiet");
    f.mgr.remove(&s.id).await;
}

/// The prompts (after any reminders) whose message carried the
/// stale-TodoWrite nudge.
fn nudged_prompts(f: &Fixture) -> Vec<String> {
    f.log()
        .into_iter()
        .filter(|m| m["type"] == "user")
        .filter_map(|m| m["message"]["content"].as_str().map(str::to_owned))
        .filter(|c| c.contains("The TodoWrite tool hasn't been used recently."))
        .map(|c| c.rsplit("\n\n").next().unwrap().to_owned())
        .collect()
}

#[tokio::test]
async fn a_clear_rearms_the_stale_todowrite_nudge() {
    let creates: Vec<Value> = (0..6)
        .map(|i| {
            tool_use(
                &format!("toolu_c{i}"),
                "TaskCreate",
                json!({"subject": format!("b{i}")}),
            )
        })
        .collect();
    let script = json!({"turns": [
        {"match": "write", "steps": [
            assistant_blocks(json!([tool_use("toolu_w", "TodoWrite", json!({"todos": numbered_todos(7)}))])),
        ]},
        // A TaskCreate rebuilds a list without restarting the count.
        {"match": "create", "steps": [assistant_blocks(Value::Array(creates))]},
    ]});
    let f = fixture_with(&[("FAKE_CLAUDE_SCRIPT", script.to_string())]);
    let s = f.create(SessionOptions::default()).await;
    let mut sub = s.subscribe(None, None);
    turn(&s, &mut sub, "write").await;
    let mut ids = (1..=7).map(|i| i.to_string());
    moving_turns(&s, &mut sub, "before", 1..=10, &mut ids).await;
    s.clear_todos(TodosClearReason::Manual);
    turn(&s, &mut sub, "create").await;
    assert_eq!(snapshot_todos(&s).await.as_array().unwrap().len(), 6);
    // The count restarted at the clear: "create" is turn 1, so the 15th
    // is "after 14", not "after 4".
    let mut ids = (0..6).map(|i| format!("toolu_c{i}"));
    moving_turns(&s, &mut sub, "after", 1..=14, &mut ids).await;
    assert_eq!(nudged_prompts(&f), vec!["after 14"]);
    f.mgr.remove(&s.id).await;
}

// ─────────────────────── linter-modified-file (S21) ───────────────────────

/// The CLI's `PostToolUse` hook callback after a file tool ran.
fn post_tool_use(tool: &str, input: Value) -> Value {
    json!({"$control": {"subtype": "hook_callback", "callback_id": "$HOOK:PostToolUse",
        "input": {"hook_event_name": "PostToolUse", "tool_name": tool, "tool_input": input, "tool_response": {}},
        "tool_use_id": "toolu_w"}})
}

/// The `linter-modified-file` block for `paths`.
fn linter_block(paths: &[&str]) -> String {
    claudius_core::session::wrap_reminder(
        &claudius_core::reminders::linter_modified_reminder_body(paths).unwrap(),
    )
}

/// Every user message the CLI got, in order.
fn user_contents(f: &Fixture) -> Vec<String> {
    f.log()
        .into_iter()
        .filter(|m| m["type"] == "user")
        .filter_map(|m| m["message"]["content"].as_str().map(str::to_owned))
        .collect()
}

/// A directory for the edited files, outside the session's cwd (the
/// script naming them exists before the fixture does).
fn edited_dir() -> (tempfile::TempDir, String) {
    let d = tempfile::tempdir().unwrap();
    let p = d.path().canonicalize().unwrap().display().to_string();
    (d, p)
}

#[tokio::test]
async fn a_file_rewritten_after_an_edit_rides_the_next_prompt_once() {
    let (_d, dir) = edited_dir();
    let a = format!("{dir}/a.ts");
    std::fs::write(&a, "let x = 1").unwrap();
    let script = json!({"turns": [
        {"match": "edit", "steps": [post_tool_use("Edit", json!({"file_path": a, "old_string": "1", "new_string": "2"}))]},
        {"match": "write", "steps": [post_tool_use("Write", json!({"file_path": a, "content": "let x = 3"}))]},
    ]});
    let f = fixture_with(&[("FAKE_CLAUDE_SCRIPT", script.to_string())]);
    let s = f.create(SessionOptions::default()).await;
    let mut sub = s.subscribe(None, None);
    turn(&s, &mut sub, "edit").await;
    // A formatter rewrote it after the edit: the next prompt says so.
    std::fs::write(&a, "let x = 1;\n").unwrap();
    turn(&s, &mut sub, "next 1").await;
    // Once: the flush cleared the snapshot, so a later change isn't news.
    std::fs::write(&a, "let x = 2;\n").unwrap();
    turn(&s, &mut sub, "next 2").await;
    // A write left as it was (the same bytes written again) is no change.
    turn(&s, &mut sub, "write").await;
    std::fs::write(&a, "let x = 2;\n").unwrap();
    turn(&s, &mut sub, "next 3").await;
    assert_eq!(
        user_contents(&f),
        [
            "edit".to_owned(),
            format!("{}next 1", linter_block(&[&a])),
            "next 2".to_owned(),
            "write".to_owned(),
            "next 3".to_owned(),
        ]
    );
    // The hook never blocks the tool.
    let replies: Vec<Value> = f
        .log()
        .into_iter()
        .filter(|m| m["type"] == "control_response")
        .map(|m| m["response"]["response"].clone())
        .collect();
    assert_eq!(
        replies,
        [json!({"continue": true}), json!({"continue": true})]
    );
    f.mgr.remove(&s.id).await;
}

#[tokio::test]
async fn deleted_files_are_skipped_and_paths_keep_their_first_write_order() {
    let (_d, dir) = edited_dir();
    let [a, b, c, d] = ["a.ts", "b.ts", "c.ipynb", "d.ts"].map(|n| format!("{dir}/{n}"));
    for p in [&a, &b, &c, &d] {
        std::fs::write(p, "v1").unwrap();
    }
    let script = json!({"turns": [{"match": "edits", "steps": [
        post_tool_use("Edit", json!({"file_path": a})),
        post_tool_use("MultiEdit", json!({"file_path": b, "edits": []})),
        post_tool_use("NotebookEdit", json!({"notebook_path": c})),
        post_tool_use("Edit", json!({"file_path": d})),
        // `a` written again: its new hash, but its first place.
        {"$fs": ["write", a, "v2"]},
        post_tool_use("Write", json!({"file_path": a})),
        // Not a file write.
        post_tool_use("Read", json!({"file_path": d})),
    ]}]});
    let f = fixture_with(&[("FAKE_CLAUDE_SCRIPT", script.to_string())]);
    let s = f.create(SessionOptions::default()).await;
    let mut sub = s.subscribe(None, None);
    turn(&s, &mut sub, "edits").await;
    std::fs::remove_file(&b).unwrap();
    for p in [&d, &c, &a] {
        std::fs::write(p, "v3").unwrap();
    }
    turn(&s, &mut sub, "next").await;
    assert_eq!(
        user_contents(&f).last().unwrap(),
        &format!("{}next", linter_block(&[&a, &c, &d]))
    );
    f.mgr.remove(&s.id).await;
}

/// TS queues the turn-end `todos-current` reminder before it serves anything
/// else, so a prompt sent the moment the turn goes idle carries it. Here the
/// session's lock ends the turn and queues it in one go (worker threads, so
/// the prompt really races the rest of the result handling).
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_prompt_sent_on_the_idle_carries_the_turn_end_list() {
    let script = json!({"turns": [{"match": "write", "steps": [
        assistant_blocks(json!([tool_use("toolu_w", "TodoWrite", json!({"todos": numbered_todos(8)}))])),
    ]}]});
    let f = fixture_with(&[("FAKE_CLAUDE_SCRIPT", script.to_string())]);
    let s = f.create(SessionOptions::default()).await;
    let mut sub = s.subscribe(None, None);
    turn(&s, &mut sub, "write").await;
    for i in 0..12 {
        s.send_input(&format!("quick {i}"), &[], SendOptions::default());
        until(&mut sub, |e| {
            e["type"] == "turn_status" && e["status"] == "running"
        })
        .await;
        until(&mut sub, |e| {
            e["type"] == "turn_status" && e["status"] == "idle"
        })
        .await;
        // Progress now and then, so the no-progress clear never takes it.
        if i % 2 == 1 {
            s.update_todo_item(&(i / 2 + 1).to_string(), TodoItemAction::Complete)
                .unwrap();
        }
    }
    let carried: Vec<bool> = user_contents(&f)
        .iter()
        .skip(1)
        .map(|c| c.contains("The current to-do list for this session is shown below."))
        .collect();
    assert_eq!(carried, [true; 12]);
    f.mgr.remove(&s.id).await;
}

/// A live session whose transcript directory exists (so the JSONL watcher
/// runs), subscribed past `init`; plus its transcript path.
async fn watched_session(f: &Fixture, id: &str) -> (Arc<Session>, Subscription, PathBuf) {
    let dir = env()
        .config
        .join("projects")
        .join(paths::sdk_project_dir_name(&f.cwd()));
    std::fs::create_dir_all(&dir).unwrap();
    let s = f
        .create(SessionOptions {
            id: Some(id.into()),
            ..Default::default()
        })
        .await;
    assert!(s.wait_jsonl_watcher().await);
    let mut sub = s.subscribe(None, None);
    until(&mut sub, |e| {
        e["type"] == "sdk" && e["message"]["subtype"] == "init"
    })
    .await;
    (s, sub, dir.join(format!("{id}.jsonl")))
}

/// Another client's TodoWrite of `todos` stamped `at_ms`, appended to the
/// transcript and read back off the stream.
async fn external_todo_write(
    s: &Session,
    sub: &mut Subscription,
    file: &Path,
    uuid: &str,
    todos: &Value,
    at_ms: i64,
) {
    use std::io::Write;
    let ts = chrono::DateTime::from_timestamp_millis(at_ms)
        .unwrap()
        .to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
    let line = json!({"type": "assistant", "uuid": uuid, "parentUuid": null, "sessionId": s.id, "cwd": s.cwd,
        "timestamp": ts, "message": {"role": "assistant", "id": format!("msg_{uuid}"), "content": [
            {"type": "tool_use", "id": format!("toolu_{uuid}"), "name": "TodoWrite", "input": {"todos": todos}}]}});
    let mut fh = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(file)
        .unwrap();
    writeln!(fh, "{line}").unwrap();
    until(sub, |e| e["type"] == "sdk" && e["message"]["uuid"] == uuid).await;
}

#[tokio::test]
async fn a_clear_bounces_older_transcript_writes() {
    let f = fixture();
    let id = "5e6f7a8b-9c0d-4e1f-8a2b-3c4d5e6f7a8b";
    let (s, mut sub, file) = watched_session(&f, id).await;
    let now = claudius_core::now_ms();
    let list = |content: &str| json!([{"content": content, "status": "pending"}]);
    external_todo_write(&s, &mut sub, &file, "x1", &list("old"), now - 60_000).await;
    assert_eq!(snapshot_todos(&s).await, list("old"));
    s.clear_todos(TodosClearReason::Manual);
    // Written before the clear but read after it: bounced.
    external_todo_write(&s, &mut sub, &file, "x2", &list("racing"), now - 30_000).await;
    assert_eq!(snapshot_todos(&s).await, json!([]));
    // Written after it: kept.
    let later = claudius_core::now_ms() + 1000;
    external_todo_write(&s, &mut sub, &file, "x3", &list("new"), later).await;
    assert_eq!(snapshot_todos(&s).await, list("new"));
    f.mgr.remove(id).await;
}

/// A transcript whose one assistant turn writes `todos` at `at_ms`.
fn todo_transcript(f: &Fixture, id: &str, todos: &Value, at_ms: i64) {
    let cwd = f.cwd();
    let dir = env()
        .config
        .join("projects")
        .join(paths::sdk_project_dir_name(&cwd));
    std::fs::create_dir_all(&dir).unwrap();
    let ts = |ms: i64| {
        chrono::DateTime::from_timestamp_millis(ms)
            .unwrap()
            .to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
    };
    let lines = [
        json!({"type": "user", "uuid": format!("{id}-u"), "parentUuid": null, "sessionId": id, "cwd": cwd,
               "timestamp": ts(at_ms - 1000), "message": {"role": "user", "content": "plan it"}}),
        json!({"type": "assistant", "uuid": format!("{id}-a"), "parentUuid": format!("{id}-u"), "sessionId": id,
               "cwd": cwd, "timestamp": ts(at_ms),
               "message": {"role": "assistant", "id": format!("msg_{id}"), "content": [
                   {"type": "tool_use", "id": format!("toolu_{id}"), "name": "TodoWrite", "input": {"todos": todos}}]}}),
    ];
    let body: String = lines.iter().map(|l| format!("{l}\n")).collect();
    std::fs::write(dir.join(format!("{id}.jsonl")), body).unwrap();
}

#[tokio::test]
async fn turn_ends_keep_the_list_in_view_then_flag_and_clear_it() {
    let two = |a: &str| json!([{"id": "a", "content": "a", "status": a}, {"id": "b", "content": "b", "status": "pending"}]);
    let all_done = json!([{"id": "a", "content": "a", "status": "completed"},
                          {"id": "b", "content": "b", "status": "completed"}]);
    let write = |m: &str, todos: Value| {
        json!({"match": m, "repeat": true, "steps": [
            assistant_blocks(json!([tool_use(&format!("toolu_{}", m.len()), "TodoWrite", json!({"todos": todos}))]))]})
    };
    // (Match keys the `todos-current` reminder riding the prompt can't
    // contain: the fake CLI matches on the whole message.)
    let script = json!({"turns": [
        write("plan", two("pending")),
        write("finish a", two("completed")),
        write("all done", all_done.clone()),
        {"match": "fail", "steps": [], "result": {"subtype": "error_during_execution", "is_error": true}},
        {"match": "rebuild", "steps": [
            assistant_blocks(json!([tool_use("toolu_l", "TaskList", json!({}))])),
            tool_results(json!([{"type": "tool_result", "tool_use_id": "toolu_l",
                "content": "#a [completed] a\n#b [completed] b"}])),
        ]},
    ]});
    let f = fixture_with(&[("FAKE_CLAUDE_SCRIPT", script.to_string())]);
    let s = f.create(SessionOptions::default()).await;
    let mut sub = s.subscribe(None, None);
    let stale = async |s: &Session| late_snapshot(s).await["todosStale"].clone();
    let auto_cleared = |s: &Session| -> Vec<(Value, Value)> {
        s.buffer_snapshot()
            .into_iter()
            .filter(|e| e["type"] == "todos_auto_cleared")
            .map(|e| (e["reason"].clone(), e["count"].clone()))
            .collect()
    };

    // plan, s1, s2 end without progress (the failed turn doesn't count):
    // flagged at the third.
    for p in ["plan", "s1", "fail"] {
        turn(&s, &mut sub, p).await;
    }
    assert_eq!(stale(&s).await, json!(false));
    turn(&s, &mut sub, "s2").await;
    let snap = late_snapshot(&s).await;
    assert_eq!(
        (snap["todos"].clone(), snap["todosStale"].clone()),
        (two("pending"), json!(true))
    );
    // An edit that isn't progress repaints with the flag still up.
    s.update_todo_item("b", TodoItemAction::InProgress).unwrap();
    let ev = until(&mut sub, |e| {
        e["type"] == "session_snapshot" && e["todos"][1]["status"] == "in_progress"
    })
    .await
    .pop()
    .unwrap();
    assert_eq!(ev["todosStale"], json!(true));
    // Progress un-stales it.
    turn(&s, &mut sub, "finish a").await;
    assert_eq!(stale(&s).await, json!(false));
    // Flagged again at three quiet turns, cleared at six.
    for i in 1..=5 {
        turn(&s, &mut sub, &format!("silent {i}")).await;
    }
    assert_eq!(stale(&s).await, json!(true));
    turn(&s, &mut sub, "silent 6").await;
    assert_eq!(snapshot_todos(&s).await, json!([]));
    assert_eq!(auto_cleared(&s), [(json!("stale"), json!(2))]);
    // The clear restarted the count and the flag: a new list starts over.
    turn(&s, &mut sub, "plan").await;
    turn(&s, &mut sub, "s3").await;
    let snap = late_snapshot(&s).await;
    assert_eq!(
        (snap["todos"].clone(), snap["todosStale"].clone()),
        (two("pending"), json!(false))
    );
    // An all-done list clears at turn end, except in the turn a TaskList
    // rebuilt it (shown once, then cleared).
    turn(&s, &mut sub, "all done").await;
    assert_eq!(snapshot_todos(&s).await, json!([]));
    turn(&s, &mut sub, "rebuild").await;
    assert_eq!(snapshot_todos(&s).await, all_done);
    turn(&s, &mut sub, "s4").await;
    assert_eq!(snapshot_todos(&s).await, json!([]));
    assert_eq!(
        auto_cleared(&s),
        [
            (json!("stale"), json!(2)),
            (json!("completed"), json!(2)),
            (json!("completed"), json!(2)),
        ]
    );

    // The `todos-current` reminder rode the prompt after every successful
    // turn that ended with open items.
    let prompts: Vec<String> = f
        .log()
        .into_iter()
        .filter(|m| m["type"] == "user")
        .filter_map(|m| m["message"]["content"].as_str().map(str::to_owned))
        .collect();
    let carried: Vec<&str> = prompts
        .iter()
        .filter(|c| c.contains("The current to-do list for this session is shown below."))
        .map(|c| c.rsplit("\n\n").next().unwrap())
        .collect();
    assert_eq!(
        carried,
        [
            "s1", "fail", "finish a", "silent 1", "silent 2", "silent 3", "silent 4", "silent 5",
            "silent 6", "s3", "all done"
        ]
    );
    let s1 = prompts.iter().find(|c| c.ends_with("s1")).unwrap();
    let body =
        claudius_core::todos::todos_current_reminder_body(two("pending").as_array().unwrap());
    assert!(s1.contains(&body), "{s1}");
    f.mgr.remove(&s.id).await;
}

/// The persisted `manualTodoOverrides`, keys in stored order.
fn stored_overrides(s: &Session) -> Vec<(String, Value)> {
    match sessions_db::get_session_state(&s.cwd, &s.id).get("manualTodoOverrides") {
        Some(Value::Object(o)) => o.iter().map(|(k, v)| (k.clone(), v.clone())).collect(),
        other => panic!("no overrides stored: {other:?}"),
    }
}

fn pairs(list: &[(&str, &str)]) -> Vec<(String, Value)> {
    list.iter()
        .map(|(k, v)| ((*k).to_owned(), json!(v)))
        .collect()
}

#[tokio::test]
async fn user_edits_stick_until_the_model_touches_them() {
    let item = |id: &str, status: &str| json!({"id": id, "content": format!("item {id}"), "status": status});
    let script = json!({"turns": [
        {"match": "plan", "steps": [assistant_blocks(json!([tool_use("toolu_p", "TodoWrite", json!({"todos": [
            item("1", "pending"), item("2", "pending"), item("10", "pending")]}))]))]},
        {"match": "touch", "steps": [assistant_blocks(json!([tool_use("toolu_u", "TaskUpdate",
            json!({"taskId": "1", "status": "in_progress"}))]))]},
        {"match": "list", "steps": [
            assistant_blocks(json!([tool_use("toolu_l", "TaskList", json!({}))])),
            tool_results(json!([{"type": "tool_result", "tool_use_id": "toolu_l",
                "content": "#1 [pending] item 1\n#2 [pending] item 2\n#10 [pending] item 10"}])),
        ]},
        // A pause between the tool use and its result, for a click.
        {"match": "create", "steps": [
            assistant_blocks(json!([tool_use("toolu_c", "TaskCreate", json!({"subject": "new"}))])),
            {"$delay_ms": 400},
            tool_results(json!([{"type": "tool_result", "tool_use_id": "toolu_c",
                "content": "Task #5 created successfully: new"}])),
        ]},
        {"match": "empty", "steps": [assistant_blocks(json!([tool_use("toolu_x", "TodoWrite", json!({"todos": []}))]))]},
    ]});
    let f = fixture_with(&[("FAKE_CLAUDE_SCRIPT", script.to_string())]);
    let s = f.create(SessionOptions::default()).await;
    let mut sub = s.subscribe(None, None);
    assert_eq!(
        s.update_todo_item("1", TodoItemAction::Complete),
        Err("no active todo list")
    );
    turn(&s, &mut sub, "plan").await;

    s.update_todo_item("2", TodoItemAction::Delete).unwrap();
    let ev = until(&mut sub, is("session_snapshot")).await.pop().unwrap();
    assert_eq!(
        ev,
        json!({"type": "session_snapshot", "todos": [item("1", "pending"), item("10", "pending")], "todosStale": false})
    );
    s.update_todo_item("10", TodoItemAction::Complete).unwrap();
    s.update_todo_item("1", TodoItemAction::InProgress).unwrap();
    s.update_todo_item("1", TodoItemAction::Reopen).unwrap();
    assert_eq!(
        snapshot_todos(&s).await,
        json!([item("1", "pending"), item("10", "completed")])
    );
    assert_eq!(
        s.update_todo_item("2", TodoItemAction::Complete),
        Err("item not found")
    );
    assert_eq!(
        s.update_todo_item("", TodoItemAction::Complete),
        Err("invalid item id")
    );
    // A re-edit keeps its place; the stored copy is in JS key order.
    let live = |s: &Session| -> Vec<(String, String)> {
        s.manual_todo_overrides()
            .into_iter()
            .map(|(k, v)| (k, v.to_owned()))
            .collect()
    };
    assert_eq!(
        live(&s),
        [("2", "deleted"), ("10", "completed"), ("1", "pending")]
            .map(|(k, v)| (k.to_owned(), v.to_owned()))
    );
    assert_eq!(
        stored_overrides(&s),
        pairs(&[("1", "pending"), ("2", "deleted"), ("10", "completed")])
    );

    // The model engaging "1" live takes it back from the user.
    turn(&s, &mut sub, "touch").await;
    assert_eq!(
        snapshot_todos(&s).await,
        json!([item("1", "in_progress"), item("10", "completed")])
    );
    assert_eq!(
        stored_overrides(&s),
        pairs(&[("2", "deleted"), ("10", "completed")])
    );
    // A TaskList rebuild is only a read: the remaining edits paint over it.
    turn(&s, &mut sub, "list").await;
    assert_eq!(
        snapshot_todos(&s).await,
        json!([
            {"id": "1", "content": "item 1", "status": "pending"},
            {"id": "10", "content": "item 10", "status": "completed"},
        ])
    );
    // Clicked before the result landed: the edit follows the item to its
    // real id, and that move is saved (integer-like keys first, as JS
    // writes them).
    s.send_input("create", &[], SendOptions::default());
    until(&mut sub, |e| {
        e["type"] == "sdk" && e["message"]["message"]["content"][0]["id"] == "toolu_c"
    })
    .await;
    s.update_todo_item("toolu_c", TodoItemAction::Complete)
        .unwrap();
    until(&mut sub, |e| {
        e["type"] == "turn_status" && e["status"] == "idle"
    })
    .await;
    assert_eq!(
        snapshot_todos(&s).await[2],
        json!({"id": "5", "content": "new", "status": "completed"})
    );
    assert_eq!(
        stored_overrides(&s),
        pairs(&[("2", "deleted"), ("5", "completed"), ("10", "completed")])
    );
    // An empty list is no list to edit.
    turn(&s, &mut sub, "empty").await;
    assert_eq!(
        s.update_todo_item("5", TodoItemAction::Complete),
        Err("no active todo list")
    );
    // A clear leaves nothing to edit, but keeps the edits.
    s.clear_todos(TodosClearReason::Manual);
    assert_eq!(
        s.update_todo_item("1", TodoItemAction::Complete),
        Err("no active todo list")
    );
    assert_eq!(
        stored_overrides(&s),
        pairs(&[("2", "deleted"), ("5", "completed"), ("10", "completed")])
    );
    f.mgr.remove(&s.id).await;
}

#[tokio::test]
async fn an_edit_bounces_older_transcript_writes() {
    let f = fixture();
    let id = "5e6f7a8b-9c0d-4e1f-8a2b-3c4d5e6f7a8c";
    let (s, mut sub, file) = watched_session(&f, id).await;
    let now = claudius_core::now_ms();
    let list = |status: &str| json!([{"id": "1", "content": "a", "status": status}]);
    external_todo_write(&s, &mut sub, &file, "y1", &list("pending"), now - 60_000).await;
    s.update_todo_item("1", TodoItemAction::Complete).unwrap();
    // Written before the edit, read after it: the edit stands.
    external_todo_write(&s, &mut sub, &file, "y2", &list("pending"), now - 30_000).await;
    assert_eq!(snapshot_todos(&s).await, list("completed"));
    f.mgr.remove(id).await;
}

/// A transcript: one prompt, then one assistant message per entry of
/// `messages` (each a block list), 1ms apart from `at_ms`.
fn blocks_transcript(f: &Fixture, id: &str, at_ms: i64, messages: &[Value]) {
    let cwd = f.cwd();
    let dir = env()
        .config
        .join("projects")
        .join(paths::sdk_project_dir_name(&cwd));
    std::fs::create_dir_all(&dir).unwrap();
    let ts = |ms: i64| {
        chrono::DateTime::from_timestamp_millis(ms)
            .unwrap()
            .to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
    };
    let mut lines = vec![
        json!({"type": "user", "uuid": format!("{id}-u"), "parentUuid": null, "sessionId": id,
        "cwd": cwd, "timestamp": ts(at_ms - 1000), "message": {"role": "user", "content": "plan it"}}),
    ];
    let mut parent = format!("{id}-u");
    for (i, blocks) in messages.iter().enumerate() {
        let uuid = format!("{id}-a{i}");
        lines.push(json!({"type": "assistant", "uuid": uuid, "parentUuid": parent, "sessionId": id, "cwd": cwd,
            "timestamp": ts(at_ms + i as i64), "message": {"role": "assistant", "id": format!("msg_{uuid}"),
            "content": blocks}}));
        parent = uuid;
    }
    let body: String = lines.iter().map(|l| format!("{l}\n")).collect();
    std::fs::write(dir.join(format!("{id}.jsonl")), body).unwrap();
}

fn store_overrides(f: &Fixture, id: &str, overrides: Value) {
    let mut patch = serde_json::Map::new();
    patch.insert("manualTodoOverrides".into(), overrides);
    sessions_db::merge_session_state(&f.cwd(), id, patch).unwrap();
}

#[tokio::test]
async fn resume_reapplies_the_users_edits() {
    let f = fixture();
    let now = claudius_core::now_ms();
    let hour = 3_600_000;
    let item = |id: &str, status: &str| json!({"id": id, "content": id, "status": status});
    let write = |todos: Value| json!([{"type": "tool_use", "id": "toolu_w", "name": "TodoWrite", "input": {"todos": todos}}]);
    let auto_cleared = |s: &Session| -> Vec<Value> {
        s.buffer_snapshot()
            .into_iter()
            .filter(|e| e["type"] == "todos_auto_cleared")
            .map(|mut e| {
                e.as_object_mut().unwrap().remove("seq");
                e
            })
            .collect()
    };

    // Edits paint over the replayed list; a replayed touch can't drop one
    // (it predates it), and malformed entries are skipped on load.
    let id = "6a1e3a1c-2a52-4c3e-9b0e-2f7f1a1c0c01";
    blocks_transcript(
        &f,
        id,
        now - hour,
        &[
            write(json!([
                item("1", "pending"),
                item("2", "pending"),
                item("3", "pending")
            ])),
            json!([{"type": "tool_use", "id": "toolu_u", "name": "TaskUpdate", "input": {"taskId": "1", "status": "in_progress"}}]),
        ],
    );
    store_overrides(
        &f,
        id,
        json!({"b": "deleted", "1": "completed", "2": "deleted", "9": "pending",
        "": "completed", "x": "bogus", "y": 5}),
    );
    let s = f.mgr.get_or_resume(id).await.unwrap();
    assert_eq!(
        snapshot_todos(&s).await,
        json!([item("1", "completed"), item("3", "pending")])
    );
    assert_eq!(
        s.manual_todo_overrides(),
        vec![
            ("1".to_owned(), "completed"),
            ("2".to_owned(), "deleted"),
            ("9".to_owned(), "pending"),
            ("b".to_owned(), "deleted"),
        ]
    );
    f.mgr.remove(id).await;

    // Edits that finish the list let the all-completed clear take it.
    let id = "6a1e3a1c-2a52-4c3e-9b0e-2f7f1a1c0c02";
    blocks_transcript(
        &f,
        id,
        now - hour,
        &[write(json!([item("1", "completed"), item("2", "pending")]))],
    );
    store_overrides(&f, id, json!({"2": "completed"}));
    let s = f.mgr.get_or_resume(id).await.unwrap();
    assert_eq!(snapshot_todos(&s).await, json!([]));
    assert_eq!(
        auto_cleared(&s),
        [json!({"type": "todos_auto_cleared", "reason": "completed", "count": 2})]
    );
    f.mgr.remove(id).await;

    // A reopen keeps a finished list.
    let id = "6a1e3a1c-2a52-4c3e-9b0e-2f7f1a1c0c03";
    blocks_transcript(
        &f,
        id,
        now - hour,
        &[write(json!([
            item("1", "completed"),
            item("2", "completed")
        ]))],
    );
    store_overrides(&f, id, json!({"1": "pending"}));
    let s = f.mgr.get_or_resume(id).await.unwrap();
    assert_eq!(
        snapshot_todos(&s).await,
        json!([item("1", "pending"), item("2", "completed")])
    );
    assert!(auto_cleared(&s).is_empty());
    f.mgr.remove(id).await;

    // The stale clear runs first, on the list as the model left it.
    let id = "6a1e3a1c-2a52-4c3e-9b0e-2f7f1a1c0c04";
    blocks_transcript(
        &f,
        id,
        now - 25 * hour,
        &[write(json!([item("1", "pending"), item("2", "pending")]))],
    );
    store_overrides(&f, id, json!({"2": "deleted"}));
    let s = f.mgr.get_or_resume(id).await.unwrap();
    assert_eq!(snapshot_todos(&s).await, json!([]));
    assert_eq!(
        auto_cleared(&s),
        [json!({"type": "todos_auto_cleared", "reason": "stale", "count": 2})]
    );
    f.mgr.remove(id).await;

    // A replayed promotion moves the edit to the real id, unsaved.
    let id = "6a1e3a1c-2a52-4c3e-9b0e-2f7f1a1c0c06";
    let dir = env()
        .config
        .join("projects")
        .join(paths::sdk_project_dir_name(&f.cwd()));
    blocks_transcript(
        &f,
        id,
        now - hour,
        &[json!([
        {"type": "tool_use", "id": "toolu_t", "name": "TaskCreate", "input": {"subject": "t"}}])],
    );
    {
        use std::io::Write;
        let line = json!({"type": "user", "uuid": format!("{id}-r"), "parentUuid": format!("{id}-a0"),
            "sessionId": id, "cwd": f.cwd(), "timestamp": chrono::DateTime::from_timestamp_millis(now - hour + 5)
                .unwrap().to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
            "message": {"role": "user", "content": [
                {"type": "tool_result", "tool_use_id": "toolu_t", "content": "Task #4 created successfully: t"}]}});
        let mut fh = std::fs::OpenOptions::new()
            .append(true)
            .open(dir.join(format!("{id}.jsonl")))
            .unwrap();
        writeln!(fh, "{line}").unwrap();
    }
    store_overrides(&f, id, json!({"toolu_t": "in_progress"}));
    let s = f.mgr.get_or_resume(id).await.unwrap();
    assert_eq!(
        snapshot_todos(&s).await,
        json!([{"id": "4", "content": "t", "status": "in_progress"}])
    );
    assert_eq!(
        s.manual_todo_overrides(),
        vec![("4".to_owned(), "in_progress")]
    );
    assert_eq!(stored_overrides(&s), pairs(&[("toolu_t", "in_progress")]));
    f.mgr.remove(id).await;

    // A non-object is ignored.
    let id = "6a1e3a1c-2a52-4c3e-9b0e-2f7f1a1c0c05";
    blocks_transcript(&f, id, now - hour, &[write(json!([item("1", "pending")]))]);
    store_overrides(&f, id, json!([["1", "completed"]]));
    let s = f.mgr.get_or_resume(id).await.unwrap();
    assert_eq!(snapshot_todos(&s).await, json!([item("1", "pending")]));
    assert!(s.manual_todo_overrides().is_empty());
    f.mgr.remove(id).await;
}

#[tokio::test]
async fn resume_honours_the_clear_marker_and_auto_clears() {
    let f = fixture();
    let now = claudius_core::now_ms();
    let hour = 3_600_000;
    let open =
        json!([{"content": "a", "status": "pending"}, {"content": "b", "status": "completed"}]);
    let done = json!([{"content": "a", "status": "completed"}]);
    let auto_cleared = |s: &Session| -> Vec<Value> {
        s.buffer_snapshot()
            .into_iter()
            .filter(|e| e["type"] == "todos_auto_cleared")
            .collect()
    };

    // A recent open list survives the restart.
    let id = "6a1e3a1c-2a52-4c3e-9b0e-2f7f1a1c0b01";
    todo_transcript(&f, id, &open, now - hour);
    let s = f.mgr.get_or_resume(id).await.unwrap();
    assert_eq!(snapshot_todos(&s).await, open);
    assert!(auto_cleared(&s).is_empty());
    f.mgr.remove(id).await;

    // A clear newer than the write bounces it: explicit `[]`, no toast.
    let id = "6a1e3a1c-2a52-4c3e-9b0e-2f7f1a1c0b02";
    todo_transcript(&f, id, &open, now - hour);
    let mut marker = serde_json::Map::new();
    marker.insert("todosClearedAt".into(), json!(now - hour + 1));
    sessions_db::merge_session_state(&f.cwd(), id, marker).unwrap();
    let s = f.mgr.get_or_resume(id).await.unwrap();
    assert_eq!(snapshot_todos(&s).await, json!([]));
    assert!(auto_cleared(&s).is_empty());
    f.mgr.remove(id).await;

    // An older clear doesn't.
    let id = "6a1e3a1c-2a52-4c3e-9b0e-2f7f1a1c0b03";
    todo_transcript(&f, id, &open, now - hour);
    let mut marker = serde_json::Map::new();
    marker.insert("todosClearedAt".into(), json!(now - 2 * hour));
    sessions_db::merge_session_state(&f.cwd(), id, marker).unwrap();
    let s = f.mgr.get_or_resume(id).await.unwrap();
    assert_eq!(snapshot_todos(&s).await, open);
    f.mgr.remove(id).await;

    // Untouched for over a day: the stale clear, announced and persisted.
    let id = "6a1e3a1c-2a52-4c3e-9b0e-2f7f1a1c0b04";
    todo_transcript(&f, id, &open, now - 25 * hour);
    let s = f.mgr.get_or_resume(id).await.unwrap();
    assert_eq!(snapshot_todos(&s).await, json!([]));
    assert_eq!(
        auto_cleared(&s),
        vec![json!({"type": "todos_auto_cleared", "reason": "stale", "count": 2})]
    );
    assert!(
        sessions_db::get_session_state(&f.cwd(), id)["todosClearedAt"]
            .as_i64()
            .unwrap()
            >= now
    );
    f.mgr.remove(id).await;

    // Just under a day: kept.
    let id = "6a1e3a1c-2a52-4c3e-9b0e-2f7f1a1c0b05";
    todo_transcript(&f, id, &open, now - 23 * hour);
    let s = f.mgr.get_or_resume(id).await.unwrap();
    assert_eq!(snapshot_todos(&s).await, open);
    f.mgr.remove(id).await;

    // Everything done: the completed clear.
    let id = "6a1e3a1c-2a52-4c3e-9b0e-2f7f1a1c0b06";
    todo_transcript(&f, id, &done, now - hour);
    let s = f.mgr.get_or_resume(id).await.unwrap();
    assert_eq!(snapshot_todos(&s).await, json!([]));
    assert_eq!(
        auto_cleared(&s),
        vec![json!({"type": "todos_auto_cleared", "reason": "completed", "count": 1})]
    );
    f.mgr.remove(id).await;

    // An empty list is left alone (`[].every` would be true).
    let id = "6a1e3a1c-2a52-4c3e-9b0e-2f7f1a1c0b07";
    todo_transcript(&f, id, &json!([]), now - 25 * hour);
    let s = f.mgr.get_or_resume(id).await.unwrap();
    assert_eq!(snapshot_todos(&s).await, json!([]));
    assert!(auto_cleared(&s).is_empty());
    assert!(
        sessions_db::get_session_state(&f.cwd(), id)
            .get("todosClearedAt")
            .is_none()
    );
    f.mgr.remove(id).await;
}

#[tokio::test]
async fn cli_crash_surfaces_error_and_settles() {
    let f = fixture();
    let s = f.create(SessionOptions::default()).await;
    let mut sub = s.subscribe(None, None);
    until(&mut sub, is("tips")).await;
    s.send_input("exit:3", &[], SendOptions::default());
    let evs = until(&mut sub, is("error")).await;
    let msg = evs.last().unwrap()["message"].as_str().unwrap().to_owned();
    assert!(msg.contains("exited with code 3"), "{msg}");
    let st = until(&mut sub, is("turn_status")).await;
    assert_eq!(st.last().unwrap()["status"], "idle");
    assert!(s.is_done());
    f.mgr.remove(&s.id).await;
}

#[tokio::test]
async fn scripted_turn_through_send_input_and_scripted_interrupt() {
    let script = json!({
        "control": {"interrupt": {"$response": {"still_queued": []}, "$emit": [
            {"type": "result", "subtype": "error_during_execution", "is_error": true,
             "duration_ms": 1, "duration_api_ms": 1, "num_turns": 1, "total_cost_usd": 0.0,
             "usage": {"input_tokens": 0, "output_tokens": 0}}]}},
        "turns": [{"match": "hang", "steps": [{"$text": "thinking…"}], "result": false}]
    });
    let f = fixture_with(&[("FAKE_CLAUDE_SCRIPT", script.to_string())]);
    let s = f.create(SessionOptions::default()).await;
    let mut sub = s.subscribe(None, Some("tab-1".into()));
    until(&mut sub, is("holder_changed")).await;

    // An inline `script:` prompt survives send_input (reminders, slash
    // handling) and its messages reach subscribers as sdk events.
    s.send_input(
        r#"script:[{"type":"system","subtype":"status","status":"compacting"},{"$text":"scripted ok"}]"#,
        &[],
        SendOptions::default(),
    );
    let turn = until(&mut sub, |e| {
        e["type"] == "turn_status" && e["status"] == "idle"
    })
    .await;
    assert!(
        turn.iter()
            .any(|e| e["type"] == "sdk" && e["message"]["subtype"] == "status"),
        "{:?}",
        types(&turn)
    );
    assert_eq!(turn.iter().find_map(assistant_text), Some("scripted ok"));

    // A scripted turn that never finishes, ended by the scripted interrupt.
    s.send_input("please hang", &[], SendOptions::default());
    until(&mut sub, |e| assistant_text(e) == Some("thinking…")).await;
    s.interrupt().await;
    let end = until(&mut sub, |e| {
        e["type"] == "turn_status" && e["status"] == "idle"
    })
    .await;
    assert!(end.iter().any(|e| e["type"] == "sdk"
        && e["message"]["type"] == "result"
        && e["message"]["subtype"] == "error_during_execution"));
    f.mgr.remove(&s.id).await;
}

/// Every `task_snapshot` in `evs`.
fn task_snapshots(evs: &[Value]) -> Vec<Value> {
    evs.iter()
        .filter(|e| e["type"] == "task_snapshot")
        .map(|e| e["tasks"].clone())
        .collect()
}

/// A subagent's state rides on SSE-only events, so it's persisted as it
/// goes: the row exists from `task_started` (status running, the inner
/// conversation still inside its write window), the terminal notification
/// writes the final state with the conversation, and every subscriber —
/// including one on the session rebuilt from disk after a reap — gets it
/// back as a `task_snapshot`. A session with no tasks sends none.
#[tokio::test]
async fn tasks_survive_a_reap_and_repaint_via_task_snapshot() {
    let task = |subtype: &str, extra: Value| {
        let mut m = json!({"type": "system", "subtype": subtype, "task_id": "task-1"});
        m.as_object_mut()
            .unwrap()
            .extend(extra.as_object().unwrap().clone());
        m
    };
    let script = json!({"turns": [
        {"match": "start", "result": "started", "steps": [
            task("task_started", json!({"tool_use_id": "toolu_task", "description": "Survey",
                "task_type": "local_agent", "spawn_depth": 1})),
            {"type": "assistant", "parent_tool_use_id": "toolu_task",
             "message": {"role": "assistant", "content": [{"type": "text", "text": "inner work"}]}},
        ]},
        {"match": "finish", "result": "finished", "steps": [
            task("task_progress", json!({"summary": "Halfway",
                "usage": {"total_tokens": 42, "tool_uses": 3, "duration_ms": 1500}})),
            task("task_notification", json!({"status": "completed", "summary": "Done",
                "usage": {"total_tokens": 99, "tool_uses": 4, "duration_ms": 2000},
                "output_file": "/tmp/task-1.out"})),
        ]},
    ]});
    let f = fixture_with(&[("FAKE_CLAUDE_SCRIPT", script.to_string())]);
    let s = f.create(SessionOptions::default()).await;
    let id = s.id.clone();
    let mut sub = s.subscribe(None, None);
    until(&mut sub, is("tips")).await;

    // No tasks yet: a subscriber gets no snapshot. Its async sends are done
    // long before a whole turn has gone by, so read through the replay to
    // this turn's own reply.
    let mut quiet = s.subscribe(None, None);
    s.send_input("hello", &[], SendOptions::default());
    let seen = until(&mut quiet, |e| assistant_text(e) == Some("echo:hello")).await;
    assert!(task_snapshots(&seen).is_empty(), "{:?}", types(&seen));
    until(&mut sub, |e| assistant_text(e) == Some("echo:hello")).await;
    drop(quiet);

    // Mid-run: the row is there from the start; the foreground subagent
    // keeps the session running past the turn's result.
    s.send_input("start", &[], SendOptions::default());
    until(&mut sub, |e| {
        e["type"] == "sdk" && e["message"]["parent_tool_use_id"] == "toolu_task"
    })
    .await;
    until(&mut sub, |e| {
        e["type"] == "sdk" && e["message"]["type"] == "result"
    })
    .await;
    assert_eq!(s.status(), claudius_core::session::TurnStatus::Running);
    let mut mid = s.subscribe(None, None);
    let mid_snap = task_snapshots(&until(&mut mid, is("task_snapshot")).await).remove(0);
    assert_eq!(
        mid_snap,
        json!([{"taskId": "task-1", "toolUseId": "toolu_task", "description": "Survey",
            "taskType": "local_agent", "status": "running", "spawnDepth": 1, "innerMessages": []}])
    );
    drop(mid);

    // The notification writes the final state, conversation included.
    s.send_input("finish", &[], SendOptions::default());
    until(&mut sub, |e| {
        e["type"] == "turn_status" && e["status"] == "idle"
    })
    .await;
    let mut late = s.subscribe(None, None);
    let done = task_snapshots(&until(&mut late, is("task_snapshot")).await).remove(0);
    let inner = done[0]["innerMessages"].as_array().unwrap();
    assert_eq!(inner.len(), 1);
    assert!(inner[0]["at"].is_i64());
    assert_eq!(
        inner[0]["message"]["message"]["content"][0]["text"],
        "inner work"
    );
    let mut summary = done[0].clone();
    summary.as_object_mut().unwrap().remove("innerMessages");
    assert_eq!(
        summary,
        json!({"taskId": "task-1", "toolUseId": "toolu_task", "description": "Survey",
            "taskType": "local_agent", "status": "completed", "totalTokens": 99, "toolUses": 4,
            "durationMs": 2000, "summary": "Done", "spawnDepth": 1,
            "outputFile": "/tmp/task-1.out"})
    );
    drop((sub, late));

    // Reaped, then rebuilt from disk: the replay knows nothing of the task,
    // the snapshot repaints it as it was.
    f.mgr.remove(&id).await;
    blocks_transcript(
        &f,
        &id,
        claudius_core::now_ms(),
        &[json!([{"type": "text", "text": "finished"}])],
    );
    let s = f.mgr.get_or_resume(&id).await.unwrap();
    let mut sub = s.subscribe(None, None);
    let seen = until(&mut sub, is("task_snapshot")).await;
    assert_eq!(task_snapshots(&seen), [done]);
    assert_eq!(s.status(), claudius_core::session::TurnStatus::Idle);
    f.mgr.remove(&id).await;
}

/// Ctrl+B end to end: a foreground subagent keeps the session running past
/// its turn; `background_tasks` sends the request (with the tool use id),
/// the CLI's `task_updated` patch moves the task to the background, and
/// `turn_status` goes idle with `backgroundTasks: 1`, then back to 0 when the
/// task finishes.
#[tokio::test]
async fn backgrounding_a_subagent_frees_the_session() {
    let control_log = tempfile::NamedTempFile::new().unwrap();
    let task = |subtype: &str, extra: Value| {
        let mut m = json!({"type": "system", "subtype": subtype, "task_id": "bg-1"});
        m.as_object_mut()
            .unwrap()
            .extend(extra.as_object().unwrap().clone());
        m
    };
    let script = json!({
        "control": {"background_tasks": {"$response": {"backgrounded": true}, "$emit": [
            task("task_updated", json!({"patch": {"is_backgrounded": true}})),
        ]}},
        "turns": [
            {"match": "spawn", "result": "spawned", "steps": [
                task("task_started", json!({"tool_use_id": "toolu_bg", "description": "Long job"})),
            ]},
            {"match": "finish", "result": "finished", "steps": [
                task("task_notification", json!({"status": "completed", "summary": "Done"})),
            ]},
        ],
    });
    let f = fixture_with(&[
        ("FAKE_CLAUDE_SCRIPT", script.to_string()),
        (
            "FAKE_CLAUDE_CONTROL_LOG",
            control_log.path().display().to_string(),
        ),
    ]);
    let s = f.create(SessionOptions::default()).await;
    let mut sub = s.subscribe(None, None);
    until(&mut sub, is("tips")).await;
    let status = |e: &Value| (e["status"].clone(), e["backgroundTasks"].clone());

    s.send_input("spawn", &[], SendOptions::default());
    let seen = until(&mut sub, |e| {
        e["type"] == "sdk" && e["message"]["type"] == "result"
    })
    .await;
    let last = seen
        .iter()
        .rev()
        .find(|e| e["type"] == "turn_status")
        .unwrap();
    assert_eq!(status(last), (json!("running"), json!(0)));

    assert_eq!(s.background_tasks(Some("toolu_bg")).await, Ok(true));
    let ts = until(&mut sub, is("turn_status")).await;
    assert_eq!(status(ts.last().unwrap()), (json!("idle"), json!(1)));
    assert_eq!(s.status(), claudius_core::session::TurnStatus::Idle);
    let sent: Vec<Value> = std::fs::read_to_string(control_log.path())
        .unwrap()
        .lines()
        .filter_map(|l| serde_json::from_str::<Value>(l).ok())
        .map(|m| m["request"].clone())
        .filter(|r| r["subtype"] == "background_tasks")
        .collect();
    assert_eq!(
        sent,
        [json!({"subtype": "background_tasks", "tool_use_id": "toolu_bg"})]
    );

    s.send_input("finish", &[], SendOptions::default());
    until(&mut sub, |e| {
        e["type"] == "turn_status" && e["status"] == "idle" && e["backgroundTasks"] == 0
    })
    .await;
    f.mgr.remove(&s.id).await;
}

/// Scheduled loops end to end (S11a): the CLI arms a session-only cron and
/// a quiet `/loop` wake-up in one turn; the tracker promotes the cron to
/// the id in its result, records the tick and attaches the turn's usage
/// when the `result` lands. The next turn stops the wake-up and deletes the
/// cron; ending the session drops it all.
#[tokio::test]
async fn the_live_stream_arms_and_cancels_loops() {
    let tool_use = |id: &str, name: &str, input: Value| {
        json!({"type": "assistant", "message": {"role": "assistant",
            "content": [{"type": "tool_use", "id": id, "name": name, "input": input}]}})
    };
    let script = json!({"turns": [
        {"match": "arm", "result": "armed", "steps": [
            tool_use("toolu_cron", "CronCreate", json!({"cron": "*/5 * * * *", "prompt": "check CI", "recurring": true})),
            {"type": "user", "message": {"role": "user", "content": [{"type": "tool_result",
                "tool_use_id": "toolu_cron",
                "content": "Scheduled recurring job ci42 (Every 5 minutes). Session-only (not written to disk)."}]},
             "tool_use_result": {"id": "ci42", "nextFireAt": 4_102_444_800_000_i64}},
            tool_use("toolu_wake", "ScheduleWakeup", json!({"delaySeconds": 90, "reason": "watch", "prompt": "/loop watch", "noop": true})),
        ]},
        {"match": "stop", "result": "stopped", "steps": [
            tool_use("toolu_stop", "ScheduleWakeup", json!({"stop": true})),
            tool_use("toolu_del", "CronDelete", json!({"id": "ci42"})),
        ]},
    ]});
    let f = fixture_with(&[("FAKE_CLAUDE_SCRIPT", script.to_string())]);
    let s = f.create(SessionOptions::default()).await;
    let mut sub = s.subscribe(None, None);
    until(&mut sub, is("tips")).await;
    assert!(s.scheduled_loops().is_empty());

    let before = claudius_core::now_ms();
    let result_of = |text: &'static str| {
        move |e: &Value| {
            e["type"] == "sdk" && e["message"]["type"] == "result" && e["message"]["result"] == text
        }
    };
    // The tick rows carry the session's title at the time.
    s.rename("Loop session").await.unwrap();
    s.send_input("arm", &[], SendOptions::default());
    until(&mut sub, result_of("armed")).await;
    let after = claudius_core::now_ms();
    let loops: Vec<Value> = s.scheduled_loops().iter().map(|l| l.to_json()).collect();
    assert_eq!(loops.len(), 2, "{loops:?}");
    for l in &loops {
        let at = l["startedAt"].as_i64().unwrap();
        assert!((before..=after).contains(&at), "{l}");
    }
    let mut cron = loops[0].clone();
    cron["startedAt"] = json!(0);
    assert_eq!(
        cron.to_string(),
        json!({"kind": "cron", "id": "ci42", "toolUseId": "toolu_cron", "cron": "*/5 * * * *",
            "humanSchedule": "Every 5 minutes", "delaySeconds": null, "prompt": "check CI",
            "recurring": true, "durable": false, "startedAt": 0, "cancelled": false,
            "nextFireAt": 4_102_444_800_000_i64})
        .to_string()
    );
    let mut wake = loops[1].clone();
    wake["startedAt"] = json!(0);
    assert_eq!(
        wake.to_string(),
        json!({"kind": "wakeup", "id": "toolu_wake", "toolUseId": "toolu_wake", "cron": null,
            "humanSchedule": null, "delaySeconds": 90, "prompt": "/loop watch", "reason": "watch",
            "recurring": false, "durable": false, "startedAt": 0, "cancelled": false,
            "noop": true, "noopStreak": 1})
        .to_string()
    );
    // The tick, with the turn's usage (the fake reports 1 in + 1 out).
    let rows = claudius_core::loop_ticks_db::list_loop_breakdown(&f.cwd());
    assert_eq!(rows.len(), 1);
    assert_eq!(
        rows[0].to_json(),
        json!({"sessionId": s.id, "sessionTitle": "Loop session", "runCount": 1, "totalTokens": 2,
            "tokensPerRun": 2, "lastRun": loops[1]["startedAt"], "lastPrompt": "/loop watch"})
    );

    s.send_input("stop", &[], SendOptions::default());
    until(&mut sub, result_of("stopped")).await;
    let cancelled: Vec<(String, bool)> = s
        .scheduled_loops()
        .iter()
        .map(|l| (l.id.clone(), l.cancelled))
        .collect();
    assert_eq!(
        cancelled,
        [("ci42".to_owned(), true), ("toolu_wake".to_owned(), true)]
    );
    // A stop arms nothing: still one tick.
    assert_eq!(
        claudius_core::loop_ticks_db::list_loop_breakdown(&f.cwd())[0].run_count,
        1.0
    );
    drop(sub);
    f.mgr.remove(&s.id).await;
    assert!(s.scheduled_loops().is_empty());
}

/// A session rebuilt from its transcript re-learns the loops on disk,
/// anchored to when they were armed (the JSONL timestamps), not to the
/// replay. The replayed records carry no `tool_use_result`, so the cron
/// has no `nextFireAt` (TS reads them through the same SDK reader).
#[tokio::test]
async fn resumed_loops_keep_their_arming_time() {
    let f = fixture();
    let id = uuid::Uuid::new_v4().to_string();
    let cwd = f.cwd();
    let dir = env()
        .config
        .join("projects")
        .join(paths::sdk_project_dir_name(&cwd));
    std::fs::create_dir_all(&dir).unwrap();
    let t0 = claudius_core::now_ms() - 3_600_000;
    let ts = |ms: i64| {
        chrono::DateTime::from_timestamp_millis(ms)
            .unwrap()
            .to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
    };
    let line = |kind: &str, uuid: &str, parent: Option<&str>, at: i64, message: Value| {
        json!({"type": kind, "uuid": uuid, "parentUuid": parent, "sessionId": id, "cwd": cwd,
            "timestamp": ts(at), "message": message})
    };
    let lines = [
        line(
            "user",
            "u0",
            None,
            t0,
            json!({"role": "user", "content": "loop it"}),
        ),
        line(
            "assistant",
            "a1",
            Some("u0"),
            t0 + 10,
            json!({"role": "assistant", "id": "msg_1",
            "content": [{"type": "tool_use", "id": "toolu_c", "name": "CronCreate",
                "input": {"cron": "0 9 * * *", "prompt": "standup"}}]}),
        ),
        {
            let mut r = line(
                "user",
                "r1",
                Some("a1"),
                t0 + 20,
                json!({"role": "user",
                "content": [{"type": "tool_result", "tool_use_id": "toolu_c",
                    "content": "Scheduled job sd9 (At 09:00)."}]}),
            );
            r["toolUseResult"] = json!({"id": "sd9", "nextFireAt": 4_102_444_800_000_i64});
            r
        },
        line(
            "assistant",
            "a2",
            Some("r1"),
            t0 + 30,
            json!({"role": "assistant", "id": "msg_2",
            "content": [{"type": "tool_use", "id": "toolu_w", "name": "ScheduleWakeup",
                "input": {"delaySeconds": 600, "prompt": "/loop again"}}]}),
        ),
    ];
    let body: String = lines.iter().map(|l| format!("{l}\n")).collect();
    std::fs::write(dir.join(format!("{id}.jsonl")), body).unwrap();

    let s = f.mgr.get_or_resume(&id).await.unwrap();
    let loops: Vec<Value> = s.scheduled_loops().iter().map(|l| l.to_json()).collect();
    assert_eq!(
        Value::Array(loops).to_string(),
        json!([
            {"kind": "cron", "id": "sd9", "toolUseId": "toolu_c", "cron": "0 9 * * *",
             "humanSchedule": "At 09:00", "delaySeconds": null, "prompt": "standup",
             "recurring": false, "durable": true, "startedAt": t0 + 10, "cancelled": false},
            {"kind": "wakeup", "id": "toolu_w", "toolUseId": "toolu_w", "cron": null,
             "humanSchedule": null, "delaySeconds": 600, "prompt": "/loop again",
             "recurring": false, "durable": false, "startedAt": t0 + 30, "cancelled": false},
        ])
        .to_string()
    );
    // The replayed wake-up is a recorded tick, fired when it was armed.
    let rows = claudius_core::loop_ticks_db::list_loop_breakdown(&cwd);
    let row = rows.iter().find(|r| r.session_id == id).unwrap();
    assert_eq!((row.run_count, row.last_run), (1.0, (t0 + 30) as f64));

    // An external writer (a terminal `claude --resume`) stops the loop and
    // deletes the cron: the resync replays it through the tracker.
    let more = [line(
        "assistant",
        "a3",
        Some("a2"),
        t0 + 40,
        json!({"role": "assistant", "id": "msg_3",
        "content": [
            {"type": "tool_use", "id": "toolu_s", "name": "ScheduleWakeup", "input": {"stop": true}},
            {"type": "tool_use", "id": "toolu_d", "name": "CronDelete", "input": {"id": "sd9"}},
        ]}),
    )];
    let tail: String = more.iter().map(|l| format!("{l}\n")).collect();
    let path = dir.join(format!("{id}.jsonl"));
    let mut text = std::fs::read_to_string(&path).unwrap();
    text.push_str(&tail);
    std::fs::write(&path, text).unwrap();
    // (The JSONL watcher may get there first; either way it's replayed once.)
    s.resync_from_disk();
    let cancelled: Vec<bool> = s.scheduled_loops().iter().map(|l| l.cancelled).collect();
    assert_eq!(cancelled, [true, true]);
    f.mgr.remove(&id).await;
}

/// Polls `cond` every 20 ms until it holds; panics after `secs`.
async fn eventually(secs: u64, what: &str, cond: impl Fn() -> bool) {
    let deadline = tokio::time::Instant::now() + Duration::from_secs(secs);
    while !cond() {
        assert!(tokio::time::Instant::now() < deadline, "timed out: {what}");
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
}

/// The idle reaper keeps an unwatched session whose `/loop` wake-up will
/// still fire, re-checking every window, and reaps it once the loop stops;
/// a session without one goes on the first window (CC 2.1.292 parity).
#[tokio::test(flavor = "multi_thread")]
async fn an_armed_loop_keeps_an_unwatched_session_alive() {
    let tool_use = |id: &str, name: &str, input: Value| {
        json!({"type": "assistant", "message": {"role": "assistant",
            "content": [{"type": "tool_use", "id": id, "name": name, "input": input}]}})
    };
    let script = json!({"turns": [
        {"match": "arm", "result": "armed", "steps": [
            tool_use("toolu_wake", "ScheduleWakeup", json!({"delaySeconds": 3600, "prompt": "/loop watch"})),
        ]},
        {"match": "stop", "result": "stopped", "steps": [
            tool_use("toolu_stop", "ScheduleWakeup", json!({"stop": true})),
        ]},
    ]});
    let f = fixture_with(&[("FAKE_CLAUDE_SCRIPT", script.to_string())]);
    *f.mgr.reap_ms_override.lock().unwrap() = Some(200);
    // Watched from the start, so the window can't close before the loop is
    // armed.
    let looping = f.create(SessionOptions::default()).await;
    let mut sub = looping.subscribe(None, None);
    until(&mut sub, is("tips")).await;
    assert!(!looping.has_armed_loops(claudius_core::now_ms()));
    looping.send_input("arm", &[], SendOptions::default());
    until(&mut sub, |e| {
        e["type"] == "sdk" && e["message"]["type"] == "result" && e["message"]["result"] == "armed"
    })
    .await;
    assert!(looping.has_armed_loops(claudius_core::now_ms()));

    let idle = f.create(SessionOptions::default()).await;
    drop(sub); // no tab left: both are up for reaping
    eventually(10, "the idle session is reaped", || {
        f.mgr.get(&idle.id).is_none()
    })
    .await;
    // Five more windows: still kept.
    tokio::time::sleep(Duration::from_millis(1_000)).await;
    assert!(f.mgr.get(&looping.id).is_some(), "an armed loop was reaped");

    // `stop: true` disarms it: the next window reaps it.
    looping.send_input("stop", &[], SendOptions::default());
    eventually(10, "the stopped loop's session is reaped", || {
        f.mgr.get(&looping.id).is_none()
    })
    .await;
    assert!(
        looping.scheduled_loops().is_empty(),
        "end() clears the loops"
    );
}

/// The next `session_recap` / `session_recap_error` on `sub`.
async fn recap_event(sub: &mut Subscription) -> Value {
    until(sub, |e| {
        e["type"] == "session_recap" || e["type"] == "session_recap_error"
    })
    .await
    .pop()
    .unwrap()
}

/// `requestRecap` (S12): no history yet, then a recap of the conversation
/// that every subscriber gets, then the multi-tab dedupe window.
#[tokio::test(flavor = "multi_thread")]
async fn a_recap_reaches_every_tab_once_per_window() {
    let script = json!({"turns": [
        {"match": "stepped away", "steps": [{"$text": "  Porting the recap.\n Next:\tthe route. "}]},
    ]});
    let f = fixture_with(&[("FAKE_CLAUDE_SCRIPT", script.to_string())]);
    let s = f.create(SessionOptions::default()).await;
    let mut sub = s.subscribe(None, None);
    let mut other = s.subscribe(None, None);
    until(&mut sub, is("tips")).await;
    until(&mut other, is("tips")).await;

    // Nothing to recap yet, and that claims no dedupe slot.
    s.request_recap("away").await;
    for tab in [&mut sub, &mut other] {
        assert_eq!(
            recap_event(tab).await,
            json!({"type": "session_recap_error", "reason": "no_history"})
        );
    }

    turn(&s, &mut sub, "hello").await;
    let before = claudius_core::now_ms();
    s.request_recap("manual").await;
    for tab in [&mut sub, &mut other] {
        let ev = recap_event(tab).await;
        assert_eq!(ev["text"], "Porting the recap. Next: the route.", "{ev}");
        assert_eq!(ev["origin"], "manual");
        let keys: Vec<&str> = ev.as_object().unwrap().keys().map(String::as_str).collect();
        assert_eq!(keys, ["type", "text", "at", "origin"]);
        assert!(ev["at"].as_i64().unwrap() >= before);
    }
    // The recap's own CLI got the conversation's tail.
    let prompt = f
        .log()
        .into_iter()
        .filter_map(|m| {
            m["message"]["content"][0]["text"]
                .as_str()
                .map(str::to_owned)
        })
        .find(|t| t.contains("<recent_transcript>"))
        .expect("the recap prompt");
    assert!(
        prompt.contains("ASSISTANT: echo:hello\n</recent_transcript>"),
        "{prompt}"
    );

    // A second tab coming back within the window.
    s.request_recap("away").await;
    assert_eq!(
        recap_event(&mut other).await,
        json!({"type": "session_recap_error", "reason": "rate_limited"})
    );
    // Recaps aren't replayed to a late subscriber.
    let mut late = s.subscribe(None, None);
    let head = until(&mut late, is("tips")).await;
    assert!(
        !types(&head).iter().any(|t| t.starts_with("session_recap")),
        "{head:?}"
    );
}

/// A new turn cancels an in-flight recap without a word, and a running turn
/// refuses one (before the dedupe window is even looked at).
#[tokio::test(flavor = "multi_thread")]
async fn a_new_turn_cancels_the_recap_and_a_running_one_refuses_it() {
    let script = json!({"turns": [
        {"match": "stepped away", "steps": [{"$delay_ms": 3000}, {"$text": "too late"}]},
        {"match": "slow", "result": "slow done", "steps": [{"$delay_ms": 1500}, {"$text": "slow"}]},
    ]});
    let f = fixture_with(&[("FAKE_CLAUDE_SCRIPT", script.to_string())]);
    let s = f.create(SessionOptions::default()).await;
    let mut sub = s.subscribe(None, None);
    until(&mut sub, is("tips")).await;
    turn(&s, &mut sub, "hello").await;

    let recap = {
        let s = s.clone();
        tokio::spawn(async move { s.request_recap("away").await })
    };
    tokio::time::sleep(Duration::from_millis(400)).await;
    let evs = turn(&s, &mut sub, "again").await;
    tokio::time::timeout(Duration::from_secs(5), recap)
        .await
        .expect("the cancelled recap returns")
        .unwrap();
    // Anything a stale recap could have sent has arrived by now.
    s.broadcast(json!({"type": "marker"}));
    let mut seen = evs;
    seen.extend(until(&mut sub, is("marker")).await);
    assert!(
        !types(&seen).iter().any(|t| t.starts_with("session_recap")),
        "{:?}",
        types(&seen)
    );

    s.send_input("slow", &[], SendOptions::default());
    until(&mut sub, |e| {
        e["type"] == "turn_status" && e["status"] == "running"
    })
    .await;
    s.request_recap("away").await;
    assert_eq!(
        recap_event(&mut sub).await,
        json!({"type": "session_recap_error", "reason": "running"})
    );
    until(&mut sub, |e| {
        e["type"] == "turn_status" && e["status"] == "idle"
    })
    .await;
    // The cancelled recap still holds the window.
    s.request_recap("away").await;
    assert_eq!(
        recap_event(&mut sub).await,
        json!({"type": "session_recap_error", "reason": "rate_limited"})
    );
}

/// A recap whose query fails or says nothing reports `failed` with why; a
/// buffer the TS tail extraction throws on sends nothing at all.
#[tokio::test(flavor = "multi_thread")]
async fn a_failed_recap_says_why() {
    for (steps, message) in [
        (
            json!([{"$stderr": "boom"}, {"$exit": 3}]),
            "Claude Code process exited with code 3. stderr: boom",
        ),
        (json!([{"$text": " \n "}]), "empty response"),
    ] {
        let script = json!({"turns": [{"match": "stepped away", "steps": steps}]});
        let f = fixture_with(&[("FAKE_CLAUDE_SCRIPT", script.to_string())]);
        let s = f.create(SessionOptions::default()).await;
        let mut sub = s.subscribe(None, None);
        until(&mut sub, is("tips")).await;
        turn(&s, &mut sub, "hello").await;
        s.request_recap("away").await;
        assert_eq!(
            recap_event(&mut sub).await,
            json!({"type": "session_recap_error", "reason": "failed", "message": message})
        );
    }

    let f = fixture();
    let s = f.create(SessionOptions::default()).await;
    let mut sub = s.subscribe(None, None);
    until(&mut sub, is("tips")).await;
    turn(&s, &mut sub, "hello").await;
    s.broadcast(json!({"type": "sdk"}));
    s.request_recap("away").await;
    s.broadcast(json!({"type": "marker"}));
    let seen = until(&mut sub, is("marker")).await;
    assert!(
        !types(&seen).iter().any(|t| t.starts_with("session_recap")),
        "{:?}",
        types(&seen)
    );
}

/// A turn waiting on the user (`needs_input`) isn't `running`: the recap
/// goes ahead, like TS.
#[tokio::test(flavor = "multi_thread")]
async fn a_recap_runs_while_a_prompt_waits() {
    let script = json!({"turns": [
        {"match": "stepped away", "steps": [{"$text": "Waiting on your answer."}]},
    ]});
    let f = fixture_with(&[("FAKE_CLAUDE_SCRIPT", script.to_string())]);
    let s = f.create(SessionOptions::default()).await;
    let mut sub = s.subscribe(None, None);
    until(&mut sub, is("tips")).await;
    turn(&s, &mut sub, "hello").await;
    s.send_input("tool:ls", &[], SendOptions::default());
    until(&mut sub, is("permission_request")).await;
    assert_eq!(s.status(), TurnStatus::NeedsInput);
    s.request_recap("away").await;
    let ev = recap_event(&mut sub).await;
    assert_eq!(ev["type"], "session_recap", "{ev}");
    assert_eq!(ev["text"], "Waiting on your answer.");
}

/// `spinnerTipsOverride.tipsFile` (S22): `start()` reads the file once
/// (`~/` against the home dir), normalizes its entries and appends them to
/// the inline tips, so a subscriber's `tips` event carries them. A later
/// edit of the file only reaches sessions started after it.
#[tokio::test]
async fn a_spinner_tips_file_reaches_subscribers_read_once_at_start() {
    let f = fixture();
    let home = paths::home_dir();
    let tips_file = home.join("s22-spinner-tips.json");
    let settings = home.join(".claude/settings.json");
    std::fs::create_dir_all(settings.parent().unwrap()).unwrap();
    let write = |path: &Path, body: &str| {
        // Atomic: other tests in this binary read the same settings.json.
        let tmp = path.with_extension("s22-tmp");
        std::fs::write(&tmp, body).unwrap();
        std::fs::rename(&tmp, path).unwrap();
    };
    write(
        &tips_file,
        r#"["  from file  ", {"id": "f", "text": " File tip ", "priority": 5, "extra": 1}, "", 7, {"id": "x"}]"#,
    );
    write(
        &settings,
        &json!({"spinnerTipsOverride": {
            "excludeDefault": true,
            "label": " Org ",
            "tips": ["", " inline "],
            "tipsFile": " ~/s22-spinner-tips.json ",
        }})
        .to_string(),
    );
    let tips_of = async |s: &Session| {
        let mut sub = s.subscribe(None, None);
        until(&mut sub, is("tips")).await.pop().unwrap()["tips"].clone()
    };

    let first = f.create(SessionOptions::default()).await;
    let want = json!([
        {"id": "custom:f", "text": "File tip", "label": "Org", "priority": 5},
        {"id": "custom:0", "text": "inline", "label": "Org"},
        {"id": "custom:1", "text": "from file", "label": "Org"},
    ]);
    assert_eq!(tips_of(&first).await, want);

    write(&tips_file, r#"["changed"]"#);
    assert_eq!(tips_of(&first).await, want, "a subscribe re-read the file");
    let second = f.create(SessionOptions::default()).await;
    std::fs::remove_file(&settings).unwrap();
    std::fs::remove_file(&tips_file).unwrap();
    assert_eq!(
        tips_of(&second).await,
        json!([
            {"id": "custom:0", "text": "inline", "label": "Org"},
            {"id": "custom:1", "text": "changed", "label": "Org"},
        ])
    );
    assert_eq!(tips_of(&first).await, want);
}

/// The full usage call's control requests, from the CLI's stdin log.
fn usage_scans(f: &Fixture) -> Vec<Value> {
    f.log()
        .into_iter()
        .map(|m| m["request"].clone())
        .filter(|r| r["subtype"] == "get_usage")
        .collect()
}

/// S16: `getUsageBehaviors` and `getWeeklyUsedSkills` share one `get_usage`
/// scan with the behaviours (no `skip_behaviors`) per query; a CLI with no
/// behaviours section gives `None` and `[]`; a failed scan is `None` for
/// both and isn't kept.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn usage_extras_share_one_full_scan() {
    let usage = json!({"behaviors": {
        "day": {"request_count": 10, "session_count": 1, "skills": [],
                "behaviors": [{"key": "max_effort", "pct": 40, "count": 4}]},
        "week": {"request_count": 50, "session_count": 3,
                 "behaviors": [{"key": "workflow", "pct": 25.5, "count": 12}, {"key": "new_kind", "pct": 90}],
                 "skills": [{"name": "pdf", "pct": 12}, {"name": "docx", "pct": 0}]},
    }});
    let script = json!({"control": {"get_usage": {"$response": usage, "$delay_ms": 200}}});
    let f = fixture_with(&[("FAKE_CLAUDE_SCRIPT", script.to_string())]);
    let s = f.create(SessionOptions::default()).await;
    let (behaviors, skills) = tokio::join!(s.get_usage_behaviors(), s.get_weekly_used_skills());
    // SDK 0.3.305: every window carries `recommendations` (empty when the
    // CLI sends none).
    let want = json!({
        "day": {"requestCount": 10, "sessionCount": 1,
                "behaviors": [{"key": "max_effort", "pct": 40, "count": 4}],
                "recommendations": []},
        "week": {"requestCount": 50, "sessionCount": 3,
                 "behaviors": [{"key": "workflow", "pct": 25.5, "count": 12}],
                 "recommendations": []},
    });
    assert_eq!(behaviors, Some(want.clone()));
    assert_eq!(skills, Some(vec!["pdf".to_owned()]));
    assert_eq!(s.get_usage_behaviors().await, Some(want));
    assert_eq!(usage_scans(&f), vec![json!({"subtype": "get_usage"})]);

    // The fake CLI's default answer has no `behaviors`: a non-subscriber.
    let f = fixture();
    let s = f.create(SessionOptions::default()).await;
    assert_eq!(s.get_usage_behaviors().await, None);
    assert_eq!(s.get_weekly_used_skills().await, Some(vec![]));
    assert_eq!(usage_scans(&f).len(), 1);

    let script = json!({"control": {"get_usage": {"$error": "scan failed"}}});
    let f = fixture_with(&[("FAKE_CLAUDE_SCRIPT", script.to_string())]);
    let s = f.create(SessionOptions::default()).await;
    assert_eq!(s.get_usage_behaviors().await, None);
    assert_eq!(s.get_weekly_used_skills().await, None);
    assert_eq!(usage_scans(&f).len(), 2);
}

/// S17: a resumed transcript with no `session_usage` row starts from the
/// estimate of every API call in its transcripts — the main JSONL (deduped
/// by message id + request id) AND its subagent transcripts — which the
/// first subscriber's `usage_snapshot` carries and the row keeps. The
/// resumed CLI's `cost-state` checkpoint is its starting "cumulative" cost,
/// so only the growth past it is added, and a smaller per-turn `num_turns`
/// is not a reset. An existing row wins over the transcript.
#[tokio::test]
async fn a_legacy_transcript_seeds_the_usage_estimate() {
    let f = fixture();
    let cwd = f.cwd();
    // The CLI's transcript dir (the resume replay) and the project root (the
    // estimate) — one dir in a real install, where the profile's `projects`
    // links to `~/.claude/projects`.
    let dirs = [
        env()
            .config
            .join("projects")
            .join(paths::sdk_project_dir_name(&cwd)),
        paths::project_root(&cwd),
    ];
    // Content-block splits chain one after another, as the CLI writes them
    // (the transcript read follows `parentUuid` back from the leaf).
    let assistant = |uuid: &str, parent: &str, id: &str, model: &str, usage: Value| {
        json!({"type": "assistant", "uuid": uuid, "parentUuid": parent, "cwd": cwd,
               "requestId": format!("req_{id}"),
               "message": {"role": "assistant", "id": id, "model": model, "usage": usage,
                           "content": [{"type": "text", "text": "answer"}]}})
    };
    let big = json!({"input_tokens": 10, "output_tokens": 20, "cache_read_input_tokens": 300,
                     "cache_creation_input_tokens": 40});
    let small = json!({"input_tokens": 1, "output_tokens": 2});
    let records = |id: &str| {
        vec![
            json!({"type": "user", "uuid": "u1", "parentUuid": null, "cwd": cwd,
                   "timestamp": "2026-01-02T03:04:05.000Z", "message": {"role": "user", "content": "q"}}),
            assistant("a1", "u1", "msg_1", "claude-opus-5-5", big.clone()),
            assistant("a2", "a1", "msg_1", "claude-opus-5-5", big.clone()),
            assistant("a3", "a2", "msg_2", "claude-haiku-5-5", small.clone()),
            json!({"type": "cost-state", "sessionId": id, "totalCostUSD": 5.0,
                   "totalAPIDuration": 9000, "modelUsage": {}}),
        ]
    };
    let write = |id: &str| {
        for dir in &dirs {
            std::fs::create_dir_all(dir.join(id).join("subagents")).unwrap();
            let body: String = records(id)
                .iter()
                .map(|l| {
                    let mut l = l.clone();
                    l["sessionId"] = json!(id);
                    format!("{l}\n")
                })
                .collect();
            std::fs::write(dir.join(format!("{id}.jsonl")), body).unwrap();
            // A Task subagent's own call: real spend, but not a main turn.
            let sub = assistant("s1", "x", "msg_sub", "claude-sonnet-5-5", small.clone());
            std::fs::write(
                dir.join(id).join("subagents/agent-a1.jsonl"),
                format!("{sub}\n"),
            )
            .unwrap();
        }
    };
    let first_usage = |s: Arc<Session>| async move {
        let mut sub = s.subscribe(None, None);
        until(&mut sub, is("usage_snapshot")).await.pop().unwrap()["usage"].clone()
    };
    let turn = |s: Arc<Session>, cost: f64, turns: u32| async move {
        let mut sub = s.subscribe(None, None);
        until(&mut sub, is("tips")).await;
        let script = json!({"steps": [{"$text": "ok"}],
                            "result": {"total_cost_usd": cost, "num_turns": turns}});
        s.send_input(&format!("script:{script}"), &[], SendOptions::default());
        until(&mut sub, is("usage_snapshot")).await.pop().unwrap()["usage"].clone()
    };

    let id = "6c1e3a1c-2a52-4c3e-9b0e-2f7f1a1c0b17";
    write(id);
    let want = claudius_core::usage_seed::estimate_usage_from_transcripts(&cwd, id).unwrap();
    assert_eq!(want.num_turns, 2.0, "subagent calls aren't main turns");
    assert_eq!(
        want.input_tokens, 12.0,
        "msg_1 once, msg_2, the subagent call"
    );
    let models = want.model_usage.as_ref().unwrap();
    assert_eq!(
        models.keys().collect::<Vec<_>>(),
        ["claude-opus-5-5", "claude-haiku-5-5", "claude-sonnet-5-5"]
    );
    let s = f.mgr.get_or_resume(id).await.expect("resumed");
    assert_eq!(first_usage(s.clone()).await, want.to_json());
    assert_eq!(sessions_db::get_session_usage(&cwd, id), Some(want.clone()));

    // The CLI restored the $5 checkpoint: $5.50 "cumulative" is $0.50 new.
    let u = turn(s.clone(), 5.5, 3).await;
    let close = |v: &Value, x: f64| (v.as_f64().unwrap() - x).abs() < 1e-9;
    assert!(close(&u["totalCostUsd"], want.total_cost_usd + 0.5), "{u}");
    assert_eq!(u["numTurns"].as_f64(), Some(want.num_turns + 3.0), "{u}");
    // A smaller per-turn `num_turns` is just a shorter turn, not a reset.
    let u = turn(s.clone(), 5.75, 1).await;
    assert!(close(&u["totalCostUsd"], want.total_cost_usd + 0.75), "{u}");
    assert_eq!(u["numTurns"].as_f64(), Some(want.num_turns + 4.0), "{u}");
    let row = sessions_db::get_session_usage(&cwd, id).unwrap();
    assert!((row.total_cost_usd - (want.total_cost_usd + 0.75)).abs() < 1e-9);
    f.mgr.remove(id).await;

    // A persisted row wins over the transcript.
    let id = "6c1e3a1c-2a52-4c3e-9b0e-2f7f1a1c0b18";
    write(id);
    let row = sessions_db::UsageTotals {
        total_cost_usd: 2.5,
        num_turns: 7.0,
        input_tokens: 70.0,
        ..Default::default()
    };
    sessions_db::save_session_usage(&cwd, id, &row).unwrap();
    let s = f.mgr.get_or_resume(id).await.expect("resumed");
    assert_eq!(first_usage(s).await, row.to_json());
    f.mgr.remove(id).await;
}

/// The `seed_read_state` requests the fake CLI has read, as `(path, mtime)`.
fn seeds(f: &Fixture) -> Vec<(String, i64)> {
    f.log()
        .iter()
        .filter(|m| m["request"]["subtype"] == "seed_read_state")
        .map(|m| {
            let r = &m["request"];
            (
                r["path"].as_str().unwrap().to_owned(),
                r["mtime"].as_i64().unwrap(),
            )
        })
        .collect()
}

/// Wait until `n` seeds have arrived, then a little longer to see that no
/// more follow.
async fn settled_seeds(f: &Fixture, n: usize) -> Vec<(String, i64)> {
    for _ in 0..250 {
        if seeds(f).len() >= n {
            break;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    tokio::time::sleep(Duration::from_millis(200)).await;
    seeds(f)
}

/// What the re-seed sends for `path`: its floored Node `mtimeMs`.
fn seed_of(path: &Path) -> (String, i64) {
    let modified = std::fs::metadata(path).unwrap().modified().unwrap();
    (
        path.display().to_string(),
        claudius_core::read_paths::floored_mtime_ms(modified),
    )
}

/// B2.3: every file the model Read is replayed through `seed_read_state`
/// after each `compact_boundary`, in first-read order, skipping a path whose
/// stat fails; a refused seed doesn't stop the pass.
#[tokio::test]
async fn a_compaction_reseeds_every_read_path() {
    let dir = tempfile::tempdir().unwrap();
    let dir = dir.path().canonicalize().unwrap();
    let [a, b, c, gone] = ["a.txt", "b.txt", "c.txt", "gone.txt"].map(|n| dir.join(n));
    for p in [&a, &b, &c] {
        std::fs::write(p, "x").unwrap();
    }
    let read =
        |id: &str, p: &Path| tool_use(id, "Read", json!({"file_path": p.display().to_string()}));
    let compact = json!({"type": "system", "subtype": "compact_boundary",
                         "compact_metadata": {"trigger": "auto", "pre_tokens": 1000}});
    let script = json!({
        "control": {"seed_read_state": {"$error": "not now"}},
        "turns": [
            {"match": "first", "steps": [
                assistant_blocks(json!([read("t1", &a), tool_use("t2", "Bash", json!({"command": "cat /x"})),
                                        read("t3", &gone), read("t4", &a)])),
                // Only a system message's subtype counts.
                {"type": "tool_progress", "subtype": "compact_boundary"},
            ]},
            {"match": "second", "steps": [assistant_blocks(json!([read("t5", &b)])), compact]},
            {"match": "third", "steps": [assistant_blocks(json!([read("t6", &c)])), compact]},
        ],
    });
    let f = fixture_with(&[("FAKE_CLAUDE_SCRIPT", script.to_string())]);
    let s = f.create(SessionOptions::default()).await;
    let mut sub = s.subscribe(None, None);
    until(&mut sub, is("ready")).await;

    turn(&s, &mut sub, "first").await;
    turn(&s, &mut sub, "second").await;
    assert_eq!(settled_seeds(&f, 2).await, vec![seed_of(&a), seed_of(&b)]);

    // A deleted file drops out; the set keeps growing across compactions.
    let (seed_b, seed_c) = (seed_of(&b), seed_of(&c));
    std::fs::remove_file(&a).unwrap();
    turn(&s, &mut sub, "third").await;
    assert_eq!(settled_seeds(&f, 4).await[2..], [seed_b, seed_c]);
    f.mgr.remove(&s.id).await;
}

/// A path Read while a re-seed pass is under way is still visited, as when
/// iterating the live JS `Set`. (`d` lands while `b`'s seed is in flight: a
/// full round trip after the message Reading it, which the consume loop
/// handles first.)
#[tokio::test]
async fn a_read_during_the_reseed_pass_is_seeded_too() {
    let dir = tempfile::tempdir().unwrap();
    let dir = dir.path().canonicalize().unwrap();
    let [a, b, d] = ["a.txt", "b.txt", "d.txt"].map(|n| dir.join(n));
    for p in [&a, &b, &d] {
        std::fs::write(p, "x").unwrap();
    }
    let read =
        |id: &str, p: &Path| tool_use(id, "Read", json!({"file_path": p.display().to_string()}));
    let script = json!({
        // Each seed's answer is followed by a message Reading `d`.
        "control": {"seed_read_state": {"$emit": [assistant_blocks(json!([read("t9", &d)]))]}},
        "turns": [{"match": "go", "steps": [
            assistant_blocks(json!([read("t1", &a), read("t2", &b)])),
            {"type": "system", "subtype": "compact_boundary"},
        ]}],
    });
    let f = fixture_with(&[("FAKE_CLAUDE_SCRIPT", script.to_string())]);
    let s = f.create(SessionOptions::default()).await;
    let mut sub = s.subscribe(None, None);
    until(&mut sub, is("ready")).await;
    turn(&s, &mut sub, "go").await;
    assert_eq!(
        settled_seeds(&f, 3).await,
        vec![seed_of(&a), seed_of(&b), seed_of(&d)]
    );
    f.mgr.remove(&s.id).await;
}

const THINKING_400: &str = "API Error: 400 messages.25.content.23: `thinking` or `redacted_thinking` blocks in the latest assistant message cannot be modified. These blocks must remain as they were in the original response.";

/// A transcript whose last turn (started by "go deep") carries a thinking
/// block: the recovery plan resumes at `a0` and re-sends "go deep".
fn poisoned_transcript(f: &Fixture, id: &str) {
    let cwd = f.cwd();
    let dir = env()
        .config
        .join("projects")
        .join(paths::sdk_project_dir_name(&cwd));
    std::fs::create_dir_all(&dir).unwrap();
    let rec = |uuid: &str, parent: Option<&str>, ty: &str, content: Value| {
        json!({"type": ty, "uuid": uuid, "parentUuid": parent, "cwd": cwd, "sessionId": id,
               "timestamp": "2026-01-02T03:04:05.000Z", "message": {"role": ty, "content": content}})
    };
    let records = [
        rec("u0", None, "user", json!("first prompt")),
        rec(
            "a0",
            Some("u0"),
            "assistant",
            json!([{"type": "text", "text": "ok"}]),
        ),
        rec("u1", Some("a0"), "user", json!("go deep")),
        rec(
            "a1",
            Some("u1"),
            "assistant",
            json!([
                {"type": "thinking", "thinking": "", "signature": "sig"},
                {"type": "tool_use", "id": "toolu_1", "name": "Bash", "input": {"command": "ls"}},
            ]),
        ),
        rec(
            "tr1",
            Some("a1"),
            "user",
            json!([{"type": "tool_result", "tool_use_id": "toolu_1", "content": "out"}]),
        ),
    ];
    let body: String = records.iter().map(|r| format!("{r}\n")).collect();
    std::fs::write(dir.join(format!("{id}.jsonl")), body).unwrap();
}

/// The `error` events a late subscriber replays from `s`.
async fn replayed_errors(s: &Arc<Session>) -> Vec<String> {
    let mut sub = s.subscribe(None, None);
    until(&mut sub, is("replay_done"))
        .await
        .iter()
        .filter(|e| e["type"] == "error")
        .map(|e| e["message"].as_str().unwrap_or_default().to_owned())
        .collect()
}

/// Wait until the live session for `id` replays an error containing
/// `needle`, and return it.
async fn live_with_error(f: &Fixture, id: &str, needle: &str) -> Arc<Session> {
    for _ in 0..300 {
        if let Some(s) = f.mgr.get(id)
            && replayed_errors(&s).await.iter().any(|m| m.contains(needle))
        {
            return s;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    panic!("no live session for {id} reported {needle:?}");
}

fn count(f: &Fixture, pred: impl Fn(&Value) -> bool) -> usize {
    f.log().iter().filter(|m| pred(m)).count()
}

fn initializes(f: &Fixture) -> usize {
    count(f, |m| m["request"]["subtype"] == "initialize")
}

fn prompts(f: &Fixture, text: &str) -> usize {
    count(f, |m| {
        m["type"] == "user" && m["message"]["content"].to_string().contains(text)
    })
}

/// The thinking-block replay 400 rebuilds the session under its id, resumed
/// at the boundary before the poisoned turn with its live settings, and
/// re-sends the prompt that started it. Three rebuilds in a row without a
/// successful turn is the cap; a successful turn resets it.
#[tokio::test]
async fn a_thinking_replay_error_rebuilds_the_session_in_place() {
    let script = json!({"turns": [
        // Surfaced twice in one turn: still one recovery per query.
        {"match": "go deep", "repeat": true,
         "steps": [{"$text": THINKING_400}, {"$text": THINKING_400}],
         "result": {"subtype": "error_during_execution", "is_error": true}},
    ]});
    let f = fixture_with(&[("FAKE_CLAUDE_SCRIPT", script.to_string())]);
    let id = "4b2f7f3e-9c1d-4e5a-8b6c-1d2e3f4a5b6c";
    poisoned_transcript(&f, id);
    let s0 = f.mgr.get_or_resume(id).await.expect("resumed");
    let mut sub = s0.subscribe(None, None);
    until(&mut sub, is("ready")).await;
    s0.set_permission_mode("acceptEdits", false).await;
    s0.set_model(Some("claude-sonnet-5-5".into()), "picker")
        .await
        .unwrap();
    s0.send_input("go deep", &[], SendOptions::default());

    // Rebuilt three times (attempts 1-3); the fourth 400 gives up.
    let last = live_with_error(&f, id, "Auto-recovery gave up").await;
    assert!(!Arc::ptr_eq(&last, &s0), "rebuilt under the same id");
    assert_eq!(initializes(&f), 4, "the first CLI and three rebuilds");
    assert_eq!(
        prompts(&f, "go deep"),
        4,
        "sent, then re-sent by each rebuild"
    );
    let errors = replayed_errors(&last).await;
    let announced = errors
        .iter()
        .filter(|m| m.starts_with("Thinking-block replay error (HTTP 400)"))
        .count();
    assert_eq!(announced, 1, "{errors:?}");
    assert_eq!(
        errors.last().map(String::as_str),
        Some(
            "Auto-recovery gave up after repeated thinking-block failures on the same turn \u{2014} please start a new session."
        )
    );
    // The rebuild resumed at the boundary with the live model and mode.
    let argv: Vec<String> =
        serde_json::from_str(&std::fs::read_to_string(&f.argv).unwrap()).unwrap();
    for want in [
        format!("--resume={id}"),
        "--resume-session-at=a0".into(),
        "--model=claude-sonnet-5-5".into(),
        "--permission-mode=acceptEdits".into(),
    ] {
        assert!(argv.contains(&want), "{want}: {argv:?}");
    }
    // Its replay stops at the boundary.
    let mut sub = last.subscribe(None, None);
    let replay = until(&mut sub, is("replay_done")).await;
    let uuids: Vec<&str> = replay
        .iter()
        .filter(|e| e["type"] == "sdk")
        .filter_map(|e| e["message"]["uuid"].as_str())
        .collect();
    assert!(uuids.contains(&"a0") && !uuids.contains(&"a1"), "{uuids:?}");
    drop(sub);

    // The count outlives a rebuild that isn't a recovery: a new session
    // object hitting the 400 gives up at once (one recovery per query, and
    // the cap is reached)...
    f.mgr.restart_in_place(id).await.unwrap();
    let s4 = f.mgr.get(id).unwrap();
    s4.send_input("go deep", &[], SendOptions::default());
    let gave_up = live_with_error(&f, id, "Auto-recovery gave up").await;
    assert!(Arc::ptr_eq(&gave_up, &s4));
    assert_eq!(initializes(&f), 5);
    // ...until a successful turn resets it: the next 400 rebuilds again, up
    // to the cap.
    f.mgr.restart_in_place(id).await.unwrap();
    let s5 = f.mgr.get(id).unwrap();
    let mut sub = s5.subscribe(None, None);
    until(&mut sub, is("replay_done")).await;
    turn(&s5, &mut sub, "fine").await;
    s5.send_input("go deep", &[], SendOptions::default());
    drop(sub);
    let last = live_with_error(&f, id, "Auto-recovery gave up").await;
    assert!(!Arc::ptr_eq(&last, &s5));
    assert_eq!(initializes(&f), 9, "s5, then three rebuilds");
    f.mgr.remove(id).await;
}

/// Without a transcript there is no boundary to resume at: the error says
/// so and the session stays as it is.
#[tokio::test]
async fn a_thinking_replay_error_without_a_safe_point_is_reported() {
    let f = fixture();
    let s = f.create(SessionOptions::default()).await;
    let mut sub = s.subscribe(None, None);
    until(&mut sub, is("ready")).await;
    let prompt = format!("script:{}", json!([{"$text": THINKING_400}]));
    s.send_input(&prompt, &[], SendOptions::default());
    let evs = until(&mut sub, |e| {
        e["type"] == "error"
            && e["message"]
                .as_str()
                .is_some_and(|m| m.starts_with("Could not auto-recover"))
    })
    .await;
    assert!(evs.iter().any(|e| {
        e["type"] == "error"
            && e["message"]
                .as_str()
                .is_some_and(|m| m.starts_with("Thinking-block replay error"))
    }));
    assert!(Arc::ptr_eq(&f.mgr.get(&s.id).unwrap(), &s), "not rebuilt");
    assert_eq!(initializes(&f), 1);
    f.mgr.remove(&s.id).await;
}

/// The recovery reads the transcript as the SDK does (whole, lossily), so a
/// byte of invalid UTF-8 in an earlier turn doesn't stop the rebuild (I14b:
/// it was "Auto-recovery failed: stream did not contain valid UTF-8").
#[tokio::test]
async fn a_thinking_replay_recovery_reads_invalid_utf8() {
    let script = json!({"turns": [
        {"match": "go deep", "steps": [{"$text": THINKING_400}],
         "result": {"subtype": "error_during_execution", "is_error": true}},
    ]});
    let f = fixture_with(&[("FAKE_CLAUDE_SCRIPT", script.to_string())]);
    let id = "4b2f7f3e-9c1d-4e5a-8b6c-1d2e3f4a5b6e";
    poisoned_transcript(&f, id);
    let file = env()
        .config
        .join("projects")
        .join(paths::sdk_project_dir_name(&f.cwd()))
        .join(format!("{id}.jsonl"));
    let mut bytes = std::fs::read(&file).unwrap();
    let at = bytes.windows(5).position(|w| w == b"first").unwrap() + 5;
    bytes.insert(at, 0xff);
    std::fs::write(&file, bytes).unwrap();
    let s0 = f.mgr.get_or_resume(id).await.expect("resumed");
    let mut sub = s0.subscribe(None, None);
    until(&mut sub, is("ready")).await;
    s0.send_input("go deep", &[], SendOptions::default());
    eventually(20, "the rebuilt CLI", || initializes(&f) >= 2).await;
    let argv: Vec<String> =
        serde_json::from_str(&std::fs::read_to_string(&f.argv).unwrap()).unwrap();
    assert!(
        argv.contains(&"--resume-session-at=a0".to_owned()),
        "{argv:?}"
    );
    let errors = replayed_errors(&s0).await;
    assert!(
        !errors.iter().any(|m| m.starts_with("Auto-recovery failed")),
        "{errors:?}"
    );
    f.mgr.remove(id).await;
}

/// A transcript it can't read is none to the SDK's `getSessionMessages`
/// (its read catches and returns []), so the recovery finds no rewind
/// point rather than failing (I14b: it was "Auto-recovery failed:
/// Permission denied").
#[tokio::test]
async fn a_thinking_replay_recovery_over_an_unreadable_transcript_finds_no_point() {
    use std::os::unix::fs::PermissionsExt;
    // SAFETY: geteuid has no preconditions.
    if unsafe { libc::geteuid() } == 0 {
        return; // root reads a mode-0 file
    }
    let script = json!({"turns": [
        {"match": "go deep", "steps": [{"$text": THINKING_400}],
         "result": {"subtype": "error_during_execution", "is_error": true}},
    ]});
    let f = fixture_with(&[("FAKE_CLAUDE_SCRIPT", script.to_string())]);
    let id = "4b2f7f3e-9c1d-4e5a-8b6c-1d2e3f4a5b70";
    poisoned_transcript(&f, id);
    let file = env()
        .config
        .join("projects")
        .join(paths::sdk_project_dir_name(&f.cwd()))
        .join(format!("{id}.jsonl"));
    let s0 = f.mgr.get_or_resume(id).await.expect("resumed");
    let mut sub = s0.subscribe(None, None);
    until(&mut sub, is("ready")).await;
    std::fs::set_permissions(&file, std::fs::Permissions::from_mode(0o000)).unwrap();
    s0.send_input("go deep", &[], SendOptions::default());
    let starts = |e: &Value, p: &str| {
        e["type"] == "error" && e["message"].as_str().is_some_and(|m| m.starts_with(p))
    };
    let evs = until(&mut sub, |e| starts(e, "Could not auto-recover")).await;
    assert!(
        !evs.iter().any(|e| starts(e, "Auto-recovery failed")),
        "{evs:?}"
    );
    assert!(Arc::ptr_eq(&f.mgr.get(id).unwrap(), &s0), "not rebuilt");
    assert_eq!(initializes(&f), 1);
    f.mgr.remove(id).await;
}

/// A resume replays the transcript as the SDK's `getSessionMessages` reads
/// it: a byte of invalid UTF-8 is U+FFFD, not an unreadable transcript and
/// an empty replay.
#[tokio::test]
async fn a_resume_replays_a_transcript_holding_invalid_utf8() {
    let f = fixture();
    let id = "4b2f7f3e-9c1d-4e5a-8b6c-1d2e3f4a5b71";
    poisoned_transcript(&f, id);
    let file = env()
        .config
        .join("projects")
        .join(paths::sdk_project_dir_name(&f.cwd()))
        .join(format!("{id}.jsonl"));
    let mut bytes = std::fs::read(&file).unwrap();
    let at = bytes.windows(5).position(|w| w == b"first").unwrap() + 5;
    bytes.insert(at, 0xff);
    std::fs::write(&file, bytes).unwrap();
    let s = f.mgr.get_or_resume(id).await.expect("resumed");
    let mut sub = s.subscribe(None, None);
    let replay = until(&mut sub, is("replay_done")).await;
    let u0 = replay
        .iter()
        .find(|e| e["type"] == "sdk" && e["message"]["uuid"] == "u0")
        .expect("u0 replayed");
    assert_eq!(u0["message"]["message"]["content"], "first\u{fffd} prompt");
    f.mgr.remove(id).await;
}

/// The manager's rebuilds: an unknown id is gone; `restart_in_place` keeps
/// the id and the live settings, resumes the whole transcript and re-sends
/// nothing.
#[tokio::test]
async fn rebuilds_in_place_keep_the_id_and_settings() {
    use claudius_core::session_manager::RecoverError;
    let f = fixture();
    assert!(matches!(
        f.mgr.recover_in_place("nope", "a0", "p").await,
        Err(RecoverError::Gone)
    ));
    assert!(matches!(
        f.mgr.restart_in_place("nope").await,
        Err(RecoverError::Gone)
    ));

    let id = "4b2f7f3e-9c1d-4e5a-8b6c-1d2e3f4a5b6d";
    poisoned_transcript(&f, id);
    let s0 = f.mgr.get_or_resume(id).await.expect("resumed");
    s0.set_agent(Some("planner")).await;
    f.mgr.restart_in_place(id).await.unwrap();
    let s1 = f.mgr.get(id).unwrap();
    assert!(!Arc::ptr_eq(&s0, &s1));
    assert_eq!(s1.agent().as_deref(), Some("planner"));
    assert_eq!(s1.cwd, s0.cwd);
    let argv: Vec<String> =
        serde_json::from_str(&std::fs::read_to_string(&f.argv).unwrap_or_default())
            .unwrap_or_default();
    assert!(
        !argv.iter().any(|a| a.starts_with("--resume-session-at")),
        "{argv:?}"
    );
    assert_eq!(prompts(&f, "go deep"), 0);
    f.mgr.remove(id).await;
}

/// S26: the feedback nudge. After a turn that a prompt started, every tab
/// gets `{type, sessionId, surface}` (in that order) and the throttle is
/// stamped; it holds the nudge back until 6 h have passed. A result with no
/// prompt in this process and an errored turn never roll. A late tab
/// doesn't get it replayed.
#[tokio::test]
async fn the_feedback_nudge_reaches_every_tab_then_waits_six_hours() {
    use claudius_core::feedback_survey::{FeedbackSurvey, SURVEY_MIN_INTERVAL_MS};
    use std::sync::atomic::{AtomicI64, AtomicUsize, Ordering::SeqCst};

    const T: i64 = 1_800_000_000_000;
    let now = Arc::new(AtomicI64::new(T));
    let draws = Arc::new(AtomicUsize::new(0));
    let survey = {
        let (n, d) = (now.clone(), draws.clone());
        Arc::new(FeedbackSurvey::new(
            move || n.load(SeqCst),
            move || {
                d.fetch_add(1, SeqCst);
                0.0
            },
        ))
    };
    let result = json!({"type": "result", "subtype": "success", "is_error": false, "result": "",
                        "duration_ms": 1, "duration_api_ms": 1, "num_turns": 1, "total_cost_usd": 0.0,
                        "usage": {"input_tokens": 0, "output_tokens": 0}});
    let script = json!({
        // A result the CLI reports on its own, with no prompt sent yet.
        "control": {"apply_flag_settings": {"$response": {}, "$emit": [result]}},
        "turns": [{"match": "boom", "steps": [{"$text": "nope"}],
                   "result": {"subtype": "error_during_execution", "is_error": true}}],
    });
    let f = fixture_with(&[("FAKE_CLAUDE_SCRIPT", script.to_string())]);
    let s = f.create(SessionOptions::default()).await;
    s.set_feedback_survey(survey.clone());
    let mut a = s.subscribe(None, Some("tab-a".into()));
    let mut b = s.subscribe(None, None);
    let mut seen = until(&mut a, is("tips")).await;
    s.set_fast(true).await;
    seen.extend(
        until(&mut a, |e| {
            e["type"] == "sdk" && e["message"]["type"] == "result"
        })
        .await,
    );
    seen.extend(turn(&s, &mut a, "boom").await);
    seen.extend(turn(&s, &mut a, "hello").await);
    seen.extend(until(&mut a, is("feedback_survey")).await);
    let nudges: Vec<&Value> = seen.iter().filter(|e| is("feedback_survey")(e)).collect();
    assert_eq!(nudges.len(), 1, "{:?}", types(&seen));
    let want = format!(
        r#"{{"type":"feedback_survey","sessionId":"{}","surface":"claudius"}}"#,
        s.id
    );
    assert_eq!(nudges[0].to_string(), want);
    // Only "hello" rolled: a roll of 0 always offers.
    assert_eq!(draws.load(SeqCst), 1);
    assert_eq!(survey.last_shown_at(), T);
    let on_b = until(&mut b, is("feedback_survey")).await;
    assert_eq!(on_b.last().unwrap().to_string(), want);

    // The same clock: throttled, so no roll and no nudge ("third" only
    // makes sure "again" is done).
    let mut later = turn(&s, &mut a, "again").await;
    later.extend(turn(&s, &mut a, "third").await);
    assert!(
        !later.iter().any(is("feedback_survey")),
        "{:?}",
        types(&later)
    );
    assert_eq!(draws.load(SeqCst), 1);

    // 6 h on, the next turn offers it again.
    now.store(T + SURVEY_MIN_INTERVAL_MS, SeqCst);
    turn(&s, &mut a, "later").await;
    let ev = until(&mut a, is("feedback_survey")).await.pop().unwrap();
    assert_eq!(ev.to_string(), want);
    assert_eq!(draws.load(SeqCst), 2);
    assert_eq!(survey.last_shown_at(), T + SURVEY_MIN_INTERVAL_MS);

    let mut late = s.subscribe(None, None);
    let head = until(&mut late, is("tips")).await;
    assert!(
        !head.iter().any(is("feedback_survey")),
        "{:?}",
        types(&head)
    );
    f.mgr.remove(&s.id).await;
}

/// The `submit_feedback` control requests the CLI got, raw.
fn feedback_requests(f: &Fixture) -> Vec<String> {
    std::fs::read_to_string(&f.log)
        .unwrap_or_default()
        .lines()
        .filter(|l| l.contains(r#""subtype":"submit_feedback""#))
        .map(|l| {
            let m: Value = serde_json::from_str(l).unwrap();
            m["request"].to_string()
        })
        .collect()
}

/// S26: `submit_feedback` sends the CLI's `submit_feedback` control request
/// (`surface` defaults to "claudius"; `attach_transcript` is always sent)
/// and reports whether the CLI took it. A refusal, a session that never
/// started and an ended one are not forwarded.
#[tokio::test]
async fn submit_feedback_forwards_through_the_cli() {
    let f = fixture();
    let s = f.create(SessionOptions::default()).await;
    assert!(s.submit_feedback("[+1] nice", None, true).await.forwarded);
    assert!(
        s.submit_feedback("[-1] meh", Some("survey"), false)
            .await
            .forwarded
    );
    assert_eq!(
        feedback_requests(&f),
        [
            r#"{"subtype":"submit_feedback","description":"[+1] nice","surface":"claudius","attach_transcript":true}"#,
            r#"{"subtype":"submit_feedback","description":"[-1] meh","surface":"survey","attach_transcript":false}"#,
        ]
    );
    s.end().await;
    assert!(!s.submit_feedback("late", None, false).await.forwarded);
    assert_eq!(feedback_requests(&f).len(), 2, "written after the end");

    let script = json!({"control": {"submit_feedback": {"$error": "feedback disabled"}}});
    let f = fixture_with(&[("FAKE_CLAUDE_SCRIPT", script.to_string())]);
    let s = f.create(SessionOptions::default()).await;
    assert!(!s.submit_feedback("x", None, false).await.forwarded);
    assert_eq!(
        feedback_requests(&f),
        [
            r#"{"subtype":"submit_feedback","description":"x","surface":"claudius","attach_transcript":false}"#
        ]
    );
    f.mgr.remove(&s.id).await;

    let idle = Session::new(SessionOptions {
        cwd: Some(f.cwd()),
        ..Default::default()
    })
    .unwrap();
    assert!(!idle.submit_feedback("x", None, false).await.forwarded);
}

// ───────────────────────── nudges (S20) ─────────────────────────

const OVERLOADED_529: &str =
    r#"API Error: 529 {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}"#;

/// Turns for the nudges: `overloaded` (an assistant 529 and an
/// `error_during_execution` result), `billing` / `auth` / `auth text` (a
/// tagged or plain assistant error), `crash <stderr>` (the CLI dies).
fn nudge_script() -> Value {
    let asst = |text: &str, error: Option<&str>| {
        let mut m = json!({"type": "assistant", "parent_tool_use_id": null,
            "message": {"role": "assistant", "content": [{"type": "text", "text": text}]}});
        if let Some(e) = error {
            m["error"] = json!(e);
        }
        m
    };
    json!({"turns": [
        {"match": "overloaded", "repeat": true, "steps": [{"$text": OVERLOADED_529}],
         "result": {"subtype": "error_during_execution", "is_error": true, "errors": [OVERLOADED_529]}},
        {"match": "billing", "repeat": true,
         "steps": [asst("API Error: 400 credit balance is too low", Some("billing_error"))]},
        {"match": "auth text", "repeat": true,
         "steps": [asst("Failed to authenticate. API Error: 401 invalid x-api-key", None)]},
        {"match": "auth", "repeat": true,
         "steps": [asst("Failed to authenticate: OAuth token revoked", Some("authentication_failed"))]},
        {"match": "crash 529", "steps": [{"$text": "crashing"}, {"$stderr": OVERLOADED_529}, {"$exit": 1}]},
        {"match": "crash revoked", "steps": [{"$text": "crashing"},
            {"$stderr": "Failed to authenticate: OAuth token revoked"}, {"$exit": 1}]},
    ]})
}

const NUDGES: [&str; 4] = [
    "opus_overload_nudge",
    "long_context_credits_required",
    "auth_failed_required",
    "token_expiring_required",
];

/// Sends `prompt` and reads until the turn has run and is idle again.
async fn nudge_turn(s: &Session, sub: &mut Subscription, prompt: &str) -> Vec<Value> {
    s.send_input(prompt, &[], SendOptions::default());
    let mut evs = until(sub, |e| {
        e["type"] == "turn_status" && e["status"] == "running"
    })
    .await;
    evs.extend(until(sub, |e| e["type"] == "turn_status" && e["status"] == "idle").await);
    evs
}

fn nudges_in(evs: &[Value]) -> Vec<Value> {
    evs.iter()
        .filter(|e| NUDGES.contains(&e["type"].as_str().unwrap_or("")))
        .cloned()
        .collect()
}

/// Two overloaded turns in a row on Opus nudge every tab once, right after
/// the second turn's assistant 529; a success in between resets the streak,
/// later overloads stay quiet, and a reload's replay skips the nudge.
#[tokio::test]
async fn an_opus_overload_streak_nudges_once() {
    let f = fixture_with(&[("FAKE_CLAUDE_SCRIPT", nudge_script().to_string())]);
    let s = f
        .create(SessionOptions {
            model: Some("claude-opus-4-1".into()),
            ..Default::default()
        })
        .await;
    let mut a = s.subscribe(None, None);
    let mut b = s.subscribe(None, None);
    until(&mut a, is("ready")).await;
    until(&mut b, is("ready")).await;
    for p in ["overloaded 1", "fine", "overloaded 2"] {
        assert_eq!(
            nudges_in(&nudge_turn(&s, &mut a, p).await),
            Vec::<Value>::new(),
            "{p}"
        );
    }
    let evs = nudge_turn(&s, &mut a, "overloaded 3").await;
    let want = json!({"type": "opus_overload_nudge", "model": "claude-opus-4-1", "count": 2});
    assert_eq!(nudges_in(&evs), std::slice::from_ref(&want));
    // On the turn's first signal, right after its `sdk` event.
    let at = evs.iter().position(|e| e == &want).unwrap();
    assert_eq!(evs[at - 1]["message"]["type"], "assistant");
    assert_eq!(evs[at + 1]["message"]["subtype"], "error_during_execution");
    assert_eq!(
        nudges_in(&nudge_turn(&s, &mut a, "overloaded 4").await),
        Vec::<Value>::new()
    );
    // The other tab got everything as it was broadcast.
    let seen_b: Vec<Value> = std::iter::from_fn(|| b.rx.try_recv().ok()).collect();
    assert_eq!(nudges_in(&seen_b), std::slice::from_ref(&want));
    let mut late = s.subscribe(None, None);
    let replay = until(&mut late, is("replay_done")).await;
    assert_eq!(nudges_in(&replay), Vec::<Value>::new());
    assert_eq!(nudges_in(&s.buffer_snapshot()), [want]);
    f.mgr.remove(&s.id).await;
}

/// The same overloads on Sonnet count but never nudge.
#[tokio::test]
async fn no_overload_nudge_off_opus() {
    let f = fixture_with(&[("FAKE_CLAUDE_SCRIPT", nudge_script().to_string())]);
    let s = f
        .create(SessionOptions {
            model: Some("claude-sonnet-4-5".into()),
            ..Default::default()
        })
        .await;
    let mut sub = s.subscribe(None, None);
    until(&mut sub, is("ready")).await;
    for p in ["overloaded 1", "overloaded 2", "overloaded 3"] {
        assert_eq!(
            nudges_in(&nudge_turn(&s, &mut sub, p).await),
            Vec::<Value>::new(),
            "{p}"
        );
    }
    f.mgr.remove(&s.id).await;
}

/// The long-context nudge needs the 1M beta; it and the auth nudge fire once
/// per session, the revoked login with its reason.
#[tokio::test]
async fn the_billing_and_auth_nudges_fire_once() {
    let f = fixture_with(&[("FAKE_CLAUDE_SCRIPT", nudge_script().to_string())]);
    let s = f
        .create(SessionOptions {
            model: Some("claude-opus-4-1[1m]".into()),
            enable_1m_context: Some(true),
            ..Default::default()
        })
        .await;
    let mut sub = s.subscribe(None, None);
    until(&mut sub, is("ready")).await;
    let mut seen = vec![];
    for p in ["billing 1", "billing 2", "auth 1", "auth 2", "auth text"] {
        seen.extend(nudge_turn(&s, &mut sub, p).await);
    }
    assert_eq!(
        nudges_in(&seen),
        [
            json!({"type": "long_context_credits_required", "model": "claude-opus-4-1[1m]"}),
            json!({"type": "auth_failed_required", "model": "claude-opus-4-1[1m]", "reason": "oauth_revoked"}),
        ]
    );
    f.mgr.remove(&s.id).await;

    let s = f.create(SessionOptions::default()).await;
    let mut sub = s.subscribe(None, None);
    until(&mut sub, is("ready")).await;
    let mut seen = vec![];
    for p in ["billing", "auth text", "auth"] {
        seen.extend(nudge_turn(&s, &mut sub, p).await);
    }
    assert_eq!(
        nudges_in(&seen),
        [json!({"type": "auth_failed_required", "model": ""})]
    );
    f.mgr.remove(&s.id).await;
}

/// A CLI that dies with a 529 or a revoked login on stderr: the thrown
/// error is broadcast, then counted like the synthetic message.
#[tokio::test]
async fn a_thrown_overload_or_auth_failure_nudges() {
    let f = fixture_with(&[("FAKE_CLAUDE_SCRIPT", nudge_script().to_string())]);
    let s = f
        .create(SessionOptions {
            model: Some("claude-opus-4-1".into()),
            ..Default::default()
        })
        .await;
    let mut sub = s.subscribe(None, None);
    until(&mut sub, is("ready")).await;
    nudge_turn(&s, &mut sub, "overloaded").await;
    let evs = nudge_turn(&s, &mut sub, "crash 529").await;
    let err = evs.iter().position(|e| e["type"] == "error").unwrap();
    let msg = evs[err]["message"].as_str().unwrap();
    assert!(
        msg.contains("exited with code 1") && msg.contains("Overloaded"),
        "{msg}"
    );
    assert_eq!(
        evs[err + 1],
        json!({"type": "opus_overload_nudge", "model": "claude-opus-4-1", "count": 2})
    );
    assert_eq!(nudges_in(&evs).len(), 1);
    f.mgr.remove(&s.id).await;

    let s = f.create(SessionOptions::default()).await;
    let mut sub = s.subscribe(None, None);
    until(&mut sub, is("ready")).await;
    let evs = nudge_turn(&s, &mut sub, "crash revoked").await;
    let err = evs.iter().position(|e| e["type"] == "error").unwrap();
    assert_eq!(
        evs[err + 1],
        json!({"type": "auth_failed_required", "model": "", "reason": "oauth_revoked"})
    );
    assert_eq!(nudges_in(&evs).len(), 1);
    f.mgr.remove(&s.id).await;
}

/// Without account profiles (G02a / S30) there is no expiry to warn about:
/// the live init passes without a token nudge.
#[tokio::test]
async fn no_token_nudge_without_an_account_profile() {
    let f = fixture();
    let s = f.create(SessionOptions::default()).await;
    let mut sub = s.subscribe(None, None);
    let mut seen = until(&mut sub, |e| {
        e["type"] == "sdk" && e["message"]["subtype"] == "init"
    })
    .await;
    seen.extend(nudge_turn(&s, &mut sub, "hello").await);
    assert_eq!(nudges_in(&seen), Vec::<Value>::new());
    assert_eq!(nudges_in(&s.buffer_snapshot()), Vec::<Value>::new());
    f.mgr.remove(&s.id).await;
}

/// R04 (CC 2.1.300): fast mode is refused because usage credits ran out. The
/// engine retries that request without fast but leaves the flag on, so the
/// host turns it off on the `fast-mode-overage-rejected` notice, once. Other
/// notices leave it alone. (A replayed notice is skipped by the
/// `is_replaying` gate; transcripts don't carry `system` notices, so that
/// branch isn't driven here.)
#[tokio::test]
async fn a_credits_rejected_notice_turns_fast_mode_off() {
    let control_log = tempfile::NamedTempFile::new().unwrap();
    let notice = |key: &str| {
        json!({"type": "system", "subtype": "notification", "key": key,
               "text": "Fast mode is unavailable: out of credits",
               "priority": "high", "color": "red", "session_id": "$SESSION_ID",
               "uuid": "$UUID"})
    };
    let script = json!({
        "turns": [
            // An unrelated notice first: nothing is turned off.
            {"match": "other", "result": "ok", "steps": [notice("some-other-notice")]},
            {"match": "credits", "result": "ok", "steps": [notice("fast-mode-overage-rejected")]},
        ],
    });
    let f = fixture_with(&[
        ("FAKE_CLAUDE_SCRIPT", script.to_string()),
        (
            "FAKE_CLAUDE_CONTROL_LOG",
            control_log.path().display().to_string(),
        ),
    ]);
    let s = f.create(SessionOptions::default()).await;
    let mut sub = s.subscribe(None, None);
    until(&mut sub, is("tips")).await;
    // The user turns fast mode on, then a turn carries an unrelated notice.
    s.set_fast(true).await;
    let flags = || -> Vec<Value> {
        std::fs::read_to_string(control_log.path())
            .unwrap()
            .lines()
            .filter_map(|l| serde_json::from_str::<Value>(l).ok())
            .map(|m| m["request"].clone())
            .filter(|r| r["subtype"] == "apply_flag_settings")
            .map(|r| r["settings"].clone())
            .collect()
    };
    turn(&s, &mut sub, "other notice").await;
    assert_eq!(flags(), [json!({"fastMode": true})]);

    turn(&s, &mut sub, "credits are gone").await;
    // The notice's `setFast(false)` runs off the consume loop, so wait for it.
    for _ in 0..200 {
        if flags().len() > 1 {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(25)).await;
    }
    assert_eq!(
        flags(),
        [json!({"fastMode": true}), json!({"fastMode": false})],
        "the credits notice must turn fast mode off, once"
    );
    f.mgr.remove(&s.id).await;
}

/// R04 (CC 2.1.301): a resumed session's `ready` names the engine transcript
/// holding the turns before its last compaction, home shortened to `~`, both
/// on the start broadcast and on every later subscribe. A fresh session has
/// none, and neither has a resumed one whose file isn't under the home's
/// `.claude/projects`.
#[tokio::test]
async fn a_resumed_session_names_its_transcript_on_ready() {
    let f = fixture();
    let cwd = f.cwd();
    let id = "4ac19b7e-51f1-4e55-9b61-2b0f0a0c1d22";
    // The CLI's own copy, which the replay reads (the config dir).
    let sdk_dir = env()
        .config
        .join("projects")
        .join(paths::sdk_project_dir_name(&cwd));
    std::fs::create_dir_all(&sdk_dir).unwrap();
    let line = json!({"type":"user","uuid":"u1","parentUuid":null,"sessionId":id,"cwd":cwd,
                      "timestamp":"2026-01-02T03:04:05.000Z",
                      "message":{"role":"user","content":"earlier question"}});
    std::fs::write(sdk_dir.join(format!("{id}.jsonl")), format!("{line}\n")).unwrap();

    // A fresh session names nothing.
    let fresh = f.create(SessionOptions::default()).await;
    let mut fsub = fresh.subscribe(None, None);
    let seen = until(&mut fsub, is("tips")).await;
    for ev in seen.iter().filter(|e| is("ready")(e)) {
        assert!(ev.get("transcriptPath").is_none(), "{ev}");
    }
    assert_eq!(fresh.resumed_transcript_path(), None);
    f.mgr.remove(&fresh.id).await;

    // A resumed session whose transcript is only in the config dir: TS looks
    // under `homedir()/.claude/projects`, so there is nothing to name.
    let s = f.mgr.get_or_resume(id).await.expect("resumed from disk");
    assert_eq!(s.resumed_transcript_path(), None);
    f.mgr.remove(id).await;

    // The same transcript under the home's `.claude/projects`: named, with
    // the home shortened.
    let home = paths::home_dir();
    let home_dir = home
        .join(".claude")
        .join("projects")
        .join(paths::encode_project_dir(&cwd));
    std::fs::create_dir_all(&home_dir).unwrap();
    std::fs::write(home_dir.join(format!("{id}.jsonl")), format!("{line}\n")).unwrap();
    let want = format!(
        "~/.claude/projects/{}/{id}.jsonl",
        paths::encode_project_dir(&cwd)
    );
    let s = f.mgr.get_or_resume(id).await.expect("resumed from disk");
    assert_eq!(s.resumed_transcript_path().as_deref(), Some(want.as_str()));
    let mut sub = s.subscribe(None, None);
    let seen = until(&mut sub, is("tips")).await;
    let readys: Vec<&Value> = seen.iter().filter(|e| is("ready")(e)).collect();
    assert!(!readys.is_empty(), "{:?}", types(&seen));
    for ev in &readys {
        assert_eq!(ev["transcriptPath"], json!(want), "{ev}");
    }
    // A late subscriber's re-emitted `ready` carries it too.
    let mut late = s.subscribe(None, None);
    let seen = until(&mut late, is("mode_changed")).await;
    let ready = seen.iter().rfind(|e| is("ready")(e)).unwrap();
    assert_eq!(ready["transcriptPath"], json!(want), "{ready}");
    f.mgr.remove(id).await;
}

// ────────── CC 2.1.309: the rename mirror and the dangerous-rm deny (R05) ──────────

/// The cases `rust/scripts/cc2309-golden.mjs` recorded from the real TS.
fn cc2309() -> &'static Value {
    static F: OnceLock<Value> = OnceLock::new();
    F.get_or_init(|| {
        let path =
            PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/cc2309_golden.json");
        serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap()
    })
}

/// One recorded `session` case by name.
fn cc2309_case(name: &str) -> Value {
    cc2309()["session"]
        .as_array()
        .unwrap()
        .iter()
        .find(|c| c["name"] == name)
        .unwrap_or_else(|| panic!("no cc2309 session case {name}"))
        .clone()
}

/// The `rename_session` control requests the CLI got, raw.
fn rename_requests(f: &Fixture) -> Vec<String> {
    std::fs::read_to_string(&f.log)
        .unwrap_or_default()
        .lines()
        .filter(|l| l.contains(r#""subtype":"rename_session""#))
        .map(|l| {
            let m: Value = serde_json::from_str(l).unwrap();
            m["request"].to_string()
        })
        .collect()
}

/// The transcript of `id` under `cwd` (the SDK's project dir).
fn transcript_path(cwd: &str, id: &str) -> PathBuf {
    paths::sdk_projects_dir()
        .join(paths::sdk_project_dir_name(cwd))
        .join(format!("{id}.jsonl"))
}

/// A one-line transcript for `id`, as the CLI would have left it.
fn write_transcript(cwd: &str, id: &str) -> PathBuf {
    let file = transcript_path(cwd, id);
    std::fs::create_dir_all(file.parent().unwrap()).unwrap();
    std::fs::write(
        &file,
        format!(
            "{}\n",
            json!({"parentUuid": null, "isSidechain": false, "type": "user",
                   "message": {"role": "user", "content": "hello"},
                   "uuid": "00000000-0000-4000-8000-000000000001",
                   "timestamp": "2026-10-01T10:00:00.000Z", "cwd": cwd, "sessionId": id})
        ),
    )
    .unwrap();
    file
}

/// Every `customTitle` the transcript records, in order.
fn custom_titles(file: &Path) -> Vec<String> {
    std::fs::read_to_string(file)
        .unwrap_or_default()
        .lines()
        .filter_map(|l| serde_json::from_str::<Value>(l).ok())
        .filter(|m| m["type"] == "custom-title")
        .map(|m| m["customTitle"].as_str().unwrap_or_default().to_owned())
        .collect()
}

/// R05: `rename()` tells the running engine (`rename_session`, source
/// "host") and, when the transcript write fails, keeps the name in the
/// pending mirror unless the engine took it — the cases
/// `cc2309-golden.mjs` recorded (`session`).
#[tokio::test]
async fn rename_tells_the_engine_and_keeps_the_pending_mirror() {
    // "a rename with no transcript, the engine takes it": the CLI acks, so
    // nothing is left pending.
    let case = cc2309_case("a rename with no transcript, the engine takes it");
    let f = fixture();
    let s = f.create(SessionOptions::default()).await;
    let mut sub = s.subscribe(None, None);
    until(&mut sub, is("ready")).await;
    s.rename("New name").await.unwrap();
    assert_eq!(
        rename_requests(&f),
        [format!(
            r#"{{"subtype":"rename_session","title":"New name","source":"host","session_id":"{}"}}"#,
            s.id
        )]
    );
    assert_eq!(s.pending_title_mirror(), None, "{}", case["name"]);
    assert_eq!(s.title().as_deref(), Some("New name"));
    assert_eq!(
        until(&mut sub, is("session_title")).await.pop().unwrap(),
        json!({"type": "session_title", "title": "New name"})
    );
    f.mgr.remove(&s.id).await;

    // "a rename with a transcript and the engine": the append lands, so the
    // mirror is clear either way.
    let f = fixture();
    let s = f.create(SessionOptions::default()).await;
    let file = write_transcript(&f.cwd(), &s.id);
    s.rename("  New name  ").await.unwrap();
    assert_eq!(custom_titles(&file), ["New name"]);
    assert_eq!(s.pending_title_mirror(), None);
    f.mgr.remove(&s.id).await;

    // "a rename with no transcript, the engine refuses": the name waits.
    let script = json!({"control": {"rename_session": {"$error": "rename_session refused"}}});
    let f = fixture_with(&[("FAKE_CLAUDE_SCRIPT", script.to_string())]);
    let s = f.create(SessionOptions::default()).await;
    s.rename("New name").await.unwrap();
    assert_eq!(rename_requests(&f).len(), 1);
    assert_eq!(s.pending_title_mirror().as_deref(), Some("New name"));
    f.mgr.remove(&s.id).await;

    // "a rename the engine never answers": bounded at 5 s, then the name
    // waits as if the engine had refused.
    let case = cc2309_case("a rename the engine never answers");
    let script = json!({"control": {"rename_session": {"$no_reply": true}}});
    let f = fixture_with(&[("FAKE_CLAUDE_SCRIPT", script.to_string())]);
    let s = f.create(SessionOptions::default()).await;
    let t0 = std::time::Instant::now();
    s.rename("New name").await.unwrap();
    let took = t0.elapsed();
    assert!(
        took >= Duration::from_secs(5) && took < Duration::from_secs(30),
        "{took:?}"
    );
    assert_eq!(rename_requests(&f).len(), 1);
    assert_eq!(
        claudius_agent::js::stringify(&json!(s.pending_title_mirror())),
        case["mirror"].as_str().unwrap(),
        "{}",
        case["name"]
    );
    assert_eq!(s.title().as_deref(), Some("New name"));
    f.mgr.remove(&s.id).await;

    // "a rename with no transcript and no query": a session that never
    // started asks no engine and keeps the name.
    let idle = Session::new(SessionOptions {
        cwd: Some(f.cwd()),
        ..Default::default()
    })
    .unwrap();
    idle.rename("New name").await.unwrap();
    assert_eq!(idle.pending_title_mirror().as_deref(), Some("New name"));
    assert_eq!(idle.rename("   ").await, Err("title required".into()));
    assert_eq!(idle.pending_title_mirror().as_deref(), Some("New name"));
    // The row is the one the recorder dumped: the trimmed title.
    assert_eq!(
        sessions_db::get_session_title(&f.cwd(), &idle.id).unwrap(),
        Some("New name".into())
    );
}

/// R05: `start()` seeds the pending mirror from the stored title on the
/// fresh branch only — a rename from an earlier boot that may never have
/// reached the transcript. On resume the transcript may hold a newer TUI
/// rename, so nothing is re-sent (`session_titles_golden.json`, `start`).
#[tokio::test]
async fn start_seeds_the_pending_mirror_only_when_fresh() {
    let f = fixture();
    let id = "4d1d4f3a-5c8e-4c6f-9f21-4d1d4f3a5c8e";
    sessions_db::set_session_title(&f.cwd(), id, "  Named in an earlier boot  ").unwrap();
    let s = f
        .create(SessionOptions {
            id: Some(id.into()),
            ..Default::default()
        })
        .await;
    // The row as stored (`setSessionTitle` trimmed it), untrimmed by `start`.
    assert_eq!(
        s.pending_title_mirror().as_deref(),
        Some("Named in an earlier boot")
    );
    assert_eq!(s.title().as_deref(), Some("Named in an earlier boot"));
    f.mgr.remove(id).await;

    let resumed = f
        .create(SessionOptions {
            id: Some("9e2b1c70-1111-4222-8333-9e2b1c701111".into()),
            resume: Some(id.into()),
            ..Default::default()
        })
        .await;
    assert_eq!(resumed.pending_title_mirror(), None, "resume");
    assert_eq!(resumed.title().as_deref(), Some("Named in an earlier boot"));
    f.mgr.remove(&resumed.id).await;

    let untitled = f.create(SessionOptions::default()).await;
    assert_eq!(untitled.pending_title_mirror(), None, "no stored title");
    f.mgr.remove(&untitled.id).await;
}

/// R05: the turn boundary re-sends a rename the transcript didn't have yet
/// (`flushPendingTitleMirror`), and a rename that still can't reach it stays
/// pending for the next turn.
#[tokio::test]
async fn a_turn_boundary_flushes_the_pending_title_mirror() {
    let f = fixture();
    let s = f.create(SessionOptions::default()).await;
    let mut sub = s.subscribe(None, None);
    until(&mut sub, is("ready")).await;
    s.rename("Named early").await.unwrap();
    assert_eq!(s.pending_title_mirror(), None, "the engine took it");

    // With the engine refusing, the name waits for a transcript.
    let script = json!({"control": {"rename_session": {"$error": "nope"}}});
    let f = fixture_with(&[("FAKE_CLAUDE_SCRIPT", script.to_string())]);
    let s = f.create(SessionOptions::default()).await;
    let mut sub = s.subscribe(None, None);
    until(&mut sub, is("ready")).await;
    s.rename("Named early").await.unwrap();
    assert_eq!(s.pending_title_mirror().as_deref(), Some("Named early"));

    // A turn with no transcript on disk leaves it pending.
    s.send_input("hello", &[], SendOptions::default());
    until(&mut sub, |e| e["message"]["type"] == "result").await;
    assert_eq!(s.pending_title_mirror().as_deref(), Some("Named early"));

    // Once the CLI's transcript exists, the next turn lands the rename.
    let file = write_transcript(&f.cwd(), &s.id);
    s.send_input("hello again", &[], SendOptions::default());
    until(&mut sub, |e| e["message"]["type"] == "result").await;
    for _ in 0..200 {
        if s.pending_title_mirror().is_none() {
            break;
        }
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
    assert_eq!(s.pending_title_mirror(), None);
    assert_eq!(custom_titles(&file), ["Named early"]);
    f.mgr.remove(&s.id).await;
}

/// R05: in Bypass permissions mode the engine's dangerous-rm safety check is
/// answered with an immediate deny (the engine's reason plus the rewrite
/// hint) instead of a permission card; every other mode still parks one.
#[tokio::test]
async fn a_dangerous_rm_in_bypass_mode_is_denied_at_once() {
    let reason = "Dangerous rm operation on working directory or its ancestor: .";
    let ask = |ty: &str| {
        json!({"$control": {"subtype": "can_use_tool", "tool_name": "Bash",
            "input": {"command": "rm -rf ."}, "tool_use_id": "toolu_rm",
            "decision_reason": reason, "decision_reason_type": ty}})
    };
    let script = json!({"turns": [
        {"match": "rm", "steps": [
            ask("safetyCheck"),
            {"$text": "$LAST:/behavior"},
            {"$text": "$LAST:/message"},
        ]},
        {"match": "hook", "steps": [
            ask("hook"),
            {"$delay_ms": 50},
            {"$text": "parked"},
        ]},
    ]});
    let want = format!(
        "{reason}\n\n{}",
        claudius_core::dangerous_rm_deny::DANGEROUS_RM_REWRITE_HINT
    );

    for (mode, denied) in [("bypassPermissions", true), ("default", false)] {
        let f = fixture_with(&[("FAKE_CLAUDE_SCRIPT", script.to_string())]);
        let s = f
            .create(SessionOptions {
                permission_mode: Some(mode.into()),
                ..Default::default()
            })
            .await;
        let mut sub = s.subscribe(None, None);
        until(&mut sub, is("ready")).await;
        s.send_input("rm it", &[], SendOptions::default());
        if denied {
            let evs = until(&mut sub, |e| e["message"]["type"] == "result").await;
            let texts: Vec<String> = evs
                .iter()
                .filter(|e| e["message"]["type"] == "assistant")
                .filter_map(|e| e["message"]["message"]["content"][0]["text"].as_str())
                .map(str::to_owned)
                .collect();
            assert_eq!(texts, ["deny".to_owned(), want.clone()], "{texts:?}");
            assert!(
                !evs.iter().any(is("permission_request")),
                "no card: {:?}",
                types(&evs)
            );
        } else {
            let evs = until(&mut sub, is("permission_request")).await;
            let req = evs.last().unwrap();
            assert_eq!(req["toolName"], "Bash", "{req}");
            s.resolve_permission(
                req["requestId"].as_str().unwrap(),
                PermissionDecision::Deny { message: None },
            );
        }
        f.mgr.remove(&s.id).await;
    }
}
