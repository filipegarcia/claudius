//! End-to-end over real HTTP: the Rust front door + fake CLI + a stub
//! "Next" upstream for the proxy fallback.

#[path = "../../claudius-agent/tests/support/test_bins.rs"]
mod test_bins;

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use axum::routing::get;
use bytes::Bytes;
use claudius_core::session::RuntimeOptions;
use claudius_core::session_manager::SessionManager;
use claudius_core::{paths, workspaces};
use claudius_server::{AppState, app, proxy::Proxy};
use http_body_util::{BodyExt, Full};
use hyper_util::client::legacy::Client;
use hyper_util::client::legacy::connect::HttpConnector;
use hyper_util::rt::TokioExecutor;
use serde_json::{Value, json};

type HttpClient = Client<HttpConnector, Full<Bytes>>;

fn fake_bin() -> PathBuf {
    test_bins::fake_claude()
}

async fn serve(router: axum::Router) -> String {
    let l = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = l.local_addr().unwrap();
    tokio::spawn(async move { axum::serve(l, router).await.unwrap() });
    format!("http://{addr}")
}

async fn call(c: &HttpClient, method: &str, url: &str, body: Option<Value>) -> (u16, Value) {
    let req = hyper::Request::builder()
        .method(method)
        .uri(url)
        .header("content-type", "application/json")
        .body(Full::new(Bytes::from(
            body.map(|b| b.to_string()).unwrap_or_default(),
        )))
        .unwrap();
    let resp = c.request(req).await.unwrap();
    let status = resp.status().as_u16();
    let bytes = resp.into_body().collect().await.unwrap().to_bytes();
    let v = serde_json::from_slice(&bytes)
        .unwrap_or_else(|_| Value::String(String::from_utf8_lossy(&bytes).into()));
    (status, v)
}

/// Incremental SSE reader over a streaming hyper body.
struct Sse {
    body: hyper::body::Incoming,
    buf: String,
}

impl Sse {
    async fn open(c: &HttpClient, url: &str) -> Sse {
        let req = hyper::Request::get(url)
            .body(Full::new(Bytes::new()))
            .unwrap();
        let resp = c.request(req).await.unwrap();
        assert_eq!(resp.status(), 200);
        Sse {
            body: resp.into_body(),
            buf: String::new(),
        }
    }

    async fn next(&mut self) -> Value {
        loop {
            if let Some(i) = self.buf.find("\n\n") {
                let frame: String = self.buf.drain(..i + 2).collect();
                if let Some(data) = frame.strip_prefix("data: ") {
                    return serde_json::from_str(data.trim_end()).unwrap();
                }
                continue; // comment / ping
            }
            let f = tokio::time::timeout(Duration::from_secs(10), self.body.frame())
                .await
                .expect("sse timeout");
            let f = f.expect("sse ended").unwrap();
            if let Ok(d) = f.into_data() {
                self.buf.push_str(&String::from_utf8_lossy(&d));
            }
        }
    }
    async fn until(&mut self, pred: impl Fn(&Value) -> bool) -> Vec<Value> {
        let mut out = vec![];
        loop {
            let v = self.next().await;
            let done = pred(&v);
            out.push(v);
            if done {
                return out;
            }
        }
    }
}

fn assistant_text(e: &Value) -> Option<&str> {
    (e["type"] == "sdk" && e["message"]["type"] == "assistant")
        .then(|| e["message"]["message"]["content"][0]["text"].as_str())
        .flatten()
}

#[tokio::test]
async fn front_door_end_to_end() {
    let root = tempfile::tempdir().unwrap();
    let home = root.path().join("home");
    let config = root.path().join("config");
    let project = root.path().join("project");
    for d in [&home, &config, &project] {
        std::fs::create_dir_all(d).unwrap();
    }
    paths::set_home_override(home);
    paths::set_config_dir_override(config);
    let project = project.canonicalize().unwrap().display().to_string();
    let ws = workspaces::create(workspaces::NewWorkspace {
        name: "Proj".into(),
        root_path: project.clone(),
        icon: None,
        defaults: Some(
            json!({"permissionMode": "default"})
                .as_object()
                .unwrap()
                .clone(),
        ),
    })
    .unwrap();

    // Stub Next upstream.
    let next = serve(
        axum::Router::new()
            .route(
                "/hello",
                get(|| async { ([("x-from", "next")], "from-next") }),
            )
            .route(
                "/api/not-ported-yet",
                get(|| async { axum::Json(json!({"proxied": true})) }),
            ),
    )
    .await;

    let mgr = Arc::new(SessionManager::default());
    let mut envmap: HashMap<String, String> = HashMap::new();
    envmap.insert("PATH".into(), std::env::var("PATH").unwrap_or_default());
    let control_log = root.path().join("control.log");
    envmap.insert("FAKE_CLAUDE_LOG".into(), control_log.display().to_string());
    *mgr.runtime.lock().unwrap() = RuntimeOptions {
        claude_bin: Some(fake_bin()),
        env_override: Some(envmap),
    };
    let state = AppState::new(
        mgr.clone(),
        Some(Arc::new(Proxy::new(&next).unwrap())),
        true,
    );
    let base = serve(app(state)).await;
    let c: HttpClient = Client::builder(TokioExecutor::new()).build(HttpConnector::new());

    // ── proxy fallback + not-ported guard
    let (st, body) = call(&c, "GET", &format!("{base}/hello"), None).await;
    assert_eq!((st, body), (200, json!("from-next")));
    // An `/api` route nothing in Rust claims falls through to Next.
    let (st, body) = call(&c, "GET", &format!("{base}/api/not-ported-yet"), None).await;
    assert_eq!((st, body), (200, json!({"proxied": true})));
    // Every `/:id/*` route TS has is ported (S30); the guard still keeps an
    // unknown one from reaching Next.
    let (st, body) = call(
        &c,
        "GET",
        &format!("{base}/api/sessions/abc/no-such-route"),
        None,
    )
    .await;
    assert_eq!(st, 501);
    assert_eq!(body["notPorted"], true);
    let (st, body) = call(&c, "GET", &format!("{base}/api/sessions/abc/account"), None).await;
    assert_eq!((st, body), (404, json!({"error": "session not found"})));
    let (st, body) = call(&c, "GET", &format!("{base}/api/rust/health"), None).await;
    assert_eq!((st, body["backend"].clone()), (200, json!("rust")));

    // ── create
    let (st, body) = call(
        &c,
        "POST",
        &format!("{base}/api/sessions"),
        Some(json!({"cwd": "/definitely/not/trusted"})),
    )
    .await;
    assert_eq!((st, body), (400, json!({"error": "unknown cwd"})));
    let (st, body) = call(
        &c,
        "POST",
        &format!("{base}/api/sessions"),
        Some(json!({"resume": "nope"})),
    )
    .await;
    assert_eq!((st, body), (400, json!({"error": "invalid resume id"})));
    let (st, created) = call(
        &c,
        "POST",
        &format!("{base}/api/sessions"),
        Some(json!({"cwd": project, "initialDraftText": "draft"})),
    )
    .await;
    assert_eq!(st, 200, "{created}");
    let id = created["id"].as_str().unwrap().to_owned();
    assert_eq!(created["cwd"], project.as_str());
    let (_, list) = call(
        &c,
        "GET",
        &format!("{base}/api/sessions?workspaceId={}", ws.id),
        None,
    )
    .await;
    assert_eq!(list[0]["id"], id.as_str());
    assert_eq!(list[0]["status"], "idle");
    let (_, other) = call(
        &c,
        "GET",
        &format!("{base}/api/sessions?workspaceId=wks_nope"),
        None,
    )
    .await;
    assert_eq!(
        other.as_array().unwrap().len(),
        1,
        "unknown workspace → no filter (TS parity)"
    );

    // ── stream
    let req = hyper::Request::get(format!("{base}/api/sessions/{id}/stream?tabId=t1"))
        .body(Full::new(Bytes::new()))
        .unwrap();
    let resp = c.request(req).await.unwrap();
    assert_eq!(resp.status(), 200);
    assert_eq!(resp.headers()["content-type"], "text/event-stream");
    assert_eq!(resp.headers()["cache-control"], "no-cache, no-transform");
    let mut sse = Sse {
        body: resp.into_body(),
        buf: String::new(),
    };
    let head = sse.until(|e| e["type"] == "holder_changed").await;
    let rd = head
        .iter()
        .position(|e| e["type"] == "replay_done")
        .unwrap();
    let trailing_ready = head.iter().rposition(|e| e["type"] == "ready").unwrap();
    assert!(trailing_ready > rd, "route's ready follows the replay");

    // ── input → echo turn
    let (st, r) = call(
        &c,
        "POST",
        &format!("{base}/api/sessions/{id}/input"),
        Some(json!({"text": "hello"})),
    )
    .await;
    assert_eq!(st, 200);
    assert_eq!(r["queued"], false);
    let evs = sse.until(|e| assistant_text(e).is_some()).await;
    assert_eq!(evs.iter().find_map(assistant_text), Some("echo:hello"));
    sse.until(|e| e["type"] == "turn_status" && e["status"] == "idle")
        .await;
    let (st, _) = call(
        &c,
        "POST",
        &format!("{base}/api/sessions/{id}/input"),
        Some(json!({})),
    )
    .await;
    assert_eq!(st, 400);

    // ── permission while a queued message waits
    call(
        &c,
        "POST",
        &format!("{base}/api/sessions/{id}/input"),
        Some(json!({"text": "tool:ls"})),
    )
    .await;
    let req_ev = sse
        .until(|e| e["type"] == "permission_request")
        .await
        .pop()
        .unwrap();
    let (_, pending) = call(
        &c,
        "GET",
        &format!("{base}/api/sessions/{id}/pending-prompts"),
        None,
    )
    .await;
    assert_eq!(pending["permissions"][0]["requestId"], req_ev["requestId"]);
    let (_, q) = call(
        &c,
        "POST",
        &format!("{base}/api/sessions/{id}/input"),
        Some(json!({"text": "later"})),
    )
    .await;
    assert_eq!(
        q["queued"], true,
        "needs_input → queued (dispatch mode wait)"
    );
    let (st, _) = call(
        &c,
        "POST",
        &format!("{base}/api/sessions/{id}/permission"),
        Some(json!({"requestId": "nope", "decision": {"kind": "allow_once"}})),
    )
    .await;
    assert_eq!(st, 404);
    let (st, r) = call(
        &c,
        "POST",
        &format!("{base}/api/sessions/{id}/permission"),
        Some(json!({"requestId": req_ev["requestId"], "decision": {"kind": "allow_once"}})),
    )
    .await;
    assert_eq!((st, r), (200, json!({"ok": true})));
    let evs = sse.until(|e| assistant_text(e) == Some("echo:later")).await;
    assert!(
        evs.iter()
            .any(|e| assistant_text(e) == Some("permission:allow"))
    );

    // ── mode / model / commands / interrupt
    let (st, _) = call(
        &c,
        "POST",
        &format!("{base}/api/sessions/{id}/mode"),
        Some(json!({"mode": "bogus"})),
    )
    .await;
    assert_eq!(st, 400);
    let (_, r) = call(
        &c,
        "POST",
        &format!("{base}/api/sessions/{id}/mode"),
        Some(json!({"mode": "plan"})),
    )
    .await;
    assert_eq!(r, json!({"ok": true, "mode": "plan"}));
    let (_, r) = call(&c, "GET", &format!("{base}/api/sessions/{id}/mode"), None).await;
    assert_eq!(r, json!({"mode": "plan"}));
    let (_, r) = call(
        &c,
        "GET",
        &format!("{base}/api/sessions/{id}/commands"),
        None,
    )
    .await;
    assert_eq!(r["commands"][0]["name"], "clear");
    let (_, r) = call(&c, "GET", &format!("{base}/api/sessions/{id}/model"), None).await;
    let values: Vec<&str> = r["models"]
        .as_array()
        .unwrap()
        .iter()
        .filter_map(|m| m["value"].as_str())
        .collect();
    assert_eq!(values, ["fake-model", "fable"]);
    let (_, r) = call(
        &c,
        "POST",
        &format!("{base}/api/sessions/{id}/interrupt"),
        None,
    )
    .await;
    assert_eq!(r, json!({"ok": true, "stillQueued": []}));
    let (_, r) = call(
        &c,
        "PATCH",
        &format!("{base}/api/sessions/{id}/holder"),
        Some(json!({"tabId": "t2"})),
    )
    .await;
    assert_eq!(r, json!({"ok": true, "holderId": "t2"}));
    let ev = sse
        .until(|e| e["type"] == "holder_changed")
        .await
        .pop()
        .unwrap();
    assert_eq!(ev["holderId"], "t2");
    let (_, r) = call(
        &c,
        "POST",
        &format!("{base}/api/sessions/{id}/goal"),
        Some(json!({"goal": "ship it"})),
    )
    .await;
    assert_eq!(r["goal"]["goal"], "ship it");
    let ev = sse
        .until(|e| e["type"] == "goal_changed")
        .await
        .pop()
        .unwrap();
    assert_eq!(ev["achieved"], false);

    // ── effort
    let effort = async |body: Value| {
        call(
            &c,
            "POST",
            &format!("{base}/api/sessions/{id}/effort"),
            Some(body),
        )
        .await
    };
    for bad in [
        json!({}),
        json!({"level": ""}),
        json!({"level": 5}),
        json!({"level": "HIGH"}),
        json!({"level": "ultra"}),
        json!({"ultracode": true}),
    ] {
        assert_eq!(
            effort(bad.clone()).await,
            (400, json!({"error": "invalid effort level"})),
            "{bad}"
        );
    }
    let (st, r) = effort(json!({"level": "xhigh", "ultracode": true})).await;
    assert_eq!((st, r), (200, json!({"ok": true, "level": "xhigh"})));
    let ev = sse
        .until(|e| e["type"] == "effort_applied")
        .await
        .pop()
        .unwrap();
    assert_eq!(ev["effort"], "xhigh");
    // Only a literal `true` counts for the flags.
    let (st, r) = effort(json!({"level": "medium", "ultracode": "yes", "sessionOnly": 1})).await;
    assert_eq!((st, r), (200, json!({"ok": true, "level": "medium"})));
    let ev = sse
        .until(|e| e["type"] == "effort_applied")
        .await
        .pop()
        .unwrap();
    assert_eq!(ev["effort"], "medium");
    let (st, r) = effort(json!({"level": "auto", "sessionOnly": true})).await;
    assert_eq!((st, r), (200, json!({"ok": true, "level": "auto"})));
    let ev = sse
        .until(|e| e["type"] == "effort_applied")
        .await
        .pop()
        .unwrap();
    assert_eq!(ev["effort"], Value::Null);
    let sent: Vec<Value> = std::fs::read_to_string(&control_log)
        .unwrap()
        .lines()
        .filter_map(|l| serde_json::from_str::<Value>(l).ok())
        .map(|m| m["request"].clone())
        .filter(|r| {
            matches!(
                r["subtype"].as_str(),
                Some("apply_flag_settings" | "update_settings")
            ) && r.to_string().contains("effortLevel")
        })
        .collect();
    assert_eq!(
        sent,
        vec![
            json!({"subtype": "apply_flag_settings", "settings": {"effortLevel": "xhigh", "ultracode": true}}),
            json!({"subtype": "update_settings", "source": "userSettings", "settings": {"effortLevel": "xhigh"}}),
            json!({"subtype": "apply_flag_settings", "settings": {"effortLevel": "medium"}}),
            json!({"subtype": "update_settings", "source": "userSettings", "settings": {"effortLevel": "medium"}}),
            json!({"subtype": "apply_flag_settings", "settings": {"effortLevel": null}}),
        ]
    );
    // ── fast
    let fast = async |body: Value| {
        call(
            &c,
            "POST",
            &format!("{base}/api/sessions/{id}/fast"),
            Some(body),
        )
        .await
    };
    for bad in [
        json!({}),
        json!({"enabled": null}),
        json!({"enabled": "true"}),
        json!({"enabled": 1}),
        json!({"enabled": [true]}),
    ] {
        assert_eq!(
            fast(bad.clone()).await,
            (
                400,
                json!({"error": "invalid 'enabled' (boolean required)"})
            ),
            "{bad}"
        );
    }
    assert_eq!(
        fast(json!({"enabled": true})).await,
        (200, json!({"ok": true, "enabled": true}))
    );
    assert_eq!(
        fast(json!({"enabled": false, "extra": 1})).await,
        (200, json!({"ok": true, "enabled": false}))
    );
    let fast_sent: Vec<Value> = std::fs::read_to_string(&control_log)
        .unwrap()
        .lines()
        .filter_map(|l| serde_json::from_str::<Value>(l).ok())
        .map(|m| m["request"].clone())
        .filter(|r| r.to_string().contains("fastMode"))
        .collect();
    assert_eq!(
        fast_sent,
        vec![
            json!({"subtype": "apply_flag_settings", "settings": {"fastMode": true}}),
            json!({"subtype": "apply_flag_settings", "settings": {"fastMode": false}}),
        ]
    );
    // Orthogonal to effort: no refresh follows (the next event is the ping
    // or whatever comes later, never an `effort_applied` within the window).
    let quiet = tokio::time::timeout(
        Duration::from_millis(500),
        sse.until(|e| e["type"] == "effort_applied"),
    )
    .await;
    assert!(quiet.is_err(), "fast mode refreshed effort: {quiet:?}");
    // ── ultracode
    let ultracode = async |body: Value| {
        call(
            &c,
            "POST",
            &format!("{base}/api/sessions/{id}/ultracode"),
            Some(body),
        )
        .await
    };
    for bad in [
        json!({}),
        json!({"enabled": "false"}),
        json!({"enabled": 0}),
    ] {
        assert_eq!(
            ultracode(bad.clone()).await,
            (
                400,
                json!({"error": "invalid 'enabled' (boolean required)"})
            ),
            "{bad}"
        );
    }
    for on in [true, false] {
        assert_eq!(
            ultracode(json!({"enabled": on})).await,
            (200, json!({"ok": true, "enabled": on}))
        );
        // It can move the applied effort, so a refresh follows.
        sse.until(|e| e["type"] == "effort_applied").await;
    }
    let ultra_sent: Vec<Value> = std::fs::read_to_string(&control_log)
        .unwrap()
        .lines()
        .filter_map(|l| serde_json::from_str::<Value>(l).ok())
        .map(|m| m["request"].clone())
        .filter(|r| {
            r["subtype"] == "apply_flag_settings"
                && r["settings"].get("effortLevel").is_none()
                && r["settings"].get("ultracode").is_some()
        })
        .collect();
    assert_eq!(
        ultra_sent,
        vec![
            json!({"subtype": "apply_flag_settings", "settings": {"ultracode": true}}),
            json!({"subtype": "apply_flag_settings", "settings": {"ultracode": false}}),
        ]
    );
    // ── agent
    let agent_url = format!("{base}/api/sessions/{id}/agent");
    assert_eq!(
        call(&c, "GET", &agent_url, None).await,
        (200, json!({"agent": null}))
    );
    for (bad, msg) in [
        (
            json!({}),
            "agent field is required (pass null to reset to default)",
        ),
        (json!({"agent": 5}), "agent must be a string or null"),
        (json!({"agent": ["x"]}), "agent must be a string or null"),
        (json!({"agent": false}), "agent must be a string or null"),
    ] {
        assert_eq!(
            call(&c, "POST", &agent_url, Some(bad.clone())).await,
            (400, json!({"error": msg})),
            "{bad}"
        );
    }
    assert_eq!(
        call(
            &c,
            "POST",
            &agent_url,
            Some(json!({"agent": "code-reviewer"}))
        )
        .await,
        (200, json!({"ok": true, "agent": "code-reviewer"}))
    );
    let ev = sse
        .until(|e| e["type"] == "agent_changed")
        .await
        .pop()
        .unwrap();
    assert_eq!(
        ev,
        json!({"type": "agent_changed", "agent": "code-reviewer"})
    );
    assert_eq!(
        call(&c, "GET", &agent_url, None).await,
        (200, json!({"agent": "code-reviewer"}))
    );
    // A tab that attaches now gets the switched agent in its `ready`.
    let late_ready = async || {
        let req = hyper::Request::get(format!("{base}/api/sessions/{id}/stream?tabId=t9"))
            .body(Full::new(Bytes::new()))
            .unwrap();
        let mut late = Sse {
            body: c.request(req).await.unwrap().into_body(),
            buf: String::new(),
        };
        // The replay carries the start-time `ready`; the route's own
        // follows it.
        late.until(|e| e["type"] == "replay_done").await;
        late.until(|e| e["type"] == "ready").await.pop().unwrap()
    };
    assert_eq!(late_ready().await["agent"], "code-reviewer");
    assert_eq!(
        call(&c, "POST", &agent_url, Some(json!({"agent": null}))).await,
        (200, json!({"ok": true, "agent": null}))
    );
    let ev = sse
        .until(|e| e["type"] == "agent_changed")
        .await
        .pop()
        .unwrap();
    assert_eq!(ev, json!({"type": "agent_changed", "agent": null}));
    assert_eq!(
        call(&c, "GET", &agent_url, None).await,
        (200, json!({"agent": null}))
    );
    assert!(late_ready().await.get("agent").is_none());
    // "" is recorded and broadcast as given, but reads as no agent.
    assert_eq!(
        call(&c, "POST", &agent_url, Some(json!({"agent": ""}))).await,
        (200, json!({"ok": true, "agent": ""}))
    );
    let ev = sse
        .until(|e| e["type"] == "agent_changed")
        .await
        .pop()
        .unwrap();
    assert_eq!(ev["agent"], "");
    assert_eq!(
        call(&c, "GET", &agent_url, None).await,
        (200, json!({"agent": ""}))
    );
    assert!(late_ready().await.get("agent").is_none());
    let agent_sent: Vec<Value> = std::fs::read_to_string(&control_log)
        .unwrap()
        .lines()
        .filter_map(|l| serde_json::from_str::<Value>(l).ok())
        .map(|m| m["request"].clone())
        .filter(|r| r["subtype"] == "apply_flag_settings" && r["settings"].get("agent").is_some())
        .collect();
    assert_eq!(
        agent_sent,
        vec![
            json!({"subtype": "apply_flag_settings", "settings": {"agent": "code-reviewer"}}),
            json!({"subtype": "apply_flag_settings", "settings": {"agent": null}}),
            json!({"subtype": "apply_flag_settings", "settings": {"agent": ""}}),
        ]
    );
    // The fake CLI's initialize reports no agents.
    assert_eq!(
        call(&c, "GET", &format!("{base}/api/sessions/{id}/agents"), None).await,
        (200, json!({"agents": []}))
    );
    // A session whose CLI never spawned has no query: the switch is a
    // no-op (still a 200) and the agents list is a 503.
    let real_bin = mgr
        .runtime
        .lock()
        .unwrap()
        .claude_bin
        .replace(root.path().join("no-such-claude"));
    let (st, dead) = call(
        &c,
        "POST",
        &format!("{base}/api/sessions"),
        Some(json!({"cwd": project, "agent": "planner"})),
    )
    .await;
    mgr.runtime.lock().unwrap().claude_bin = real_bin;
    assert_eq!(st, 200, "{dead}");
    let dead = dead["id"].as_str().unwrap().to_owned();
    assert!(mgr.get(&dead).unwrap().query_handle().is_none());
    assert_eq!(
        call(
            &c,
            "POST",
            &format!("{base}/api/sessions/{dead}/agent"),
            Some(json!({"agent": "code-reviewer"}))
        )
        .await,
        (200, json!({"ok": true, "agent": "code-reviewer"}))
    );
    assert_eq!(
        call(
            &c,
            "GET",
            &format!("{base}/api/sessions/{dead}/agent"),
            None
        )
        .await,
        (200, json!({"agent": "planner"}))
    );
    assert_eq!(
        call(
            &c,
            "GET",
            &format!("{base}/api/sessions/{dead}/agents"),
            None
        )
        .await,
        (503, json!({"error": "session not active"}))
    );
    mgr.remove(&dead).await;
    // ── clear-todos (any body; resumes a reaped session, 404 with no transcript)
    assert_eq!(
        call(
            &c,
            "POST",
            &format!("{base}/api/sessions/{id}/clear-todos"),
            Some(json!("ignored"))
        )
        .await,
        (200, json!({"ok": true}))
    );
    let ev = sse
        .until(|e| e["type"] == "session_snapshot")
        .await
        .pop()
        .unwrap();
    assert_eq!(
        ev,
        json!({"type": "session_snapshot", "todos": [], "todosStale": false})
    );
    assert_eq!(
        call(
            &c,
            "POST",
            &format!("{base}/api/sessions/00000000-0000-0000-0000-000000000000/clear-todos"),
            None
        )
        .await,
        (404, json!({"error": "session not found"}))
    );
    // Not in memory but on disk: resumed, then cleared.
    let reaped = "7c2e3a1c-2a52-4c3e-9b0e-2f7f1a1c0b21";
    let tdir = root
        .path()
        .join("config/projects")
        .join(claudius_core::paths::sdk_project_dir_name(&project));
    std::fs::create_dir_all(&tdir).unwrap();
    std::fs::write(
        tdir.join(format!("{reaped}.jsonl")),
        format!(
            "{}\n",
            json!({"type": "user", "uuid": "r-u", "parentUuid": null, "sessionId": reaped, "cwd": project,
                   "timestamp": "2026-01-02T03:04:05.000Z", "message": {"role": "user", "content": "hi"}})
        ),
    )
    .unwrap();
    assert!(mgr.get(reaped).is_none());
    assert_eq!(
        call(
            &c,
            "POST",
            &format!("{base}/api/sessions/{reaped}/clear-todos"),
            None
        )
        .await,
        (200, json!({"ok": true}))
    );
    assert!(mgr.get(reaped).is_some(), "resumed from its transcript");
    assert!(
        claudius_core::sessions_db::get_session_state(&project, reaped)["todosClearedAt"].is_i64()
    );
    mgr.remove(reaped).await;
    // ── todos/:itemId (resumes a reaped session; 422 when the list moved)
    let item_url = |sid: &str, item: &str| format!("{base}/api/sessions/{sid}/todos/{item}");
    assert_eq!(
        call(
            &c,
            "POST",
            &item_url(&id, "1"),
            Some(json!({"action": "complete"}))
        )
        .await,
        (422, json!({"error": "no active todo list"}))
    );
    let edited = "7c2e3a1c-2a52-4c3e-9b0e-2f7f1a1c0b22";
    let todos = json!([
        {"id": "1", "content": "a", "status": "pending"},
        {"id": "t 2", "content": "b", "status": "pending"},
    ]);
    let stamp = chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
    std::fs::write(
        tdir.join(format!("{edited}.jsonl")),
        format!(
            "{}\n{}\n",
            json!({"type": "user", "uuid": "e-u", "parentUuid": null, "sessionId": edited, "cwd": project,
                   "timestamp": stamp, "message": {"role": "user", "content": "plan"}}),
            json!({"type": "assistant", "uuid": "e-a", "parentUuid": "e-u", "sessionId": edited, "cwd": project,
                   "timestamp": stamp, "message": {"role": "assistant", "id": "msg_e", "content": [
                       {"type": "tool_use", "id": "toolu_e", "name": "TodoWrite", "input": {"todos": todos}}]}})
        ),
    )
    .unwrap();
    assert!(mgr.get(edited).is_none());
    // The path segment is percent-decoded, as Next decodes `[itemId]`.
    assert_eq!(
        call(
            &c,
            "POST",
            &item_url(edited, "t%202"),
            Some(json!({"action": "delete", "extra": true}))
        )
        .await,
        (200, json!({"ok": true}))
    );
    let resumed = mgr.get(edited).expect("resumed from its transcript");
    assert_eq!(
        call(
            &c,
            "POST",
            &item_url(edited, "1"),
            Some(json!({"action": "complete"}))
        )
        .await,
        (200, json!({"ok": true}))
    );
    assert_eq!(
        call(
            &c,
            "POST",
            &item_url(edited, "t%202"),
            Some(json!({"action": "reopen"}))
        )
        .await,
        (422, json!({"error": "item not found"}))
    );
    assert_eq!(
        claudius_core::sessions_db::get_session_state(&project, edited)["manualTodoOverrides"],
        json!({"t 2": "deleted", "1": "completed"})
    );
    let mut esse = Sse::open(&c, &format!("{base}/api/sessions/{edited}/stream")).await;
    esse.until(|e| e["type"] == "replay_done").await;
    let snap = esse
        .until(|e| e["type"] == "session_snapshot")
        .await
        .pop()
        .unwrap();
    assert_eq!(
        snap["todos"],
        json!([{"id": "1", "content": "a", "status": "completed"}])
    );
    drop(esse);
    drop(resumed);
    mgr.remove(edited).await;
    // ── output style
    let style_url = format!("{base}/api/sessions/{id}/output-style");
    let (st, r) = call(&c, "GET", &style_url, None).await;
    assert_eq!(
        (st, r),
        (
            200,
            json!({"current": "default", "available": ["default", "explanatory", "concise", "developer"], "source": "session"})
        ),
        "the fake's initialize reports no styles"
    );
    for bad in [
        Some(json!({})),
        Some(json!({"outputStyle": null})),
        Some(json!({"outputStyle": " \u{a0}\t"})),
        Some(json!("concise")),
        None,
    ] {
        let (st, r) = call(&c, "PATCH", &style_url, bad.clone()).await;
        assert_eq!(
            (st, r),
            (400, json!({"error": "outputStyle is required"})),
            "{bad:?}"
        );
    }
    // `.trim()` on a non-string throws: Next's bare 500.
    for bad in [
        json!({"outputStyle": 5}),
        json!({"outputStyle": ["x"]}),
        json!({"outputStyle": true}),
    ] {
        let (st, r) = call(&c, "PATCH", &style_url, Some(bad.clone())).await;
        assert_eq!((st, r), (500, json!("")), "{bad}");
    }
    let local = std::path::Path::new(&project).join(".claude/settings.local.json");
    std::fs::create_dir_all(local.parent().unwrap()).unwrap();
    std::fs::write(&local, r#"{"a": 1, "outputStyle": "concise", "z": [2]}"#).unwrap();
    let (st, r) = call(
        &c,
        "PATCH",
        &style_url,
        Some(json!({"outputStyle": "\u{feff} explanatory\u{a0}"})),
    )
    .await;
    assert_eq!(
        (st, r),
        (200, json!({"ok": true, "outputStyle": "explanatory"}))
    );
    // Spread semantics: the key keeps its place; 2-space JSON + newline.
    assert_eq!(
        std::fs::read_to_string(&local).unwrap(),
        "{\n  \"a\": 1,\n  \"outputStyle\": \"explanatory\",\n  \"z\": [\n    2\n  ]\n}\n"
    );
    let style_sent: Vec<Value> = std::fs::read_to_string(&control_log)
        .unwrap()
        .lines()
        .filter_map(|l| serde_json::from_str::<Value>(l).ok())
        .map(|m| m["request"].clone())
        .filter(|r| r.to_string().contains("outputStyle"))
        .collect();
    assert_eq!(
        style_sent,
        vec![
            json!({"subtype": "update_settings", "source": "localSettings", "settings": {"outputStyle": "explanatory"}})
        ]
    );
    // A settings file that doesn't parse is the error, and stays untouched.
    std::fs::write(&local, "{\"a\": ").unwrap();
    let (st, r) = call(
        &c,
        "PATCH",
        &style_url,
        Some(json!({"outputStyle": "developer"})),
    )
    .await;
    assert_eq!((st, r["ok"].clone()), (500, json!(false)), "{r}");
    let msg = r["error"].as_str().unwrap();
    assert!(
        msg.starts_with(&format!("{} doesn't load: ", local.display())),
        "{msg}"
    );
    assert_eq!(std::fs::read_to_string(&local).unwrap(), "{\"a\": ");
    std::fs::remove_file(&local).unwrap();
    for method in ["GET", "PATCH"] {
        let (st, r) = call(
            &c,
            method,
            &format!("{base}/api/sessions/00000000-0000-0000-0000-000000000000/output-style"),
            Some(json!({"outputStyle": "x"})),
        )
        .await;
        assert_eq!(
            (st, r),
            (404, json!({"error": "session not found"})),
            "{method}"
        );
    }

    for (method, route) in [("POST", "agent"), ("GET", "agent"), ("GET", "agents")] {
        let (st, r) = call(
            &c,
            method,
            &format!("{base}/api/sessions/00000000-0000-0000-0000-000000000000/{route}"),
            Some(json!({"agent": "x"})),
        )
        .await;
        assert_eq!(
            (st, r),
            (404, json!({"error": "session not found"})),
            "{method} {route}"
        );
    }
    for route in ["ultracode", "fast"] {
        let (st, r) = call(
            &c,
            "POST",
            &format!("{base}/api/sessions/00000000-0000-0000-0000-000000000000/{route}"),
            Some(json!({"enabled": true})),
        )
        .await;
        assert_eq!(
            (st, r),
            (404, json!({"error": "session not found"})),
            "{route}"
        );
    }
    let (st, r) = call(
        &c,
        "POST",
        &format!("{base}/api/sessions/00000000-0000-0000-0000-000000000000/effort"),
        Some(json!({"level": "high"})),
    )
    .await;
    assert_eq!((st, r), (404, json!({"error": "session not found"})));

    // ── per-session disk state the composer / chat load on every bind
    let (_, r) = call(
        &c,
        "GET",
        &format!("{base}/api/sessions/{id}/prompt-draft"),
        None,
    )
    .await;
    assert_eq!(
        r["text"], "draft",
        "initialDraftText from create seeds the composer"
    );
    assert!(r["updatedAt"].is_u64());
    let img = json!({"id": "i1", "ordinal": 0, "data": "AAAA", "mediaType": "image/png"});
    let (_, r) = call(
        &c,
        "PUT",
        &format!("{base}/api/sessions/{id}/prompt-draft"),
        Some(json!({"text": "wip", "images": [img, {"bogus": 1}]})),
    )
    .await;
    assert_eq!(r, json!({"ok": true}));
    let (_, r) = call(
        &c,
        "GET",
        &format!("{base}/api/sessions/{id}/prompt-draft"),
        None,
    )
    .await;
    assert_eq!(
        (r["text"].clone(), r["images"].clone()),
        (json!("wip"), json!([img])),
        "malformed images dropped on read"
    );
    call(
        &c,
        "DELETE",
        &format!("{base}/api/sessions/{id}/prompt-draft"),
        None,
    )
    .await;
    let (_, r) = call(
        &c,
        "GET",
        &format!("{base}/api/sessions/{id}/prompt-draft"),
        None,
    )
    .await;
    assert_eq!(r, json!({"text": "", "images": []}));

    let (_, r) = call(
        &c,
        "POST",
        &format!("{base}/api/sessions/{id}/input"),
        Some(json!({"text": "via chip", "fromSuggestion": true})),
    )
    .await;
    let chip_uuid = r["uuid"].clone();
    let (_, r) = call(
        &c,
        "GET",
        &format!("{base}/api/sessions/{id}/suggested-messages"),
        None,
    )
    .await;
    assert_eq!(r, json!({"uuids": [chip_uuid]}));
    let (_, r) = call(
        &c,
        "GET",
        &format!("{base}/api/sessions/{id}/goal-messages"),
        None,
    )
    .await;
    assert_eq!(r, json!({"uuids": []}));

    let (_, r) = call(
        &c,
        "GET",
        &format!("{base}/api/sessions/{id}/prompt-color"),
        None,
    )
    .await;
    assert_eq!(r, json!({"sessionId": id, "color": null}));
    let (st, _) = call(
        &c,
        "POST",
        &format!("{base}/api/sessions/{id}/prompt-color"),
        Some(json!({"color": "chartreuse"})),
    )
    .await;
    assert_eq!(st, 400);
    let (_, r) = call(
        &c,
        "POST",
        &format!("{base}/api/sessions/{id}/prompt-color"),
        Some(json!({"color": "cyan"})),
    )
    .await;
    assert_eq!(r, json!({"sessionId": id, "color": "cyan"}));
    let (_, r) = call(
        &c,
        "GET",
        &format!("{base}/api/sessions/{id}/prompt-color"),
        None,
    )
    .await;
    assert_eq!(r["color"], "cyan");

    let (_, r) = call(
        &c,
        "GET",
        &format!("{base}/api/sessions/{id}/advisor"),
        None,
    )
    .await;
    assert_eq!(r, json!({"model": null}));
    let (_, r) = call(
        &c,
        "POST",
        &format!("{base}/api/sessions/{id}/advisor"),
        Some(json!({"model": "claude-opus-4-8"})),
    )
    .await;
    assert_eq!(r, json!({"ok": true, "model": "claude-opus-4-8"}));
    let (_, r) = call(
        &c,
        "GET",
        &format!("{base}/api/sessions/{id}/advisor"),
        None,
    )
    .await;
    assert_eq!(r, json!({"model": "claude-opus-4-8"}));
    let user =
        claudius_core::settings::read_settings(claudius_core::settings::Scope::User, &project)
            .unwrap();
    assert_eq!(
        user["advisorModel"], "claude-opus-4-8",
        "persisted as the global default"
    );
    // A model switch auto-disables the advisor (file + flag layer) and says so.
    call(
        &c,
        "POST",
        &format!("{base}/api/sessions/{id}/model"),
        Some(json!({"model": "fake-model"})),
    )
    .await;
    let ev = sse
        .until(|e| e["type"] == "advisor_disabled_on_model_change")
        .await
        .pop()
        .unwrap();
    assert_eq!(
        (ev["previousAdvisor"].clone(), ev["newModel"].clone()),
        (json!("claude-opus-4-8"), json!("fake-model"))
    );
    let user =
        claudius_core::settings::read_settings(claudius_core::settings::Scope::User, &project)
            .unwrap();
    assert!(user.get("advisorModel").is_none());
    let (_, r) = call(
        &c,
        "POST",
        &format!("{base}/api/sessions/{id}/advisor"),
        Some(json!({"model": "gpt-9"})),
    )
    .await;
    assert_eq!(
        r,
        json!({"ok": true, "model": null}),
        "unknown advisor → cleared (normalizeAdvisorChoice)"
    );

    // unknown session
    let (st, r) = call(
        &c,
        "POST",
        &format!("{base}/api/sessions/00000000-0000-0000-0000-000000000000/input"),
        Some(json!({"text": "x"})),
    )
    .await;
    assert_eq!((st, r), (404, json!({"error": "session not found"})));
    let (st, _) = call(
        &c,
        "GET",
        &format!("{base}/api/sessions/00000000-0000-0000-0000-000000000000/prompt-draft"),
        None,
    )
    .await;
    assert_eq!(st, 404);
    let (st, r) = call(
        &c,
        "GET",
        &format!("{base}/api/sessions/00000000-0000-0000-0000-000000000000/goal-messages"),
        None,
    )
    .await;
    assert_eq!((st, r), (200, json!({"uuids": []})));

    for s in mgr.list() {
        mgr.remove(&s.id).await;
    }
}
