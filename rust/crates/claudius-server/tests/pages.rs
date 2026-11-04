//! N02's page rules on the real router, in front of a stub Next upstream:
//! the fallback order (a rule answers, everything else is proxied), the 307
//! `Location`, and the cookie the workspace id writes back.
//!
//! One test function: `paths::set_home_override` is process-wide, so the
//! scenarios share a world and run in order (starting with no workspace).

use std::collections::HashMap;
use std::sync::Arc;

use axum::routing::any;
use bytes::Bytes;
use claudius_core::session_manager::SessionManager;
use claudius_core::{paths, workspaces};
use claudius_server::{AppState, app, proxy::Proxy};
use http_body_util::Full;
use hyper_util::client::legacy::Client;
use hyper_util::client::legacy::connect::HttpConnector;
use hyper_util::rt::TokioExecutor;

type HttpClient = Client<HttpConnector, Full<Bytes>>;

async fn serve(router: axum::Router) -> String {
    let l = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = l.local_addr().unwrap();
    tokio::spawn(async move { axum::serve(l, router).await.unwrap() });
    format!("http://{addr}")
}

/// `(status, location, set-cookie, body)`.
struct Answer {
    status: u16,
    location: String,
    set_cookie: String,
    body: String,
}

async fn get_with(c: &HttpClient, base: &str, path: &str, cookie: Option<&str>) -> Answer {
    let mut req = hyper::Request::builder()
        .method("GET")
        .uri(format!("{base}{path}"));
    if let Some(v) = cookie {
        req = req.header("cookie", format!("claudius.workspace={v}"));
    }
    let resp = c
        .request(req.body(Full::new(Bytes::new())).unwrap())
        .await
        .unwrap();
    let status = resp.status().as_u16();
    let head = |n: hyper::header::HeaderName| {
        resp.headers()
            .get(n)
            .and_then(|v| v.to_str().ok())
            .unwrap_or_default()
            .to_owned()
    };
    let (location, set_cookie) = (
        head(hyper::header::LOCATION),
        head(hyper::header::SET_COOKIE),
    );
    let body = String::from_utf8_lossy(
        &http_body_util::BodyExt::collect(resp.into_body())
            .await
            .unwrap()
            .to_bytes(),
    )
    .into_owned();
    Answer {
        status,
        location,
        set_cookie,
        body,
    }
}

#[tokio::test]
async fn the_page_rules_answer_and_everything_else_is_proxied() {
    let root = tempfile::tempdir().unwrap();
    let (home, config) = (root.path().join("home"), root.path().join("config"));
    let project = root.path().join("project");
    for d in [&home, &config, &project] {
        std::fs::create_dir_all(d).unwrap();
    }
    paths::set_home_override(home);
    paths::set_config_dir_override(config);

    // A stub Next: anything that reaches it says so, so a proxied request is
    // distinguishable from a rule's answer.
    let next =
        serve(axum::Router::new().fallback(any(|| async { ([("x-from", "next")], "from-next") })))
            .await;
    let mgr = Arc::new(SessionManager::default());
    let mut envmap: HashMap<String, String> = HashMap::new();
    envmap.insert("PATH".into(), std::env::var("PATH").unwrap_or_default());
    let state = AppState::new(mgr, Some(Arc::new(Proxy::new(&next).unwrap())), true);
    let base = serve(app(state)).await;
    let c: HttpClient = Client::builder(TokioExecutor::new()).build_http();

    // R1 with no workspace at all → the first-run splash, which is Next's.
    assert!(workspaces::list().unwrap().is_empty());
    let a = get_with(&c, &base, "/?session=abc", None).await;
    assert_eq!((a.status, a.location.as_str()), (307, "/welcome"));
    let a = get_with(&c, &base, "/welcome", None).await;
    assert_eq!((a.status, a.body.as_str()), (200, "from-next"));

    let ws = workspaces::create(workspaces::NewWorkspace {
        name: "Proj".into(),
        root_path: project.canonicalize().unwrap().display().to_string(),
        icon: None,
        defaults: None,
    })
    .unwrap();
    let id = ws.id;

    // R1 now resolves the workspace and keeps the query.
    let a = get_with(&c, &base, "/?session=abc", None).await;
    assert_eq!((a.status, a.location), (307, format!("/{id}?session=abc")));
    // R5: the splash bounces once a workspace exists.
    let a = get_with(&c, &base, "/welcome", None).await;
    assert_eq!((a.status, a.location.as_str()), (307, "/"));

    // R2: a bare scoped path goes under the cookie's id…
    let a = get_with(&c, &base, "/git?x=1", Some("wks_abcdef012345")).await;
    assert_eq!(
        (a.status, a.location.as_str()),
        (307, "/wks_abcdef012345/git?x=1")
    );
    // …and without a cookie, under the active workspace's.
    let a = get_with(&c, &base, "/sessions/deep", None).await;
    assert_eq!(
        (a.status, a.location),
        (307, format!("/{id}/sessions/deep"))
    );

    // R3: the id in the URL is written back to the cookie, and the page is
    // served by Next.
    let a = get_with(&c, &base, &format!("/{id}/git"), None).await;
    assert_eq!((a.status, a.body.as_str()), (200, "from-next"));
    assert!(
        a.set_cookie
            .starts_with(&format!("claudius.workspace={id}; Path=/; Expires=")),
        "{}",
        a.set_cookie
    );
    assert!(a.set_cookie.ends_with("; Max-Age=31536000; SameSite=lax"));
    // Already in sync: nothing written.
    let a = get_with(&c, &base, &format!("/{id}/git"), Some(&id)).await;
    assert_eq!((a.status, a.set_cookie.as_str()), (200, ""));

    // R4: an id the store doesn't have goes to `/`, still writing the cookie
    // (the proxy's job runs first, as in Next).
    let a = get_with(&c, &base, "/wks_abcdef012345/git", None).await;
    assert_eq!((a.status, a.location.as_str()), (307, "/"));
    assert!(a.set_cookie.contains("claudius.workspace=wks_abcdef012345"));

    // R6: an unknown customization's chat.
    let a = get_with(&c, &base, "/customize/nope/chat", None).await;
    assert_eq!((a.status, a.location.as_str()), (307, "/customize"));

    // Not ours: the API, Next's internals, assets, and an unscoped page.
    for path in [
        "/api/not-ported-yet",
        "/_next/static/chunk",
        "/favicon.ico",
        "/settings",
        "/customize",
        "/git/file",
    ] {
        let a = get_with(&c, &base, path, None).await;
        assert_eq!((path, a.status, a.body.as_str()), (path, 200, "from-next"));
    }

    // A non-GET keeps the proxy's rules but not the page ones.
    let req = hyper::Request::builder()
        .method("POST")
        .uri(format!("{base}/"))
        .body(Full::new(Bytes::from("{}")))
        .unwrap();
    let resp = c.request(req).await.unwrap();
    assert_eq!(resp.status().as_u16(), 200, "POST / reaches Next");
}
