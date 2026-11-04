//! The Customize-wide routes (D16): `GET`/`PUT /api/customize-settings`
//! (port of `app/api/customize-settings/route.ts`, over
//! [`claudius_core::customize_settings`]) and `GET /api/customize/runtime`
//! (port of `app/api/customize/runtime/route.ts`, over
//! [`claudius_core::customize_runtime`]).
//!
//! * `GET customize-settings`: `{autoFixPrompt, defaults: {autoFixPrompt}}`
//!   (the stored prompt, or the default, then the default).
//! * `PUT customize-settings`: the body is `await req.json()` with nothing
//!   catching it, so an empty or malformed body, or a `null` one (`body.
//!   autoFixPrompt` throws), is Next's empty 500. A body whose
//!   `autoFixPrompt` isn't a string is 400 `autoFixPrompt (string) required`;
//!   otherwise the prompt is saved as given (blank included) and the saved
//!   settings are the answer.
//! * `GET customize/runtime`: `{isPreview: false}` in the main install, or
//!   `{isPreview: true, customizationId, name}` in a preview. The live
//!   source is this process's ([`claudius_core::runtime_dir`]), so the
//!   answer is about the Rust front door, which never runs inside a mirror
//!   unless `CLAUDIUS_LIVE_SOURCE` says so.
//!
//! What the TS lets throw (a settings file that can't be read or parsed, or
//! is `null`; a folder or file that can't be written) is logged as
//! `[api/<route>] <message>` and answered with Next's empty 500. Strings are
//! JS strings: lone-surrogate escapes in the body or the files are kept and
//! written back as `\udXXX` escapes. Replayed by `tests/customize.rs`
//! against `rust/scripts/customize-golden.mjs`.

use axum::Router;
use axum::body::Bytes;
use axum::http::StatusCode;
use axum::response::Response;
use axum::routing::get;
use claudius_core::customize_settings::{self, AUTO_FIX_PROMPT, DEFAULT_AUTO_FIX_PROMPT};
use claudius_core::{customize_runtime, js_string, log};
use serde_json::{Map, Value, json};

use crate::AppState;
use crate::body::{JsonBody, thrown};
use crate::workspaces::json_text;

pub fn router() -> Router<AppState> {
    Router::new()
        .route(
            "/api/customize-settings",
            get(get_settings).put(put_settings),
        )
        .route("/api/customize/runtime", get(runtime))
}

/// What the TS let throw: logged, then Next's empty 500.
fn failed(route: &str, e: impl std::fmt::Display) -> Response {
    tracing::error!(target: log::API, "[api/{route}] {e}");
    thrown()
}

async fn get_settings() -> Response {
    match tokio::task::spawn_blocking(customize_settings::get_settings).await {
        Ok(Ok(mut settings)) => {
            // `{...settings, defaults: {autoFixPrompt: DEFAULT_AUTO_FIX_PROMPT}}`.
            settings.insert(
                "defaults".into(),
                json!({AUTO_FIX_PROMPT: DEFAULT_AUTO_FIX_PROMPT}),
            );
            json_text(StatusCode::OK, &Value::Object(settings))
        }
        Ok(Err(e)) => failed("customize-settings", e),
        Err(e) => failed("customize-settings", e),
    }
}

async fn put_settings(body: Bytes) -> Response {
    // `await req.json()`: `Body.json()`'s text, lone surrogates kept.
    let body = match js_string::parse(&JsonBody::text(&body)) {
        Ok(b) => b,
        Err(e) => return failed("customize-settings", e),
    };
    // `body.autoFixPrompt`, no `?.`.
    let prompt = match &body {
        Value::Null => {
            return failed(
                "customize-settings",
                format!("Cannot read properties of null (reading '{AUTO_FIX_PROMPT}')"),
            );
        }
        Value::Object(m) => m.get(AUTO_FIX_PROMPT),
        _ => None,
    };
    let Some(Value::String(prompt)) = prompt else {
        return json_text(
            StatusCode::BAD_REQUEST,
            &json!({"error": "autoFixPrompt (string) required"}),
        );
    };
    let mut patch = Map::new();
    patch.insert(AUTO_FIX_PROMPT.into(), Value::String(prompt.clone()));
    match tokio::task::spawn_blocking(move || customize_settings::set_settings(&patch)).await {
        Ok(Ok(next)) => json_text(StatusCode::OK, &Value::Object(next)),
        Ok(Err(e)) => failed("customize-settings", e),
        Err(e) => failed("customize-settings", e),
    }
}

async fn runtime() -> Response {
    match tokio::task::spawn_blocking(customize_runtime::runtime_info).await {
        Ok(info) => json_text(StatusCode::OK, &info),
        Err(e) => failed("customize/runtime", e),
    }
}
