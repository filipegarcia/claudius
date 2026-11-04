//! The settings file routes: ports of `app/api/settings/route.ts` (GET),
//! `settings/full` (GET, PUT), `settings/permissions` (GET, POST),
//! `settings/auto-mode` (GET, POST, DELETE), `settings/additional-dirs`
//! (POST) and `settings/skill-overrides` (GET, POST), over
//! [`claudius_core::settings`].
//!
//! * `GET /api/settings?cwd=&scope=`: one scope's settings value as
//!   `JSON.parse` reads it (`{scope, settings}`; any JSON value, `{}` for a
//!   missing file), or all three (`{scopes: [{scope, settings}]}`). A
//!   `scope` that isn't `user` / `project` / `local` is a 400, checked after
//!   the cwd.
//! * `GET /api/settings/full?cwd=`: `{cwd, scopes: [{scope, path,
//!   settings}]}`. `PUT {scope, cwd?, settings}` writes `settings` (any
//!   object or array) over the scope's file as it is.
//! * `GET /api/settings/permissions?cwd=`: each scope's `permissions ?? {}`.
//!   `POST {scope, cwd?, patch}` spreads `patch` over the scope's
//!   `permissions` and answers the whole new value.
//! * `/api/settings/auto-mode`: the user scope's `autoMode` (GET), `patch`
//!   spread over it (POST), or the key dropped (DELETE, `cwd` in the query).
//! * `POST /api/settings/additional-dirs {scope, cwd?, add?, remove?}`:
//!   `permissions.additionalDirectories` as a JS `Set` (SameValueZero, the
//!   file's entries first), `add`ed then `remove`d; the key goes when the
//!   list empties, and `permissions` when every value left in it is `null`.
//!   A network path in `add` (a UNC share or a `/net/<host>` automount,
//!   after JS `trim`) is refused with a 400 before the cwd is looked at.
//! * `/api/settings/skill-overrides`: the project scope's `skillOverrides`
//!   (GET), or one name set to one of the four values (POST; `"on"` deletes
//!   it, and an emptied map is dropped).
//!
//! A cwd that `resolveTrustedCwd` doesn't know is the 400 `unknown cwd` (a
//! non-string `cwd` is no input: the server's cwd). Bodies are a bare `await
//! req.json()` (an empty or malformed body is Next's empty 500), read with
//! ±Infinity kept apart from `null` ([`db_agents::json_parse`]), as are the
//! files. Nothing here catches a throw: a file that doesn't load, an fs
//! error, or V8's `TypeError` (reading a key off a `null` file, a
//! non-string in `add`, a non-iterable `remove`) is the empty 500, logged as
//! `[api/settings/…] <name>: <message>`. No live session is told: the CLI
//! reads these files at its next start.

use axum::Router;
use axum::body::Bytes;
use axum::extract::RawQuery;
use axum::http::{StatusCode, header};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use claudius_agent::js;
use claudius_core::settings::{self, Scope, UpdateError};
use claudius_core::{db_agents, log, trusted_cwd};
use serde_json::{Map, Value, json};

use crate::AppState;
use crate::body::{JsonBody, thrown};
use crate::session_transcript::search_param;

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/api/settings", get(get_settings))
        .route("/api/settings/full", get(get_full).put(put_full))
        .route(
            "/api/settings/permissions",
            get(get_permissions).post(post_permissions),
        )
        .route(
            "/api/settings/auto-mode",
            get(get_auto_mode)
                .post(post_auto_mode)
                .delete(delete_auto_mode),
        )
        .route("/api/settings/additional-dirs", post(post_additional_dirs))
        .route(
            "/api/settings/skill-overrides",
            get(get_skill_overrides).post(post_skill_override),
        )
}

const SCOPES: [(Scope, &str); 3] = [
    (Scope::User, "user"),
    (Scope::Project, "project"),
    (Scope::Local, "local"),
];

/// `NextResponse.json(body, {status})`.
fn json_text(status: StatusCode, body: &Value) -> Response {
    (
        status,
        [(header::CONTENT_TYPE, "application/json")],
        js::stringify(body),
    )
        .into_response()
}

fn ok(body: &Value) -> Response {
    json_text(StatusCode::OK, body)
}

fn bad_request(msg: &str) -> Response {
    json_text(StatusCode::BAD_REQUEST, &json!({ "error": msg }))
}

/// A throw the TS handler doesn't catch: Next's empty 500.
fn failed(route: &str, name: &str, message: &dyn std::fmt::Display) -> Response {
    tracing::error!(target: log::API, "[api/{route}] {name}: {message}");
    thrown()
}

fn update_failed(route: &str, e: &UpdateError) -> Response {
    failed(route, e.name(), e)
}

/// `await req.json()`, uncaught.
fn body(route: &str, bytes: &[u8]) -> Result<Value, Box<Response>> {
    db_agents::json_parse(&JsonBody::text(bytes))
        .map_err(|m| Box::new(failed(route, "SyntaxError", &m)))
}

/// `body.key` when `typeof` it is `"string"`.
fn text<'a>(v: &'a Value, key: &str) -> Option<&'a str> {
    v.get(key).and_then(db_agents::as_str)
}

/// `!body?.scope || !SCOPES.includes(body.scope)` failing.
fn scope_of(v: &Value) -> Option<Scope> {
    text(v, "scope").and_then(Scope::parse)
}

/// `typeof v === "object" && v !== null`.
fn is_object(v: Option<&Value>) -> bool {
    matches!(v, Some(Value::Object(_) | Value::Array(_)))
}

/// `resolveTrustedCwd(input)`: a non-string input is no input.
fn trusted(input: Option<&str>) -> Option<String> {
    trusted_cwd::resolve_trusted_cwd(input)
}

fn unknown_cwd() -> Response {
    bad_request("unknown cwd")
}

/// `GET /api/settings`.
async fn get_settings(RawQuery(query): RawQuery) -> Response {
    const ROUTE: &str = "settings";
    let q = query.as_deref();
    let Some(cwd) = trusted(search_param(q, "cwd").as_deref()) else {
        return unknown_cwd();
    };
    if let Some(name) = search_param(q, "scope").filter(|s| !s.is_empty()) {
        let Some(scope) = Scope::parse(&name) else {
            return bad_request("invalid scope");
        };
        return match settings::read_settings_twin(scope, &cwd) {
            Ok(v) => ok(&json!({ "scope": name, "settings": settings::plain(&v) })),
            Err(e) => failed(ROUTE, e.name(), &e),
        };
    }
    let mut all = Vec::new();
    for (scope, name) in SCOPES {
        match settings::read_settings_twin(scope, &cwd) {
            Ok(v) => all.push(json!({ "scope": name, "settings": settings::plain(&v) })),
            Err(e) => return failed(ROUTE, e.name(), &e),
        }
    }
    ok(&json!({ "scopes": all }))
}

/// `GET /api/settings/full`.
async fn get_full(RawQuery(query): RawQuery) -> Response {
    let Some(cwd) = trusted(search_param(query.as_deref(), "cwd").as_deref()) else {
        return unknown_cwd();
    };
    let mut out = Vec::new();
    for (scope, name) in SCOPES {
        match settings::read_settings_twin(scope, &cwd) {
            Ok(v) => out.push(json!({
                "scope": name,
                "path": settings::path_for(scope, &cwd).to_string_lossy(),
                "settings": settings::plain(&v),
            })),
            Err(e) => return failed("settings/full", e.name(), &e),
        }
    }
    ok(&json!({ "cwd": cwd, "scopes": out }))
}

/// `PUT /api/settings/full`.
async fn put_full(bytes: Bytes) -> Response {
    const ROUTE: &str = "settings/full";
    let b = match body(ROUTE, &bytes) {
        Ok(b) => b,
        Err(r) => return *r,
    };
    let Some(scope) = scope_of(&b) else {
        return bad_request("invalid scope");
    };
    if !is_object(b.get("settings")) {
        return bad_request("settings required");
    }
    let Some(cwd) = trusted(text(&b, "cwd")) else {
        return unknown_cwd();
    };
    match settings::write_settings_value(scope, &cwd, &settings::plain(&b["settings"])) {
        Ok(()) => ok(&json!({ "ok": true })),
        Err(e) => failed(ROUTE, e.name(), &e),
    }
}

/// `GET /api/settings/permissions`.
async fn get_permissions(RawQuery(query): RawQuery) -> Response {
    const ROUTE: &str = "settings/permissions";
    let Some(cwd) = trusted(search_param(query.as_deref(), "cwd").as_deref()) else {
        return unknown_cwd();
    };
    let mut out = Map::new();
    for (scope, name) in SCOPES {
        let s = match settings::read_settings_twin(scope, &cwd) {
            Ok(s) => s,
            Err(e) => return failed(ROUTE, e.name(), &e),
        };
        match settings::get_twin(&s, "permissions") {
            Ok(p) => out.insert(name.into(), settings::plain(&settings::or_empty(p))),
            Err(e) => return update_failed(ROUTE, &e),
        };
    }
    ok(&Value::Object(out))
}

/// `POST /api/settings/permissions`.
async fn post_permissions(bytes: Bytes) -> Response {
    const ROUTE: &str = "settings/permissions";
    let b = match body(ROUTE, &bytes) {
        Ok(b) => b,
        Err(r) => return *r,
    };
    let Some(scope) = scope_of(&b) else {
        return bad_request("invalid scope");
    };
    if !is_object(b.get("patch")) {
        return bad_request("patch required");
    }
    let Some(cwd) = trusted(text(&b, "cwd")) else {
        return unknown_cwd();
    };
    match settings::update_permissions(scope, &cwd, &b["patch"]) {
        Ok(next) => ok(&json!({ "ok": true, "settings": settings::plain(&next) })),
        Err(e) => update_failed(ROUTE, &e),
    }
}

/// The user scope's `autoMode ?? {}`, for GET.
async fn get_auto_mode(RawQuery(query): RawQuery) -> Response {
    const ROUTE: &str = "settings/auto-mode";
    let Some(cwd) = trusted(search_param(query.as_deref(), "cwd").as_deref()) else {
        return unknown_cwd();
    };
    let s = match settings::read_settings_twin(Scope::User, &cwd) {
        Ok(s) => s,
        Err(e) => return failed(ROUTE, e.name(), &e),
    };
    match settings::get_twin(&s, "autoMode") {
        Ok(a) => ok(&json!({ "autoMode": settings::plain(&settings::or_empty(a)) })),
        Err(e) => update_failed(ROUTE, &e),
    }
}

/// `POST /api/settings/auto-mode`.
async fn post_auto_mode(bytes: Bytes) -> Response {
    const ROUTE: &str = "settings/auto-mode";
    let b = match body(ROUTE, &bytes) {
        Ok(b) => b,
        Err(r) => return *r,
    };
    if !is_object(b.get("patch")) {
        return bad_request("patch required");
    }
    let Some(cwd) = trusted(text(&b, "cwd")) else {
        return unknown_cwd();
    };
    match settings::update_auto_mode(&cwd, &b["patch"]) {
        Ok(next) => ok(&json!({
            "ok": true,
            "autoMode": settings::plain(&settings::or_empty(next.get("autoMode"))),
        })),
        Err(e) => update_failed(ROUTE, &e),
    }
}

/// `DELETE /api/settings/auto-mode`.
async fn delete_auto_mode(RawQuery(query): RawQuery) -> Response {
    let Some(cwd) = trusted(search_param(query.as_deref(), "cwd").as_deref()) else {
        return unknown_cwd();
    };
    match settings::reset_auto_mode(&cwd) {
        Ok(_) => ok(&json!({ "ok": true, "autoMode": {} })),
        Err(e) => update_failed("settings/auto-mode", &e),
    }
}

/// `isNetworkPath(raw)`: `/^\\\\[^\\]+\\/` or `/^\/net\/[^/]+(\/|$)/` on
/// the JS-trimmed text.
fn is_network_path(raw: &str) -> bool {
    let p = js::trim(raw);
    let unc = p
        .strip_prefix("\\\\")
        .and_then(|rest| rest.find('\\'))
        .is_some_and(|run| run > 0);
    let automount = p
        .strip_prefix("/net/")
        .is_some_and(|rest| !rest.is_empty() && !rest.starts_with('/'));
    unc || automount
}

/// Set membership (SameValueZero) between twins: numbers by value, every
/// object or array distinct.
fn same_value_zero(a: &Value, b: &Value) -> bool {
    match (a, b) {
        (Value::Number(x), Value::Number(y)) => x.as_f64() == y.as_f64(),
        (Value::Object(_) | Value::Array(_), _) | (_, Value::Object(_) | Value::Array(_)) => false,
        _ => a == b,
    }
}

/// V8's `TypeError` for `for (… of v)` over a value that isn't iterable.
fn not_iterable(v: &Value) -> String {
    let what = match v {
        Value::Bool(b) => format!("boolean {b}"),
        // A string here is an Infinity sentinel (other strings iterate).
        Value::Number(_) | Value::String(_) => format!("number {}", db_agents::js_string(v)),
        _ => "object".to_owned(),
    };
    format!("{what} is not iterable (cannot read property Symbol(Symbol.iterator))")
}

/// `POST /api/settings/additional-dirs`.
async fn post_additional_dirs(bytes: Bytes) -> Response {
    const ROUTE: &str = "settings/additional-dirs";
    let type_error = |m: &str| failed(ROUTE, "TypeError", &m);
    let b = match body(ROUTE, &bytes) {
        Ok(b) => b,
        Err(r) => return *r,
    };
    let Some(scope) = scope_of(&b) else {
        return bad_request("invalid scope");
    };
    // `(body.add ?? []).filter(isNetworkPath)`
    let add: &[Value] = match b.get("add") {
        None | Some(Value::Null) => &[],
        Some(Value::Array(items)) => items,
        Some(_) => return type_error("(body.add ?? []).filter is not a function"),
    };
    let mut rejected = Vec::new();
    for a in add {
        match a {
            Value::Null => return type_error(&settings::null_property_error("trim")),
            a => match db_agents::as_str(a) {
                Some(s) if is_network_path(s) => rejected.push(s),
                Some(_) => {}
                None => return type_error("raw.trim is not a function"),
            },
        }
    }
    if !rejected.is_empty() {
        return bad_request(&format!(
            "Network paths aren't allowed as additional directories: {}. On Windows, use a mapped drive letter instead.",
            rejected.join(", ")
        ));
    }
    let Some(cwd) = trusted(text(&b, "cwd")) else {
        return unknown_cwd();
    };
    let current = match settings::read_settings_twin(scope, &cwd) {
        Ok(s) => s,
        Err(e) => return failed(ROUTE, e.name(), &e),
    };
    let permissions = match settings::get_twin(&current, "permissions") {
        Ok(p) => p,
        Err(e) => return update_failed(ROUTE, &e),
    };
    // `new Set(Array.isArray(settings.permissions?.additionalDirectories) ? … : [])`
    let mut dirs = match permissions.and_then(|p| p.get("additionalDirectories")) {
        Some(Value::Array(items)) => js::dedupe(items.clone()),
        _ => Vec::new(),
    };
    for a in add {
        if !dirs.iter().any(|d| same_value_zero(d, a)) {
            dirs.push(a.clone());
        }
    }
    // `for (const r of body.remove ?? [])`: a string by code point.
    let remove: Vec<Value> = match b.get("remove") {
        None | Some(Value::Null) => Vec::new(),
        Some(Value::Array(items)) => items.clone(),
        Some(v @ Value::String(s)) if db_agents::as_str(v).is_some() => {
            s.chars().map(|c| Value::String(c.into())).collect()
        }
        Some(v) => return type_error(&not_iterable(v)),
    };
    for r in &remove {
        if let Some(i) = dirs.iter().position(|d| same_value_zero(d, r)) {
            dirs.remove(i);
        }
    }
    let mut perms = settings::spread_or_empty(permissions);
    if dirs.is_empty() {
        // `additionalDirectories: undefined`, which JSON.stringify leaves out.
        perms.shift_remove("additionalDirectories");
    } else {
        perms.insert("additionalDirectories".into(), Value::Array(dirs.clone()));
    }
    let drop_permissions = perms.values().all(Value::is_null);
    let mut next = settings::spread_twin(&current);
    next.insert("permissions".into(), Value::Object(perms));
    if drop_permissions {
        next.shift_remove("permissions");
    }
    match settings::write_settings_value(scope, &cwd, &settings::plain(&Value::Object(next))) {
        Ok(()) => ok(&json!({
            "ok": true,
            "additionalDirectories": settings::plain(&Value::Array(dirs)),
        })),
        Err(e) => failed(ROUTE, e.name(), &e),
    }
}

/// The project scope's `skillOverrides ?? {}`, for GET.
async fn get_skill_overrides(RawQuery(query): RawQuery) -> Response {
    const ROUTE: &str = "settings/skill-overrides";
    let Some(cwd) = trusted(search_param(query.as_deref(), "cwd").as_deref()) else {
        return unknown_cwd();
    };
    let s = match settings::read_settings_twin(Scope::Project, &cwd) {
        Ok(s) => s,
        Err(e) => return failed(ROUTE, e.name(), &e),
    };
    match settings::get_twin(&s, "skillOverrides") {
        Ok(o) => ok(&json!({ "skillOverrides": settings::plain(&settings::or_empty(o)) })),
        Err(e) => update_failed(ROUTE, &e),
    }
}

/// `POST /api/settings/skill-overrides`.
async fn post_skill_override(bytes: Bytes) -> Response {
    const ROUTE: &str = "settings/skill-overrides";
    let b = match body(ROUTE, &bytes) {
        Ok(b) => b,
        Err(r) => return *r,
    };
    let Some(name) = text(&b, "name").filter(|n| !n.is_empty()) else {
        return bad_request("name required");
    };
    let value = b.get("value");
    if !settings::is_skill_override_value(value) {
        return bad_request("invalid value");
    }
    let Some(cwd) = trusted(text(&b, "cwd")) else {
        return unknown_cwd();
    };
    let value = value.and_then(Value::as_str).unwrap_or_default();
    match settings::update_skill_override(&cwd, name, value) {
        Ok(next) => ok(&json!({
            "ok": true,
            "skillOverrides": settings::plain(&settings::or_empty(next.get("skillOverrides"))),
        })),
        Err(e) => update_failed(ROUTE, &e),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn network_paths_match_the_ts_regexes() {
        for p in [
            r"\\server\share",
            r"\\s\",
            " \\\\s\\x ",
            "\u{feff}\\\\a\\b",
            "/net/host",
            "/net/host/x",
            "/net/h\n",
            "\t/net/h ",
            "\u{a0}/net/h",
            "/net/\u{1f600}",
        ] {
            assert!(is_network_path(p), "{p:?}");
        }
        for p in [
            r"\\server",
            r"\\\x",
            r"\server\share",
            "//server/share",
            "/net/",
            "/net//x",
            "/net",
            "/NET/h",
            "//net/h",
            "/network/h",
            "net/h",
            "\u{85}/net/h",
            "",
        ] {
            assert!(!is_network_path(p), "{p:?}");
        }
    }

    #[test]
    fn set_membership_is_same_value_zero() {
        assert!(same_value_zero(&json!(0), &json!(-0.0)));
        assert!(same_value_zero(&json!(1), &json!(1.0)));
        assert!(!same_value_zero(&json!(1), &json!("1")));
        assert!(same_value_zero(&json!(null), &json!(null)));
        assert!(same_value_zero(&json!("a"), &json!("a")));
        assert!(!same_value_zero(&json!({}), &json!({})));
        assert!(!same_value_zero(&json!([]), &json!([])));
        assert!(!same_value_zero(&json!("a"), &json!(["a"])));
    }

    #[test]
    fn not_iterable_reads_like_v8() {
        let tail = " is not iterable (cannot read property Symbol(Symbol.iterator))";
        let inf = db_agents::json_parse("-1e400").unwrap();
        for (v, what) in [
            (json!(5), "number 5"),
            (json!(-0.0), "number 0"),
            (json!(1e21), "number 1e+21"),
            (inf, "number -Infinity"),
            (json!(true), "boolean true"),
            (json!(false), "boolean false"),
            (json!({}), "object"),
        ] {
            assert_eq!(not_iterable(&v), format!("{what}{tail}"));
        }
    }
}
