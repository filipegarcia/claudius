//! The disk-only session routes beside `/api/sessions/:id/*` (D19), ports
//! of `app/api/sessions/`:
//!
//! - `GET all` (`all/route.ts`): the SDK's listing plus the DB-only rows,
//!   with Claudius titles and account pins ([`sessions_all::list_all`]);
//!   `?dir=` scopes it, `?limit=` is `Number(…) || 200`. A throw from the
//!   rows or titles is `500 {error}`.
//! - `GET info/:id` (`info/[id]/route.ts`): `getSessionInfo`
//!   ([`sessions_store::info`]) or `404 {"error":"session not found"}`, with
//!   `claudiusTitle` when the session's cwd (else `?dir=`) has a truthy
//!   title through `getSessionTitle` (which opens the database read-write,
//!   so it creates and migrates it; a BLOB title is a `Buffer`; its errors
//!   read as no title).
//! - `GET export/:id` (`export/[id]/route.ts`): the plain-text export as an
//!   attachment named `claudius-session-<id>.txt` (written as latin1, as
//!   Node writes headers). Where the TS throws, in the export or because
//!   the id can't be a header byte string, `500 failed to export session`.
//! - `GET transcript/:id` (`transcript/[id]/route.ts`): `{messages}`, with
//!   system messages unless `?system=0`. Its reader never throws, so the
//!   TS `500 {error}` can't happen.
//! - `DELETE file/:id` (`file/[id]/route.ts`): `deleteSession`
//!   ([`sessions_store::remove`]): `{ok: true}`, or `500 {error}` with the
//!   SDK's message. Database rows and live sessions are left alone.
//!
//! None of them reads the live sessions (the TS doesn't either). Each runs
//! its disk and database work off the async runtime.

use axum::Router;
use axum::extract::{Path, RawQuery};
use axum::http::{HeaderValue, StatusCode, header};
use axum::response::{IntoResponse, Response};
use axum::routing::{delete, get};
use claudius_agent::js;
use claudius_core::{log, sessions_all, sessions_db, sessions_store};
use serde_json::{Value, json};

use crate::AppState;
use crate::body::thrown;
use crate::session_transcript::search_param;

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/api/sessions/all", get(all))
        .route("/api/sessions/info/{id}", get(info))
        .route("/api/sessions/export/{id}", get(export))
        .route("/api/sessions/transcript/{id}", get(transcript))
        .route("/api/sessions/file/{id}", delete(remove))
}

fn json_text(status: StatusCode, body: &Value) -> Response {
    (
        status,
        [(header::CONTENT_TYPE, "application/json")],
        js::stringify(body),
    )
        .into_response()
}

/// `searchParams.get("dir") || undefined`.
fn dir_param(query: Option<&str>) -> Option<String> {
    search_param(query, "dir").filter(|d| !d.is_empty())
}

/// `f` off the async runtime (`None`: it panicked, Next's empty 500).
async fn blocking<T: Send + 'static>(f: impl FnOnce() -> T + Send + 'static) -> Option<T> {
    tokio::task::spawn_blocking(f).await.ok()
}

async fn all(RawQuery(query): RawQuery) -> Response {
    let dir = dir_param(query.as_deref());
    let limit = sessions_all::limit_param(search_param(query.as_deref(), "limit").as_deref());
    match blocking(move || sessions_all::list_all(dir.as_deref(), limit)).await {
        Some(Ok(body)) => json_text(StatusCode::OK, &body),
        Some(Err(error)) => json_text(
            StatusCode::INTERNAL_SERVER_ERROR,
            &json!({ "error": error }),
        ),
        None => thrown(),
    }
}

async fn info(Path(id): Path<String>, RawQuery(query): RawQuery) -> Response {
    let dir = dir_param(query.as_deref());
    let found = blocking(move || {
        let meta = sessions_store::info(&id, dir.as_deref())?;
        let mut body = serde_json::to_value(&meta).ok()?;
        let cwd = meta.cwd.clone().or(dir).filter(|c| !c.is_empty());
        if let Some(cwd) = cwd
            && let Ok(Some(title)) = sessions_db::get_session_title_cell(&cwd, &id)
            && let Value::Object(m) = &mut body
        {
            m.insert("claudiusTitle".into(), title.to_json());
        }
        Some(body)
    })
    .await;
    match found {
        Some(Some(body)) => json_text(StatusCode::OK, &body),
        Some(None) => json_text(
            StatusCode::NOT_FOUND,
            &json!({ "error": "session not found" }),
        ),
        None => thrown(),
    }
}

/// `attachment; filename="claudius-session-<id>.txt"` as the bytes Node
/// writes, or `None` where `new Response(…, {headers})` (a ByteString: no
/// char past U+00FF, no NUL / CR / LF) or Node's header check (no other
/// control char) refuses it.
fn disposition(id: &str) -> Option<HeaderValue> {
    let value = format!("attachment; filename=\"claudius-session-{id}.txt\"");
    let bytes: Vec<u8> = value
        .chars()
        .map(|c| u8::try_from(u32::from(c)).ok())
        .collect::<Option<_>>()?;
    HeaderValue::from_bytes(&bytes).ok()
}

async fn export(Path(id): Path<String>, RawQuery(query): RawQuery) -> Response {
    let dir = dir_param(query.as_deref());
    let key = id.clone();
    let text = match blocking(move || sessions_store::export_plain_text(&key, dir.as_deref())).await
    {
        Some(text) => text,
        None => return thrown(),
    };
    match (text, disposition(&id)) {
        (Some(text), Some(disposition)) => (
            [
                (
                    header::CONTENT_TYPE,
                    HeaderValue::from_static("text/plain; charset=utf-8"),
                ),
                (header::CONTENT_DISPOSITION, disposition),
            ],
            text,
        )
            .into_response(),
        (text, _) => {
            let why = if text.is_some() {
                "the id can't be sent in a header"
            } else {
                "the transcript can't be exported"
            };
            tracing::error!(target: log::API, "[export-session] failed {{ id: {id:?} }}: {why}");
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                [(header::CONTENT_TYPE, "text/plain;charset=UTF-8")],
                "failed to export session",
            )
                .into_response()
        }
    }
}

async fn transcript(Path(id): Path<String>, RawQuery(query): RawQuery) -> Response {
    let dir = dir_param(query.as_deref());
    let include_system = search_param(query.as_deref(), "system").as_deref() != Some("0");
    match blocking(move || sessions_store::messages(&id, dir.as_deref(), include_system)).await {
        Some(list) => json_text(StatusCode::OK, &json!({ "messages": list })),
        None => thrown(),
    }
}

async fn remove(Path(id): Path<String>, RawQuery(query): RawQuery) -> Response {
    let dir = dir_param(query.as_deref());
    match blocking(move || sessions_store::remove(&id, dir.as_deref())).await {
        Some(Ok(())) => json_text(StatusCode::OK, &json!({ "ok": true })),
        Some(Err(error)) => json_text(
            StatusCode::INTERNAL_SERVER_ERROR,
            &json!({ "error": error }),
        ),
        None => thrown(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn disposition_is_a_latin1_byte_string() {
        let v = disposition("a b \"q\" caf\u{e9}\ty").unwrap();
        assert_eq!(
            v.as_bytes(),
            b"attachment; filename=\"claudius-session-a b \"q\" caf\xe9\ty.txt\""
        );
        for bad in ["\u{4e2d}", "x\ny", "x\ry", "x\0y", "x\u{1}y", "x\u{7f}y"] {
            assert!(disposition(bad).is_none(), "{bad:?}");
        }
        assert!(disposition("\u{ff}").is_some());
    }
}
