//! Dev-only test routes (`dev-*`).
//!
//! The TS handlers start with `if (process.env.NODE_ENV === "production")
//! return …`, so they answer under `next dev` (and the e2e run) and refuse in
//! a production build. Rust has no `next dev` / `next start` split, so the
//! decision is made once at startup by [`dev_routes_enabled`] and stored in
//! [`AppState::dev_routes`](crate::AppState). Every dev handler calls
//! [`dev_only`] **first**, before reading params, the session or the body,
//! like TS.
//!
//! The refusal differs per route, copied from each TS handler:
//!
//! | route                                   | refusal                              |
//! |-----------------------------------------|--------------------------------------|
//! | `sessions/[id]/dev-broadcast`           | 404 `{error: "dev-only endpoint"}`   |
//! | `sessions/[id]/dev-reap`                | 404 `{error: "dev-only endpoint"}`   |
//! | `notifications/dev-emit`                | 404 `{error: "dev-only endpoint"}`   |
//! | `sessions/[id]/dev-inject-denial`       | 403 `{error: "dev only"}`            |

use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use serde_json::json;

/// Env var that overrides the build-type default: `0` / `false` force the
/// dev routes off, any other non-empty value forces them on.
pub const ENV_OVERRIDE: &str = "CLAUDIUS_DEV";

/// Whether the dev-only routes answer, in priority order:
/// 1. `CLAUDIUS_DEV`: `0` / `false` → off; any other non-empty value → on
///    (e.g. to run the e2e suite against a release binary).
/// 2. `NODE_ENV=production` → off, the exact TS condition. The packaged
///    desktop app runs with it.
/// 3. Otherwise the build type: on in debug builds (`cargo run`, the parity
///    e2e's `target/debug/claudius`), off in release builds.
pub fn dev_routes_enabled(
    claudius_dev: Option<&str>,
    node_env: Option<&str>,
    debug_build: bool,
) -> bool {
    match claudius_dev.map(str::trim) {
        None | Some("") => {}
        Some("0" | "false") => return false,
        Some(_) => return true,
    }
    if node_env == Some("production") {
        return false;
    }
    debug_build
}

/// [`dev_routes_enabled`] for this process's environment and build.
pub fn dev_routes_from_env() -> bool {
    dev_routes_enabled(
        std::env::var(ENV_OVERRIDE).ok().as_deref(),
        std::env::var("NODE_ENV").ok().as_deref(),
        cfg!(debug_assertions),
    )
}

/// How a dev route refuses when dev routes are off (see the module table).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DevRefusal {
    /// 404 `{error: "dev-only endpoint"}`
    NotFound,
    /// 403 `{error: "dev only"}`
    Forbidden,
}

impl IntoResponse for DevRefusal {
    fn into_response(self) -> Response {
        let (status, msg) = match self {
            DevRefusal::NotFound => (StatusCode::NOT_FOUND, "dev-only endpoint"),
            DevRefusal::Forbidden => (StatusCode::FORBIDDEN, "dev only"),
        };
        (status, axum::Json(json!({"error": msg}))).into_response()
    }
}

/// The guard: `tri!(dev_only(app.dev_routes, DevRefusal::NotFound));` as the
/// first line of a dev handler.
pub fn dev_only(enabled: bool, refusal: DevRefusal) -> Result<(), DevRefusal> {
    if enabled { Ok(()) } else { Err(refusal) }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn enabled_matrix() {
        // Build-type default.
        assert!(dev_routes_enabled(None, None, true));
        assert!(!dev_routes_enabled(None, None, false));
        // NODE_ENV: only "production" refuses, like TS.
        assert!(!dev_routes_enabled(None, Some("production"), true));
        assert!(dev_routes_enabled(None, Some("development"), true));
        assert!(dev_routes_enabled(None, Some("test"), true));
        assert!(!dev_routes_enabled(None, Some("development"), false));
        // CLAUDIUS_DEV wins over both.
        for on in ["1", "true", "yes", " 1 "] {
            assert!(
                dev_routes_enabled(Some(on), Some("production"), false),
                "{on:?}"
            );
        }
        for off in ["0", "false", " 0"] {
            assert!(!dev_routes_enabled(Some(off), None, true), "{off:?}");
        }
        // Empty = unset.
        assert!(dev_routes_enabled(Some(""), None, true));
        assert!(!dev_routes_enabled(Some(""), Some("production"), true));
    }

    #[tokio::test]
    async fn refusals_match_ts() {
        assert_eq!(dev_only(true, DevRefusal::NotFound), Ok(()));
        for (refusal, status, msg) in [
            (DevRefusal::NotFound, 404, "dev-only endpoint"),
            (DevRefusal::Forbidden, 403, "dev only"),
        ] {
            let r = dev_only(false, refusal).unwrap_err().into_response();
            assert_eq!(r.status().as_u16(), status);
            let body = axum::body::to_bytes(r.into_body(), usize::MAX)
                .await
                .unwrap();
            assert_eq!(
                serde_json::from_slice::<serde_json::Value>(&body).unwrap(),
                json!({"error": msg})
            );
        }
    }
}
