//! `/api/sessions/**` — ports of `app/api/sessions/**/route.ts`.
//!
//! Live sessions exist only in this process, so every `/api/sessions/:id/*`
//! route is served here: ported ones mirror the TS handlers' status codes
//! and JSON shapes; the rest answer 501 rather than being proxied (Next would
//! otherwise resume a *second* CLI for the same session id).

use std::collections::HashMap;
use std::time::Duration;

use axum::Router;
use axum::body::{Body, Bytes};
use axum::extract::{Path, Query, RawQuery, State};
use axum::http::{HeaderMap, HeaderValue, StatusCode, header};
use axum::response::{IntoResponse, Response};
use axum::routing::{any, get, patch, post};
use claudius_core::managed_settings;
use claudius_core::session::create_options;
use claudius_core::session::{
    PermissionDecision, PlanDecision, SendOptions, Session, TodoItemAction, TodosClearReason,
    TurnStatus,
};
use claudius_core::session_manager::last_recorded_permission_mode;
use claudius_core::{is_uuid, sessions_db, sessions_store, settings, trusted_cwd, workspaces};
use futures::StreamExt;
use serde_json::{Map, Value, json};
use std::sync::Arc;

use crate::AppState;
use crate::body::{JsonBody, Rejection, js_member, js_truthy};
use crate::dev::{DevRefusal, dev_only};
use crate::tri;
use claudius_core::log;

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/api/sessions", get(list).post(create))
        .route("/api/sessions/rename", post(rename))
        .route("/api/sessions/{id}/stream", get(stream))
        .route("/api/sessions/{id}/input", post(input))
        .route("/api/sessions/{id}/interrupt", post(interrupt))
        .route("/api/sessions/{id}/permission", post(permission))
        .route("/api/sessions/{id}/ask-answer", post(ask_answer))
        .route("/api/sessions/{id}/plan", post(plan))
        .route("/api/sessions/{id}/elicitation", post(elicitation))
        .route("/api/sessions/{id}/mode", get(mode_get).post(mode_post))
        .route("/api/sessions/{id}/model", get(model_get).post(model_post))
        .route("/api/sessions/{id}/effort", post(effort_post))
        .route("/api/sessions/{id}/fast", post(fast_post))
        .route("/api/sessions/{id}/ultracode", post(ultracode_post))
        .route("/api/sessions/{id}/agent", get(agent_get).post(agent_post))
        .route("/api/sessions/{id}/agents", get(agents_get))
        .route("/api/sessions/{id}/clear-todos", post(clear_todos))
        .route("/api/sessions/{id}/todos/{item_id}", post(todo_item))
        .route(
            "/api/sessions/{id}/output-style",
            get(output_style_get).patch(output_style_patch),
        )
        .route("/api/sessions/{id}/goal", post(goal))
        .route("/api/sessions/{id}/holder", patch(holder))
        .route("/api/sessions/{id}/pending-prompts", get(pending_prompts))
        .route("/api/sessions/{id}/queue/send-all", post(queue_send_all))
        .route(
            "/api/sessions/{id}/queue/{uuid}",
            axum::routing::delete(queue_delete),
        )
        .route("/api/sessions/{id}/queue/{uuid}/move", post(queue_move))
        .route(
            "/api/sessions/{id}/queue/{uuid}/send-now",
            post(queue_send_now),
        )
        .route("/api/sessions/{id}/commands", get(commands))
        .route("/api/sessions/{id}/context", get(context))
        .route("/api/sessions/{id}/usage-behaviors", get(usage_behaviors))
        .route("/api/sessions/{id}/denials", get(denials))
        .route("/api/sessions/{id}/stop-task", post(stop_task))
        .route("/api/sessions/{id}/mcp-dynamic", post(mcp_dynamic))
        .route("/api/sessions/{id}/background-task", post(background_task))
        .route("/api/sessions/{id}/bash", post(bash))
        .route("/api/sessions/{id}/recap", post(recap))
        .route("/api/sessions/{id}/rewind", post(rewind))
        .route(
            "/api/sessions/{id}/transcript",
            get(crate::session_transcript::transcript),
        )
        .route(
            "/api/sessions/{id}/search",
            get(crate::session_transcript::search),
        )
        .route(
            "/api/sessions/{id}/prompt-draft",
            get(prompt_draft_get)
                .put(prompt_draft_put)
                .delete(prompt_draft_delete),
        )
        .route("/api/sessions/{id}/goal-messages", get(goal_messages))
        .route(
            "/api/sessions/{id}/suggested-messages",
            get(suggested_messages),
        )
        .route(
            "/api/sessions/{id}/prompt-color",
            get(prompt_color_get).post(prompt_color_post),
        )
        .route(
            "/api/sessions/{id}/notification-prefs",
            get(crate::notification_prefs::get).post(crate::notification_prefs::post),
        )
        .route(
            "/api/sessions/{id}/advisor",
            get(advisor_get).post(advisor_post),
        )
        .route("/api/sessions/{id}/dev-broadcast", post(dev_broadcast))
        .route("/api/sessions/{id}/dev-reap", post(dev_reap))
        .route(
            "/api/sessions/{id}/dev-inject-denial",
            post(dev_inject_denial),
        )
        // The collection routes are `sessions_collection` (D19) and
        // `worktrees` (`/api/sessions/fork`, D05).
        .route("/api/sessions/{id}/{*rest}", any(not_ported))
}

fn json(status: StatusCode, v: Value) -> Response {
    (status, axum::Json(v)).into_response()
}
fn ok(v: Value) -> Response {
    json(StatusCode::OK, v)
}
/// A 200 whose body is `JSON.stringify(v)`: for bodies built from parsed
/// CLI data, which JS re-prints (number forms, array-index keys first).
fn js_ok(v: &Value) -> Response {
    (
        StatusCode::OK,
        [(header::CONTENT_TYPE, "application/json")],
        claudius_agent::js::stringify(v),
    )
        .into_response()
}
fn err(status: StatusCode, msg: &str) -> Response {
    json(status, json!({"error": msg}))
}
fn not_found() -> Response {
    err(StatusCode::NOT_FOUND, "session not found")
}

/// `deadSessionResponse(live)`: what the write routes answer when
/// `restart_if_dead` couldn't hand back a live session (CC 2.1.311).
fn dead_session(reason: &claudius_core::session_manager::DeadReason) -> Response {
    let (message, status) = claudius_core::session_manager::dead_session_response(reason);
    err(
        StatusCode::from_u16(status).unwrap_or(StatusCode::SERVICE_UNAVAILABLE),
        &message,
    )
}

fn session(app: &AppState, id: &str) -> Option<Arc<Session>> {
    app.mgr.get(id)
}

async fn not_ported(Path((id, rest)): Path<(String, String)>) -> Response {
    json(
        StatusCode::NOT_IMPLEMENTED,
        json!({"error": format!("/api/sessions/{{id}}/{rest} is not yet ported to the Rust backend"), "notPorted": true, "sessionId": id}),
    )
}

fn cookie(headers: &HeaderMap, name: &str) -> Option<String> {
    headers
        .get_all(header::COOKIE)
        .iter()
        .filter_map(|v| v.to_str().ok())
        .flat_map(|v| v.split(';'))
        .find_map(|kv| {
            let (k, v) = kv.trim().split_once('=')?;
            (k == name && !v.is_empty()).then(|| v.to_owned())
        })
}

// ─────────────────────────────── list / create ───────────────────────────────

async fn list(State(app): State<AppState>, RawQuery(q): RawQuery) -> Response {
    // `url.searchParams.get(…)`: the first pair of that name.
    let param = |k: &str| {
        crate::session_transcript::search_param(q.as_deref(), k).filter(|s| !s.is_empty())
    };
    let filter: Option<String> = if let Some(c) = param("customizationId") {
        Some(claudius_core::customizations::customization_src_dir(&c))
    } else if let Some(w) = param("workspaceId") {
        workspaces::get(&w).ok().flatten().map(|w| w.root_path)
    } else {
        None
    };
    let out: Vec<Value> = app
        .mgr
        .list()
        .into_iter()
        .filter(|s| filter.as_ref().is_none_or(|f| *f == s.cwd))
        .map(|s| {
            // `model: s.model` (left out while unset), then the account the
            // session is pinned to, each only when it's a non-empty string.
            let mut row = Map::new();
            row.insert("id".into(), json!(s.id));
            row.insert("cwd".into(), json!(s.cwd));
            if let Some(m) = s.model() {
                row.insert("model".into(), json!(m));
            }
            row.insert("title".into(), json!(s.title()));
            row.insert("createdAt".into(), json!(s.created_at));
            row.insert("status".into(), json!(s.status().as_str()));
            let pin = s.account_pin();
            if let Some(a) = pin.id.filter(|a| !a.is_empty()) {
                row.insert("accountId".into(), json!(a));
            }
            if let Some(l) = pin.label.filter(|l| !l.is_empty()) {
                row.insert("accountLabel".into(), json!(l));
            }
            Value::Object(row)
        })
        .collect();
    ok(Value::Array(out))
}

const MAX_INITIAL_DRAFT_TEXT: usize = 200_000;

/// JS `s.length > max ? s.slice(0, max) : s` — lengths in UTF-16 units.
fn js_truncate(s: &str, max: usize) -> String {
    if s.encode_utf16().count() > max {
        String::from_utf16_lossy(&s.encode_utf16().take(max).collect::<Vec<_>>())
    } else {
        s.to_owned()
    }
}

/// `mergeSessionDefaults(body, defaults)` — request fields win.
fn merge_defaults(body: &Map<String, Value>, defaults: &Map<String, Value>) -> Map<String, Value> {
    const KEYS: [&str; 17] = [
        "model",
        "agent",
        "maxBudgetUsd",
        "taskBudgetTokens",
        "maxTurns",
        "fallbackModel",
        "sandboxEnabled",
        "sandboxFilesystemDisabled",
        "sandboxNetworkAllowedDomains",
        "sandboxNetworkStrictAllowlist",
        "enable1mContext",
        "persistSession",
        "additionalDirectories",
        "systemPromptAppend",
        "planModeInstructions",
        "permissionMode",
        "restrictedMode",
    ];
    let mut out = Map::new();
    for k in KEYS {
        let v = body
            .get(k)
            .filter(|v| !v.is_null())
            .or_else(|| defaults.get(k).filter(|v| !v.is_null()));
        if let Some(v) = v {
            out.insert(k.into(), v.clone());
        }
    }
    out
}

async fn create(State(app): State<AppState>, headers: HeaderMap, body: Bytes) -> Response {
    // try { body = await req.json() } catch { body = {} }; then `body.resume`
    // (no `?.`), so a literal `null` body throws.
    let parsed = JsonBody::lenient(&body, json!({}));
    tri!(js_member(&parsed, "resume"));
    let body = parsed.as_object().cloned().unwrap_or_default();
    let resume = body
        .get("resume")
        .and_then(Value::as_str)
        .map(str::to_owned);
    if body.get("resume").is_some_and(Value::is_string) && !resume.as_deref().is_some_and(is_uuid) {
        return err(StatusCode::BAD_REQUEST, "invalid resume id");
    }
    let mut cwd: Option<String> = None;
    // `if (body.cwd)`: a truthy non-string is resolved too, and resolving
    // anything that isn't a non-blank string yields the first trusted root
    // (`process.cwd()`), never a 400.
    if let Some(c) = body.get("cwd").filter(|c| claudius_agent::js::truthy(c)) {
        match trusted_cwd::resolve_trusted_cwd(c.as_str()) {
            Some(t) => cwd = Some(t),
            None => return err(StatusCode::BAD_REQUEST, "unknown cwd"),
        }
    }
    let all = workspaces::list().unwrap_or_default();
    let mut origin: Option<workspaces::Workspace> = None;
    if cwd.is_none()
        && let Some(r) = &resume
        && let Some((wt, source)) = trusted_cwd::fork_worktree_cwd(r)
    {
        cwd = Some(wt);
        origin = all.iter().find(|w| w.root_path == source).cloned();
    }
    if cwd.is_none()
        && let Some(r) = &resume
    {
        cwd = sessions_store::info(r, None)
            .and_then(|i| i.cwd)
            .filter(|c| !c.is_empty());
    }
    if cwd.is_none() {
        let cust = cookie(&headers, "claudius.customization").filter(|id| {
            matches!(
                claudius_core::customizations::get_customization(id),
                Ok(Some(_))
            )
        });
        if let Some(c) = cust {
            cwd = Some(claudius_core::customizations::customization_src_dir(&c));
        } else if let Ok(Some(ws)) =
            workspaces::resolve_active(cookie(&headers, "claudius.workspace").as_deref())
        {
            cwd = Some(ws.root_path.clone());
            origin = Some(ws);
        }
    } else if !trusted_cwd::is_customization_cwd(cwd.as_deref().unwrap()) && origin.is_none() {
        origin = all
            .iter()
            .find(|w| Some(&w.root_path) == cwd.as_ref())
            .cloned();
    }
    let defaults: Map<String, Value> = if cwd
        .as_deref()
        .is_some_and(trusted_cwd::is_customization_cwd)
    {
        let mut m = Map::new();
        m.insert("permissionMode".into(), json!("bypassPermissions"));
        m
    } else {
        origin
            .as_ref()
            .and_then(|w| w.defaults.clone())
            .unwrap_or_default()
    };
    // TS hands every field to `new Session` untyped: each option has its own
    // test there, and a wrong type is dropped, printed with `${}` or fails
    // the start — never a 400 (S27d).
    let merged = merge_defaults(&body, &defaults);
    let mut opts = create_options::from_create_body(&merged, &body);
    if resume.is_some() && body.get("permissionMode").is_none_or(Value::is_null) && cwd.is_some() {
        let was = match app.mgr.get(resume.as_deref().unwrap()) {
            Some(s) => Some(s.permission_mode()),
            None => {
                last_recorded_permission_mode(resume.as_deref().unwrap(), cwd.as_deref().unwrap())
            }
        };
        if was.as_deref() == Some("plan") {
            opts.permission_mode = Some("plan".into());
        }
    }
    opts.cwd = cwd;
    opts.resume = resume;
    let effective_mode = opts.permission_mode.clone();
    let s = match app.mgr.create(opts).await {
        Ok(s) => s,
        Err(e) => {
            tracing::error!(target: log::API, "[api/sessions] sessionManager.create failed: {e}");
            return json(
                StatusCode::INTERNAL_SERVER_ERROR,
                json!({"error": e.to_string(), "name": e.name()}),
            );
        }
    };
    // Outside the create's try in TS: a throw is Next's bare 500.
    if let Some(m) = effective_mode
        && s.permission_mode() != m
        && s.try_set_permission_mode(&m, false).await.is_err()
    {
        return crate::body::thrown();
    }
    if let Some(d) = body
        .get("initialDraftText")
        .and_then(Value::as_str)
        .filter(|d| !d.is_empty())
    {
        let trimmed = js_truncate(d, MAX_INITIAL_DRAFT_TEXT);
        if let Err(e) = sessions_db::set_prompt_draft(&s.cwd, &s.id, &trimmed, &json!([])) {
            tracing::error!(target: log::API, "[api/sessions] initialDraftText write failed: {e}");
        }
    }
    let mut out = json!({"id": s.id, "cwd": s.cwd});
    // `{ …, model: session.model }`: the body's own value, and no key at all
    // when the session has no model (`undefined`).
    let model = s.model_value();
    if !model.is_null() {
        out["model"] = model;
    }
    ok(out)
}

async fn rename(State(app): State<AppState>, body: Bytes) -> Response {
    let b = tri!(JsonBody::strict(&body));
    // CC 2.1.309: the title is trimmed once here, so whitespace alone is the
    // 400 and every write below gets the trimmed name.
    let title = b["title"]
        .as_str()
        .map(claudius_agent::js::trim)
        .unwrap_or("");
    let (Some(id), false) = (
        b["sessionId"].as_str().filter(|s| !s.is_empty()),
        title.is_empty(),
    ) else {
        return err(StatusCode::BAD_REQUEST, "sessionId and title required");
    };
    if let Some(live) = app.mgr.get(id) {
        return match live.rename(title).await {
            Ok(()) => ok(json!({"ok": true})),
            Err(e) => err(StatusCode::INTERNAL_SERVER_ERROR, &e),
        };
    }
    // CC 2.1.309: a rename must win over a generated name after a reload or
    // resume, and every title reader prefers the sessions-index row over the
    // transcript's `customTitle`. The row goes first (same order as
    // `Session::rename`); the transcript write is then best effort when a row
    // was updated and required when none was.
    let indexed = sessions_db::retitle_indexed_session(id, title).unwrap_or(0);
    match sessions_store::rename(id, title, b["dir"].as_str()) {
        Ok(()) => ok(json!({"ok": true})),
        Err(_) if indexed > 0 => ok(json!({"ok": true})),
        Err(e) => err(StatusCode::INTERNAL_SERVER_ERROR, &e.to_string()),
    }
}

// ─────────────────────────────────── stream ──────────────────────────────────

async fn stream(
    State(app): State<AppState>,
    Path(id): Path<String>,
    Query(q): Query<HashMap<String, String>>,
) -> Response {
    let Some(s) = app.mgr.get_or_resume(&id).await else {
        return (StatusCode::NOT_FOUND, "session not found").into_response();
    };
    // `Math.max(0, Math.min(500, Number(tail) || 0))`
    let tail = q.get("tail").map(|t| {
        let n = t
            .trim()
            .parse::<f64>()
            .ok()
            .filter(|n| n.is_finite())
            .unwrap_or(0.0);
        n.clamp(0.0, 500.0) as usize
    });
    let tab_id = q.get("tabId").filter(|t| !t.is_empty()).cloned();
    s.resync_from_disk();
    // The trailing `ready` lands AFTER the replay, so it carries the resumed
    // transcript path too (CC 2.1.301). The client treats an absent field as
    // "no news", so a `ready` without one must not wipe it.
    let mut ready = json!({"type": "ready", "sessionId": id});
    if let Some(p) = s.resumed_transcript_path() {
        ready["transcriptPath"] = json!(p);
    }
    let sub = s.subscribe_with(tail, tab_id, &[ready]);
    let mut ping = tokio::time::interval_at(
        tokio::time::Instant::now() + Duration::from_secs(15),
        Duration::from_secs(15),
    );
    ping.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    let body = futures::stream::unfold((sub, ping), |(mut sub, mut ping)| async move {
        let chunk = tokio::select! {
            ev = sub.recv() => match ev {
                // `JSON.stringify(data)`: JS number text (`1e+21`, `2`).
                Some(ev) => {
                    let data = claudius_agent::js::stringify(&ev);
                    Bytes::from(format!("data: {data}\n\n"))
                }
                None => return None,
            },
            _ = ping.tick() => Bytes::from_static(b": ping\n\n"),
        };
        Some((Ok::<_, std::convert::Infallible>(chunk), (sub, ping)))
    });
    let mut resp = Response::new(Body::from_stream(body.boxed()));
    let h = resp.headers_mut();
    h.insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("text/event-stream"),
    );
    h.insert(
        header::CACHE_CONTROL,
        HeaderValue::from_static("no-cache, no-transform"),
    );
    h.insert("x-accel-buffering", HeaderValue::from_static("no"));
    resp
}

// ──────────────────────────────────── input ──────────────────────────────────

async fn input(State(app): State<AppState>, Path(id): Path<String>, body: Bytes) -> Response {
    // `req.json().catch(() => null)`, checked before any restart below, so an
    // empty (or cross-origin) POST can't spawn a CLI just to be told 400.
    let b = JsonBody::lenient(&body, Value::Null);
    let has_text = b["text"].as_str().is_some_and(|t| !t.is_empty());
    // `body.images` goes on as posted; `hasImages` is a non-empty array.
    let images = b.get("images");
    let has_images = images
        .and_then(Value::as_array)
        .is_some_and(|a| !a.is_empty());
    // `if (!body || (!hasText && !hasImages))`: a falsy body is a 400 too.
    if !js_truthy(Some(&b)) || (!has_text && !has_images) {
        return err(StatusCode::BAD_REQUEST, "text or images required");
    }
    // CC 2.1.311 — the CLI ended on its own (a crash, a non-zero exit):
    // `send_input` would silently drop this message while we answered `ok`.
    // `restart_if_dead` hands back the live session unchanged, rebuilds a dead
    // one from its transcript, or joins a rebuild another send started; if it
    // can't, say so instead of pretending the message went through.
    let s = match app.mgr.restart_if_dead(&id, false).await {
        Ok(live) => live.session,
        Err(reason) => return dead_session(&reason),
    };
    // `body.uuid ?? randomUUID()` and `body.text ?? ""`: what was posted, of
    // any type, goes everywhere TS hands it (S29a).
    let nullish = |k: &str, or: fn() -> Value| match &b[k] {
        Value::Null => or(),
        v => v.clone(),
    };
    let uuid = nullish("uuid", || json!(uuid::Uuid::new_v4().to_string()));
    let text = nullish("text", || json!(""));
    // `if (body.flag)`: JS truthiness (`0` and `""` are false too).
    let truthy = |k: &str| js_truthy(b.get(k));
    // Best-effort provenance bookkeeping: a failure never fails the send.
    if truthy("fromSuggestion")
        && let Err(e) = sessions_db::record_tagged_message(&s.cwd, false, &s.id, &uuid, &text)
    {
        tracing::warn!(target: log::API, "[input] recordSuggestedMessage: {e}");
    }
    if truthy("fromGoal")
        && let Err(e) = sessions_db::record_tagged_message(&s.cwd, true, &s.id, &uuid, &text)
    {
        tracing::warn!(target: log::API, "[input] recordGoalMessage: {e}");
    }
    if let Some(Value::Array(imgs)) = images.filter(|_| has_images) {
        // `void recordSendUses(…)`: the images into the Files page's store,
        // off the request; it never fails the send.
        let (cwd, sid, mid, imgs) = (s.cwd.clone(), s.id.clone(), uuid.clone(), imgs.clone());
        let now = claudius_core::now_ms() as f64;
        tokio::task::spawn_blocking(move || {
            claudius_core::asset_ingest::record_send_uses(&cwd, &sid, &mid, now, &imgs)
        });
    }
    let force_queue = truthy("forceQueue");
    let wait = !s.queue_dispatch_asap();
    let is_idle = s.status() == TurnStatus::Idle;
    let queue_len = s.queue_length();
    if force_queue || (wait && (!is_idle || queue_len > 0)) {
        return match s.enqueue_message(
            &text,
            images,
            Some(uuid.clone()),
            truthy("slash"),
            truthy("fromSuggestion"),
            truthy("fromGoal"),
        ) {
            Ok(_) => js_ok(&json!({"ok": true, "queued": true, "uuid": uuid})),
            Err(_) => crate::body::thrown(),
        };
    }
    let inline_pastes: Vec<String> = b
        .get("inlinePastes")
        .and_then(Value::as_array)
        // The body is untyped JSON: keep only real, non-empty strings.
        .map(|a| {
            a.iter()
                .filter_map(|x| x.as_str().filter(|p| !p.is_empty()).map(str::to_owned))
                .collect()
        })
        .unwrap_or_default();
    // `sendInput` throws (V8's TypeError) on images it can't iterate, or on
    // a `text` that isn't a string.
    let sent = s.send_input_value(
        &text,
        images,
        SendOptions {
            uuid: Some(uuid.clone()),
            slash: truthy("slash"),
            priority_now: false,
            inline_pastes,
        },
    );
    if let Err(e) = sent {
        tracing::error!(target: log::API, "[input] {e}");
        return crate::body::thrown();
    }
    js_ok(&json!({"ok": true, "queued": false, "uuid": uuid}))
}

async fn interrupt(State(app): State<AppState>, Path(id): Path<String>) -> Response {
    let Some(s) = session(&app, &id) else {
        return not_found();
    };
    let still = s.interrupt().await;
    ok(json!({"ok": true, "stillQueued": still}))
}

// ─────────────────────────────────── prompts ─────────────────────────────────

async fn permission(State(app): State<AppState>, Path(id): Path<String>, body: Bytes) -> Response {
    let Some(s) = session(&app, &id) else {
        return not_found();
    };
    let b = tri!(JsonBody::strict(&body));
    let (Some(rid), Some(dec)) = (
        b["requestId"].as_str().filter(|s| !s.is_empty()),
        b.get("decision").filter(|d| d.is_object()),
    ) else {
        return err(StatusCode::BAD_REQUEST, "requestId and decision required");
    };
    let Ok(decision) = serde_json::from_value::<PermissionDecision>(dec.clone()) else {
        return err(StatusCode::BAD_REQUEST, "requestId and decision required");
    };
    if !s.resolve_permission(rid, decision) {
        return err(StatusCode::NOT_FOUND, "no pending permission with that id");
    }
    ok(json!({"ok": true}))
}

async fn ask_answer(State(app): State<AppState>, Path(id): Path<String>, body: Bytes) -> Response {
    let Some(s) = session(&app, &id) else {
        return not_found();
    };
    let b = tri!(JsonBody::or_bad_request(&body, "invalid json"));
    let (Some(rid), Some(answers)) = (
        b["requestId"].as_str().filter(|s| !s.is_empty()),
        b["answers"].as_array(),
    ) else {
        return err(StatusCode::BAD_REQUEST, "requestId and answers required");
    };
    if !s.submit_ask_answer(rid, answers) {
        return ok(json!({"ok": false, "reason": "stale"}));
    }
    ok(json!({"ok": true}))
}

async fn plan(State(app): State<AppState>, Path(id): Path<String>, body: Bytes) -> Response {
    let Some(s) = session(&app, &id) else {
        return not_found();
    };
    let b = tri!(JsonBody::or_bad_request(&body, "invalid json"));
    let rid = b["requestId"].as_str().filter(|s| !s.is_empty());
    let decision = b
        .get("decision")
        .and_then(|d| serde_json::from_value::<PlanDecision>(d.clone()).ok());
    let (Some(rid), Some(decision)) = (rid, decision) else {
        return err(StatusCode::BAD_REQUEST, "requestId and decision required");
    };
    if !s.resolve_plan(rid, decision) {
        return ok(json!({"ok": false, "reason": "stale"}));
    }
    ok(json!({"ok": true}))
}

/// `parseElicitationDecision` limits.
fn parse_elicitation_decision(raw: &Value) -> Option<(String, Option<Value>)> {
    let o = raw.as_object()?;
    match o.get("action").and_then(Value::as_str)? {
        a @ ("decline" | "cancel") => Some((a.to_owned(), None)),
        "accept" => {
            let Some(content) = o.get("content") else {
                return Some(("accept".into(), None));
            };
            let c = content.as_object()?;
            if c.len() > 50 {
                return None;
            }
            for (k, v) in c {
                if ["__proto__", "constructor", "prototype"].contains(&k.as_str()) {
                    return None;
                }
                let okv = match v {
                    Value::String(s) => s.encode_utf16().count() <= 10_000,
                    Value::Bool(_) => true,
                    Value::Number(n) => n.as_f64().is_some_and(f64::is_finite),
                    Value::Array(a) => {
                        a.len() <= 200
                            && a.iter().all(|x| {
                                x.as_str()
                                    .is_some_and(|s| s.encode_utf16().count() <= 10_000)
                            })
                    }
                    _ => false,
                };
                if !okv {
                    return None;
                }
            }
            Some(("accept".into(), Some(content.clone())))
        }
        _ => None,
    }
}

async fn elicitation(State(app): State<AppState>, Path(id): Path<String>, body: Bytes) -> Response {
    let Some(s) = session(&app, &id) else {
        return not_found();
    };
    let b = JsonBody::lenient(&body, Value::Null);
    let rid = b["requestId"].as_str().unwrap_or("");
    let decision = b.get("decision").and_then(parse_elicitation_decision);
    let (false, Some((action, content))) = (rid.is_empty(), decision) else {
        return err(
            StatusCode::BAD_REQUEST,
            "requestId and a valid decision required",
        );
    };
    if !s.resolve_elicitation(rid, &action, content) {
        return err(StatusCode::NOT_FOUND, "no pending elicitation with that id");
    }
    ok(json!({"ok": true}))
}

async fn pending_prompts(State(app): State<AppState>, Path(id): Path<String>) -> Response {
    let Some(s) = session(&app, &id) else {
        return not_found();
    };
    let (asks, permissions, elicitations) = s.pending_prompts();
    ok(json!({"asks": asks, "permissions": permissions, "elicitations": elicitations}))
}

// ──────────────────────────────── mode / model ───────────────────────────────

const MODES: [&str; 6] = [
    "default",
    "acceptEdits",
    "auto",
    "dontAsk",
    "bypassPermissions",
    "plan",
];

async fn mode_post(State(app): State<AppState>, Path(id): Path<String>, body: Bytes) -> Response {
    let Some(s) = session(&app, &id) else {
        return not_found();
    };
    let b = JsonBody::lenient(&body, Value::Null);
    let Some(mode) = b["mode"].as_str().filter(|m| MODES.contains(m)) else {
        return err(StatusCode::BAD_REQUEST, "invalid mode");
    };
    if s.try_set_permission_mode(mode, false).await.is_err() {
        return crate::body::thrown();
    }
    ok(json!({"ok": true, "mode": mode}))
}

async fn mode_get(State(app): State<AppState>, Path(id): Path<String>) -> Response {
    let Some(s) = session(&app, &id) else {
        return not_found();
    };
    ok(json!({"mode": s.permission_mode()}))
}

async fn model_post(State(app): State<AppState>, Path(id): Path<String>, body: Bytes) -> Response {
    let Some(s) = session(&app, &id) else {
        return not_found();
    };
    let b = tri!(JsonBody::strict(&body));
    let model = b["model"]
        .as_str()
        .filter(|m| !m.is_empty())
        .map(str::to_owned);
    let source = if b["source"] == "chat_command" {
        "chat_command"
    } else {
        "picker"
    };
    match s.set_model(model, source).await {
        Ok(m) => ok(json!({"ok": true, "model": m})),
        Err((e, m)) => json(
            StatusCode::CONFLICT,
            json!({"ok": false, "error": e, "model": m}),
        ),
    }
}

/// `POST /:id/effort` `{level, ultracode?, sessionOnly?}`. Unlike `mode`,
/// the TS route doesn't guard its `req.json()` (a malformed body throws),
/// but `!body?.level` does let a `null` body through to the 400. Levels
/// outside the route's set are refused; the rest go to the CLI unchecked.
async fn effort_post(State(app): State<AppState>, Path(id): Path<String>, body: Bytes) -> Response {
    let Some(s) = session(&app, &id) else {
        return not_found();
    };
    let b = tri!(JsonBody::strict(&body));
    let Some(level) = b
        .get("level")
        .and_then(Value::as_str)
        .filter(|l| claudius_core::effort::EFFORT_LEVELS.contains(l))
    else {
        return err(StatusCode::BAD_REQUEST, "invalid effort level");
    };
    // CC 2.1.284: keep ultracode on across the change. CC 2.1.257:
    // `sessionOnly` applies the level live without saving it.
    s.set_effort(level, b["ultracode"] == true, b["sessionOnly"] == true)
        .await;
    ok(json!({"ok": true, "level": level}))
}

/// The `{enabled}` toggle body of `fast` and `ultracode`: strict
/// `req.json()`, then anything but a boolean `body?.enabled` is a 400.
fn toggle_body(body: &[u8]) -> Result<bool, Rejection> {
    let b = JsonBody::strict(body)?;
    b.get("enabled")
        .and_then(Value::as_bool)
        .ok_or(Rejection::BadRequest(
            "invalid 'enabled' (boolean required)",
        ))
}

/// `POST /:id/fast` `{enabled}`.
async fn fast_post(State(app): State<AppState>, Path(id): Path<String>, body: Bytes) -> Response {
    let Some(s) = session(&app, &id) else {
        return not_found();
    };
    let enabled = tri!(toggle_body(&body));
    s.set_fast(enabled).await;
    ok(json!({"ok": true, "enabled": enabled}))
}

/// `POST /:id/ultracode` `{enabled}`.
async fn ultracode_post(
    State(app): State<AppState>,
    Path(id): Path<String>,
    body: Bytes,
) -> Response {
    let Some(s) = session(&app, &id) else {
        return not_found();
    };
    let enabled = tri!(toggle_body(&body));
    s.set_ultracode(enabled).await;
    ok(json!({"ok": true, "enabled": enabled}))
}

/// `POST /:id/clear-todos`: the user's Clear. Resumes a reaped session
/// from disk first, so the click doesn't 404 after the idle reap. (The TS
/// route's 503 guards a dev-HMR stale prototype, which has no counterpart.)
async fn clear_todos(State(app): State<AppState>, Path(id): Path<String>) -> Response {
    let Some(s) = app.mgr.get_or_resume(&id).await else {
        return not_found();
    };
    s.clear_todos(TodosClearReason::Manual);
    ok(json!({"ok": true}))
}

/// `POST /:id/todos/:itemId` `{action}`: the user's per-item edit from the
/// banner or the rail (`complete` / `reopen` / `in_progress` / `delete`).
/// The body is checked before the session is looked up; a reaped session
/// is resumed. An empty or missing list, or an id not in it, is a 422 (the
/// list moved under the UI); any other failure a 500.
async fn todo_item(
    State(app): State<AppState>,
    Path((id, item_id)): Path<(String, String)>,
    body: Bytes,
) -> Response {
    if item_id.is_empty() {
        return err(StatusCode::BAD_REQUEST, "missing item id");
    }
    let b = tri!(JsonBody::or_bad_request(&body, "invalid JSON body"));
    let Some(action) = tri!(js_member(&b, "action"))
        .and_then(Value::as_str)
        .and_then(TodoItemAction::parse)
    else {
        return err(
            StatusCode::BAD_REQUEST,
            "action must be one of: complete, reopen, in_progress, delete",
        );
    };
    let Some(s) = app.mgr.get_or_resume(&id).await else {
        return not_found();
    };
    match s.update_todo_item(&item_id, action) {
        Ok(()) => ok(json!({"ok": true})),
        Err(e @ ("no active todo list" | "item not found")) => {
            err(StatusCode::UNPROCESSABLE_ENTITY, e)
        }
        Err(e) => err(StatusCode::INTERNAL_SERVER_ERROR, e),
    }
}

/// `GET /:id/agent`: the main-thread agent, `null` for the default one.
async fn agent_get(State(app): State<AppState>, Path(id): Path<String>) -> Response {
    let Some(s) = session(&app, &id) else {
        return not_found();
    };
    ok(json!({"agent": s.agent()}))
}

/// The `POST /:id/agent` body: `{agent: string | null}`. Unparseable JSON
/// is a 400; `const { agent } = body` throws on a `null` body (a bare 500)
/// but reads `undefined` off any other non-object.
fn agent_body(body: &[u8]) -> Result<Option<String>, Rejection> {
    let b = JsonBody::or_bad_request(body, "invalid JSON body")?;
    match js_member(&b, "agent")? {
        Some(Value::Null) => Ok(None),
        Some(Value::String(a)) => Ok(Some(a.clone())),
        Some(_) => Err(Rejection::BadRequest("agent must be a string or null")),
        None => Err(Rejection::BadRequest(
            "agent field is required (pass null to reset to default)",
        )),
    }
}

/// `POST /:id/agent` `{agent}`: switch (a name) or reset (`null`).
async fn agent_post(State(app): State<AppState>, Path(id): Path<String>, body: Bytes) -> Response {
    let Some(s) = session(&app, &id) else {
        return not_found();
    };
    let agent = tri!(agent_body(&body));
    s.set_agent(agent.as_deref()).await;
    ok(json!({"ok": true, "agent": agent}))
}

/// `GET /:id/agents`: the agents the CLI loaded, `(await
/// query.supportedAgents())` = the initialize response's `agents`. Read raw
/// (not through `QueryHandle::supported_agents`, which defaults to `[]`) so
/// a response without the key answers `{}` as `{agents: undefined}` does.
/// No live query, a failed initialize or a `null` response is a 503.
async fn agents_get(State(app): State<AppState>, Path(id): Path<String>) -> Response {
    let Some(s) = session(&app, &id) else {
        return not_found();
    };
    let Some(h) = s.query_handle() else {
        return err(StatusCode::SERVICE_UNAVAILABLE, "session not active");
    };
    let message = match h.initialization_result().await {
        Ok(Value::Null) => "Cannot read properties of null (reading 'agents')".to_owned(),
        Ok(data) => {
            let mut out = Map::new();
            if let Some(a) = data.get("agents") {
                out.insert("agents".into(), a.clone());
            }
            return ok(Value::Object(out));
        }
        Err(e) => e.to_string(),
    };
    tracing::error!(target: log::API, "[api/sessions/agents] GET failed {message}");
    err(StatusCode::SERVICE_UNAVAILABLE, &message)
}

/// `STATIC_OUTPUT_STYLES` (lib/shared/output-styles.ts): the list GET falls
/// back to without a live CLI.
pub const STATIC_OUTPUT_STYLES: [&str; 4] = ["default", "explanatory", "concise", "developer"];

/// The GET body from the CLI's `initializationResult()`, or the fallback
/// when there's none (`None`: no CLI, or the call failed). The CLI's
/// `available_output_styles` is used only when it's a non-empty array (its
/// items pass through unchecked), and `output_style ?? "default"` keeps any
/// non-null value.
pub fn output_style_view(init: Option<&Value>) -> Value {
    let Some(data) = init else {
        return json!({"current": "default", "available": STATIC_OUTPUT_STYLES, "source": "fallback"});
    };
    let available = data
        .get("available_output_styles")
        .filter(|a| a.as_array().is_some_and(|a| !a.is_empty()))
        .cloned()
        .unwrap_or_else(|| json!(STATIC_OUTPUT_STYLES));
    let current = data
        .get("output_style")
        .filter(|c| !c.is_null())
        .cloned()
        .unwrap_or_else(|| json!("default"));
    json!({"current": current, "available": available, "source": "session"})
}

/// `GET /:id/output-style`: `{current, available, source}`.
async fn output_style_get(State(app): State<AppState>, Path(id): Path<String>) -> Response {
    let Some(s) = session(&app, &id) else {
        return not_found();
    };
    if let Some(h) = s.query_handle() {
        match h.initialization_result().await {
            // `data.output_style` on `null` throws, like a failed call.
            Ok(data) if !data.is_null() => return ok(output_style_view(Some(&data))),
            Ok(_) => {
                tracing::error!(target: log::API, "[api/sessions/output-style] GET failed TypeError: Cannot read properties of null (reading 'available_output_styles')")
            }
            Err(e) => {
                tracing::error!(target: log::API, "[api/sessions/output-style] GET failed {e}")
            }
        }
    }
    ok(output_style_view(None))
}

/// `PATCH /:id/output-style` `{outputStyle}`: a bad body reads as missing
/// (`.catch(() => null)`), but `body?.outputStyle?.trim()` on a non-string
/// value throws (`trim` isn't a function there), which Next answers with a
/// bare 500.
async fn output_style_patch(
    State(app): State<AppState>,
    Path(id): Path<String>,
    body: Bytes,
) -> Response {
    let Some(s) = session(&app, &id) else {
        return not_found();
    };
    let b = JsonBody::lenient(&body, Value::Null);
    let name = match b.get("outputStyle") {
        None | Some(Value::Null) => "",
        Some(Value::String(n)) => claudius_agent::js::trim(n),
        Some(_) => return crate::body::thrown(),
    };
    if name.is_empty() {
        return err(StatusCode::BAD_REQUEST, "outputStyle is required");
    }
    match s.set_output_style(name).await {
        Ok(n) => ok(json!({"ok": true, "outputStyle": n})),
        Err(e) => json(
            StatusCode::INTERNAL_SERVER_ERROR,
            json!({"ok": false, "error": e}),
        ),
    }
}

async fn model_get(State(app): State<AppState>, Path(id): Path<String>) -> Response {
    let Some(s) = session(&app, &id) else {
        return not_found();
    };
    let Some(h) = s.query_handle() else {
        return err(StatusCode::SERVICE_UNAVAILABLE, "session not active");
    };
    // `await query.supportedModels()`: the initialize reply's `models`.
    let sdk = match h.initialization_result().await {
        Ok(init) => init.get("models").cloned(),
        Err(e) => {
            tracing::error!(target: log::API, "[api/sessions/model] GET failed: {e}");
            return err(StatusCode::SERVICE_UNAVAILABLE, &e.to_string());
        }
    };
    let policy = managed_settings::resolve_managed_model_policy(&s.cwd);
    let picker = crate::models::user_model_picker();
    match claudius_core::models::session_model_list(sdk, &policy, picker.as_ref()) {
        Ok(models) => js_ok(&json!({"models": models})),
        Err(e) => {
            tracing::error!(target: log::API, "[api/sessions/model] GET failed: TypeError: {e}");
            err(StatusCode::SERVICE_UNAVAILABLE, &e)
        }
    }
}

async fn commands(State(app): State<AppState>, Path(id): Path<String>) -> Response {
    let Some(s) = session(&app, &id) else {
        return not_found();
    };
    let Some(h) = s.query_handle() else {
        return err(StatusCode::SERVICE_UNAVAILABLE, "session not active");
    };
    match h.supported_commands().await {
        Ok(c) => ok(json!({"commands": c})),
        Err(e) => {
            tracing::error!(target: log::API, "[api/sessions/commands] GET failed: {e}");
            err(StatusCode::SERVICE_UNAVAILABLE, &e.to_string())
        }
    }
}

async fn context(
    State(app): State<AppState>,
    Path(id): Path<String>,
    Query(q): Query<HashMap<String, String>>,
) -> Response {
    let Some(s) = app.mgr.get_or_resume(&id).await else {
        return not_found();
    };
    let summary = q.get("detail").map(String::as_str) == Some("summary");
    let data = match s.get_context_usage(summary).await {
        Ok(data) => data,
        Err(e) => return err(StatusCode::INTERNAL_SERVER_ERROR, &e),
    };
    if summary {
        return js_ok(&data);
    }
    // The full `/context` overlay fetch also gets the week's used skills
    // (`null` when unknown): `{ ...data, weeklyUsedSkills }`.
    let weekly = s.get_weekly_used_skills().await;
    js_ok(&claudius_core::usage_behaviors::with_weekly_used_skills(
        &data, weekly,
    ))
}

/// `GET /:id/usage-behaviors`: `{behaviors}` for the Cost overlay, `null`
/// (still a 200) when the CLI has none. Resumes a reaped session.
async fn usage_behaviors(State(app): State<AppState>, Path(id): Path<String>) -> Response {
    let Some(s) = app.mgr.get_or_resume(&id).await else {
        return not_found();
    };
    js_ok(&json!({"behaviors": s.get_usage_behaviors().await}))
}

async fn denials(State(app): State<AppState>, Path(id): Path<String>) -> Response {
    let Some(s) = session(&app, &id) else {
        return not_found();
    };
    ok(json!({"denials": s.recent_denials()}))
}

async fn stop_task(State(app): State<AppState>, Path(id): Path<String>, body: Bytes) -> Response {
    let Some(s) = session(&app, &id) else {
        return not_found();
    };
    let b = JsonBody::lenient(&body, json!({}));
    let Some(task) = b["taskId"].as_str().filter(|t| !t.is_empty()) else {
        return err(StatusCode::BAD_REQUEST, "taskId required");
    };
    match s.stop_task(task).await {
        Ok(()) => ok(json!({"ok": true})),
        Err(e) => err(StatusCode::SERVICE_UNAVAILABLE, &e),
    }
}

/// `POST /:id/background-task` (Ctrl+B): `{toolUseId?}` backgrounds that
/// blocking task, else every foreground one. Live sessions only (404); 503
/// without a query or when the CLI refuses.
async fn background_task(
    State(app): State<AppState>,
    Path(id): Path<String>,
    body: Bytes,
) -> Response {
    let Some(s) = session(&app, &id) else {
        return not_found();
    };
    // `req.json().catch(() => ({}))`, then `body?.toolUseId` only if a string.
    let b = JsonBody::lenient(&body, json!({}));
    match s.background_tasks(b["toolUseId"].as_str()).await {
        Ok(backgrounded) => ok(json!({"ok": true, "backgrounded": backgrounded})),
        Err(e) => err(StatusCode::SERVICE_UNAVAILABLE, &e),
    }
}

/// `POST /:id/mcp-dynamic`: replace the live session's SDK-added MCP
/// servers with `{servers}`. `{}` removes them all, and file-configured
/// servers are left alone. 404 for an unknown session, 400 without a
/// `servers` object, 503 with the error (no query, or the CLI refused),
/// else 200 `{result}`: the CLI's add/remove/error report.
async fn mcp_dynamic(State(app): State<AppState>, Path(id): Path<String>, body: Bytes) -> Response {
    let Some(s) = session(&app, &id) else {
        return not_found();
    };
    // `req.json().catch(() => ({}))`; `servers` must be an object, not null
    // or an array (a `null` body fails `!body`).
    let b = JsonBody::lenient(&body, json!({}));
    let Some(servers) = b.get("servers").filter(|v| v.is_object()) else {
        return err(StatusCode::BAD_REQUEST, "servers object required");
    };
    // The request goes out as `JSON.stringify` text (integer-like names
    // first, `1.0` as `1`), like the SDK's.
    let servers = servers.as_object().into_iter().flatten().map(|(k, v)| {
        (
            k.clone(),
            claudius_agent::McpServerConfig::External(v.clone()),
        )
    });
    match s.set_mcp_servers(servers).await {
        // `NextResponse.json` of the reply as `JSON.parse` read it.
        Ok(data) => (
            [(header::CONTENT_TYPE, "application/json")],
            claudius_agent::js::stringify(&json!({"result": data})),
        )
            .into_response(),
        Err(e) => err(StatusCode::SERVICE_UNAVAILABLE, &e),
    }
}

/// `POST /:id/recap`: start a "where were we?" recap of a live session
/// (else 404). The body's `origin` (`"away"` unless it is `"manual"`) is
/// echoed on the `session_recap` event. The answer only accepts the
/// request: the recap, or why there is none, arrives over SSE.
async fn recap(State(app): State<AppState>, Path(id): Path<String>, body: Bytes) -> Response {
    let Some(s) = session(&app, &id) else {
        return not_found();
    };
    // `try { body = await req.json() } catch {}`: no body or bad JSON is
    // `away`, and so is any `origin` other than the two names.
    let b = JsonBody::lenient(&body, Value::Null);
    let origin = match b["origin"].as_str() {
        Some("manual") => "manual",
        _ => "away",
    };
    tokio::spawn(async move { s.request_recap(origin).await });
    json(StatusCode::ACCEPTED, json!({"ok": true}))
}

/// `POST /:id/rewind`: `{userMessageId, dryRun?}` puts the live session's
/// edited files back as they were at that user message (the CLI's file
/// checkpoints), or with `dryRun: true` only reports what would change.
/// 404 for an unknown session, before the body is read; a body `JSON.parse`
/// refuses is a 503 with V8's message (the handler's catch); 400 without a
/// non-empty string `userMessageId`; 503 `session not active` without a
/// query, or the SDK's error; else 200 `{result}`, the CLI's reply as
/// `JSON.parse` read it (`canRewind: false` is a 200 too).
async fn rewind(State(app): State<AppState>, Path(id): Path<String>, body: Bytes) -> Response {
    let Some(s) = session(&app, &id) else {
        return not_found();
    };
    let failed = |message: String| {
        tracing::error!(target: log::API, "[api/sessions/rewind] POST failed {message}");
        err(StatusCode::SERVICE_UNAVAILABLE, &message)
    };
    let b = match JsonBody::parse_or_message(&body) {
        Ok(b) => b,
        Err(message) => return failed(message),
    };
    let Some(user_message_id) = b["userMessageId"].as_str().filter(|m| !m.is_empty()) else {
        return err(StatusCode::BAD_REQUEST, "userMessageId required");
    };
    // The query itself, not `Session::rewind_files`: TS reads `session.query`.
    let Some(h) = s.query_handle() else {
        return err(StatusCode::SERVICE_UNAVAILABLE, "session not active");
    };
    let dry_run = b["dryRun"] == Value::Bool(true);
    match h.rewind_files(user_message_id, Some(dry_run)).await {
        Ok(result) => js_ok(&json!({"result": result})),
        Err(e) => failed(e.to_string()),
    }
}

/// `POST /:id/bash` (`!` mode): `{command, sudoPassword?, uuid?}` runs the
/// command on the session's persistent shell (live sessions only → 404).
/// The model isn't invoked; the result reaches it with the next prompt.
/// `sudoPassword` is never logged.
async fn bash(State(app): State<AppState>, Path(id): Path<String>, body: Bytes) -> Response {
    let Some(s) = session(&app, &id) else {
        return not_found();
    };
    let b = tri!(JsonBody::or_bad_request(&body, "invalid JSON body"));
    let command = b["command"].as_str().unwrap_or_default();
    if claudius_agent::js::trim(command).is_empty() {
        return err(StatusCode::BAD_REQUEST, "command required");
    }
    // A NUL would end the wrapper before its sentinel and hang the call.
    if command.contains('\0') {
        return err(StatusCode::BAD_REQUEST, "command contains NUL");
    }
    let sudo_password = b["sudoPassword"].as_str().filter(|p| !p.is_empty());
    // `body.uuid ?? randomUUID()`: any other JSON value is kept as is.
    let uuid = match &b["uuid"] {
        Value::Null => json!(uuid::Uuid::new_v4().to_string()),
        v => v.clone(),
    };
    match s.run_bash_command(command, sudo_password, uuid).await {
        Ok(run) => ok(json!({
            "ok": true,
            "uuid": run.uuid,
            "stdout": run.result.stdout,
            "stderr": run.result.stderr,
            "exitCode": run.result.exit_code,
            "truncated": run.result.truncated,
            "timedOut": run.result.timed_out,
        })),
        Err(_) => crate::body::thrown(),
    }
}

// ─────────────────────────────── goal / holder ───────────────────────────────

async fn goal(State(app): State<AppState>, Path(id): Path<String>, body: Bytes) -> Response {
    let Some(s) = session(&app, &id) else {
        return not_found();
    };
    let b = JsonBody::lenient(&body, json!({}));
    let text = b["goal"].as_str().map(str::trim).unwrap_or("");
    let res = if text.is_empty() {
        s.clear_goal()
    } else {
        s.set_goal(text)
    };
    match res {
        Ok(g) => ok(json!({"ok": true, "goal": g})),
        Err(e) => err(StatusCode::INTERNAL_SERVER_ERROR, &e.to_string()),
    }
}

async fn holder(State(app): State<AppState>, Path(id): Path<String>, body: Bytes) -> Response {
    let Some(s) = session(&app, &id) else {
        return not_found();
    };
    let b = JsonBody::lenient(&body, Value::Null);
    let Some(tab) = b["tabId"].as_str().filter(|t| !t.is_empty()) else {
        return err(StatusCode::BAD_REQUEST, "tabId required");
    };
    s.claim_holder(tab);
    ok(json!({"ok": true, "holderId": tab}))
}

// ──────────────────────────────────── queue ──────────────────────────────────

async fn queue_delete(
    State(app): State<AppState>,
    Path((id, uuid)): Path<(String, String)>,
) -> Response {
    let Some(s) = session(&app, &id) else {
        return not_found();
    };
    let row = claudius_core::queue_db::list_queue(&s.cwd, &s.id)
        .into_iter()
        .find(|r| r.uuid == uuid);
    let Some(row) = row else {
        return err(StatusCode::NOT_FOUND, "queued message not found");
    };
    if !s.remove_queued(&uuid).unwrap_or(false) {
        return err(StatusCode::NOT_FOUND, "queued message not found");
    }
    let mut out = json!({"ok": true, "uuid": row.uuid, "text": row.text});
    if let Some(imgs) = row.images.filter(|i| !i.is_empty()) {
        out["images"] = json!(imgs);
    }
    if row.slash {
        out["slash"] = json!(true);
    }
    if row.from_suggestion {
        out["fromSuggestion"] = json!(true);
    }
    if row.from_goal {
        out["fromGoal"] = json!(true);
    }
    ok(out)
}

async fn queue_move(
    State(app): State<AppState>,
    Path((id, uuid)): Path<(String, String)>,
    body: Bytes,
) -> Response {
    let Some(s) = session(&app, &id) else {
        return not_found();
    };
    let b = JsonBody::lenient(&body, Value::Null);
    let up = match b["direction"].as_str() {
        Some("up") => true,
        Some("down") => false,
        _ => {
            return err(
                StatusCode::BAD_REQUEST,
                "body.direction must be 'up' or 'down'",
            );
        }
    };
    if s.move_queued(&uuid, up).unwrap_or(false) {
        ok(json!({"ok": true, "moved": true}))
    } else {
        ok(json!({"ok": false, "moved": false}))
    }
}

async fn queue_send_now(
    State(app): State<AppState>,
    Path((id, uuid)): Path<(String, String)>,
) -> Response {
    // CC 2.1.311 — a session whose CLI died between turns would pop the row
    // and drop it while we answered `ok`. Restart it first (or join a rebuild
    // already under way); the rebuilt session drains the persisted queue on
    // start, so a row it already sent reads as "already on its way".
    let s = match app.mgr.restart_if_dead(&id, false).await {
        Ok(live) => live.session,
        Err(reason) => return dead_session(&reason),
    };
    // `sendQueuedNow` throws on a database error or images it can't send.
    let Ok(dispatched) = s.send_queued_now(&json!(uuid), false) else {
        return crate::body::thrown();
    };
    ok(json!({"ok": true, "dispatched": dispatched}))
}

async fn queue_send_all(State(app): State<AppState>, Path(id): Path<String>) -> Response {
    // CC 2.1.311, as `queue_send_now` above.
    let s = match app.mgr.restart_if_dead(&id, false).await {
        Ok(live) => live.session,
        Err(reason) => return dead_session(&reason),
    };
    let mut dispatched = vec![];
    let mut join_running_turn = true;
    for item in s.queue_snapshot() {
        if item["slash"] == true {
            join_running_turn = false;
        }
        // `item.uuid` as the queue holds it, of any type (S29a).
        match s.send_queued_now(&item["uuid"], join_running_turn) {
            Ok(true) => dispatched.push(item["uuid"].clone()),
            Ok(false) => {}
            Err(_) => return crate::body::thrown(),
        }
    }
    js_ok(&json!({"ok": true, "dispatched": dispatched}))
}

// ─────────────────────── per-session disk-backed state ───────────────────────

/// `resolveCwd` shared by prompt-draft / goal-messages / suggested-messages /
/// prompt-color / notification-prefs: the live session's cwd, else the
/// on-disk session index — so these still work for a session that was
/// reaped but exists on disk.
pub(crate) fn resolve_cwd(app: &AppState, id: &str) -> Option<String> {
    if let Some(s) = session(app, id) {
        return Some(s.cwd.clone());
    }
    sessions_store::info(id, None).and_then(|i| i.cwd)
}

async fn prompt_draft_get(State(app): State<AppState>, Path(id): Path<String>) -> Response {
    let Some(cwd) = resolve_cwd(&app, &id) else {
        return not_found();
    };
    // Empty shape (no `updatedAt`) so the client can seed blindly.
    ok(sessions_db::get_prompt_draft(&cwd, &id)
        .unwrap_or_else(|| json!({"text": "", "images": []})))
}

async fn prompt_draft_put(
    State(app): State<AppState>,
    Path(id): Path<String>,
    body: Bytes,
) -> Response {
    const MAX_TEXT: usize = 200_000;
    const MAX_IMAGES: usize = 16;
    let Some(cwd) = resolve_cwd(&app, &id) else {
        return not_found();
    };
    let b = JsonBody::lenient(&body, json!({}));
    let text = tri!(js_member(&b, "text"))
        .and_then(Value::as_str)
        .unwrap_or("");
    let text = js_truncate(text, MAX_TEXT);
    let images: Vec<Value> = b["images"]
        .as_array()
        .map(|a| a.iter().take(MAX_IMAGES).cloned().collect())
        .unwrap_or_default();
    match sessions_db::set_prompt_draft(&cwd, &id, &text, &Value::Array(images)) {
        Ok(()) => ok(json!({"ok": true})),
        Err(e) => err(StatusCode::INTERNAL_SERVER_ERROR, &e.to_string()),
    }
}

async fn prompt_draft_delete(State(app): State<AppState>, Path(id): Path<String>) -> Response {
    let Some(cwd) = resolve_cwd(&app, &id) else {
        return not_found();
    };
    sessions_db::clear_prompt_draft(&cwd, &id);
    ok(json!({"ok": true}))
}

fn tagged_uuids(app: &AppState, id: &str, goal: bool) -> Response {
    let uuids = resolve_cwd(app, id)
        .map(|cwd| sessions_db::list_tagged_message_uuids(&cwd, goal, id))
        .unwrap_or_default();
    ok(json!({"uuids": uuids}))
}

async fn goal_messages(State(app): State<AppState>, Path(id): Path<String>) -> Response {
    tagged_uuids(&app, &id, true)
}

async fn suggested_messages(State(app): State<AppState>, Path(id): Path<String>) -> Response {
    tagged_uuids(&app, &id, false)
}

/// `PROMPT_COLORS` names (`lib/shared/prompt-colors.ts`).
const PROMPT_COLOR_NAMES: [&str; 8] = [
    "red", "orange", "yellow", "green", "cyan", "blue", "purple", "pink",
];

async fn prompt_color_get(State(app): State<AppState>, Path(id): Path<String>) -> Response {
    let Some(cwd) = resolve_cwd(&app, &id) else {
        return not_found();
    };
    let state = sessions_db::get_session_state(&cwd, &id);
    let color = state
        .get("promptColor")
        .and_then(Value::as_str)
        .filter(|c| PROMPT_COLOR_NAMES.contains(c));
    ok(json!({"sessionId": id, "color": color}))
}

async fn prompt_color_post(
    State(app): State<AppState>,
    Path(id): Path<String>,
    body: Bytes,
) -> Response {
    let b = JsonBody::lenient(&body, json!({}));
    let Some(cwd) = resolve_cwd(&app, &id) else {
        return not_found();
    };
    // `null` clears; a string must be a palette name; anything else (incl.
    // a missing key) is rejected. `body.color` throws on a `null` body.
    let color = match tri!(js_member(&b, "color")) {
        Some(Value::Null) => Value::Null,
        Some(Value::String(c)) if PROMPT_COLOR_NAMES.contains(&c.as_str()) => {
            Value::String(c.clone())
        }
        _ => return err(StatusCode::BAD_REQUEST, "invalid color"),
    };
    let mut patch = Map::new();
    patch.insert("promptColor".into(), color.clone());
    if let Err(e) = sessions_db::merge_session_state(&cwd, &id, patch) {
        return err(StatusCode::INTERNAL_SERVER_ERROR, &e.to_string());
    }
    ok(json!({"sessionId": id, "color": color}))
}

/// `ADVISOR_PICKABLE_VALUES` minus `null` (`lib/shared/advisor.ts`).
const ADVISOR_MODELS: [&str; 4] = [
    "claude-opus-5-5",
    "claude-opus-4-8",
    "claude-sonnet-5",
    "claude-fable-5",
];

async fn advisor_get(State(app): State<AppState>, Path(id): Path<String>) -> Response {
    let Some(s) = session(&app, &id) else {
        return not_found();
    };
    if let Some(cached) = s.advisor_model().filter(|m| !m.is_empty()) {
        return ok(json!({"model": cached}));
    }
    // Cache miss → the canonical settings.json; parse error / missing → null.
    let on_disk = settings::read_settings(settings::Scope::User, &s.cwd)
        .ok()
        .and_then(|d| {
            d.get("advisorModel")
                .and_then(Value::as_str)
                .map(str::to_owned)
        });
    ok(json!({"model": on_disk}))
}

async fn advisor_post(
    State(app): State<AppState>,
    Path(id): Path<String>,
    body: Bytes,
) -> Response {
    let Some(s) = session(&app, &id) else {
        return not_found();
    };
    let b = tri!(JsonBody::strict(&body));
    // `normalizeAdvisorChoice`: unknown strings (and a missing key) → null.
    let choice = b
        .get("model")
        .and_then(Value::as_str)
        .filter(|m| ADVISOR_MODELS.contains(m))
        .map(str::to_owned);
    settings::persist_advisor_to_user_settings(&s.cwd, choice.as_deref());
    s.set_advisor_model(choice.clone()).await;
    ok(json!({"ok": true, "model": choice}))
}

// ───────────────────────────── dev-only test routes ─────────────────────────────
// Ports of `app/api/sessions/[id]/dev-*`. Each starts with the `crate::dev`
// gate, like the TS `NODE_ENV === "production"` check.

/// `dev-broadcast`: push an arbitrary event through `Session::broadcast` (the
/// same funnel as live events: stamp, buffer, snapshot capture, fan out).
/// TODO S31: TS's broadcast also feeds the notification bus.
async fn dev_broadcast(
    State(app): State<AppState>,
    Path(id): Path<String>,
    body: Bytes,
) -> Response {
    tri!(dev_only(app.dev_routes, DevRefusal::NotFound));
    // `(await req.json().catch(() => ({}))).event`: no `?.`, so `null` throws.
    let b = JsonBody::lenient(&body, json!({}));
    let event = tri!(js_member(&b, "event"));
    let Some(event) = event.filter(|e| js_truthy(Some(e))) else {
        return err(StatusCode::BAD_REQUEST, "event required");
    };
    let Some(s) = session(&app, &id) else {
        return err(StatusCode::NOT_FOUND, "session not bound");
    };
    s.broadcast(event.clone());
    ok(json!({"ok": true, "sessionCwd": s.cwd, "sessionId": s.id}))
}

/// `dev-reap`: evict the in-memory session the way the idle reaper does, so
/// the next subscriber resumes it from disk.
async fn dev_reap(State(app): State<AppState>, Path(id): Path<String>) -> Response {
    tri!(dev_only(app.dev_routes, DevRefusal::NotFound));
    let existed = app.mgr.get(&id).is_some();
    if existed {
        app.mgr.remove(&id).await;
    }
    ok(json!({"ok": true, "reaped": existed}))
}

/// `dev-inject-denial`: seed the Recent Denials ring.
async fn dev_inject_denial(
    State(app): State<AppState>,
    Path(id): Path<String>,
    body: Bytes,
) -> Response {
    tri!(dev_only(app.dev_routes, DevRefusal::Forbidden));
    let Some(s) = session(&app, &id) else {
        return not_found();
    };
    // `body.toolName` / `body.reasonType` without `?.`: a `null` body throws.
    let b = JsonBody::lenient(&body, json!({}));
    let tool = tri!(js_member(&b, "toolName"))
        .and_then(Value::as_str)
        .unwrap_or("Bash");
    let reason = tri!(js_member(&b, "reasonType"))
        .and_then(Value::as_str)
        .unwrap_or("auto_deny");
    s.inject_denial_for_testing(tool, reason);
    ok(json!({"ok": true}))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn elicitation_decisions() {
        assert_eq!(
            parse_elicitation_decision(&json!({"action":"cancel"})),
            Some(("cancel".into(), None))
        );
        assert!(
            parse_elicitation_decision(&json!({"action":"accept","content":{"__proto__":"x"}}))
                .is_none()
        );
        assert!(
            parse_elicitation_decision(&json!({"action":"accept","content":{"a":{"nested":1}}}))
                .is_none()
        );
        assert_eq!(
            parse_elicitation_decision(&json!({"action":"accept"})),
            Some(("accept".into(), None))
        );
        assert!(parse_elicitation_decision(&json!({"action":"nope"})).is_none());
    }

    #[test]
    fn merge_prefers_request() {
        let body = json!({"model":"a","maxTurns":null})
            .as_object()
            .unwrap()
            .clone();
        let defs = json!({"model":"b","maxTurns":3,"permissionMode":"auto"})
            .as_object()
            .unwrap()
            .clone();
        let m = merge_defaults(&body, &defs);
        assert_eq!(m["model"], "a");
        assert_eq!(m["maxTurns"], 3);
        assert_eq!(m["permissionMode"], "auto");
    }

    /// `GET /:id/output-style`'s shape rules, from the TS route.
    #[test]
    fn output_style_view_follows_the_route() {
        let fallback =
            json!({"current": "default", "available": STATIC_OUTPUT_STYLES, "source": "fallback"});
        assert_eq!(output_style_view(None), fallback);
        let session = |current: Value, available: Value| json!({"current": current, "available": available, "source": "session"});
        let statics = json!(STATIC_OUTPUT_STYLES);
        for (init, want) in [
            (
                json!({"output_style": "concise", "available_output_styles": ["default", "mine"]}),
                session(json!("concise"), json!(["default", "mine"])),
            ),
            // Missing, empty or non-array lists fall back to the static one.
            (json!({}), session(json!("default"), statics.clone())),
            (
                json!({"available_output_styles": []}),
                session(json!("default"), statics.clone()),
            ),
            (
                json!({"available_output_styles": "default"}),
                session(json!("default"), statics.clone()),
            ),
            (
                json!({"available_output_styles": {"0": "x"}}),
                session(json!("default"), statics.clone()),
            ),
            // Items aren't checked.
            (
                json!({"available_output_styles": [1, null]}),
                session(json!("default"), json!([1, null])),
            ),
            // `?? "default"` only replaces null/undefined.
            (
                json!({"output_style": null}),
                session(json!("default"), statics.clone()),
            ),
            (
                json!({"output_style": ""}),
                session(json!(""), statics.clone()),
            ),
            (
                json!({"output_style": 7}),
                session(json!(7), statics.clone()),
            ),
            // A non-object result reads every field as undefined.
            (json!([1]), session(json!("default"), statics.clone())),
            (json!("x"), session(json!("default"), statics.clone())),
        ] {
            assert_eq!(output_style_view(Some(&init)), want, "{init}");
        }
    }
}
