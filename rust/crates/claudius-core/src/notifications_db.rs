//! `lib/server/notifications-db.ts` and the constants of
//! `lib/shared/notifications.ts`: the per-workspace inbox (`notifications`,
//! migration 005) and the per-session prefs (`session_notification_prefs`).
//! The bus on top of them is [`crate::notification_bus`].
//!
//! Both tables live in each cwd's `.claudius.db` ([`open_db`]), keyed by the
//! cwd, never by the workspace. Values are kept as better-sqlite3 hands them
//! to JS and bound as it binds them (every number a REAL), so a row another
//! writer filled with foreign values (TEXT / BLOB / REAL where the schema
//! says otherwise), or a table it created with other column types (the
//! migration's `CREATE TABLE IF NOT EXISTS` keeps one), reads, rewrites and
//! compares as it does in TS.
//!
//! Prefs: a row is a block switch and an optional snooze deadline (epoch ms).
//!
//! Inbox: every function opens the database the way TS does, because which
//! handle is cached is visible to the bus (its cold-cache prime and its
//! synchronous state flush): readers open it read-only and answer empty when
//! it can't open (no file yet), writers open it read-write and fail. The
//! clock is read lazily through `now`, at the points `Date.now()` is.

use claudius_agent::js;
use rusqlite::types::{ToSqlOutput, Value as Sql, ValueRef};
use rusqlite::{Connection, OptionalExtension, ToSql};
use serde_json::{Map, Value, json};

use crate::db::{Mode, open_db};
use crate::sql_text::{self, JsText, bind_js_args};
use crate::{js_num, js_params, js_string, now_ms};

// ───────────────────────── kinds (lib/shared/notifications.ts) ─────────────────────────

/// `DEFAULT_ENABLED_KINDS`: what a workspace without `enabledKinds` gets.
/// `session_error` is opt-in.
pub const DEFAULT_ENABLED_KINDS: [&str; 5] = [
    "permission_request",
    "ask_user_question",
    "plan_approval_request",
    "session_idle",
    "scheduled_run_finished",
];

/// `OPT_IN_KINDS`: off unless a workspace enables them.
pub const OPT_IN_KINDS: [&str; 1] = ["session_error"];

/// `ALL_NOTIFICATION_KINDS`: defaults first, then the opt-ins.
pub const ALL_NOTIFICATION_KINDS: [&str; 6] = [
    "permission_request",
    "ask_user_question",
    "plan_approval_request",
    "session_idle",
    "scheduled_run_finished",
    "session_error",
];

/// `ACTIONABLE_KINDS`: the agent is blocked on the user. Only the resolve
/// paths (`markReadByRequestId`) and the orphan sweep mark them read.
pub const ACTIONABLE_KINDS: [&str; 3] = [
    "permission_request",
    "ask_user_question",
    "plan_approval_request",
];

/// `isActionableKind`.
pub fn is_actionable_kind(kind: &str) -> bool {
    ACTIONABLE_KINDS.contains(&kind)
}

// ───────────────────────── inbox rows ─────────────────────────

/// A column value as better-sqlite3 hands it to JS.
#[derive(Clone, Debug, PartialEq)]
pub enum Cell {
    Null,
    /// INTEGER (rounded past 2^53, as JS reads it) or REAL.
    Number(f64),
    /// TEXT, decoded lossily like V8 decodes it.
    Text(String),
    /// BLOB: a Node `Buffer`.
    Blob(Vec<u8>),
}

impl Cell {
    pub fn read(v: ValueRef) -> Cell {
        match v {
            ValueRef::Null => Cell::Null,
            ValueRef::Integer(n) => Cell::Number(n as f64),
            ValueRef::Real(f) => Cell::Number(f),
            ValueRef::Text(t) => Cell::Text(String::from_utf8_lossy(t).into_owned()),
            ValueRef::Blob(b) => Cell::Blob(b.to_vec()),
        }
    }

    /// `JSON.stringify`'s view: a non-finite number is `null`, a `Buffer`
    /// is `{type: "Buffer", data}`.
    pub fn to_json(&self) -> Value {
        match self {
            Cell::Null => Value::Null,
            Cell::Number(f) => js_num(*f),
            Cell::Text(s) => json!(s),
            Cell::Blob(b) => json!({"type": "Buffer", "data": b}),
        }
    }

    /// `!!value`. A `Buffer` is an object, so always truthy.
    fn truthy(&self) -> bool {
        match self {
            Cell::Null => false,
            Cell::Number(f) => *f != 0.0 && !f.is_nan(),
            Cell::Text(s) => !s.is_empty(),
            Cell::Blob(_) => true,
        }
    }

    /// `String(value)`; a `Buffer` prints its bytes as UTF-8.
    fn to_js_string(&self) -> String {
        match self {
            Cell::Null => "null".into(),
            Cell::Number(f) if f.is_nan() => "NaN".into(),
            Cell::Number(f) if f.is_infinite() => {
                if *f > 0.0 { "Infinity" } else { "-Infinity" }.into()
            }
            Cell::Number(f) => js::number_to_string(*f),
            Cell::Text(s) => s.clone(),
            Cell::Blob(b) => String::from_utf8_lossy(b).into_owned(),
        }
    }

    /// The number JS arithmetic reads (`b.createdAt - a.createdAt`): `null`
    /// is 0, text goes through `Number()`, a `Buffer` through its text.
    fn to_number(&self) -> f64 {
        match self {
            Cell::Null => 0.0,
            Cell::Number(f) => *f,
            Cell::Text(_) | Cell::Blob(_) => js::to_number(&self.to_js_string()),
        }
    }
}

/// `NotificationRow`, the wire shape of an inbox row. Each field is the JS
/// value TS holds: a hydrated row's are the stored cells as better-sqlite3
/// reads them (so a foreign row can carry a number id or a `Buffer` title);
/// the row `insertNotification` returns holds what it was given.
#[derive(Clone, Debug, PartialEq)]
pub struct NotificationRow {
    pub id: Value,
    pub workspace_id: String,
    pub session_id: Value,
    pub run_id: Value,
    pub job_id: Value,
    pub kind: Value,
    pub title: Value,
    pub body: Value,
    /// The parsed JSON object, or `None` (`null`).
    pub payload: Option<Map<String, Value>>,
    pub created_at: Value,
    pub read_at: Value,
    /// `createdAt` as the cross-workspace sort subtracts it.
    created_at_number: f64,
}

impl NotificationRow {
    /// The TS object in its key order. Serialize it with
    /// `claudius_agent::js::stringify`.
    pub fn to_json(&self) -> Value {
        let mut m = Map::new();
        m.insert("id".into(), self.id.clone());
        m.insert("workspaceId".into(), json!(self.workspace_id));
        m.insert("sessionId".into(), self.session_id.clone());
        m.insert("runId".into(), self.run_id.clone());
        m.insert("jobId".into(), self.job_id.clone());
        m.insert("kind".into(), self.kind.clone());
        m.insert("title".into(), self.title.clone());
        m.insert("body".into(), self.body.clone());
        m.insert(
            "payload".into(),
            self.payload.clone().map_or(Value::Null, Value::Object),
        );
        m.insert("createdAt".into(), self.created_at.clone());
        m.insert("readAt".into(), self.read_at.clone());
        Value::Object(m)
    }

    /// `createdAt` as JS arithmetic reads it.
    pub fn created_at_number(&self) -> f64 {
        self.created_at_number
    }
}

const ROW_COLUMNS: &str =
    "id, session_id, run_id, job_id, kind, title, body, payload, request_id, created_at, read_at";

/// `hydrate(row, workspaceId)`: a non-empty `payload` is `JSON.parse`d
/// (from its `String()`), and kept only when it is a plain object.
fn hydrate(r: &rusqlite::Row, workspace_id: &str) -> rusqlite::Result<NotificationRow> {
    let cell = |i: usize| -> rusqlite::Result<Cell> { Ok(Cell::read(r.get_ref(i)?)) };
    let payload_cell = cell(7)?;
    let payload = if payload_cell.truthy() {
        match js::json_parse(&payload_cell.to_js_string()) {
            Ok(Value::Object(m)) => Some(m),
            _ => None,
        }
    } else {
        None
    };
    let created_at = cell(9)?;
    Ok(NotificationRow {
        id: cell(0)?.to_json(),
        workspace_id: workspace_id.to_owned(),
        session_id: cell(1)?.to_json(),
        run_id: cell(2)?.to_json(),
        job_id: cell(3)?.to_json(),
        kind: cell(4)?.to_json(),
        title: cell(5)?.to_json(),
        body: cell(6)?.to_json(),
        payload,
        created_at_number: created_at.to_number(),
        created_at: created_at.to_json(),
        read_at: cell(10)?.to_json(),
    })
}

/// `insertNotification`'s input. `body` and `request_id` are any JS value
/// (the bus passes event fields through), `Null` standing for `null` /
/// `undefined`; they are bound the way better-sqlite3 binds an argument.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct NewNotification {
    pub id: Option<String>,
    pub session_id: Option<String>,
    pub run_id: Option<String>,
    pub job_id: Option<String>,
    pub kind: String,
    pub title: String,
    pub body: Value,
    pub payload: Option<Map<String, Value>>,
    pub request_id: Value,
    pub created_at: Option<f64>,
}

/// `insertNotification`: `INSERT OR IGNORE`, so a `request_id` already in
/// the table (the partial UNIQUE index) inserts nothing and answers `None`.
/// The id (`new_id`) and the clock are taken after the database opens, even
/// when the row is then ignored or fails to bind.
pub fn insert_notification(
    cwd: &str,
    workspace_id: &str,
    input: &NewNotification,
    now: &dyn Fn() -> f64,
    new_id: &dyn Fn() -> String,
) -> anyhow::Result<Option<NotificationRow>> {
    let db = open_db(cwd, Mode::ReadWrite)?;
    let id = input.id.clone().unwrap_or_else(new_id);
    let created_at = input.created_at.unwrap_or_else(now);
    let payload = input
        .payload
        .as_ref()
        .map(|p| js_string::stringify(&Value::Object(p.clone())));
    let opt = |v: &Option<String>| v.as_ref().map_or(Value::Null, |s| json!(s));
    let args = [
        json!(id),
        opt(&input.session_id),
        opt(&input.run_id),
        opt(&input.job_id),
        json!(input.kind),
        json!(input.title),
        input.body.clone(),
        payload.map_or(Value::Null, Value::String),
        input.request_id.clone(),
        // A JS number: bound as a REAL (`js_num` keeps a fraction).
        js_num(created_at),
    ];
    let changes = db.with(|c| {
        let mut st = c.prepare(
            "INSERT OR IGNORE INTO notifications
         (id, session_id, run_id, job_id, kind, title, body, payload, request_id, created_at, read_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)",
        )?;
        let mut values = bind_js_args(&args, st.parameter_count())
            .map_err(|e| rusqlite::Error::ToSqlConversionFailure(e.into()))?;
        // The clock is the last argument and a scalar, so the last value;
        // bound as the f64 itself, which `js_num` can't carry when infinite.
        if let Some(last) = values.last_mut() {
            *last = Sql::Real(created_at);
        }
        st.execute(rusqlite::params_from_iter(values.into_iter().map(JsText::new)))
    });
    let changes = match changes {
        Ok(n) => n,
        Err(rusqlite::Error::ToSqlConversionFailure(e)) => anyhow::bail!("{e}"),
        Err(e) => return Err(e.into()),
    };
    if changes == 0 {
        return Ok(None);
    }
    Ok(Some(NotificationRow {
        id: json!(id),
        workspace_id: workspace_id.to_owned(),
        session_id: opt(&input.session_id),
        run_id: opt(&input.run_id),
        job_id: opt(&input.job_id),
        kind: json!(input.kind),
        title: json!(input.title),
        body: input.body.clone(),
        payload: input.payload.clone(),
        created_at: js_num(created_at),
        read_at: Value::Null,
        created_at_number: created_at,
    }))
}

/// `listNotifications`' options.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct ListOpts {
    /// Clamped to 1..=200 (`?? 50`). A fraction, NaN or an infinite value
    /// left after the clamp fails the query (`datatype mismatch`), as the
    /// bound REAL does in TS.
    pub limit: Option<f64>,
    /// A `created_at` cursor, used when truthy (non-zero, not NaN).
    pub before: Option<f64>,
    pub unread_only: bool,
}

/// `Math.max(1, Math.min(200, limit ?? 50))`, NaN staying NaN.
pub fn clamp_limit(limit: Option<f64>) -> f64 {
    limit.unwrap_or(50.0).clamp(1.0, 200.0)
}

/// `listNotifications`: newest first. No database (it can't open read-only)
/// is an empty list; a failing query is an error.
pub fn list_notifications(
    cwd: &str,
    workspace_id: &str,
    opts: &ListOpts,
) -> anyhow::Result<Vec<NotificationRow>> {
    let Ok(db) = open_db(cwd, Mode::ReadOnly) else {
        return Ok(Vec::new());
    };
    let limit = clamp_limit(opts.limit);
    let mut clauses = Vec::new();
    let mut args = Vec::new();
    if opts.unread_only {
        clauses.push("read_at IS NULL");
    }
    if let Some(before) = opts.before.filter(|b| *b != 0.0 && !b.is_nan()) {
        clauses.push("created_at < ?");
        args.push(Sql::Real(before));
    }
    let where_clause = if clauses.is_empty() {
        String::new()
    } else {
        format!("WHERE {}", clauses.join(" AND "))
    };
    args.push(Sql::Real(limit));
    let sql = format!(
        "SELECT {ROW_COLUMNS}
       FROM notifications {where_clause}
       ORDER BY created_at DESC LIMIT ?"
    );
    Ok(db.with(|c| {
        let mut st = c.prepare(&sql)?;
        let rows = st.query_map(rusqlite::params_from_iter(args), |r| {
            hydrate(r, workspace_id)
        })?;
        rows.collect::<rusqlite::Result<Vec<_>>>()
    })?)
}

/// `unreadCount`: 0 without a database.
pub fn unread_count(cwd: &str) -> anyhow::Result<i64> {
    let Ok(db) = open_db(cwd, Mode::ReadOnly) else {
        return Ok(0);
    };
    Ok(db.with(unread_count_on)?)
}

/// `unreadCountOn`: the bus's synchronous read on a handle it already has.
pub fn unread_count_on(c: &Connection) -> rusqlite::Result<i64> {
    c.query_row(
        "SELECT COUNT(*) AS n FROM notifications WHERE read_at IS NULL",
        [],
        |r| r.get(0),
    )
}

/// `unreadCountsBySession`: unread rows per `session_id` (rows without one
/// are skipped), as the plain object TS builds: keys are `String(session_id)`
/// in the order the groups come back, a later group with the same key
/// overwriting the count in place. `{}` without a database.
pub fn unread_counts_by_session(cwd: &str) -> anyhow::Result<Map<String, Value>> {
    let Ok(db) = open_db(cwd, Mode::ReadOnly) else {
        return Ok(Map::new());
    };
    Ok(db.with(unread_counts_by_session_on)?)
}

/// `unreadCountsBySessionOn`.
pub fn unread_counts_by_session_on(c: &Connection) -> rusqlite::Result<Map<String, Value>> {
    let mut st = c.prepare(
        "SELECT session_id, COUNT(*) AS n
         FROM notifications
        WHERE read_at IS NULL AND session_id IS NOT NULL
        GROUP BY session_id",
    )?;
    let rows = st.query_map([], |r| {
        Ok((
            Cell::read(r.get_ref(0)?).to_js_string(),
            r.get::<_, i64>(1)?,
        ))
    })?;
    let mut out = Map::new();
    for row in rows {
        let (k, n) = row?;
        out.insert(k, json!(n));
    }
    Ok(out)
}

/// One `UPDATE … SET read_at = ? …` with the clock first, then `args`.
fn mark(cwd: &str, sql: &str, args: Vec<Sql>, now: &dyn Fn() -> f64) -> anyhow::Result<usize> {
    let db = open_db(cwd, Mode::ReadWrite)?;
    let mut params = vec![Sql::Real(now())];
    params.extend(args);
    let params = params.into_iter().map(JsText::new);
    Ok(db.with(|c| c.execute(sql, rusqlite::params_from_iter(params)))?)
}

fn text(s: &str) -> Sql {
    Sql::Text(s.to_owned())
}

/// `markRead`: the unread rows among `ids`. Nothing to do (no database
/// opened, no clock read) for an empty list.
pub fn mark_read(cwd: &str, ids: &[String], now: &dyn Fn() -> f64) -> anyhow::Result<usize> {
    if ids.is_empty() {
        return Ok(0);
    }
    let placeholders = vec!["?"; ids.len()].join(",");
    mark(
        cwd,
        &format!(
            "UPDATE notifications SET read_at = ? WHERE read_at IS NULL AND id IN ({placeholders})"
        ),
        ids.iter().map(|id| text(id)).collect(),
        now,
    )
}

/// `markAllRead`.
pub fn mark_all_read(cwd: &str, now: &dyn Fn() -> f64) -> anyhow::Result<usize> {
    mark(
        cwd,
        "UPDATE notifications SET read_at = ? WHERE read_at IS NULL",
        Vec::new(),
        now,
    )
}

/// `markReadByKind`: 0 for an empty kind.
pub fn mark_read_by_kind(cwd: &str, kind: &str, now: &dyn Fn() -> f64) -> anyhow::Result<usize> {
    if kind.is_empty() {
        return Ok(0);
    }
    mark(
        cwd,
        "UPDATE notifications SET read_at = ? WHERE read_at IS NULL AND kind = ?",
        vec![text(kind)],
        now,
    )
}

fn by_session_sql(op: &str) -> String {
    let placeholders = vec!["?"; ACTIONABLE_KINDS.len()].join(", ");
    format!(
        "UPDATE notifications SET read_at = ?
        WHERE read_at IS NULL
          AND session_id = ?
          AND kind {op} ({placeholders})"
    )
}

fn session_and_kinds(session_id: &str) -> Vec<Sql> {
    let mut args = vec![text(session_id)];
    args.extend(ACTIONABLE_KINDS.iter().map(|k| text(k)));
    args
}

/// `markReadBySession`: the session's unread rows except the actionable
/// kinds, which only their resolve path (or the orphan sweep) clears.
pub fn mark_read_by_session(
    cwd: &str,
    session_id: &str,
    now: &dyn Fn() -> f64,
) -> anyhow::Result<usize> {
    if session_id.is_empty() {
        return Ok(0);
    }
    mark(
        cwd,
        &by_session_sql("NOT IN"),
        session_and_kinds(session_id),
        now,
    )
}

/// `markReadActionableBySession`: the mirror image, only the actionable kinds.
pub fn mark_read_actionable_by_session(
    cwd: &str,
    session_id: &str,
    now: &dyn Fn() -> f64,
) -> anyhow::Result<usize> {
    if session_id.is_empty() {
        return Ok(0);
    }
    mark(
        cwd,
        &by_session_sql("IN"),
        session_and_kinds(session_id),
        now,
    )
}

/// `markReadByRequestId`: the ids (as JS reads them) of the unread rows with
/// this `request_id`, marked read. The clock is read only when there are
/// some.
pub fn mark_read_by_request_id(
    cwd: &str,
    request_id: &str,
    now: &dyn Fn() -> f64,
) -> anyhow::Result<Vec<Value>> {
    if request_id.is_empty() {
        return Ok(Vec::new());
    }
    let db = open_db(cwd, Mode::ReadWrite)?;
    Ok(db.with(|c| {
        let mut st =
            c.prepare("SELECT id FROM notifications WHERE read_at IS NULL AND request_id = ?")?;
        let ids = st
            .query_map(js_params![request_id], |r| {
                Ok(Cell::read(r.get_ref(0)?).to_json())
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        if ids.is_empty() {
            return Ok(ids);
        }
        c.execute(
            "UPDATE notifications SET read_at = ? WHERE read_at IS NULL AND request_id = ?",
            js_params![now(), request_id],
        )?;
        Ok(ids)
    })?)
}

/// `getNotification`: the row with this id, `None` without one or without
/// a database.
pub fn get_notification(
    cwd: &str,
    workspace_id: &str,
    id: &str,
) -> anyhow::Result<Option<NotificationRow>> {
    let Ok(db) = open_db(cwd, Mode::ReadOnly) else {
        return Ok(None);
    };
    Ok(db.with(|c| {
        c.query_row(
            &format!("SELECT {ROW_COLUMNS} FROM notifications WHERE id = ?"),
            js_params![id],
            |r| hydrate(r, workspace_id),
        )
        .optional()
    })?)
}

// ───────────────────────── per-session prefs ─────────────────────────

/// A `snooze_until` value as better-sqlite3 reads it.
#[derive(Clone, Debug, PartialEq)]
pub enum Snooze {
    /// INTEGER or REAL: a JS number (±Infinity included; an INTEGER past
    /// 2^53 rounds, as it does in JS).
    Number(f64),
    /// TEXT. Only another writer stores one.
    Text(String),
    /// BLOB, a Node `Buffer` in TS. Only another writer stores one.
    Blob(Vec<u8>),
}

impl Snooze {
    fn read(v: ValueRef) -> Option<Snooze> {
        match v {
            ValueRef::Null => None,
            ValueRef::Integer(n) => Some(Snooze::Number(n as f64)),
            ValueRef::Real(f) => Some(Snooze::Number(f)),
            ValueRef::Text(t) => Some(Snooze::Text(String::from_utf8_lossy(t).into_owned())),
            ValueRef::Blob(b) => Some(Snooze::Blob(b.to_vec())),
        }
    }

    /// `JSON.stringify`'s view: a number (`null` when it isn't finite), the
    /// string, or `Buffer.prototype.toJSON`.
    pub fn to_json(&self) -> Value {
        match self {
            Snooze::Number(f) => js_num(*f),
            Snooze::Text(s) => json!(s),
            Snooze::Blob(b) => json!({"type": "Buffer", "data": b}),
        }
    }

    /// The JS number it compares as (`snoozeUntil > Date.now()`): a string
    /// goes through `Number()`, a `Buffer` through its UTF-8 `toString()`.
    fn as_number(&self) -> f64 {
        match self {
            Snooze::Number(f) => *f,
            Snooze::Text(s) => js::to_number(s),
            Snooze::Blob(b) => js::to_number(&String::from_utf8_lossy(b)),
        }
    }
}

/// Bound the way better-sqlite3 binds the JS value: a number as a double
/// (the column's INTEGER affinity stores a whole one as an integer).
impl ToSql for Snooze {
    fn to_sql(&self) -> rusqlite::Result<ToSqlOutput<'_>> {
        Ok(ToSqlOutput::Owned(match self {
            Snooze::Number(f) => Sql::Real(*f),
            Snooze::Text(s) => Sql::Text(s.clone()),
            Snooze::Blob(b) => Sql::Blob(b.clone()),
        }))
    }
}

/// `SessionNotificationPrefs`.
#[derive(Clone, Debug, PartialEq)]
pub struct SessionPrefs {
    pub session_id: String,
    /// When set, the bus drops every event for the session.
    pub blocked: bool,
    /// Epoch ms; `None` or in the past means "not snoozed".
    pub snooze_until: Option<Snooze>,
}

impl SessionPrefs {
    /// What the route answers for a session without a row.
    pub fn unset(session_id: &str) -> SessionPrefs {
        SessionPrefs {
            session_id: session_id.to_owned(),
            blocked: false,
            snooze_until: None,
        }
    }

    /// `{sessionId, blocked, snoozeUntil}`. Serialize it with
    /// `claudius_agent::js::stringify`, so a deadline past 2^53 prints the
    /// way JS prints it.
    pub fn to_json(&self) -> Value {
        let mut m = Map::new();
        m.insert("sessionId".into(), json!(self.session_id));
        m.insert("blocked".into(), json!(self.blocked));
        m.insert(
            "snoozeUntil".into(),
            self.snooze_until
                .as_ref()
                .map_or(Value::Null, Snooze::to_json),
        );
        Value::Object(m)
    }

    /// `isSessionMuted`'s test against a clock: blocked, or a deadline
    /// still ahead of `now`.
    pub fn is_muted_at(&self, now: f64) -> bool {
        self.blocked
            || self
                .snooze_until
                .as_ref()
                .is_some_and(|s| s.as_number() > now)
    }
}

/// `setSessionPrefs`'s patch: `None` leaves a field as stored.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct PrefsPatch {
    pub blocked: Option<bool>,
    /// `Some(None)` clears the snooze.
    pub snooze_until: Option<Option<f64>>,
}

/// The route's deadline for "snooze `minutes` from `now`":
/// `Date.now() + Math.floor(minutes) * 60_000`, in f64 like JS (so it can
/// round past 2^53 or overflow to Infinity).
pub fn snooze_until(now: f64, minutes: f64) -> f64 {
    now + minutes.floor() * 60_000.0
}

const SELECT: &str =
    "SELECT session_id, blocked, snooze_until FROM session_notification_prefs WHERE session_id = ?";

/// The stored row; `blocked` is `row.blocked === 1`, which a REAL 1.0
/// passes too (a `blocked` column without INTEGER affinity keeps the REAL
/// better-sqlite3 binds).
fn read_row(c: &Connection, session_id: &str) -> rusqlite::Result<Option<SessionPrefs>> {
    c.query_row(SELECT, js_params![session_id], |r| {
        Ok(SessionPrefs {
            session_id: sql_text::get(r, 0)?,
            blocked: match r.get_ref(1)? {
                ValueRef::Integer(n) => n == 1,
                ValueRef::Real(f) => f == 1.0,
                _ => false,
            },
            snooze_until: Snooze::read(r.get_ref(2)?),
        })
    })
    .optional()
}

/// `getSessionPrefs`: the row, or `None` without one. A database that
/// doesn't exist (or won't open) is `None` too; a failing query is an error.
pub fn get_session_prefs(cwd: &str, session_id: &str) -> anyhow::Result<Option<SessionPrefs>> {
    let Ok(db) = open_db(cwd, Mode::ReadOnly) else {
        return Ok(None);
    };
    Ok(db.with(|c| read_row(c, session_id))?)
}

/// `setSessionPrefs`: upsert the row, keeping the stored value of each field
/// the patch leaves out (`blocked` re-read as `=== 1`, the snooze as is), and
/// return what was written.
pub fn set_session_prefs(
    cwd: &str,
    session_id: &str,
    patch: &PrefsPatch,
) -> anyhow::Result<SessionPrefs> {
    let db = open_db(cwd, Mode::ReadWrite)?;
    let prefs = db.with(|c| {
        let existing = read_row(c, session_id)?;
        let prefs = SessionPrefs {
            session_id: session_id.to_owned(),
            blocked: patch
                .blocked
                .unwrap_or_else(|| existing.as_ref().is_some_and(|e| e.blocked)),
            snooze_until: match patch.snooze_until {
                Some(v) => v.map(Snooze::Number),
                None => existing.and_then(|e| e.snooze_until),
            },
        };
        // `blocked ? 1 : 0`, a JS number: bound as a REAL.
        let blocked: f64 = if prefs.blocked { 1.0 } else { 0.0 };
        c.execute(
            "INSERT INTO session_notification_prefs(session_id, blocked, snooze_until)
             VALUES (?, ?, ?)
             ON CONFLICT(session_id) DO UPDATE SET
               blocked      = excluded.blocked,
               snooze_until = excluded.snooze_until",
            js_params![session_id, blocked, prefs.snooze_until],
        )?;
        // What was given, not what was stored: a TEXT-affinity column turns
        // the deadline into text, but TS answers the number it bound.
        Ok(prefs)
    })?;
    Ok(prefs)
}

/// `isSessionMuted`: whether the bus should drop the session's events right
/// now. The TS bus calls it with `.catch(() => false)`.
pub fn is_session_muted(cwd: &str, session_id: &str) -> anyhow::Result<bool> {
    is_session_muted_at(cwd, session_id, now_ms() as f64)
}

/// [`is_session_muted`] against a given clock (epoch ms).
pub fn is_session_muted_at(cwd: &str, session_id: &str, now: f64) -> anyhow::Result<bool> {
    Ok(get_session_prefs(cwd, session_id)?.is_some_and(|p| p.is_muted_at(now)))
}

/// [`is_session_muted`] reading the clock only where TS calls `Date.now()`:
/// for an unblocked row with a deadline.
pub fn is_session_muted_with(
    cwd: &str,
    session_id: &str,
    now: &dyn Fn() -> f64,
) -> anyhow::Result<bool> {
    Ok(get_session_prefs(cwd, session_id)?.is_some_and(|p| {
        p.blocked
            || p.snooze_until
                .as_ref()
                .is_some_and(|s| s.as_number() > now())
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn prefs(blocked: bool, snooze: Option<Snooze>) -> SessionPrefs {
        SessionPrefs {
            session_id: "s".into(),
            blocked,
            snooze_until: snooze,
        }
    }

    #[test]
    fn snooze_arithmetic_is_js() {
        let now = 1_761_500_000_123.0;
        assert_eq!(snooze_until(now, 5.0), now + 300_000.0);
        // Math.floor: 1.9 → 1 minute, anything under one → now.
        assert_eq!(snooze_until(now, 1.9), now + 60_000.0);
        assert_eq!(snooze_until(now, 0.5), now);
        assert_eq!(snooze_until(now, 5e-324), now);
        // Past 2^53 the sum rounds to the double grid, as in JS.
        assert_eq!(snooze_until(now, 1e15), 60_000_001_761_500_000_000.0);
        // Overflow is Infinity (printed as null).
        assert_eq!(snooze_until(now, 1e308), f64::INFINITY);
        assert_eq!(snooze_until(now, f64::MAX), f64::INFINITY);
        assert!(snooze_until(now, 2.9e303).is_finite());
    }

    #[test]
    fn muted_is_blocked_or_a_deadline_ahead() {
        let now = 1_000.0;
        assert!(!prefs(false, None).is_muted_at(now));
        assert!(prefs(true, None).is_muted_at(now));
        assert!(prefs(true, Some(Snooze::Number(0.0))).is_muted_at(now));
        assert!(prefs(false, Some(Snooze::Number(1_000.5))).is_muted_at(now));
        assert!(!prefs(false, Some(Snooze::Number(1_000.0))).is_muted_at(now));
        assert!(!prefs(false, Some(Snooze::Number(999.0))).is_muted_at(now));
        assert!(prefs(false, Some(Snooze::Number(f64::INFINITY))).is_muted_at(now));
        assert!(!prefs(false, Some(Snooze::Number(f64::NEG_INFINITY))).is_muted_at(now));
        // Foreign values compare through Number() / Buffer#toString().
        let text = |s: &str| Some(Snooze::Text(s.into()));
        assert!(prefs(false, text("1001")).is_muted_at(now));
        assert!(prefs(false, text(" 0x3E9 ")).is_muted_at(now - 0.5));
        assert!(prefs(false, text("Infinity")).is_muted_at(now));
        assert!(!prefs(false, text("1000")).is_muted_at(now));
        assert!(!prefs(false, text("abc")).is_muted_at(now));
        assert!(!prefs(false, text("")).is_muted_at(now), "Number('') is 0");
        assert!(prefs(false, text("")).is_muted_at(-1.0));
        assert!(prefs(false, Some(Snooze::Blob(b"2000".to_vec()))).is_muted_at(now));
        assert!(!prefs(false, Some(Snooze::Blob(vec![0x32, 0xff]))).is_muted_at(now));
    }

    #[test]
    fn json_is_the_ts_shape() {
        let p = |s| prefs(false, s).to_json();
        assert_eq!(
            js::stringify(&SessionPrefs::unset("x").to_json()),
            r#"{"sessionId":"x","blocked":false,"snoozeUntil":null}"#
        );
        assert_eq!(
            js::stringify(&prefs(true, None).to_json()),
            r#"{"sessionId":"s","blocked":true,"snoozeUntil":null}"#
        );
        assert_eq!(
            js::stringify(&p(Some(Snooze::Number(6.0000001761562e19)))),
            r#"{"sessionId":"s","blocked":false,"snoozeUntil":60000001761562000000}"#
        );
        assert_eq!(
            p(Some(Snooze::Number(1_761_500_000_000.0)))["snoozeUntil"],
            json!(1_761_500_000_000i64)
        );
        assert_eq!(
            p(Some(Snooze::Number(f64::INFINITY)))["snoozeUntil"],
            Value::Null
        );
        assert_eq!(
            p(Some(Snooze::Text("abc".into())))["snoozeUntil"],
            json!("abc")
        );
        assert_eq!(
            p(Some(Snooze::Blob(vec![0, 255])))["snoozeUntil"],
            json!({"type": "Buffer", "data": [0, 255]})
        );
    }
}
