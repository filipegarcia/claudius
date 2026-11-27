//! What the sessions browser reads and does, as the [`SessionsData`] trait.
//! It is transport-shaped: each call is a [`SessionsRequest`] (a method, a
//! URL and a JSON body, exactly as the React page and `useSessionsHistory`
//! build them) answered by a [`Reply`] (the status and the body text), and
//! the client-side rules the TS runs on the answer (`sessionAction`'s error,
//! the hook's `HTTP <status>`) live in the models, not in the source.
//!
//! | Request | Route | 200 body |
//! |---|---|---|
//! | [`SessionsRequest::List`] | `GET /api/sessions/all?dir=&limit=` | `{sessions: [StoredSession], accountsConfigured}` |
//! | [`SessionsRequest::Info`] | `GET /api/sessions/info/<id>?dir=` | a [`StoredSession`] (`SDKSessionInfo` + `claudiusTitle`) |
//! | [`SessionsRequest::Transcript`] | `GET /api/sessions/transcript/<id>?dir=` | `{messages: [HistoryMessage], historyError?}` |
//! | [`SessionsRequest::Search`] | `GET /api/sessions/search?q=&dir=` | `{matches: [{sessionId, snippet}]}` |
//! | [`SessionsRequest::Rename`] | `POST /api/sessions/rename` | `{ok: true}` |
//! | [`SessionsRequest::Fork`] | `POST /api/sessions/fork` | `{sessionId, worktree}` |
//! | [`SessionsRequest::Delete`] | `DELETE /api/sessions/file/<id>?dir=` | `{ok: true}` |
//! | [`SessionsRequest::Export`] | `GET /api/sessions/export/<id>?dir=` | the transcript as text, an attachment |
//!
//! An error answer is the route's status with its `{error}` body. A
//! transport failure (no answer at all) is the future's `Err`, its message
//! what the page shows, as `fetch`'s rejection is.
//!
//! [`SessionsData::subscribe`] streams [`SessionsChange`]s: the screen
//! re-reads what changed. [`super::fixture::FixtureSessionsData`] is the
//! fixture-backed implementation; [`super::live::TransportSessionsData`]
//! sends the requests over the engine's transport (U11b).

use std::collections::BTreeMap;

use futures::channel::mpsc::UnboundedReceiver;
use serde::{Deserialize, Deserializer, Serialize};
use serde_json::{Map, Value, json};

use crate::data::DataFuture;
use crate::route::{encode_uri_component, form_encode};

/// One call to the sessions routes.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum SessionsRequest {
    /// `useSessionsHistory`'s listing: `dir` scopes it to a workspace's
    /// project, `limit` grows by a page with each "Load more".
    List { dir: Option<String>, limit: u32 },
    /// One session's metadata.
    Info { id: String, dir: Option<String> },
    /// One session's messages, turns before each compaction included.
    Transcript { id: String, dir: Option<String> },
    /// "Search in transcripts": the workspace's `.jsonl` bodies.
    Search { q: String, dir: String },
    /// The one-session page's rename.
    Rename {
        session_id: String,
        title: String,
        dir: Option<String>,
    },
    /// "Fork" (the whole session) or "Rewind here" (up to a message).
    Fork {
        session_id: String,
        up_to_message_id: Option<String>,
        dir: Option<String>,
    },
    /// "Delete": the transcript file.
    Delete { id: String, dir: Option<String> },
    /// "Export": the plain-text transcript.
    Export { id: String, dir: Option<String> },
}

/// `?dir=<encodeURIComponent(dir)>` when `dir` is set (the pages' `qs`).
fn dir_qs(dir: &Option<String>) -> String {
    match dir.as_deref().filter(|d| !d.is_empty()) {
        Some(d) => format!("?dir={}", encode_uri_component(d)),
        None => String::new(),
    }
}

impl SessionsRequest {
    pub fn method(&self) -> &'static str {
        match self {
            SessionsRequest::Rename { .. } | SessionsRequest::Fork { .. } => "POST",
            SessionsRequest::Delete { .. } => "DELETE",
            _ => "GET",
        }
    }

    /// The URL as the TS builds it. Ids go in raw (template literals), the
    /// `dir` and `q` values through `encodeURIComponent`, the listing's
    /// query through `URLSearchParams`.
    pub fn url(&self) -> String {
        match self {
            SessionsRequest::List { dir, limit } => {
                let mut q = Vec::new();
                if let Some(d) = dir.as_deref().filter(|d| !d.is_empty()) {
                    q.push(format!("dir={}", form_encode(d)));
                }
                q.push(format!("limit={limit}"));
                format!("/api/sessions/all?{}", q.join("&"))
            }
            SessionsRequest::Info { id, dir } => format!("/api/sessions/info/{id}{}", dir_qs(dir)),
            SessionsRequest::Transcript { id, dir } => {
                format!("/api/sessions/transcript/{id}{}", dir_qs(dir))
            }
            SessionsRequest::Search { q, dir } => format!(
                "/api/sessions/search?q={}&dir={}",
                encode_uri_component(q),
                encode_uri_component(dir)
            ),
            SessionsRequest::Rename { .. } => "/api/sessions/rename".into(),
            SessionsRequest::Fork { .. } => "/api/sessions/fork".into(),
            SessionsRequest::Delete { id, dir } => {
                format!("/api/sessions/file/{id}{}", dir_qs(dir))
            }
            SessionsRequest::Export { id, dir } => {
                format!("/api/sessions/export/{id}{}", dir_qs(dir))
            }
        }
    }

    /// The JSON body (`JSON.stringify` drops an `undefined` field).
    pub fn body(&self) -> Option<Value> {
        match self {
            SessionsRequest::Rename {
                session_id,
                title,
                dir,
            } => {
                let mut m = Map::new();
                m.insert("sessionId".into(), json!(session_id));
                m.insert("title".into(), json!(title));
                if let Some(d) = dir {
                    m.insert("dir".into(), json!(d));
                }
                Some(Value::Object(m))
            }
            SessionsRequest::Fork {
                session_id,
                up_to_message_id,
                dir,
            } => {
                let mut m = Map::new();
                m.insert("sessionId".into(), json!(session_id));
                if let Some(u) = up_to_message_id {
                    m.insert("upToMessageId".into(), json!(u));
                }
                if let Some(d) = dir {
                    m.insert("dir".into(), json!(d));
                }
                Some(Value::Object(m))
            }
            _ => None,
        }
    }
}

/// A route's answer.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Reply {
    pub status: u16,
    /// The body as sent (JSON, or the export's text).
    pub body: String,
    /// The `Content-Disposition` attachment's file name (the export).
    pub filename: Option<String>,
}

impl Reply {
    /// A JSON answer.
    pub fn json(status: u16, body: &Value) -> Reply {
        Reply {
            status,
            body: body.to_string(),
            filename: None,
        }
    }

    /// `res.ok`.
    pub fn ok(&self) -> bool {
        (200..300).contains(&self.status)
    }

    /// `res.json()`: the body, or the parse error's message.
    pub fn parse(&self) -> Result<Value, String> {
        serde_json::from_str(&self.body).map_err(|e| format!("invalid JSON: {e}"))
    }
}

/// Something the sessions browser shows changed at the source.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum SessionsChange {
    /// The sessions under a project dir (`None`: anywhere).
    List { dir: Option<String> },
    /// One session (renamed, its transcript grew).
    Session { id: String },
    /// A workspace's unread notification counts.
    Unread { workspace_id: String },
}

/// The sessions browser's data source. See the module docs for the routes.
pub trait SessionsData: Send + Sync + 'static {
    fn send(&self, request: SessionsRequest) -> DataFuture<Reply>;
    /// The unread notification count per session id in a workspace (the
    /// notifications provider's `unreadBySessionByWorkspace[id]`, fed by
    /// the SSE `state` events). Empty by default.
    fn unread(&self, _workspace_id: &str) -> BTreeMap<String, u32> {
        BTreeMap::new()
    }
    /// Change notifications, from now on. Each call is a new stream.
    fn subscribe(&self) -> UnboundedReceiver<SessionsChange>;
}

// ---- the shapes ------------------------------------------------------------

/// A JSON number, else NaN (`Date.now() - "x"`); absent is 0.
fn js_number<'de, D: Deserializer<'de>>(d: D) -> Result<f64, D::Error> {
    let v = Value::deserialize(d)?;
    Ok(match v {
        Value::Number(n) => n.as_f64().unwrap_or(f64::NAN),
        Value::Null => 0.,
        _ => f64::NAN,
    })
}

/// A JSON number, else none.
fn opt_number<'de, D: Deserializer<'de>>(d: D) -> Result<Option<f64>, D::Error> {
    Ok(Value::deserialize(d)?.as_f64())
}

/// A JSON string, else none (a `Buffer` or `null` title reads as none).
fn opt_string<'de, D: Deserializer<'de>>(d: D) -> Result<Option<String>, D::Error> {
    Ok(match Value::deserialize(d)? {
        Value::String(s) => Some(s),
        _ => None,
    })
}

/// One listed session (`StoredSession`: the SDK's `SDKSessionInfo` with
/// Claudius's title and the account pin). Also the info route's answer.
#[derive(Clone, Debug, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StoredSession {
    pub session_id: String,
    #[serde(default, deserialize_with = "opt_string")]
    pub summary: Option<String>,
    #[serde(default, deserialize_with = "js_number")]
    pub last_modified: f64,
    #[serde(
        default,
        deserialize_with = "opt_number",
        skip_serializing_if = "Option::is_none"
    )]
    pub file_size: Option<f64>,
    #[serde(
        default,
        deserialize_with = "opt_string",
        skip_serializing_if = "Option::is_none"
    )]
    pub custom_title: Option<String>,
    #[serde(
        default,
        deserialize_with = "opt_string",
        skip_serializing_if = "Option::is_none"
    )]
    pub first_prompt: Option<String>,
    #[serde(
        default,
        deserialize_with = "opt_string",
        skip_serializing_if = "Option::is_none"
    )]
    pub git_branch: Option<String>,
    #[serde(
        default,
        deserialize_with = "opt_string",
        skip_serializing_if = "Option::is_none"
    )]
    pub cwd: Option<String>,
    #[serde(
        default,
        deserialize_with = "opt_string",
        skip_serializing_if = "Option::is_none"
    )]
    pub tag: Option<String>,
    #[serde(
        default,
        deserialize_with = "opt_number",
        skip_serializing_if = "Option::is_none"
    )]
    pub created_at: Option<f64>,
    /// The sessions-index title (every Claudius rename), which wins over
    /// the transcript's `customTitle`.
    #[serde(
        default,
        deserialize_with = "opt_string",
        skip_serializing_if = "Option::is_none"
    )]
    pub claudius_title: Option<String>,
    #[serde(
        default,
        deserialize_with = "opt_string",
        skip_serializing_if = "Option::is_none"
    )]
    pub account_id: Option<String>,
    #[serde(
        default,
        deserialize_with = "opt_string",
        skip_serializing_if = "Option::is_none"
    )]
    pub account_label: Option<String>,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

fn truthy(s: &Option<String>) -> Option<&str> {
    s.as_deref().filter(|s| !s.is_empty())
}

impl StoredSession {
    /// The title the pages show: `claudiusTitle || customTitle ||
    /// readableSessionLabel(createdAt) || "(untitled)"`. Never `summary` or
    /// `firstPrompt` (prompt text).
    pub fn display_title(&self, now_year: i32) -> String {
        if let Some(t) = truthy(&self.claudius_title).or(truthy(&self.custom_title)) {
            return t.to_owned();
        }
        match self.created_at.filter(|c| *c != 0. && !c.is_nan()) {
            Some(c) => crate::tabs::readable_session_label(c, now_year),
            None => "(untitled)".into(),
        }
    }

    /// `s.cwd` when truthy.
    pub fn cwd(&self) -> Option<&str> {
        truthy(&self.cwd)
    }

    /// The rename box's pre-fill: `claudiusTitle ?? customTitle ?? ""`.
    pub fn title_draft(&self) -> String {
        self.claudius_title
            .clone()
            .or_else(|| self.custom_title.clone())
            .unwrap_or_default()
    }

    pub fn search_fields(&self) -> super::search::SearchFields<'_> {
        super::search::SearchFields {
            custom_title: self.custom_title.as_deref(),
            claudius_title: self.claudius_title.as_deref(),
            first_prompt: self.first_prompt.as_deref(),
            session_id: &self.session_id,
        }
    }
}

/// `GET /api/sessions/all`'s 200 body.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct SessionsPage {
    pub sessions: Vec<StoredSession>,
    pub accounts_configured: u32,
    /// `data.error` (a 200 that says it failed).
    pub error: Option<String>,
}

impl SessionsPage {
    /// The body as the hook reads it: `data.sessions ?? []` (a row that
    /// isn't a session object is skipped), `data.accountsConfigured ?? 0`.
    pub fn from_json(v: &Value) -> SessionsPage {
        let sessions = v
            .get("sessions")
            .and_then(Value::as_array)
            .map(|rows| {
                rows.iter()
                    .filter_map(|r| serde_json::from_value(r.clone()).ok())
                    .collect()
            })
            .unwrap_or_default();
        // `if (data.error) throw new Error(data.error)`: a truthy value,
        // as `String()` writes it.
        let error = match v.get("error") {
            None | Some(Value::Null | Value::Bool(false)) => None,
            Some(Value::String(s)) => Some(s.clone()).filter(|s| !s.is_empty()),
            Some(Value::Number(n)) => match n.as_f64() {
                Some(0.) => None,
                _ => Some(n.as_i64().map_or_else(|| n.to_string(), |i| i.to_string())),
            },
            Some(Value::Object(_)) => Some("[object Object]".into()),
            Some(Value::Array(items)) => Some(
                items
                    .iter()
                    .map(|i| match i {
                        Value::Null => String::new(),
                        Value::String(s) => s.clone(),
                        other => other.to_string(),
                    })
                    .collect::<Vec<_>>()
                    .join(","),
            ),
            Some(Value::Bool(true)) => Some("true".into()),
        };
        SessionsPage {
            sessions,
            accounts_configured: v
                .get("accountsConfigured")
                .and_then(Value::as_u64)
                .map_or(0, |n| u32::try_from(n).unwrap_or(u32::MAX)),
            error,
        }
    }
}

/// `GET /api/sessions/transcript/<id>`'s 200 body.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct TranscriptPage {
    /// `HistoryMessage`s, as the route sends them.
    pub messages: Vec<Value>,
    /// Set when the turns before the last compaction couldn't be read.
    pub history_error: Option<String>,
}

impl TranscriptPage {
    pub fn from_json(v: &Value) -> TranscriptPage {
        TranscriptPage {
            messages: v
                .get("messages")
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default(),
            history_error: v
                .get("historyError")
                .and_then(Value::as_str)
                .map(str::to_owned),
        }
    }
}

/// `GET /api/sessions/search`'s matches: session id → snippet, in order.
pub fn content_matches(v: &Value) -> Vec<(String, String)> {
    v.get("matches")
        .and_then(Value::as_array)
        .map(|ms| {
            ms.iter()
                .filter_map(|m| {
                    Some((
                        m.get("sessionId")?.as_str()?.to_owned(),
                        m.get("snippet")
                            .and_then(Value::as_str)
                            .unwrap_or_default()
                            .to_owned(),
                    ))
                })
                .collect()
        })
        .unwrap_or_default()
}

/// `SessionActionResult`: `sessionAction`'s reading of a rename or delete
/// answer. An error answer says its `{error}` string when it has a
/// non-empty one, else `HTTP <status>`; a transport failure its message.
pub fn action_result(reply: &Result<Reply, String>) -> Result<(), String> {
    match reply {
        Err(message) => Err(message.clone()),
        Ok(r) if r.ok() => Ok(()),
        Ok(r) => {
            let error = r
                .parse()
                .ok()
                .and_then(|b| b.get("error").and_then(Value::as_str).map(str::to_owned))
                .filter(|e| !e.is_empty());
            Err(error.unwrap_or_else(|| format!("HTTP {}", r.status)))
        }
    }
}

/// The hook's `fork`: the new session's id, or `None` (not ok, or no
/// `sessionId`).
pub fn fork_result(reply: &Result<Reply, String>) -> Option<String> {
    let r = reply.as_ref().ok().filter(|r| r.ok())?;
    r.parse()
        .ok()?
        .get("sessionId")
        .and_then(Value::as_str)
        .map(str::to_owned)
}
