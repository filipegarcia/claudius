//! `lib/server/notification-bus.ts`: the in-process pub/sub behind the
//! workspace notification inbox.
//!
//! Producers: sessions ([`NotificationBus::record_session_event`],
//! [`NotificationBus::mark_user_input`], the resolve paths'
//! [`NotificationBus::mark_read_by_request_id`] and the start-up
//! [`NotificationBus::sweep_orphaned_actionable_for_session`]) and the
//! scheduler ([`NotificationBus::record_scheduler_event`]). Consumers: the
//! `/api/notifications/*` routes (the readers and mark-read calls below) and
//! the `notifications/stream` SSE, one [`NotificationBus::subscribe`]
//! receiver per open tab.
//!
//! `record` filters in TS's order: a subagent message is skipped; the cwd
//! must map to a workspace; the event must map to a kind
//! ([`map_event_to_kind`]); the workspace must enable the kind
//! ([`is_kind_enabled`]); the session must not be muted (the S24 prefs). Then
//! the row is inserted (a repeated `requestId` is ignored), a `notification`
//! event goes out (not for an idle / error row of a session no tab is
//! watching) and a `state` flush is scheduled. Events that move a session's
//! status (`turn_status`, `ready`, `error`, the prompts, a `result`) schedule
//! the flush even when they write no row, unless the workspace's master
//! switch is off.
//!
//! The `state` flush is coalesced per workspace like TS's `setTimeout(…, 0)`:
//! every schedule before it runs collapses into one event, with a version
//! one past the last one sent (or answered by
//! [`NotificationBus::get_workspace_state`]). It reads the counts through the
//! handle the database cache already holds and sends nothing without one.
//!
//! The workspace list is read the way TS reads `workspaces.json` (lossy
//! UTF-8, `JSON.parse`, `version === 1`, an array of anything), not through
//! the strict [`crate::workspaces`] model, and the cwd → workspace map is
//! cached until the file's mtime changes, as in TS. Workspace ids are
//! strings: an entry whose `id` isn't one is skipped (TS would use a number
//! id as is). A `null` entry throws where TS's property read would.
//!
//! Not ported: the HMR singleton migration (`pickBus`, the build tag and the
//! `Proxy`); [`NotificationBus::global`] is the process's one bus.

use std::collections::{HashMap, VecDeque};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, UNIX_EPOCH};

use claudius_agent::js;
use indexmap::IndexMap;
use serde_json::{Map, Value, json};
use tokio::sync::mpsc;

use crate::db::{Mode, cached_db, open_db};
use crate::notifications_db::{
    self as ndb, DEFAULT_ENABLED_KINDS, ListOpts, NewNotification, NotificationRow,
};
use crate::{log, now_ms, workspaces};

/// The clock (`Date.now()`), epoch ms.
pub type Clock = Arc<dyn Fn() -> f64 + Send + Sync>;
/// The row id source (`crypto.randomUUID()`).
pub type IdSource = Arc<dyn Fn() -> String + Send + Sync>;

/// A JS exception: what TS would have thrown, with V8's message.
#[derive(Clone, Debug, PartialEq, Eq, thiserror::Error)]
#[error("{0}")]
pub struct JsError(pub String);

/// How the coalesced `state` flushes run.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum Timers {
    /// `setTimeout(…, 0)`: 1 ms later, on the tokio runtime of the caller
    /// when there is one, else on a thread of its own.
    #[default]
    Auto,
    /// Queued until [`NotificationBus::run_timers`] (tests).
    Manual,
}

/// What a bus is built with.
#[derive(Clone)]
pub struct BusOptions {
    pub clock: Clock,
    pub new_id: IdSource,
    pub timers: Timers,
}

impl Default for BusOptions {
    fn default() -> Self {
        BusOptions {
            clock: Arc::new(|| now_ms() as f64),
            new_id: Arc::new(|| uuid::Uuid::new_v4().to_string()),
            timers: Timers::Auto,
        }
    }
}

/// `WorkspaceUnreadState`: a workspace's unread total and per-session
/// counts, with the per-workspace version clients gate updates on.
#[derive(Clone, Debug, PartialEq)]
pub struct WorkspaceUnreadState {
    pub workspace_id: String,
    pub version: u64,
    pub total_unread: i64,
    /// `String(session_id)` → count, in the order TS builds the object.
    pub per_session: Map<String, Value>,
}

impl WorkspaceUnreadState {
    /// `{workspaceId, version, totalUnread, perSession}`.
    pub fn to_json(&self) -> Value {
        let mut m = Map::new();
        self.write(&mut m);
        Value::Object(m)
    }

    fn write(&self, m: &mut Map<String, Value>) {
        m.insert("workspaceId".into(), json!(self.workspace_id));
        m.insert("version".into(), json!(self.version));
        m.insert("totalUnread".into(), json!(self.total_unread));
        m.insert("perSession".into(), Value::Object(self.per_session.clone()));
    }
}

/// `NotificationStreamEvent`, what a subscriber receives.
#[derive(Clone, Debug, PartialEq)]
pub enum StreamEvent {
    /// A new row (drives OS toasts and the drawer's recent list).
    Notification(Box<NotificationRow>),
    /// A workspace's fresh unread state.
    State(WorkspaceUnreadState),
}

impl StreamEvent {
    /// `{type: "notification", notification}` / `{type: "state", ...state}`.
    /// Serialize it with `claudius_agent::js::stringify`.
    pub fn to_json(&self) -> Value {
        let mut m = Map::new();
        match self {
            StreamEvent::Notification(row) => {
                m.insert("type".into(), json!("notification"));
                m.insert("notification".into(), row.to_json());
            }
            StreamEvent::State(state) => {
                m.insert("type".into(), json!("state"));
                state.write(&mut m);
            }
        }
        Value::Object(m)
    }
}

/// `RecordContext`.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct RecordContext {
    pub cwd: String,
    pub session_id: Option<String>,
    pub run_id: Option<String>,
    pub job_id: Option<String>,
    /// The session's label (custom title or id prefix): the idle row's body.
    pub session_title: Option<String>,
    /// Whether the session has a live tab. `Some(false)` mutes the toast for
    /// idle / error rows; `None` (the caller didn't say) notifies.
    pub has_subscribers: Option<bool>,
    /// Background work still running when the turn's `result` fired: no
    /// idle row.
    pub has_active_background_work: Option<bool>,
}

/// `recordSessionEvent`'s options.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct SessionEventOpts {
    pub has_subscribers: Option<bool>,
    pub session_title: Option<String>,
    pub has_active_background_work: Option<bool>,
}

/// What [`map_event_to_kind`] makes of an event. `None` fields are
/// `undefined` (left out of the JSON); `Some(Null)` is `null`.
#[derive(Clone, Debug, PartialEq)]
pub struct MappedEvent {
    pub kind: &'static str,
    pub title: String,
    pub body: Option<Value>,
    pub payload: Option<Map<String, Value>>,
    pub request_id: Option<Value>,
}

impl MappedEvent {
    /// The TS object as `JSON.stringify` prints it.
    pub fn to_json(&self) -> Value {
        let mut m = Map::new();
        m.insert("kind".into(), json!(self.kind));
        m.insert("title".into(), json!(self.title));
        if let Some(b) = &self.body {
            m.insert("body".into(), b.clone());
        }
        if let Some(p) = &self.payload {
            m.insert("payload".into(), Value::Object(p.clone()));
        }
        if let Some(r) = &self.request_id {
            m.insert("requestId".into(), r.clone());
        }
        Value::Object(m)
    }
}

// ───────────────────────── pure helpers ─────────────────────────

/// `v.key` on a JSON value: a plain object's property; `undefined` on any
/// other non-null value.
fn get<'a>(v: &'a Value, key: &str) -> Option<&'a Value> {
    v.as_object()?.get(key)
}

/// `v.key` where `v` may be `null`: TS throws reading a property off it.
fn get_or_throw<'a>(v: &'a Value, key: &str) -> Result<Option<&'a Value>, JsError> {
    if v.is_null() {
        return Err(JsError(format!(
            "Cannot read properties of null (reading '{key}')"
        )));
    }
    Ok(get(v, key))
}

/// `a ?? …`: `None` for `undefined` and `null`.
fn nullish(v: Option<&Value>) -> Option<&Value> {
    v.filter(|v| !v.is_null())
}

fn truthy_str(s: &Option<String>) -> bool {
    s.as_deref().is_some_and(|s| !s.is_empty())
}

fn string_is(v: Option<&Value>, s: &str) -> bool {
    v.and_then(Value::as_str) == Some(s)
}

const ABORT_SENTINEL: &str = "Claude Code process aborted by user";

/// `isAbortSentinel`: the SDK's abort message, trimmed. A truthy
/// non-string throws (`message.trim` isn't a function).
fn is_abort_sentinel(message: Option<&Value>) -> Result<bool, JsError> {
    match message {
        None => Ok(false),
        Some(v) if !js::truthy(v) => Ok(false),
        Some(Value::String(s)) => Ok(js::trim(s) == ABORT_SENTINEL),
        Some(_) => Err(JsError("message.trim is not a function".into())),
    }
}

/// `firstLine`: the text before the first `\n` (or `\r\n`: `trim` drops the
/// `\r` that `/\r?\n/` would), trimmed, cut to 197 UTF-16 units plus `…`
/// when longer than 200; `None` when that's empty.
/// A truthy non-string throws (`s.split` isn't a function).
///
/// Where the cut splits a surrogate pair, JS keeps the lone high surrogate,
/// which a Rust string can't hold: it becomes U+FFFD, what V8 writes for it
/// in UTF-8 (the stored row; [`js::json_parse`] reads its escape the same
/// way).
pub fn first_line(s: Option<&Value>) -> Result<Option<String>, JsError> {
    let s = match s {
        None => return Ok(None),
        Some(v) if !js::truthy(v) => return Ok(None),
        Some(Value::String(s)) => s.as_str(),
        Some(_) => return Err(JsError("s.split is not a function".into())),
    };
    let line = js::trim(s.split('\n').next().unwrap_or(s));
    if line.is_empty() {
        return Ok(None);
    }
    if line.encode_utf16().count() <= 200 {
        return Ok(Some(line.to_owned()));
    }
    let mut out = String::new();
    let mut units = 0;
    for c in line.chars() {
        units += c.len_utf16();
        if units > 197 {
            if units == 198 && c.len_utf16() == 2 {
                out.push('\u{FFFD}');
            }
            break;
        }
        out.push(c);
    }
    out.push('\u{2026}');
    Ok(Some(out))
}

/// `isBackgroundSuppressible`: the FYI kinds a session no tab watches
/// doesn't toast for.
fn is_background_suppressible(kind: &str) -> bool {
    kind == "session_idle" || kind == "session_error"
}

/// `isStatusSyncRelevant`: events that move a session's status, so other
/// tabs need a `state` event to refresh it.
fn is_status_sync_relevant(event: &Value) -> bool {
    match get(event, "type").and_then(Value::as_str) {
        Some(
            "turn_status"
            | "ready"
            | "error"
            | "permission_request"
            | "ask_user_question"
            | "mcp_elicitation_request"
            | "plan_approval_request",
        ) => true,
        Some("sdk") => string_is(js::prop(get(event, "message"), "type"), "result"),
        _ => false,
    }
}

/// `isKindEnabled(kind, prefs)`: the master switch (`enabled === false`
/// blocks everything), then `enabledKinds ?? DEFAULT_ENABLED_KINDS`, through
/// its `includes`: an array's items, a string's substrings; anything else
/// throws.
pub fn is_kind_enabled(kind: &str, prefs: Option<&Value>) -> Result<bool, JsError> {
    let prefs = prefs.and_then(Value::as_object);
    if prefs.and_then(|p| p.get("enabled")) == Some(&Value::Bool(false)) {
        return Ok(false);
    }
    match prefs.and_then(|p| nullish(p.get("enabledKinds"))) {
        None => Ok(DEFAULT_ENABLED_KINDS.contains(&kind)),
        Some(Value::Array(items)) => Ok(items.iter().any(|v| v.as_str() == Some(kind))),
        Some(Value::String(s)) => Ok(s.contains(kind)),
        Some(_) => Err(JsError("set.includes is not a function".into())),
    }
}

/// `mapEventToKind(event, ctx, lastUserInputAt)`: the row an event makes, or
/// `None`. Fields of odd types pass through as the JS code reads them
/// (template strings print `String(v)`, `??` falls through `null` and
/// `undefined`); where the JS throws, this is an `Err` with V8's message.
pub fn map_event_to_kind(
    event: &Value,
    ctx: &RecordContext,
    last_user_input_at: &HashMap<String, f64>,
) -> Result<Option<MappedEvent>, JsError> {
    let ty = get_or_throw(event, "type")?.and_then(Value::as_str);
    let field = |k: &str| get(event, k);
    let pick = |keys: &[&str]| -> Map<String, Value> {
        let mut m = Map::new();
        for k in keys {
            if let Some(v) = field(k) {
                m.insert((*k).to_owned(), v.clone());
            }
        }
        m
    };
    let request_id = || field("requestId").cloned();
    let mapped = |kind, title: &str, body, payload, request_id| MappedEvent {
        kind,
        title: title.to_owned(),
        body,
        payload,
        request_id,
    };
    Ok(Some(match ty {
        Some("permission_request") => mapped(
            "permission_request",
            "Claude needs permission",
            match nullish(field("title")) {
                Some(t) => Some(t.clone()),
                None => field("toolName").cloned(),
            },
            Some(pick(&["toolName", "toolUseId"])),
            request_id(),
        ),
        Some("mcp_elicitation_request") => {
            let server = js::to_string(field("serverName"));
            let title = if string_is(field("mode"), "url") {
                format!("{server} needs you to sign in")
            } else {
                format!("{server} needs your input")
            };
            let body = first_line(field("message"))?.map(Value::String);
            mapped(
                "permission_request",
                &title,
                body,
                Some(pick(&["serverName", "mode"])),
                request_id(),
            )
        }
        Some("ask_user_question") => {
            // `event.questions?.[0]`: only an object's properties are read.
            let first = match nullish(field("questions")) {
                Some(Value::Array(items)) => items.first(),
                Some(Value::Object(m)) => m.get("0"),
                _ => None,
            };
            let mut payload = pick(&["toolUseId"]);
            if let Some(h) = first.and_then(|f| get(f, "header")) {
                payload.insert("header".into(), h.clone());
            }
            mapped(
                "ask_user_question",
                "Claude is asking a question",
                nullish(first.and_then(|f| get(f, "question"))).cloned(),
                Some(payload),
                request_id(),
            )
        }
        Some("plan_approval_request") => mapped(
            "plan_approval_request",
            "Claude has a plan to review",
            first_line(field("plan"))?.map(Value::String),
            Some(pick(&["toolUseId"])),
            request_id(),
        ),
        Some("error") => {
            let scheduled = truthy_str(&ctx.run_id);
            if !scheduled && is_abort_sentinel(field("message"))? {
                return Ok(None);
            }
            let (kind, title) = if scheduled {
                ("scheduled_run_finished", "Scheduled run errored")
            } else {
                ("session_error", "Session error")
            };
            mapped(kind, title, field("message").cloned(), None, None)
        }
        Some("sdk") => {
            if !string_is(js::prop(field("message"), "type"), "result") {
                return Ok(None);
            }
            let Some(sid) = ctx.session_id.as_deref().filter(|s| !s.is_empty()) else {
                return Ok(None);
            };
            if ctx.has_active_background_work == Some(true) {
                return Ok(None);
            }
            if last_user_input_at.get(sid).copied().unwrap_or(0.0) == 0.0 {
                return Ok(None);
            }
            let body = ctx.session_title.clone().unwrap_or_else(|| ctx.cwd.clone());
            mapped(
                "session_idle",
                "Claude finished a turn",
                Some(json!(body)),
                None,
                None,
            )
        }
        Some("run_finished") => {
            let status = field("status");
            let title = if string_is(status, "success") {
                "Scheduled run finished".to_owned()
            } else {
                format!("Scheduled run {}", js::to_string(status))
            };
            let mut payload = pick(&["status"]);
            if let Some(c) = field("costUsd").filter(|c| js::truthy(c)) {
                payload.insert("costUsd".into(), c.clone());
            }
            mapped(
                "scheduled_run_finished",
                &title,
                nullish(field("note")).cloned(),
                Some(payload),
                None,
            )
        }
        _ => return Ok(None),
    }))
}

// ───────────────────────── workspaces.json ─────────────────────────

/// `listWorkspaces().catch(() => [])`, as TS reads the file: any read or
/// parse failure, a `version` other than 1 or a non-array `workspaces` is no
/// workspace; the entries are whatever the array holds.
fn workspace_entries() -> Vec<Value> {
    let Ok(bytes) = std::fs::read(workspaces::workspaces_path()) else {
        return Vec::new();
    };
    match js::json_parse(&String::from_utf8_lossy(&bytes)) {
        Ok(Value::Object(m)) if m.get("version").and_then(Value::as_f64) == Some(1.0) => {
            match m.get("workspaces") {
                Some(Value::Array(items)) => items.clone(),
                _ => Vec::new(),
            }
        }
        _ => Vec::new(),
    }
}

/// `statSync(workspacesFile()).mtimeMs`, 0 when it can't be read.
fn workspaces_mtime() -> f64 {
    let Ok(t) = std::fs::metadata(workspaces::workspaces_path()).and_then(|m| m.modified()) else {
        return 0.0;
    };
    let ms = |d: Duration| d.as_secs() as f64 * 1e3 + f64::from(d.subsec_nanos()) / 1e6;
    match t.duration_since(UNIX_EPOCH) {
        Ok(d) => ms(d),
        Err(e) => -ms(e.duration()),
    }
}

/// A workspace entry with a string id.
#[derive(Clone, Debug)]
struct Workspace {
    id: String,
    /// The `rootPath`, or the `TypeError` the DB layer throws on a
    /// non-string one (`encodeProjectDir` calls `.replace` on it).
    root: Result<String, JsError>,
    entry: Value,
}

impl Workspace {
    fn from_entry(entry: &Value) -> Option<Workspace> {
        let id = get(entry, "id")?.as_str()?.to_owned();
        let root = match get(entry, "rootPath") {
            Some(Value::String(r)) => Ok(r.clone()),
            None => Err(JsError(
                "Cannot read properties of undefined (reading 'replace')".into(),
            )),
            Some(Value::Null) => Err(JsError(
                "Cannot read properties of null (reading 'replace')".into(),
            )),
            Some(_) => Err(JsError("absPath.replace is not a function".into())),
        };
        Some(Workspace {
            id,
            root,
            entry: entry.clone(),
        })
    }

    /// `ws.defaults?.notifications`.
    fn prefs(&self) -> Option<&Value> {
        js::prop(get(&self.entry, "defaults"), "notifications")
    }

    fn root(&self) -> anyhow::Result<&str> {
        self.root.as_deref().map_err(|e| e.clone().into())
    }
}

/// `all.find((w) => w.id === id)`: a `null` entry before the match throws.
fn find_workspace(all: &[Value], id: &str) -> Result<Option<Workspace>, JsError> {
    for w in all {
        if string_is(get_or_throw(w, "id")?, id) {
            return Ok(Workspace::from_entry(w));
        }
    }
    Ok(None)
}

/// `getWorkspaceById`.
fn workspace_by_id(id: &str) -> Result<Option<Workspace>, JsError> {
    find_workspace(&workspace_entries(), id)
}

// ───────────────────────── the bus ─────────────────────────

struct Timer {
    id: u64,
    workspace_id: String,
    cwd: String,
}

#[derive(Default)]
struct State {
    subs: Vec<(u64, mpsc::UnboundedSender<StreamEvent>)>,
    next_sub: u64,
    /// sessionId → epoch ms of its last user input (the idle heuristic).
    last_user_input_at: HashMap<String, f64>,
    /// rootPath → workspace id (`None`: the entry's id isn't a string).
    cwd_map: Option<HashMap<String, Option<String>>>,
    cwd_map_mtime: f64,
    /// The last state sent (or answered) per workspace.
    per_workspace: HashMap<String, WorkspaceUnreadState>,
    /// workspace id → the timer that will flush it.
    pending_flush: HashMap<String, u64>,
    next_timer: u64,
    manual: VecDeque<Timer>,
}

impl State {
    fn fan_out(&mut self, ev: &StreamEvent) {
        self.subs.retain(|(_, tx)| tx.send(ev.clone()).is_ok());
    }

    fn next_version(&self, workspace_id: &str) -> u64 {
        self.per_workspace
            .get(workspace_id)
            .map_or(0, |s| s.version)
            + 1
    }
}

struct Shared {
    st: Mutex<State>,
    opts: BusOptions,
}

impl Shared {
    fn lock(&self) -> std::sync::MutexGuard<'_, State> {
        self.st.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// The timer callback: `emitStateSync` if the flush is still pending.
    /// The flag is cleared first, so a write during the read schedules a
    /// fresh flush.
    fn fire(&self, timer: &Timer) -> Result<(), String> {
        let mut st = self.lock();
        if st.pending_flush.get(&timer.workspace_id) != Some(&timer.id) {
            return Ok(());
        }
        st.pending_flush.remove(&timer.workspace_id);
        let Some(db) = cached_db(&timer.cwd, Mode::ReadWrite)
            .or_else(|| cached_db(&timer.cwd, Mode::ReadOnly))
        else {
            return Ok(());
        };
        let (total_unread, per_session) = db
            .with(|c| {
                Ok((
                    ndb::unread_count_on(c)?,
                    ndb::unread_counts_by_session_on(c)?,
                ))
            })
            .map_err(|e| e.to_string())?;
        let state = WorkspaceUnreadState {
            workspace_id: timer.workspace_id.clone(),
            version: st.next_version(&timer.workspace_id),
            total_unread,
            per_session,
        };
        st.per_workspace
            .insert(timer.workspace_id.clone(), state.clone());
        st.fan_out(&StreamEvent::State(state));
        Ok(())
    }
}

/// The notification bus. Cheap to clone; clones share one bus.
#[derive(Clone)]
pub struct NotificationBus {
    shared: Arc<Shared>,
}

impl Default for NotificationBus {
    fn default() -> Self {
        NotificationBus::new(BusOptions::default())
    }
}

/// A subscriber's receiver. Dropping it unsubscribes.
pub struct NotificationSubscription {
    shared: Arc<Shared>,
    id: u64,
    pub rx: mpsc::UnboundedReceiver<StreamEvent>,
}

impl NotificationSubscription {
    pub async fn recv(&mut self) -> Option<StreamEvent> {
        self.rx.recv().await
    }
}

impl Drop for NotificationSubscription {
    fn drop(&mut self) {
        self.shared.lock().subs.retain(|(id, _)| *id != self.id);
    }
}

impl NotificationBus {
    pub fn new(opts: BusOptions) -> NotificationBus {
        NotificationBus {
            shared: Arc::new(Shared {
                st: Mutex::new(State::default()),
                opts,
            }),
        }
    }

    /// The process's bus (real clock, random ids, real timers).
    pub fn global() -> &'static NotificationBus {
        static BUS: OnceLock<NotificationBus> = OnceLock::new();
        BUS.get_or_init(NotificationBus::default)
    }

    fn now(&self) -> f64 {
        (self.shared.opts.clock)()
    }

    // ── cwd → workspace ──

    /// `refreshCwdMapIfStale`: re-read the map when workspaces.json's mtime
    /// moved (or there is none yet). A `null` entry throws and leaves the
    /// old map in place.
    fn refresh_cwd_map_if_stale(&self) -> Result<(), JsError> {
        let mtime = workspaces_mtime();
        {
            let st = self.shared.lock();
            if st.cwd_map.is_some() && st.cwd_map_mtime == mtime {
                return Ok(());
            }
        }
        let mut map = HashMap::new();
        for w in workspace_entries() {
            let root = get_or_throw(&w, "rootPath")?;
            let id = get(&w, "id");
            // A non-string rootPath never matches a cwd.
            if let Some(Value::String(root)) = root {
                map.insert(root.clone(), id.and_then(Value::as_str).map(str::to_owned));
            }
        }
        let mut st = self.shared.lock();
        st.cwd_map = Some(map);
        st.cwd_map_mtime = mtime;
        Ok(())
    }

    /// `lookupWorkspace(cwd)`: the cached map's id for the cwd (`""` is
    /// none), then that workspace as the file holds it now.
    fn lookup_workspace(&self, cwd: &str) -> Result<Option<Workspace>, JsError> {
        self.refresh_cwd_map_if_stale()?;
        let id = {
            let st = self.shared.lock();
            st.cwd_map
                .as_ref()
                .and_then(|m| m.get(cwd))
                .cloned()
                .flatten()
        };
        match id.filter(|id| !id.is_empty()) {
            Some(id) => workspace_by_id(&id),
            None => Ok(None),
        }
    }

    // ── producers ──

    /// `markUserInput(sessionId)`: stamp the session's last input now.
    pub fn mark_user_input(&self, session_id: &str) {
        let at = self.now();
        self.mark_user_input_at(session_id, at);
    }

    /// `markUserInput(sessionId, at)`.
    pub fn mark_user_input_at(&self, session_id: &str, at: f64) {
        self.shared
            .lock()
            .last_user_input_at
            .insert(session_id.to_owned(), at);
    }

    /// `resetForTests`: drop subscribers, caches, versions and pending
    /// flushes. A flush timer already queued still fires, as a no-op (TS
    /// clears it).
    pub fn reset_for_tests(&self) {
        let mut st = self.shared.lock();
        let next_sub = st.next_sub;
        let next_timer = st.next_timer;
        let manual = std::mem::take(&mut st.manual);
        *st = State {
            next_sub,
            next_timer,
            manual,
            ..State::default()
        };
    }

    /// `recordSessionEvent`. Never fails: notifications are best effort.
    /// It reads workspaces.json and the database synchronously; TS fires it
    /// and moves on, so a caller on a hot path can run it off-thread.
    pub fn record_session_event(
        &self,
        cwd: &str,
        session_id: &str,
        event: &Value,
        opts: SessionEventOpts,
    ) {
        let ctx = RecordContext {
            cwd: cwd.to_owned(),
            session_id: Some(session_id.to_owned()),
            run_id: None,
            job_id: None,
            session_title: opts.session_title,
            has_subscribers: opts.has_subscribers,
            has_active_background_work: opts.has_active_background_work,
        };
        let _ = self.record(event, &ctx);
    }

    /// `recordSchedulerEvent`.
    pub fn record_scheduler_event(&self, cwd: &str, run_id: &str, job_id: &str, event: &Value) {
        let ctx = RecordContext {
            cwd: cwd.to_owned(),
            run_id: Some(run_id.to_owned()),
            job_id: Some(job_id.to_owned()),
            ..RecordContext::default()
        };
        let _ = self.record(event, &ctx);
    }

    /// `record()`: the filters, the insert and the fan-out (see the module
    /// docs). An `Err` is what TS's catch-all swallows.
    fn record(&self, event: &Value, ctx: &RecordContext) -> anyhow::Result<()> {
        // 1. Subagent messages (`event.type` throws on `null`).
        if string_is(get_or_throw(event, "type")?, "sdk") {
            let m = get(event, "message");
            if m.is_some_and(js::truthy) && nullish(js::prop(m, "parent_tool_use_id")).is_some() {
                return Ok(());
            }
        }
        // 2. cwd → workspace.
        let Some(ws) = self.lookup_workspace(&ctx.cwd)? else {
            return Ok(());
        };
        let prefs = ws.prefs();
        let master_enabled = prefs.and_then(|p| get(p, "enabled")) != Some(&Value::Bool(false));
        let status_sync =
            master_enabled && truthy_str(&ctx.session_id) && is_status_sync_relevant(event);
        if status_sync && cached_db(&ctx.cwd, Mode::ReadWrite).is_none() {
            // Cold cache: open it now so the flush finds a handle.
            let _ = open_db(&ctx.cwd, Mode::ReadWrite);
        }
        let emit_status_sync = || {
            if status_sync {
                self.schedule_state_emit(&ws.id, &ctx.cwd);
            }
        };
        // 3. event → kind.
        let mapped = {
            let st = self.shared.lock();
            map_event_to_kind(event, ctx, &st.last_user_input_at)?
        };
        let Some(mapped) = mapped else {
            emit_status_sync();
            return Ok(());
        };
        let suppress_toast = truthy_str(&ctx.session_id)
            && ctx.has_subscribers == Some(false)
            && is_background_suppressible(mapped.kind);
        // 4. The workspace's kinds.
        if !is_kind_enabled(mapped.kind, prefs)? {
            emit_status_sync();
            return Ok(());
        }
        // 5. Per-session block / snooze.
        if let Some(sid) = ctx.session_id.as_deref().filter(|s| !s.is_empty()) {
            let clock = &*self.shared.opts.clock;
            if ndb::is_session_muted_with(&ctx.cwd, sid, clock).unwrap_or(false) {
                emit_status_sync();
                return Ok(());
            }
        }
        // 6. Persist (`INSERT OR IGNORE`).
        let input = NewNotification {
            id: None,
            session_id: ctx.session_id.clone(),
            run_id: ctx.run_id.clone(),
            job_id: ctx.job_id.clone(),
            kind: mapped.kind.to_owned(),
            title: mapped.title,
            body: mapped.body.unwrap_or(Value::Null),
            payload: mapped.payload,
            request_id: mapped.request_id.unwrap_or(Value::Null),
            created_at: None,
        };
        let opts = &self.shared.opts;
        let Some(row) =
            ndb::insert_notification(&ctx.cwd, &ws.id, &input, &*opts.clock, &*opts.new_id)?
        else {
            emit_status_sync();
            return Ok(());
        };
        // 7. Fan out.
        if !suppress_toast {
            self.shared
                .lock()
                .fan_out(&StreamEvent::Notification(Box::new(row)));
        }
        self.schedule_state_emit(&ws.id, &ctx.cwd);
        Ok(())
    }

    // ── state flushes ──

    /// `scheduleStateEmit`: one pending flush per workspace; later calls
    /// before it runs are folded into it (with the first call's cwd).
    fn schedule_state_emit(&self, workspace_id: &str, cwd: &str) {
        let timer = {
            let mut st = self.shared.lock();
            if st.pending_flush.contains_key(workspace_id) {
                return;
            }
            st.next_timer += 1;
            let timer = Timer {
                id: st.next_timer,
                workspace_id: workspace_id.to_owned(),
                cwd: cwd.to_owned(),
            };
            st.pending_flush.insert(workspace_id.to_owned(), timer.id);
            if self.shared.opts.timers == Timers::Manual {
                st.manual.push_back(timer);
                return;
            }
            timer
        };
        let shared = self.shared.clone();
        let run = move || {
            if let Err(e) = shared.fire(&timer) {
                // TS throws out of its timer callback here.
                tracing::warn!(target: log::SESSION, workspaceId = %timer.workspace_id, error = %e, "[notifications] state flush failed");
            }
        };
        match tokio::runtime::Handle::try_current() {
            Ok(rt) => {
                rt.spawn(async move {
                    tokio::time::sleep(Duration::from_millis(1)).await;
                    run();
                });
            }
            Err(_) => {
                std::thread::spawn(move || {
                    std::thread::sleep(Duration::from_millis(1));
                    run();
                });
            }
        }
    }

    /// Run the queued flushes in order ([`Timers::Manual`]): what they
    /// failed with (TS throws out of the timer callback).
    pub fn run_timers(&self) -> Vec<String> {
        let mut errors = Vec::new();
        loop {
            let Some(timer) = self.shared.lock().manual.pop_front() else {
                return errors;
            };
            if let Err(e) = self.shared.fire(&timer) {
                errors.push(e);
            }
        }
    }

    /// `computeAndStoreState`: fresh counts (0 / `{}` when they can't be
    /// read), one version up.
    fn compute_and_store_state(&self, ws: &Workspace) -> WorkspaceUnreadState {
        let (total_unread, per_session) = match &ws.root {
            Ok(cwd) => (
                ndb::unread_count(cwd).unwrap_or(0),
                ndb::unread_counts_by_session(cwd).unwrap_or_default(),
            ),
            Err(_) => (0, Map::new()),
        };
        let mut st = self.shared.lock();
        let state = WorkspaceUnreadState {
            workspace_id: ws.id.clone(),
            version: st.next_version(&ws.id),
            total_unread,
            per_session,
        };
        st.per_workspace.insert(ws.id.clone(), state.clone());
        state
    }

    // ── consumers ──

    /// `subscribe`: every `notification` and `state` event from now on.
    pub fn subscribe(&self) -> NotificationSubscription {
        let (tx, rx) = mpsc::unbounded_channel();
        let mut st = self.shared.lock();
        st.next_sub += 1;
        let id = st.next_sub;
        st.subs.push((id, tx));
        NotificationSubscription {
            shared: self.shared.clone(),
            id,
            rx,
        }
    }

    /// The number of live subscribers.
    pub fn subscriber_count(&self) -> usize {
        self.shared.lock().subs.len()
    }

    /// `list(workspaceId, opts)`: the workspace's rows, newest first; none
    /// for an unknown workspace.
    pub fn list(
        &self,
        workspace_id: &str,
        opts: &ListOpts,
    ) -> anyhow::Result<Vec<NotificationRow>> {
        let Some(ws) = workspace_by_id(workspace_id)? else {
            return Ok(Vec::new());
        };
        match &ws.root {
            Ok(cwd) => ndb::list_notifications(cwd, workspace_id, opts),
            Err(_) => Ok(Vec::new()),
        }
    }

    /// `listAcrossWorkspaces({limit, unreadOnly})`: up to `limit` rows from
    /// each workspace (a workspace whose read fails gives none), merged by
    /// `createdAt` descending with a stable sort (ties keep workspace order,
    /// then the query's), cut to `limit`. `before` isn't used.
    ///
    /// The sort subtracts `createdAt` like the TS comparator; rows whose
    /// `createdAt` reads as NaN (foreign text or blobs) compare equal to
    /// everything, where V8's TimSort can order them differently.
    pub fn list_across_workspaces(&self, opts: &ListOpts) -> anyhow::Result<Vec<NotificationRow>> {
        let limit = ndb::clamp_limit(opts.limit);
        let per_ws = ListOpts {
            limit: Some(limit),
            before: None,
            unread_only: opts.unread_only,
        };
        let mut merged = Vec::new();
        for w in workspace_entries() {
            get_or_throw(&w, "rootPath")?;
            let Some(ws) = Workspace::from_entry(&w) else {
                continue;
            };
            if let Ok(cwd) = &ws.root {
                merged.extend(ndb::list_notifications(cwd, &ws.id, &per_ws).unwrap_or_default());
            }
        }
        merged.sort_by(|a, b| {
            let d = b.created_at_number() - a.created_at_number();
            d.partial_cmp(&0.0).unwrap_or(std::cmp::Ordering::Equal)
        });
        // `slice(0, limit)`: NaN is 0, a fraction rounds down.
        merged.truncate(limit as usize);
        Ok(merged)
    }

    /// `markRead(workspaceId, ids)`: rows that flipped; a `state` flush when
    /// any did.
    pub fn mark_read(&self, workspace_id: &str, ids: &[String]) -> anyhow::Result<usize> {
        let Some(ws) = workspace_by_id(workspace_id)? else {
            return Ok(0);
        };
        if ids.is_empty() {
            return Ok(0);
        }
        let cwd = ws.root()?;
        let changed = ndb::mark_read(cwd, ids, &*self.shared.opts.clock)?;
        if changed > 0 {
            self.schedule_state_emit(workspace_id, cwd);
        }
        Ok(changed)
    }

    /// `markAllRead(workspaceId)`.
    pub fn mark_all_read(&self, workspace_id: &str) -> anyhow::Result<usize> {
        let Some(ws) = workspace_by_id(workspace_id)? else {
            return Ok(0);
        };
        let cwd = ws.root()?;
        let changed = ndb::mark_all_read(cwd, &*self.shared.opts.clock)?;
        if changed > 0 {
            self.schedule_state_emit(workspace_id, cwd);
        }
        Ok(changed)
    }

    /// `markReadBySession(workspaceId, sessionId)`: the session's rows
    /// except the actionable kinds.
    pub fn mark_read_by_session(
        &self,
        workspace_id: &str,
        session_id: &str,
    ) -> anyhow::Result<usize> {
        if session_id.is_empty() {
            return Ok(0);
        }
        let Some(ws) = workspace_by_id(workspace_id)? else {
            return Ok(0);
        };
        let cwd = ws.root()?;
        let changed = ndb::mark_read_by_session(cwd, session_id, &*self.shared.opts.clock)?;
        if changed > 0 {
            self.schedule_state_emit(workspace_id, cwd);
        }
        Ok(changed)
    }

    /// `markReadByKind(workspaceId, kind)`.
    pub fn mark_read_by_kind(&self, workspace_id: &str, kind: &str) -> anyhow::Result<usize> {
        if kind.is_empty() {
            return Ok(0);
        }
        let Some(ws) = workspace_by_id(workspace_id)? else {
            return Ok(0);
        };
        let cwd = ws.root()?;
        let changed = ndb::mark_read_by_kind(cwd, kind, &*self.shared.opts.clock)?;
        if changed > 0 {
            self.schedule_state_emit(workspace_id, cwd);
        }
        Ok(changed)
    }

    /// `sweepOrphanedActionableForSession(cwd, sessionId)`: mark the
    /// session's unread actionable rows read (nothing can answer them any
    /// more). The database first, then the workspace; best effort.
    pub fn sweep_orphaned_actionable_for_session(&self, cwd: &str, session_id: &str) {
        if session_id.is_empty() {
            return;
        }
        let run = || -> anyhow::Result<()> {
            let changed =
                ndb::mark_read_actionable_by_session(cwd, session_id, &*self.shared.opts.clock)?;
            if changed == 0 {
                return Ok(());
            }
            if let Some(ws) = self.lookup_workspace(cwd)? {
                self.schedule_state_emit(&ws.id, cwd);
            }
            Ok(())
        };
        let _ = run();
    }

    /// `markReadByRequestId(cwd, requestId)`: clear a prompt's rows once it
    /// is answered. The workspace first (no database is touched without
    /// one), then the rows; best effort.
    pub fn mark_read_by_request_id(&self, cwd: &str, request_id: &str) {
        if request_id.is_empty() {
            return;
        }
        let run = || -> anyhow::Result<()> {
            let Some(ws) = self.lookup_workspace(cwd)? else {
                return Ok(());
            };
            let changed = ndb::mark_read_by_request_id(cwd, request_id, &*self.shared.opts.clock)?;
            if !changed.is_empty() {
                self.schedule_state_emit(&ws.id, cwd);
            }
            Ok(())
        };
        let _ = run();
    }

    /// `getWorkspaceState(workspaceId)`: a fresh snapshot, one version up;
    /// `None` for an unknown workspace.
    pub fn get_workspace_state(
        &self,
        workspace_id: &str,
    ) -> anyhow::Result<Option<WorkspaceUnreadState>> {
        let Some(ws) = workspace_by_id(workspace_id)? else {
            return Ok(None);
        };
        Ok(Some(self.compute_and_store_state(&ws)))
    }

    /// `getAllWorkspaceStates()`: every workspace's snapshot, keyed by id in
    /// workspace order (a repeated id keeps its first place and the last
    /// snapshot). TS inserts each key as its reads settle, so its order can
    /// differ while a handle isn't cached yet. A `null` entry fails the call
    /// after the others have been counted, as `Promise.all` rejects.
    pub fn get_all_workspace_states(
        &self,
    ) -> anyhow::Result<IndexMap<String, WorkspaceUnreadState>> {
        let mut out = IndexMap::new();
        let mut threw = None;
        for w in workspace_entries() {
            if let Err(e) = get_or_throw(&w, "id") {
                threw.get_or_insert(e);
                continue;
            }
            if let Some(ws) = Workspace::from_entry(&w) {
                let state = self.compute_and_store_state(&ws);
                out.insert(ws.id, state);
            }
        }
        match threw {
            Some(e) => Err(e.into()),
            None => Ok(out),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ctx(sid: Option<&str>) -> RecordContext {
        RecordContext {
            cwd: "/c".into(),
            session_id: sid.map(str::to_owned),
            ..RecordContext::default()
        }
    }

    #[test]
    fn first_line_cuts_at_utf16_units() {
        let s = |v: &str| first_line(Some(&json!(v))).unwrap();
        assert_eq!(s("  a \r\nb"), Some("a".into()));
        assert_eq!(s("a\rb\nc"), Some("a\rb".into()));
        assert_eq!(s("\nx"), None);
        assert_eq!(s(&"a".repeat(200)), Some("a".repeat(200)));
        assert_eq!(
            s(&"a".repeat(201)),
            Some(format!("{}\u{2026}", "a".repeat(197)))
        );
        // 196 + a pair: the pair straddles unit 197, JS keeps half of it.
        assert_eq!(
            s(&format!("{}\u{1F600}{}", "a".repeat(196), "b".repeat(10))),
            Some(format!("{}\u{FFFD}\u{2026}", "a".repeat(196)))
        );
        assert_eq!(
            s(&format!("{}\u{1F600}{}", "a".repeat(195), "b".repeat(10))),
            Some(format!("{}\u{1F600}\u{2026}", "a".repeat(195)))
        );
        assert_eq!(first_line(Some(&json!(0))).unwrap(), None);
        assert!(first_line(Some(&json!(5))).is_err());
        assert!(first_line(Some(&json!([]))).is_err());
    }

    #[test]
    fn kinds_follow_the_prefs() {
        let k = |kind, prefs: Value| is_kind_enabled(kind, Some(&prefs));
        assert_eq!(is_kind_enabled("session_idle", None), Ok(true));
        assert_eq!(is_kind_enabled("session_error", None), Ok(false));
        assert_eq!(k("session_idle", json!({"enabled": false})), Ok(false));
        assert_eq!(
            k("session_error", json!({"enabledKinds": ["session_error"]})),
            Ok(true)
        );
        assert_eq!(k("session_idle", json!({"enabledKinds": []})), Ok(false));
        assert_eq!(
            k("session_idle", json!({"enabledKinds": "xsession_idlex"})),
            Ok(true)
        );
        assert!(k("session_idle", json!({"enabledKinds": 5})).is_err());
    }

    #[test]
    fn idle_needs_an_input_and_no_background_work() {
        let ev = json!({"type": "sdk", "message": {"type": "result"}});
        let mut inputs = HashMap::new();
        assert_eq!(map_event_to_kind(&ev, &ctx(Some("s")), &inputs), Ok(None));
        inputs.insert("s".to_owned(), 5.0);
        let m = map_event_to_kind(&ev, &ctx(Some("s")), &inputs)
            .unwrap()
            .unwrap();
        assert_eq!(m.kind, "session_idle");
        assert_eq!(m.body, Some(json!("/c")));
        let bg = RecordContext {
            has_active_background_work: Some(true),
            ..ctx(Some("s"))
        };
        assert_eq!(map_event_to_kind(&ev, &bg, &inputs), Ok(None));
        assert_eq!(map_event_to_kind(&ev, &ctx(Some("")), &inputs), Ok(None));
    }

    #[test]
    fn stream_events_print_the_ts_envelope() {
        let state = WorkspaceUnreadState {
            workspace_id: "w".into(),
            version: 3,
            total_unread: 2,
            per_session: json!({"10": 1, "2": 1}).as_object().unwrap().clone(),
        };
        assert_eq!(
            js::stringify(&StreamEvent::State(state).to_json()),
            r#"{"type":"state","workspaceId":"w","version":3,"totalUnread":2,"perSession":{"2":1,"10":1}}"#
        );
    }
}
