//! `GET /api/sessions/search`: port of `app/api/sessions/search/route.ts`,
//! the Sessions page's full-text search across one workspace's raw `.jsonl`
//! transcripts ([`claudius_core::session_search`]).
//!
//! `q`, `dir` and `limit` are `searchParams.get` values (first pair wins,
//! form-decoded). A blank `q` (JS `trim`) is `{"matches":[]}` before
//! anything else; then a missing or empty `dir` is 400 `dir is required`.
//! The query is a literal, never compiled as a pattern (CLAUDE.md's ReDoS
//! rule), matched case-insensitively the way a non-`u` `i` regex matches.
//! The scan and the reads run on the blocking pool. The body is written by
//! hand so a snippet's lone surrogate prints as `JSON.stringify` prints it.

use axum::Router;
use axum::extract::RawQuery;
use axum::http::{StatusCode, header};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use claudius_core::{paths, session_search};

use crate::AppState;
use crate::body::thrown;
use crate::session_transcript::search_param;

pub fn router() -> Router<AppState> {
    Router::new().route("/api/sessions/search", get(search))
}

async fn search(RawQuery(query): RawQuery) -> Response {
    let query = query.as_deref();
    let (q, dir, limit) = (
        search_param(query, "q"),
        search_param(query, "dir"),
        search_param(query, "limit"),
    );
    let home = paths::home_dir().to_string_lossy().into_owned();
    let answer = tokio::task::spawn_blocking(move || {
        session_search::respond(&home, q.as_deref(), dir.as_deref(), limit.as_deref())
    })
    .await;
    match answer {
        Ok((status, body)) => (
            StatusCode::from_u16(status).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR),
            [(header::CONTENT_TYPE, "application/json")],
            body,
        )
            .into_response(),
        Err(_) => thrown(),
    }
}
