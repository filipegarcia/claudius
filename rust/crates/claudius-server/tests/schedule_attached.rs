//! `GET /api/schedule/:id/runs` marks a running run `attached` while a
//! client has its live stream open, and `false` while nobody does (CC
//! 2.1.221's attached / unattended job). This test subscribes in process,
//! as the stream route does (G07c; `schedule_stream.rs` replays it on the
//! binary), against the router on a real socket and the scheduler running
//! the fake CLI.

mod common;

use std::collections::HashMap;
use std::path::Path;
use std::sync::Arc;
use std::time::{Duration, Instant};

use claudius_agent::js;
use claudius_core::paths;
use claudius_core::scheduler::{self, RunnerOptions};
use claudius_core::session_manager::SessionManager;
use claudius_server::{AppState, app};
use common::Payload;
use serde_json::{Value, json};

/// One blocking HTTP/1.1 request → (status, body).
fn request(port: u16, method: &str, url: &str) -> (u16, String) {
    let r = common::send(port, method, url, Payload::Bytes(b""));
    assert!(r.status != 0, "{}", r.head);
    (r.status, r.text())
}

async fn get(port: u16, url: &'static str) -> (u16, String) {
    tokio::task::spawn_blocking(move || request(port, "GET", url))
        .await
        .unwrap()
}

async fn until(what: &str, mut f: impl FnMut() -> bool) {
    let start = Instant::now();
    while !f() {
        assert!(
            start.elapsed() < Duration::from_secs(30),
            "timed out waiting for {what}"
        );
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
}

fn runs(port: u16, body: &str) -> Vec<Value> {
    let v: Value = serde_json::from_str(body).unwrap_or_else(|e| panic!("{port}: {e}: {body}"));
    v["runs"].as_array().unwrap().clone()
}

fn gate_marks(events: &Path) -> usize {
    std::fs::read_to_string(events)
        .unwrap_or_default()
        .lines()
        .filter(|l| *l == r#"{"mark":"gate"}"#)
        .count()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_watched_run_is_attached() {
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path().canonicalize().unwrap();
    let (home, config, project) = (root.join("home"), root.join("config"), root.join("project"));
    for d in [&home, &config, &project] {
        std::fs::create_dir_all(d).unwrap();
    }
    assert!(paths::set_home_override(home.clone()));
    assert!(paths::set_config_dir_override(config.clone()));
    let dir = home.join(".claude/claudius/schedule");
    std::fs::create_dir_all(&dir).unwrap();
    // Booted by the first route (nothing else boots it here). A boot that
    // threw is kept and thrown again (`schedule_routes.rs` replays that), so
    // this one has to succeed for the rest to run.
    std::fs::write(dir.join("jobs.json"), r#"{"jobs":[]}"#).unwrap();
    let jobs = json!({"jobs": [{
        "id": "w",
        "name": "watched",
        "cron": "0 0 29 2 *",
        "prompt": "[gate] w",
        "cwd": project,
        "enabled": false,
        "createdAt": 1,
        "updatedAt": 1,
    }]});

    let events = project.join("events.jsonl");
    let script = json!({"turns": [{
        "match": "[gate]",
        "steps": [{"$mark": "gate"}, {"$wait_file": "release"}],
    }]});
    let env: HashMap<String, String> = [
        ("PATH", std::env::var("PATH").unwrap_or_default()),
        ("HOME", home.display().to_string()),
        ("CLAUDE_CONFIG_DIR", config.display().to_string()),
        ("FAKE_CLAUDE_SCRIPT", js::stringify(&script)),
        ("FAKE_CLAUDE_EVENTS", events.display().to_string()),
    ]
    .into_iter()
    .map(|(k, v)| (k.to_owned(), v))
    .collect();
    let sched = scheduler::scheduler();
    assert_eq!(sched.store().root(), dir.as_path());
    sched.set_runner(RunnerOptions {
        claude_bin: Some(common::fake_bin()),
        env: Some(env),
    });
    scheduler::set_enabled(true);

    let state = AppState::new(Arc::new(SessionManager::default()), None, false);
    let l = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = l.local_addr().unwrap().port();
    tokio::spawn(async move { axum::serve(l, app(state)).await.unwrap() });

    // `await scheduler.boot()` on an empty store: nothing armed.
    assert_eq!(
        get(port, "/api/schedule").await,
        (200, r#"{"jobs":[]}"#.to_owned())
    );
    // A job saved now isn't armed by a boot that already ran.
    let mut armed = jobs.clone();
    armed["jobs"][0]["id"] = json!("e");
    armed["jobs"][0]["enabled"] = json!(true);
    armed["jobs"]
        .as_array_mut()
        .unwrap()
        .push(jobs["jobs"][0].clone());
    std::fs::write(dir.join("jobs.json"), js::stringify_pretty(&armed) + "\n").unwrap();
    let (_, body) = get(port, "/api/schedule/e").await;
    assert!(!body.contains("nextRunAt"), "{body}");

    let run = tokio::task::spawn_blocking(move || request(port, "POST", "/api/schedule/w/run-now"));
    until("the gate", || gate_marks(&events) >= 1).await;
    let (status, body) = get(port, "/api/schedule/w/runs").await;
    assert_eq!(status, 200);
    let list = runs(port, &body);
    assert_eq!(list.len(), 1, "{body}");
    let run_id = list[0]["id"].as_str().unwrap().to_owned();
    assert!(sched.is_run_live(&run_id));
    // Nobody watching: unattended.
    assert_eq!(
        body,
        format!(
            r#"{{"runs":[{{"id":"{run_id}","jobId":"w","startedAt":{},"status":"running","pid":{},"transcript":[],"attached":false}}]}}"#,
            list[0]["startedAt"],
            std::process::id()
        )
    );

    let watching = sched.subscribe_run(&run_id, Arc::new(|_: &Value| {}));
    let (_, body) = get(port, "/api/schedule/w/runs").await;
    let list = runs(port, &body);
    assert_eq!(list[0]["attached"], true, "{body}");
    assert!(
        body.ends_with(r#""transcript":[],"attached":true}]}"#),
        "{body}"
    );
    // `?limit` doesn't change it.
    let (_, body) = get(port, "/api/schedule/w/runs?limit=1").await;
    assert_eq!(runs(port, &body)[0]["attached"], true, "{body}");

    drop(watching);
    let (_, body) = get(port, "/api/schedule/w/runs").await;
    assert_eq!(runs(port, &body)[0]["attached"], false, "{body}");

    std::fs::write(project.join("release"), "").unwrap();
    let (status, body) = run.await.unwrap();
    assert_eq!((status, body), (202, format!(r#"{{"runId":"{run_id}"}}"#)));
    // Ended: no `attached`, watched or not.
    let watching = sched.subscribe_run(&run_id, Arc::new(|_: &Value| {}));
    let (_, body) = get(port, "/api/schedule/w/runs").await;
    let list = runs(port, &body);
    assert_eq!(list[0]["status"], "success", "{body}");
    assert!(list[0].get("attached").is_none(), "{body}");
    drop(watching);
    sched.shutdown().await;
}
