//! `/api/memory/auto` and `/api/memory/rules`: ports of
//! `app/api/memory/auto/route.ts` and `app/api/memory/rules/route.ts`
//! (GET, POST, PATCH, DELETE each), over [`claudius_core::auto_memory`] and
//! [`claudius_core::rules`].
//!
//! * `memory/auto?cwd=` (a trusted cwd, else 400 `unknown cwd`): `GET` lists
//!   the cwd's memory dir (`&file=<name>` reads one file, 404 when it's
//!   missing or not a valid name), `POST {filename, type, name, description,
//!   body}` (all strings) creates one with its index line (201), `PATCH
//!   &filename= {description?, type?, body?}` rewrites one and `DELETE
//!   &filename=` removes it. Each write that lands queues the
//!   `memory-update` reminder on every live session in that cwd. A call
//!   that throws is Next's empty 500.
//! * `memory/rules?scope=user|project` (default `project`; a project scope
//!   needs a trusted `cwd`): the same verbs over the scope's rule files,
//!   where `PATCH {body}` only edits an existing file. A refused cwd is a
//!   400 and any other thrown error a 500, both `{error: message}`.
//!
//! A malformed body is 400 `invalid JSON` (`try { await req.json() }`), read
//! as `JSON.parse` reads it (`1e400` isn't a string either way; a lone
//! surrogate escape becomes U+FFFD). The memory dir is under
//! `paths::home_dir()`, which `CLAUDIUS_STATE_HOME` moves (TS: `homedir()`).

use axum::Router;
use axum::body::Bytes;
use axum::extract::{RawQuery, State};
use axum::http::{StatusCode, header};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use claudius_agent::js;
use claudius_core::auto_memory::{
    self as am, MemoryOp, MemoryUpdate, PatchMemoryInput, Refusal, Thrown, WriteMemoryInput,
};
use claudius_core::rules::{self, RuleScope};
use claudius_core::{log, node_path, paths, trusted_cwd};
use serde_json::{Value, json};

use crate::AppState;
use crate::body::{JsonBody, thrown};
use crate::session_transcript::search_param;

pub fn router() -> Router<AppState> {
    Router::new()
        .route(
            "/api/memory/auto",
            get(auto_get)
                .post(auto_post)
                .patch(auto_patch)
                .delete(auto_delete),
        )
        .route(
            "/api/memory/rules",
            get(rules_get)
                .post(rules_post)
                .patch(rules_patch)
                .delete(rules_delete),
        )
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

fn error(status: u16, msg: &str) -> Response {
    json_text(
        StatusCode::from_u16(status).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR),
        &json!({ "error": msg }),
    )
}

fn refused(r: &Refusal) -> Response {
    error(r.status, &r.error)
}

/// `homedir()`.
fn home() -> String {
    paths::home_dir().to_string_lossy().into_owned()
}

/// `new Date()`.
fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| d.as_millis() as i64)
}

/// Run a handler's blocking fs work off the async runtime.
async fn blocking<T: Send + 'static>(
    f: impl FnOnce() -> T + Send + 'static,
    or: impl FnOnce() -> T,
) -> T {
    tokio::task::spawn_blocking(f)
        .await
        .unwrap_or_else(|_| or())
}

/// A 400 `{error}`, by message.
type BadRequest = &'static str;

/// The trusted `cwd` param, or the 400.
fn trusted(q: Option<&str>) -> Result<String, BadRequest> {
    trusted_cwd::resolve_trusted_cwd(search_param(q, "cwd").as_deref()).ok_or("unknown cwd")
}

/// A non-empty query param (`if (!x)`).
fn non_empty(q: Option<&str>, key: &str) -> Option<String> {
    search_param(q, key).filter(|v| !v.is_empty())
}

/// `try { body = await req.json() } catch { return 400 }`.
fn parse_body(bytes: &[u8]) -> Result<Value, BadRequest> {
    JsonBody::parse_or_message(bytes).map_err(|_| "invalid JSON")
}

/// `body?.key` when it's a string.
fn str_field<'a>(b: &'a Value, key: &str) -> Option<&'a str> {
    b.as_object()?.get(key)?.as_str()
}

// ───────────────────────────────── auto ─────────────────────────────────

const AUTO: &str = "memory/auto";

/// A call that threw in TS: logged as Next logs it, then the empty 500.
fn failed(t: &Thrown) -> Response {
    tracing::error!(target: log::API, "[api/{AUTO}] {t}");
    thrown()
}

/// `notifyMemoryUpdate(cwd, update)`: the reminder on every live session in
/// `cwd`.
fn notify(app: &AppState, landed: Option<(String, MemoryUpdate)>) {
    let Some((cwd, update)) = landed else {
        return;
    };
    for s in app.mgr.sessions_by_cwd(&cwd) {
        s.notify_memory_update(std::slice::from_ref(&update));
    }
}

/// A handler's response, and the write to fan out once it has landed.
type Landed = (Response, Option<(String, MemoryUpdate)>);

fn respond(r: Response) -> Landed {
    (r, None)
}

/// `GET /api/memory/auto`.
async fn auto_get(RawQuery(query): RawQuery) -> Response {
    blocking(
        move || {
            let q = query.as_deref();
            let cwd = match trusted(q) {
                Ok(c) => c,
                Err(m) => return error(400, m),
            };
            let home = home();
            if let Some(file) = non_empty(q, "file") {
                return match am::read_memory_file(&home, &cwd, &file) {
                    Ok(Some(content)) => {
                        json_text(StatusCode::OK, &json!({ "name": file, "content": content }))
                    }
                    Ok(None) => error(404, "not found"),
                    Err(e) => failed(&Thrown::Fs(e)),
                };
            }
            match am::list_auto_memory(&home, &cwd) {
                Ok(files) => json_text(
                    StatusCode::OK,
                    &json!({
                        "dir": am::auto_memory_dir(&home, &cwd),
                        "files": files.iter().map(am::MemoryFile::to_json).collect::<Vec<_>>(),
                    }),
                ),
                Err(e) => failed(&Thrown::Fs(e)),
            }
        },
        thrown,
    )
    .await
}

/// `POST /api/memory/auto`.
async fn auto_post(
    State(app): State<AppState>,
    RawQuery(query): RawQuery,
    body: Bytes,
) -> Response {
    let (r, landed) = blocking(
        move || -> Landed {
            let q = query.as_deref();
            let cwd = match trusted(q) {
                Ok(c) => c,
                Err(m) => return respond(error(400, m)),
            };
            let b = match parse_body(&body) {
                Ok(b) => b,
                Err(m) => return respond(error(400, m)),
            };
            let field = |k: &str| str_field(&b, k).map(str::to_owned);
            let (Some(filename), Some(type_), Some(name), Some(description), Some(text)) = (
                field("filename"),
                field("type"),
                field("name"),
                field("description"),
                field("body"),
            ) else {
                return respond(error(400, "filename/type/name/description/body required"));
            };
            let input = WriteMemoryInput {
                filename,
                type_,
                name,
                description,
                body: text,
            };
            match am::write_memory_file(&home(), &cwd, &input, now_ms()) {
                Ok(Ok(w)) => (
                    json_text(
                        StatusCode::CREATED,
                        &json!({ "name": w.name, "path": w.path }),
                    ),
                    Some((
                        cwd,
                        MemoryUpdate {
                            op: MemoryOp::Created,
                            path: w.path,
                        },
                    )),
                ),
                Ok(Err(r)) => respond(refused(&r)),
                Err(t) => respond(failed(&t)),
            }
        },
        || respond(thrown()),
    )
    .await;
    notify(&app, landed);
    r
}

/// `PATCH /api/memory/auto`.
async fn auto_patch(
    State(app): State<AppState>,
    RawQuery(query): RawQuery,
    body: Bytes,
) -> Response {
    let (r, landed) = blocking(
        move || -> Landed {
            let q = query.as_deref();
            let cwd = match trusted(q) {
                Ok(c) => c,
                Err(m) => return respond(error(400, m)),
            };
            let Some(filename) = non_empty(q, "filename") else {
                return respond(error(400, "filename query param required"));
            };
            let b = match parse_body(&body) {
                Ok(b) => b,
                Err(m) => return respond(error(400, m)),
            };
            // `body.key`: `undefined` unless an object has it.
            let get = |k: &str| b.as_object().and_then(|m| m.get(k)).cloned();
            let input = PatchMemoryInput {
                filename,
                description: get("description"),
                type_: get("type"),
                body: get("body"),
            };
            if input.description.is_none() && input.type_.is_none() && input.body.is_none() {
                return respond(error(400, "at least one of description/type/body required"));
            }
            match am::patch_memory_file(&home(), &cwd, &input, now_ms()) {
                Ok(Ok(p)) => (
                    json_text(
                        StatusCode::OK,
                        &json!({ "path": p.path, "parsed": p.parsed }),
                    ),
                    Some((
                        cwd,
                        MemoryUpdate {
                            op: MemoryOp::Updated,
                            path: p.path,
                        },
                    )),
                ),
                Ok(Err(r)) => respond(refused(&r)),
                Err(t) => respond(failed(&t)),
            }
        },
        || respond(thrown()),
    )
    .await;
    notify(&app, landed);
    r
}

/// `DELETE /api/memory/auto`.
async fn auto_delete(State(app): State<AppState>, RawQuery(query): RawQuery) -> Response {
    let (r, landed) = blocking(
        move || -> Landed {
            let q = query.as_deref();
            let cwd = match trusted(q) {
                Ok(c) => c,
                Err(m) => return respond(error(400, m)),
            };
            let Some(filename) = non_empty(q, "filename") else {
                return respond(error(400, "filename query param required"));
            };
            let home = home();
            match am::delete_memory_file(&home, &cwd, &filename) {
                Ok(Ok(())) => {
                    let path = node_path::join(&[&am::auto_memory_dir(&home, &cwd), &filename]);
                    (
                        json_text(StatusCode::OK, &json!({ "ok": true })),
                        Some((
                            cwd,
                            MemoryUpdate {
                                op: MemoryOp::Deleted,
                                path,
                            },
                        )),
                    )
                }
                Ok(Err(r)) => respond(refused(&r)),
                Err(t) => respond(failed(&t)),
            }
        },
        || respond(thrown()),
    )
    .await;
    notify(&app, landed);
    r
}

// ───────────────────────────────── rules ─────────────────────────────────

/// `parseScope(url)` and `scopedCwd(scope, url)`: the scope and, for the
/// project scope, the trusted cwd.
fn scoped(q: Option<&str>) -> Result<(RuleScope, Option<String>), BadRequest> {
    let raw = search_param(q, "scope").unwrap_or_else(|| "project".into());
    let Some(scope) = RuleScope::parse(&raw) else {
        return Err("invalid scope");
    };
    match scope {
        RuleScope::User => Ok((scope, None)),
        RuleScope::Project => Ok((scope, Some(trusted(q)?))),
    }
}

/// `fail(err)`: a refused path is a 400, anything else a 500, with the
/// error's message.
fn fail(t: &Thrown) -> Response {
    match t {
        Thrown::PathInjection(m) => error(400, m),
        t => error(500, t.message()),
    }
}

/// `GET /api/memory/rules`.
async fn rules_get(RawQuery(query): RawQuery) -> Response {
    blocking(
        move || {
            let q = query.as_deref();
            let (scope, cwd) = match scoped(q) {
                Ok(s) => s,
                Err(m) => return error(400, m),
            };
            let (home, cwd) = (home(), cwd.as_deref());
            if let Some(file) = non_empty(q, "file") {
                return match rules::read_rule(&home, scope, &file, cwd) {
                    Ok(Some(content)) => {
                        json_text(StatusCode::OK, &json!({ "name": file, "content": content }))
                    }
                    Ok(None) => error(404, "not found"),
                    Err(t) => fail(&t),
                };
            }
            let listed = rules::list_rules(&home, scope, cwd)
                .and_then(|files| Ok((rules::rules_dir(&home, scope, cwd)?, files)));
            match listed {
                Ok((dir, files)) => json_text(
                    StatusCode::OK,
                    &json!({
                        "dir": dir,
                        "files": files.iter().map(am::MemoryFile::to_json).collect::<Vec<_>>(),
                    }),
                ),
                Err(t) => fail(&t),
            }
        },
        thrown,
    )
    .await
}

/// `POST /api/memory/rules`.
async fn rules_post(RawQuery(query): RawQuery, body: Bytes) -> Response {
    blocking(
        move || {
            let q = query.as_deref();
            let (scope, cwd) = match scoped(q) {
                Ok(s) => s,
                Err(m) => return error(400, m),
            };
            let b = match parse_body(&body) {
                Ok(b) => b,
                Err(m) => return error(400, m),
            };
            let (Some(filename), Some(text)) = (str_field(&b, "filename"), str_field(&b, "body"))
            else {
                return error(400, "filename and body required");
            };
            match rules::write_rule(&home(), scope, filename, text, cwd.as_deref(), false) {
                Ok(Ok(w)) => json_text(
                    StatusCode::CREATED,
                    &json!({ "name": w.name, "path": w.path }),
                ),
                Ok(Err(r)) => refused(&r),
                Err(t) => fail(&t),
            }
        },
        thrown,
    )
    .await
}

/// `PATCH /api/memory/rules`.
async fn rules_patch(RawQuery(query): RawQuery, body: Bytes) -> Response {
    blocking(
        move || {
            let q = query.as_deref();
            let (scope, cwd) = match scoped(q) {
                Ok(s) => s,
                Err(m) => return error(400, m),
            };
            let Some(filename) = non_empty(q, "filename") else {
                return error(400, "filename query param required");
            };
            let b = match parse_body(&body) {
                Ok(b) => b,
                Err(m) => return error(400, m),
            };
            let Some(text) = str_field(&b, "body") else {
                return error(400, "body required");
            };
            match rules::write_rule(&home(), scope, &filename, text, cwd.as_deref(), true) {
                Ok(Ok(w)) => json_text(StatusCode::OK, &json!({ "name": w.name, "path": w.path })),
                Ok(Err(r)) => refused(&r),
                Err(t) => fail(&t),
            }
        },
        thrown,
    )
    .await
}

/// `DELETE /api/memory/rules`.
async fn rules_delete(RawQuery(query): RawQuery) -> Response {
    blocking(
        move || {
            let q = query.as_deref();
            let (scope, cwd) = match scoped(q) {
                Ok(s) => s,
                Err(m) => return error(400, m),
            };
            let Some(filename) = non_empty(q, "filename") else {
                return error(400, "filename query param required");
            };
            match rules::delete_rule(&home(), scope, &filename, cwd.as_deref()) {
                Ok(Ok(())) => json_text(StatusCode::OK, &json!({ "ok": true })),
                Ok(Err(r)) => refused(&r),
                Err(t) => fail(&t),
            }
        },
        thrown,
    )
    .await
}
