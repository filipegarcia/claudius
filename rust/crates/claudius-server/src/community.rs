//! The community chat's routes (D24), over [`claudius_core::community`]:
//!
//! * `GET`/`PUT /api/community/prefs` (`app/api/community/prefs/route.ts`):
//!   the consent and nickname kept in the user settings file.
//! * `GET /api/community/admin/check` (`admin/check/route.ts`):
//!   `{configured}`, whether an admin token and a chat server are set.
//! * `GET`/`POST`/`DELETE /api/community/admin/[...path]`
//!   (`admin/[...path]/route.ts`): the moderation proxy to the chat server's
//!   `/admin/*`, with the `X-Admin-Token` added here. It forwards the method
//!   and, for a POST or DELETE, the body as text (with `Content-Type:
//!   application/json` when there is one), never the caller's headers or
//!   query string, through the process's outbound client (Node's `fetch`
//!   semantics, `claudius_core::fetch`). It answers the upstream's status,
//!   body text and `Content-Type` (`application/json` when there is none).
//!   No chat server is a 503, no token a 403; an upstream that can't be
//!   reached or breaks off, or a status `new Response` refuses (204, 205,
//!   304, or one outside 200–599), is Next's empty 500.
//!
//! Every other method on these paths, and a catch-all path Next would
//! redirect, refuse or rewrite ([`community::catch_all_segments`]), is
//! forwarded to Next unchanged.

use axum::Router;
use axum::body::Body;
use axum::extract::{Request, State};
use axum::http::{HeaderValue, Method, StatusCode, header};
use axum::response::{IntoResponse, Response};
use axum::routing::any;
use claudius_agent::js;
use claudius_core::community::{self, PrefsAnswer};
use claudius_core::fetch;
use claudius_core::log;
use serde_json::{Value, json};

use crate::AppState;
use crate::body::{JsonBody, thrown};

const ADMIN_PREFIX: &str = "/api/community/admin/";

/// The app's request-body cap (`DefaultBodyLimit` in [`crate::app`]).
const BODY_LIMIT: usize = 256 * 1024 * 1024;

pub fn router() -> Router<AppState> {
    // `any` first, so axum puts no `Allow` on what Next answers.
    Router::new()
        .route(
            "/api/community/prefs",
            any(to_next).get(prefs_get).put(prefs_put).head(to_next),
        )
        .route(
            "/api/community/admin/check",
            any(to_next).get(check).head(to_next),
        )
        .route(
            "/api/community/admin/{*path}",
            any(to_next)
                .get(admin)
                .post(admin)
                .delete(admin)
                .head(to_next),
        )
}

/// A method or path these routes leave to Next.
async fn to_next(state: State<AppState>, req: Request) -> Response {
    crate::proxy::handler(state, req).await
}

/// `NextResponse.json(body, { status })`.
fn json_text(status: u16, body: &Value) -> Response {
    (
        StatusCode::from_u16(status).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR),
        [(header::CONTENT_TYPE, "application/json")],
        js::stringify(body),
    )
        .into_response()
}

fn threw(route: &str, message: &str) -> Response {
    tracing::error!(target: log::API, "[api/community/{route}] {message}");
    thrown()
}

fn prefs_answer(answer: PrefsAnswer) -> Response {
    match answer {
        PrefsAnswer::Json(status, body) => json_text(status, &body),
        PrefsAnswer::Threw(message) => threw("prefs", &message),
    }
}

async fn prefs_get() -> Response {
    match tokio::task::spawn_blocking(community::get_prefs).await {
        Ok(answer) => prefs_answer(answer),
        Err(_) => thrown(),
    }
}

async fn prefs_put(body: axum::body::Bytes) -> Response {
    // `try { body = await req.json() } catch { 400 }`. A number past f64
    // (Infinity in JS) is only ever compared as "not a string, not null",
    // so any number stands in for it.
    let Ok(body) = JsonBody::parse_or_message_overflow(&body, &json!(0)) else {
        return json_text(400, &json!({"error": "invalid json"}));
    };
    match tokio::task::spawn_blocking(move || community::put_prefs(&body)).await {
        Ok(answer) => prefs_answer(answer),
        Err(_) => thrown(),
    }
}

async fn check() -> Response {
    let configured =
        community::admin_configured(&community::admin_token(), &community::chat_server_url());
    json_text(200, &json!({ "configured": configured }))
}

async fn admin(state: State<AppState>, req: Request) -> Response {
    let raw = req
        .uri()
        .path()
        .strip_prefix(ADMIN_PREFIX)
        .unwrap_or_default();
    let Some(segments) = community::catch_all_segments(raw) else {
        return to_next(state, req).await;
    };
    let method = req.method().clone();
    // Read before answering even where TS doesn't, so no early answer
    // leaves unread bytes for the kernel to reset the connection over.
    let Ok(bytes) = axum::body::to_bytes(req.into_body(), BODY_LIMIT).await else {
        return StatusCode::PAYLOAD_TOO_LARGE.into_response();
    };
    let configured = community::chat_server_url();
    let server = community::server_base(&configured);
    if server.is_empty() {
        return json_text(
            503,
            &json!({"error": "NEXT_PUBLIC_CLAUDIUS_CHAT_SERVER_URL is not set"}),
        );
    }
    let token = community::admin_token();
    if token.is_empty() {
        return json_text(
            403,
            &json!({"error": "CLAUDIUS_CHAT_ADMIN_TOKEN is not set on this install"}),
        );
    }
    // The first call works the version out (a `git tag` run).
    let Ok(client) = tokio::task::spawn_blocking(community::this_client).await else {
        return thrown();
    };
    let target = community::with_client_param(&community::admin_target(server, &segments), &client);
    // `req.text()` for anything but GET / HEAD; an empty text sends nothing.
    let text = (method != Method::GET && method != Method::HEAD)
        .then(|| JsonBody::text(&bytes).into_owned())
        .filter(|t| !t.is_empty());
    let mut headers = vec![("X-Admin-Token".to_owned(), token)];
    if text.is_some() {
        headers.push(("Content-Type".to_owned(), "application/json".to_owned()));
    }
    let outbound = fetch::Request {
        method: method.as_str().to_owned(),
        url: target,
        headers,
        body: text,
    };
    let (upstream, upstream_headers) = match state.https.fetch_with_headers(&outbound).await {
        Ok(r) => r,
        Err(e) => return threw("admin", &format!("TypeError: {e}")),
    };
    let text = match upstream.text() {
        Ok(t) => t,
        Err(e) => return threw("admin", &format!("TypeError: {e}")),
    };
    // `new NextResponse(text, { status })`: a body with a null-body status,
    // or a status outside 200–599, throws.
    let status = upstream.status;
    if !(200..=599).contains(&status) {
        return threw(
            "admin",
            "RangeError: init[\"status\"] must be in the range of 200 to 599, inclusive.",
        );
    }
    if matches!(status, 204 | 205 | 304) {
        return threw(
            "admin",
            &format!("TypeError: Response constructor: Invalid response status code {status}"),
        );
    }
    let content_type = upstream_headers
        .get("content-type")
        .and_then(|v| HeaderValue::from_bytes(&v).ok())
        .unwrap_or_else(|| HeaderValue::from_static("application/json"));
    let mut res = Response::new(Body::from(text));
    *res.status_mut() = StatusCode::from_u16(status).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR);
    res.headers_mut().insert(header::CONTENT_TYPE, content_type);
    res
}
