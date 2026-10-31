//! `/api/models` and `/api/models/probe`: ports of `app/api/models/route.ts`
//! and `app/api/models/probe/route.ts` (GET), over
//! [`claudius_core::models`].
//!
//! * `GET /api/models`: the model list for pickers without a session (the
//!   workspace form, the Settings page). The first live session, oldest
//!   first, whose `supportedModels()` is a non-empty array and survives the
//!   user's `modelPicker` curation answers it (`source: "session"`);
//!   otherwise the curated static list (`source: "fallback"`). A curation
//!   that throws on the fallback is Next's empty 500.
//! * `GET /api/models/probe`: one single-turn query per pinned model, all at
//!   once, each answering whether that model replied.

use axum::Router;
use axum::extract::State;
use axum::http::{StatusCode, header};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use claudius_agent::js;
use claudius_core::log;
use claudius_core::models::{self as core_models, apply_model_picker_curation, static_fallback};
use claudius_core::settings::{self, Scope};
use serde_json::{Value, json};

use crate::AppState;
use crate::body::{replace_overflowing_numbers, thrown};

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/api/models", get(list))
        .route("/api/models/probe", get(probe))
}

/// `NextResponse.json(body)`.
fn json_text(body: &Value) -> Response {
    (
        StatusCode::OK,
        [(header::CONTENT_TYPE, "application/json")],
        js::stringify(body),
    )
        .into_response()
}

/// `readSettings("user", cwd).then((s) => s.modelPicker).catch(() => undefined)`:
/// `homedir()/.claude/settings.json` read as `fs.readFile(p, "utf8")` and
/// `JSON.parse` read it. Anything that doesn't load (missing, unreadable,
/// not JSON, a `null` file) is `None`, and so is a file without the key.
///
/// A number literal past f64 range (±Infinity in JS) reads as `1`: the
/// curation only tells a number from a string or nullish, and never prints
/// one.
pub(crate) fn user_model_picker() -> Option<Value> {
    let bytes = std::fs::read(settings::path_for(Scope::User, "")).ok()?;
    let text = String::from_utf8_lossy(&bytes);
    let text = replace_overflowing_numbers(&text, "1").map_or(text, Into::into);
    match js::json_parse(&text).ok()? {
        Value::Object(mut m) => m.shift_remove("modelPicker"),
        _ => None,
    }
}

/// `GET /api/models`.
async fn list(State(app): State<AppState>) -> Response {
    let picker = user_model_picker();
    for s in app.mgr.list() {
        let Some(q) = s.query_handle() else {
            continue;
        };
        // A query that fails, a list that isn't a non-empty array, or one the
        // curation throws on: try the next session.
        let Ok(Value::Array(models)) = q.supported_models().await else {
            continue;
        };
        if models.is_empty() {
            continue;
        }
        if let Ok(models) = apply_model_picker_curation(models, picker.as_ref()) {
            return json_text(&json!({"models": models, "source": "session"}));
        }
    }
    match apply_model_picker_curation(static_fallback(), picker.as_ref()) {
        Ok(models) => json_text(&json!({"models": models, "source": "fallback"})),
        Err(e) => {
            tracing::error!(target: log::API, "[api/models] GET failed: TypeError: {e}");
            thrown()
        }
    }
}

/// `GET /api/models/probe`, on the CLI the sessions use.
async fn probe(State(app): State<AppState>) -> Response {
    let claude_bin = app.mgr.runtime.lock().unwrap().claude_bin.clone();
    let results = core_models::probe_all(claude_bin).await;
    json_text(&json!({"results": results}))
}
