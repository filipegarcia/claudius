//! `/api/mcp/**`: ports of `app/api/mcp/route.ts` (GET, POST),
//! `app/api/mcp/[name]/route.ts` (DELETE) and its `toggle` / `reconnect`
//! (POST), over [`claudius_core::mcp_config`] and the live sessions.
//!
//! * `GET /api/mcp?cwd=&sessionId=`: the configured servers of a trusted
//!   cwd (400 `unknown cwd` otherwise) and, for a live session, the CLI's
//!   status list (`status`, left out when the CLI's reply has none) or why
//!   it failed (`statusError`). A file that doesn't load is Next's empty 500.
//! * `POST /api/mcp {scope, name, config, cwd?}`: add or replace a server.
//! * `DELETE /api/mcp/:name?scope=&cwd=`: 404 `not found` when the scope's
//!   file doesn't have it.
//! * `POST /api/mcp/:name/toggle {sessionId, enabled}` and
//!   `POST /api/mcp/:name/reconnect?sessionId=`: the `mcp_toggle` /
//!   `mcp_reconnect` control request on that one live session (404 for any
//!   other id, 500 with the CLI's error), which also queues the `mcp-delta`
//!   reminder for its next turn.
//!
//! The bodies are bare `await req.json()`s (an empty or malformed body is
//! the empty 500), read as `JSON.parse` reads them: a number literal past
//! f64 is Infinity, truthy, and `String(Infinity)` as a key, but `null`
//! where `JSON.stringify` writes it into a file.

use axum::Router;
use axum::body::Bytes;
use axum::extract::{Path, RawQuery, State};
use axum::http::{StatusCode, header};
use axum::response::{IntoResponse, Response};
use axum::routing::{delete, get, post};
use claudius_agent::js;
use claudius_core::mcp_config::{self, McpConfigError};
use claudius_core::settings::Scope;
use claudius_core::{log, trusted_cwd};
use serde_json::{Map, Value, json};

use crate::AppState;
use crate::body::{JsonBody, thrown};
use crate::session_transcript::search_param;

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/api/mcp", get(list).post(upsert))
        .route("/api/mcp/{name}", delete(remove))
        .route("/api/mcp/{name}/toggle", post(toggle))
        .route("/api/mcp/{name}/reconnect", post(reconnect))
}

/// `NextResponse.json(body, {status})`.
fn json_text(status: StatusCode, body: &Value) -> Response {
    (
        status,
        [(header::CONTENT_TYPE, "application/json")],
        js::stringify(body),
    )
        .into_response()
}

fn error(status: StatusCode, msg: &str) -> Response {
    json_text(status, &json!({"error": msg}))
}

fn ok() -> Response {
    json_text(StatusCode::OK, &json!({"ok": true}))
}

/// A config call that threw in TS: Next's empty 500.
fn failed(route: &str, e: &McpConfigError) -> Response {
    tracing::error!(target: log::API, "[api/{route}] {e}");
    thrown()
}

/// `await req.json()`, uncaught: `None` is the empty 500 (V8's
/// `SyntaxError` logged, as Next logs it). The second value reads each
/// overflowing number literal (`1e400`, Infinity in JS) as `infinite`
/// instead of `null`, for the checks that only see its truthiness or its
/// `String()`.
fn read_body(route: &str, bytes: &[u8], infinite: &Value) -> Option<(Value, Value)> {
    let parsed = match JsonBody::parse_or_message(bytes) {
        Ok(v) => v,
        Err(msg) => {
            tracing::error!(target: log::API, "[api/{route}] SyntaxError: {msg}");
            return None;
        }
    };
    let checked = JsonBody::lenient_overflow(bytes, parsed.clone(), infinite);
    Some((parsed, checked))
}

/// `GET /api/mcp`.
async fn list(State(app): State<AppState>, RawQuery(query): RawQuery) -> Response {
    let q = query.as_deref();
    let Some(cwd) = trusted_cwd::resolve_trusted_cwd(search_param(q, "cwd").as_deref()) else {
        return error(StatusCode::BAD_REQUEST, "unknown cwd");
    };
    let session_id = search_param(q, "sessionId");
    let configured = match mcp_config::list_configured(&cwd) {
        Ok(c) => c,
        Err(e) => return failed("mcp", &e),
    };
    // `status` starts as `null`; `None` is the SDK's `undefined`, which
    // `JSON.stringify` leaves out.
    let mut status = Some(Value::Null);
    let mut status_error = Value::Null;
    if let Some(s) = session_id
        .filter(|id| !id.is_empty())
        .and_then(|id| app.mgr.get(&id))
    {
        match s.mcp_server_status_reply().await {
            Ok(data) => status = data,
            Err(e) => status_error = Value::String(e),
        }
    }
    let mut body = Map::new();
    body.insert("cwd".into(), Value::String(cwd));
    body.insert(
        "configured".into(),
        Value::Array(configured.iter().map(|s| s.to_json()).collect()),
    );
    if let Some(status) = status {
        body.insert("status".into(), status);
    }
    body.insert("statusError".into(), status_error);
    json_text(StatusCode::OK, &Value::Object(body))
}

/// `POST /api/mcp`.
async fn upsert(body: Bytes) -> Response {
    let Some((b, checked)) = read_body("mcp", &body, &json!("Infinity")) else {
        return thrown();
    };
    // `!body?.scope || !SCOPES.includes(body.scope)`
    let Some(scope) = b["scope"].as_str().and_then(Scope::parse) else {
        return error(StatusCode::BAD_REQUEST, "invalid scope");
    };
    if !js::truthy(&checked["name"]) || !js::truthy(&checked["config"]) {
        return error(StatusCode::BAD_REQUEST, "name and config required");
    }
    // `resolveTrustedCwd(body.cwd)`: anything but a string is no input.
    let Some(cwd) = trusted_cwd::resolve_trusted_cwd(b["cwd"].as_str()) else {
        return error(StatusCode::BAD_REQUEST, "unknown cwd");
    };
    // `[name]: config`: the key is `String(name)`, which can throw.
    let upserted = mcp_config::property_key(&checked["name"])
        .and_then(|name| mcp_config::upsert_server(scope, &cwd, &name, &b["config"]));
    match upserted {
        Ok(()) => ok(),
        Err(e) => failed("mcp", &e),
    }
}

/// `DELETE /api/mcp/:name`.
async fn remove(Path(name): Path<String>, RawQuery(query): RawQuery) -> Response {
    let q = query.as_deref();
    let scope = search_param(q, "scope");
    let Some(cwd) = trusted_cwd::resolve_trusted_cwd(search_param(q, "cwd").as_deref()) else {
        return error(StatusCode::BAD_REQUEST, "unknown cwd");
    };
    let Some(scope) = scope.as_deref().and_then(Scope::parse) else {
        return error(StatusCode::BAD_REQUEST, "invalid scope");
    };
    match mcp_config::remove_server(scope, &cwd, &name) {
        Ok(true) => ok(),
        Ok(false) => error(StatusCode::NOT_FOUND, "not found"),
        Err(e) => failed("mcp/[name]", &e),
    }
}

/// `POST /api/mcp/:name/toggle`.
async fn toggle(State(app): State<AppState>, Path(name): Path<String>, body: Bytes) -> Response {
    // Infinity is truthy, and no session's id.
    let Some((_, b)) = read_body("mcp/[name]/toggle", &body, &json!(true)) else {
        return thrown();
    };
    if !js::truthy(&b["sessionId"]) {
        return error(StatusCode::BAD_REQUEST, "sessionId required");
    }
    // `sessionManager.get(body.sessionId)`: a Map lookup, so only a string
    // can match.
    let Some(s) = b["sessionId"].as_str().and_then(|id| app.mgr.get(id)) else {
        return error(StatusCode::NOT_FOUND, "session not found");
    };
    match s.toggle_mcp(&name, js::truthy(&b["enabled"])).await {
        Ok(()) => ok(),
        Err(e) => error(StatusCode::INTERNAL_SERVER_ERROR, &e),
    }
}

/// `POST /api/mcp/:name/reconnect`.
async fn reconnect(
    State(app): State<AppState>,
    Path(name): Path<String>,
    RawQuery(query): RawQuery,
) -> Response {
    let Some(id) = search_param(query.as_deref(), "sessionId").filter(|id| !id.is_empty()) else {
        return error(StatusCode::BAD_REQUEST, "sessionId required");
    };
    let Some(s) = app.mgr.get(&id) else {
        return error(StatusCode::NOT_FOUND, "session not found");
    };
    match s.reconnect_mcp(&name).await {
        Ok(()) => ok(),
        Err(e) => error(StatusCode::INTERNAL_SERVER_ERROR, &e),
    }
}
