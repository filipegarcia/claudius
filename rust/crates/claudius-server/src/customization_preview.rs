//! A customization's preview server: port of
//! `app/api/customizations/[id]/preview/route.ts` (GET / POST / DELETE) and
//! `[id]/preview/restart/route.ts` (POST) (D15), over
//! [`claudius_core::preview_server`].
//!
//! Each handler first looks the customization up (`ensureExists`): none is
//! 404 `{"error":"not found"}`, an index the store can't read is Next's
//! bare 500. GET answers the preview state, DELETE stops it, POST starts it
//! (or answers the running one) and `restart` restarts it; a start that
//! throws is 500 `{"error": <message>}`.
//!
//! Path safety: POST and `restart` answer 403 `{"error":"path outside
//! allowed root"}` for an id whose `<root>/<id>/src` is not strictly inside
//! the customizations root, as D13's `diff` and D14's routes do. TS stats,
//! mirrors into, cleans and spawns in wherever an id like `../x` points.

use axum::Router;
use axum::extract::Path;
use axum::http::StatusCode;
use axum::response::Response;
use axum::routing::{get, post};
use claudius_core::customizations::Store;
use claudius_core::{log, node_path, preview_server, runtime_dir};
use serde_json::json;

use crate::AppState;
use crate::body::thrown;
use crate::workspaces::json_text;

pub fn router() -> Router<AppState> {
    Router::new()
        .route(
            "/api/customizations/{id}/preview",
            get(state).post(start).delete(stop),
        )
        .route("/api/customizations/{id}/preview/restart", post(restart))
}

fn error(status: StatusCode, msg: &str) -> Response {
    json_text(status, &json!({"error": msg}))
}

/// `ensureExists(id)`: 404 without the record; a store that throws is
/// Next's empty 500.
fn ensure_exists(store: &Store, id: &str, route: &str) -> Result<(), Box<Response>> {
    match store.get_customization(id) {
        Ok(Some(_)) => Ok(()),
        Ok(None) => Err(Box::new(error(StatusCode::NOT_FOUND, "not found"))),
        Err(e) => {
            tracing::error!(target: log::API, "[api/customizations/[id]/preview{route}] {e:#}");
            Err(Box::new(thrown()))
        }
    }
}

/// 403 unless `<root>/<id>/src` is strictly inside the root.
fn inside_root(store: &Store, id: &str) -> Result<(), Box<Response>> {
    let src = node_path::resolve(&[&store.customization_src_dir(id)]);
    if src.starts_with(&format!("{}/", store.root())) {
        return Ok(());
    }
    Err(Box::new(error(
        StatusCode::FORBIDDEN,
        "path outside allowed root",
    )))
}

async fn state(Path(id): Path<String>) -> Response {
    if let Err(r) = ensure_exists(&Store::from_env(), &id, "") {
        return *r;
    }
    json_text(StatusCode::OK, &preview_server::get_preview_state(&id))
}

async fn start(Path(id): Path<String>) -> Response {
    let store = Store::from_env();
    if let Err(r) = ensure_exists(&store, &id, "").and_then(|()| inside_root(&store, &id)) {
        return *r;
    }
    let live = runtime_dir::live_source_dir();
    match preview_server::start_preview(&store, &live, &id).await {
        Ok(state) => json_text(StatusCode::OK, &state),
        Err(e) => error(StatusCode::INTERNAL_SERVER_ERROR, &format!("{e}")),
    }
}

async fn stop(Path(id): Path<String>) -> Response {
    if let Err(r) = ensure_exists(&Store::from_env(), &id, "") {
        return *r;
    }
    json_text(StatusCode::OK, &preview_server::stop_preview(&id).await)
}

async fn restart(Path(id): Path<String>) -> Response {
    let store = Store::from_env();
    if let Err(r) = ensure_exists(&store, &id, "/restart").and_then(|()| inside_root(&store, &id)) {
        return *r;
    }
    let live = runtime_dir::live_source_dir();
    match preview_server::restart_preview(&store, &live, &id).await {
        Ok(state) => json_text(StatusCode::OK, &state),
        Err(e) => error(StatusCode::INTERNAL_SERVER_ERROR, &format!("{e}")),
    }
}
