//! `GET/PUT /api/sessions/open-tabs`: port of
//! `app/api/sessions/open-tabs/route.ts`, the persisted session-tab strip
//! ([`claudius_core::open_tabs`]).
//!
//! Both scope to the active context's cwd ([`resolve_active_cwd`]: the
//! `claudius.customization` cookie, else the `claudius.workspace` cookie or
//! the store's hint, else this process's cwd), read from the request's
//! cookies as Next's `RequestCookies` parses them ([`request_cookies`]).
//!
//! GET returns `{tabs, activeId, labelMaxWidth, titles, pinned}`: the stored
//! values (nothing stored, or a cwd that isn't a string: `[]`, `null`, 180,
//! `{}`, `[]`), with each tab's trimmed title from the sessions table (the
//! `{cwd}:{id}` key, else `*:{id}`); a title lookup that throws leaves
//! `titles` empty. PUT checks and writes each present field in turn (`tabs`,
//! `activeId`, `pinned`, `labelMaxWidth`), so a bad later field is a 400
//! after the earlier ones were saved.
//!
//! Ids are JS strings: the body keeps lone-surrogate escapes
//! ([`JsonBody::parse_js_overflow`]), the rows store them as `JSON.stringify`
//! does, and the answer writes them back as `\udXXX` escapes.

use axum::Router;
use axum::body::Bytes;
use axum::http::{HeaderMap, StatusCode};
use axum::response::Response;
use axum::routing::get;
use claudius_agent::js;
use claudius_core::active_cwd::resolve_active_cwd;
use claudius_core::{js_num, log, open_tabs, sessions_db};
use serde_json::{Map, Value, json};

use crate::AppState;
use crate::body::{JsonBody, js_member, thrown};
use crate::tri;
use crate::workspaces::{COOKIE, COOKIE_CUST, cookie, json_text, request_cookies};

pub fn router() -> Router<AppState> {
    Router::new().route("/api/sessions/open-tabs", get(get_tabs).put(put_tabs))
}

fn bad_request(error: &str) -> Response {
    json_text(StatusCode::BAD_REQUEST, &json!({"error": error}))
}

/// A write that threw in TS: Next's empty 500.
fn failed(e: &anyhow::Error) -> Response {
    tracing::error!(target: log::API, "[api/sessions/open-tabs] {e}");
    thrown()
}

/// `resolveActiveCwd().cwd` for this request ([`resolve_active_cwd`]
/// passes over an empty cookie).
fn active_cwd(headers: &HeaderMap) -> Option<Value> {
    let cookies = request_cookies(headers);
    resolve_active_cwd(cookie(&cookies, COOKIE_CUST), cookie(&cookies, COOKIE)).cwd
}

fn strings(ids: &[String]) -> Value {
    Value::Array(ids.iter().cloned().map(Value::String).collect())
}

async fn get_tabs(headers: HeaderMap) -> Response {
    let cwd = active_cwd(&headers);
    // `openDb` rejects a cwd that isn't a string, which every getter
    // catches: the defaults.
    let (tabs, active_id, label_width, pinned) = match cwd.as_ref().and_then(Value::as_str) {
        Some(cwd) => (
            open_tabs::get_open_tabs(cwd),
            open_tabs::get_active_tab(cwd),
            open_tabs::get_tab_label_max_width(cwd),
            open_tabs::get_pinned_tabs(cwd),
        ),
        None => (Vec::new(), None, None, Vec::new()),
    };
    let mut titles = Map::new();
    // TS skips the lookup for an empty strip, which finds nothing anyway.
    if let Some(cwd) = cwd.as_ref().and_then(Value::as_str) {
        let pairs: Vec<(Option<&str>, &str)> =
            tabs.iter().map(|id| (Some(cwd), id.as_str())).collect();
        if let Ok(map) = sessions_db::get_session_titles_by_cwd(&pairs) {
            for id in &tabs {
                // Every title found trims to something.
                let Some(t) = map
                    .get(&format!("{cwd}:{id}"))
                    .or_else(|| map.get(&format!("*:{id}")))
                else {
                    continue;
                };
                // `out[id] = …` on a plain object: `__proto__` sets the
                // prototype (to nothing, for a string) instead of a key.
                if id != "__proto__" {
                    titles.insert(id.clone(), Value::String(js::trim(t).to_owned()));
                }
            }
        }
    }
    json_text(
        StatusCode::OK,
        &json!({
            "tabs": strings(&tabs),
            "activeId": active_id,
            "labelMaxWidth": js_num(label_width.unwrap_or(open_tabs::TAB_LABEL_DEFAULT)),
            "titles": titles,
            "pinned": strings(&pinned),
        }),
    )
}

/// `body.tabs.filter((x) => typeof x === "string")`.
fn string_items(items: &[Value]) -> Vec<&str> {
    items.iter().filter_map(Value::as_str).collect()
}

async fn put_tabs(headers: HeaderMap, body: Bytes) -> Response {
    // `try { body = await req.json() } catch { 400 }`. `1e400` is Infinity
    // there; `false` stands in for it, failing every check it fails.
    let Ok(b) = JsonBody::parse_js_overflow(&body, &Value::Bool(false)) else {
        return bad_request("invalid JSON");
    };
    let cwd = active_cwd(&headers);
    // `openDb(cwd)` on a cwd that isn't a string rejects, uncaught.
    let write_cwd = || -> anyhow::Result<&str> {
        cwd.as_ref()
            .and_then(Value::as_str)
            .ok_or_else(|| anyhow::anyhow!("absPath.replace is not a function"))
    };
    // `body.tabs` (no `?.`): a `null` body throws here.
    if let Some(tabs) = tri!(js_member(&b, "tabs")) {
        let Value::Array(items) = tabs else {
            return bad_request("tabs must be an array of strings");
        };
        if let Err(e) = write_cwd().and_then(|c| open_tabs::set_open_tabs(c, &string_items(items)))
        {
            return failed(&e);
        }
    }
    if let Some(active) = tri!(js_member(&b, "activeId")) {
        let id = match active {
            Value::Null => None,
            Value::String(s) => Some(s.as_str()),
            _ => return bad_request("activeId must be a string or null"),
        };
        if let Err(e) = write_cwd().and_then(|c| open_tabs::set_active_tab(c, id)) {
            return failed(&e);
        }
    }
    if let Some(pinned) = tri!(js_member(&b, "pinned")) {
        let Value::Array(items) = pinned else {
            return bad_request("pinned must be an array of strings");
        };
        if let Err(e) =
            write_cwd().and_then(|c| open_tabs::set_pinned_tabs(c, &string_items(items)))
        {
            return failed(&e);
        }
    }
    if let Some(width) = tri!(js_member(&b, "labelMaxWidth")) {
        // A JSON number is finite here (an overflowing one is the stand-in).
        let Some(width) = width.as_f64() else {
            return bad_request("labelMaxWidth must be a number");
        };
        if let Err(e) = write_cwd().and_then(|c| open_tabs::set_tab_label_max_width(c, width)) {
            return failed(&e);
        }
    }
    json_text(StatusCode::OK, &json!({"ok": true}))
}
