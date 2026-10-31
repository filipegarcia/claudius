//! The Git page's branch routes, ports of
//! `app/api/workspaces/[id]/git/{branches,branch-compare,branch-delete,
//! branch-rename,checkout}/route.ts` over [`claudius_core::git`] (D07):
//! * `GET branches`: `{branches}`, `[]` outside a work tree; a failing
//!   for-each-ref is 500 `{error, code}`.
//! * `GET branch-compare?mode&base&head`: 400 without a `head`; `mode=diff`
//!   is the head's diff against the working tree, any other mode the
//!   commit / diffstat report, which needs a `base` too.
//! * `POST branch-delete {name, remote?, force?}`, `POST branch-rename
//!   {oldName, newName}`, `POST checkout {name, create?, startPoint?}`.
//!
//! The four git-backed answers are `{ok: true, output}`, or 400 `{error,
//! code}` for any failure (outside a work tree too), git's own output being
//! the error. The id is looked up as a workspace (a `cust_…` id too) after
//! D06's [`crate::git::workspace`]: 404 `workspace not found`, or Next's
//! empty 500 when the store can't be read. A body is read after that lookup.
//!
//! Every name and ref a body or query carries goes through
//! [`git::is_valid_ref_name`] before git sees it, so none can start with `-`
//! (TS refuses those too, with the same messages).

use axum::Router;
use axum::body::Bytes;
use axum::extract::{Path, RawQuery};
use axum::http::StatusCode;
use axum::response::Response;
use axum::routing::{get, post};
use claudius_agent::js;
use claudius_core::git::{self, GitBranch, GitError, GitErrorCode};
use serde_json::{Value, json};

use crate::AppState;
use crate::body::{JsonBody, js_member};
use crate::git::{error, json_text, workspace};
use crate::session_transcript::search_param;
use crate::tri;

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/api/workspaces/{id}/git/branches", get(branches))
        .route(
            "/api/workspaces/{id}/git/branch-compare",
            get(branch_compare),
        )
        .route(
            "/api/workspaces/{id}/git/branch-delete",
            post(branch_delete),
        )
        .route(
            "/api/workspaces/{id}/git/branch-rename",
            post(branch_rename),
        )
        .route("/api/workspaces/{id}/git/checkout", post(checkout))
}

/// `{ error: result.message, code: result.code }`.
fn git_error(status: StatusCode, e: &GitError) -> Response {
    json_text(
        status,
        &json!({"error": e.message, "code": e.code.as_str()}),
    )
}

/// `{ ok: true, output }`, or the failure as a 400.
fn output(result: Result<String, GitError>) -> Response {
    match result {
        Ok(output) => json_text(StatusCode::OK, &json!({"ok": true, "output": output})),
        Err(e) => git_error(StatusCode::BAD_REQUEST, &e),
    }
}

/// `(await req.json().catch(() => ({}))) as Body`: any JSON value as
/// `Body.json()` reads it (two BOMs stripped, a lone surrogate escape as
/// U+FFFD), `{}` for an empty or malformed body. A number past f64
/// (`1e400`, Infinity in JS) reads as the stand-in `0`: like Infinity a
/// number, neither `null` nor a string nor `true`, all these handlers ask.
fn read_body(bytes: &[u8]) -> Value {
    let Ok(parsed) = JsonBody::parse_or_message(bytes) else {
        return json!({});
    };
    // V8 parsed this text, so it doesn't start with a third BOM.
    JsonBody::lenient_overflow(JsonBody::text(bytes).as_bytes(), parsed, &json!(0))
}

/// `typeof v !== "string" || !v.trim()` is `None`.
fn required(v: Option<&Value>) -> Option<&str> {
    match v {
        Some(Value::String(s)) if !js::trim(s).is_empty() => Some(s),
        _ => None,
    }
}

/// `=== true`.
fn is_true(b: &Value, key: &str) -> bool {
    b.get(key) == Some(&Value::Bool(true))
}

async fn branches(Path(id): Path<String>) -> Response {
    let ws = match workspace(&id, "branches") {
        Ok(ws) => ws,
        Err(r) => return *r,
    };
    match git::list_branches(&ws.root_path).await {
        Ok(list) => {
            let list: Vec<Value> = list.iter().map(GitBranch::to_json).collect();
            json_text(StatusCode::OK, &json!({ "branches": list }))
        }
        Err(e) if e.code == GitErrorCode::NotARepo => {
            json_text(StatusCode::OK, &json!({"branches": []}))
        }
        Err(e) => git_error(StatusCode::INTERNAL_SERVER_ERROR, &e),
    }
}

async fn branch_compare(Path(id): Path<String>, RawQuery(query): RawQuery) -> Response {
    let ws = match workspace(&id, "branch-compare") {
        Ok(ws) => ws,
        Err(r) => return *r,
    };
    let q = query.as_deref();
    // `searchParams.get("mode") ?? "log"`: only `diff` picks the diff.
    let mode = search_param(q, "mode");
    let head = search_param(q, "head").unwrap_or_default();
    if head.is_empty() {
        return error(StatusCode::BAD_REQUEST, "head (string) required");
    }
    if mode.as_deref() == Some("diff") {
        return output(git::diff_branch_against_worktree(&ws.root_path, &head).await);
    }
    let base = search_param(q, "base").unwrap_or_default();
    if base.is_empty() {
        return error(StatusCode::BAD_REQUEST, "base (string) required");
    }
    output(git::compare_branches(&ws.root_path, &base, &head).await)
}

async fn branch_delete(Path(id): Path<String>, body: Bytes) -> Response {
    let ws = match workspace(&id, "branch-delete") {
        Ok(ws) => ws,
        Err(r) => return *r,
    };
    let b = read_body(&body);
    // `body.name` (no `?.`): a `null` body throws here.
    let Some(name) = required(tri!(js_member(&b, "name"))) else {
        return error(StatusCode::BAD_REQUEST, "name (string) required");
    };
    output(if is_true(&b, "remote") {
        git::delete_remote_branch(&ws.root_path, name).await
    } else {
        git::delete_local_branch(&ws.root_path, name, is_true(&b, "force")).await
    })
}

async fn branch_rename(Path(id): Path<String>, body: Bytes) -> Response {
    let ws = match workspace(&id, "branch-rename") {
        Ok(ws) => ws,
        Err(r) => return *r,
    };
    let b = read_body(&body);
    let Some(old_name) = required(tri!(js_member(&b, "oldName"))) else {
        return error(StatusCode::BAD_REQUEST, "oldName (string) required");
    };
    let Some(new_name) = required(b.get("newName")) else {
        return error(StatusCode::BAD_REQUEST, "newName (string) required");
    };
    output(git::rename_branch(&ws.root_path, old_name, new_name).await)
}

async fn checkout(Path(id): Path<String>, body: Bytes) -> Response {
    let ws = match workspace(&id, "checkout") {
        Ok(ws) => ws,
        Err(r) => return *r,
    };
    let b = read_body(&body);
    let Some(name) = required(tri!(js_member(&b, "name"))) else {
        return error(StatusCode::BAD_REQUEST, "name (string) required");
    };
    // `body.startPoint != null`, then a string.
    let start_point = match b.get("startPoint") {
        None | Some(Value::Null) => None,
        Some(Value::String(s)) => Some(s.as_str()),
        Some(_) => return error(StatusCode::BAD_REQUEST, "startPoint must be a string"),
    };
    output(git::checkout_branch(&ws.root_path, name, is_true(&b, "create"), start_point).await)
}
