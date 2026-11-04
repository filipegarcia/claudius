//! The workspace host routes: port of `app/api/workspaces/[id]/roots`
//! (GET), `[id]/reveal` (POST: show a path in Finder / Explorer / the file
//! manager) and `[id]/shell` (POST: run one `/bin/bash -c` command in the
//! workspace root for the Git page's console), over
//! [`claudius_core::workspace_roots`], [`claudius_core::reveal`] and
//! [`claudius_core::shell`].
//!
//! Bodies are read like `await req.json().catch(() => ({}))` into JS values
//! ([`js_string::parse`], lone surrogates kept): a malformed or empty body is
//! `{}`, and a `null` one throws at its first property read. Every answer is
//! `JSON.stringify` of the TS value; what TS lets throw (the store's errors,
//! `path.resolve` of a non-string `rootPath`, a cwd or command `spawn()`
//! refuses) is Next's empty 500.

use axum::Router;
use axum::body::Bytes;
use axum::extract::Path;
use axum::http::{StatusCode, header};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use claudius_core::js_string::{self, lossy};
use claudius_core::shell::{self, ShellOpts};
use claudius_core::workspace_roots::{list_workspace_roots, resolve_workspace_root};
use claudius_core::{log, node_path, reveal, workspaces};
use serde_json::{Value, json};

use crate::AppState;
use crate::body::{JsonBody, thrown};

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/api/workspaces/{id}/roots", get(roots))
        .route("/api/workspaces/{id}/reveal", post(reveal))
        .route("/api/workspaces/{id}/shell", post(shell))
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
    json_text(status, &json!({"error": msg}))
}

/// What the TS let throw: Next's empty 500.
fn failed(route: &str, e: impl std::fmt::Display) -> Response {
    tracing::error!(target: log::API, "[api/workspaces/[id]/{route}] {e:#}");
    thrown()
}

/// `await req.json().catch(() => ({}))`.
fn body_or_empty(bytes: &[u8]) -> Value {
    js_string::parse(&JsonBody::text(bytes)).unwrap_or_else(|_| json!({}))
}

// ---- GET /api/workspaces/:id/roots ---------------------------------------------

async fn roots(Path(id): Path<String>) -> Response {
    let ws = match workspaces::get_raw(&id) {
        Ok(Some(ws)) => ws,
        Ok(None) => return error(StatusCode::NOT_FOUND, "workspace not found"),
        Err(e) => return failed("roots", e),
    };
    match list_workspace_roots(&ws) {
        Ok(roots) => {
            let roots: Vec<Value> = roots.iter().map(|r| r.to_json()).collect();
            json_text(StatusCode::OK, &json!({"roots": roots}))
        }
        Err(e) => failed("roots", e),
    }
}

// ---- POST /api/workspaces/:id/reveal --------------------------------------------

/// Body `{relPath?, root?}`: the root's path (`relPath` empty or missing) or
/// a path under it. A file is selected in its folder, a folder opened;
/// which one comes from `fs.stat` (through symlinks).
async fn reveal(Path(id): Path<String>, body: Bytes) -> Response {
    let body = body_or_empty(&body);
    if body.is_null() {
        return failed("reveal", "Cannot read properties of null (reading 'root')");
    }
    let root_sel = body.get("root").and_then(Value::as_str);
    let resolved = match resolve_workspace_root(&id, root_sel) {
        Ok(Some(r)) => r,
        Ok(None) => {
            let msg = if root_sel.is_some_and(|s| !s.is_empty()) {
                "unknown root"
            } else {
                "workspace not found"
            };
            return error(StatusCode::NOT_FOUND, msg);
        }
        Err(e) => return failed("reveal", e),
    };
    let raw_rel = body.get("relPath").and_then(Value::as_str).unwrap_or("");
    let root = resolved.root.abs_path;
    // `normalize(rawRel).replace(/^\/+/, "")`.
    let normalized = node_path::normalize(raw_rel);
    let rel = normalized.trim_start_matches('/');
    if rel == ".." || rel.starts_with("../") {
        return error(StatusCode::BAD_REQUEST, "path escapes workspace root");
    }
    let target = if rel.is_empty() || rel == "." {
        root.clone()
    } else {
        node_path::resolve(&[&root, rel])
    };
    // Bound under the root, as TS checks it: `relative(root, target)` may
    // not climb (any first segment starting with `..`, so `..foo` too) or
    // be absolute.
    let r = node_path::relative(&root, &target);
    if !r.is_empty() && (r.starts_with("..") || node_path::is_absolute(&r)) {
        return error(StatusCode::BAD_REQUEST, "path escapes workspace root");
    }
    let is_dir = match std::fs::metadata(lossy(&target).as_ref()) {
        Ok(m) => m.is_dir(),
        Err(_) => return error(StatusCode::NOT_FOUND, "path not found on disk"),
    };
    match reveal::reveal_on_host(&target, is_dir) {
        Ok(()) => json_text(StatusCode::OK, &json!({"ok": true})),
        Err(message) => error(StatusCode::INTERNAL_SERVER_ERROR, &message),
    }
}

// ---- POST /api/workspaces/:id/shell ---------------------------------------------

/// Body `{command}`: run it with `/bin/bash -c` in the workspace's
/// `rootPath` and answer `{stdout, stderr, truncated, exitCode, signal}`
/// (200 for any exit).
async fn shell(Path(id): Path<String>, body: Bytes) -> Response {
    let ws = match workspaces::get_raw(&id) {
        Ok(Some(ws)) => ws,
        Ok(None) => return error(StatusCode::NOT_FOUND, "workspace not found"),
        Err(e) => return failed("shell", e),
    };
    let body = body_or_empty(&body);
    if body.is_null() {
        return failed(
            "shell",
            "Cannot read properties of null (reading 'command')",
        );
    }
    let command = match body.get("command") {
        Some(Value::String(c)) if !claudius_agent::js::trim(c).is_empty() => c,
        _ => return error(StatusCode::BAD_REQUEST, "command required"),
    };
    // `ws.rootPath` goes to `spawn()` as is: `undefined` / `null` / `""`
    // run in the server's cwd, and any other non-string throws.
    match shell::exec_shell_command(ws.get("rootPath"), command, &ShellOpts::default()).await {
        Ok(result) => json_text(StatusCode::OK, &result.to_json()),
        Err(e) => failed("shell", e),
    }
}
