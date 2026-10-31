//! `GET/PUT/DELETE /api/splash-examples`: port of
//! `app/api/splash-examples/route.ts`, the chat splash screen's suggestion
//! chips and greeting-name override ([`claudius_core::splash_examples`])
//! with the account-derived fallback name
//! ([`claudius_core::splash_fallback_name`]).
//!
//! Every method scopes to the active context's cwd
//! ([`resolve_active_cwd`]: the `claudius.customization` cookie, else the
//! `claudius.workspace` cookie or the store's hint, else this process's
//! cwd), read from the request's cookies as Next's `RequestCookies` parses
//! them ([`request_cookies`]). The query string is ignored.
//!
//! - GET: `{examples, customized, defaults, limits, displayName: {override,
//!   fallback}}`. A cwd that isn't a string reads as nothing saved.
//! - PUT: `try { await req.json() } catch { 400 "invalid JSON" }`, then the
//!   cwd and the current chips are read (the read-only open makes the
//!   project dir), then `body.examples` (no `?.`: a `null` body throws
//!   there) is checked and saved, then `body.displayName`. So a bad name is
//!   a 400 after the chips were saved.
//! - DELETE: both rows go; the answer is the defaults and no override.
//!
//! A write that throws in TS (a cwd that isn't a string, a database that
//! won't open or has no usable `ui_state`) is Next's empty 500.
//!
//! Strings are JS strings: the body is read with lone-surrogate escapes kept
//! ([`js_string::parse`]), and the answer writes them back as `\udXXX`
//! escapes, as `JSON.stringify` does. Around the module, as Next answers an
//! app route: `vary` on every answer, HEAD runs GET without the body,
//! OPTIONS is 204 with `Allow`, POST/PATCH an empty 405 and any other method
//! an empty 400 ([`crate::heartbeat`]).

use std::borrow::Cow;

use axum::Router;
use axum::body::Bytes;
use axum::http::{HeaderMap, HeaderValue, StatusCode, header};
use axum::middleware::map_response;
use axum::response::{IntoResponse, Response};
use axum::routing::any;
use claudius_core::active_cwd::resolve_active_cwd;
use claudius_core::splash_examples::{
    self as splash, DEFAULT_SPLASH_EXAMPLES, JsString, SPLASH_DISPLAY_NAME_MAX_LEN,
    SPLASH_EXAMPLE_MAX_LEN, SPLASH_EXAMPLES_MAX, SplashExamples,
};
use claudius_core::splash_fallback_name::resolve_splash_fallback_name;
use claudius_core::{js_string, log};
use serde_json::{Value, json};

use crate::AppState;
use crate::body::{JsonBody, js_member, replace_overflowing_numbers, thrown};
use crate::heartbeat::{VARY, other_method};
use crate::tri;
use crate::workspaces::request_cookies;

pub fn router() -> Router<AppState> {
    Router::new()
        .route(
            "/api/splash-examples",
            any(other_method)
                .get(get_examples)
                .put(put_examples)
                .delete(delete_examples)
                .options(options),
        )
        .layer(map_response(with_vary))
}

const COOKIE_CUST: &str = "claudius.customization";
const COOKIE_WS: &str = "claudius.workspace";

/// What Next's `setVaryHeader` puts on every app route answer, thrown 500s
/// included.
async fn with_vary(mut res: Response) -> Response {
    res.headers_mut()
        .insert(header::VARY, HeaderValue::from_static(VARY));
    res
}

/// Next's automatic `OPTIONS` for a module exporting GET, PUT and DELETE.
async fn options() -> Response {
    (
        StatusCode::NO_CONTENT,
        [(header::ALLOW, "DELETE, GET, HEAD, OPTIONS, PUT")],
    )
        .into_response()
}

/// `NextResponse.json(body, {status})`, lone surrogates as escapes.
fn json_text(status: StatusCode, body: &Value) -> Response {
    (
        status,
        [(header::CONTENT_TYPE, "application/json")],
        js_string::stringify(body),
    )
        .into_response()
}

fn bad_request(error: &str) -> Response {
    json_text(StatusCode::BAD_REQUEST, &json!({"error": error}))
}

/// A write that threw in TS: Next's empty 500.
fn failed(e: &anyhow::Error) -> Response {
    tracing::error!(target: log::API, "[api/splash-examples] {e}");
    thrown()
}

/// `resolveActiveCwd().cwd` for this request; `openDb` takes only a string.
fn active_cwd(headers: &HeaderMap) -> Option<Value> {
    let cookies = request_cookies(headers);
    let cookie = |name: &str| {
        cookies
            .iter()
            .find(|(n, _)| n == name)
            .map(|(_, v)| v.as_str())
    };
    resolve_active_cwd(cookie(COOKIE_CUST), cookie(COOKIE_WS)).cwd
}

/// `openDb(cwd)` on a cwd that isn't a string rejects (uncaught in TS).
fn write_cwd(cwd: Option<&str>) -> anyhow::Result<&str> {
    cwd.ok_or_else(|| anyhow::anyhow!("the active cwd is not a string"))
}

/// The JS string as a Rust one, a lone surrogate as its stand-in.
fn js(s: &JsString) -> Value {
    Value::String(js_string::from_units(s.units()))
}

fn js_list(items: &[JsString]) -> Value {
    Value::Array(items.iter().map(js).collect())
}

/// `getSplashExamples(cwd)`; its read-only open fails on a non-string cwd,
/// which it catches: the defaults.
fn read_examples(cwd: Option<&str>) -> SplashExamples {
    cwd.map_or_else(SplashExamples::defaults, splash::get_splash_examples)
}

/// `{override, fallback}`.
fn display_name(over: Option<&JsString>) -> Value {
    json!({
        "override": over.map(js),
        "fallback": resolve_splash_fallback_name(),
    })
}

/// `await req.json()`, or `None` where it throws. Lone-surrogate escapes
/// are kept (stand-ins), and a number past f64 (Infinity in JS) is `false`,
/// which every check here treats as it treats Infinity (not an array, not
/// null, not a string). Nesting past serde_json's 127 levels is `None`
/// where V8 parses it.
fn parse_body(bytes: &[u8]) -> Option<Value> {
    let text = JsonBody::text(bytes);
    // Only a valid number literal is replaced, so the text stays as valid
    // (or not) as V8 finds it; `js_string::parse` runs V8's check.
    let text = match replace_overflowing_numbers(&text, "false") {
        Some(replaced) => Cow::Owned(replaced),
        None => text,
    };
    js_string::parse(&text).ok()
}

async fn get_examples(headers: HeaderMap) -> Response {
    let cwd = active_cwd(&headers);
    let cwd = cwd.as_ref().and_then(Value::as_str);
    let current = read_examples(cwd);
    let over = cwd.and_then(splash::get_splash_display_name);
    json_text(
        StatusCode::OK,
        &json!({
            "examples": js_list(&current.examples),
            "customized": current.customized,
            "defaults": DEFAULT_SPLASH_EXAMPLES,
            "limits": {
                "maxLen": SPLASH_EXAMPLE_MAX_LEN,
                "maxCount": SPLASH_EXAMPLES_MAX,
                "nameMaxLen": SPLASH_DISPLAY_NAME_MAX_LEN,
            },
            "displayName": display_name(over.as_ref()),
        }),
    )
}

async fn put_examples(headers: HeaderMap, body: Bytes) -> Response {
    let Some(b) = parse_body(&body) else {
        return bad_request("invalid JSON");
    };
    let cwd = active_cwd(&headers);
    let cwd = cwd.as_ref().and_then(Value::as_str);
    let SplashExamples {
        mut examples,
        mut customized,
    } = read_examples(cwd);
    if let Some(given) = tri!(js_member(&b, "examples")) {
        let Value::Array(items) = given else {
            return bad_request("examples must be an array of strings");
        };
        // TS drops the non-strings here too; `setSplashExamples` skips them.
        examples = match write_cwd(cwd).and_then(|c| splash::set_splash_examples(c, items)) {
            Ok(saved) => saved,
            Err(e) => return failed(&e),
        };
        customized = true;
    }
    let over = match tri!(js_member(&b, "displayName")) {
        Some(given) => {
            let name = match given {
                Value::Null => None,
                Value::String(s) => Some(s.as_str()),
                _ => return bad_request("displayName must be a string or null"),
            };
            match write_cwd(cwd).and_then(|c| splash::set_splash_display_name(c, name)) {
                Ok(saved) => saved,
                Err(e) => return failed(&e),
            }
        }
        None => cwd.and_then(splash::get_splash_display_name),
    };
    json_text(
        StatusCode::OK,
        &json!({
            "examples": js_list(&examples),
            "customized": customized,
            "displayName": display_name(over.as_ref()),
        }),
    )
}

async fn delete_examples(headers: HeaderMap) -> Response {
    let cwd = active_cwd(&headers);
    let cwd = cwd.as_ref().and_then(Value::as_str);
    // `Promise.all([reset, setName(null)])`: both run, the first failure wins.
    let reset = write_cwd(cwd).and_then(splash::reset_splash_examples);
    let clear = write_cwd(cwd).and_then(|c| splash::set_splash_display_name(c, None));
    if let Err(e) = reset.and(clear) {
        return failed(&e);
    }
    json_text(
        StatusCode::OK,
        &json!({
            "examples": DEFAULT_SPLASH_EXAMPLES,
            "customized": false,
            "displayName": display_name(None),
        }),
    )
}
