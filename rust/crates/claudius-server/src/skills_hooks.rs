//! `/api/skills` (+ `/api/skills/:name`), `/api/hooks` (+
//! `/api/hooks/disabled`), `/api/keybindings` and `/api/claudemd`: ports of
//! the six route files under `app/api/{skills,hooks,keybindings,claudemd}`,
//! over [`claudius_core::skills`], [`claudius_core::hooks`],
//! [`claudius_core::keybindings`] and [`claudius_core::claudemd`]. None of
//! them touches a live session.
//!
//! * `GET /api/skills?cwd&scope&name`: one skill when `scope` and `name` are
//!   both given (an invalid name throws: Next's empty 500), else both
//!   scopes' listings. `PUT {scope, cwd?, name, raw}` writes `SKILL.md`; a
//!   refused write is 400 `{error: message}`. `DELETE /api/skills/:name
//!   ?scope&cwd` removes the folder (the cwd is checked before the scope).
//! * `GET /api/hooks?cwd`: the three settings scopes' hooks. `POST {scope,
//!   cwd?, event, group}` appends a group, `DELETE {scope, cwd?, event,
//!   index}` removes one (404 when there is none), `POST
//!   /api/hooks/disabled {scope, cwd?, disabled}` sets or clears
//!   `disableAllHooks`.
//! * `GET /api/keybindings` / `PUT {data}`: `~/.claude/keybindings.json`.
//! * `GET /api/claudemd?cwd&scope&resolved`: `resolved=1` the import tree
//!   (before `scope` is looked at), `scope` one file, else all four. `PUT
//!   {scope, cwd?, content}` writes one and answers its path.
//!
//! A body that isn't JSON is the uncaught `await req.json()` (empty 500).
//! Bodies are read as `JSON.parse` reads them: through
//! [`db_agents::json_parse`] where Infinity can reach a check (`String(name)`,
//! `typeof index`), [`js_string`] for keybindings (a lone surrogate escape is
//! written back as the escape), [`js::json_parse`] elsewhere (a lone
//! surrogate becomes U+FFFD, as everywhere settings files are written).
//! Files are under `paths::home_dir()` (`CLAUDIUS_STATE_HOME`; TS:
//! `homedir()`).

use axum::Router;
use axum::body::Bytes;
use axum::extract::Path;
use axum::http::{StatusCode, Uri, header};
use axum::response::{IntoResponse, Response};
use axum::routing::{delete, get, post};
use claudius_agent::js;
use claudius_core::claudemd::{self, ClaudeMdScope};
use claudius_core::hooks::{self, HOOK_EVENT_NAMES};
use claudius_core::settings::Scope;
use claudius_core::skills::{self, SkillScope, Thrown};
use claudius_core::{db_agents, js_string, keybindings, log, paths, trusted_cwd};
use serde_json::{Map, Value, json};

use crate::AppState;
use crate::body::{JsonBody, thrown};
use crate::session_transcript::search_param;

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/api/skills", get(skills_get).put(skills_put))
        .route("/api/skills/{name}", delete(skills_delete))
        .route(
            "/api/hooks",
            get(hooks_get).post(hooks_post).delete(hooks_delete),
        )
        .route("/api/hooks/disabled", post(hooks_disabled))
        .route(
            "/api/keybindings",
            get(keybindings_get).put(keybindings_put),
        )
        .route("/api/claudemd", get(claudemd_get).put(claudemd_put))
}

const SKILLS: &str = "api/skills";
const HOOKS: &str = "api/hooks";
const HOOKS_DISABLED: &str = "api/hooks/disabled";
const KEYBINDINGS: &str = "api/keybindings";
const CLAUDEMD: &str = "api/claudemd";

/// `NextResponse.json(v, {status})`, `JSON.stringify`'s bytes.
fn json_text(status: StatusCode, text: String) -> Response {
    (status, [(header::CONTENT_TYPE, "application/json")], text).into_response()
}

fn ok(v: &Value) -> Response {
    json_text(StatusCode::OK, js::stringify(v))
}

fn err(status: StatusCode, msg: &str) -> Response {
    json_text(status, js::stringify(&json!({ "error": msg })))
}

fn bad(msg: &str) -> Response {
    err(StatusCode::BAD_REQUEST, msg)
}

/// What a TS handler didn't catch: logged as `Name: message`, then Next's
/// empty 500.
fn failed(route: &str, why: &str) -> Response {
    tracing::error!(target: log::API, "[{route}] {why}");
    thrown()
}

fn threw(route: &str, t: &Thrown) -> Response {
    failed(route, &t.to_string())
}

/// `JSON.stringify` of a value holding a cycle (a YAML alias in a front
/// matter).
const CIRCULAR: &str = "TypeError: Converting circular structure to JSON";

/// `homedir()`.
fn home() -> String {
    paths::home_dir().to_string_lossy().into_owned()
}

/// Run a handler's blocking work (the trusted-cwd lookup, the fs calls)
/// off the async runtime.
async fn blocking(f: impl FnOnce() -> Response + Send + 'static) -> Response {
    tokio::task::spawn_blocking(f)
        .await
        .unwrap_or_else(|_| thrown())
}

/// `resolveTrustedCwd(input)` (a non-string is the default root).
fn trusted(input: Option<&str>) -> Option<String> {
    trusted_cwd::resolve_trusted_cwd(input)
}

/// `body?.[key]` of a parsed body.
fn field<'a>(body: &'a Value, key: &str) -> Option<&'a Value> {
    body.as_object()?.get(key)
}

/// `body?.[key]` when `typeof` it is `"string"`.
fn str_field<'a>(body: &'a Value, key: &str) -> Option<&'a str> {
    field(body, key).and_then(db_agents::as_str)
}

/// `await req.json()` read by [`db_agents::json_parse`], uncaught: the
/// `SyntaxError` to log.
fn body_with_infinities(bytes: &[u8]) -> Result<Value, String> {
    db_agents::json_parse(&JsonBody::text(bytes)).map_err(|m| format!("SyntaxError: {m}"))
}

// ───────────────────────────────── skills ─────────────────────────────────

/// `GET /api/skills?cwd&scope&name`.
async fn skills_get(uri: Uri) -> Response {
    let q = uri.query().map(str::to_owned);
    blocking(move || {
        let q = q.as_deref();
        let Some(cwd) = trusted(search_param(q, "cwd").as_deref()) else {
            return bad("unknown cwd");
        };
        let home = home();
        let scope = search_param(q, "scope").filter(|s| !s.is_empty());
        let name = search_param(q, "name").filter(|s| !s.is_empty());
        if let (Some(scope), Some(name)) = (scope, name) {
            let Some(scope) = SkillScope::parse(&scope) else {
                return bad("invalid scope");
            };
            return match skills::read_skill(&home, scope, &cwd, &name) {
                Err(t) => threw(SKILLS, &t),
                Ok(None) => err(StatusCode::NOT_FOUND, "not found"),
                Ok(Some(file)) => match file.to_json() {
                    Some(v) => ok(&v),
                    None => failed(SKILLS, CIRCULAR),
                },
            };
        }
        // `Promise.all`: a NUL in a path is refused before either `readdir`
        // starts, so it is the error even when the other scope's fails.
        let scopes = [SkillScope::User, SkillScope::Project];
        let lists: Vec<_> = scopes
            .iter()
            .map(|&s| skills::list_skills(&home, s, &cwd))
            .collect();
        let first = lists
            .iter()
            .filter_map(|r| r.as_ref().err())
            .min_by_key(|t| t.name != "TypeError");
        if let Some(t) = first {
            return threw(SKILLS, t);
        }
        let mut out = Vec::new();
        for (scope, files) in scopes.iter().zip(lists) {
            let Some(files) = files
                .unwrap_or_default()
                .iter()
                .map(skills::SkillFile::to_json)
                .collect::<Option<Vec<_>>>()
            else {
                return failed(SKILLS, CIRCULAR);
            };
            out.push(json!({ "scope": scope.as_str(), "files": files }));
        }
        ok(&json!({ "cwd": cwd, "scopes": out }))
    })
    .await
}

/// `PUT /api/skills {scope, cwd?, name, raw}`.
async fn skills_put(bytes: Bytes) -> Response {
    blocking(move || {
        let body = match body_with_infinities(&bytes) {
            Ok(b) => b,
            Err(why) => return failed(SKILLS, &why),
        };
        let Some(scope) = str_field(&body, "scope").and_then(SkillScope::parse) else {
            return bad("invalid scope");
        };
        let Some(name) = field(&body, "name").filter(|n| js::truthy(n)) else {
            return bad("name required");
        };
        let Some(raw) = str_field(&body, "raw") else {
            return bad("raw content required");
        };
        let Some(cwd) = trusted(str_field(&body, "cwd")) else {
            return bad("unknown cwd");
        };
        match skills::write_skill(&home(), scope, &cwd, name, raw) {
            Err(t) => bad(&t.message),
            Ok(()) => ok(&json!({ "ok": true })),
        }
    })
    .await
}

/// `DELETE /api/skills/:name?scope&cwd`.
async fn skills_delete(Path(name): Path<String>, uri: Uri) -> Response {
    let q = uri.query().map(str::to_owned);
    blocking(move || {
        let q = q.as_deref();
        let scope = search_param(q, "scope");
        let Some(cwd) = trusted(search_param(q, "cwd").as_deref()) else {
            return bad("unknown cwd");
        };
        let Some(scope) = scope.as_deref().and_then(SkillScope::parse) else {
            return bad("invalid scope");
        };
        match skills::delete_skill(&home(), scope, &cwd, &name) {
            Err(t) => bad(&t.message),
            Ok(false) => err(StatusCode::NOT_FOUND, "not found"),
            Ok(true) => ok(&json!({ "ok": true })),
        }
    })
    .await
}

// ───────────────────────────────── hooks ──────────────────────────────────

/// `GET /api/hooks?cwd`.
async fn hooks_get(uri: Uri) -> Response {
    let q = uri.query().map(str::to_owned);
    blocking(move || {
        let Some(cwd) = trusted(search_param(q.as_deref(), "cwd").as_deref()) else {
            return bad("unknown cwd");
        };
        match hooks::list_all(&cwd) {
            Err(t) => threw(HOOKS, &t),
            Ok(scopes) => ok(&json!({
                "cwd": cwd,
                "scopes": scopes.iter().map(hooks::ScopedHooks::to_json).collect::<Vec<_>>(),
            })),
        }
    })
    .await
}

/// `body.scope` checked against the settings scopes.
fn settings_scope(body: &Value) -> Option<Scope> {
    str_field(body, "scope").and_then(Scope::parse)
}

/// `HOOK_EVENT_NAMES.includes(body.event)`.
fn hook_event(body: &Value) -> Option<&str> {
    str_field(body, "event").filter(|e| HOOK_EVENT_NAMES.contains(e))
}

/// `!!body?.group?.hooks?.length`: only an object group has a `hooks`, and
/// only an array, a string or an object with a `length` has a length.
fn has_hooks(body: &Value) -> bool {
    let Some(hooks) = field(body, "group").and_then(|g| field(g, "hooks")) else {
        return false;
    };
    match hooks {
        Value::Array(items) => !items.is_empty(),
        Value::String(s) => db_agents::is_string(hooks) && !s.is_empty(),
        Value::Object(m) => m.get("length").is_some_and(js::truthy),
        _ => false,
    }
}

/// `POST /api/hooks {scope, cwd?, event, group}`.
async fn hooks_post(bytes: Bytes) -> Response {
    blocking(move || {
        let body = match body_with_infinities(&bytes) {
            Ok(b) => b,
            Err(why) => return failed(HOOKS, &why),
        };
        let Some(scope) = settings_scope(&body) else {
            return bad("invalid scope");
        };
        let Some(event) = hook_event(&body) else {
            return bad("invalid event");
        };
        if !has_hooks(&body) {
            return bad("group.hooks required");
        }
        let Some(cwd) = trusted(str_field(&body, "cwd")) else {
            return bad("unknown cwd");
        };
        // The group as `JSON.stringify` writes it: Infinity is `null`.
        let plain = js::json_parse(&JsonBody::text(&bytes)).unwrap_or_default();
        let group = field(&plain, "group").cloned().unwrap_or_default();
        match hooks::add_group(scope, &cwd, event, &group) {
            Err(t) => threw(HOOKS, &t),
            Ok(()) => ok(&json!({ "ok": true })),
        }
    })
    .await
}

/// `DELETE /api/hooks {scope, cwd?, event, index}`.
async fn hooks_delete(bytes: Bytes) -> Response {
    blocking(move || {
        let body = match body_with_infinities(&bytes) {
            Ok(b) => b,
            Err(why) => return failed(HOOKS, &why),
        };
        let Some(scope) = settings_scope(&body) else {
            return bad("invalid scope");
        };
        let Some(event) = hook_event(&body) else {
            return bad("invalid event");
        };
        let Some(index) = field(&body, "index").and_then(db_agents::number) else {
            return bad("index required");
        };
        let Some(cwd) = trusted(str_field(&body, "cwd")) else {
            return bad("unknown cwd");
        };
        match hooks::remove_group(scope, &cwd, event, index) {
            Err(t) => threw(HOOKS, &t),
            Ok(false) => err(StatusCode::NOT_FOUND, "not found"),
            Ok(true) => ok(&json!({ "ok": true })),
        }
    })
    .await
}

/// `POST /api/hooks/disabled {scope, cwd?, disabled}`.
async fn hooks_disabled(bytes: Bytes) -> Response {
    blocking(move || {
        let body = match body_with_infinities(&bytes) {
            Ok(b) => b,
            Err(why) => return failed(HOOKS_DISABLED, &why),
        };
        let Some(scope) = settings_scope(&body) else {
            return bad("invalid scope");
        };
        let Some(cwd) = trusted(str_field(&body, "cwd")) else {
            return bad("unknown cwd");
        };
        let disabled = field(&body, "disabled").is_some_and(js::truthy);
        match hooks::set_disable_all_hooks(scope, &cwd, disabled) {
            Err(t) => threw(HOOKS_DISABLED, &t),
            Ok(()) => ok(&json!({ "ok": true })),
        }
    })
    .await
}

// ────────────────────────────── keybindings ───────────────────────────────

/// `GET /api/keybindings`.
async fn keybindings_get() -> Response {
    blocking(|| match keybindings::read_keybindings(&home()) {
        Err(t) => threw(KEYBINDINGS, &t),
        Ok(v) => json_text(StatusCode::OK, js_string::stringify(&v)),
    })
    .await
}

/// `PUT /api/keybindings {data}`: `data` must be an object or array.
async fn keybindings_put(bytes: Bytes) -> Response {
    blocking(move || {
        let body = match js_string::parse(&JsonBody::text(&bytes)) {
            Ok(b) => b,
            Err(m) => return failed(KEYBINDINGS, &format!("SyntaxError: {m}")),
        };
        let Some(data) = field(&body, "data").filter(|d| d.is_object() || d.is_array()) else {
            return bad("data required");
        };
        match keybindings::write_keybindings(&home(), data) {
            Err(t) => threw(KEYBINDINGS, &t),
            Ok(()) => ok(&json!({ "ok": true })),
        }
    })
    .await
}

// ──────────────────────────────── claudemd ────────────────────────────────

/// `GET /api/claudemd?cwd&scope&resolved`.
async fn claudemd_get(uri: Uri) -> Response {
    let q = uri.query().map(str::to_owned);
    blocking(move || {
        let q = q.as_deref();
        let Some(cwd) = trusted(search_param(q, "cwd").as_deref()) else {
            return bad("unknown cwd");
        };
        let home = home();
        if search_param(q, "resolved").as_deref() == Some("1") {
            return match claudemd::resolve_hierarchy(&home, &cwd) {
                Err(t) => threw(CLAUDEMD, &t),
                Ok(v) => ok(&v),
            };
        }
        if let Some(scope) = search_param(q, "scope").filter(|s| !s.is_empty()) {
            let Some(scope) = ClaudeMdScope::parse(&scope) else {
                return bad("invalid scope");
            };
            return match claudemd::read_scope(&home, scope, &cwd) {
                Err(t) => threw(CLAUDEMD, &t),
                Ok(file) => ok(&file.to_json()),
            };
        }
        match claudemd::read_all_scopes(&home, &cwd) {
            Err(t) => threw(CLAUDEMD, &t),
            Ok(files) => ok(&json!({
                "cwd": cwd,
                "scopes": files.iter().map(claudemd::ScopeFile::to_json).collect::<Vec<_>>(),
            })),
        }
    })
    .await
}

/// `PUT /api/claudemd {scope, cwd?, content}`.
async fn claudemd_put(bytes: Bytes) -> Response {
    blocking(move || {
        let body = match JsonBody::parse_or_message(&bytes) {
            Ok(b) => b,
            Err(m) => return failed(CLAUDEMD, &format!("SyntaxError: {m}")),
        };
        let str_of = |key: &str| field(&body, key).and_then(Value::as_str);
        let Some(scope) = str_of("scope").and_then(ClaudeMdScope::parse) else {
            return bad("invalid scope");
        };
        let Some(content) = str_of("content") else {
            return bad("content required");
        };
        let Some(cwd) = trusted(str_of("cwd")) else {
            return bad("unknown cwd");
        };
        match claudemd::write_scope(&home(), scope, &cwd, content) {
            Err(t) => threw(CLAUDEMD, &t),
            Ok(path) => {
                let mut m = Map::new();
                m.insert("ok".into(), Value::Bool(true));
                m.insert("path".into(), Value::String(path));
                ok(&Value::Object(m))
            }
        }
    })
    .await
}
