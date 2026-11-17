//! The customization lifecycle routes: port of `POST /api/customizations`
//! (bootstrap) and `[id]/{deactivate,sync,description,build-app,publish,
//! auto-fix}` plus `[id]/publishes/[pubId]/revert` (D14), over
//! [`claudius_core`]'s `customization_*` modules. D13 ported the store's own
//! routes ([`crate::customizations`]).
//!
//! Each handler keeps the TS order: the `getCustomization` 404 first, then
//! the work, and the thrown error's `message` in the body the TS builds.
//! Anything the TS lets throw (an unreadable index, a `null` PATCH body, a
//! `createHash` update on a non-string manifest hash) is Next's bare 500.
//!
//! The long jobs (tree walks, hashing, copies) run on
//! [`tokio::task::spawn_blocking`], so one publish or sync doesn't stall the
//! server; the SDK query of `description` and the revert script are async
//! already.
//!
//! Path safety: an id whose `src` mirror is not strictly inside the
//! customizations root answers 403 `{"error":"path outside allowed root"}`,
//! as D13's `diff` does. TS walks, writes and deletes wherever an id like
//! `../x` points; the only place that difference is invisible is the
//! `description` GET, whose hash failure is already "no diff" there.

use axum::Router;
use axum::body::Bytes;
use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::response::Response;
use axum::routing::{get, post};
use claudius_agent::js;
use claudius_core::customization_build::{build_availability, get_build_state, start_build};
use claudius_core::customization_description::{
    DescribeEnv, Described, describe_customization, diff_hash_for,
};
use claudius_core::customization_sync::{Verdict, apply_safe_sync, compute_sync_status};
use claudius_core::customizations::Store;
use claudius_core::{
    customization_auto_fix, customization_bootstrap, customization_publish, customization_revert,
    customize_settings, js_string, log, node_path, runtime_dir,
};
use serde_json::{Map, Value, json};

use crate::AppState;
use crate::body::{js_member, thrown};
use crate::customizations::patch_body;
use crate::tri;
use crate::workspaces::json_text;

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/api/customizations/{id}/deactivate", post(deactivate))
        .route("/api/customizations/{id}/sync", get(sync).post(sync_apply))
        .route(
            "/api/customizations/{id}/description",
            get(description).post(regenerate).patch(set_description),
        )
        .route(
            "/api/customizations/{id}/build-app",
            get(build_state).post(build_start),
        )
        .route("/api/customizations/{id}/publish", post(publish))
        .route("/api/customizations/{id}/auto-fix", post(auto_fix))
        .route(
            "/api/customizations/{id}/publishes/{pub_id}/revert",
            post(revert),
        )
}

fn error(status: StatusCode, msg: &str) -> Response {
    json_text(status, &json!({"error": msg}))
}

/// What the TS let throw: Next's empty 500.
fn failed(route: &str, e: impl std::fmt::Display) -> Response {
    tracing::error!(target: log::API, "[api/customizations{route}] {e:#}");
    thrown()
}

/// `const c = await getCustomization(id); if (!c) return 404 {error: msg}`.
fn existing(store: &Store, id: &str, route: &str, msg: &str) -> Result<Value, Box<Response>> {
    match store.get_customization(id) {
        Ok(Some(c)) => Ok(c),
        Ok(None) => Err(Box::new(error(StatusCode::NOT_FOUND, msg))),
        Err(e) => Err(Box::new(failed(route, e))),
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

/// A job that walks or writes the mirror, off the request thread.
async fn blocking<T: Send + 'static>(
    route: &str,
    job: impl FnOnce() -> T + Send + 'static,
) -> Result<T, Box<Response>> {
    tokio::task::spawn_blocking(job)
        .await
        .map_err(|e| Box::new(failed(route, e)))
}

/// `err instanceof Error ? err.message : "<fallback>"`: every error here is
/// an `Error`, so the fallback never shows.
fn message(e: &anyhow::Error) -> String {
    format!("{e}")
}

// ---- POST /api/customizations (bootstrap) ---------------------------------------

/// `POST /api/customizations`: `bootstrapCustomization({name})`, 201 with
/// the record, the file count and the mirror dir. A body that isn't JSON is
/// `{}`; a `name` that is neither nullish nor a string throws
/// (`name.trim is not a function`).
pub async fn bootstrap(body: Bytes) -> Response {
    let b = patch_body(&body).unwrap_or_else(|| json!({}));
    // `body?.name?.trim()`: a `null` body never throws here.
    let name = match b.get("name") {
        Some(Value::String(s)) => js::trim(s).to_owned(),
        Some(Value::Null) | None => String::new(),
        Some(_) => return failed("", "body?.name?.trim is not a function"),
    };
    let store = Store::from_env();
    let name = if name.is_empty() {
        customization_bootstrap::fallback_name(store.now())
    } else {
        name
    };
    let live = runtime_dir::live_source_dir();
    let done = blocking("", move || {
        customization_bootstrap::bootstrap_customization(&store, &live, &name)
    })
    .await;
    match done {
        Ok(Ok(r)) => json_text(
            StatusCode::CREATED,
            &json!({
                "customization": r.customization,
                "filesCopied": r.files_copied,
                "srcDir": r.src_dir,
            }),
        ),
        Ok(Err(e)) => error(StatusCode::INTERNAL_SERVER_ERROR, &message(&e)),
        Err(r) => *r,
    }
}

// ---- /api/customizations/:id/sync ------------------------------------------------

async fn sync(Path(id): Path<String>) -> Response {
    let store = Store::from_env();
    if let Err(r) = existing(&store, &id, "/[id]/sync", "not found") {
        return *r;
    }
    if let Err(r) = inside_root(&store, &id) {
        return *r;
    }
    let live = runtime_dir::live_source_dir();
    let status = blocking("/[id]/sync", move || {
        compute_sync_status(&store, &live, &id)
    })
    .await;
    match status {
        Ok(Ok(s)) => json_text(StatusCode::OK, &s.to_json()),
        Ok(Err(e)) => error(StatusCode::INTERNAL_SERVER_ERROR, &message(&e)),
        Err(r) => *r,
    }
}

async fn sync_apply(Path(id): Path<String>) -> Response {
    let store = Store::from_env();
    if let Err(r) = existing(&store, &id, "/[id]/sync", "not found") {
        return *r;
    }
    if let Err(r) = inside_root(&store, &id) {
        return *r;
    }
    let live = runtime_dir::live_source_dir();
    let result = blocking("/[id]/sync", move || apply_safe_sync(&store, &live, &id)).await;
    match result {
        Ok(Ok(r)) => json_text(StatusCode::OK, &r.to_json()),
        Ok(Err(e)) => error(StatusCode::INTERNAL_SERVER_ERROR, &message(&e)),
        Err(r) => *r,
    }
}

// ---- /api/customizations/:id/description -------------------------------------------

/// `buildResponse(id)`: `None` where the TS has no record. The current diff
/// hash is only computed where `stale` could be true (the walk is O(tree)),
/// and its failure reads as "no diff".
fn build_response(store: &Store, live: &str, id: &str) -> anyhow::Result<Option<Value>> {
    let Some(c) = store.get_customization(id)? else {
        return Ok(None);
    };
    let field = |key: &str| c.get(key).cloned().filter(|v| !v.is_null());
    let is_manual = c.get("descriptionIsManual").is_some_and(js::truthy);
    let description = c.get("description").filter(|v| js::truthy(v));
    let hash = c.get("descriptionDiffHash").filter(|v| js::truthy(v));
    let needs = !is_manual && description.is_some() && hash.is_some();
    let current = if needs {
        diff_hash_for(store, live, id).unwrap_or_default()
    } else {
        String::new()
    };
    let stale = needs && !current.is_empty() && hash != Some(&json!(current));
    let mut out = Map::new();
    out.insert(
        "description".into(),
        field("description").unwrap_or(Value::Null),
    );
    out.insert(
        "descriptionGeneratedAt".into(),
        field("descriptionGeneratedAt").unwrap_or(Value::Null),
    );
    out.insert(
        "descriptionDiffHash".into(),
        field("descriptionDiffHash").unwrap_or(Value::Null),
    );
    out.insert("descriptionIsManual".into(), json!(is_manual));
    out.insert("currentDiffHash".into(), json!(current));
    out.insert("stale".into(), json!(stale));
    Ok(Some(Value::Object(out)))
}

/// The response after a write: `NextResponse.json(body!)`, where a record
/// that vanished meanwhile is the JSON `null`.
async fn written(store: Store, live: String, id: String) -> Response {
    match blocking("/[id]/description", move || {
        build_response(&store, &live, &id)
    })
    .await
    {
        Ok(Ok(body)) => json_text(StatusCode::OK, &body.unwrap_or(Value::Null)),
        Ok(Err(e)) => failed("/[id]/description", e),
        Err(r) => *r,
    }
}

async fn description(Path(id): Path<String>) -> Response {
    let store = Store::from_env();
    let live = runtime_dir::live_source_dir();
    let body = blocking("/[id]/description", {
        let (store, live, id) = (store.clone(), live.clone(), id.clone());
        move || build_response(&store, &live, &id)
    })
    .await;
    match body {
        Ok(Ok(Some(body))) => json_text(StatusCode::OK, &body),
        Ok(Ok(None)) => error(StatusCode::NOT_FOUND, "not found"),
        Ok(Err(e)) => failed("/[id]/description", e),
        Err(r) => *r,
    }
}

async fn regenerate(State(app): State<AppState>, Path(id): Path<String>) -> Response {
    let store = Store::from_env();
    if let Err(r) = existing(&store, &id, "/[id]/description", "not found") {
        return *r;
    }
    if let Err(r) = inside_root(&store, &id) {
        return *r;
    }
    let live = runtime_dir::live_source_dir();
    let env = DescribeEnv {
        claude_bin: app.mgr.runtime.lock().unwrap().claude_bin.clone(),
    };
    let result = describe_customization(&store, &live, &id, &env).await;
    let described = match result {
        Ok(d) => d,
        Err(e) => return failed("/[id]/description", e),
    };
    let (description, diff_hash) = match described {
        Described::Ok {
            description,
            diff_hash,
        } => (description, diff_hash),
        Described::Err(e) => return error(StatusCode::UNPROCESSABLE_ENTITY, &e),
    };
    match store.set_customization_description(&id, &description, &diff_hash) {
        Ok(Some(_)) => written(store, live, id).await,
        Ok(None) => error(StatusCode::INTERNAL_SERVER_ERROR, "failed to persist"),
        Err(e) => failed("/[id]/description", e),
    }
}

async fn set_description(Path(id): Path<String>, body: Bytes) -> Response {
    let store = Store::from_env();
    if let Err(r) = existing(&store, &id, "/[id]/description", "not found") {
        return *r;
    }
    let Some(b) = patch_body(&body) else {
        return error(StatusCode::BAD_REQUEST, "invalid json");
    };
    // `payload.description` throws on a `null` body.
    let text = match tri!(js_member(&b, "description")) {
        Some(Value::String(s)) => s.clone(),
        _ => return error(StatusCode::BAD_REQUEST, "description must be a string"),
    };
    match store.set_customization_description_manual(&id, &text) {
        Ok(Some(_)) => written(store, runtime_dir::live_source_dir(), id).await,
        Ok(None) => error(StatusCode::INTERNAL_SERVER_ERROR, "failed to persist"),
        Err(e) => failed("/[id]/description", e),
    }
}

// ---- /api/customizations/:id/build-app ----------------------------------------------

async fn build_state(Path(id): Path<String>) -> Response {
    let store = Store::from_env();
    if let Err(r) = existing(&store, &id, "/[id]/build-app", "not found") {
        return *r;
    }
    let live = runtime_dir::live_source_dir();
    json_text(
        StatusCode::OK,
        &json!({
            "availability": build_availability(&live),
            "state": get_build_state(&id),
        }),
    )
}

async fn build_start(Path(id): Path<String>) -> Response {
    let store = Store::from_env();
    if let Err(r) = existing(&store, &id, "/[id]/build-app", "not found") {
        return *r;
    }
    let live = runtime_dir::live_source_dir();
    let availability = build_availability(&live);
    if availability["available"] != json!(true) {
        let reason = availability["reason"].as_str().unwrap_or("").to_owned();
        return error(StatusCode::BAD_REQUEST, &reason);
    }
    if let Err(r) = inside_root(&store, &id) {
        return *r;
    }
    // `startBuild` spawns the child; the walk before it is blocking.
    let started = blocking("/[id]/build-app", move || start_build(&store, &live, &id)).await;
    match started {
        Ok(Ok(state)) => json_text(StatusCode::OK, &state),
        Ok(Err(e)) => error(StatusCode::INTERNAL_SERVER_ERROR, &message(&e)),
        Err(r) => *r,
    }
}

// ---- /api/customizations/:id/publish ------------------------------------------------

async fn publish(Path(id): Path<String>) -> Response {
    let store = Store::from_env();
    if let Err(r) = existing(&store, &id, "/[id]/publish", "not found") {
        return *r;
    }
    if let Err(r) = inside_root(&store, &id) {
        return *r;
    }
    let live = runtime_dir::live_source_dir();
    let done = blocking("/[id]/publish", move || {
        customization_publish::publish_customization(&store, &live, &id)
    })
    .await;
    match done {
        Ok(Ok(rec)) => json_text(StatusCode::CREATED, &rec),
        Ok(Err(e)) => error(StatusCode::INTERNAL_SERVER_ERROR, &message(&e)),
        Err(r) => *r,
    }
}

// ---- /api/customizations/:id/auto-fix -----------------------------------------------

async fn auto_fix(Path(id): Path<String>) -> Response {
    let store = Store::from_env();
    if let Err(r) = existing(&store, &id, "/[id]/auto-fix", "customization not found") {
        return *r;
    }
    if let Err(r) = inside_root(&store, &id) {
        return *r;
    }
    let live = runtime_dir::live_source_dir();
    let status = blocking("/[id]/auto-fix", move || {
        compute_sync_status(&store, &live, &id)
    })
    .await;
    let status = match status {
        // `computeSyncStatus` is not caught here: a failure is a bare 500.
        Ok(Ok(s)) => s,
        Ok(Err(e)) => return failed("/[id]/auto-fix", e),
        Err(r) => return *r,
    };
    let paths: Vec<&str> = status
        .entries
        .iter()
        .filter(|e| e.verdict == Verdict::Conflict)
        .map(|e| e.path.as_str())
        .collect();
    if paths.is_empty() {
        return error(StatusCode::BAD_REQUEST, "no conflicts to fix");
    }
    // `getSettings()` is not caught either.
    let settings = match customize_settings::get_settings() {
        Ok(s) => s,
        Err(e) => return failed("/[id]/auto-fix", e),
    };
    let template = settings[customize_settings::AUTO_FIX_PROMPT]
        .as_str()
        .unwrap_or_default();
    let composed = customization_auto_fix::compose_prompt(template, &paths);
    json_text(
        StatusCode::OK,
        &json!({"prompt": composed, "conflictCount": paths.len()}),
    )
}

// ---- /api/customizations/:id/deactivate and .../publishes/:pubId/revert -------------

/// `String(p.id)`, as `execFile` coerces an argument that isn't a string
/// (libuv takes the array's `Utf8Value`); an object with no primitive is
/// the `TypeError` the TS catch reports.
fn arg_text(v: Option<&Value>) -> Result<String, String> {
    match v {
        None => Ok("undefined".to_owned()),
        Some(v) => js_string::to_js_string(v)
            .map_err(|_| "Cannot convert object to primitive value".to_owned()),
    }
}

async fn deactivate(Path(id): Path<String>) -> Response {
    let store = Store::from_env();
    if let Err(r) = existing(&store, &id, "/[id]/deactivate", "not found") {
        return *r;
    }
    let publishes = match store.list_publishes(Some(&id)) {
        Ok(p) => p,
        Err(e) => return failed("/[id]/deactivate", e),
    };
    let mut active: Vec<&Value> = publishes
        .iter()
        .filter(|p| p.get("revertedAt").is_none_or(Value::is_null))
        .collect();
    // `.sort((a, b) => b.publishedAt - a.publishedAt)`, as V8 sorts.
    let keys: Vec<_> = active
        .iter()
        .map(|p| js_string::to_js_number(p.get("publishedAt")))
        .collect();
    if active.len() > 1 && keys.iter().any(Result::is_err) {
        return failed(
            "/[id]/deactivate",
            "Cannot convert object to primitive value",
        );
    }
    let mut keyed: Vec<(f64, &Value)> = keys
        .into_iter()
        .map(|k| k.unwrap_or(f64::NAN))
        .zip(active.drain(..))
        .collect();
    claudius_core::asset_list::v8_sort(&mut keyed, |a, b| b.0 - a.0);
    if keyed.is_empty() {
        return json_text(
            StatusCode::OK,
            &json!({"ok": true, "reverted": 0, "alreadyInactive": true}),
        );
    }
    let live = runtime_dir::live_source_dir();
    let node = customization_revert::node_program();
    let mut reverted = 0u64;
    let mut errors: Vec<Value> = Vec::new();
    for (_, p) in keyed {
        let raw = p.get("id");
        let failure = match arg_text(raw) {
            Ok(pub_id) => customization_revert::revert_publish(&node, &live, &pub_id)
                .await
                .err()
                .map(|e| e.message),
            Err(e) => Some(e),
        };
        match failure {
            None => reverted += 1,
            Some(e) => {
                let mut entry = Map::new();
                if let Some(v) = raw {
                    entry.insert("publishId".into(), v.clone());
                }
                entry.insert("error".into(), json!(e));
                errors.push(Value::Object(entry));
            }
        }
    }
    if errors.is_empty() {
        return json_text(StatusCode::OK, &json!({"ok": true, "reverted": reverted}));
    }
    json_text(
        StatusCode::from_u16(207).expect("207 is a status"),
        &json!({"ok": reverted > 0, "reverted": reverted, "errors": errors}),
    )
}

async fn revert(Path((id, pub_id)): Path<(String, String)>) -> Response {
    let store = Store::from_env();
    let route = "/[id]/publishes/[pubId]/revert";
    if let Err(r) = existing(&store, &id, route, "customization not found") {
        return *r;
    }
    let publishes = match store.list_publishes(Some(&id)) {
        Ok(p) => p,
        Err(e) => return failed(route, e),
    };
    let target = json!(pub_id);
    let Some(p) = publishes.iter().find(|p| p.get("id") == Some(&target)) else {
        return error(StatusCode::NOT_FOUND, "publish not found");
    };
    if !p.get("revertedAt").is_none_or(Value::is_null) {
        return json_text(
            StatusCode::OK,
            &json!({"ok": true, "alreadyReverted": true}),
        );
    }
    let live = runtime_dir::live_source_dir();
    let node = customization_revert::node_program();
    match customization_revert::revert_publish(&node, &live, &pub_id).await {
        Ok(out) => json_text(
            StatusCode::OK,
            &json!({"ok": true, "stdout": out.stdout, "stderr": out.stderr}),
        ),
        Err(e) => error(StatusCode::INTERNAL_SERVER_ERROR, &e.message),
    }
}
