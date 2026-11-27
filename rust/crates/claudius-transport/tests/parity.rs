//! Parity: one scripted scenario through [`InProcessTransport`] and
//! [`RemoteTransport`] against the same server state and the fake CLI
//! (the `claudius-server` `http.rs` setup). The two run in lockstep, each
//! step on both, and must see the same statuses, content types, bodies and
//! event sequences. Each transport gets its own session, so a body that
//! names it is compared with its id (and the uuids and times a turn mints)
//! replaced by placeholders.

#[path = "../../claudius-agent/tests/support/test_bins.rs"]
mod test_bins;

use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

use claudius_core::session::RuntimeOptions;
use claudius_core::session_manager::SessionManager;
use claudius_core::{paths, workspaces};
use claudius_server::{AppState, app};
use claudius_transport::{
    EventSource, EventSourceEvent, EventSourceOptions, InProcessTransport, ReadyState,
    RemoteTransport, Request, Response, Transport,
};
use serde_json::{Value, json};

struct Side {
    name: &'static str,
    t: Arc<dyn Transport>,
    jar: Arc<claudius_transport::CookieJar>,
    /// This side's session, once created.
    sid: String,
}

/// What a step saw, for comparing: status, content type, and the body
/// (JSON when it parses) with the side's session id replaced.
#[derive(Debug, PartialEq)]
struct Seen {
    status: u16,
    content_type: Option<String>,
    body: Value,
}

fn seen(res: &Response, sid: &str) -> Seen {
    let text = res.text();
    let body = serde_json::from_str(&text).unwrap_or(Value::String(text));
    Seen {
        status: res.status,
        content_type: res
            .headers
            .get("content-type")
            .map(|v| v.to_str().unwrap().to_owned()),
        body: normalize(body, sid),
    }
}

fn is_uuid(s: &str) -> bool {
    s.len() == 36
        && s.char_indices().all(|(i, c)| {
            if [8, 13, 18, 23].contains(&i) {
                c == '-'
            } else {
                c.is_ascii_hexdigit()
            }
        })
}

/// Keys whose numbers are times or durations.
fn is_time_key(k: &str) -> bool {
    k.ends_with("At")
        || k.ends_with("_at")
        || k.ends_with("Ms")
        || k.ends_with("_ms")
        || ["at", "ts", "timestamp", "time", "mtime", "lastActivity"].contains(&k)
}

fn normalize(v: Value, sid: &str) -> Value {
    match v {
        Value::String(s) => {
            let s = if sid.is_empty() {
                s
            } else {
                s.replace(sid, "<sid>")
            };
            if is_uuid(&s) {
                return json!("<uuid>");
            }
            // The fake CLI's message ids, `msg_<32 hex>`.
            if s.strip_prefix("msg_")
                .is_some_and(|h| h.len() == 32 && h.bytes().all(|b| b.is_ascii_hexdigit()))
            {
                return json!("<msg-id>");
            }
            // An ISO timestamp.
            if s.len() >= 20 && s.as_bytes()[4] == b'-' && s.as_bytes()[10] == b'T' {
                return json!("<time>");
            }
            Value::String(s)
        }
        Value::Array(a) => Value::Array(a.into_iter().map(|v| normalize(v, sid)).collect()),
        Value::Object(m) => Value::Object(
            m.into_iter()
                .map(|(k, v)| {
                    let v = if is_time_key(&k) && v.is_number() {
                        json!("<num>")
                    } else {
                        normalize(v, sid)
                    };
                    (k, v)
                })
                .collect(),
        ),
        v => v,
    }
}

async fn fetch(side: &Side, req: Request) -> Response {
    tokio::time::timeout(Duration::from_secs(30), side.t.fetch(req))
        .await
        .unwrap_or_else(|_| panic!("{}: fetch timed out", side.name))
        .unwrap_or_else(|e| panic!("{}: {e}", side.name))
}

/// Run one request on both sides; both must see the same (normalized)
/// response, which is returned. A body about the side's own session has
/// its id replaced.
async fn both(sides: &[Side; 2], req: impl Fn(&Side) -> Request) -> Seen {
    on_both(sides, true, req).await
}

/// [`both`] for a body that is the same server state for both sides (the
/// session list): ids stay.
async fn both_shared(sides: &[Side; 2], req: impl Fn(&Side) -> Request) -> Seen {
    on_both(sides, false, req).await
}

async fn on_both(sides: &[Side; 2], own: bool, req: impl Fn(&Side) -> Request) -> Seen {
    let mut out = Vec::new();
    for side in sides {
        let res = fetch(side, req(side)).await;
        out.push(seen(&res, if own { &side.sid } else { "" }));
    }
    let b = out.pop().unwrap();
    let a = out.pop().unwrap();
    assert_eq!(a, b, "in-process vs remote");
    a
}

async fn next(es: &mut EventSource, who: &str) -> EventSourceEvent {
    tokio::time::timeout(Duration::from_secs(30), es.recv())
        .await
        .unwrap_or_else(|_| panic!("{who}: no event in 30 s"))
        .unwrap_or_else(|| panic!("{who}: stream ended"))
}

/// Events up to and including the first one `stop` matches, as parsed
/// JSON (an `open` / `error` as a marker string), normalized.
async fn read_until(
    es: &mut EventSource,
    side: &Side,
    stop: impl Fn(&Value) -> bool,
) -> Vec<Value> {
    let mut out = Vec::new();
    loop {
        let ev = next(es, side.name).await;
        let v = match ev {
            EventSourceEvent::Open => json!("<open>"),
            EventSourceEvent::Error { ready_state } => json!(format!("<error {ready_state:?}>")),
            EventSourceEvent::Message {
                data, event_type, ..
            } => {
                assert_eq!(event_type, "message");
                serde_json::from_str(&data).unwrap()
            }
        };
        let done = stop(&v);
        out.push(normalize(v, &side.sid));
        if done {
            return out;
        }
    }
}

/// Wait until a session's CLI is up and its startup state is in: the
/// stream head of a fresh subscriber (no tab, so no holder change) has the
/// init and the applied effort. Otherwise the two sides' heads differ by
/// how far each CLI got, which is the server's timing, not the transport's.
async fn wait_settled(t: &Arc<dyn Transport>, sid: &str) {
    let t0 = std::time::Instant::now();
    loop {
        let mut es = EventSource::open(
            t.clone(),
            format!("/api/sessions/{sid}/stream?tail=20"),
            EventSourceOptions::default(),
        );
        let mut types = Vec::new();
        loop {
            let ev = tokio::time::timeout(Duration::from_secs(10), es.recv())
                .await
                .expect("a head event");
            let data = match ev {
                Some(EventSourceEvent::Open) => continue,
                Some(EventSourceEvent::Message { data, .. }) => data,
                other => panic!("{sid}: {other:?}"),
            };
            let v: Value = serde_json::from_str(&data).unwrap();
            let ty = v["type"].as_str().unwrap_or_default().to_owned();
            match ty.as_str() {
                "sdk" => types.push(format!(
                    "sdk/{}",
                    v["message"]["subtype"].as_str().unwrap_or("")
                )),
                "tips" => break,
                _ => types.push(ty),
            }
        }
        es.close();
        if types.iter().any(|t| t == "sdk/init") && types.iter().any(|t| t == "effort_applied") {
            return;
        }
        assert!(
            t0.elapsed() < Duration::from_secs(20),
            "{sid} never settled: {types:?}"
        );
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
}

fn assistant_text(e: &Value) -> Option<&str> {
    (e["type"] == "sdk" && e["message"]["type"] == "assistant")
        .then(|| e["message"]["message"]["content"][0]["text"].as_str())
        .flatten()
}

#[tokio::test]
async fn in_process_and_remote_see_the_same_server() {
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

    let mgr = Arc::new(SessionManager::default());
    let mut envmap: HashMap<String, String> = HashMap::new();
    envmap.insert("PATH".into(), std::env::var("PATH").unwrap_or_default());
    *mgr.runtime.lock().unwrap() = RuntimeOptions {
        claude_bin: Some(test_bins::fake_claude()),
        env_override: Some(envmap),
    };
    let state = AppState::new(mgr.clone(), None, true);

    let inproc = InProcessTransport::new(state.clone());
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let router = app(state);
    tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });
    let remote = RemoteTransport::new(&format!("http://{addr}")).unwrap();
    let mut sides = [
        Side {
            name: "in-process",
            jar: inproc.cookie_jar().clone(),
            t: Arc::new(inproc),
            sid: String::new(),
        },
        Side {
            name: "remote",
            jar: remote.cookie_jar().clone(),
            t: Arc::new(remote),
            sid: String::new(),
        },
    ];

    // ── plain routes
    let s = both(&sides, |_| Request::get("/api/rust/health")).await;
    assert_eq!((s.status, &s.body["backend"]), (200, &json!("rust")));
    let s = both(&sides, |_| {
        Request::post("/api/sessions").json(r#"{"cwd":"/definitely/not/trusted"}"#)
    })
    .await;
    assert_eq!((s.status, s.body), (400, json!({"error": "unknown cwd"})));
    let s = both(&sides, |_| {
        Request::post("/api/sessions").json(r#"{"resume":"nope"}"#)
    })
    .await;
    assert_eq!(
        (s.status, s.body),
        (400, json!({"error": "invalid resume id"}))
    );
    let s = both(&sides, |_| Request::get("/api/sessions/nope/account")).await;
    assert_eq!(
        (s.status, s.body),
        (404, json!({"error": "session not found"}))
    );
    let s = both(&sides, |_| Request::get("/api/sessions/abc/no-such-route")).await;
    assert_eq!((s.status, &s.body["notPorted"]), (501, &json!(true)));
    // A method the route doesn't export: axum's 405, empty.
    let s = both(&sides, |_| Request::new("DELETE", "/api/rust/health")).await;
    assert_eq!(s.status, 405);
    // `fetch` sends a lowercase `patch` as given, so no route matches it.
    let s = both(&sides, |_| Request::new("put", "/api/rust/health")).await;
    assert_eq!(s.status, 405);

    // ── cookies: `select` sets the workspace cookie; the list reads it.
    let s = both(&sides, |_| {
        Request::post(format!("/api/workspaces/{}/select", ws.id))
    })
    .await;
    assert_eq!((s.status, s.body), (200, json!({"ok": true, "id": ws.id})));
    for side in &sides {
        assert_eq!(
            side.jar.get("claudius.workspace").as_deref(),
            Some(ws.id.as_str()),
            "{}",
            side.name
        );
    }
    let s = both(&sides, |_| Request::get("/api/workspaces")).await;
    assert_eq!(s.status, 200);

    // ── a session each
    for side in &mut sides {
        let body = json!({"cwd": project}).to_string();
        let res = fetch(side, Request::post("/api/sessions").json(body)).await;
        assert_eq!(res.status, 200, "{}: {}", side.name, res.text());
        let v: Value = serde_json::from_str(&res.text()).unwrap();
        side.sid = v["id"].as_str().unwrap().to_owned();
    }
    assert_ne!(sides[0].sid, sides[1].sid);
    // Both see both, the same.
    let s = both_shared(&sides, |_| {
        Request::get(format!("/api/sessions?workspaceId={}", ws.id))
    })
    .await;
    assert_eq!(s.body.as_array().map(Vec::len), Some(2), "{:?}", s.body);

    for side in &sides {
        wait_settled(&side.t, &side.sid).await;
    }

    // ── the stream, as the hook opens it
    let mut streams: Vec<EventSource> = sides
        .iter()
        .map(|side| {
            EventSource::open(
                side.t.clone(),
                format!("/api/sessions/{}/stream?tail=20&tabId=t1", side.sid),
                EventSourceOptions::default(),
            )
        })
        .collect();
    let mut heads = Vec::new();
    for (side, es) in sides.iter().zip(&mut streams) {
        heads.push(read_until(es, side, |e| e["type"] == "holder_changed").await);
        assert_eq!(es.ready_state(), ReadyState::Open);
    }
    assert_eq!(heads[0], heads[1], "stream head");
    let head = &heads[0];
    assert_eq!(head[0], json!("<open>"));
    let rd = head
        .iter()
        .position(|e| e["type"] == "replay_done")
        .unwrap();
    let ready = head.iter().rposition(|e| e["type"] == "ready").unwrap();
    assert!(ready > rd, "the route's ready follows the replay: {head:?}");

    // ── a prompt, read to the turn's end
    let s = both(&sides, |side| {
        Request::post(format!("/api/sessions/{}/input", side.sid)).json(r#"{"text":"hello"}"#)
    })
    .await;
    assert_eq!((s.status, &s.body["queued"]), (200, &json!(false)));
    let mut turns = Vec::new();
    for (side, es) in sides.iter().zip(&mut streams) {
        turns.push(
            read_until(es, side, |e| {
                e["type"] == "turn_status" && e["status"] == "idle"
            })
            .await,
        );
    }
    assert_eq!(turns[0], turns[1], "the turn's events");
    assert_eq!(
        turns[0].iter().find_map(assistant_text),
        Some("echo:hello"),
        "{:?}",
        turns[0]
    );
    let s = both(&sides, |side| {
        Request::post(format!("/api/sessions/{}/input", side.sid)).json("{}")
    })
    .await;
    assert_eq!(s.status, 400);
    let s = both(&sides, |side| {
        Request::get(format!("/api/sessions/{}/pending-prompts", side.sid))
    })
    .await;
    assert_eq!(s.status, 200);

    // ── a missing session's stream: a text 404, which fails the source
    let missing = "00000000-0000-4000-8000-000000000000";
    let s = both(&sides, |_| {
        Request::get(format!("/api/sessions/{missing}/stream?tail=20&tabId=t1"))
    })
    .await;
    assert_eq!(
        (s.status, s.body),
        (404, json!("session not found")),
        "plain text"
    );
    for side in &sides {
        let mut es = EventSource::open(
            side.t.clone(),
            format!("/api/sessions/{missing}/stream?tail=20&tabId=t1"),
            EventSourceOptions::default(),
        );
        assert_eq!(
            next(&mut es, side.name).await,
            EventSourceEvent::Error {
                ready_state: ReadyState::Closed
            }
        );
        assert_eq!(es.recv().await, None);
    }

    // ── closing a stream ends its subscription on the server: the holder
    // tab goes, so the next stream's head has no holder.
    for es in &mut streams {
        es.close();
    }
    drop(streams);
    for side in &sides {
        let t0 = std::time::Instant::now();
        loop {
            let session = mgr.get(&side.sid).expect("live session");
            if session.subscriber_count() == 0 {
                break;
            }
            assert!(
                t0.elapsed() < Duration::from_secs(10),
                "{}: still subscribed",
                side.name
            );
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    }

    // Leave no CLI behind.
    for side in &sides {
        mgr.remove(&side.sid).await;
    }
}
