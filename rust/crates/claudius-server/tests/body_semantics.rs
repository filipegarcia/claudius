//! Request-body semantics of the ported routes, over real HTTP: each route
//! fails on an empty / malformed / `null` body exactly like its TS handler
//! (see `src/body.rs` for the mapping).

#[path = "../../claudius-agent/tests/support/test_bins.rs"]
mod test_bins;

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;

use bytes::Bytes;
use claudius_core::session::RuntimeOptions;
use claudius_core::session_manager::SessionManager;
use claudius_core::{paths, workspaces};
use claudius_server::{AppState, app};
use http_body_util::{BodyExt, Full};
use hyper_util::client::legacy::Client;
use hyper_util::client::legacy::connect::HttpConnector;
use hyper_util::rt::TokioExecutor;
use serde_json::{Value, json};

type HttpClient = Client<HttpConnector, Full<Bytes>>;

fn fake_bin() -> PathBuf {
    test_bins::fake_claude()
}

struct Resp {
    status: u16,
    body: String,
    content_type: Option<String>,
}

impl Resp {
    fn json(&self) -> Value {
        serde_json::from_str(&self.body).unwrap_or(Value::Null)
    }
    /// Next's response to a thrown handler: empty 500, no content type.
    fn is_thrown(&self) -> bool {
        self.status == 500 && self.body.is_empty() && self.content_type.is_none()
    }
}

async fn raw(c: &HttpClient, method: &str, url: &str, body: &'static [u8]) -> Resp {
    let req = hyper::Request::builder()
        .method(method)
        .uri(url)
        .header("content-type", "application/json")
        .body(Full::new(Bytes::from_static(body)))
        .unwrap();
    let resp = c.request(req).await.unwrap();
    let status = resp.status().as_u16();
    let content_type = resp
        .headers()
        .get("content-type")
        .map(|v| v.to_str().unwrap().to_owned());
    let bytes = resp.into_body().collect().await.unwrap().to_bytes();
    Resp {
        status,
        body: String::from_utf8_lossy(&bytes).into_owned(),
        content_type,
    }
}

#[tokio::test]
async fn routes_fail_on_bad_bodies_like_their_ts_handlers() {
    let root = tempfile::tempdir().unwrap();
    let (home, config, project) = (
        root.path().join("home"),
        root.path().join("config"),
        root.path().join("project"),
    );
    for d in [&home, &config, &project] {
        std::fs::create_dir_all(d).unwrap();
    }
    paths::set_home_override(home);
    paths::set_config_dir_override(config);
    let project = project.canonicalize().unwrap().display().to_string();
    workspaces::create(workspaces::NewWorkspace {
        name: "Proj".into(),
        root_path: project.clone(),
        icon: None,
        defaults: None,
    })
    .unwrap();
    let mgr = Arc::new(SessionManager::default());
    let mut envmap: HashMap<String, String> = HashMap::new();
    envmap.insert("PATH".into(), std::env::var("PATH").unwrap_or_default());
    *mgr.runtime.lock().unwrap() = RuntimeOptions {
        claude_bin: Some(fake_bin()),
        env_override: Some(envmap),
    };
    let router = app(AppState::new(mgr.clone(), None, true));
    let l = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}", l.local_addr().unwrap());
    tokio::spawn(async move { axum::serve(l, router).await.unwrap() });
    let c: HttpClient = Client::builder(TokioExecutor::new()).build(HttpConnector::new());
    let missing = "00000000-0000-4000-8000-000000000000";

    // POST /api/sessions: try/catch → {} (lenient), but `body.resume` throws on `null`.
    assert!(
        raw(&c, "POST", &format!("{base}/api/sessions"), b"null")
            .await
            .is_thrown()
    );
    let r = raw(
        &c,
        "POST",
        &format!("{base}/api/sessions"),
        b"{\"resume\":\"nope\"",
    )
    .await;
    assert_ne!(
        r.status, 500,
        "malformed create body falls back to {{}}: {}",
        r.body
    );
    let created = raw(
        &c,
        "POST",
        &format!("{base}/api/sessions"),
        Box::leak(
            json!({"cwd": project})
                .to_string()
                .into_bytes()
                .into_boxed_slice(),
        ),
    )
    .await;
    assert_eq!(created.status, 200, "{}", created.body);
    let id = created.json()["id"].as_str().unwrap().to_owned();
    let s = |rest: &str| format!("{base}/api/sessions/{id}/{rest}");
    let gone = |rest: &str| format!("{base}/api/sessions/{missing}/{rest}");

    // Strict `await req.json()`: empty/malformed → bare 500. A `null` body is
    // fine where the handler uses `body?.x`.
    for route in [
        "permission",
        "model",
        "advisor",
        "effort",
        "fast",
        "ultracode",
    ] {
        for bad in [&b""[..], b"{", b"not json"] {
            let r = raw(&c, "POST", &s(route), bad).await;
            assert!(
                r.is_thrown(),
                "{route} {bad:?} → {} {:?} {}",
                r.status,
                r.content_type,
                r.body
            );
        }
        // The session lookup runs before req.json(): unknown id → 404 even with a bad body.
        let r = raw(&c, "POST", &gone(route), b"{").await;
        assert_eq!(
            (r.status, r.json()),
            (404, json!({"error": "session not found"})),
            "{route}"
        );
    }
    // input: `req.json().catch(() => null)`, and the validation runs before the
    // session lookup and the dead-session restart (CC 2.1.311), so a body with
    // no text or images is a 400 whatever the id.
    for bad in [
        &b""[..],
        b"{",
        b"not json",
        b"null",
        b"0",
        b"false",
        b"\"hi\"",
        b"{}",
    ] {
        for url in [s("input"), gone("input")] {
            let r = raw(&c, "POST", &url, bad).await;
            assert_eq!(
                (r.status, r.json()),
                (400, json!({"error": "text or images required"})),
                "input {bad:?}"
            );
        }
    }
    let r = raw(&c, "POST", &gone("input"), b"{\"text\":\"hi\"}").await;
    assert_eq!(
        (r.status, r.json()),
        (404, json!({"error": "session not found"})),
        "input on an unknown id"
    );
    let r = raw(&c, "POST", &s("permission"), b"[1]").await;
    assert_eq!(
        (r.status, r.json()),
        (400, json!({"error": "requestId and decision required"}))
    );
    // effort: strict, but `!body?.level` lets a non-object body reach the 400.
    for bad in [&b"null"[..], b"\"str\"", b"[1]", b"7"] {
        let r = raw(&c, "POST", &s("effort"), bad).await;
        assert_eq!(
            (r.status, r.json()),
            (400, json!({"error": "invalid effort level"})),
            "effort {bad:?}"
        );
    }
    // fast / ultracode: strict, and `typeof body?.enabled` never throws.
    for route in ["fast", "ultracode"] {
        for bad in [&b"null"[..], b"\"str\"", b"[true]", b"true"] {
            let r = raw(&c, "POST", &s(route), bad).await;
            assert_eq!(
                (r.status, r.json()),
                (
                    400,
                    json!({"error": "invalid 'enabled' (boolean required)"})
                ),
                "{route} {bad:?}"
            );
        }
    }
    let r = raw(&c, "POST", &format!("{base}/api/sessions/rename"), b"").await;
    assert!(r.is_thrown(), "rename is strict too");
    let r = raw(&c, "POST", &format!("{base}/api/sessions/rename"), b"null").await;
    assert_eq!(
        (r.status, r.json()),
        (400, json!({"error": "sessionId and title required"}))
    );

    // try/catch → 400 "invalid json".
    for route in ["ask-answer", "plan"] {
        let r = raw(&c, "POST", &s(route), b"{").await;
        assert_eq!(
            (r.status, r.json()),
            (400, json!({"error": "invalid json"})),
            "{route}"
        );
        assert_eq!(r.content_type.as_deref(), Some("application/json"));
    }

    // agent: try/catch → 400 "invalid JSON body", then `const { agent } =
    // body` throws on `null` but reads `undefined` off any other non-object.
    for bad in [&b""[..], b"{", b"not json"] {
        let r = raw(&c, "POST", &s("agent"), bad).await;
        assert_eq!(
            (r.status, r.json()),
            (400, json!({"error": "invalid JSON body"})),
            "agent {bad:?}"
        );
    }
    assert!(raw(&c, "POST", &s("agent"), b"null").await.is_thrown());
    for bad in [&b"\"str\""[..], b"[\"x\"]", b"7", b"true", b"{}"] {
        let r = raw(&c, "POST", &s("agent"), bad).await;
        assert_eq!(
            (r.status, r.json()),
            (
                400,
                json!({"error": "agent field is required (pass null to reset to default)"})
            ),
            "agent {bad:?}"
        );
    }
    let r = raw(&c, "POST", &gone("agent"), b"null").await;
    assert_eq!(
        (r.status, r.json()),
        (404, json!({"error": "session not found"}))
    );

    // todos/:itemId: try/catch → 400 "invalid JSON body", then `body.action`
    // throws on `null`; anything but the four actions is a 400. All before
    // the session is looked up.
    let action_err =
        json!({"error": "action must be one of: complete, reopen, in_progress, delete"});
    for url in [s("todos/1"), gone("todos/1")] {
        for bad in [&b""[..], b"{", b"not json"] {
            let r = raw(&c, "POST", &url, bad).await;
            assert_eq!(
                (r.status, r.json()),
                (400, json!({"error": "invalid JSON body"})),
                "{url} {bad:?}"
            );
        }
        assert!(raw(&c, "POST", &url, b"null").await.is_thrown(), "{url}");
        for bad in [
            &b"\"str\""[..],
            b"[]",
            b"7",
            b"{}",
            br#"{"action":"Complete"}"#,
            br#"{"action":" complete"}"#,
            br#"{"action":1}"#,
            br#"{"action":["complete"]}"#,
            br#"{"action":null}"#,
        ] {
            let r = raw(&c, "POST", &url, bad).await;
            assert_eq!(
                (r.status, r.json()),
                (400, action_err.clone()),
                "{url} {bad:?}"
            );
        }
    }
    let r = raw(&c, "POST", &gone("todos/1"), br#"{"action":"delete"}"#).await;
    assert_eq!(
        (r.status, r.json()),
        (404, json!({"error": "session not found"}))
    );

    // .catch(() => null) / ({}) with `?.`: a bad body reads as missing fields.
    for (method, route, err) in [
        ("POST", "mode", "invalid mode"),
        ("PATCH", "holder", "tabId required"),
        ("POST", "stop-task", "taskId required"),
        (
            "POST",
            "elicitation",
            "requestId and a valid decision required",
        ),
    ] {
        for bad in [&b""[..], b"{", b"null", b"\"str\""] {
            let r = raw(&c, method, &s(route), bad).await;
            assert_eq!(
                (r.status, r.json()),
                (400, json!({"error": err})),
                "{route} {bad:?}"
            );
        }
    }
    let r = raw(&c, "POST", &s("goal"), b"{").await;
    assert_eq!(
        (r.status, r.json()["ok"].clone()),
        (200, json!(true)),
        "malformed goal body clears"
    );
    // `body?.toolUseId` only if a string: any bad body backgrounds everything.
    for bad in [&b""[..], b"{", b"null", b"\"str\"", br#"{"toolUseId":1}"#] {
        let r = raw(&c, "POST", &s("background-task"), bad).await;
        assert_eq!(
            (r.status, r.json()),
            (200, json!({"ok": true, "backgrounded": true})),
            "background-task {bad:?}"
        );
    }
    let r = raw(&c, "POST", &gone("background-task"), b"{").await;
    assert_eq!(
        (r.status, r.json()),
        (404, json!({"error": "session not found"}))
    );
    // `try { await req.json() } catch { 400 }`, then a string `command`
    // (bash_golden pins the rest).
    for (bad, msg) in [
        (&b""[..], "invalid JSON body"),
        (b"{", "invalid JSON body"),
        (b"null", "command required"),
        (b"\"str\"", "command required"),
        (br#"{"command":1}"#, "command required"),
    ] {
        let r = raw(&c, "POST", &s("bash"), bad).await;
        assert_eq!(
            (r.status, r.json()),
            (400, json!({"error": msg})),
            "bash {bad:?}"
        );
    }
    let r = raw(&c, "POST", &gone("bash"), b"{").await;
    assert_eq!(
        (r.status, r.json()),
        (404, json!({"error": "session not found"}))
    );

    // .catch(() => ({})) then `body.x` WITHOUT `?.`: malformed → fallback,
    // but a literal `null` throws.
    let r = raw(&c, "PUT", &s("prompt-draft"), b"{").await;
    assert_eq!((r.status, r.json()), (200, json!({"ok": true})));
    assert!(
        raw(&c, "PUT", &s("prompt-draft"), b"null")
            .await
            .is_thrown()
    );
    let r = raw(&c, "POST", &s("prompt-color"), b"{").await;
    assert_eq!(
        (r.status, r.json()),
        (400, json!({"error": "invalid color"})),
        "missing color is invalid"
    );
    assert!(
        raw(&c, "POST", &s("prompt-color"), b"null")
            .await
            .is_thrown()
    );
    // prompt-color parses before its 404 check, but only touches `body.color` after it.
    let r = raw(&c, "POST", &gone("prompt-color"), b"null").await;
    assert_eq!(r.status, 404);
    let r = raw(&c, "POST", &s("prompt-color"), b"[\"red\"]").await;
    assert_eq!(
        (r.status, r.json()),
        (400, json!({"error": "invalid color"})),
        "array body: color undefined"
    );

    mgr.remove(&id).await;
}
