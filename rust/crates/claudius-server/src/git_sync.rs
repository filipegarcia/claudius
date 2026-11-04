//! The Git page's sync routes, ports of `app/api/workspaces/[id]/git/
//! {merge,rebase,pull-merge,remote,remote-host,pr-status}/route.ts` over
//! [`claudius_core::git`] and [`claudius_core::pr_status`] (D09):
//! * `POST merge {name}`, `POST rebase {onto, checkoutBranch?}` and `POST
//!   pull-merge` (no body read): `{ok: true, output}`, 409 `{ok: false,
//!   kind: "conflicts", conflicts, output}` when git failed with unmerged
//!   paths in the tree, else 400 `{ok: false, kind: "error", message}`
//!   (outside a work tree too).
//! * `POST remote {op}` (`fetch` / `pull` / `push`): `{ok: true, output}`,
//!   or 500 `{error, code}`.
//! * `GET remote-host`: `{host, url}`, `origin`'s URL (or `null`) and its
//!   host class.
//! * `GET pr-status`: `{badge}`, the current branch's PR / MR or `null`.
//!
//! The four POSTs look the id up as a workspace (a `cust_…` id too), the two
//! GETs take a customization's `cust_…` id to its mirror as `status` does:
//! 404 `workspace not found` / `customization not found`, or Next's empty
//! 500 when the store can't be read. A body is read after that lookup, like
//! D07's (`{}` when malformed; a `null` body throws).
//!
//! Every name a body carries passes [`git::is_valid_ref_name`] before git
//! sees it, so none starts with `-` (TS refuses the same, with the same
//! messages); the remote and branch `push -u` and `gh` / `glab` get come
//! from the repo, unchecked as in TS.

use axum::Router;
use axum::body::Bytes;
use axum::extract::Path;
use axum::http::{StatusCode, header};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use claudius_core::git::{self, MergeOutcome, RemoteOp};
use claudius_core::{customizations, js_string, pr_status};
use serde_json::{Value, json};

use crate::AppState;
use crate::body::js_member;
use crate::git::{error, json_text, workspace};
use crate::git_branches::{read_body, required};
use crate::tri;

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/api/workspaces/{id}/git/merge", post(merge))
        .route("/api/workspaces/{id}/git/rebase", post(rebase))
        .route("/api/workspaces/{id}/git/pull-merge", post(pull_merge))
        .route("/api/workspaces/{id}/git/remote", post(remote))
        .route("/api/workspaces/{id}/git/remote-host", get(remote_host))
        .route("/api/workspaces/{id}/git/pr-status", get(pr_status))
}

/// 200, 409 for conflicts, 400 for an error.
fn outcome(result: MergeOutcome) -> Response {
    let status = match result {
        MergeOutcome::Ok(_) => StatusCode::OK,
        MergeOutcome::Conflicts { .. } => StatusCode::CONFLICT,
        MergeOutcome::Error(_) => StatusCode::BAD_REQUEST,
    };
    json_text(status, &result.to_json())
}

/// `rootPath` for the GETs: a `cust_…` id's mirror (`getCustomization(id)
/// .catch(() => null)`, then `customizationSrcDir(id)`), else the
/// workspace's.
fn root_path(id: &str, route: &str) -> Result<String, Box<Response>> {
    if id.starts_with("cust_") {
        if !matches!(customizations::get_customization(id), Ok(Some(_))) {
            return Err(Box::new(error(
                StatusCode::NOT_FOUND,
                "customization not found",
            )));
        }
        return Ok(customizations::customization_src_dir(id));
    }
    workspace(id, route).map(|ws| ws.root_path)
}

async fn merge(Path(id): Path<String>, body: Bytes) -> Response {
    let ws = match workspace(&id, "merge") {
        Ok(ws) => ws,
        Err(r) => return *r,
    };
    let b = read_body(&body);
    let Some(name) = required(tri!(js_member(&b, "name"))) else {
        return error(StatusCode::BAD_REQUEST, "name (string) required");
    };
    outcome(git::merge_branch_into_current(&ws.root_path, name).await)
}

async fn rebase(Path(id): Path<String>, body: Bytes) -> Response {
    let ws = match workspace(&id, "rebase") {
        Ok(ws) => ws,
        Err(r) => return *r,
    };
    let b = read_body(&body);
    let Some(onto) = required(tri!(js_member(&b, "onto"))) else {
        return error(StatusCode::BAD_REQUEST, "onto (string) required");
    };
    // `body.checkoutBranch != null`, then a non-blank string.
    let result = match b.get("checkoutBranch") {
        None | Some(Value::Null) => git::rebase_current_onto(&ws.root_path, onto).await,
        branch => match required(branch) {
            Some(branch) => git::checkout_and_rebase_onto(&ws.root_path, branch, onto).await,
            None => {
                return error(
                    StatusCode::BAD_REQUEST,
                    "checkoutBranch must be a non-empty string",
                );
            }
        },
    };
    outcome(result)
}

async fn pull_merge(Path(id): Path<String>) -> Response {
    let ws = match workspace(&id, "pull-merge") {
        Ok(ws) => ws,
        Err(r) => return *r,
    };
    outcome(git::pull_with_merge(&ws.root_path).await)
}

async fn remote(Path(id): Path<String>, body: Bytes) -> Response {
    let ws = match workspace(&id, "remote") {
        Ok(ws) => ws,
        Err(r) => return *r,
    };
    let b = read_body(&body);
    let op = match tri!(js_member(&b, "op")) {
        Some(Value::String(s)) => RemoteOp::parse(s),
        _ => None,
    };
    let Some(op) = op else {
        let ops: Vec<&str> = RemoteOp::ALL.iter().map(|op| op.as_str()).collect();
        return error(
            StatusCode::BAD_REQUEST,
            &format!("op must be one of {}", ops.join(", ")),
        );
    };
    match git::git_remote(&ws.root_path, op).await {
        Ok(output) => json_text(StatusCode::OK, &json!({"ok": true, "output": output})),
        Err(e) => json_text(
            StatusCode::INTERNAL_SERVER_ERROR,
            &json!({"error": e.message, "code": e.code.as_str()}),
        ),
    }
}

async fn remote_host(Path(id): Path<String>) -> Response {
    let root = match root_path(&id, "remote-host") {
        Ok(root) => root,
        Err(r) => return *r,
    };
    let url = git::get_origin_remote_url(&root).await;
    let host = pr_status::detect_git_remote_host(url.as_deref());
    json_text(StatusCode::OK, &json!({"host": host.as_str(), "url": url}))
}

async fn pr_status(Path(id): Path<String>) -> Response {
    let root = match root_path(&id, "pr-status") {
        Ok(root) => root,
        Err(r) => return *r,
    };
    let badge = pr_status::get_pr_status(&root).await;
    // The CLI's strings may hold lone surrogates (`js_string`).
    (
        StatusCode::OK,
        [(header::CONTENT_TYPE, "application/json")],
        js_string::stringify(&json!({ "badge": badge })),
    )
        .into_response()
}
