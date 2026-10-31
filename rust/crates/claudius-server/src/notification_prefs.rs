//! `GET/POST /api/sessions/:id/notification-prefs`: port of
//! `app/api/sessions/[id]/notification-prefs/route.ts`, the per-session
//! block / snooze switch behind the chat's notify menu
//! ([`claudius_core::notifications_db`]).
//!
//! Both resolve the session's cwd like the other disk-backed session routes
//! (the live session, else the transcript index), so a reaped session's
//! prefs stay editable; an unknown id is 404. Bodies are written with
//! `JSON.stringify`'s number format: a snooze that overflows past 2^53
//! prints as JS prints it (`60000001761562000000`, `9e+21`, `null` for
//! Infinity).

use axum::body::Bytes;
use axum::extract::{Path, State};
use axum::http::{StatusCode, header};
use axum::response::{IntoResponse, Response};
use claudius_agent::js;
use claudius_core::notifications_db::{
    self, PrefsPatch, SessionPrefs, get_session_prefs, set_session_prefs,
};
use claudius_core::{log, now_ms};
use serde_json::{Value, json};

use crate::AppState;
use crate::body::{JsonBody, js_member, thrown};
use crate::sessions::resolve_cwd;
use crate::tri;

fn json_text(status: StatusCode, body: &Value) -> Response {
    (
        status,
        [(header::CONTENT_TYPE, "application/json")],
        js::stringify(body),
    )
        .into_response()
}

fn not_found() -> Response {
    json_text(
        StatusCode::NOT_FOUND,
        &json!({"error": "session not found"}),
    )
}

/// A DB call that threw in TS: Next's empty 500.
fn failed(e: &anyhow::Error) -> Response {
    tracing::error!(target: log::API, "[api/sessions/notification-prefs] {e}");
    thrown()
}

pub async fn get(State(app): State<AppState>, Path(id): Path<String>) -> Response {
    let Some(cwd) = resolve_cwd(&app, &id) else {
        return not_found();
    };
    match get_session_prefs(&cwd, &id) {
        Ok(prefs) => json_text(
            StatusCode::OK,
            &prefs.unwrap_or_else(|| SessionPrefs::unset(&id)).to_json(),
        ),
        Err(e) => failed(&e),
    }
}

pub async fn post(State(app): State<AppState>, Path(id): Path<String>, body: Bytes) -> Response {
    // `await req.json().catch(() => ({}))`, before the lookup. `1e400` is
    // Infinity there; a string stand-in fails `Number.isFinite` the same way.
    let b = JsonBody::lenient_overflow(&body, json!({}), &json!("Infinity"));
    let Some(cwd) = resolve_cwd(&app, &id) else {
        return not_found();
    };
    let mut patch = PrefsPatch::default();
    // `body.blocked` (no `?.`): a `null` body throws here.
    if let Some(Value::Bool(blocked)) = tri!(js_member(&b, "blocked")) {
        patch.blocked = Some(*blocked);
    }
    match tri!(js_member(&b, "snoozeMinutes")) {
        None => {}
        Some(Value::Null) => patch.snooze_until = Some(None),
        // `Number.isFinite(m) && m > 0`: a JSON number is always finite here
        // (an overflowing literal arrives as the string stand-in).
        Some(v) => match v.as_f64().filter(|m| *m > 0.0) {
            Some(m) => {
                let until = notifications_db::snooze_until(now_ms() as f64, m);
                patch.snooze_until = Some(Some(until));
            }
            None => {
                return json_text(
                    StatusCode::BAD_REQUEST,
                    &json!({"error": "invalid snoozeMinutes"}),
                );
            }
        },
    }
    match set_session_prefs(&cwd, &id, &patch) {
        Ok(prefs) => json_text(StatusCode::OK, &prefs.to_json()),
        Err(e) => failed(&e),
    }
}
