//! The Cost page's read routes (D18b): `GET /api/cost`
//! (`app/api/cost/route.ts`), `GET /api/cost/loops`
//! (`app/api/cost/loops/route.ts`) and `GET /api/cost/overview`
//! (`app/api/cost/overview/route.ts`), over [`claudius_core::cost_aggregate`],
//! [`claudius_core::cost_overview`] and
//! [`claudius_core::loop_ticks_db::list_loop_breakdown_js`].
//!
//! - `cost` and `cost/loops` resolve `?cwd=` to a trusted cwd first (400
//!   `unknown cwd`); the report or `{loops}` is a 200, and anything the
//!   module throws a 500 `{error: err.message}`.
//! - `cost/overview` takes no input. Concurrent requests share one run
//!   (`getCostOverview`'s in-flight promise), which is forgotten once it
//!   settles; a throw is a 500 `{error}`.
//!
//! Turns are priced with the process's LiteLLM table
//! ([`crate::cost_prices::pricing`]), so a `cost/refresh-prices` POST shows
//! up here at once. The day keys use the process's zone (`TZ` first).

use std::sync::Mutex;

use axum::Router;
use axum::extract::{RawQuery, State};
use axum::http::{StatusCode, header};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use claudius_core::cost_aggregate::{self, Clock};
use claudius_core::{cost_overview, js_string, loop_ticks_db, trusted_cwd};
use futures::FutureExt;
use futures::future::{BoxFuture, Shared};
use serde_json::{Value, json};

use crate::AppState;
use crate::body::thrown;
use crate::cost_prices::pricing;
use crate::session_transcript::search_param;

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/api/cost", get(get_cost))
        .route("/api/cost/loops", get(get_loops))
        .route("/api/cost/overview", get(get_overview))
}

fn json_text(status: StatusCode, text: String) -> Response {
    (status, [(header::CONTENT_TYPE, "application/json")], text).into_response()
}

/// `NextResponse.json(v)` / `NextResponse.json({error}, {status: 500})`.
fn answer(r: Result<Value, String>) -> Response {
    match r {
        Ok(v) => json_text(StatusCode::OK, js_string::stringify(&v)),
        Err(e) => json_text(
            StatusCode::INTERNAL_SERVER_ERROR,
            js_string::stringify(&json!({ "error": e })),
        ),
    }
}

fn unknown_cwd() -> Response {
    json_text(
        StatusCode::BAD_REQUEST,
        json!({"error": "unknown cwd"}).to_string(),
    )
}

/// `resolveTrustedCwd(url.searchParams.get("cwd"))`.
fn trusted(q: Option<&str>) -> Option<String> {
    trusted_cwd::resolve_trusted_cwd(search_param(q, "cwd").as_deref())
}

async fn blocking(f: impl FnOnce() -> Response + Send + 'static) -> Response {
    tokio::task::spawn_blocking(f)
        .await
        .unwrap_or_else(|_| thrown())
}

/// `GET /api/cost`.
async fn get_cost(State(app): State<AppState>, RawQuery(query): RawQuery) -> Response {
    let prices = pricing(&app);
    let rt = tokio::runtime::Handle::current();
    blocking(move || {
        let Some(cwd) = trusted(query.as_deref()) else {
            return unknown_cwd();
        };
        let mut table = || rt.block_on(prices.get_pricing_table());
        answer(cost_aggregate::aggregate(
            &cwd,
            &Clock::system(),
            &mut table,
        ))
    })
    .await
}

/// `GET /api/cost/loops`.
async fn get_loops(RawQuery(query): RawQuery) -> Response {
    blocking(move || {
        let Some(cwd) = trusted(query.as_deref()) else {
            return unknown_cwd();
        };
        answer(loop_ticks_db::list_loop_breakdown_js(&cwd).map(|loops| json!({ "loops": loops })))
    })
    .await
}

type Overview = Shared<BoxFuture<'static, Result<Value, String>>>;

/// `inflight`: the overview being computed, shared by every request that
/// arrives meanwhile.
static INFLIGHT: Mutex<Option<Overview>> = Mutex::new(None);

/// Forgets the in-flight overview when dropped.
struct Settled;

impl Drop for Settled {
    fn drop(&mut self) {
        *INFLIGHT.lock().unwrap_or_else(|e| e.into_inner()) = None;
    }
}

/// `getCostOverview()`.
fn cost_overview_run(app: &AppState) -> Overview {
    let mut slot = INFLIGHT.lock().unwrap_or_else(|e| e.into_inner());
    if let Some(f) = slot.as_ref() {
        return f.clone();
    }
    let prices = pricing(app);
    let task = tokio::spawn(async move {
        // `.finally(() => { inflight = null; })`, a panic included.
        let _settled = Settled;
        let table = prices.get_pricing_table().await;
        tokio::task::spawn_blocking(move || {
            cost_overview::aggregate_overview(table, &Clock::system())
        })
        .await
    });
    let shared = async move {
        match task.await {
            Ok(Ok(r)) => r,
            _ => Err("the cost overview task failed".into()),
        }
    }
    .boxed()
    .shared();
    *slot = Some(shared.clone());
    shared
}

/// `GET /api/cost/overview`.
async fn get_overview(State(app): State<AppState>) -> Response {
    answer(cost_overview_run(&app).await)
}
