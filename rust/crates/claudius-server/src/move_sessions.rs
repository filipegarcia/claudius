//! `GET`/`POST /api/workspaces/:id/move-sessions`: port of
//! `app/api/workspaces/[id]/move-sessions/route.ts` (G09), over
//! [`claudius_core::workspace_relocate`] and the workspace store.
//!
//! * `GET` previews the "move sessions to the new root?" prompt:
//!   `{rootPath, count, busy, sharedWith}`: the sessions recorded under the
//!   root that history shows (any failure counts 0), how many live sessions
//!   there are not idle,
//!   and the names of the other workspaces with the same root (`===` on the
//!   stored values; a `null` store entry after the match throws).
//! * `POST {to}` re-roots the workspace and carries its sessions along. In
//!   order: 404 for an unknown id; 400 `invalid body` (malformed, or a
//!   `null` body), `missing target root` (`to` not a string), the
//!   `assertAbsoluteUserPath` message, `rootPath does not exist` (`stat`
//!   fails, through symlinks), `rootPath not a directory`; the unchanged
//!   workspace with nothing moved when `to` (resolved) is the root already;
//!   409 while a live session in the root isn't idle; otherwise every live
//!   session there is ended, the sessions move (a throw is 500 `Moving
//!   sessions failed: …`) and the root is updated:
//!   `{workspace, moved, failed, dataError?}`.
//!
//! Bodies are read as `JSON.parse` reads them ([`js_string::parse`], lone
//! surrogates kept) and answers written as `JSON.stringify` writes them.
//! What the TS lets throw (an unreadable store, a store write) is Next's
//! empty 500.

use axum::Router;
use axum::body::Bytes;
use axum::extract::{Path, State};
use axum::http::{StatusCode, header};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use claudius_core::session::TurnStatus;
use claudius_core::workspace_relocate as reloc;
use claudius_core::workspaces as store;
use claudius_core::{js_string, log};
use serde_json::{Map, Value, json};

use crate::AppState;
use crate::body::{JsonBody, thrown};
use crate::workspaces::assert_absolute_user_path;

pub fn router() -> Router<AppState> {
    Router::new().route(
        "/api/workspaces/{id}/move-sessions",
        get(preview).post(move_sessions),
    )
}

fn json_text(status: StatusCode, body: &Value) -> Response {
    (
        status,
        [(header::CONTENT_TYPE, "application/json")],
        js_string::stringify(body),
    )
        .into_response()
}

fn error(status: StatusCode, msg: &str) -> Response {
    json_text(status, &json!({ "error": msg }))
}

/// What the TS let throw: Next's empty 500.
fn failed(e: impl std::fmt::Display) -> Response {
    tracing::error!(target: log::API, "[api/workspaces/[id]/move-sessions] {e:#}");
    thrown()
}

/// JS `a === b` on store values (`None` is `undefined`): two parsed
/// objects or arrays are never the same one.
fn strict_eq(a: Option<&Value>, b: Option<&Value>) -> bool {
    match (a, b) {
        (None, None) | (Some(Value::Null), Some(Value::Null)) => true,
        (Some(Value::Bool(x)), Some(Value::Bool(y))) => x == y,
        (Some(Value::Number(x)), Some(Value::Number(y))) => x.as_f64() == y.as_f64(),
        (Some(Value::String(x)), Some(Value::String(y))) => x == y,
        _ => false,
    }
}

/// `w.key` on a store entry: `undefined` for a primitive or an array, a
/// `TypeError` for `null`.
fn member<'a>(w: &'a Value, key: &str) -> Result<Option<&'a Value>, String> {
    match w {
        Value::Null => Err(format!(
            "TypeError: Cannot read properties of null (reading '{key}')"
        )),
        Value::Object(m) => Ok(m.get(key)),
        _ => Ok(None),
    }
}

/// `getWorkspace(id)`, or the response that ends the request.
fn workspace(id: &str) -> Result<Value, Box<Response>> {
    match store::get_raw(id) {
        Ok(Some(ws)) => Ok(ws),
        Ok(None) => Err(Box::new(error(StatusCode::NOT_FOUND, "not found"))),
        Err(e) => Err(Box::new(failed(e))),
    }
}

/// The live sessions bound to the root (`sessionsByCwd`; a non-string root
/// matches none).
fn live_in(
    app: &AppState,
    root: Option<&Value>,
) -> Vec<std::sync::Arc<claudius_core::session::Session>> {
    match root {
        Some(Value::String(r)) => app.mgr.sessions_by_cwd(r),
        _ => vec![],
    }
}

async fn preview(State(app): State<AppState>, Path(id): Path<String>) -> Response {
    let ws = match workspace(&id) {
        Ok(ws) => ws,
        Err(res) => return *res,
    };
    let root = ws.get("rootPath");
    // `listWorkspaceSessionIds(ws.rootPath).catch(() => [])`: a non-string
    // root throws in `encodeProjectDir`.
    let count = match root {
        Some(Value::String(r)) => {
            let r = r.clone();
            // CC 2.1.309: count what history shows, so the prompt matches
            // `/api/sessions/all` (an untitled DB-only row only while its
            // session is live).
            let mgr = app.mgr.clone();
            let live = move |id: &str| mgr.get(id).is_some();
            tokio::task::spawn_blocking(move || reloc::list_workspace_session_ids(&r, Some(&live)))
                .await
                .ok()
                .and_then(Result::ok)
                .map_or(0, |ids| ids.len())
        }
        _ => 0,
    };
    let busy = live_in(&app, root)
        .iter()
        .filter(|s| s.status() != TurnStatus::Idle)
        .count();
    let all = match store::list_raw() {
        Ok(all) => all,
        Err(e) => return failed(e),
    };
    let ws_id = json!(id);
    let mut shared_with = Vec::new();
    for w in &all {
        let other_id = match member(w, "id") {
            Ok(v) => v,
            Err(e) => return failed(e),
        };
        if strict_eq(other_id, Some(&ws_id)) {
            continue;
        }
        if strict_eq(w.get("rootPath"), root) {
            // `undefined` in an array prints as `null`.
            shared_with.push(w.get("name").cloned().unwrap_or(Value::Null));
        }
    }
    let mut out = Map::new();
    if let Some(r) = root {
        out.insert("rootPath".into(), r.clone());
    }
    out.insert("count".into(), json!(count));
    out.insert("busy".into(), json!(busy));
    out.insert("sharedWith".into(), Value::Array(shared_with));
    json_text(StatusCode::OK, &Value::Object(out))
}

async fn move_sessions(
    State(app): State<AppState>,
    Path(id): Path<String>,
    body: Bytes,
) -> Response {
    let ws = match workspace(&id) {
        Ok(ws) => ws,
        Err(res) => return *res,
    };
    // `try { body = await req.json(); … } catch → 400 "invalid body"`: a
    // malformed body, and `body.to` on a `null` one.
    let to = match js_string::parse(&JsonBody::text(&body)) {
        Err(_) | Ok(Value::Null) => return error(StatusCode::BAD_REQUEST, "invalid body"),
        Ok(Value::Object(b)) => match b.get("to") {
            Some(Value::String(to)) => to.clone(),
            _ => return error(StatusCode::BAD_REQUEST, "missing target root"),
        },
        Ok(_) => return error(StatusCode::BAD_REQUEST, "missing target root"),
    };
    let to = match assert_absolute_user_path(&to) {
        Ok(to) => to,
        Err(msg) => return error(StatusCode::BAD_REQUEST, msg),
    };
    match std::fs::metadata(js_string::lossy(&to).as_ref()) {
        Ok(m) if m.is_dir() => {}
        Ok(_) => return error(StatusCode::BAD_REQUEST, "rootPath not a directory"),
        Err(_) => return error(StatusCode::BAD_REQUEST, "rootPath does not exist"),
    }
    let root = ws.get("rootPath");
    let to_value = Value::String(to.clone());
    if strict_eq(Some(&to_value), root) {
        return json_text(
            StatusCode::OK,
            &json!({"workspace": ws, "moved": 0, "failed": []}),
        );
    }

    // A live CLI appends to its transcript by path: a chat that's working
    // (or waiting on a prompt) blocks the move; idle ones are ended.
    let live = live_in(&app, root);
    let n = live
        .iter()
        .filter(|s| s.status() != TurnStatus::Idle)
        .count();
    if n > 0 {
        let (verb, them) = if n == 1 {
            ("chat is", "it")
        } else {
            ("chats are", "them")
        };
        return error(
            StatusCode::CONFLICT,
            &format!(
                "{n} {verb} still working in this workspace. Wait for {them} to finish (or stop {them}), then save again."
            ),
        );
    }
    for s in &live {
        app.mgr.remove(&s.id).await;
    }

    // `encodeProjectDir(fromRoot)` on a non-string root throws.
    let moved = match root {
        Some(Value::String(from)) => {
            let (from, to) = (from.clone(), to.clone());
            tokio::task::spawn_blocking(move || reloc::relocate_workspace_sessions(&from, &to))
                .await
                .map_err(|e| e.to_string())
                .and_then(|r| r.map_err(|e| e.message().to_owned()))
        }
        Some(Value::Null) => Err("Cannot read properties of null (reading 'replace')".into()),
        None => Err("Cannot read properties of undefined (reading 'replace')".into()),
        Some(_) => Err("absPath.replace is not a function".into()),
    };
    let result = match moved {
        Ok(r) => r,
        Err(msg) => {
            return error(
                StatusCode::INTERNAL_SERVER_ERROR,
                &format!("Moving sessions failed: {msg}"),
            );
        }
    };
    let updated = match store::update_raw(&id, &json!({ "rootPath": to })) {
        Ok(Some(w)) => w,
        Ok(None) => return error(StatusCode::NOT_FOUND, "not found"),
        Err(e) => return failed(e),
    };
    let mut out = Map::new();
    out.insert("workspace".into(), updated);
    out.extend(result.to_json());
    json_text(StatusCode::OK, &Value::Object(out))
}
