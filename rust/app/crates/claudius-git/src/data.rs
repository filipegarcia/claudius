//! What the Git page reads and does, as the [`GitData`] trait: one method
//! per `fetch` the React page (and the components it mounts) makes, each
//! answering what the TS reads out of the response, or the error text the
//! TS shows (`j.error ?? \`HTTP ${res.status}\``, or the rejected fetch's
//! `err.message`).
//!
//! | Method | Request | Ok |
//! |---|---|---|
//! | [`GitData::status`] | `GET git/status` | the payload |
//! | [`GitData::diff`] | `GET git/diff?path=&mode=` | `{diff, binary}` |
//! | [`GitData::stage`] | `POST git/stage {paths, op}` | |
//! | [`GitData::commit`] | `POST git/commit {message, stagePaths}` | `{sha, subject}` |
//! | [`GitData::commit_message`] | `POST git/commit-message {paths}` | the message |
//! | [`GitData::commit_draft`] | `GET git/commit-draft` | `message ?? ""` |
//! | [`GitData::save_commit_draft`] | `POST git/commit-draft {message}` | (any status) |
//! | [`GitData::clear_commit_draft`] | `DELETE git/commit-draft` | (any status) |
//! | [`GitData::branches`] | `GET git/branches` | `branches ?? []` |
//! | [`GitData::checkout`] | `POST git/checkout {name, create?, startPoint?}` | |
//! | [`GitData::rename_branch`] | `POST git/branch-rename {oldName, newName}` | `output` |
//! | [`GitData::delete_branch`] | `POST git/branch-delete {name, force}` / `{name, remote: true}` | `output` |
//! | [`GitData::compare_branches`] | `GET git/branch-compare?mode=log&base=&head=` | `output` |
//! | [`GitData::diff_with_worktree`] | `GET git/branch-compare?mode=diff&head=` | `output` |
//! | [`GitData::merge`] | `POST git/merge {name}` | `output` |
//! | [`GitData::rebase`] | `POST git/rebase {onto, checkoutBranch?}` | `output` |
//! | [`GitData::pull_merge`] | `POST git/pull-merge` | `output` |
//! | [`GitData::remote`] | `POST git/remote {op}` | `output` |
//! | [`GitData::pr_status`] | `GET git/pr-status` | `badge` (or none) |
//!
//! All under `/api/workspaces/<id>/`. [`TransportGitData`] sends them
//! through a [`Transport`] (the in-process router, or a remote server);
//! [`crate::fixture::FixtureGitData`] answers from memory.

use std::sync::Arc;

use claudius_transport::{Request, Response, Transport};
use futures::future::{BoxFuture, FutureExt as _};
use serde::de::DeserializeOwned;
use serde_json::{Map, Value, json};

use crate::changes::DiffMode;
use crate::types::{BranchInfo, CommitOk, DiffPayload, GitStatusPayload, PrBadge, js_number};

/// An answer: the value, or the error text the page shows.
pub type GitFuture<T> = BoxFuture<'static, Result<T, String>>;

/// `op` of `POST git/stage`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum StageOp {
    Stage,
    Unstage,
    Discard,
    Remove,
}

impl StageOp {
    pub fn as_str(self) -> &'static str {
        match self {
            StageOp::Stage => "stage",
            StageOp::Unstage => "unstage",
            StageOp::Discard => "discard",
            StageOp::Remove => "remove",
        }
    }
}

/// `op` of `POST git/remote`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum RemoteOp {
    Fetch,
    Pull,
    Push,
}

impl RemoteOp {
    pub fn as_str(self) -> &'static str {
        match self {
            RemoteOp::Fetch => "fetch",
            RemoteOp::Pull => "pull",
            RemoteOp::Push => "push",
        }
    }
}

/// `POST git/branch-delete`: a local branch (`-d`, or `-D` when forced) or
/// a remote one (`git push <remote> --delete`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum DeleteTarget {
    Local { force: bool },
    Remote,
}

/// A merge / rebase / pull-merge that didn't answer `ok`: `conflicts` when
/// the body's `kind` is `"conflicts"` (its `conflicts` when an array, else
/// empty), `message` is `body.message ?? body.error ?? HTTP <status>` (or
/// the rejected fetch's message), `output` the body's `output`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct MergeFailure {
    pub conflicts: Option<Vec<String>>,
    pub message: String,
    pub output: Option<String>,
}

impl MergeFailure {
    pub fn error(message: impl Into<String>) -> Self {
        MergeFailure {
            conflicts: None,
            message: message.into(),
            output: None,
        }
    }
}

pub type MergeFuture = BoxFuture<'static, Result<Option<String>, MergeFailure>>;

/// The Git page's requests (see the module docs).
pub trait GitData: Send + Sync + 'static {
    fn status(&self, ws: &str) -> GitFuture<GitStatusPayload>;
    fn diff(&self, ws: &str, path: &str, mode: DiffMode) -> GitFuture<DiffPayload>;
    fn stage(&self, ws: &str, paths: &[String], op: StageOp) -> GitFuture<()>;
    fn commit(&self, ws: &str, message: &str, stage_paths: &[String]) -> GitFuture<CommitOk>;
    /// `Err("empty response")` for an ok answer without a message.
    fn commit_message(&self, ws: &str, paths: &[String]) -> GitFuture<String>;
    /// `Err` (ignored by the page) when the answer isn't ok.
    fn commit_draft(&self, ws: &str) -> GitFuture<String>;
    /// `Ok` once the request answered, whatever its status.
    fn save_commit_draft(&self, ws: &str, message: &str) -> GitFuture<()>;
    fn clear_commit_draft(&self, ws: &str) -> GitFuture<()>;
    fn branches(&self, ws: &str) -> GitFuture<Vec<BranchInfo>>;
    fn checkout(
        &self,
        ws: &str,
        name: &str,
        create: bool,
        start_point: Option<&str>,
    ) -> GitFuture<()>;
    fn rename_branch(&self, ws: &str, old_name: &str, new_name: &str) -> GitFuture<Option<String>>;
    fn delete_branch(
        &self,
        ws: &str,
        name: &str,
        target: DeleteTarget,
    ) -> GitFuture<Option<String>>;
    fn compare_branches(&self, ws: &str, base: &str, head: &str) -> GitFuture<Option<String>>;
    fn diff_with_worktree(&self, ws: &str, head: &str) -> GitFuture<Option<String>>;
    fn merge(&self, ws: &str, name: &str) -> MergeFuture;
    fn rebase(&self, ws: &str, onto: &str, checkout_branch: Option<&str>) -> MergeFuture;
    fn pull_merge(&self, ws: &str) -> MergeFuture;
    fn remote(&self, ws: &str, op: RemoteOp) -> GitFuture<Option<String>>;
    /// `null` for no badge, a non-ok answer or a failed fetch.
    fn pr_status(&self, ws: &str) -> BoxFuture<'static, Option<PrBadge>>;
}

// ---- the requests, as the TS builds them ----------------------------------

/// `encodeURIComponent`.
pub fn encode_uri_component(s: &str) -> String {
    let mut out = String::new();
    for b in s.bytes() {
        if b.is_ascii_alphanumeric() || b"-_.!~*'()".contains(&b) {
            out.push(char::from(b));
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}

/// `/api/workspaces/${wsId}/git/<route>` (the id goes in raw).
pub fn git_url(ws: &str, route: &str) -> String {
    format!("/api/workspaces/{ws}/git/{route}")
}

/// `JSON.stringify` of an object literal (an `undefined` field left out).
fn body(fields: Vec<(&str, Option<Value>)>) -> String {
    let mut m = Map::new();
    for (k, v) in fields {
        if let Some(v) = v {
            m.insert(k.into(), v);
        }
    }
    Value::Object(m).to_string()
}

fn post_json(url: String, text: String) -> Request {
    Request::post(url)
        .header("Content-Type", "application/json")
        .body(text)
}

/// Every request the trait's methods send, for the transport and the
/// tests that pin them.
pub mod request {
    use super::*;

    pub fn status(ws: &str) -> Request {
        Request::get(git_url(ws, "status"))
    }
    pub fn diff(ws: &str, path: &str, mode: DiffMode) -> Request {
        Request::get(format!(
            "{}?path={}&mode={}",
            git_url(ws, "diff"),
            encode_uri_component(path),
            mode.as_str()
        ))
    }
    pub fn stage(ws: &str, paths: &[String], op: StageOp) -> Request {
        post_json(
            git_url(ws, "stage"),
            body(vec![
                ("paths", Some(json!(paths))),
                ("op", Some(json!(op.as_str()))),
            ]),
        )
    }
    pub fn commit(ws: &str, message: &str, stage_paths: &[String]) -> Request {
        post_json(
            git_url(ws, "commit"),
            body(vec![
                ("message", Some(json!(message))),
                ("stagePaths", Some(json!(stage_paths))),
            ]),
        )
    }
    pub fn commit_message(ws: &str, paths: &[String]) -> Request {
        post_json(
            git_url(ws, "commit-message"),
            body(vec![("paths", Some(json!(paths)))]),
        )
    }
    pub fn commit_draft(ws: &str) -> Request {
        Request::get(git_url(ws, "commit-draft"))
    }
    pub fn save_commit_draft(ws: &str, message: &str) -> Request {
        post_json(
            git_url(ws, "commit-draft"),
            body(vec![("message", Some(json!(message)))]),
        )
    }
    pub fn clear_commit_draft(ws: &str) -> Request {
        Request::new("DELETE", git_url(ws, "commit-draft"))
    }
    pub fn branches(ws: &str) -> Request {
        Request::get(git_url(ws, "branches"))
    }
    pub fn checkout(ws: &str, name: &str, create: bool, start_point: Option<&str>) -> Request {
        let fields = if create {
            vec![
                ("name", Some(json!(name))),
                ("create", Some(json!(true))),
                ("startPoint", start_point.map(|s| json!(s))),
            ]
        } else {
            vec![("name", Some(json!(name)))]
        };
        post_json(git_url(ws, "checkout"), body(fields))
    }
    pub fn rename_branch(ws: &str, old_name: &str, new_name: &str) -> Request {
        post_json(
            git_url(ws, "branch-rename"),
            body(vec![
                ("oldName", Some(json!(old_name))),
                ("newName", Some(json!(new_name))),
            ]),
        )
    }
    pub fn delete_branch(ws: &str, name: &str, target: DeleteTarget) -> Request {
        let fields = match target {
            DeleteTarget::Local { force } => {
                vec![("name", Some(json!(name))), ("force", Some(json!(force)))]
            }
            DeleteTarget::Remote => {
                vec![("name", Some(json!(name))), ("remote", Some(json!(true)))]
            }
        };
        post_json(git_url(ws, "branch-delete"), body(fields))
    }
    pub fn compare_branches(ws: &str, base: &str, head: &str) -> Request {
        Request::get(format!(
            "{}?mode=log&base={}&head={}",
            git_url(ws, "branch-compare"),
            encode_uri_component(base),
            encode_uri_component(head)
        ))
    }
    pub fn diff_with_worktree(ws: &str, head: &str) -> Request {
        Request::get(format!(
            "{}?mode=diff&head={}",
            git_url(ws, "branch-compare"),
            encode_uri_component(head)
        ))
    }
    pub fn merge(ws: &str, name: &str) -> Request {
        post_json(
            git_url(ws, "merge"),
            body(vec![("name", Some(json!(name)))]),
        )
    }
    pub fn rebase(ws: &str, onto: &str, checkout_branch: Option<&str>) -> Request {
        post_json(
            git_url(ws, "rebase"),
            body(vec![
                ("onto", Some(json!(onto))),
                ("checkoutBranch", checkout_branch.map(|s| json!(s))),
            ]),
        )
    }
    pub fn pull_merge(ws: &str) -> Request {
        Request::post(git_url(ws, "pull-merge"))
    }
    pub fn remote(ws: &str, op: RemoteOp) -> Request {
        post_json(
            git_url(ws, "remote"),
            body(vec![("op", Some(json!(op.as_str())))]),
        )
    }
    pub fn pr_status(ws: &str) -> Request {
        Request::get(git_url(ws, "pr-status"))
    }
}

// ---- reading the answers, as the TS does ----------------------------------

/// `String(v)` for a JSON value.
pub fn js_string_of(v: &Value) -> String {
    match v {
        Value::String(s) => s.clone(),
        Value::Number(n) => js_number(n.as_f64().unwrap_or(f64::NAN)),
        Value::Bool(b) => b.to_string(),
        Value::Null => "null".into(),
        Value::Array(a) => a
            .iter()
            .map(|x| match x {
                Value::Null => String::new(),
                x => js_string_of(x),
            })
            .collect::<Vec<_>>()
            .join(","),
        Value::Object(_) => "[object Object]".into(),
    }
}

/// `await res.json()` (a leading BOM dropped).
fn parse_json(res: &Response) -> Result<Value, String> {
    let text = res.text();
    let text = text.strip_prefix('\u{feff}').unwrap_or(&text);
    serde_json::from_str(text).map_err(|e| format!("JSON.parse: {e}"))
}

/// `(await res.json().catch(() => ({})))`.
fn json_or_empty(res: &Response) -> Value {
    parse_json(res).unwrap_or_else(|_| json!({}))
}

/// `j.<key>` when it is neither `undefined` nor `null` (`??`).
fn field<'a>(j: &'a Value, key: &str) -> Option<&'a Value> {
    j.get(key).filter(|v| !v.is_null())
}

/// `j.error ?? \`HTTP ${res.status}\`` of a non-ok answer.
pub fn error_text(res: &Response) -> String {
    let j = json_or_empty(res);
    field(&j, "error")
        .map(js_string_of)
        .unwrap_or_else(|| format!("HTTP {}", res.status))
}

/// `j.output` of an ok answer read with `.catch(() => ({}))`.
pub fn output_of(res: &Response) -> Option<String> {
    field(&json_or_empty(res), "output").map(js_string_of)
}

fn typed<T: DeserializeOwned>(v: Value) -> Result<T, String> {
    serde_json::from_value(v).map_err(|e| format!("{e}"))
}

/// The merge-like routes' answer (page.tsx:1230).
pub fn merge_outcome(res: &Response) -> Result<Option<String>, MergeFailure> {
    if res.ok() {
        return Ok(output_of(res));
    }
    let b = json_or_empty(res);
    let conflicts = (b.get("kind").and_then(Value::as_str) == Some("conflicts")).then(|| {
        b.get("conflicts")
            .and_then(Value::as_array)
            .map(|a| a.iter().map(js_string_of).collect())
            .unwrap_or_default()
    });
    let message = field(&b, "message")
        .or_else(|| field(&b, "error"))
        .map(js_string_of)
        .unwrap_or_else(|| format!("HTTP {}", res.status));
    Err(MergeFailure {
        conflicts,
        message,
        output: field(&b, "output").map(js_string_of),
    })
}

// ---- over a transport -----------------------------------------------------

/// [`GitData`] through a [`Transport`]: the requests the TS sends, answered
/// by the engine's ported routes. The futures run on `rt` (the engine's
/// runtime: the routes spawn git there); the caller may poll them anywhere.
pub struct TransportGitData {
    transport: Arc<dyn Transport>,
    rt: tokio::runtime::Handle,
}

impl TransportGitData {
    pub fn new(transport: Arc<dyn Transport>, rt: tokio::runtime::Handle) -> Self {
        TransportGitData { transport, rt }
    }

    /// Sends `req` on the runtime: the response, or the rejection's text.
    fn send(&self, req: Request) -> BoxFuture<'static, Result<Response, String>> {
        let t = self.transport.clone();
        let task = self
            .rt
            .spawn(async move { t.fetch(req).await.map_err(|e| e.page_text().to_owned()) });
        async move { task.await.map_err(|e| e.to_string())? }.boxed()
    }

    /// `if (!res.ok) throw j.error ?? HTTP`; then `read`.
    fn ok<T: Send + 'static>(
        &self,
        req: Request,
        read: impl FnOnce(&Response) -> Result<T, String> + Send + 'static,
    ) -> GitFuture<T> {
        let res = self.send(req);
        async move {
            let res = res.await?;
            if !res.ok() {
                return Err(error_text(&res));
            }
            read(&res)
        }
        .boxed()
    }

    fn merge_like(&self, req: Request) -> MergeFuture {
        let res = self.send(req);
        async move {
            match res.await {
                Ok(res) => merge_outcome(&res),
                Err(e) => Err(MergeFailure::error(e)),
            }
        }
        .boxed()
    }
}

impl GitData for TransportGitData {
    fn status(&self, ws: &str) -> GitFuture<GitStatusPayload> {
        self.ok(request::status(ws), |r| typed(parse_json(r)?))
    }

    fn diff(&self, ws: &str, path: &str, mode: DiffMode) -> GitFuture<DiffPayload> {
        self.ok(request::diff(ws, path, mode), |r| typed(parse_json(r)?))
    }

    fn stage(&self, ws: &str, paths: &[String], op: StageOp) -> GitFuture<()> {
        self.ok(request::stage(ws, paths, op), |_| Ok(()))
    }

    fn commit(&self, ws: &str, message: &str, stage_paths: &[String]) -> GitFuture<CommitOk> {
        self.ok(request::commit(ws, message, stage_paths), |r| {
            let j = json_or_empty(r);
            Ok(CommitOk {
                sha: field(&j, "sha").map(js_string_of),
                subject: field(&j, "subject").map(js_string_of),
            })
        })
    }

    fn commit_message(&self, ws: &str, paths: &[String]) -> GitFuture<String> {
        let res = self.send(request::commit_message(ws, paths));
        async move {
            let res = res.await?;
            // Read before the status check, `.catch(() => ({}))`.
            let j = json_or_empty(&res);
            if !res.ok() {
                return Err(field(&j, "error")
                    .map(js_string_of)
                    .unwrap_or_else(|| format!("HTTP {}", res.status)));
            }
            // `if (!j.message)`: falsy.
            match j.get("message") {
                Some(v) if crate::types::truthy(v) => Ok(js_string_of(v)),
                _ => Err("empty response".into()),
            }
        }
        .boxed()
    }

    fn commit_draft(&self, ws: &str) -> GitFuture<String> {
        self.ok(request::commit_draft(ws), |r| {
            Ok(field(&json_or_empty(r), "message")
                .map(js_string_of)
                .unwrap_or_default())
        })
    }

    fn save_commit_draft(&self, ws: &str, message: &str) -> GitFuture<()> {
        let res = self.send(request::save_commit_draft(ws, message));
        async move { res.await.map(|_| ()) }.boxed()
    }

    fn clear_commit_draft(&self, ws: &str) -> GitFuture<()> {
        let res = self.send(request::clear_commit_draft(ws));
        async move { res.await.map(|_| ()) }.boxed()
    }

    fn branches(&self, ws: &str) -> GitFuture<Vec<BranchInfo>> {
        self.ok(request::branches(ws), |r| {
            let j = parse_json(r)?;
            match field(&j, "branches") {
                Some(b) => typed(b.clone()),
                None => Ok(Vec::new()),
            }
        })
    }

    fn checkout(
        &self,
        ws: &str,
        name: &str,
        create: bool,
        start_point: Option<&str>,
    ) -> GitFuture<()> {
        self.ok(request::checkout(ws, name, create, start_point), |_| Ok(()))
    }

    fn rename_branch(&self, ws: &str, old_name: &str, new_name: &str) -> GitFuture<Option<String>> {
        self.ok(request::rename_branch(ws, old_name, new_name), |r| {
            Ok(output_of(r))
        })
    }

    fn delete_branch(
        &self,
        ws: &str,
        name: &str,
        target: DeleteTarget,
    ) -> GitFuture<Option<String>> {
        self.ok(request::delete_branch(ws, name, target), |r| {
            Ok(output_of(r))
        })
    }

    fn compare_branches(&self, ws: &str, base: &str, head: &str) -> GitFuture<Option<String>> {
        self.ok(request::compare_branches(ws, base, head), |r| {
            Ok(output_of(r))
        })
    }

    fn diff_with_worktree(&self, ws: &str, head: &str) -> GitFuture<Option<String>> {
        self.ok(request::diff_with_worktree(ws, head), |r| Ok(output_of(r)))
    }

    fn merge(&self, ws: &str, name: &str) -> MergeFuture {
        self.merge_like(request::merge(ws, name))
    }

    fn rebase(&self, ws: &str, onto: &str, checkout_branch: Option<&str>) -> MergeFuture {
        self.merge_like(request::rebase(ws, onto, checkout_branch))
    }

    fn pull_merge(&self, ws: &str) -> MergeFuture {
        self.merge_like(request::pull_merge(ws))
    }

    fn remote(&self, ws: &str, op: RemoteOp) -> GitFuture<Option<String>> {
        self.ok(request::remote(ws, op), |r| Ok(output_of(r)))
    }

    fn pr_status(&self, ws: &str) -> BoxFuture<'static, Option<PrBadge>> {
        let res = self.send(request::pr_status(ws));
        async move {
            let res = res.await.ok().filter(Response::ok)?;
            let j = parse_json(&res).ok()?;
            serde_json::from_value(field(&j, "badge")?.clone()).ok()
        }
        .boxed()
    }
}
