//! Dead-session restart (R03 / CC 2.1.311) replayed against the TS.
//!
//! `tests/fixtures/dead_session_golden.json`
//! (`rust/scripts/dead-session-golden.mjs`) records one timeline per scenario
//! on the real TS `sessionManager` and the real `POST /input`,
//! `queue/[uuid]/send-now`, `queue/send-all` and `GET /stream` handlers. This
//! replays the same steps against the real Rust router, served in process so
//! the probes can read the manager: after every step, whether the id is still
//! bound, which instance it is, `is_dead` / `came_up_live` / `done` /
//! `has_armed_loops`, the turn status and the persisted queue — plus every
//! route's status and body byte for byte.
//!
//! A step's own result is compared at once; the probe is given up to
//! [`SETTLE`] to reach the recorded state (TS settles on its event loop, Rust
//! on tokio tasks and a blocking pool).

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicI64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use bytes::Bytes;
use claudius_core::session::{RuntimeOptions, SessionOptions};
use claudius_core::session_manager::{DeadReason, SessionManager, dead_session_response};
use claudius_core::{paths, workspaces};
use claudius_server::{AppState, app};
use http_body_util::{BodyExt, Full};
use hyper_util::client::legacy::Client;
use hyper_util::client::legacy::connect::HttpConnector;
use hyper_util::rt::TokioExecutor;
use serde_json::{Map, Value, json};

type HttpClient = Client<HttpConnector, Full<Bytes>>;

/// How long a probe may take to reach the recorded state.
const SETTLE: Duration = Duration::from_secs(10);

/// A shorter settle while debugging a mismatch (`DEAD_SESSION_SETTLE_MS`).
fn settle() -> Duration {
    std::env::var("DEAD_SESSION_SETTLE_MS")
        .ok()
        .and_then(|v| v.parse().ok())
        .map(Duration::from_millis)
        .unwrap_or(SETTLE)
}

fn fixture() -> Value {
    serde_json::from_str(include_str!(
        "../../claudius-core/tests/fixtures/dead_session_golden.json"
    ))
    .unwrap()
}

fn fake_bin() -> PathBuf {
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
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../target/debug/claudius-fake-claude")
}

/// The recorder's instance counter: a number per `Session` object, assigned
/// the first time a step or a probe sees it. Every instance seen is kept
/// alive, so a dropped one's address can't be reused for the next.
#[derive(Default)]
struct Instances {
    by_ptr: HashMap<usize, u64>,
    keep: Vec<Arc<claudius_core::session::Session>>,
    next: u64,
}

impl Instances {
    fn of(&mut self, s: Option<&Arc<claudius_core::session::Session>>) -> Value {
        let Some(s) = s else { return Value::Null };
        let key = Arc::as_ptr(s) as usize;
        if let Some(n) = self.by_ptr.get(&key) {
            return json!(n);
        }
        self.next += 1;
        self.by_ptr.insert(key, self.next);
        self.keep.push(s.clone());
        json!(self.next)
    }
}

/// The recorder's `norm`: an enqueued uuid reads `$Q<n>`, any other uuid
/// `$UUID`, and the temp root `$ROOT`.
fn norm(v: &Value, queued: &[String], root: &str) -> Value {
    match v {
        Value::String(s) => {
            let s = s.replace(root, "$ROOT");
            if let Some(i) = queued.iter().position(|q| *q == s) {
                return json!(format!("$Q{}", i + 1));
            }
            if is_uuid(&s) {
                return json!("$UUID");
            }
            json!(s)
        }
        Value::Array(a) => Value::Array(a.iter().map(|x| norm(x, queued, root)).collect()),
        Value::Object(o) => Value::Object(
            o.iter()
                .map(|(k, x)| (k.clone(), norm(x, queued, root)))
                .collect(),
        ),
        v => v.clone(),
    }
}

fn is_uuid(s: &str) -> bool {
    let b = s.as_bytes();
    b.len() == 36
        && b.iter().enumerate().all(|(i, c)| match i {
            8 | 13 | 18 | 23 => *c == b'-',
            _ => c.is_ascii_hexdigit() && !c.is_ascii_uppercase(),
        })
}

struct Resp {
    status: u16,
    body: String,
}

async fn post(c: &HttpClient, url: String, body: Option<&str>) -> Resp {
    let bytes = Bytes::copy_from_slice(body.unwrap_or("").as_bytes());
    let mut req = hyper::Request::builder().method("POST").uri(url);
    if body.is_some() {
        req = req.header("content-type", "application/json");
    }
    let resp = c
        .request(req.body(Full::new(bytes)).unwrap())
        .await
        .unwrap();
    let status = resp.status().as_u16();
    let bytes = resp.into_body().collect().await.unwrap().to_bytes();
    Resp {
        status,
        body: String::from_utf8_lossy(&bytes).into_owned(),
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn dead_session_restart_matches_ts() {
    let fx = fixture();
    assert_eq!(fx["maxDeadRestarts"], json!(3));
    assert_eq!(fx["cooldownMs"], json!(300_000));
    // `deadSessionResponse` for every reason, error text included.
    for res in fx["responses"].as_array().unwrap() {
        let reason = match res["res"]["reason"].as_str().unwrap() {
            "gone" => DeadReason::Gone,
            "max_attempts" => DeadReason::MaxAttempts,
            "skipped" => DeadReason::Skipped,
            // `res.error ?? "unknown error"`.
            _ => match res["res"]["error"].as_str() {
                Some(e) => DeadReason::Failed(e.to_owned()),
                None => DeadReason::Skipped,
            },
        };
        let (error, status) = dead_session_response(&reason);
        assert_eq!(
            json!({"error": error, "status": status}),
            json!({"error": res["error"], "status": res["status"]}),
            "deadSessionResponse({})",
            res["res"]
        );
    }

    let root = tempfile::tempdir().unwrap();
    let root_path = root.path().canonicalize().unwrap().display().to_string();
    let (home, config) = (root.path().join("home"), root.path().join("config"));
    for d in [&home, &config] {
        std::fs::create_dir_all(d).unwrap();
    }
    let settings_file = home.join(".claude/settings.json");
    std::fs::create_dir_all(settings_file.parent().unwrap()).unwrap();
    paths::set_home_override(home.clone());
    paths::set_config_dir_override(config);

    let fake = fake_bin();
    let mgr = Arc::new(SessionManager::default());
    // The clock the restart budget reads: real time plus what `advance` adds.
    let offset = Arc::new(AtomicI64::new(0));
    {
        let offset = offset.clone();
        *mgr.dead_restart_clock.lock().unwrap() = Some(Arc::new(move || {
            claudius_core::now_ms() + offset.load(Ordering::SeqCst)
        }));
    }
    let router = app(AppState::new(mgr.clone(), None, true));
    let l = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}", l.local_addr().unwrap());
    tokio::spawn(async move { axum::serve(l, router).await.unwrap() });
    let c: HttpClient = Client::builder(TokioExecutor::new()).build(HttpConnector::new());
    let instances = Arc::new(Mutex::new(Instances::default()));
    let mut diffs: Vec<String> = Vec::new();

    for scenario in fx["scenarios"].as_array().unwrap() {
        let name = scenario["name"].as_str().unwrap();
        let id = scenario["id"].as_str().unwrap().to_owned();
        let cwd = root
            .path()
            .join("proj")
            .join(id.rsplit('-').next().unwrap());
        std::fs::create_dir_all(&cwd).unwrap();
        let cwd = cwd.canonicalize().unwrap().display().to_string();
        workspaces::create(workspaces::NewWorkspace {
            name: name.into(),
            root_path: cwd.clone(),
            icon: None,
            defaults: None,
        })
        .ok();
        let pid_file = PathBuf::from(&cwd).join("cli.pid");
        let mut env: HashMap<String, String> = HashMap::new();
        env.insert("PATH".into(), std::env::var("PATH").unwrap_or_default());
        env.insert("FAKE_CLAUDE_PID".into(), pid_file.display().to_string());
        env.insert(
            "FAKE_CLAUDE_LOG".into(),
            PathBuf::from(&cwd).join("stdin.log").display().to_string(),
        );
        // The wake-up the keep-alive scenario arms.
        if name.contains("wake-up") {
            env.insert(
                "FAKE_CLAUDE_SCRIPT".into(),
                json!({"turns": [{"match": "arm", "result": "armed", "steps": [
                    {"type": "assistant", "message": {"role": "assistant", "content": [
                        {"type": "tool_use", "id": "toolu_wake", "name": "ScheduleWakeup",
                         "input": {"delaySeconds": 3600, "reason": "watch", "prompt": "/loop watch", "noop": true}}]}},
                ]}]})
                .to_string(),
            );
        }
        let mut bin = fake.clone();
        let set_runtime = |bin: &PathBuf| {
            *mgr.runtime.lock().unwrap() = RuntimeOptions {
                claude_bin: Some(bin.clone()),
                env_override: Some(env.clone()),
            };
        };
        set_runtime(&bin);
        offset.store(0, Ordering::SeqCst);
        let _ = std::fs::remove_file(&settings_file);
        let mut queued: Vec<String> = Vec::new();
        let stream_closed: Arc<AtomicBool> = Arc::new(AtomicBool::new(false));
        let mut streaming = false;

        for (si, step) in scenario["steps"].as_array().unwrap().iter().enumerate() {
            let want = step["got"].as_object().unwrap().clone();
            let mut got = Map::new();
            let where_ = format!("{name} / step {si} {}", {
                let mut s = step.clone();
                s.as_object_mut().unwrap().remove("got");
                s
            });

            if step["create"] == true {
                match mgr
                    .create(SessionOptions {
                        id: Some(id.clone()),
                        cwd: Some(cwd.clone()),
                        ..Default::default()
                    })
                    .await
                {
                    Ok(s) => {
                        let n = instances.lock().unwrap().of(Some(&s));
                        got.insert("created".into(), n);
                    }
                    Err(e) => {
                        got.insert("threw".into(), json!(format!("{}: {e}", e.name())));
                    }
                }
            } else if let Some(p) = step["post"].as_array() {
                let route = p[0].as_str().unwrap();
                let body = p[1].as_str();
                let uuid = p[2].as_str().map(|u| match u.strip_prefix("$Q") {
                    Some(n) => queued[n.parse::<usize>().unwrap() - 1].clone(),
                    None => u.to_owned(),
                });
                let url = match route {
                    "input" => format!("{base}/api/sessions/{id}/input"),
                    "send-now" => format!(
                        "{base}/api/sessions/{id}/queue/{}/send-now",
                        uuid.as_deref().unwrap_or("")
                    ),
                    "send-all" => format!("{base}/api/sessions/{id}/queue/send-all"),
                    r => panic!("unknown route {r}"),
                };
                let r = post(&c, url, body).await;
                // An enqueued message's uuid reads `$Q<n>` from here on.
                if let Ok(v) = serde_json::from_str::<Value>(&r.body)
                    && v["queued"] == true
                    && let Some(u) = v["uuid"].as_str()
                {
                    queued.push(u.to_owned());
                }
                got.insert("status".into(), json!(r.status));
                let body = match serde_json::from_str::<Value>(&r.body) {
                    Ok(v) => claudius_agent::js::stringify(&norm(&v, &queued, &root_path)),
                    Err(_) => r.body.clone(),
                };
                got.insert("body".into(), json!(body));
            } else if let Some(r) = step["restart"].as_object() {
                let passive = r["passive"] == true;
                match mgr.restart_if_dead(&id, passive).await {
                    Ok(live) => {
                        let n = instances.lock().unwrap().of(Some(&live.session));
                        got.insert("ok".into(), json!(true));
                        got.insert("restarted".into(), json!(live.restarted));
                        got.insert("instance".into(), n);
                    }
                    Err(reason) => {
                        got.insert("ok".into(), json!(false));
                        let (name, error) = match &reason {
                            DeadReason::Gone => ("gone", Value::Null),
                            DeadReason::MaxAttempts => ("max_attempts", Value::Null),
                            DeadReason::Skipped => ("skipped", Value::Null),
                            DeadReason::Failed(e) => ("failed", json!(e)),
                        };
                        got.insert("reason".into(), json!(name));
                        got.insert("error".into(), error);
                    }
                }
            } else if let Some(q) = step["sendQueuedNow"].as_str() {
                let uuid =
                    queued[q.strip_prefix("$Q").unwrap().parse::<usize>().unwrap() - 1].clone();
                let dispatched = mgr
                    .get(&id)
                    .map(|s| json!(s.send_queued_now(&uuid, false).unwrap_or(false)))
                    .unwrap_or(Value::Null);
                got.insert("dispatched".into(), dispatched);
            } else if step["noteSuccess"] == true {
                mgr.note_thinking_recovery_success(&id);
            } else if let Some(ms) = step["advance"].as_i64() {
                offset.fetch_add(ms, Ordering::SeqCst);
            } else if let Some(text) = step["settings"].as_str() {
                if text == "$RM" {
                    let _ = std::fs::remove_file(&settings_file);
                } else {
                    std::fs::write(&settings_file, text).unwrap();
                }
            } else if let Some(which) = step["bin"].as_str() {
                bin = if which == "missing" {
                    PathBuf::from("/nonexistent/claude")
                } else {
                    fake.clone()
                };
                set_runtime(&bin);
            } else if step["stream"] == true {
                let req = hyper::Request::builder()
                    .method("GET")
                    .uri(format!("{base}/api/sessions/{id}/stream"))
                    .body(Full::new(Bytes::new()))
                    .unwrap();
                let resp = c.request(req).await.unwrap();
                got.insert("status".into(), json!(resp.status().as_u16()));
                streaming = true;
                stream_closed.store(false, Ordering::SeqCst);
                let closed = stream_closed.clone();
                tokio::spawn(async move {
                    let mut body = resp.into_body();
                    while let Some(Ok(_)) = body.frame().await {}
                    closed.store(true, Ordering::SeqCst);
                });
            } else if step["end"] == true {
                if let Some(s) = mgr.get(&id) {
                    s.end().await;
                }
            } else if step["kill"] == true {
                // A crash between turns: the CLI goes without the session
                // ending it.
                let pid = std::fs::read_to_string(&pid_file)
                    .unwrap()
                    .trim()
                    .to_owned();
                let ok = std::process::Command::new("kill")
                    .args(["-KILL", &pid])
                    .status()
                    .is_ok_and(|s| s.success());
                got.insert("killed".into(), json!(ok));
            } else if step["waitDead"] == true {
                let start = Instant::now();
                while start.elapsed() < settle() && !mgr.get(&id).is_some_and(|s| s.is_dead()) {
                    tokio::time::sleep(Duration::from_millis(20)).await;
                }
                got.insert(
                    "dead".into(),
                    json!(mgr.get(&id).is_some_and(|s| s.is_dead())),
                );
            }

            // The step's own result, then the probe once it has settled.
            let step_got = Value::Object(got.clone());
            let step_want = Value::Object(
                want.iter()
                    .filter(|(k, _)| got.contains_key(*k))
                    .map(|(k, v)| (k.clone(), v.clone()))
                    .collect(),
            );
            if step_got != step_want {
                diffs.push(format!("{where_}:\n  want {step_want}\n   got {step_got}"));
            }
            let probe_keys: Vec<String> = want
                .keys()
                .filter(|k| !got.contains_key(*k))
                .cloned()
                .collect();
            let want_probe = Value::Object(
                probe_keys
                    .iter()
                    .map(|k| (k.clone(), want[k].clone()))
                    .collect(),
            );
            let start = Instant::now();
            let mut probe;
            loop {
                probe = {
                    let s = mgr.get(&id);
                    let mut p = Map::new();
                    p.insert("bound".into(), json!(s.is_some()));
                    p.insert("instance".into(), instances.lock().unwrap().of(s.as_ref()));
                    let b = |v: Option<bool>| v.map(Value::from).unwrap_or(Value::Null);
                    p.insert("isDead".into(), b(s.as_ref().map(|s| s.is_dead())));
                    p.insert("cameUpLive".into(), b(s.as_ref().map(|s| s.came_up_live())));
                    p.insert("done".into(), b(s.as_ref().map(|s| s.is_done())));
                    p.insert(
                        "turnStatus".into(),
                        s.as_ref()
                            .map(|s| json!(s.status().as_str()))
                            .unwrap_or(Value::Null),
                    );
                    p.insert(
                        "hasArmedLoops".into(),
                        b(s.as_ref()
                            .map(|s| s.has_armed_loops(claudius_core::now_ms()))),
                    );
                    let rows: Vec<Value> = s
                        .as_ref()
                        .map(|s| s.queue_snapshot())
                        .unwrap_or_default()
                        .iter()
                        .map(|r| json!({"uuid": norm(&r["uuid"], &queued, &root_path), "text": r["text"]}))
                        .collect();
                    p.insert("queue".into(), Value::Array(rows));
                    if streaming {
                        p.insert(
                            "streamClosed".into(),
                            json!(stream_closed.load(Ordering::SeqCst)),
                        );
                    }
                    Value::Object(
                        probe_keys
                            .iter()
                            .map(|k| (k.clone(), p.get(k).cloned().unwrap_or(Value::Null)))
                            .collect(),
                    )
                };
                if probe == want_probe || start.elapsed() >= settle() {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(50)).await;
            }
            if probe != want_probe {
                diffs.push(format!("{where_}:\n  want {want_probe}\n   got {probe}"));
            }
        }
        if let Some(s) = mgr.get(&id) {
            let _ = mgr.remove(&id).await;
            drop(s);
        }
    }
    let _ = std::fs::remove_file(&settings_file);
    assert!(diffs.is_empty(), "{}", diffs.join("\n"));

    // ── Rust-side: what the recorder can't pin ──────────────────────────────
    //
    // A dead session with an armed wake-up is reaped (CC 2.1.311: a dead CLI
    // took the timer with it, and `hasArmedLoops` used to pin the instance in
    // memory forever), and concurrent sends share one rebuild, hence one
    // attempt from the budget.
    let mut env: HashMap<String, String> = HashMap::new();
    env.insert("PATH".into(), std::env::var("PATH").unwrap_or_default());
    env.insert(
        "FAKE_CLAUDE_SCRIPT".into(),
        json!({"turns": [{"match": "arm", "result": "armed", "steps": [
            {"type": "assistant", "message": {"role": "assistant", "content": [
                {"type": "tool_use", "id": "toolu_wake", "name": "ScheduleWakeup",
                 "input": {"delaySeconds": 3600, "reason": "watch", "prompt": "/loop watch", "noop": true}}]}},
        ]}]})
        .to_string(),
    );

    // A world for one extra session: its own cwd and pid file.
    let world = |n: &str| {
        let cwd = root.path().join("proj").join(n);
        std::fs::create_dir_all(&cwd).unwrap();
        let cwd = cwd.canonicalize().unwrap();
        (cwd.display().to_string(), cwd.join("cli.pid"))
    };
    let start_extra = |id: &str, cwd: &str, pid_file: &PathBuf| {
        let mut env = env.clone();
        env.insert("FAKE_CLAUDE_PID".into(), pid_file.display().to_string());
        *mgr.runtime.lock().unwrap() = RuntimeOptions {
            claude_bin: Some(fake.clone()),
            env_override: Some(env),
        };
        let (id, cwd) = (id.to_owned(), cwd.to_owned());
        let mgr = mgr.clone();
        async move {
            mgr.create(SessionOptions {
                id: Some(id),
                cwd: Some(cwd),
                ..Default::default()
            })
            .await
            .expect("create")
        }
    };
    /// SIGKILL the CLI the session is running: the pid file is rewritten by
    /// each new CLI, so wait until it names a live process first.
    async fn kill(pid_file: &PathBuf) {
        let alive = |pid: &str| {
            std::process::Command::new("kill")
                .args(["-0", pid])
                .stderr(std::process::Stdio::null())
                .status()
                .is_ok_and(|s| s.success())
        };
        let pid = {
            let start = Instant::now();
            loop {
                let pid = std::fs::read_to_string(pid_file)
                    .map(|t| t.trim().to_owned())
                    .unwrap_or_default();
                if !pid.is_empty() && alive(&pid) {
                    break pid;
                }
                assert!(start.elapsed() < SETTLE, "no live CLI in {pid_file:?}");
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
        };
        assert!(
            std::process::Command::new("kill")
                .args(["-KILL", &pid])
                .status()
                .unwrap()
                .success()
        );
    }
    async fn wait(what: &str, f: impl Fn() -> bool) {
        let start = Instant::now();
        while start.elapsed() < SETTLE && !f() {
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        assert!(f(), "timed out waiting for {what}");
    }

    // The reaper takes a dead session that armed a wake-up. (A live one is
    // kept: `claudius-core/tests/session_fake.rs`.)
    let (cwd, pid_file) = world("extra-reap");
    let id = "dead-extra-reap";
    let s = start_extra(id, &cwd, &pid_file).await;
    let r = post(
        &c,
        format!("{base}/api/sessions/{id}/input"),
        Some(r#"{"text":"arm"}"#),
    )
    .await;
    assert_eq!(r.status, 200, "{}", r.body);
    wait("the armed wake-up", || {
        s.has_armed_loops(claudius_core::now_ms())
    })
    .await;
    kill(&pid_file).await;
    wait("the death", || s.is_dead()).await;
    assert!(!s.has_armed_loops(claudius_core::now_ms()));
    *mgr.reap_ms_override.lock().unwrap() = Some(100);
    // A subscribe + drop re-arms the reap timer with that window.
    drop(s.subscribe(None, None));
    wait("the reap", || mgr.get(id).is_none()).await;
    *mgr.reap_ms_override.lock().unwrap() = None;
    drop(s);

    // Two sends landing together: both get the same rebuilt session, and the
    // budget moved once, so two more restarts fit before `max_attempts`.
    let (cwd, pid_file) = world("extra-share");
    let id = "dead-extra-share";
    let s = start_extra(id, &cwd, &pid_file).await;
    kill(&pid_file).await;
    wait("the death", || s.is_dead()).await;
    let (a, b) = tokio::join!(
        mgr.restart_if_dead(id, false),
        mgr.restart_if_dead(id, false)
    );
    let (a, b) = (a.expect("restart a"), b.expect("restart b"));
    assert!(
        Arc::ptr_eq(&a.session, &b.session),
        "both callers get the one rebuilt session"
    );
    // Whether the joiner reports `restarted` depends on whether the rebuild
    // yielded before the second call (TS's `await` always does), so only the
    // attempt count below is asserted.
    assert!(a.restarted || b.restarted, "one of them rebuilt");
    drop((a, b));
    for attempt in 2..=3 {
        let s = mgr.get(id).expect("bound");
        kill(&pid_file).await;
        wait("the death", || s.is_dead()).await;
        let r = mgr
            .restart_if_dead(id, false)
            .await
            .unwrap_or_else(|e| panic!("attempt {attempt}: {e}"));
        assert!(r.restarted, "attempt {attempt} rebuilt");
    }
    let s = mgr.get(id).expect("bound");
    kill(&pid_file).await;
    wait("the death", || s.is_dead()).await;
    assert_eq!(
        mgr.restart_if_dead(id, false).await.err(),
        Some(DeadReason::MaxAttempts),
        "the shared rebuild took one attempt, not two"
    );
    drop(s);
    mgr.remove(id).await;

    // A caller dropped mid-rebuild (a closed tab's send): the rebuild runs to
    // the end anyway, as TS's promise does, so the id ends up bound to a live
    // session instead of unbound with a rebuild nobody finishes.
    let (cwd, pid_file) = world("extra-cancel");
    let id = "dead-extra-cancel";
    let s = start_extra(id, &cwd, &pid_file).await;
    kill(&pid_file).await;
    wait("the death", || s.is_dead()).await;
    // `timeout` polls the call once (the rebuild starts), then drops it.
    assert!(
        tokio::time::timeout(Duration::from_millis(1), mgr.restart_if_dead(id, false))
            .await
            .is_err(),
        "the rebuild can't finish in 1 ms"
    );
    wait("the rebuilt session", || {
        mgr.get(id)
            .is_some_and(|n| !Arc::ptr_eq(&n, &s) && !n.is_dead())
    })
    .await;
    let r = mgr
        .restart_if_dead(id, false)
        .await
        .expect("the next caller gets the live session");
    assert!(!r.restarted && !Arc::ptr_eq(&r.session, &s));
    drop((r, s));
    mgr.remove(id).await;
}
