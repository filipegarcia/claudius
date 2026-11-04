//! `GET /api/doctor` and `POST /api/doctor/fix`: ports of
//! `app/api/doctor/route.ts` and `app/api/doctor/fix/route.ts` over
//! [`claudius_core::doctor`] (D22).
//!
//! * `GET` answers the report (`{runtime, sdk, checks}`), read off this
//!   process: `paths::home_dir()` (which `CLAUDIUS_STATE_HOME` moves; TS:
//!   `homedir()`), the cwd, the env and `node` / `git` on `PATH`. What the
//!   TS throws (a `null` workspace entry, a non-string `rootPath`, a rule
//!   file that can't be read, an id that can't be a string) is Next's empty
//!   500, logged.
//! * `POST {id}` makes `~/.claude` (`claude-dir`) or `~/.claude/projects`
//!   (`projects-dir`), `mkdir -p` style: 200 `{ok, id, path}`, or 500
//!   `{ok: false, id, error}` with Node's message. A body `req.json()`
//!   can't parse is 400 `Invalid JSON body`; any other id 400 `Unknown or
//!   non-fixable check id` (see the core module for `Object.prototype`'s
//!   names).

use axum::Router;
use axum::body::Bytes;
use axum::http::{StatusCode, header};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use claudius_core::doctor::{self, FixAnswer, Host};
use claudius_core::{js_string, log, paths};
use serde_json::Value;

use crate::AppState;
use crate::body::{JsonBody, thrown};

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/api/doctor", get(report))
        .route("/api/doctor/fix", post(fix))
}

/// `NextResponse.json(body, {status})`.
fn json_text(status: StatusCode, body: &Value) -> Response {
    (
        status,
        [(header::CONTENT_TYPE, "application/json")],
        js_string::stringify(body),
    )
        .into_response()
}

async fn report() -> Response {
    match doctor::report(&Host::current()).await {
        Ok(body) => json_text(StatusCode::OK, &body),
        Err(e) => {
            tracing::error!(target: log::API, "[api/doctor] GET failed: {e}");
            thrown()
        }
    }
}

async fn fix(body: Bytes) -> Response {
    let home = paths::home_dir().to_string_lossy().into_owned();
    let parsed = JsonBody::parse_or_message(&body);
    let answer = tokio::task::spawn_blocking(move || doctor::fix(&home, parsed)).await;
    match answer {
        Ok(FixAnswer::Json(status, body)) => json_text(
            StatusCode::from_u16(status).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR),
            &body,
        ),
        Ok(FixAnswer::Thrown(e)) => {
            tracing::error!(target: log::API, "[api/doctor/fix] POST failed: {e}");
            thrown()
        }
        Err(e) => {
            tracing::error!(target: log::API, "[api/doctor/fix] POST failed: {e}");
            thrown()
        }
    }
}
