//! The Git page's commit routes, ports of `app/api/workspaces/[id]/git/
//! {stage,commit,commit-draft,commit-message}/route.ts` over
//! [`claudius_core::git`], [`claudius_core::commit_drafts`] and
//! [`claudius_core::commit_message`] (D08):
//! * `POST stage {op, paths}`: `op` one of `stage` / `unstage` / `discard`
//!   / `remove`, `paths` a string array with no path starting with `..` or
//!   holding a NUL; `{ok: true}`, or 500 `{error, code}`.
//! * `POST commit {message, stagePaths?}`: a non-blank message; the given
//!   paths are staged first; `{ok: true, sha, subject}`, or 500 `{error,
//!   code}`.
//! * `GET / POST {message} / DELETE commit-draft`: the workspace's draft,
//!   `{message}` (`null` for none) or `{ok: true}`.
//! * `POST commit-message {paths}`: a non-empty string array; the diff of
//!   those paths through the one-shot query, `{message}`; 400 `no diff to
//!   summarise` when there is none, 500 `{error, code}` for git, 500
//!   `{error}` for the query.
//!
//! The id is looked up as a workspace (a `cust_…` id too, as in TS) with
//! D06's [`crate::git::workspace`]: 404 `workspace not found`, or Next's
//! empty 500 when the store can't be read. Bodies are read after that
//! lookup like D07's ([`read_body`]: `{}` when malformed; a `null` body
//! throws at the first `body.x`); the draft's keeps lone surrogates
//! ([`js_string::parse`]). A draft store that throws is Next's empty 500
//! too.
//!
//! Paths reach git only after `--`, so none is an option.

use axum::Router;
use axum::body::Bytes;
use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::response::Response;
use axum::routing::post;
use claudius_agent::js;
use claudius_core::git::{self, GitError, StageOp};
use claudius_core::{commit_drafts, commit_message, js_string, log};
use serde_json::{Value, json};

use crate::AppState;
use crate::body::{JsonBody, js_member, thrown};
use crate::git::{error, json_text, workspace};
use crate::git_branches::read_body;
use crate::tri;

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/api/workspaces/{id}/git/stage", post(stage))
        .route("/api/workspaces/{id}/git/commit", post(commit))
        .route(
            "/api/workspaces/{id}/git/commit-draft",
            post(set_draft).get(get_draft).delete(clear_draft),
        )
        .route(
            "/api/workspaces/{id}/git/commit-message",
            post(commit_message),
        )
}

/// `{ error: result.message, code: result.code }` with a 500.
fn git_error(e: &GitError) -> Response {
    json_text(
        StatusCode::INTERNAL_SERVER_ERROR,
        &json!({"error": e.message, "code": e.code.as_str()}),
    )
}

/// `Array.isArray(v) && v.every((p) => typeof p === "string")`.
fn string_array(v: Option<&Value>) -> Option<Vec<String>> {
    match v {
        Some(Value::Array(items)) => items
            .iter()
            .map(|p| p.as_str().map(str::to_owned))
            .collect(),
        _ => None,
    }
}

/// A draft store that threw: logged, then Next's empty 500.
fn store_threw(route: &str, e: &str) -> Response {
    tracing::error!(target: log::API, "[api/workspaces/git/{route}] {e}");
    thrown()
}

async fn stage(Path(id): Path<String>, body: Bytes) -> Response {
    let ws = match workspace(&id, "stage") {
        Ok(ws) => ws,
        Err(r) => return *r,
    };
    let b = read_body(&body);
    let op = match tri!(js_member(&b, "op")) {
        Some(Value::String(s)) => StageOp::parse(s),
        _ => None,
    };
    let Some(op) = op else {
        let ops: Vec<&str> = StageOp::ALL.iter().map(|op| op.as_str()).collect();
        return error(
            StatusCode::BAD_REQUEST,
            &format!("op must be one of {}", ops.join(", ")),
        );
    };
    let Some(paths) = string_array(b.get("paths")) else {
        return error(StatusCode::BAD_REQUEST, "paths must be string[]");
    };
    // An obvious traversal (or a NUL) is a 400 rather than git's 500.
    if paths
        .iter()
        .any(|p| p.starts_with("..") || p.contains('\0'))
    {
        return error(StatusCode::BAD_REQUEST, "invalid path");
    }
    match git::stage_paths(&ws.root_path, &paths, op).await {
        Ok(()) => json_text(StatusCode::OK, &json!({"ok": true})),
        Err(e) => git_error(&e),
    }
}

async fn commit(Path(id): Path<String>, body: Bytes) -> Response {
    let ws = match workspace(&id, "commit") {
        Ok(ws) => ws,
        Err(r) => return *r,
    };
    let b = read_body(&body);
    let message = match tri!(js_member(&b, "message")) {
        Some(Value::String(s)) if !js::trim(s).is_empty() => s.clone(),
        _ => return error(StatusCode::BAD_REQUEST, "message required"),
    };
    // `body.stagePaths !== undefined`: stage those first.
    if let Some(v) = b.get("stagePaths") {
        let Some(paths) = string_array(Some(v)) else {
            return error(StatusCode::BAD_REQUEST, "stagePaths must be string[]");
        };
        if !paths.is_empty()
            && let Err(e) = git::stage_paths(&ws.root_path, &paths, StageOp::Stage).await
        {
            return git_error(&e);
        }
    }
    match git::commit_staged(&ws.root_path, &message).await {
        Ok(c) => json_text(StatusCode::OK, &c.to_json()),
        Err(e) => git_error(&e),
    }
}

async fn get_draft(Path(id): Path<String>) -> Response {
    let ws = match workspace(&id, "commit-draft") {
        Ok(ws) => ws,
        Err(r) => return *r,
    };
    match commit_drafts::get_commit_draft(&ws.root_path) {
        Ok(message) => json_text(StatusCode::OK, &json!({ "message": message })),
        Err(e) => store_threw("commit-draft", &e),
    }
}

async fn set_draft(Path(id): Path<String>, body: Bytes) -> Response {
    let ws = match workspace(&id, "commit-draft") {
        Ok(ws) => ws,
        Err(r) => return *r,
    };
    // `JSON.parse` with lone surrogates kept: the draft stores them as
    // better-sqlite3 does. A literal past f64 reads as `null` (Infinity in
    // JS), not a string either way.
    let b = js_string::parse(&JsonBody::text(&body)).unwrap_or_else(|_| json!({}));
    let Some(Value::String(message)) = tri!(js_member(&b, "message")) else {
        return error(StatusCode::BAD_REQUEST, "message must be a string");
    };
    match commit_drafts::set_commit_draft(&ws.root_path, message) {
        Ok(()) => json_text(StatusCode::OK, &json!({"ok": true})),
        Err(e) => store_threw("commit-draft", &e),
    }
}

async fn clear_draft(Path(id): Path<String>) -> Response {
    let ws = match workspace(&id, "commit-draft") {
        Ok(ws) => ws,
        Err(r) => return *r,
    };
    match commit_drafts::clear_commit_draft(&ws.root_path) {
        Ok(()) => json_text(StatusCode::OK, &json!({"ok": true})),
        Err(e) => store_threw("commit-draft", &e),
    }
}

async fn commit_message(
    State(app): State<AppState>,
    Path(id): Path<String>,
    body: Bytes,
) -> Response {
    let ws = match workspace(&id, "commit-message") {
        Ok(ws) => ws,
        Err(r) => return *r,
    };
    let b = read_body(&body);
    let Some(paths) = string_array(tri!(js_member(&b, "paths"))) else {
        return error(StatusCode::BAD_REQUEST, "paths must be string[]");
    };
    if paths.is_empty() {
        return error(StatusCode::BAD_REQUEST, "no files selected");
    }
    let diff = match git::get_diff_for_commit(&ws.root_path, &paths).await {
        Ok(diff) => diff,
        Err(e) => return git_error(&e),
    };
    if js::trim(&diff).is_empty() {
        return error(StatusCode::BAD_REQUEST, "no diff to summarise");
    }
    let claude_bin = app.mgr.runtime.lock().unwrap().claude_bin.clone();
    match commit_message::generate_commit_message(&ws.root_path, &diff, claude_bin).await {
        Ok(message) => json_text(StatusCode::OK, &json!({ "message": message })),
        Err(e) => json_text(StatusCode::INTERNAL_SERVER_ERROR, &json!({ "error": e })),
    }
}
