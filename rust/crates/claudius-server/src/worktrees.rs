//! `GET /api/worktrees` and `POST /api/sessions/fork` (D05): ports of
//! `app/api/worktrees/route.ts` (a trusted cwd's git worktrees,
//! [`claudius_core::worktrees`]) and `app/api/sessions/fork/route.ts` (fork a
//! session's transcript, [`claudius_core::session_fork`], and for `/fork`
//! give the copy its own git worktree, [`claudius_core::fork_worktrees`]).
//!
//! * `GET ?cwd=`: `{cwd, worktrees}` for a trusted cwd (a blank or missing
//!   one is the server's), else 400 `unknown cwd`; `worktrees` is `[]`
//!   whenever git can't list them.
//! * `POST {sessionId, upToMessageId?, title?, dir?, worktree?, cwd?}`: a
//!   body that isn't JSON is Next's empty 500 (the TS `req.json()` is
//!   uncaught); a falsy `sessionId` is 400 `sessionId required`; whatever
//!   the fork throws is 500 `{error: message}`. Then, when `worktree` is
//!   truthy and `cwd` a string, a trusted `cwd` gets a worktree off its
//!   repo's `HEAD`: `{sessionId, worktree}`, `worktree` being `null` (with
//!   `worktreeError` when the repo couldn't take one) whenever that didn't
//!   happen. The fork itself never fails on the worktree.
//!
//! The body is read as `JSON.parse` reads it, lone surrogates kept as their
//! [`js_string`] stand-ins (and written back as escapes). A number literal
//! past the f64 range (`1e400`) is JS ±Infinity, which a `Value` can't hold:
//! it reads as `["Infinity"]` / `["-Infinity"]`, which every step here
//! treats as it treats the number (truthy, not a string, the same
//! `String()`).

use axum::Router;
use axum::body::Bytes;
use axum::extract::RawQuery;
use axum::http::{StatusCode, header};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use claudius_agent::js;
use claudius_core::fork_worktrees::{ForkWorktree, create_fork_worktree};
use claudius_core::session_fork::fork_js;
use claudius_core::{js_string, trusted_cwd, worktrees};
use serde_json::{Map, Value, json};

use crate::AppState;
use crate::body::{JsonBody, js_truthy, replace_overflowing_signed, thrown};
use crate::session_transcript::search_param;

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/api/worktrees", get(list))
        .route("/api/sessions/fork", post(fork))
}

fn json_text(status: StatusCode, text: String) -> Response {
    (status, [(header::CONTENT_TYPE, "application/json")], text).into_response()
}

async fn list(RawQuery(query): RawQuery) -> Response {
    let cwd = search_param(query.as_deref(), "cwd");
    let Some(cwd) = trusted_cwd::resolve_trusted_cwd(cwd.as_deref()) else {
        return json_text(
            StatusCode::BAD_REQUEST,
            js::stringify(&json!({"error": "unknown cwd"})),
        );
    };
    let listed = worktrees::list_worktrees(&cwd).await;
    let worktrees: Vec<Value> = listed.into_iter().map(Value::Object).collect();
    json_text(
        StatusCode::OK,
        js::stringify(&json!({"cwd": cwd, "worktrees": worktrees})),
    )
}

/// `(await req.json()) as Body` (see the module doc); `None` is a body V8
/// doesn't parse, which throws.
fn read_body(bytes: &[u8]) -> Option<Value> {
    let text = JsonBody::text(bytes);
    if js::json_parse_error(&text).is_some() {
        return None;
    }
    match replace_overflowing_signed(&text, r#"["Infinity"]"#, r#"["-Infinity"]"#) {
        Some(replaced) => js_string::parse(&replaced).ok(),
        None => js_string::parse(&text).ok(),
    }
}

async fn fork(body: Bytes) -> Response {
    let Some(b) = read_body(&body) else {
        return thrown();
    };
    // `body?.x`: `undefined` for a non-object body.
    let field = |k: &str| b.as_object().and_then(|o| o.get(k));
    let Some(session_id) = field("sessionId").filter(|v| js_truthy(Some(v))) else {
        return json_text(
            StatusCode::BAD_REQUEST,
            js::stringify(&json!({"error": "sessionId required"})),
        );
    };
    let id = match fork_js(
        session_id,
        field("upToMessageId"),
        field("title"),
        field("dir"),
    ) {
        Ok(id) => id,
        Err(message) => {
            return json_text(
                StatusCode::INTERNAL_SERVER_ERROR,
                js_string::stringify(&json!({"error": message})),
            );
        }
    };
    let mut worktree = Value::Null;
    let mut worktree_error = None;
    if js_truthy(field("worktree"))
        && let Some(Value::String(cwd)) = field("cwd")
        && let Some(source) = trusted_cwd::resolve_trusted_cwd(Some(cwd))
    {
        // `.catch(() => null)`: a throw is no worktree and no reason.
        match create_fork_worktree(&source, &id).await {
            Ok(ForkWorktree::Created(info)) => worktree = info.to_json(),
            Ok(ForkWorktree::Failed(reason)) => worktree_error = reason,
            Err(_) => {}
        }
    }
    let mut out = Map::new();
    out.insert("sessionId".into(), Value::String(id));
    out.insert("worktree".into(), worktree);
    if let Some(reason) = worktree_error.filter(|r| !r.is_empty()) {
        out.insert("worktreeError".into(), Value::String(reason));
    }
    // A reason cut through a surrogate pair ends in its lone half.
    json_text(StatusCode::OK, js_string::stringify(&Value::Object(out)))
}
