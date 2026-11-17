//! `/api/cost/refresh-prices`: port of `app/api/cost/refresh-prices/route.ts`
//! over [`claudius_core::litellm_pricing`], and the process's pricing state
//! ([`pricing`]) the Cost routes (D18b) price turns with.
//!
//! - `GET`: where the active prices come from, `{source: "cache", models,
//!   fetchedAt}` (the disk cache's mtime) or `{source: "bundle", models}`.
//! - `POST`: fetch LiteLLM's table now. 200 `{ok: true, models, source,
//!   fetchedAt}`; 502 `{ok: false, models, source, reason}` when the fetch
//!   fails; 503 with `source: "disabled"` under
//!   `CLAUDIUS_DISABLE_PRICE_REFRESH=1`; Next's empty 500 when the cache
//!   can't be written.
//!
//! The fetch goes out through the server's client (`AppState::https`), so
//! with the dev routes on `CLAUDIUS_DEV_FETCH_BASE` points it at a local
//! fake. The Cost routes (`cost.rs`, D18b) price with the same state, so a
//! refresh made here shows up there at once.

use std::sync::{Arc, OnceLock};

use axum::Router;
use axum::extract::State;
use axum::http::{StatusCode, header};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use claudius_agent::js;
use claudius_core::fetch::Fetch;
use claudius_core::litellm_pricing::PricingCache;
use claudius_core::{log, paths};
use serde_json::Value;

use crate::AppState;
use crate::body::thrown;

pub fn router() -> Router<AppState> {
    Router::new().route("/api/cost/refresh-prices", get(status).post(refresh))
}

static PRICING: OnceLock<Arc<PricingCache>> = OnceLock::new();

/// The process's `litellm-pricing.ts` module state, created on first use
/// over the server's outbound client and `homedir()`.
pub fn pricing(app: &AppState) -> Arc<PricingCache> {
    PRICING
        .get_or_init(|| {
            let fetch: Arc<dyn Fetch> = app.https.clone();
            Arc::new(PricingCache::new(&paths::home_dir(), fetch))
        })
        .clone()
}

fn json_status(status: StatusCode, body: &Value) -> Response {
    (
        status,
        [(header::CONTENT_TYPE, "application/json")],
        js::stringify(body),
    )
        .into_response()
}

/// `GET /api/cost/refresh-prices`.
async fn status(State(app): State<AppState>) -> Response {
    let p = pricing(&app);
    match tokio::task::spawn_blocking(move || p.get_pricing_status()).await {
        Ok(s) => json_status(StatusCode::OK, &s.to_json()),
        Err(_) => thrown(),
    }
}

/// `POST /api/cost/refresh-prices`.
async fn refresh(State(app): State<AppState>) -> Response {
    match pricing(&app).refresh_pricing().await {
        Ok(r) => {
            let status = if r.ok {
                StatusCode::OK
            } else if r.source == "disabled" {
                StatusCode::SERVICE_UNAVAILABLE
            } else {
                StatusCode::BAD_GATEWAY
            };
            json_status(status, &r.to_json())
        }
        Err(e) => {
            tracing::error!(target: log::API, "[api/cost/refresh-prices] {e}");
            thrown()
        }
    }
}
