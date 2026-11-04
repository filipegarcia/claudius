//! `/api/limits`: port of `app/api/limits/route.ts` (GET, PUT, POST) over
//! [`claudius_core::limits_store`].
//!
//! Every verb first resolves `?cwd=` to a trusted cwd (400 `unknown cwd`),
//! then reads the body with `try { await req.json() } catch { 400 invalid
//! JSON }`, as `JSON.parse` reads it (`1e400` is Infinity, lone surrogates
//! survive; a `null` body makes `body.x` throw: Next's empty 500).
//! - `GET`: the state, `{limits, overrides, audit}`.
//! - `PUT {projectDailyUsd?, sessionUsd?, maxWebSearches?, maxSubagents?}`:
//!   the numbers `>= 0` among them, in that order, replace the stored caps.
//! - `POST {action: "audit", event}` appends `event` (any value; the newest
//!   200 kept); `{action: "override", sessionId, on}` sets (truthy `on`) or
//!   clears `session:${sessionId}:<local date>`; else 400 `unknown action`.
//!
//! The store lives under `paths::home_dir()`, which `CLAUDIUS_STATE_HOME`
//! moves (TS: `homedir()`). A call that throws is logged and answers Next's
//! empty 500.

use axum::Router;
use axum::body::Bytes;
use axum::extract::RawQuery;
use axum::http::{StatusCode, header};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use claudius_core::limits_store::{self as store, Thrown};
use claudius_core::{db_agents, log, paths, trusted_cwd};
use serde_json::{Map, Value, json};

use crate::AppState;
use crate::body::{JsonBody, thrown};
use crate::session_transcript::search_param;

pub fn router() -> Router<AppState> {
    Router::new().route(
        "/api/limits",
        get(get_limits).put(put_limits).post(post_limits),
    )
}

/// `NextResponse.json(body, {status})`, with the store's text.
fn json_text(status: StatusCode, text: String) -> Response {
    (status, [(header::CONTENT_TYPE, "application/json")], text).into_response()
}

fn error(status: StatusCode, msg: &str) -> Response {
    json_text(status, json!({ "error": msg }).to_string())
}

fn failed(t: &Thrown) -> Response {
    tracing::error!(target: log::API, "[api/limits] {t}");
    thrown()
}

fn answer(r: Result<Value, Thrown>) -> Response {
    match r {
        Ok(state) => json_text(StatusCode::OK, store::to_text(&state, false)),
        Err(t) => failed(&t),
    }
}

/// `homedir()`.
fn home() -> String {
    paths::home_dir().to_string_lossy().into_owned()
}

/// `resolveTrustedCwd(url.searchParams.get("cwd"))`.
fn trusted(q: Option<&str>) -> Option<String> {
    trusted_cwd::resolve_trusted_cwd(search_param(q, "cwd").as_deref())
}

/// `try { body = await req.json() } catch { return 400 }`.
fn parse(bytes: &[u8]) -> Option<Value> {
    db_agents::json_parse_js(&JsonBody::text(bytes)).ok()
}

/// Run a handler's blocking work (the trust check, the store) off the
/// async runtime.
async fn blocking(f: impl FnOnce() -> Response + Send + 'static) -> Response {
    tokio::task::spawn_blocking(f)
        .await
        .unwrap_or_else(|_| thrown())
}

/// `GET /api/limits`.
async fn get_limits(RawQuery(query): RawQuery) -> Response {
    blocking(move || {
        let Some(cwd) = trusted(query.as_deref()) else {
            return error(StatusCode::BAD_REQUEST, "unknown cwd");
        };
        answer(store::read_limits(&home(), &cwd))
    })
    .await
}

/// The caps PUT keeps, in the handler's order.
const CAPS: [&str; 4] = [
    "projectDailyUsd",
    "sessionUsd",
    "maxWebSearches",
    "maxSubagents",
];

/// `PUT /api/limits`.
async fn put_limits(RawQuery(query): RawQuery, body: Bytes) -> Response {
    blocking(move || {
        let Some(cwd) = trusted(query.as_deref()) else {
            return error(StatusCode::BAD_REQUEST, "unknown cwd");
        };
        let Some(b) = parse(&body) else {
            return error(StatusCode::BAD_REQUEST, "invalid JSON");
        };
        // `body.projectDailyUsd` throws on a `null` body.
        if b.is_null() {
            return failed(
                &"TypeError: Cannot read properties of null (reading 'projectDailyUsd')".into(),
            );
        }
        let mut next = Map::new();
        for cap in CAPS {
            if let Some(v) = store::non_negative(b.as_object().and_then(|o| o.get(cap))) {
                next.insert(cap.into(), v);
            }
        }
        answer(store::write_limits(&home(), &cwd, Value::Object(next)))
    })
    .await
}

/// `POST /api/limits`.
async fn post_limits(RawQuery(query): RawQuery, body: Bytes) -> Response {
    blocking(move || {
        let Some(cwd) = trusted(query.as_deref()) else {
            return error(StatusCode::BAD_REQUEST, "unknown cwd");
        };
        let Some(b) = parse(&body) else {
            return error(StatusCode::BAD_REQUEST, "invalid JSON");
        };
        // `body.action` throws on a `null` body.
        if b.is_null() {
            return failed(&"TypeError: Cannot read properties of null (reading 'action')".into());
        }
        let field = |k: &str| b.as_object().and_then(|o| o.get(k));
        match field("action").and_then(Value::as_str) {
            Some("audit") => answer(store::append_audit(&home(), &cwd, field("event").cloned())),
            Some("override") => {
                // `sessionOverrideKey(body.sessionId)` runs before the store.
                let id = match store::template_string(field("sessionId")) {
                    Ok(id) => id,
                    Err(t) => return failed(&t),
                };
                let key = store::session_override_key(&id);
                answer(store::set_override(
                    &home(),
                    &cwd,
                    &key,
                    store::truthy(field("on")),
                ))
            }
            _ => error(StatusCode::BAD_REQUEST, "unknown action"),
        }
    })
    .await
}
