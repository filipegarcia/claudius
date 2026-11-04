//! Claudius HTTP front door (library half, so tests can mount the router).

pub mod accounts;
pub mod accounts_oauth;
pub mod agents;
pub mod assets;
pub mod body;
pub mod community;
pub mod cost_prices;
pub mod customizations;
pub mod customize;
pub mod dev;
pub mod docker;
pub mod doctor;
pub mod feedback;
pub mod files_preview;
pub mod fs_routes;
pub mod git;
pub mod git_branches;
pub mod git_sync;
pub mod heapdump;
pub mod heartbeat;
pub mod limits;
pub mod logging;
pub mod mcp_config;
pub mod memory;
pub mod models;
pub mod move_sessions;
pub mod notification_prefs;
pub mod notifications;
pub mod open_tabs;
pub mod pages;
pub mod peer_source;
pub mod plugins;
pub mod proxy;
pub mod schedule;
pub mod schedule_live;
pub mod session_account;
pub mod session_search;
pub mod session_transcript;
pub mod sessions;
pub mod sessions_collection;
pub mod settings_routes;
pub mod skills_hooks;
pub mod splash_examples;
pub mod workspace_files;
pub mod workspace_roots;
pub mod workspaces;
pub mod worktrees;

use std::sync::Arc;

use axum::Router;
use axum::extract::DefaultBodyLimit;
use axum::routing::get;
use claudius_core::account_profile::ProfileInfoResolver;
use claudius_core::fetch::HttpsClient;
use claudius_core::session_manager::SessionManager;
use serde_json::json;

#[derive(Clone)]
pub struct AppState {
    pub mgr: Arc<SessionManager>,
    pub proxy: Option<Arc<proxy::Proxy>>,
    /// Whether the dev-only `dev-*` test routes answer (see [`dev`]).
    pub dev_routes: bool,
    /// The outbound HTTPS client ([`accounts_oauth::https_client`]).
    pub https: Arc<HttpsClient>,
    /// The account profile-info cache over [`Self::https`] (TS
    /// `account-profile.ts` module state; [`accounts::profile_resolver`]).
    pub profile_info: Arc<ProfileInfoResolver>,
}

impl AppState {
    pub fn new(
        mgr: Arc<SessionManager>,
        proxy: Option<Arc<proxy::Proxy>>,
        dev_routes: bool,
    ) -> AppState {
        let https = Arc::new(accounts_oauth::https_client(dev_routes));
        let profile_info = Arc::new(accounts::profile_resolver(https.clone()));
        AppState {
            mgr,
            proxy,
            dev_routes,
            https,
            profile_info,
        }
    }
}

pub fn app(state: AppState) -> Router {
    Router::new()
        .route(
            "/api/rust/health",
            get(|| async {
                axum::Json(
                    json!({"ok": true, "backend": "rust", "version": env!("CARGO_PKG_VERSION")}),
                )
            }),
        )
        .merge(sessions::router())
        .merge(agents::router())
        .merge(workspaces::router())
        .merge(mcp_config::router())
        .merge(git::router())
        .merge(git_branches::router())
        .merge(git_sync::router())
        .merge(fs_routes::router())
        .merge(session_search::router())
        .merge(open_tabs::router())
        .merge(heartbeat::router())
        .merge(heapdump::router())
        .merge(splash_examples::router())
        .merge(models::router())
        .merge(schedule::router())
        .merge(schedule_live::router())
        .merge(memory::router())
        .merge(accounts_oauth::router())
        .merge(assets::router())
        .merge(docker::router())
        .merge(doctor::router())
        .merge(plugins::router())
        .merge(notifications::router())
        .merge(accounts::router())
        .merge(workspace_roots::router())
        .merge(session_account::router())
        .merge(move_sessions::router())
        .merge(peer_source::router())
        .merge(settings_routes::router())
        .merge(workspace_files::router())
        .merge(skills_hooks::router())
        .merge(customizations::router())
        .merge(sessions_collection::router())
        .merge(worktrees::router())
        .fallback(pages::handler)
        .merge(community::router())
        .merge(feedback::router())
        .merge(limits::router())
        .merge(cost_prices::router())
        .merge(customize::router())
        .merge(files_preview::router())
        .fallback(proxy::handler)
        .layer(DefaultBodyLimit::max(256 * 1024 * 1024))
        .with_state(state)
}
