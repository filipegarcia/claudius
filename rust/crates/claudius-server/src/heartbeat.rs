//! `GET/HEAD /api/heartbeat` and `GET /api/heartbeatz`: ports of
//! `app/api/heartbeat/route.ts` (liveness: no I/O) and
//! `app/api/heartbeatz/route.ts` (readiness: the database of the server's
//! own cwd opens, migrates and answers `SELECT 1`).
//!
//! Both answer what Next sends around the route modules, as a live
//! `next dev` / `next start` sent it: the `vary` header Next puts on every
//! app route response, no `Cache-Control`; HEAD on `heartbeat` is the
//! module's own empty 200 (no content type), HEAD on `heartbeatz` is its GET
//! without the body (the check runs); OPTIONS is Next's 204 with `Allow`;
//! another known method is an empty 405 and an unknown one an empty 400.
//!
//! The readiness check runs on [`claudius_core::db::open_db`]'s cached
//! handle, so once it has succeeded it stays `ok` whatever happens on disk,
//! as in TS. A failure is `503` with the message `openDb` rejected with
//! (Node's `mkdir` wording, or SQLite's as better-sqlite3 reports it).

use std::sync::OnceLock;

use axum::Router;
use axum::http::{HeaderValue, Method, StatusCode, header};
use axum::response::{IntoResponse, Response};
use axum::routing::any;
use claudius_agent::js;
use claudius_core::db::{self, Mode};
use claudius_core::{node_fs, now_ms};
use serde_json::json;

use crate::AppState;
use crate::body::thrown;

pub fn router() -> Router<AppState> {
    // Node reads `process.cwd()` at startup; so does this.
    let _ = process_cwd();
    // `any` first: axum then leaves out the `Allow` it puts on a fallback's
    // answer, which Next doesn't send.
    Router::new()
        .route(
            "/api/heartbeat",
            any(other_method)
                .get(heartbeat)
                .head(heartbeat_head)
                .options(options),
        )
        .route(
            "/api/heartbeatz",
            any(other_method).get(heartbeatz).options(options),
        )
}

/// What Next's `setVaryHeader` adds to every app route response.
pub const VARY: &str =
    "rsc, next-router-state-tree, next-router-prefetch, next-router-segment-prefetch";

fn respond(status: StatusCode, json: Option<String>) -> Response {
    let mut res = match json {
        Some(body) => (status, [(header::CONTENT_TYPE, "application/json")], body).into_response(),
        None => status.into_response(),
    };
    res.headers_mut()
        .insert(header::VARY, HeaderValue::from_static(VARY));
    res
}

async fn heartbeat() -> Response {
    respond(
        StatusCode::OK,
        Some(js::stringify(&json!({"status": "ok", "ts": now_ms()}))),
    )
}

/// The module's own `HEAD`: `new Response(null, { status: 200 })`.
async fn heartbeat_head() -> Response {
    respond(StatusCode::OK, None)
}

/// Next's automatic `OPTIONS`.
async fn options() -> Response {
    let mut res = respond(StatusCode::NO_CONTENT, None);
    res.headers_mut().insert(
        header::ALLOW,
        HeaderValue::from_static("GET, HEAD, OPTIONS"),
    );
    res
}

/// A method the module doesn't export: 405 for the ones Next knows
/// (`HTTP_METHODS`), 400 for any other.
pub(crate) async fn other_method(method: Method) -> Response {
    let known = [Method::POST, Method::PUT, Method::DELETE, Method::PATCH];
    let status = if known.contains(&method) {
        StatusCode::METHOD_NOT_ALLOWED
    } else {
        StatusCode::BAD_REQUEST
    };
    respond(status, None)
}

/// `process.cwd()`. Node keeps the first answer (it reads it at startup), and
/// throws until there is one (`ENOENT: no such file or directory, uv_cwd`
/// when the directory was removed).
fn process_cwd() -> Result<String, String> {
    static CWD: OnceLock<String> = OnceLock::new();
    if let Some(cwd) = CWD.get() {
        return Ok(cwd.clone());
    }
    match std::env::current_dir() {
        Ok(p) => Ok(CWD.get_or_init(|| p.to_string_lossy().into_owned()).clone()),
        Err(e) => Err(node_fs::FsError::new(&e, "uv_cwd", None, None).message),
    }
}

/// `checkDb()`: `Err` is the failed check's `detail`.
fn check_db() -> Result<(), String> {
    let cwd = process_cwd()?;
    let db = db::open_db(&cwd, Mode::ReadWrite).map_err(|e| e.to_string())?;
    // `db.prepare("SELECT 1 AS ok").get()`: the first row, if any.
    let ok = db
        .with(|c| {
            let mut st = c.prepare("SELECT 1 AS ok")?;
            let mut rows = st.query([])?;
            rows.next()?.map(|r| r.get::<_, i64>(0)).transpose()
        })
        .map_err(|e| db::sqlite_message(&e))?;
    if ok != Some(1) {
        return Err("SELECT 1 returned no row".into());
    }
    Ok(())
}

async fn heartbeatz() -> Response {
    let Ok(check) = tokio::task::spawn_blocking(check_db).await else {
        return thrown();
    };
    // `{ status, ts: Date.now(), checks, failed }`, the clock read after the check.
    let body = match check {
        Ok(()) => json!({
            "status": "ok",
            "ts": now_ms(),
            "checks": [{"id": "db", "status": "ok"}],
            "failed": [],
        }),
        Err(detail) => json!({
            "status": "fail",
            "ts": now_ms(),
            "checks": [{"id": "db", "status": "fail", "detail": detail}],
            "failed": ["db"],
        }),
    };
    let http = if body["failed"].as_array().is_some_and(Vec::is_empty) {
        StatusCode::OK
    } else {
        StatusCode::SERVICE_UNAVAILABLE
    };
    respond(http, Some(js::stringify(&body)))
}
