//! The notification routes: port of `app/api/notifications/route.ts` (GET),
//! `counts`, `[id]/read`, `read-all`, `read-by-kind`, `read-by-session`,
//! `dev-emit` and the `stream` SSE, over the process's
//! [`NotificationBus::global`].
//!
//! Workspace scoping is TS's: `?workspace=` / `body.workspaceId` when truthy,
//! else the active workspace (the `claudius.workspace` cookie, then the
//! store's hint, as [`workspaces::resolve_active_raw`] reads them), else 400
//! `no workspace` (the list answers `{items: []}`); an id the store doesn't
//! hold (`getWorkspace`, `===` on any JSON type) is 404 `unknown workspace`.
//! Bodies are `await req.json().catch(() => ({}))` and read with `body.x`,
//! so a `null` body is Next's empty 500, as is anything the TS lets throw
//! (an unreadable store, a `null` entry before the match, a non-string
//! `kind` / `sessionId`, a fractional `limit` on one workspace, a workspace
//! whose `rootPath` isn't a string).
//!
//! `getAllWorkspaceStates` (counts, dev-emit, the stream's seed) inserts
//! each key as its reads settle: workspaces whose read-only handle is cached
//! (or whose `rootPath` isn't a string) at once, in order, the others after
//! their `fs.mkdir`. `all_states` keeps that order, the second group in
//! workspace order (TS: I/O order).
//!
//! The stream sends `: connected\n\n`, one `data: {"type":"state",…}\n\n`
//! per workspace, then every bus event as one `data: …\n\n` chunk and a
//! `: ping\n\n` every 15 s; it ends only when the client goes away, which
//! drops the subscription.
//!
//! Where it differs (none is in the golden):
//! * The bus addresses workspaces by string id: a store entry whose `id`
//!   is another type (a number) is found by the routes, but its list is
//!   empty and its marks change nothing.
//! * dev-emit hands the bus `String(sessionId)` for a non-string one, and
//!   the session id and the event with lone surrogates as U+FFFD, the way
//!   better-sqlite3 stores them; the `notification` event of such a row
//!   carries U+FFFD where TS's in-memory row keeps the lone surrogate.
//! * A body number past the f64 range is `null` (falsy), not `Infinity`.
//! * dev-emit with a `null` store entry: TS's trusted-cwd check throws on
//!   it before the bus runs; here the trusted roots skip it (a non-string
//!   `cwd` then reaches the bus) and the states fail after counting the
//!   other workspaces, whose versions move on. Both answer the empty 500
//!   (a string `cwd` is 400 `unknown cwd` here).

use std::collections::HashSet;
use std::convert::Infallible;
use std::time::Duration;

use axum::Router;
use axum::body::{Body, Bytes};
use axum::extract::{Path, RawQuery, State};
use axum::http::{HeaderMap, HeaderValue, StatusCode, header};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use claudius_agent::js;
use claudius_core::db::{self, Mode};
use claudius_core::js_string::{self, lossy, lossy_value};
use claudius_core::notification_bus::{
    NotificationBus, NotificationSubscription, SessionEventOpts, StreamEvent, WorkspaceUnreadState,
};
use claudius_core::notifications_db::{ALL_NOTIFICATION_KINDS, ListOpts};
use claudius_core::{log, trusted_cwd, workspaces};
use futures::{Stream, StreamExt};
use serde_json::{Map, Value, json};

use crate::AppState;
use crate::body::{JsonBody, js_member, thrown};
use crate::dev::{DevRefusal, dev_only};
use crate::session_transcript::{page_limit, search_param};
use crate::tri;

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/api/notifications", get(list))
        .route("/api/notifications/counts", get(counts))
        .route("/api/notifications/{id}/read", post(read_one))
        .route("/api/notifications/read-all", post(read_all))
        .route("/api/notifications/read-by-kind", post(read_by_kind))
        .route("/api/notifications/read-by-session", post(read_by_session))
        .route("/api/notifications/dev-emit", post(dev_emit))
        .route("/api/notifications/stream", get(stream))
}

/// The stream's keep-alive period (`setInterval(…, 15000)`).
pub const HEARTBEAT: Duration = Duration::from_secs(15);
const CONNECTED: &[u8] = b": connected\n\n";
const PING: &[u8] = b": ping\n\n";

fn json_text(status: StatusCode, body: &Value) -> Response {
    (
        status,
        [(header::CONTENT_TYPE, "application/json")],
        js_string::stringify(body),
    )
        .into_response()
}

fn error(status: StatusCode, msg: &str) -> Response {
    json_text(status, &json!({"error": msg}))
}

/// What the TS let throw: Next's empty 500.
fn failed(route: &str, e: impl std::fmt::Display) -> Response {
    tracing::error!(target: log::API, "[api/notifications{route}] {e:#}");
    thrown()
}

/// `await req.json().catch(() => ({}))`.
fn read_body(bytes: &[u8]) -> Value {
    js_string::parse(&JsonBody::text(bytes)).unwrap_or_else(|_| json!({}))
}

/// `(await resolveActiveWorkspace())?.id`: always truthy, since it is
/// `===` the (non-empty) cookie or the (truthy) hint.
fn active_id(headers: &HeaderMap) -> anyhow::Result<Option<Value>> {
    let cookie = crate::workspaces::read_active_cookie(headers);
    Ok(workspaces::resolve_active_raw(cookie.as_deref())?.and_then(|w| w.get("id").cloned()))
}

/// A mark route once its own checks passed: the target is `explicit`
/// (`body.workspaceId`) when truthy, else the active workspace's id; 400
/// when neither is, 404 when the store has no such workspace, else `{ok,
/// changed}` with what `mark` changed. A workspace found under an id that
/// isn't a string is one the bus can't address: nothing changes.
fn mark(
    route: &str,
    explicit: Option<&Value>,
    headers: &HeaderMap,
    mark: impl FnOnce(&NotificationBus, &str) -> anyhow::Result<usize>,
) -> Response {
    let id = match explicit.filter(|v| js::truthy(v)) {
        Some(v) => v.clone(),
        None => match active_id(headers) {
            Ok(Some(v)) => v,
            Ok(None) => return error(StatusCode::BAD_REQUEST, "no workspace"),
            Err(e) => return failed(route, e),
        },
    };
    match workspaces::get_raw_value(&id) {
        Ok(Some(_)) => {}
        Ok(None) => return error(StatusCode::NOT_FOUND, "unknown workspace"),
        Err(e) => return failed(route, e),
    }
    let changed = match id.as_str() {
        Some(id) => mark(NotificationBus::global(), id),
        None => Ok(0),
    };
    match changed {
        Ok(n) => json_text(StatusCode::OK, &json!({"ok": true, "changed": n})),
        Err(e) => failed(route, e),
    }
}

/// `body.<key>?.trim()`: `None` for `undefined` / `null`; a value that isn't
/// a string throws (`.trim is not a function`).
fn trimmed(v: Option<&Value>) -> Result<Option<String>, ()> {
    match v {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(s)) => Ok(Some(js::trim(s).to_owned())),
        Some(_) => Err(()),
    }
}

/// `notificationBus.getAllWorkspaceStates()` in the order TS's object gets
/// its keys (see the module docs): the bus's workspace order, with the
/// workspaces whose read-only handle isn't cached yet moved last. Which
/// those are is read before the call, which caches the handles it opens.
fn all_states(bus: &NotificationBus) -> anyhow::Result<Vec<WorkspaceUnreadState>> {
    let settles_late: HashSet<String> = workspaces::list_raw()
        .unwrap_or_default()
        .iter()
        .filter_map(|w| match (w.get("id"), w.get("rootPath")) {
            (Some(Value::String(id)), Some(Value::String(root)))
                if db::cached_db(root, Mode::ReadOnly).is_none() =>
            {
                Some(id.clone())
            }
            _ => None,
        })
        .collect();
    let mut states: Vec<_> = bus.get_all_workspace_states()?.into_values().collect();
    states.sort_by_key(|s| settles_late.contains(&s.workspace_id));
    Ok(states)
}

// ---- GET /api/notifications ---------------------------------------------------

async fn list(headers: HeaderMap, RawQuery(q): RawQuery) -> Response {
    const ROUTE: &str = "";
    let q = q.as_deref();
    let explicit = search_param(q, "workspace");
    let limit = page_limit(search_param(q, "limit").as_deref());
    // `beforeParam ? Number(beforeParam) : undefined`, used when truthy
    // (`Number("")` is 0, so `?before=` is no cursor either way).
    let before = search_param(q, "before").map(|b| js::to_number(&b));
    let unread_only = search_param(q, "unreadOnly").as_deref() == Some("1");
    let bus = NotificationBus::global();
    let items = |rows: anyhow::Result<Vec<_>>| match rows {
        Ok(rows) => {
            let items: Vec<Value> = rows
                .iter()
                .map(claudius_core::notifications_db::NotificationRow::to_json)
                .collect();
            json_text(StatusCode::OK, &json!({"items": items}))
        }
        Err(e) => failed(ROUTE, e),
    };
    if explicit.as_deref() == Some("all") {
        return items(bus.list_across_workspaces(&ListOpts {
            limit: Some(limit),
            before: None,
            unread_only,
        }));
    }
    let id = match explicit.filter(|e| !e.is_empty()) {
        Some(e) => Value::String(e),
        None => match active_id(&headers) {
            Ok(Some(v)) => v,
            Ok(None) => return json_text(StatusCode::OK, &json!({"items": []})),
            Err(e) => return failed(ROUTE, e),
        },
    };
    match workspaces::get_raw_value(&id) {
        Ok(Some(_)) => {}
        Ok(None) => return error(StatusCode::NOT_FOUND, "unknown workspace"),
        Err(e) => return failed(ROUTE, e),
    }
    let Value::String(id) = id else {
        return items(Ok(Vec::new()));
    };
    items(bus.list(
        &id,
        &ListOpts {
            limit: Some(limit),
            before,
            unread_only,
        },
    ))
}

// ---- GET /api/notifications/counts --------------------------------------------

async fn counts() -> Response {
    match all_states(NotificationBus::global()) {
        Ok(states) => {
            let states: Map<String, Value> = states
                .into_iter()
                .map(|s| (s.workspace_id.clone(), s.to_json()))
                .collect();
            json_text(StatusCode::OK, &json!({"states": states}))
        }
        Err(e) => failed("/counts", e),
    }
}

// ---- the marks ----------------------------------------------------------------

async fn read_one(headers: HeaderMap, Path(id): Path<String>, body: Bytes) -> Response {
    let b = read_body(&body);
    let explicit = tri!(js_member(&b, "workspaceId"));
    mark("/[id]/read", explicit, &headers, |bus, ws| {
        bus.mark_read(ws, &[id])
    })
}

async fn read_all(headers: HeaderMap, body: Bytes) -> Response {
    let b = read_body(&body);
    let explicit = tri!(js_member(&b, "workspaceId"));
    mark("/read-all", explicit, &headers, |bus, ws| {
        bus.mark_all_read(ws)
    })
}

async fn read_by_kind(headers: HeaderMap, body: Bytes) -> Response {
    const ROUTE: &str = "/read-by-kind";
    let b = read_body(&body);
    let Ok(kind) = trimmed(tri!(js_member(&b, "kind"))) else {
        return failed(ROUTE, "TypeError: body.kind?.trim is not a function");
    };
    let Some(kind) = kind.filter(|k| !k.is_empty()) else {
        return error(StatusCode::BAD_REQUEST, "kind required");
    };
    if !ALL_NOTIFICATION_KINDS.contains(&kind.as_str()) {
        return error(StatusCode::BAD_REQUEST, "unknown kind");
    }
    mark(ROUTE, b.get("workspaceId"), &headers, |bus, ws| {
        bus.mark_read_by_kind(ws, &kind)
    })
}

async fn read_by_session(headers: HeaderMap, body: Bytes) -> Response {
    const ROUTE: &str = "/read-by-session";
    let b = read_body(&body);
    let Ok(session_id) = trimmed(tri!(js_member(&b, "sessionId"))) else {
        return failed(ROUTE, "TypeError: body.sessionId?.trim is not a function");
    };
    let Some(session_id) = session_id.filter(|s| !s.is_empty()) else {
        return error(StatusCode::BAD_REQUEST, "sessionId required");
    };
    mark(ROUTE, b.get("workspaceId"), &headers, |bus, ws| {
        bus.mark_read_by_session(ws, &lossy(&session_id))
    })
}

// ---- POST /api/notifications/dev-emit -----------------------------------------

async fn dev_emit(State(app): State<AppState>, body: Bytes) -> Response {
    const ROUTE: &str = "/dev-emit";
    tri!(dev_only(app.dev_routes, DevRefusal::NotFound));
    let b = read_body(&body);
    // `body.cwd` throws on a `null` body; the rest can't throw after it.
    let cwd = tri!(js_member(&b, "cwd"));
    let (Some(cwd), Some(session_id), Some(event)) = (
        cwd.filter(|v| js::truthy(v)),
        b.get("sessionId").filter(|v| js::truthy(v)),
        b.get("event").filter(|v| js::truthy(v)),
    ) else {
        return error(StatusCode::BAD_REQUEST, "cwd, sessionId, event required");
    };
    // `resolveTrustedCwd(input)`: a non-string is "no input", the first root.
    let Some(cwd) = trusted_cwd::resolve_trusted_cwd(cwd.as_str()) else {
        return error(StatusCode::BAD_REQUEST, "unknown cwd");
    };
    // Lone surrogates as better-sqlite3 binds them (U+FFFD).
    let session_id = match session_id {
        Value::String(s) => lossy(s).into_owned(),
        v => js::to_string(Some(v)),
    };
    let bus = NotificationBus::global();
    bus.record_session_event(
        &cwd,
        &session_id,
        &lossy_value(event),
        SessionEventOpts {
            has_subscribers: b.get("hasSubscribers").and_then(Value::as_bool),
            ..SessionEventOpts::default()
        },
    );
    match all_states(bus) {
        Ok(states) => {
            let counts: Map<String, Value> = states
                .into_iter()
                .map(|s| (s.workspace_id, json!(s.total_unread)))
                .collect();
            json_text(StatusCode::OK, &json!({"ok": true, "counts": counts}))
        }
        Err(e) => failed(ROUTE, e),
    }
}

// ---- GET /api/notifications/stream --------------------------------------------

fn frame(ev: &StreamEvent) -> Bytes {
    Bytes::from(format!("data: {}\n\n", js_string::stringify(&ev.to_json())))
}

/// The stream's body after its first chunks (`seed`): each event of `sub`
/// as one chunk, and `heartbeat` after the call, then every `heartbeat`
/// ([`HEARTBEAT`] in the route), a `: ping\n\n`. It never ends (TS closes
/// only on the client's abort; a subscription the bus drops leaves the
/// pings), and dropping it unsubscribes. Call it on a tokio runtime.
pub fn event_stream(
    seed: Vec<Bytes>,
    sub: NotificationSubscription,
    heartbeat: Duration,
) -> impl Stream<Item = Result<Bytes, Infallible>> + Send + 'static {
    let mut ping = tokio::time::interval_at(tokio::time::Instant::now() + heartbeat, heartbeat);
    ping.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    enum Next {
        Event(StreamEvent),
        Closed,
        Ping,
    }
    let events = futures::stream::unfold((Some(sub), ping), |(mut sub, mut ping)| async move {
        loop {
            let next = match sub.as_mut() {
                Some(s) => tokio::select! {
                    ev = s.recv() => ev.map_or(Next::Closed, Next::Event),
                    _ = ping.tick() => Next::Ping,
                },
                None => {
                    ping.tick().await;
                    Next::Ping
                }
            };
            let chunk = match next {
                Next::Event(ev) => frame(&ev),
                Next::Ping => Bytes::from_static(PING),
                Next::Closed => {
                    sub = None;
                    continue;
                }
            };
            return Some((Ok(chunk), (sub, ping)));
        }
    });
    futures::stream::iter(seed.into_iter().map(Ok)).chain(events)
}

async fn stream() -> Response {
    let bus = NotificationBus::global();
    let mut seed = vec![Bytes::from_static(CONNECTED)];
    // Seeding is best effort, like the TS's try/catch.
    if let Ok(states) = all_states(bus) {
        seed.extend(states.into_iter().map(|s| frame(&StreamEvent::State(s))));
    }
    let sub = bus.subscribe();
    let mut resp = Response::new(Body::from_stream(
        event_stream(seed, sub, HEARTBEAT).boxed(),
    ));
    let h = resp.headers_mut();
    h.insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("text/event-stream"),
    );
    h.insert(
        header::CACHE_CONTROL,
        HeaderValue::from_static("no-cache, no-transform"),
    );
    h.insert(header::CONNECTION, HeaderValue::from_static("keep-alive"));
    h.insert("x-accel-buffering", HeaderValue::from_static("no"));
    resp
}
