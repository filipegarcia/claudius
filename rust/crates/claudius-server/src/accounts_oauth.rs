//! `POST /api/accounts/oauth`: port of `app/api/accounts/oauth/route.ts`,
//! the account switcher's browser sign-in (`{action: "start"}`, then
//! `{action: "complete", flowId, code, label}`). The handler's logic is
//! [`claudius_core::account_oauth::post_route`]; this module holds the
//! process-wide pending flows (TS module state) and the outbound client.
//!
//! The store is `AccountsStore::from_env()` at each request, as TS reads
//! `accountsDir()` on every call. The token request goes out through the
//! process's client (`AppState::https`, built by [`https_client`]), and a
//! sign-in drops the new id from the profile-info cache
//! (`AppState::profile_info`). With the dev routes on
//! (`claudius_server::dev`), `CLAUDIUS_DEV_FETCH_BASE=<url>` sends every
//! outbound request to `<url>/<host>/<path>` instead, so tests can stand a
//! local fake in for Anthropic.

use std::sync::LazyLock;

use axum::Router;
use axum::body::Bytes;
use axum::extract::State;
use axum::http::{StatusCode, header};
use axum::response::{IntoResponse, Response};
use axum::routing::post;
use claudius_agent::js;
use claudius_core::account_oauth::{OAuthFlows, RouteAnswer, post_route};
use claudius_core::accounts::AccountsStore;
use claudius_core::fetch::HttpsClient;
use claudius_core::log;
use serde_json::{Value, json};

use crate::AppState;
use crate::body::{JsonBody, thrown};

/// Dev / test only: where outbound requests go instead (see the module docs).
pub const DEV_FETCH_BASE_ENV: &str = "CLAUDIUS_DEV_FETCH_BASE";

static FLOWS: LazyLock<OAuthFlows> = LazyLock::new(OAuthFlows::new);

/// The process's outbound HTTPS client (`AppState::https`): redirected to
/// `$CLAUDIUS_DEV_FETCH_BASE` only when `dev_routes` is on.
pub fn https_client(dev_routes: bool) -> HttpsClient {
    client_for(dev_routes, std::env::var(DEV_FETCH_BASE_ENV).ok())
}

/// The client for a dev-routes switch and a `CLAUDIUS_DEV_FETCH_BASE` value.
fn client_for(dev_routes: bool, base: Option<String>) -> HttpsClient {
    match base.filter(|b| dev_routes && !b.is_empty()) {
        Some(base) => HttpsClient::new().with_base(base),
        None => HttpsClient::new(),
    }
}

pub fn router() -> Router<AppState> {
    Router::new().route("/api/accounts/oauth", post(oauth))
}

fn json_text(status: u16, body: &Value) -> Response {
    (
        StatusCode::from_u16(status).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR),
        [(header::CONTENT_TYPE, "application/json")],
        js::stringify(body),
    )
        .into_response()
}

pub async fn oauth(State(app): State<AppState>, body: Bytes) -> Response {
    // `try { body = await req.json() } catch { return 400 }`.
    let Ok(b) = JsonBody::parse_or_message(&body) else {
        return json_text(400, &json!({"error": "invalid JSON"}));
    };
    let store = AccountsStore::from_env();
    match post_route(&FLOWS, &*app.https, &store, Some(&app.profile_info), &b).await {
        RouteAnswer::Json(status, v) => json_text(status, &v),
        RouteAnswer::Thrown(e) => {
            tracing::error!(target: log::API, "[api/accounts/oauth] {e}");
            thrown()
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_fetch_base_needs_the_dev_routes() {
        let url = claudius_core::account_oauth::OAUTH_TOKEN_URL;
        let base = || Some("http://127.0.0.1:9".to_owned());
        assert_eq!(client_for(false, base()).target(url), url);
        assert_eq!(client_for(true, None).target(url), url);
        assert_eq!(client_for(true, Some(String::new())).target(url), url);
        assert_eq!(
            client_for(true, base()).target(url),
            "http://127.0.0.1:9/platform.claude.com/v1/oauth/token"
        );
    }
}
