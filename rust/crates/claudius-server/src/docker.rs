//! `GET /api/docker/containers`: port of `app/api/docker/containers/route.ts`
//! over [`claudius_core::docker`] (D23). Always 200 with the
//! `JSON.stringify` text of the fleet, or of `{status: "unavailable", …}`.

use axum::Router;
use axum::http::{StatusCode, header};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use claudius_core::docker;

use crate::AppState;

pub fn router() -> Router<AppState> {
    Router::new().route("/api/docker/containers", get(containers))
}

async fn containers() -> Response {
    (
        StatusCode::OK,
        [(header::CONTENT_TYPE, "application/json")],
        docker::get_containers().await.to_json(),
    )
        .into_response()
}
