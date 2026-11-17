//! `lib/client/api-retry.ts`: the state the hook keeps for the SDK's
//! `system/api_retry` message (`session.apiRetry`).
//!
//! The hook imports only the type; it builds the value inline in its
//! `api_retry` branch (U01h). `describeApiRetry`, `humanizeApiRetryError`
//! and `ANTHROPIC_STATUS_URL` are the working row's display copy
//! (`SpinnerTip`), not state.

use serde::{Deserialize, Serialize};

use crate::types::num;

/// `ApiRetryState`: one retry in flight. `errorStatus` is always there on
/// the wire (`null` for none), so `None` writes `null`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ApiRetryState {
    #[serde(with = "num")]
    pub attempt: f64,
    #[serde(with = "num")]
    pub max_retries: f64,
    #[serde(with = "num")]
    pub retry_delay_ms: f64,
    #[serde(default, with = "num::opt")]
    pub error_status: Option<f64>,
    /// An `ApiRetryErrorReason` (`overloaded`, `rate_limit`, …) or any
    /// other string the SDK sends.
    pub error: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub no_response: Option<ApiRetryNoResponse>,
}

/// `ApiRetryState["noResponse"]` (SDK 0.3.261): no response headers came
/// within the first-byte timeout.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ApiRetryNoResponse {
    #[serde(with = "num")]
    pub waited_ms: f64,
    #[serde(with = "num")]
    pub retry_wait_ms: f64,
}
