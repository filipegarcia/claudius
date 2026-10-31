//! `GET /api/workspaces/:id/git/{status,diff,show}`: ports of
//! `app/api/workspaces/[id]/git/{status,diff,show}/route.ts` over
//! [`claudius_core::git`] (D06).
//!
//! The id names a workspace (`workspaces.json`, a missing one is 404
//! `workspace not found`). `status` also takes a customization id
//! (`cust_…`): the Git pane runs it on the customization's mirror,
//! `<customizations>/<id>/src`, or answers 404 `customization not found`.
//! A store that can't be read throws in TS (Next's empty 500).
//!
//! Query parameters are read like `searchParams.get` (the first one wins,
//! form-decoded). Every body is `JSON.stringify` text:
//! * `status`: the status, or `{isRepo: false, files: []}` outside a work
//!   tree; git missing or failing is 500 `{error, code}`.
//! * `diff?path&mode`: 400 without a path or with a mode other than
//!   `worktree` / `staged` / `untracked`; `{diff, binary}`, or 500
//!   `{error, code}` (outside a work tree too).
//! * `show?path&ref`: 400 without a path, without a ref (`ref=` is the
//!   index), or for a path starting with `..` or holding a NUL;
//!   `{content}`, or 500 `{error, code}`.

use axum::Router;
use axum::extract::{Path, RawQuery};
use axum::http::{StatusCode, header};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use claudius_agent::js;
use claudius_core::git::{self, DiffMode, GitError, GitErrorCode};
use claudius_core::workspaces::{self, Workspace};
use claudius_core::{log, trusted_cwd};
use serde_json::{Value, json};

use crate::AppState;
use crate::body::thrown;
use crate::session_transcript::search_param;

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/api/workspaces/{id}/git/status", get(status))
        .route("/api/workspaces/{id}/git/diff", get(diff))
        .route("/api/workspaces/{id}/git/show", get(show))
}

pub(crate) fn json_text(status: StatusCode, body: &Value) -> Response {
    (
        status,
        [(header::CONTENT_TYPE, "application/json")],
        js::stringify(body),
    )
        .into_response()
}

pub(crate) fn error(status: StatusCode, msg: &str) -> Response {
    json_text(status, &json!({"error": msg}))
}

/// `{ error: result.message, code: result.code }` with a 500.
fn git_error(e: &GitError) -> Response {
    json_text(
        StatusCode::INTERNAL_SERVER_ERROR,
        &json!({"error": e.message, "code": e.code.as_str()}),
    )
}

/// `getWorkspace(id)`: `Err` is the 404 or the store's throw.
pub(crate) fn workspace(id: &str, route: &str) -> Result<Workspace, Box<Response>> {
    match workspaces::get(id) {
        Ok(Some(ws)) => Ok(ws),
        Ok(None) => Err(Box::new(error(
            StatusCode::NOT_FOUND,
            "workspace not found",
        ))),
        Err(e) => {
            tracing::error!(target: log::API, "[api/workspaces/git/{route}] {e}");
            Err(Box::new(thrown()))
        }
    }
}

/// `getCustomization(id).catch(() => null) != null`: the index read as
/// `fs.readFile(…, "utf8")` + `JSON.parse` (a bad file is no index), then
/// `customizations.find((c) => c.id === id)`, which throws (so: not found)
/// on a `null` entry before the match.
fn customization_exists(id: &str) -> bool {
    let Ok(bytes) = std::fs::read(trusted_cwd::customizations_root().join("index.json")) else {
        return false;
    };
    let Ok(Value::Object(index)) = js::json_parse(&String::from_utf8_lossy(&bytes)) else {
        return false;
    };
    let (Some(Value::Array(list)), Some(Value::Array(_))) =
        (index.get("customizations"), index.get("publishes"))
    else {
        return false;
    };
    if index.get("version").and_then(Value::as_f64) != Some(1.0) {
        return false;
    }
    for c in list {
        match c {
            Value::Null => return false,
            Value::Object(o) if o.get("id").and_then(Value::as_str) == Some(id) => return true,
            _ => {}
        }
    }
    false
}

/// `path.join(root, id, "src")` for an absolute `root`: `.` and `..`
/// segments resolve and repeated slashes collapse, as `path.normalize` does.
fn join_normalized(root: &str, id: &str) -> String {
    let joined = format!("{root}/{id}/src");
    let mut segs: Vec<&str> = vec![];
    for s in joined.split('/') {
        match s {
            "" | "." => {}
            ".." => {
                segs.pop();
            }
            s => segs.push(s),
        }
    }
    format!("/{}", segs.join("/"))
}

async fn status(Path(id): Path<String>) -> Response {
    // The Git pane passes a customization's `cust_<id>`: its mirror dir.
    let root_path = if id.starts_with("cust_") {
        if !customization_exists(&id) {
            return error(StatusCode::NOT_FOUND, "customization not found");
        }
        join_normalized(
            &trusted_cwd::customizations_root().display().to_string(),
            &id,
        )
    } else {
        match workspace(&id, "status") {
            Ok(ws) => ws.root_path,
            Err(r) => return *r,
        }
    };
    match git::get_status(&root_path).await {
        Ok(st) => json_text(StatusCode::OK, &st.to_json()),
        Err(e) if e.code == GitErrorCode::NotARepo => {
            json_text(StatusCode::OK, &json!({"isRepo": false, "files": []}))
        }
        Err(e) => git_error(&e),
    }
}

async fn diff(Path(id): Path<String>, RawQuery(query): RawQuery) -> Response {
    let ws = match workspace(&id, "diff") {
        Ok(ws) => ws,
        Err(r) => return *r,
    };
    let q = query.as_deref();
    let path = search_param(q, "path").unwrap_or_default();
    let mode = search_param(q, "mode");
    if path.is_empty() {
        return error(StatusCode::BAD_REQUEST, "path required");
    }
    let Some(mode) = mode.as_deref().and_then(DiffMode::parse) else {
        let modes: Vec<&str> = DiffMode::ALL.iter().map(|m| m.as_str()).collect();
        return error(
            StatusCode::BAD_REQUEST,
            &format!("mode must be one of {}", modes.join(", ")),
        );
    };
    match git::get_diff(&ws.root_path, &path, mode).await {
        Ok(d) => json_text(StatusCode::OK, &d.to_json()),
        Err(e) => git_error(&e),
    }
}

async fn show(Path(id): Path<String>, RawQuery(query): RawQuery) -> Response {
    let ws = match workspace(&id, "show") {
        Ok(ws) => ws,
        Err(r) => return *r,
    };
    let q = query.as_deref();
    let path = search_param(q, "path").unwrap_or_default();
    let rev = search_param(q, "ref");
    if path.is_empty() {
        return error(StatusCode::BAD_REQUEST, "path required");
    }
    let Some(rev) = rev else {
        return error(StatusCode::BAD_REQUEST, "ref required");
    };
    // An obvious traversal is a 400 rather than git's 500.
    if path.starts_with("..") || path.contains('\0') {
        return error(StatusCode::BAD_REQUEST, "invalid path");
    }
    match git::git_show(&ws.root_path, &rev, &path).await {
        Ok(content) => json_text(StatusCode::OK, &json!({"content": content})),
        Err(e) => git_error(&e),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn src_dir_joins_like_path_join() {
        assert_eq!(join_normalized("/h/c", "cust_a"), "/h/c/cust_a/src");
        assert_eq!(join_normalized("/h/c", "cust_a/../b"), "/h/c/b/src");
        assert_eq!(
            join_normalized("/h/c", "cust_..//./x"),
            "/h/c/cust_../x/src"
        );
        assert_eq!(join_normalized("/h/c", "cust_a/../../../../.."), "/src");
        assert_eq!(join_normalized("/h//c/", "cust_"), "/h/c/cust_/src");
    }
}
