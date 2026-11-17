//! The customization store's routes: port of `app/api/customizations/route.ts`
//! (GET; its POST, the bootstrap, is [`crate::customization_actions`], D14),
//! `[id]/route.ts` (GET/PATCH/DELETE), `[id]/select/route.ts` (POST),
//! `[id]/publishes/route.ts` (GET) and `[id]/diff/route.ts` (GET), over
//! [`claudius_core::customizations`].
//!
//! Anything the TS lets throw (an unreadable or `null` index, a store entry
//! that is `null`, a `null` PATCH body) is Next's bare 500. Every answer is
//! `JSON.stringify` of the TS value ([`js_string::stringify`]).
//!
//! `select` writes the `claudius.customization` cookie and deletes
//! `claudius.workspace` (the two are exclusive), serialized and ordered as
//! Next's `ResponseCookies` sends them ([`crate::workspaces`]); a missing
//! customization deletes the customization cookie.
//!
//! `DELETE` stops the customization's preview first
//! ([`claudius_core::preview_server::stop_preview`], D15), while the record
//! still exists.
//!
//! Path safety: `DELETE` removes `<root>/<id>` and `diff` walks
//! `<root>/<id>/src` only when that is strictly inside the customizations
//! root ([`claudius_core::customizations::Store`]). TS removes or walks
//! whatever an id like `../x` or `x/..` names; here the removal is skipped
//! (logged, the record still goes) and the diff answers 403.

use std::borrow::Cow;

use axum::Router;
use axum::body::Bytes;
use axum::extract::Path;
use axum::http::{HeaderMap, StatusCode};
use axum::response::Response;
use axum::routing::{get, post};
use claudius_agent::js;
use claudius_core::customizations::{DiffError, Store};
use claudius_core::{js_string, log, now_ms, preview_server, runtime_dir};
use serde_json::{Map, Value, json};

use crate::AppState;
use crate::body::{JsonBody, js_member, replace_overflowing_numbers, thrown};
use crate::tri;
use crate::workspaces::{
    COOKIE, COOKIE_CUST, MAX_AGE, deleted_cookie, in_next_order, json_text, utc_string,
    with_cookies,
};

pub fn router() -> Router<AppState> {
    Router::new()
        // POST is the bootstrap (D14's module).
        .route(
            "/api/customizations",
            get(list).post(crate::customization_actions::bootstrap),
        )
        .route(
            "/api/customizations/{id}",
            get(get_one).patch(patch_one).delete(delete_one),
        )
        .route("/api/customizations/{id}/select", post(select))
        .route("/api/customizations/{id}/publishes", get(publishes))
        .route("/api/customizations/{id}/diff", get(diff))
}

fn error(status: StatusCode, msg: &str) -> Response {
    json_text(status, &json!({"error": msg}))
}

/// What the TS let throw: Next's empty 500.
fn failed(route: &str, e: impl std::fmt::Display) -> Response {
    tracing::error!(target: log::API, "[api/customizations{route}] {e:#}");
    thrown()
}

/// `const c = await getCustomization(id); if (!c) return 404`.
fn existing(store: &Store, id: &str, route: &str) -> Result<Value, Box<Response>> {
    match store.get_customization(id) {
        Ok(Some(c)) => Ok(c),
        Ok(None) => Err(Box::new(error(StatusCode::NOT_FOUND, "not found"))),
        Err(e) => Err(Box::new(failed(route, e))),
    }
}

// ---- /api/customizations ------------------------------------------------------

async fn list() -> Response {
    let store = Store::from_env();
    let customizations = match store.list_customizations() {
        Ok(c) => c,
        Err(e) => return failed("", e),
    };
    let publishes = match store.list_publishes(None) {
        Ok(p) => p,
        Err(e) => return failed("", e),
    };
    json_text(
        StatusCode::OK,
        &json!({"customizations": customizations, "publishes": publishes}),
    )
}

// ---- /api/customizations/:id ------------------------------------------------------

async fn get_one(Path(id): Path<String>) -> Response {
    match existing(&Store::from_env(), &id, "/[id]") {
        Ok(c) => json_text(StatusCode::OK, &c),
        Err(r) => *r,
    }
}

/// `try { body = await req.json() } catch { return 400 }`: the text
/// `Body.json()` parses, lone surrogates kept; a number past the f64 range
/// (JS ±Infinity, never a string) reads as `0`.
pub(crate) fn patch_body(bytes: &[u8]) -> Option<Value> {
    let text = JsonBody::text(bytes);
    let text = replace_overflowing_numbers(&text, "0").map_or(text, Cow::Owned);
    js_string::parse(&text).ok()
}

async fn patch_one(Path(id): Path<String>, body: Bytes) -> Response {
    let store = Store::from_env();
    if let Err(r) = existing(&store, &id, "/[id]") {
        return *r;
    }
    let Some(b) = patch_body(&body) else {
        return error(StatusCode::BAD_REQUEST, "invalid body");
    };
    // `typeof body.name === "string"` (no `?.`: a `null` body throws).
    let mut patch = Map::new();
    if let Some(Value::String(name)) = tri!(js_member(&b, "name")) {
        let trimmed = js::trim(name);
        if trimmed.is_empty() {
            return error(StatusCode::BAD_REQUEST, "name cannot be empty");
        }
        patch.insert("name".into(), json!(trimmed));
    }
    if patch.is_empty() {
        return error(StatusCode::BAD_REQUEST, "no fields to update");
    }
    match store.update_customization_record(&id, &Value::Object(patch)) {
        Ok(updated) => json_text(StatusCode::OK, &updated.unwrap_or(Value::Null)),
        Err(e) => failed("/[id]", e),
    }
}

async fn delete_one(Path(id): Path<String>) -> Response {
    let store = Store::from_env();
    if let Err(r) = existing(&store, &id, "/[id]") {
        return *r;
    }
    // Deleting would strand an active publish's snapshot (and its revert).
    let publishes = match store.list_publishes(Some(&id)) {
        Ok(p) => p,
        Err(e) => return failed("/[id]", e),
    };
    let active = publishes
        .iter()
        .filter(|p| p.get("revertedAt").is_none_or(Value::is_null))
        .count();
    if active > 0 {
        let s = if active == 1 { "" } else { "es" };
        return error(
            StatusCode::CONFLICT,
            &format!("cannot delete: {active} active publish{s}. Revert first."),
        );
    }
    // `try { await stopPreview(id) } catch {}`: it never throws.
    preview_server::stop_preview(&id).await;
    if let Err(e) = store.remove_customization_dir(&id) {
        tracing::warn!(target: log::API, "[customizations] {e}");
    }
    if let Err(e) = store.delete_customization_record(&id) {
        return failed("/[id]", e);
    }
    json_text(StatusCode::OK, &json!({"ok": true}))
}

// ---- /api/customizations/:id/select -------------------------------------------------

async fn select(Path(id): Path<String>, headers: HeaderMap) -> Response {
    match Store::from_env().get_customization(&id) {
        Ok(Some(_)) => {}
        // `clearActiveCustomizationCookie()`.
        Ok(None) => {
            return with_cookies(
                error(StatusCode::NOT_FOUND, "not found"),
                vec![deleted_cookie(COOKIE_CUST)],
            );
        }
        Err(e) => return failed("/[id]/select", e),
    }
    // `writeActiveCustomizationCookie`: set (Max-Age plus the Expires Next
    // derives from it), then delete the workspace cookie.
    let Some(value) = js_string::encode_uri_component(&id) else {
        return failed("/[id]/select", "URIError: URI malformed");
    };
    let set = format!(
        "{COOKIE_CUST}={value}; Path=/; Expires={}; Max-Age={MAX_AGE}; SameSite=lax",
        utc_string(now_ms() + MAX_AGE * 1000)
    );
    let cookies = in_next_order(
        &headers,
        vec![(COOKIE_CUST, set), (COOKIE, deleted_cookie(COOKIE))],
    );
    with_cookies(
        json_text(StatusCode::OK, &json!({"ok": true, "id": id})),
        cookies,
    )
}

// ---- /api/customizations/:id/publishes and /diff ------------------------------------

async fn publishes(Path(id): Path<String>) -> Response {
    let store = Store::from_env();
    if let Err(r) = existing(&store, &id, "/[id]/publishes") {
        return *r;
    }
    match store.list_publishes(Some(&id)) {
        Ok(p) => json_text(StatusCode::OK, &json!({"publishes": p})),
        Err(e) => failed("/[id]/publishes", e),
    }
}

async fn diff(Path(id): Path<String>) -> Response {
    let store = Store::from_env();
    if let Err(r) = existing(&store, &id, "/[id]/diff") {
        return *r;
    }
    let live = runtime_dir::live_source_dir();
    let res = tokio::task::spawn_blocking(move || store.compute_diff(&id, &live)).await;
    match res {
        Ok(Ok(summary)) => json_text(StatusCode::OK, &summary),
        Ok(Err(DiffError::Fs(e))) => error(StatusCode::INTERNAL_SERVER_ERROR, &e.message),
        Ok(Err(DiffError::Outside)) => error(StatusCode::FORBIDDEN, "path outside allowed root"),
        Err(e) => failed("/[id]/diff", e),
    }
}
