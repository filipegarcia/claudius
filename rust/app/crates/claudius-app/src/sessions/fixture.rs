//! [`FixtureSessionsData`]: the [`SessionsData`] of a JSON file holding
//! what the sessions routes answer, for running the browser without a
//! server. It records every request, so tests can assert them, and can be
//! told to answer the next matching request with a given reply (an error
//! status, a transport failure).
//!
//! ```json
//! {
//!   "now": 1795723200000,
//!   "accountsConfigured": 2,
//!   "sessions": [ { "sessionId": …, "lastModified": …, "cwd": …, "claudiusTitle": … } ],
//!   "transcripts": { "<id>": { "messages": [ … ], "historyError": … } },
//!   "unread": { "wks_…": { "<id>": 2 } }
//! }
//! ```
//!
//! `sessions` are `GET /api/sessions/all` rows (scoped by `cwd === dir`,
//! newest first, cut at `limit`), and `info/<id>` answers a row; each
//! `transcripts` entry is `transcript/<id>`'s body. Rename, fork and delete
//! change the in-memory copy (the server pushes nothing for them: the pages
//! re-read, as the React ones do); [`FixtureSessionsData::change`] is a
//! change made elsewhere, and notifies. The file is never written. `now` is
//! the clock the fixture's ages were written against.

use std::collections::BTreeMap;
use std::path::Path;
use std::sync::{Arc, Mutex};

use anyhow::Context as _;
use futures::channel::mpsc::{UnboundedReceiver, UnboundedSender, unbounded};
use futures::future::{self, FutureExt as _};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use super::data::{Reply, SessionsChange, SessionsData, SessionsRequest, StoredSession};
use super::search::js_lower;
use super::transcript::plain_text;
use crate::data::DataFuture;

/// The fixture file's shape.
#[derive(Clone, Debug, Default, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionsFixture {
    /// Epoch ms the ages are relative to.
    pub now: f64,
    #[serde(default)]
    pub accounts_configured: u32,
    pub sessions: Vec<StoredSession>,
    #[serde(default)]
    pub transcripts: BTreeMap<String, Value>,
    #[serde(default)]
    pub unread: BTreeMap<String, BTreeMap<String, u32>>,
}

/// The bundled fixture: 30 sessions in the shell fixture's 3 workspaces.
pub const BUILTIN: &str = include_str!("../../fixtures/sessions.json");

type Matcher = Box<dyn Fn(&SessionsRequest) -> bool + Send>;

struct State {
    fixture: SessionsFixture,
    requests: Vec<SessionsRequest>,
    overrides: Vec<(Matcher, Result<Reply, String>)>,
    forks: u64,
}

pub struct FixtureSessionsData {
    state: Arc<Mutex<State>>,
    subscribers: Arc<Mutex<Vec<UnboundedSender<SessionsChange>>>>,
}

fn not_found() -> Reply {
    Reply::json(404, &json!({"error": "session not found"}))
}

impl FixtureSessionsData {
    pub fn new(fixture: SessionsFixture) -> Self {
        FixtureSessionsData {
            state: Arc::new(Mutex::new(State {
                fixture,
                requests: Vec::new(),
                overrides: Vec::new(),
                forks: 0,
            })),
            subscribers: Arc::default(),
        }
    }

    pub fn from_json(text: &str) -> anyhow::Result<Self> {
        Ok(Self::new(serde_json::from_str(text)?))
    }

    pub fn from_path(path: &Path) -> anyhow::Result<Self> {
        let text = std::fs::read_to_string(path)
            .with_context(|| format!("reading the fixture {}", path.display()))?;
        Self::from_json(&text).with_context(|| format!("parsing the fixture {}", path.display()))
    }

    /// [`BUILTIN`].
    pub fn builtin() -> Self {
        Self::from_json(BUILTIN).expect("the bundled sessions fixture parses")
    }

    /// The fixture with its times moved so `now` is `now_ms` (the app's
    /// real clock, so the ages read as written).
    pub fn rebased(self, now_ms: f64) -> Self {
        {
            let mut s = self.state.lock().expect("fixture lock");
            let shift = now_ms - s.fixture.now;
            s.fixture.now = now_ms;
            for row in &mut s.fixture.sessions {
                row.last_modified += shift;
                if let Some(c) = &mut row.created_at {
                    *c += shift;
                }
            }
        }
        self
    }

    /// The fixture's clock.
    pub fn now(&self) -> f64 {
        self.state.lock().expect("fixture lock").fixture.now
    }

    /// The current data.
    pub fn snapshot(&self) -> SessionsFixture {
        self.state.lock().expect("fixture lock").fixture.clone()
    }

    /// Every request so far, in order.
    pub fn requests(&self) -> Vec<SessionsRequest> {
        self.state.lock().expect("fixture lock").requests.clone()
    }

    /// Forgets the recorded requests.
    pub fn clear_requests(&self) {
        self.state.lock().expect("fixture lock").requests.clear();
    }

    /// Answers the next request `matches` accepts with `reply` (once).
    pub fn answer_next(
        &self,
        matches: impl Fn(&SessionsRequest) -> bool + Send + 'static,
        reply: Result<Reply, String>,
    ) {
        self.state
            .lock()
            .expect("fixture lock")
            .overrides
            .push((Box::new(matches), reply));
    }

    /// Changes the data and notifies, as a change elsewhere would.
    pub fn change(&self, change: SessionsChange, f: impl FnOnce(&mut SessionsFixture)) {
        f(&mut self.state.lock().expect("fixture lock").fixture);
        self.notify(change);
    }

    fn notify(&self, change: SessionsChange) {
        self.subscribers
            .lock()
            .expect("subscribers lock")
            .retain(|tx| tx.unbounded_send(change.clone()).is_ok());
    }

    fn answer(s: &mut State, request: &SessionsRequest) -> Reply {
        let f = &mut s.fixture;
        let find =
            |f: &SessionsFixture, id: &str| f.sessions.iter().position(|r| r.session_id == id);
        match request {
            SessionsRequest::List { dir, limit } => {
                let mut rows: Vec<&StoredSession> = f
                    .sessions
                    .iter()
                    .filter(|r| dir.is_none() || r.cwd == *dir)
                    .collect();
                rows.sort_by(|a, b| b.last_modified.total_cmp(&a.last_modified));
                rows.truncate(*limit as usize);
                let body = json!({"sessions": rows, "accountsConfigured": f.accounts_configured});
                Reply::json(200, &body)
            }
            SessionsRequest::Info { id, .. } => match find(f, id) {
                Some(i) => Reply::json(200, &json!(f.sessions[i])),
                None => not_found(),
            },
            SessionsRequest::Transcript { id, .. } => {
                let body = f
                    .transcripts
                    .get(id)
                    .cloned()
                    .unwrap_or_else(|| json!({"messages": []}));
                Reply::json(200, &body)
            }
            SessionsRequest::Search { q, dir } => {
                let needle = js_lower(q);
                let matches: Vec<Value> = f
                    .sessions
                    .iter()
                    .filter(|r| r.cwd.as_deref() == Some(dir.as_str()))
                    .filter_map(|r| {
                        let tx = f.transcripts.get(&r.session_id)?;
                        let snippet = tx["messages"].as_array()?.iter().find_map(|m| {
                            let text = plain_text(m.get("message").and_then(|x| x.get("content")));
                            let line = text.lines().find(|l| js_lower(l).contains(&needle))?;
                            Some(line.chars().take(120).collect::<String>())
                        })?;
                        Some(json!({"sessionId": r.session_id, "snippet": snippet}))
                    })
                    .collect();
                Reply::json(200, &json!({"matches": matches}))
            }
            SessionsRequest::Rename {
                session_id, title, ..
            } => {
                if title.trim().is_empty() || session_id.is_empty() {
                    return Reply::json(400, &json!({"error": "sessionId and title required"}));
                }
                let Some(i) = find(f, session_id) else {
                    return Reply::json(
                        500,
                        &json!({"error": format!("Session {session_id} not found")}),
                    );
                };
                let row = &mut f.sessions[i];
                row.claudius_title = Some(title.clone());
                row.custom_title = Some(title.clone());
                Reply::json(200, &json!({"ok": true}))
            }
            SessionsRequest::Fork {
                session_id,
                up_to_message_id,
                ..
            } => {
                let Some(i) = find(f, session_id) else {
                    return Reply::json(
                        500,
                        &json!({"error": format!("Session {session_id} not found")}),
                    );
                };
                s.forks += 1;
                let new_id = format!("f0f0f0f0-0000-4000-8000-{:012x}", s.forks);
                let mut row = f.sessions[i].clone();
                row.session_id = new_id.clone();
                row.claudius_title = None;
                row.custom_title = None;
                row.last_modified = f.now + s.forks as f64 * 1000.;
                row.created_at = Some(row.last_modified);
                let mut messages: Vec<Value> = f
                    .transcripts
                    .get(session_id)
                    .and_then(|t| t["messages"].as_array().cloned())
                    .unwrap_or_default();
                if let Some(up_to) = up_to_message_id
                    && let Some(at) = messages
                        .iter()
                        .position(|m| m["uuid"].as_str() == Some(up_to.as_str()))
                {
                    messages.truncate(at + 1);
                }
                f.sessions.push(row);
                f.transcripts
                    .insert(new_id.clone(), json!({"messages": messages}));
                Reply::json(200, &json!({"sessionId": new_id, "worktree": null}))
            }
            SessionsRequest::Delete { id, .. } => match find(f, id) {
                Some(i) => {
                    f.sessions.remove(i);
                    f.transcripts.remove(id);
                    Reply::json(200, &json!({"ok": true}))
                }
                None => Reply::json(500, &json!({"error": format!("Session {id} not found")})),
            },
            SessionsRequest::Export { id, .. } => {
                let Some(tx) = f.transcripts.get(id) else {
                    return Reply {
                        status: 500,
                        body: "failed to export session".into(),
                        filename: None,
                    };
                };
                let text: Vec<String> = tx["messages"]
                    .as_array()
                    .map(Vec::as_slice)
                    .unwrap_or_default()
                    .iter()
                    .filter_map(|m| {
                        let who = match m["type"].as_str()? {
                            "user" => "User",
                            "assistant" => "Assistant",
                            _ => return None,
                        };
                        let body = plain_text(m.get("message").and_then(|x| x.get("content")));
                        (!body.is_empty()).then(|| format!("{who}: {body}"))
                    })
                    .collect();
                Reply {
                    status: 200,
                    body: text.join("\n\n"),
                    filename: Some(format!("claudius-session-{id}.txt")),
                }
            }
        }
    }
}

impl SessionsData for FixtureSessionsData {
    fn send(&self, request: SessionsRequest) -> DataFuture<Reply> {
        let reply = {
            let mut s = self.state.lock().expect("fixture lock");
            s.requests.push(request.clone());
            match s.overrides.iter().position(|(m, _)| m(&request)) {
                Some(i) => s.overrides.remove(i).1,
                None => Ok(Self::answer(&mut s, &request)),
            }
        };
        future::ready(reply.map_err(|m| anyhow::anyhow!(m))).boxed()
    }

    fn unread(&self, workspace_id: &str) -> BTreeMap<String, u32> {
        self.state
            .lock()
            .expect("fixture lock")
            .fixture
            .unread
            .get(workspace_id)
            .cloned()
            .unwrap_or_default()
    }

    fn subscribe(&self) -> UnboundedReceiver<SessionsChange> {
        let (tx, rx) = unbounded();
        self.subscribers.lock().expect("subscribers lock").push(tx);
        rx
    }
}
