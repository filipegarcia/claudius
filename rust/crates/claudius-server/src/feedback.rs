//! `POST/GET /api/feedback`: port of `app/api/feedback/route.ts`, the
//! session-quality survey's submit ([`claudius_core::feedback_store`],
//! `Session::submit_feedback`).
//!
//! POST reads the body as `req.json().catch(() => null)` and only through
//! `body?.x`: `comment` (a string, JS-trimmed), `rating` (`"up"` / `"down"`
//! exactly), `sessionId`, `surface` (a string, else `"claudius"`) and
//! `attachTranscript` (`=== true`). With neither a comment nor a rating it
//! is 400 `empty feedback`; a `sessionId` that isn't a live session's is 409
//! `session-unavailable` (nothing is stored: the per-cwd database comes from
//! the session). Otherwise the verdict-tagged text goes to the CLI, a row
//! is written whatever the CLI said (a failed write is swallowed, and the
//! answer still says `stored: true`), and the answer carries `forwarded`,
//! plus the CLI's refusal `reason` when it gave one.
//!
//! GET lists the newest rows of a live session's cwd: `limit` is
//! `Number(limit)`, 100 unless finite and above 0, capped at 500, and bound
//! as that JS number, so a fractional one fails the query (Next's empty
//! 500, as for a missing table). An unknown session is 404.

use axum::Router;
use axum::body::Bytes;
use axum::extract::{RawQuery, State};
use axum::http::{StatusCode, header};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use claudius_agent::js;
use claudius_core::feedback_store::{self, FeedbackRecord};
use claudius_core::{log, now_ms};
use serde_json::{Value, json};

use crate::AppState;
use crate::body::{JsonBody, thrown};
use crate::session_transcript::search_param;

const ROUTE: &str = "api/feedback";

pub fn router() -> Router<AppState> {
    Router::new().route("/api/feedback", get(list).post(submit))
}

fn json_text(status: StatusCode, body: &Value) -> Response {
    (
        status,
        [(header::CONTENT_TYPE, "application/json")],
        js::stringify(body),
    )
        .into_response()
}

/// `forwardText(rating, comment)`: the verdict as a tag in front of the
/// comment (`submitFeedback` takes only a description), JS-trimmed.
fn forward_text(rating: Option<&str>, comment: &str) -> String {
    let tag = match rating {
        Some("up") => "[+1] ",
        Some("down") => "[-1] ",
        _ => "",
    };
    js::trim(&format!("{tag}{comment}")).to_owned()
}

async fn submit(State(app): State<AppState>, body: Bytes) -> Response {
    // `await req.json().catch(() => null)`: every read below is `body?.x`.
    let b = JsonBody::parse_or_message(&body).unwrap_or(Value::Null);
    let comment = match &b["comment"] {
        Value::String(s) => js::trim(s).to_owned(),
        _ => String::new(),
    };
    let rating = match &b["rating"] {
        Value::String(s) if s == "up" || s == "down" => Some(s.clone()),
        _ => None,
    };
    if comment.is_empty() && rating.is_none() {
        return json_text(StatusCode::BAD_REQUEST, &json!({"error": "empty feedback"}));
    }
    let surface = match &b["surface"] {
        Value::String(s) => s.clone(),
        _ => "claudius".to_owned(),
    };
    let attach_transcript = b["attachTranscript"] == Value::Bool(true);
    let session = b["sessionId"]
        .as_str()
        .filter(|id| !id.is_empty())
        .and_then(|id| app.mgr.get(id));
    let Some(session) = session else {
        return json_text(
            StatusCode::CONFLICT,
            &json!({"ok": false, "stored": false, "forwarded": false, "reason": "session-unavailable"}),
        );
    };
    let r = session
        .submit_feedback(
            &forward_text(rating.as_deref(), &comment),
            Some(&surface),
            attach_transcript,
        )
        .await;
    let record = FeedbackRecord {
        id: uuid::Uuid::new_v4().to_string(),
        session_id: Some(session.id.clone()),
        rating,
        comment,
        surface: Some(surface),
        forwarded: r.forwarded,
        attach_transcript,
        created_at: now_ms() as f64,
    };
    let cwd = session.cwd.clone();
    // `insertFeedback(…).catch(() => {})`: best effort, never the answer.
    match tokio::task::spawn_blocking(move || feedback_store::insert_feedback(&cwd, &record)).await
    {
        Ok(Ok(())) => {}
        Ok(Err(e)) => tracing::debug!(target: log::API, "[{ROUTE}] insertFeedback: {e}"),
        Err(e) => tracing::debug!(target: log::API, "[{ROUTE}] insertFeedback: {e}"),
    }
    let mut out = json!({"ok": true, "stored": true, "forwarded": r.forwarded});
    if let (false, Some(reason)) = (r.forwarded, r.reason) {
        out["reason"] = Value::String(reason);
    }
    json_text(StatusCode::OK, &out)
}

async fn list(State(app): State<AppState>, RawQuery(raw): RawQuery) -> Response {
    let raw = raw.as_deref();
    let session = search_param(raw, "sessionId")
        .filter(|id| !id.is_empty())
        .and_then(|id| app.mgr.get(&id));
    let Some(session) = session else {
        return json_text(
            StatusCode::NOT_FOUND,
            &json!({"error": "session not found"}),
        );
    };
    // `Number(url.searchParams.get("limit"))`: `Number(null)` is 0.
    let limit_raw = search_param(raw, "limit").map_or(0.0, |s| js::to_number(&s));
    let limit = if limit_raw.is_finite() && limit_raw > 0.0 {
        limit_raw.min(500.0)
    } else {
        100.0
    };
    let cwd = session.cwd.clone();
    match tokio::task::spawn_blocking(move || feedback_store::list_feedback(&cwd, limit)).await {
        Ok(Ok(items)) => json_text(StatusCode::OK, &json!({"ok": true, "items": items})),
        Ok(Err(e)) => {
            tracing::error!(target: log::API, "[{ROUTE}] {e}");
            thrown()
        }
        Err(e) => {
            tracing::error!(target: log::API, "[{ROUTE}] {e}");
            thrown()
        }
    }
}
