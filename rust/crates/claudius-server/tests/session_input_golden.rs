//! `sendInput()`, `subscribe()` and the session manager's list (S29),
//! replayed against the TS.
//!
//! `claudius-core/tests/fixtures/session_input_golden.json`
//! (`rust/scripts/session-input-golden.mjs`) records one timeline per
//! scenario on the real TS `sessionManager` and the real `POST /input`,
//! `queue/send-all` and `GET /api/sessions` handlers against the fake CLI.
//! This replays the steps against the real Rust router, served in process so
//! the steps can reach the sessions. After every step, once the sessions are
//! quiet, it compares (as `JSON.stringify` text, so key order counts) the
//! route's status and body, the `user` lines the CLI read, what a subscriber
//! registered at create saw, the queue rows, the asset rows and store files,
//! and the suggested / goal rows; a `sub` step compares what `subscribe`
//! delivered before returning and in the 500 ms after. Plus the idle reap
//! window for every recorded `CLAUDIUS_SESSION_IDLE_REAP_MS` and
//! `lastRecordedPermissionMode` over the recorded transcripts.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant};

use bytes::Bytes;
use claudius_agent::js;
use claudius_core::auto_memory::{MemoryOp, MemoryUpdate};
use claudius_core::db::{Mode, open_db};
use claudius_core::paths;
use claudius_core::session::{RuntimeOptions, Session, SessionOptions, Subscription, TurnStatus};
use claudius_core::session_manager::{SessionManager, last_recorded_permission_mode, reap_ms_from};
use claudius_server::{AppState, app};
use http_body_util::{BodyExt, Full};
use hyper_util::client::legacy::Client;
use hyper_util::client::legacy::connect::HttpConnector;
use hyper_util::rt::TokioExecutor;
use serde_json::{Map, Value, json};

type HttpClient = Client<HttpConnector, Full<Bytes>>;

/// The reap window the reaper's scenario runs with (TS: its 5 s floor).
const REAP_MS: u64 = 3000;

fn fixture() -> Value {
    serde_json::from_str(include_str!(
        "../../claudius-core/tests/fixtures/session_input_golden.json"
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

/// The recorder's normalization.
struct Norm {
    root: String,
    today_key: String,
    today: String,
}

fn is_hex(b: u8) -> bool {
    b.is_ascii_digit() || (b'a'..=b'f').contains(&b)
}

/// `[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}` at `b`.
fn uuid_at(b: &[u8]) -> bool {
    b.len() >= 36
        && b[..36].iter().enumerate().all(|(i, c)| match i {
            8 | 13 | 18 | 23 => *c == b'-',
            14 => *c == b'4',
            19 => matches!(c, b'8' | b'9' | b'a' | b'b'),
            _ => is_hex(*c),
        })
}

/// `msg_[0-9a-f]{32}` at `b`.
fn msg_at(b: &[u8]) -> bool {
    b.len() >= 36 && b.starts_with(b"msg_") && b[4..36].iter().all(|c| is_hex(*c))
}

fn replace_ids(s: &str) -> String {
    let b = s.as_bytes();
    let mut out = String::with_capacity(s.len());
    let mut i = 0;
    while i < b.len() {
        if uuid_at(&b[i..]) {
            out.push_str("$UUID");
            i += 36;
        } else if msg_at(&b[i..]) {
            out.push_str("$MSG");
            i += 36;
        } else {
            let c = s[i..].chars().next().unwrap();
            out.push(c);
            i += c.len_utf8();
        }
    }
    out
}

/// `/(?<![0-9.])(?:1[5-9]|2[0-4])[0-9]{11}(?![0-9.])/g`: a maximal run of
/// digits and dots that is 13 digits from 15… to 24….
fn replace_stamps(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut run = String::new();
    let flush = |run: &mut String, out: &mut String| {
        let stamp = run.len() == 13
            && run.bytes().all(|c| c.is_ascii_digit())
            && (15..=24).contains(&run[..2].parse::<u32>().unwrap());
        out.push_str(if stamp { "$NOW" } else { run });
        run.clear();
    };
    for c in s.chars() {
        if c.is_ascii_digit() || c == '.' {
            run.push(c);
        } else {
            flush(&mut run, &mut out);
            out.push(c);
        }
    }
    flush(&mut run, &mut out);
    out
}

impl Norm {
    fn text(&self, s: &str, cwd: Option<&str>) -> String {
        let mut t = s.replace(&self.root, "$ROOT");
        if let Some(c) = cwd {
            t = t.replace(&c.replace(&self.root, "$ROOT"), "$CWD");
        }
        replace_stamps(&replace_ids(&t))
            .replace(&self.today_key, "$TODAY_KEY")
            .replace(&self.today, "$TODAY")
    }

    fn value(&self, v: &Value, cwd: Option<&str>) -> Value {
        match v {
            Value::String(s) => json!(self.text(s, cwd)),
            Value::Number(n) if n.as_f64().is_some_and(|f| f > 1.5e12 && f < 2.5e12) => {
                json!("$NOW")
            }
            Value::Array(a) => Value::Array(a.iter().map(|x| self.value(x, cwd)).collect()),
            Value::Object(o) => Value::Object(
                o.iter()
                    .map(|(k, x)| (k.clone(), self.value(x, cwd)))
                    .collect(),
            ),
            v => v.clone(),
        }
    }
}

/// The recorder's `NOISE`: events riding a background round trip.
const NOISE: [&str; 7] = [
    "plan_usage",
    "plan_usage_unavailable",
    "effort_applied",
    "mcp_needs_auth_notice",
    "mcp_disconnected_notice",
    "feedback_survey",
    "usage_snapshot",
];

fn ev_type(e: &Value) -> &str {
    e["type"].as_str().unwrap_or("")
}

/// The recorder's `keep`: no noise, and of the CLI's own messages only the
/// `user` ones and `slash_invoked`.
fn keep(e: &Value) -> bool {
    if NOISE.contains(&ev_type(e)) {
        return false;
    }
    if ev_type(e) != "sdk" {
        return true;
    }
    let m = &e["message"];
    m["type"] == "user" || (m["type"] == "system" && m["subtype"] == "slash_invoked")
}

struct Resp {
    status: u16,
    body: String,
}

async fn request(c: &HttpClient, method: &str, url: String, body: Option<&str>) -> Resp {
    let mut req = hyper::Request::builder().method(method).uri(url);
    if body.is_some() {
        req = req.header("content-type", "text/plain;charset=UTF-8");
    }
    let bytes = Bytes::copy_from_slice(body.unwrap_or("").as_bytes());
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

/// A watcher: every event the session broadcast, as it arrives.
struct Watch {
    sub: Subscription,
    events: Vec<Value>,
}

/// Drains every watcher; true when one had something.
fn drain(watches: &mut HashMap<String, Watch>) -> bool {
    let mut any = false;
    for w in watches.values_mut() {
        while let Ok(e) = w.sub.rx.try_recv() {
            w.events.push(e);
            any = true;
        }
    }
    any
}

/// What one subscriber got: during `subscribe` (`sync`, the replayed part
/// without noise) and in the 500 ms after (`async`).
async fn subscribe_once(s: &Arc<Session>, opts: &Value) -> Value {
    let tail = opts["tail"].as_u64().map(|t| t as usize);
    let tab = opts["tabId"].as_str().map(str::to_owned);
    let marker = json!({"type": "$sync_done"});
    let mut sub = s.subscribe_with(tail, tab, std::slice::from_ref(&marker));
    tokio::time::sleep(Duration::from_millis(500)).await;
    let mut all = Vec::new();
    while let Ok(e) = sub.rx.try_recv() {
        all.push(e);
    }
    drop(sub);
    let split = all
        .iter()
        .position(|e| *e == marker)
        .expect("the sync marker");
    let done = all
        .iter()
        .position(|e| ev_type(e) == "replay_done")
        .unwrap_or(0);
    let sync: Vec<Value> = all[..split]
        .iter()
        .enumerate()
        .filter(|(i, e)| !(*i < done && NOISE.contains(&ev_type(e))))
        .map(|(_, e)| e.clone())
        .collect();
    json!({"sync": sync, "async": all[split + 1..].to_vec()})
}

/// better-sqlite3's rows: column name → value.
fn rows(cwd: &str, sql: &str) -> Value {
    let Ok(db) = open_db(cwd, Mode::ReadOnly) else {
        return json!([]);
    };
    db.with(|c| {
        let mut st = c.prepare(sql)?;
        let names: Vec<String> = st.column_names().iter().map(|s| s.to_string()).collect();
        let out = st.query_map([], |r| {
            let mut m = Map::new();
            for (i, n) in names.iter().enumerate() {
                use rusqlite::types::ValueRef;
                let v = match r.get_ref(i)? {
                    ValueRef::Null => Value::Null,
                    ValueRef::Integer(n) => json!(n),
                    ValueRef::Real(f) => claudius_core::js_num(f),
                    ValueRef::Text(t) => json!(String::from_utf8_lossy(t)),
                    ValueRef::Blob(b) => json!(String::from_utf8_lossy(b)),
                };
                m.insert(n.clone(), v);
            }
            Ok(Value::Object(m))
        })?;
        out.collect::<Result<Vec<_>, _>>()
    })
    .map(Value::Array)
    .unwrap_or_else(|_| json!([]))
}

/// The asset store's files under the cwd's project dir, as the recorder lists them.
fn store_files(home: &Path, cwd: &str) -> Value {
    let enc: String = cwd
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
        .collect();
    let dir = home.join(".claude/projects").join(enc).join("assets");
    let mut out = Vec::new();
    fn walk(base: &Path, d: &Path, out: &mut Vec<Value>) {
        let Ok(rd) = std::fs::read_dir(d) else { return };
        let mut names: Vec<_> = rd.flatten().map(|e| e.file_name()).collect();
        names.sort();
        for n in names {
            let p = d.join(&n);
            if p.is_dir() {
                walk(base, &p, out);
            } else {
                let rel = p.strip_prefix(base).unwrap().display().to_string();
                out.push(json!({"path": rel, "size": std::fs::metadata(&p).unwrap().len()}));
            }
        }
    }
    walk(&dir, &dir, &mut out);
    Value::Array(out)
}

/// Differences filed for later: (scenario, step, keys, why). Every listed
/// key must differ (else the entry is stale) and nothing else may.
const KNOWN: &[(&str, usize, &[&str], &str)] = &[];

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn session_input_matches_ts() {
    let fx = fixture();
    assert_eq!(
        fx["rejections"],
        json!([]),
        "the recording had unhandled rejections"
    );

    // The idle reap window (`_idleTimeout` of the armed timer).
    for w in fx["reapWindows"].as_array().unwrap() {
        let raw = w["raw"].as_str();
        let want = w["ms"].as_f64().unwrap().trunc() as u64;
        assert_eq!(reap_ms_from(raw), want, "reapMs({raw:?})");
    }

    let root = tempfile::tempdir().unwrap();
    let root_path = root.path().canonicalize().unwrap().display().to_string();
    let rootp = PathBuf::from(&root_path);
    let (home, config) = (rootp.join("home"), rootp.join("config"));
    for d in [&home, &config] {
        std::fs::create_dir_all(d).unwrap();
    }
    paths::set_home_override(home.clone());
    paths::set_config_dir_override(config);
    let settings_file = home.join(".claude/settings.json");
    let state_dir = home.join(".claude/.claudius");
    std::fs::create_dir_all(&state_dir).unwrap();
    let norm = Norm {
        root: root_path.clone(),
        today_key: chrono::Local::now().format("%Y-%m-%d").to_string(),
        today: chrono::Local::now().format("%a %b %d %Y").to_string(),
    };

    // `lastRecordedPermissionMode` over the recorded transcripts.
    let pm = &fx["permissionModes"];
    let pm_cwd = pm["cwd"].as_str().unwrap().replace("$ROOT", &root_path);
    std::fs::create_dir_all(&pm_cwd).unwrap();
    let pm_dir = paths::project_root(&pm_cwd);
    std::fs::create_dir_all(&pm_dir).unwrap();
    let mut diffs: Vec<String> = Vec::new();
    for c in pm["cases"].as_array().unwrap() {
        let id = c["id"].as_str().unwrap();
        if let Some(b64) = c["base64"].as_str() {
            let bytes = claudius_core::asset_ingest::buffer_from_base64(b64);
            std::fs::write(pm_dir.join(format!("{id}.jsonl")), bytes).unwrap();
        }
        let got = json!(last_recorded_permission_mode(id, &pm_cwd));
        if got != c["mode"] {
            diffs.push(format!(
                "permission mode {}: {id:?}: want {} got {got}",
                c["label"], c["mode"]
            ));
        }
    }

    let fake = fake_bin();
    let gated = rootp.join("gated-claude.sh");
    std::fs::write(
        &gated,
        "#!/bin/sh\nwhile [ ! -e \"$SESSION_INPUT_GATE\" ]; do sleep 0.02; done\nexec \"$SESSION_INPUT_GOLDEN_FAKE\" \"$@\"\n",
    )
    .unwrap();
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&gated, std::fs::Permissions::from_mode(0o755)).unwrap();
    }

    let list_cwd = |k: u64| rootp.join("list").join(k.to_string());
    for k in [0, 1] {
        std::fs::create_dir_all(list_cwd(k)).unwrap();
    }
    let workspaces = js::stringify_pretty(&fx["workspaces"]).replace("$ROOT", &root_path);
    std::fs::write(state_dir.join("workspaces.json"), format!("{workspaces}\n")).unwrap();

    let mgr = Arc::new(SessionManager::default());
    let router = app(AppState::new(mgr.clone(), None, true));
    let l = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}", l.local_addr().unwrap());
    tokio::spawn(async move { axum::serve(l, router).await.unwrap() });
    let c: HttpClient = Client::builder(TokioExecutor::new()).build(HttpConnector::new());

    // A session that was never started.
    let unstarted_cwd = rootp.join("unstarted").display().to_string();
    std::fs::create_dir_all(&unstarted_cwd).unwrap();
    std::fs::write(
        &settings_file,
        js::stringify_pretty(&json!({"feedbackSurveyRate": 0, "spinnerTipsEnabled": false})),
    )
    .unwrap();
    let unstarted = Session::new(SessionOptions {
        id: Some("s29-unstarted".into()),
        cwd: Some(unstarted_cwd.clone()),
        ..Default::default()
    })
    .unwrap();
    let got = norm.value(
        &subscribe_once(&unstarted, &json!({})).await,
        Some(&unstarted_cwd),
    );
    if js::stringify(&got) != js::stringify(&fx["unstarted"]) {
        diffs.push(format!(
            "unstarted subscribe:\n  want {}\n   got {}",
            fx["unstarted"], got
        ));
    }

    let mut seen_known = 0usize;
    for (ci, sc) in fx["scenarios"].as_array().unwrap().iter().enumerate() {
        let name = sc["name"].as_str().unwrap();
        let multi = sc["multi"] == true;
        let reap = sc["reap"] == true;
        let wedged = sc["wedged"] == true;
        let settings = js::stringify_pretty(&sc["settings"]) + "\n";
        std::fs::write(&settings_file, &settings).unwrap();
        if let Some(a) = sc["accounts"].as_str() {
            std::fs::write(state_dir.join("accounts.json"), a).unwrap();
        }
        let cwds: Vec<String> = if sc["accounts"].is_string() {
            vec![
                list_cwd(0).display().to_string(),
                list_cwd(1).display().to_string(),
            ]
        } else {
            vec![
                rootp
                    .join("proj")
                    .join(ci.to_string())
                    .display()
                    .to_string(),
            ]
        };
        for d in &cwds {
            std::fs::create_dir_all(d).unwrap();
        }
        let id_of = |step: &Value| -> String {
            if multi {
                let n = step["$id"]
                    .as_u64()
                    .or(step["create"]["$id"].as_u64())
                    .unwrap_or(0);
                format!("s29-{ci}-{n}")
            } else {
                format!("s29-{ci}")
            }
        };
        let script = js::stringify(&sc["script"]).replace("$CWD", &cwds[0]);
        let gate = PathBuf::from(&cwds[0]).join("cli-gate");
        let mut env: HashMap<String, String> = HashMap::new();
        env.insert("PATH".into(), std::env::var("PATH").unwrap_or_default());
        env.insert("FAKE_CLAUDE_SCRIPT".into(), script);
        env.insert("SESSION_INPUT_GATE".into(), gate.display().to_string());
        env.insert(
            "SESSION_INPUT_GOLDEN_FAKE".into(),
            fake.display().to_string(),
        );
        let bin = if sc["bin"] == "gated" {
            gated.clone()
        } else {
            fake.clone()
        };
        *mgr.reap_ms_override.lock().unwrap() = reap.then_some(REAP_MS);

        let mut watches: HashMap<String, Watch> = HashMap::new();
        let mut logs: HashMap<String, (PathBuf, usize)> = HashMap::new();
        let mut cwd_by_id: HashMap<String, String> = HashMap::new();
        let mut attached: Vec<Subscription> = Vec::new();
        let mut ids: Vec<String> = Vec::new();
        // Sessions whose turn waits on a gate: only their own settling is skipped.
        let mut held: HashSet<String> = HashSet::new();
        let mut images = false;

        for (si, step) in sc["steps"].as_array().unwrap().iter().enumerate() {
            let id = id_of(step);
            let mut got = Map::new();
            if step.get("create").is_some() {
                let cwd = cwds[step["create"]["$cwd"].as_u64().unwrap_or(0) as usize].clone();
                let log = PathBuf::from(&cwd).join(format!("stdin-{id}.log"));
                env.insert("FAKE_CLAUDE_LOG".into(), log.display().to_string());
                *mgr.runtime.lock().unwrap() = RuntimeOptions {
                    claude_bin: Some(bin.clone()),
                    env_override: Some(env.clone()),
                };
                let created = mgr
                    .create(SessionOptions {
                        id: Some(id.clone()),
                        cwd: Some(cwd.clone()),
                        model: step["create"]["model"].as_str().map(str::to_owned),
                        ..Default::default()
                    })
                    .await;
                match created {
                    Ok(s) => {
                        logs.insert(id.clone(), (log, 0));
                        cwd_by_id.insert(id.clone(), cwd.clone());
                        ids.push(id.clone());
                        if sc["bin"] != "gated" {
                            let start = Instant::now();
                            while !s
                                .buffer_snapshot()
                                .iter()
                                .any(|e| e["message"]["subtype"] == "init")
                            {
                                assert!(
                                    start.elapsed() < Duration::from_secs(10),
                                    "{name}: no init"
                                );
                                tokio::time::sleep(Duration::from_millis(10)).await;
                            }
                        }
                        if !reap {
                            let sub = s.subscribe(None, None);
                            watches.insert(
                                id.clone(),
                                Watch {
                                    sub,
                                    events: vec![],
                                },
                            );
                        }
                        tokio::time::sleep(Duration::from_millis(400)).await;
                        drain(&mut watches);
                        if let Some(w) = watches.get_mut(&id) {
                            w.events.clear();
                        }
                        got.insert("created".into(), json!(true));
                    }
                    Err(e) => {
                        got.insert("threw".into(), json!(format!("{}: {e}", e.name())));
                    }
                }
            } else if let Some(body) = step["post"].as_str() {
                if step["hold"] == true {
                    held.insert(id.clone());
                }
                if body.contains("images") {
                    images = true;
                }
                let r = request(
                    &c,
                    "POST",
                    format!("{base}/api/sessions/{id}/input"),
                    Some(body),
                )
                .await;
                got.insert("res".into(), json!({"status": r.status, "body": r.body}));
            } else if step["sendAll"] == true {
                let r = request(
                    &c,
                    "POST",
                    format!("{base}/api/sessions/{id}/queue/send-all"),
                    None,
                )
                .await;
                got.insert("res".into(), json!({"status": r.status, "body": r.body}));
            } else if step.get("sub").is_some() {
                let s = mgr.get(&id).unwrap();
                got.insert("sub".into(), subscribe_once(&s, &step["sub"]).await);
            } else if let Some(name) = step["open"].as_str() {
                if name == "$GATE" {
                    std::fs::write(&gate, "").unwrap();
                    let s = mgr.get(&id).unwrap();
                    let start = Instant::now();
                    while !s
                        .buffer_snapshot()
                        .iter()
                        .any(|e| e["message"]["subtype"] == "init")
                        && start.elapsed() < Duration::from_secs(10)
                    {
                        tokio::time::sleep(Duration::from_millis(10)).await;
                    }
                } else {
                    let dir = cwd_by_id
                        .get(&id)
                        .cloned()
                        .unwrap_or_else(|| cwds[0].clone());
                    std::fs::write(PathBuf::from(dir).join(name), "").unwrap();
                }
                held.remove(&id);
            } else if let Some(key) = step["date"].as_str() {
                mgr.get(&id).unwrap().set_last_seen_local_date(key);
            } else if let Some(goal) = step["goal"].as_str() {
                mgr.get(&id).unwrap().set_goal(goal).unwrap();
            } else if let Some(updates) = step["memory"].as_array() {
                let updates: Vec<MemoryUpdate> = updates
                    .iter()
                    .map(|u| MemoryUpdate {
                        op: match u["op"].as_str().unwrap() {
                            "created" => MemoryOp::Created,
                            "updated" => MemoryOp::Updated,
                            _ => MemoryOp::Deleted,
                        },
                        path: u["path"].as_str().unwrap().replace("$CWD", &cwds[0]),
                    })
                    .collect();
                mgr.get(&id).unwrap().notify_memory_update(&updates);
            } else if let Some(cmd) = step["bash"].as_str() {
                let s = mgr.get(&id).unwrap();
                let r = s
                    .run_bash_command(cmd, None, json!(format!("u-bash-{si}")))
                    .await
                    .unwrap();
                got.insert(
                    "bash".into(),
                    json!({"stdout": r.result.stdout, "stderr": r.result.stderr, "exitCode": r.result.exit_code}),
                );
            } else if let Some(t) = step["touch"].as_array() {
                std::fs::write(
                    PathBuf::from(&cwds[0]).join(t[0].as_str().unwrap()),
                    t[1].as_str().unwrap(),
                )
                .unwrap();
            } else if let Some(title) = step["rename"].as_str() {
                mgr.get(&id).unwrap().rename(title).await.unwrap();
            } else if let Some(q) = step["list"].as_str() {
                let url = if q.is_empty() {
                    format!("{base}/api/sessions")
                } else {
                    format!("{base}/api/sessions?{q}")
                };
                let r = request(&c, "GET", url, None).await;
                got.insert("list".into(), json!({"status": r.status, "body": r.body}));
            } else if step["waitDead"] == true {
                let start = Instant::now();
                while start.elapsed() < Duration::from_secs(15)
                    && !mgr.get(&id).is_some_and(|s| s.is_dead())
                {
                    tokio::time::sleep(Duration::from_millis(10)).await;
                }
                got.insert(
                    "dead".into(),
                    json!(mgr.get(&id).is_some_and(|s| s.is_dead())),
                );
            } else if let Some(text) = step["settings"].as_str() {
                match text {
                    "$RM" => {
                        let _ = std::fs::remove_file(&settings_file);
                    }
                    "$BASE" => std::fs::write(&settings_file, &settings).unwrap(),
                    t => std::fs::write(&settings_file, t).unwrap(),
                }
            } else if step["attach"] == true {
                attached.push(mgr.get(&id).unwrap().subscribe(None, None));
            } else if step["reapWait"] == true {
                tokio::time::sleep(Duration::from_millis(REAP_MS + 1000)).await;
            } else {
                panic!("{name}: unknown step {step}");
            }

            // Quiet: no event for 300 ms, and not running unless a gate holds its turn.
            let holding = held.contains(&id);
            let start = Instant::now();
            let mut last = Instant::now();
            loop {
                if drain(&mut watches) {
                    last = Instant::now();
                }
                let running = mgr
                    .get(&id)
                    .is_some_and(|s| !s.is_done() && s.status() == TurnStatus::Running);
                if (!running || holding || wedged) && last.elapsed() >= Duration::from_millis(300) {
                    break;
                }
                assert!(
                    start.elapsed() < Duration::from_secs(20),
                    "{name}: never went quiet"
                );
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
            if images {
                tokio::time::sleep(Duration::from_millis(200)).await;
            }

            let cwd = cwd_by_id
                .get(&id)
                .cloned()
                .unwrap_or_else(|| cwds[0].clone());
            let wrote: Vec<Value> = match logs.get_mut(&id) {
                Some((file, seen)) => {
                    let users: Vec<String> = std::fs::read_to_string(&*file)
                        .unwrap_or_default()
                        .split('\n')
                        .filter(|l| !l.is_empty())
                        .filter(|l| {
                            serde_json::from_str::<Value>(l).is_ok_and(|v| v["type"] == "user")
                        })
                        .map(str::to_owned)
                        .collect();
                    let fresh = users[(*seen).min(users.len())..].to_vec();
                    *seen = users.len();
                    fresh
                        .iter()
                        .map(|l| json!(norm.text(l, Some(&cwd))))
                        .collect()
                }
                None => vec![],
            };
            let events: Vec<Value> = watches
                .get_mut(&id)
                .map(|w| std::mem::take(&mut w.events))
                .unwrap_or_default()
                .into_iter()
                .filter(keep)
                .collect();
            got.insert("wrote".into(), Value::Array(wrote));
            got.insert("events".into(), Value::Array(events));
            got.insert(
                "queue".into(),
                rows(
                    &cwd,
                    &format!(
                        "SELECT uuid, position, text, images_json, slash, from_suggestion, from_goal FROM queued_messages WHERE session_id = '{id}' ORDER BY position"
                    ),
                ),
            );
            let mut tagged = rows(
                &cwd,
                &format!("SELECT 'suggested' AS kind, message_uuid, suggestion_text AS text FROM suggested_messages WHERE session_id = '{id}'"),
            )
            .as_array()
            .cloned()
            .unwrap_or_default();
            tagged.extend(
                rows(
                    &cwd,
                    &format!("SELECT 'goal' AS kind, message_uuid, goal_text AS text FROM goal_messages WHERE session_id = '{id}'"),
                )
                .as_array()
                .cloned()
                .unwrap_or_default(),
            );
            if !tagged.is_empty() {
                got.insert("tagged".into(), Value::Array(tagged));
            }
            if images {
                got.insert(
                    "assets".into(),
                    rows(&cwd, "SELECT hash, media_type, size_bytes, width, height FROM assets ORDER BY hash"),
                );
                got.insert(
                    "uses".into(),
                    rows(
                        &cwd,
                        "SELECT asset_hash, session_id, message_uuid, ordinal FROM asset_uses ORDER BY asset_hash, message_uuid, ordinal",
                    ),
                );
                got.insert("files".into(), store_files(&home, &cwd));
            }
            let got = norm.value(&Value::Object(got), Some(&cwd));

            let mut want = step["got"].clone();
            // What TS threw only reaches the log.
            if let Some(r) = want.get_mut("res").and_then(Value::as_object_mut) {
                r.shift_remove("threw");
            }
            let mut keys: Vec<String> = want.as_object().unwrap().keys().cloned().collect();
            keys.extend(
                got.as_object()
                    .unwrap()
                    .keys()
                    .filter(|k| want.get(*k).is_none())
                    .cloned(),
            );
            let mut step_desc = step.clone();
            step_desc.as_object_mut().unwrap().shift_remove("got");
            let text = |v: Option<&Value>| v.map_or_else(|| "<absent>".to_owned(), js::stringify);
            for k in keys {
                let (w, g) = (text(want.get(&k)), text(got.get(&k)));
                let why = KNOWN
                    .iter()
                    .find(|(n, i, ks, _)| *n == name && *i == si && ks.contains(&k.as_str()))
                    .map(|(.., why)| *why);
                match (w == g, why) {
                    (true, None) => {}
                    (true, Some(why)) => diffs.push(format!(
                        "{name} / step {si} {k}: matches now, drop KNOWN ({why})"
                    )),
                    (false, Some(_)) => seen_known += 1,
                    (false, None) => diffs.push(format!(
                        "{name} / step {si} {step_desc} {k}:\n  want {w}\n   got {g}"
                    )),
                }
            }
        }
        drop(attached);
        drop(watches);
        *mgr.reap_ms_override.lock().unwrap() = None;
        for id in &ids {
            mgr.remove(id).await;
        }
        let _ = std::fs::remove_file(state_dir.join("accounts.json"));
    }
    let listed: usize = KNOWN.iter().map(|(_, _, ks, _)| ks.len()).sum();
    assert_eq!(seen_known, listed, "a KNOWN difference wasn't seen");
    assert!(
        diffs.is_empty(),
        "{} differences:\n{}",
        diffs.len(),
        diffs.join("\n")
    );
}
