//! What a route receives, and what comes back, is the same through both
//! transports: an echo router served on a socket for [`RemoteTransport`]
//! and called directly by [`InProcessTransport`].

use std::sync::Arc;
use std::time::Duration;

use axum::Router;
use axum::body::{Body, Bytes};
use axum::extract::Request as AxumRequest;
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{any, get};
use claudius_transport::{InProcessTransport, RemoteTransport, Request, Transport, TransportError};
use serde_json::{Value, json};

/// Echo the request: method, target, headers (sorted; `host` and `origin`
/// left out, they name each transport's origin) and body.
async fn echo(req: AxumRequest) -> Response {
    let (parts, body) = req.into_parts();
    let body = axum::body::to_bytes(body, usize::MAX).await.unwrap();
    let mut headers: Vec<(String, String)> = parts
        .headers
        .iter()
        .filter(|(k, _)| *k != "host" && *k != "origin")
        .map(|(k, v)| {
            (
                k.to_string(),
                String::from_utf8_lossy(v.as_bytes()).into_owned(),
            )
        })
        .collect();
    headers.sort();
    let has_origin = parts.headers.contains_key("origin");
    let v = json!({
        "method": parts.method.as_str(),
        "uri": parts.uri.to_string(),
        "version": format!("{:?}", parts.version),
        "headers": headers,
        "hasOrigin": has_origin,
        "body": String::from_utf8_lossy(&body),
    });
    (
        [
            ("content-type", "application/json"),
            ("set-cookie", "seen=1; Path=/"),
        ],
        v.to_string(),
    )
        .into_response()
}

async fn chunks() -> Response {
    let s = futures::stream::iter(["a", "b", "c"].map(|c| Ok::<_, std::io::Error>(Bytes::from(c))));
    Response::new(Body::from_stream(s))
}

/// A body that breaks off after a chunk. The pause lets hyper flush the
/// head and the chunk first: a body that fails before that costs the
/// whole response over HTTP (a network error), while in-process the head
/// always arrives.
async fn broken() -> Response {
    let s = futures::stream::unfold(0, |n| async move {
        match n {
            0 => Some((Ok(Bytes::from("partial")), 1)),
            1 => {
                tokio::time::sleep(Duration::from_millis(100)).await;
                Some((Err(std::io::Error::other("boom")), 2))
            }
            _ => None,
        }
    });
    Response::new(Body::from_stream(s))
}

async fn body_panics() -> Response {
    let s = futures::stream::unfold(0, |n| async move {
        match n {
            0 => Some((Ok::<_, std::io::Error>(Bytes::from("partial")), 1)),
            _ => panic!("body panic (expected by the test)"),
        }
    });
    Response::new(Body::from_stream(s))
}

async fn panics() -> Response {
    panic!("handler panic (expected by the test)")
}

async fn status(headers: HeaderMap) -> Response {
    let cookie = headers
        .get("cookie")
        .map(|v| v.to_str().unwrap().to_owned())
        .unwrap_or_default();
    (StatusCode::IM_A_TEAPOT, cookie).into_response()
}

fn router() -> Router {
    Router::new()
        .route("/echo", any(echo))
        .route("/echo/{*rest}", any(echo))
        .route("/chunks", get(chunks))
        .route("/broken", get(broken))
        .route("/panics", get(panics))
        .route("/body-panics", get(body_panics))
        .route("/status", get(status))
}

async fn transports() -> [(&'static str, Arc<dyn Transport>); 2] {
    let l = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = l.local_addr().unwrap();
    tokio::spawn(async move { axum::serve(l, router()).await.unwrap() });
    [
        (
            "in-process",
            Arc::new(InProcessTransport::from_router(router())),
        ),
        (
            "remote",
            Arc::new(RemoteTransport::new(&format!("http://{addr}")).unwrap()),
        ),
    ]
}

#[tokio::test]
async fn a_route_sees_the_same_request() {
    let ts = transports().await;
    let reqs = [
        Request::get("/echo?x=1&y=a b"),
        Request::post("/echo").json(r#"{"a":1}"#),
        Request::post("/echo"),
        Request::new("put", "/echo").body("text"),
        Request::new("DELETE", "/echo/a/../b"),
        Request::new("PATCH", "/echo")
            .header("X-Two", "1")
            .header("x-two", "2"),
        Request::get("/echo/caf\u{e9}").header("Accept", "text/event-stream"),
    ];
    for req in reqs {
        let mut seen = Vec::new();
        for (name, t) in &ts {
            let res = t.fetch(req.clone()).await.unwrap();
            assert_eq!(res.status, 200, "{name}");
            let v: Value = serde_json::from_str(&res.text()).unwrap();
            seen.push(v);
        }
        assert_eq!(seen[0], seen[1], "{req:?}");
        let method = seen[0]["method"].as_str().unwrap();
        assert_eq!(
            seen[0]["hasOrigin"],
            json!(method != "GET" && method != "HEAD"),
            "{req:?}"
        );
    }
}

#[tokio::test]
async fn cookies_ride_along_on_both() {
    for (name, t) in transports().await {
        let res = t.fetch(Request::get("/status")).await.unwrap();
        assert_eq!((res.status, res.text()), (418, String::new()), "{name}");
        // The echo's `Set-Cookie` is kept, then sent.
        t.fetch(Request::get("/echo")).await.unwrap();
        let res = t.fetch(Request::get("/status")).await.unwrap();
        assert_eq!(res.text(), "seen=1", "{name}");
    }
}

#[tokio::test]
async fn bodies_stream_and_break_the_same() {
    for (name, t) in transports().await {
        let res = t.fetch(Request::get("/chunks")).await.unwrap();
        assert_eq!(res.text(), "abc", "{name}");
        let err = t.fetch(Request::get("/broken")).await.unwrap_err();
        assert!(matches!(err, TransportError::Body(_)), "{name}: {err:?}");
        // A 404 from the router: empty.
        let res = t.fetch(Request::get("/nope")).await.unwrap();
        assert_eq!((res.status, res.text()), (404, String::new()), "{name}");
        // A refused request never reaches the route.
        let err = t.fetch(Request::get("/echo").body("x")).await.unwrap_err();
        assert!(matches!(err, TransportError::Invalid(_)), "{name}");
    }
}

#[tokio::test]
async fn a_panicking_handler_is_a_network_error() {
    for (name, t) in transports().await {
        let err = tokio::time::timeout(Duration::from_secs(10), t.fetch(Request::get("/panics")))
            .await
            .unwrap()
            .unwrap_err();
        assert!(matches!(err, TransportError::Network(_)), "{name}: {err:?}");
        // The transport still works.
        let res = t.fetch(Request::get("/chunks")).await.unwrap();
        assert_eq!(res.text(), "abc", "{name}");
    }
}

#[tokio::test]
async fn in_process_reports_a_known_length() {
    let t = InProcessTransport::from_router(router());
    let res = t.fetch(Request::get("/echo")).await.unwrap();
    let len = res.headers["content-length"].to_str().unwrap();
    assert_eq!(len, res.body.len().to_string());
    // A streamed body has none.
    let res = t.fetch(Request::get("/chunks")).await.unwrap();
    assert!(!res.headers.contains_key("content-length"));
}

#[tokio::test]
async fn a_server_that_is_down_is_failed_to_fetch() {
    let l = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let addr = l.local_addr().unwrap();
    drop(l);
    let t = RemoteTransport::new(&format!("http://{addr}")).unwrap();
    let err = t.fetch(Request::get("/echo")).await.unwrap_err();
    assert!(matches!(err, TransportError::Network(_)), "{err:?}");
    let fr = claudius_client::effect::FetchRequest {
        id: claudius_client::effect::FetchId(1),
        method: "GET",
        url: "/echo".into(),
        headers: vec![],
        body: None,
    };
    assert_eq!(
        t.fetch_outcome(&fr).await,
        claudius_client::effect::FetchOutcome::Failed("TypeError: Failed to fetch".into())
    );
}

#[tokio::test]
async fn in_process_a_body_that_panics_breaks_off() {
    let t = InProcessTransport::from_router(router());
    let mut res = t.send(Request::get("/body-panics")).await.unwrap();
    assert_eq!(res.status, 200);
    use futures::StreamExt;
    assert_eq!(res.body.next().await.unwrap().unwrap(), "partial");
    assert!(matches!(
        res.body.next().await,
        Some(Err(TransportError::Body(_)))
    ));
    assert!(res.body.next().await.is_none());
}
