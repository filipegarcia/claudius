//! `/api/agents`, `/api/agents/:name` and `/api/agents/db`: ports of
//! `app/api/agents/route.ts`, `app/api/agents/[name]/route.ts` and
//! `app/api/agents/db/route.ts`, over [`claudius_core::agents`] (the
//! `.claude/agents/*.md` files) and [`claudius_core::db_agents`] (the
//! `db_agents` table fed to sessions as `Options.agents`).
//!
//! Saving or deleting a file agent reloads the plugins of every live session
//! in that cwd ([`reload_for_cwd`]) and answers how many there were. Bodies
//! go through [`db_agents::json_parse`], so a number past f64 range is
//! `Infinity` as in JS (a `name` of `1e400` saves `Infinity.md`).

use axum::Router;
use axum::body::Bytes;
use axum::extract::{Path, State};
use axum::http::{StatusCode, Uri, header};
use axum::response::{IntoResponse, Response};
use axum::routing::{delete, get};
use claudius_agent::js;
use claudius_core::agents::{self, AgentScope};
use claudius_core::session_manager::SessionManager;
use claudius_core::{db_agents, log, trusted_cwd};
use serde_json::{Value, json};

use crate::AppState;
use crate::body::{JsonBody, thrown};
use crate::session_transcript::search_param;

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/api/agents", get(list_or_read).put(write))
        .route(
            "/api/agents/db",
            get(db_list).put(db_upsert).delete(db_delete),
        )
        .route("/api/agents/{name}", delete(remove))
}

/// `NextResponse.json(v, {status})`: `JSON.stringify`'s bytes.
fn json_text(status: StatusCode, v: &Value) -> Response {
    (
        status,
        [(header::CONTENT_TYPE, "application/json")],
        js::stringify(v),
    )
        .into_response()
}

fn err(status: StatusCode, msg: &str) -> Response {
    json_text(status, &json!({ "error": msg }))
}

/// An error the TS handler doesn't catch: Next's empty 500.
fn failed(route: &str, why: &str) -> Response {
    tracing::error!(target: log::API, "[{route}] {why}");
    thrown()
}

/// `resolveTrustedCwd(input)`, where "blank" is JS's `trim()` (which drops
/// U+FEFF and keeps U+0085, unlike Rust's): `./` keeps a non-blank input
/// non-blank to [`trusted_cwd::resolve_trusted_cwd`] without moving it.
fn trusted(input: Option<&str>) -> Option<String> {
    match input {
        Some(s) if !js::trim(s).is_empty() => {
            if s.trim().is_empty() {
                trusted_cwd::resolve_trusted_cwd(Some(&format!("./{s}")))
            } else {
                trusted_cwd::resolve_trusted_cwd(Some(s))
            }
        }
        _ => trusted_cwd::resolve_trusted_cwd(None),
    }
}

/// `sessionManager.reloadForCwd(cwd)`: `reloadPlugins()` on every live
/// session in `cwd` at once (failures ignored), and how many there were.
pub async fn reload_for_cwd(mgr: &SessionManager, cwd: &str) -> usize {
    let targets = mgr.sessions_by_cwd(cwd);
    futures::future::join_all(targets.iter().map(|s| async move {
        if let Some(q) = s.query_handle() {
            let _ = q.reload_plugins(true).await;
        }
    }))
    .await;
    targets.len()
}

/// `body?.[key]` of a parsed body.
fn field<'a>(body: &'a Value, key: &str) -> Option<&'a Value> {
    body.as_object()?.get(key)
}

const ROUTE: &str = "api/agents";

/// `GET /api/agents?cwd&scope&name`: one file (`scope` and `name` both
/// given), else both scopes' listings.
async fn list_or_read(uri: Uri) -> Response {
    let q = uri.query();
    let Some(cwd) = trusted(search_param(q, "cwd").as_deref()) else {
        return err(StatusCode::BAD_REQUEST, "unknown cwd");
    };
    let scope = search_param(q, "scope").filter(|s| !s.is_empty());
    let name = search_param(q, "name").filter(|s| !s.is_empty());
    if let (Some(scope), Some(name)) = (scope, name) {
        let Some(scope) = AgentScope::parse(&scope) else {
            return err(StatusCode::BAD_REQUEST, "invalid scope");
        };
        return match agents::read_agent(scope, &cwd, &name) {
            Err(e) => failed(ROUTE, &e.0),
            Ok(None) => err(StatusCode::NOT_FOUND, "not found"),
            Ok(Some(file)) => match file.to_json() {
                Some(v) => json_text(StatusCode::OK, &v),
                None => failed(ROUTE, "Converting circular structure to JSON"),
            },
        };
    }
    let mut scopes = Vec::new();
    for scope in [AgentScope::User, AgentScope::Project] {
        let files = match agents::list_agents(scope, &cwd) {
            Ok(f) => f,
            Err(e) => return failed(ROUTE, &e.0),
        };
        let Some(files) = files
            .iter()
            .map(agents::AgentFile::to_json)
            .collect::<Option<Vec<_>>>()
        else {
            return failed(ROUTE, "Converting circular structure to JSON");
        };
        scopes.push(json!({ "scope": scope.as_str(), "files": files }));
    }
    json_text(StatusCode::OK, &json!({ "cwd": cwd, "scopes": scopes }))
}

/// `PUT /api/agents {scope, cwd?, name, raw}`: write the file, then reload
/// the cwd's live sessions.
async fn write(State(app): State<AppState>, bytes: Bytes) -> Response {
    // `await req.json()`, uncaught
    let body = match db_agents::json_parse(&JsonBody::text(&bytes)) {
        Ok(b) => b,
        Err(e) => return failed(ROUTE, &e),
    };
    let Some(scope) = field(&body, "scope")
        .and_then(db_agents::as_str)
        .and_then(AgentScope::parse)
    else {
        return err(StatusCode::BAD_REQUEST, "invalid scope");
    };
    let Some(name) = field(&body, "name").filter(|n| js::truthy(n)) else {
        return err(StatusCode::BAD_REQUEST, "name required");
    };
    let Some(raw) = field(&body, "raw").and_then(db_agents::as_str) else {
        return err(StatusCode::BAD_REQUEST, "raw content required");
    };
    let Some(cwd) = trusted(field(&body, "cwd").and_then(db_agents::as_str)) else {
        return err(StatusCode::BAD_REQUEST, "unknown cwd");
    };
    if let Err(msg) = agents::write_agent(scope, &cwd, name, raw) {
        return err(StatusCode::BAD_REQUEST, &msg);
    }
    let reloaded = reload_for_cwd(&app.mgr, &cwd).await;
    json_text(
        StatusCode::OK,
        &json!({ "ok": true, "reloadedSessions": reloaded }),
    )
}

/// `DELETE /api/agents/:name?scope&cwd`.
async fn remove(State(app): State<AppState>, Path(name): Path<String>, uri: Uri) -> Response {
    let q = uri.query();
    let scope = search_param(q, "scope");
    let Some(cwd) = trusted(search_param(q, "cwd").as_deref()) else {
        return err(StatusCode::BAD_REQUEST, "unknown cwd");
    };
    let Some(scope) = scope.as_deref().and_then(AgentScope::parse) else {
        return err(StatusCode::BAD_REQUEST, "invalid scope");
    };
    match agents::delete_agent(scope, &cwd, &name) {
        Err(e) => failed("api/agents/[name]", &e.0),
        Ok(false) => err(StatusCode::NOT_FOUND, "not found"),
        Ok(true) => {
            let reloaded = reload_for_cwd(&app.mgr, &cwd).await;
            json_text(
                StatusCode::OK,
                &json!({ "ok": true, "reloadedSessions": reloaded }),
            )
        }
    }
}

/// `GET /api/agents/db?cwd`.
async fn db_list(uri: Uri) -> Response {
    let Some(cwd) = trusted(search_param(uri.query(), "cwd").as_deref()) else {
        return err(StatusCode::BAD_REQUEST, "unknown cwd");
    };
    let agents = db_agents::list_db_agents(&cwd);
    json_text(StatusCode::OK, &json!({ "cwd": cwd, "agents": agents }))
}

/// `PUT /api/agents/db {cwd?, name, definition}`.
async fn db_upsert(bytes: Bytes) -> Response {
    let Ok(body) = db_agents::json_parse(&JsonBody::text(&bytes)) else {
        return err(StatusCode::BAD_REQUEST, "invalid JSON body");
    };
    let Some(name) = field(&body, "name").filter(|n| js::truthy(n)) else {
        return err(StatusCode::BAD_REQUEST, "name required");
    };
    let Some(cwd) = trusted(field(&body, "cwd").and_then(db_agents::as_str)) else {
        return err(StatusCode::BAD_REQUEST, "unknown cwd");
    };
    match db_agents::upsert_db_agent(&cwd, name, field(&body, "definition")) {
        Ok(row) => json_text(StatusCode::OK, &json!({ "ok": true, "agent": row })),
        Err(msg) => err(StatusCode::BAD_REQUEST, &msg),
    }
}

/// `DELETE /api/agents/db?cwd&name`.
async fn db_delete(uri: Uri) -> Response {
    let q = uri.query();
    let Some(cwd) = trusted(search_param(q, "cwd").as_deref()) else {
        return err(StatusCode::BAD_REQUEST, "unknown cwd");
    };
    let Some(name) = search_param(q, "name").filter(|n| !n.is_empty()) else {
        return err(StatusCode::BAD_REQUEST, "name required");
    };
    match db_agents::delete_db_agent(&cwd, &name) {
        Ok(deleted) => json_text(StatusCode::OK, &json!({ "ok": true, "deleted": deleted })),
        Err(msg) => err(StatusCode::BAD_REQUEST, &msg),
    }
}
