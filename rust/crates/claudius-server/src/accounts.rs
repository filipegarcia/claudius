//! The account switcher's routes (G02c): ports of
//! `app/api/accounts/route.ts` (`GET`/`POST`/`PATCH`/`DELETE /api/accounts`),
//! `app/api/accounts/profile/route.ts` (`GET /api/accounts/profile`) and
//! `app/api/account/route.ts` (`GET /api/account`).
//!
//! The store is `AccountsStore::from_env()` at each request, as TS reads
//! `accountsDir()` on every call ([`claudius_core::accounts`]). Profile
//! lookups go through the process's one [`ProfileInfoResolver`]
//! (`AppState::profile_info`, see [`profile_resolver`]): its 5-minute cache
//! is shared with the OAuth sign-in, and adding or deleting a profile drops
//! that id from it. Only `oauth-token` profiles ask Anthropic (through
//! `AppState::https`, so `CLAUDIUS_DEV_FETCH_BASE` reaches it too).
//!
//! Live sessions: switching the active profile (`PATCH` with
//! `activeProfileId`) asks every live session to recompute its drift from
//! the active account ([`claudius_core::account_drift`]); no session's
//! credential changes. `GET /api/account?sessionId=` answers a live
//! session's `accountInfo()`: the `account` of its CLI's `initialize` reply.
//!
//! Secrets never reach an answer (profiles go out through `toPublic`) or a
//! log line: only the store's own error text is logged.

use std::sync::Arc;

use axum::Router;
use axum::body::Bytes;
use axum::extract::{RawQuery, State};
use axum::http::{StatusCode, header};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use claudius_agent::js;
use claudius_core::account_oauth::RouteAnswer;
use claudius_core::account_profile::ProfileInfoResolver;
use claudius_core::accounts::{AccountsError, AccountsStore, NewAccount};
use claudius_core::claude_global_config;
use claudius_core::fetch::HttpsClient;
use claudius_core::log;
use claudius_core::session_manager::SessionManager;
use serde_json::{Value, json};

use crate::AppState;
use crate::body::{JsonBody, js_truthy, thrown};
use crate::session_transcript::search_param;

pub fn router() -> Router<AppState> {
    Router::new()
        .route(
            "/api/accounts",
            get(list).post(add).patch(update).delete(remove),
        )
        .route("/api/accounts/profile", get(profile))
        .route("/api/account", get(account))
}

/// The process's profile-info cache: over the store the environment names,
/// the process-wide `~/.claude.json` reader and `https`.
pub fn profile_resolver(https: Arc<HttpsClient>) -> ProfileInfoResolver {
    ProfileInfoResolver::new(
        AccountsStore::from_env(),
        claude_global_config::global_shared().clone(),
        https,
    )
}

fn json_text(status: u16, body: &Value) -> Response {
    (
        StatusCode::from_u16(status).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR),
        [(header::CONTENT_TYPE, "application/json")],
        js::stringify(body),
    )
        .into_response()
}

/// A [`RouteAnswer`] as the response; a throw is logged under `route`.
fn respond(route: &str, answer: RouteAnswer) -> Response {
    match answer {
        RouteAnswer::Json(status, v) => json_text(status, &v),
        RouteAnswer::Thrown(e) => {
            tracing::error!(target: log::API, "[api/{route}] {e}");
            thrown()
        }
    }
}

fn error(status: u16, message: impl Into<String>) -> RouteAnswer {
    RouteAnswer::Json(status, json!({"error": message.into()}))
}

/// `body.<key>` on a parsed body that isn't `null`: own keys of an object,
/// `undefined` (`None`) on anything else.
fn member<'a>(body: &'a Value, key: &str) -> Option<&'a Value> {
    body.as_object().and_then(|o| o.get(key))
}

// ---- GET /api/accounts -----------------------------------------------------------

/// `GET /api/accounts`: `readAccountsPublic()` (secrets as 4-char previews).
pub fn get_accounts(store: &AccountsStore) -> RouteAnswer {
    match store.read_public() {
        Ok(v) => RouteAnswer::Json(200, v),
        Err(e) => RouteAnswer::Thrown(e.0),
    }
}

async fn list() -> Response {
    respond("accounts", get_accounts(&AccountsStore::from_env()))
}

// ---- POST /api/accounts ----------------------------------------------------------

/// `POST /api/accounts`: add a profile (`{label, kind, secret?, bedrock?}`;
/// the first one becomes active) and answer `{state, profileId}`. A body
/// that doesn't parse is a 400 `invalid JSON`, a `null` one throws; the
/// route's own checks come before `addAccount`'s, and every store error is a
/// 400 with its message, also one from `toPublic` after the profile was
/// written (a broken Bedrock peer).
pub fn post_accounts(
    store: &AccountsStore,
    profile_info: &ProfileInfoResolver,
    body: &[u8],
) -> RouteAnswer {
    let Ok(b) = JsonBody::parse_or_message(body) else {
        return error(400, "invalid JSON");
    };
    if b.is_null() {
        return RouteAnswer::Thrown("Cannot read properties of null (reading 'label')".into());
    }
    let (label, kind, secret) = (
        member(&b, "label"),
        member(&b, "kind"),
        member(&b, "secret"),
    );
    if !js_truthy(label) || !js_truthy(kind) {
        return error(400, "label, kind required");
    }
    let bedrock = kind.and_then(Value::as_str) == Some("bedrock");
    if !bedrock && !js_truthy(secret) {
        return error(400, "label, kind, secret required");
    }
    let input = NewAccount {
        label: label.cloned(),
        kind: kind.cloned(),
        secret: secret.cloned(),
        bedrock: member(&b, "bedrock").filter(|_| bedrock).cloned(),
        ..Default::default()
    };
    let (state, profile) = match store.add_account(&input) {
        Ok(added) => added,
        Err(e) => return error(400, e.0),
    };
    // A fresh secret is a fresh profile: no stale lookup for its id.
    profile_info.invalidate_profile_cache(Some(profile.id()));
    match state.to_public() {
        Ok(public) => RouteAnswer::Json(200, json!({"state": public, "profileId": profile.id()})),
        Err(e) => error(400, e.0),
    }
}

async fn add(State(app): State<AppState>, body: Bytes) -> Response {
    let store = AccountsStore::from_env();
    respond("accounts", post_accounts(&store, &app.profile_info, &body))
}

// ---- PATCH /api/accounts ---------------------------------------------------------

/// `PATCH /api/accounts`: `{autoRotateOnRateLimit?: boolean,
/// activeProfileId?}`, in that order, then the public state. Switching the
/// active profile asks every live session in `mgr` to recompute its drift
/// (`notifyActiveAccountChanged`). A store error is a 400 with its message;
/// what was written before it stays.
pub fn patch_accounts(store: &AccountsStore, mgr: &SessionManager, body: &[u8]) -> RouteAnswer {
    let Ok(b) = JsonBody::parse_or_message(body) else {
        return error(400, "invalid JSON");
    };
    if b.is_null() {
        return RouteAnswer::Thrown(
            "Cannot read properties of null (reading 'activeProfileId')".into(),
        );
    }
    let active = member(&b, "activeProfileId").filter(|v| js::truthy(v));
    let auto_rotate = member(&b, "autoRotateOnRateLimit").and_then(Value::as_bool);
    if active.is_none() && auto_rotate.is_none() {
        return error(400, "activeProfileId or autoRotateOnRateLimit required");
    }
    let run = || -> Result<Value, AccountsError> {
        if let Some(on) = auto_rotate {
            store.set_auto_rotate(on)?;
        }
        if let Some(id) = active {
            match id {
                Value::String(id) => {
                    store.set_active_account(id)?;
                }
                // No stored id is `===` a non-string.
                _ => {
                    store.read_raw()?;
                    return Err(AccountsError("profile not found".into()));
                }
            }
            mgr.notify_active_account_changed(store);
        }
        store.read_public()
    };
    match run() {
        Ok(v) => RouteAnswer::Json(200, v),
        Err(e) => error(400, e.0),
    }
}

async fn update(State(app): State<AppState>, body: Bytes) -> Response {
    let store = AccountsStore::from_env();
    respond("accounts", patch_accounts(&store, &app.mgr, &body))
}

// ---- DELETE /api/accounts?id= ----------------------------------------------------

/// `DELETE /api/accounts?id=`: remove the profile (an unknown id changes
/// nothing; a deleted active one hands over to the first left) and answer
/// the public state. A store error throws.
pub fn delete_accounts(
    store: &AccountsStore,
    profile_info: &ProfileInfoResolver,
    query: Option<&str>,
) -> RouteAnswer {
    let Some(id) = search_param(query, "id").filter(|id| !id.is_empty()) else {
        return error(400, "id required");
    };
    if let Err(e) = store.delete_account(&id) {
        return RouteAnswer::Thrown(e.0);
    }
    profile_info.invalidate_profile_cache(Some(&id));
    get_accounts(store)
}

async fn remove(State(app): State<AppState>, RawQuery(query): RawQuery) -> Response {
    let store = AccountsStore::from_env();
    respond(
        "accounts",
        delete_accounts(&store, &app.profile_info, query.as_deref()),
    )
}

// ---- GET /api/accounts/profile?id=&refresh=1 -------------------------------------

/// `GET /api/accounts/profile?id=<profileId>&refresh=1`: `{info}` for the
/// profile (the active one without an `id`), `null` for none or an unknown
/// id. `refresh=1` (exactly) skips the cache. A store error throws.
pub async fn get_profile(
    store: &AccountsStore,
    profile_info: &ProfileInfoResolver,
    query: Option<&str>,
) -> RouteAnswer {
    let refresh = search_param(query, "refresh").as_deref() == Some("1");
    let id = match search_param(query, "id").filter(|id| !id.is_empty()) {
        Some(id) => Some(id),
        None => match store.read_raw() {
            Ok(cur) => cur.active_profile_id,
            Err(e) => return RouteAnswer::Thrown(e.0),
        },
    };
    let Some(id) = id.filter(|id| !id.is_empty()) else {
        return RouteAnswer::Json(200, json!({"info": null}));
    };
    match profile_info
        .get_profile_info_for_account(&id, refresh)
        .await
    {
        Ok(info) => RouteAnswer::Json(200, json!({"info": info})),
        Err(e) => RouteAnswer::Thrown(e.0),
    }
}

async fn profile(State(app): State<AppState>, RawQuery(query): RawQuery) -> Response {
    let store = AccountsStore::from_env();
    respond(
        "accounts/profile",
        get_profile(&store, &app.profile_info, query.as_deref()).await,
    )
}

// ---- GET /api/account?sessionId= -------------------------------------------------

/// `GET /api/account?sessionId=`: the live session's `accountInfo()`, the
/// `account` its CLI reported in `initialize` (not resumed: a session that
/// isn't live is a 404). A failed `initialize` is a 500 with its message;
/// no `account` at all is Next's empty 500 (`NextResponse.json(undefined)`
/// throws).
pub async fn get_account(mgr: &SessionManager, query: Option<&str>) -> RouteAnswer {
    let Some(id) = search_param(query, "sessionId").filter(|id| !id.is_empty()) else {
        return error(400, "sessionId required");
    };
    let Some(session) = mgr.get(&id) else {
        return error(404, "session not found");
    };
    let Some(query) = session.query_handle() else {
        return error(500, "no active query");
    };
    match query.initialization_result().await {
        // `(await this.initialization).account`
        Ok(Value::Null) => error(500, "Cannot read properties of null (reading 'account')"),
        Ok(init) => match init.get("account") {
            Some(account) => RouteAnswer::Json(200, account.clone()),
            None => RouteAnswer::Thrown("Value is not JSON serializable".into()),
        },
        Err(e) => error(500, e.to_string()),
    }
}

async fn account(State(app): State<AppState>, RawQuery(query): RawQuery) -> Response {
    respond("account", get_account(&app.mgr, query.as_deref()).await)
}
