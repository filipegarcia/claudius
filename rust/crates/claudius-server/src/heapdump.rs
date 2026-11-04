//! `POST /api/heapdump` (`app/api/heapdump/route.ts`, D29).
//!
//! The TS route writes Node's diagnostic report for the Next process
//! (`process.report.writeReport()`) and answers `{ok: true, path}`, or
//! `{ok: false, error}` with a 500. The Rust backend has no Node runtime to
//! report on, so it answers in that error shape with a 501 and says why.
//! While Next runs, its own report is still `POST /api/heapdump` on Next's
//! port. No UI calls the route.

use axum::Router;
use axum::http::{StatusCode, header};
use axum::response::{IntoResponse, Response};
use axum::routing::post;
use claudius_agent::js;
use serde_json::json;

use crate::AppState;

/// The 501's `error`.
pub const NOT_AVAILABLE: &str = "heapdump writes a Node diagnostic report, and the Rust backend has no Node runtime to report on";

pub fn router() -> Router<AppState> {
    Router::new().route("/api/heapdump", post(heapdump))
}

async fn heapdump() -> Response {
    (
        StatusCode::NOT_IMPLEMENTED,
        [(header::CONTENT_TYPE, "application/json")],
        js::stringify(&json!({"ok": false, "error": NOT_AVAILABLE})),
    )
        .into_response()
}

#[cfg(test)]
mod tests {
    use super::*;
    use http_body_util::BodyExt;

    #[tokio::test]
    async fn answers_501_in_the_route_error_shape() {
        let res = heapdump().await;
        assert_eq!(res.status(), StatusCode::NOT_IMPLEMENTED);
        assert_eq!(res.headers()[header::CONTENT_TYPE], "application/json");
        let body = res.into_body().collect().await.unwrap().to_bytes();
        let v: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(v, json!({"ok": false, "error": NOT_AVAILABLE}));
        assert_eq!(js::stringify(&v), String::from_utf8_lossy(&body));
    }
}
