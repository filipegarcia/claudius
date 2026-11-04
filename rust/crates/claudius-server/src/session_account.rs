//! `GET/POST /api/sessions/:id/account`: port of
//! `app/api/sessions/[id]/account/route.ts`, the account switcher's surface
//! for one live session (S30).
//!
//! - `GET`: `{account}`, the profile the session runs under
//!   (`{id, label, driftFromActive?}`), or `null` when it runs on the
//!   ambient environment.
//! - `POST`: re-pin the session to the active profile
//!   ([`claudius_core::account_pinning::move_to_active_account`]), then
//!   rebuild it in place under the same id so the new credential takes
//!   effect (`restart_in_place`): `{ok: true, account: {id, label},
//!   restarted}`, where `restarted: false` means the session was reaped in
//!   between (it picks the pin up at its next resume). 400 `no active account
//!   profile configured` when no profile is active; the request body is
//!   ignored.
//!
//! Both answer 404 `session not found` for an id that isn't live (no resume,
//! as TS's `sessionManager.get`). A store that can't be read, a pin that
//! can't be written or a rebuild whose start fails is Next's empty 500,
//! logged as `[api/sessions/account] <message>`.

use axum::Router;
use axum::extract::{Path, State};
use axum::http::{StatusCode, header};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use claudius_agent::js;
use claudius_core::account_pinning::move_to_active_account;
use claudius_core::accounts::AccountsStore;
use claudius_core::log;
use claudius_core::session_manager::RecoverError;
use serde_json::{Value, json};

use crate::AppState;
use crate::body::thrown;

pub fn router() -> Router<AppState> {
    Router::new().route(
        "/api/sessions/{id}/account",
        get(get_account).post(post_account),
    )
}

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

fn failed(message: &str) -> Response {
    tracing::error!(target: log::API, "[api/sessions/account] {message}");
    thrown()
}

async fn get_account(State(app): State<AppState>, Path(id): Path<String>) -> Response {
    let Some(session) = app.mgr.get(&id) else {
        return not_found();
    };
    let account = session.account_pin().account_json().unwrap_or(Value::Null);
    json_text(StatusCode::OK, &json!({"account": account}))
}

async fn post_account(State(app): State<AppState>, Path(id): Path<String>) -> Response {
    let Some(session) = app.mgr.get(&id) else {
        return not_found();
    };
    let store = AccountsStore::from_env();
    let moved = match move_to_active_account(&store, &session.cwd, &session.id) {
        Ok(Some(moved)) => moved,
        Ok(None) => {
            return json_text(
                StatusCode::BAD_REQUEST,
                &json!({"error": "no active account profile configured"}),
            );
        }
        Err(e) => return failed(&e),
    };
    drop(session);
    let restarted = match app.mgr.restart_in_place(&id).await {
        Ok(()) => true,
        Err(RecoverError::Gone) => false,
        Err(e) => return failed(&e.to_string()),
    };
    json_text(
        StatusCode::OK,
        &json!({
            "ok": true,
            "account": {"id": moved.id(), "label": moved.label()},
            "restarted": restarted,
        }),
    )
}
