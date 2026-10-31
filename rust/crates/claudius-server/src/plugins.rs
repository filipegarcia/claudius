//! `/api/plugins` (GET, POST), `/api/plugins/available` (GET) and
//! `/api/plugins/reload` (POST): ports of `app/api/plugins/route.ts`,
//! `available/route.ts` and `reload/route.ts`, over
//! [`claudius_core::plugins`] and the live sessions.
//!
//! * `GET /api/plugins?cwd=&sessionId=`: each scope's plugin settings of a
//!   trusted cwd (400 `unknown cwd` otherwise) and, for a live session, the
//!   CLI's installed plugins (`reload_plugins` with `hold_on_cache_impact`,
//!   so a page load never drops the prompt cache), enriched from each
//!   plugin's `plugin.json`, or why the reload failed (`installedError`).
//!   `pluginErrors` are the load errors of the session's newest
//!   `system/init`, cleared when the reload reports `error_count: 0`. A
//!   settings file that doesn't load is listed with its `parseError`; any
//!   other read failure is Next's empty 500.
//! * `POST /api/plugins {kind, scope, cwd?, …}`: `toggle` (`pluginId`,
//!   `enabled`), `marketplaces` (`op`: `add-extra` `{name, source}`,
//!   `remove-extra` `{name}`, `remove-policy` `{list, index}`) and
//!   `plugin-config` (`pluginId`, `name`, `value`; no `value` clears it).
//!   A scope file that doesn't load is a 422 naming it, and is not written.
//! * `GET /api/plugins/available`: the cloned marketplaces' plugins.
//! * `POST /api/plugins/reload?sessionId=&force=`: `reload_plugins` on one
//!   live session (held on cache impact unless `force` is `1` / `true`):
//!   the CLI's reply, or 500 with its error (404 for an unknown session).
//!
//! The POST body is a bare `await req.json()` (an empty or malformed body
//! is the empty 500). It is read as `JSON.parse` reads it: a number past
//! f64 is `null` in what gets written (as `JSON.stringify` writes
//! Infinity), but `Infinity` where the handler tests it (a truthy
//! `pluginId`, `enabled` or `source`; a numeric `index`).

use axum::Router;
use axum::body::Bytes;
use axum::extract::{RawQuery, State};
use axum::http::{StatusCode, header};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use claudius_agent::js;
use claudius_core::plugins::{self, PluginsError, PolicyList};
use claudius_core::settings::{Scope, SettingsError};
use claudius_core::{db_agents, log, trusted_cwd};
use serde_json::{Value, json};

use crate::AppState;
use crate::body::{JsonBody, thrown};
use crate::session_transcript::search_param;

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/api/plugins", get(list).post(update))
        .route("/api/plugins/available", get(available))
        .route("/api/plugins/reload", post(reload))
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

fn error(status: StatusCode, msg: &str) -> Response {
    json_text(status, &json!({"error": msg}))
}

fn ok() -> Response {
    json_text(StatusCode::OK, &json!({"ok": true}))
}

/// A call that threw in TS: Next's empty 500.
fn failed(route: &str, why: &dyn std::fmt::Display) -> Response {
    tracing::error!(target: log::API, "[api/{route}] {why}");
    thrown()
}

/// `GET /api/plugins`.
async fn list(State(app): State<AppState>, RawQuery(query): RawQuery) -> Response {
    let q = query.as_deref();
    let Some(cwd) = trusted_cwd::resolve_trusted_cwd(search_param(q, "cwd").as_deref()) else {
        return error(StatusCode::BAD_REQUEST, "unknown cwd");
    };
    let session_id = search_param(q, "sessionId");
    let scopes = match plugins::list_all(&cwd) {
        Ok(s) => s,
        Err(e) => return failed("plugins", &e),
    };
    let mut installed = Vec::new();
    let mut installed_error = Value::Null;
    let mut plugin_errors = Vec::new();
    if let Some(s) = session_id
        .filter(|id| !id.is_empty())
        .and_then(|id| app.mgr.get(&id))
    {
        plugin_errors = s.plugin_load_errors();
        match s.reload_plugins(true).await {
            Ok(Value::Null) => {
                return failed(
                    "plugins",
                    &"TypeError: Cannot read properties of null (reading 'plugins')",
                );
            }
            Ok(d) => {
                let raw = d.get("plugins").and_then(Value::as_array);
                installed = plugins::enrich_installed(raw.map_or(&[], Vec::as_slice));
                if d.get("error_count").and_then(Value::as_f64) == Some(0.0) {
                    plugin_errors = Vec::new();
                }
            }
            Err(e) => installed_error = Value::String(e),
        }
    }
    json_text(
        StatusCode::OK,
        &json!({
            "cwd": cwd,
            "scopes": scopes,
            "installed": installed,
            "installedError": installed_error,
            "pluginErrors": plugin_errors,
        }),
    )
}

/// `POST /api/plugins`.
async fn update(bytes: Bytes) -> Response {
    // `await req.json()`, uncaught. `plain` has a number past f64 as `null`
    // (what JSON.stringify writes); `twin` keeps it as Infinity.
    let text = JsonBody::text(&bytes);
    let plain = match js::json_parse(&text) {
        Ok(v) => v,
        Err(msg) => return failed("plugins", &format!("SyntaxError: {msg}")),
    };
    let Ok(twin) = db_agents::json_parse(&text) else {
        return thrown();
    };
    // `!body?.scope || !SCOPES.includes(body.scope)`
    let Some(scope) = plain
        .get("scope")
        .and_then(Value::as_str)
        .and_then(Scope::parse)
    else {
        return error(StatusCode::BAD_REQUEST, "invalid scope");
    };
    // `resolveTrustedCwd(body.cwd)`: anything but a string is no input.
    let Some(cwd) = trusted_cwd::resolve_trusted_cwd(plain.get("cwd").and_then(Value::as_str))
    else {
        return error(StatusCode::BAD_REQUEST, "unknown cwd");
    };
    apply_post(&plain, &twin, scope, &cwd)
}

/// What a settings write answers: `{ok: true}`; a scope file that doesn't
/// load (`SettingsParseError`) is the 422 naming it; any other throw is the
/// empty 500.
fn written(r: Result<(), PluginsError>) -> Response {
    match r {
        Ok(()) => ok(),
        Err(PluginsError::Settings(SettingsError::Parse { path, reason })) => error(
            StatusCode::UNPROCESSABLE_ENTITY,
            &plugins::plugin_settings_write_blocked_message(&path, &reason),
        ),
        Err(e) => failed("plugins", &e),
    }
}

/// `applyPost(body, cwd)`.
fn apply_post(plain: &Value, twin: &Value, scope: Scope, cwd: &str) -> Response {
    let text = |k: &str| plain.get(k).and_then(Value::as_str);
    let truthy = |k: &str| twin.get(k).is_some_and(js::truthy);
    match text("kind") {
        Some("toggle") => {
            let Some(plugin_id) = twin.get("pluginId").filter(|v| js::truthy(v)) else {
                return error(StatusCode::BAD_REQUEST, "pluginId required");
            };
            written(plugins::set_enabled(
                scope,
                cwd,
                plugin_id,
                truthy("enabled"),
            ))
        }
        Some("marketplaces") => match text("op") {
            Some("add-extra") => {
                let (Some(name), true) = (text("name"), truthy("source")) else {
                    return error(StatusCode::BAD_REQUEST, "name and source required");
                };
                match plugins::add_extra_marketplace(scope, cwd, name, &plain["source"]) {
                    Ok(Err(why)) => error(StatusCode::BAD_REQUEST, &why),
                    r => written(r.map(|_| ())),
                }
            }
            Some("remove-extra") => {
                let Some(name) = text("name") else {
                    return error(StatusCode::BAD_REQUEST, "name required");
                };
                written(plugins::remove_extra_marketplace(scope, cwd, name))
            }
            Some("remove-policy") => {
                let list = match text("list") {
                    Some("strict") => Some(PolicyList::Strict),
                    Some("blocked") => Some(PolicyList::Blocked),
                    _ => None,
                };
                // `typeof body.index === "number"`, Infinity included.
                let index = match plain.get("index") {
                    Some(Value::Number(n)) => n.as_f64(),
                    Some(Value::Null) => twin.get("index").and_then(db_agents::infinity),
                    _ => None,
                };
                let (Some(list), Some(index)) = (list, index) else {
                    return error(StatusCode::BAD_REQUEST, "list and index required");
                };
                written(plugins::remove_policy_marketplace_entry(
                    scope, cwd, list, index,
                ))
            }
            _ => error(StatusCode::BAD_REQUEST, "invalid op"),
        },
        Some("plugin-config") => {
            let (Some(plugin_id), Some(name)) = (text("pluginId"), text("name")) else {
                return error(StatusCode::BAD_REQUEST, "pluginId and name required");
            };
            written(plugins::set_plugin_option_value(
                scope,
                cwd,
                plugin_id,
                name,
                plain.get("value"),
            ))
        }
        _ => error(StatusCode::BAD_REQUEST, "invalid kind"),
    }
}

/// `GET /api/plugins/available`.
async fn available() -> Response {
    match plugins::list_available() {
        Ok(list) => json_text(StatusCode::OK, &json!({ "plugins": list })),
        Err(e) => failed("plugins/available", &e),
    }
}

/// `POST /api/plugins/reload`.
async fn reload(State(app): State<AppState>, RawQuery(query): RawQuery) -> Response {
    let q = query.as_deref();
    let Some(id) = search_param(q, "sessionId").filter(|id| !id.is_empty()) else {
        return error(StatusCode::BAD_REQUEST, "sessionId required");
    };
    let Some(s) = app.mgr.get(&id) else {
        return error(StatusCode::NOT_FOUND, "session not found");
    };
    let force = plugins::is_force_reload(search_param(q, "force").as_deref());
    match s.reload_plugins(!force).await {
        Ok(data) => json_text(StatusCode::OK, &data),
        Err(e) => error(StatusCode::INTERNAL_SERVER_ERROR, &e),
    }
}
