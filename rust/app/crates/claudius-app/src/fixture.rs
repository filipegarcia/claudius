//! [`FixtureShellData`]: the [`ShellData`] of a JSON file holding what the
//! routes answer, for running the shell without a server (U04b puts the
//! transport behind the same trait).
//!
//! ```json
//! {
//!   "workspaces": { "workspaces": [ … ], "activeId": "wks_…" },
//!   "openTabs": { "wks_…": { "tabs": [ … ], "activeId": …, "labelMaxWidth": 180, "titles": { … }, "pinned": [ … ] } },
//!   "sessions": [ { "id": …, "cwd": …, "title": …, "createdAt": …, "status": "running" } ],
//!   "activeSession": { "wks_…": { "ready": true, "pending": false, "hasError": false } }
//! }
//! ```
//!
//! `workspaces` is `GET /api/workspaces`, each `openTabs` entry is `GET
//! /api/sessions/open-tabs` with that workspace active (a workspace with no
//! entry answers the route's defaults), `sessions` is `GET /api/sessions`
//! (filtered per workspace by `cwd`, as `?workspaceId=` does), and
//! `activeSession` is the optional bound-session state the chat would hold.
//! Writes change the in-memory copy and notify subscribers; the file is
//! never written.

use std::collections::BTreeMap;
use std::path::Path;
use std::sync::{Arc, Mutex};

use anyhow::Context as _;
use futures::channel::mpsc::{UnboundedReceiver, UnboundedSender, unbounded};
use futures::future::{self, FutureExt as _};
use serde::{Deserialize, Serialize};

use crate::data::{
    ActiveSessionState, DataFuture, LiveStatus, OpenTabs, OpenTabsPut, SessionSummary, ShellChange,
    ShellData, WorkspaceList,
};

/// The fixture file's shape.
#[derive(Clone, Debug, Default, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Fixture {
    pub workspaces: WorkspaceList,
    #[serde(default)]
    pub open_tabs: BTreeMap<String, OpenTabs>,
    #[serde(default)]
    pub sessions: Vec<SessionSummary>,
    #[serde(default)]
    pub active_session: BTreeMap<String, ActiveSessionState>,
}

/// The bundled fixture: 3 workspaces, 10 tabs, every tab status.
pub const BUILTIN: &str = include_str!("../fixtures/shell.json");

struct State {
    fixture: Fixture,
    created: u64,
    /// Epoch ms a created session gets.
    now_ms: f64,
}

pub struct FixtureShellData {
    state: Arc<Mutex<State>>,
    subscribers: Arc<Mutex<Vec<UnboundedSender<ShellChange>>>>,
}

impl FixtureShellData {
    pub fn new(fixture: Fixture) -> Self {
        FixtureShellData {
            state: Arc::new(Mutex::new(State {
                fixture,
                created: 0,
                now_ms: 1_795_723_200_000.,
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
        Self::from_json(BUILTIN).expect("the bundled fixture parses")
    }

    /// The current data (what a reload would read).
    pub fn snapshot(&self) -> Fixture {
        self.state.lock().expect("fixture lock").fixture.clone()
    }

    /// Changes the data and notifies, as a server-side change would (a
    /// session finishing its turn, a rename in another window).
    pub fn change(&self, change: ShellChange, f: impl FnOnce(&mut Fixture)) {
        f(&mut self.state.lock().expect("fixture lock").fixture);
        self.notify(change);
    }

    fn notify(&self, change: ShellChange) {
        self.subscribers
            .lock()
            .expect("subscribers lock")
            .retain(|tx| tx.unbounded_send(change.clone()).is_ok());
    }

    fn read<T: Send + 'static>(
        &self,
        f: impl FnOnce(&Fixture) -> anyhow::Result<T>,
    ) -> DataFuture<T> {
        let out = f(&self.state.lock().expect("fixture lock").fixture);
        future::ready(out).boxed()
    }

    fn root_of(fixture: &Fixture, workspace_id: &str) -> anyhow::Result<String> {
        fixture
            .workspaces
            .workspaces
            .iter()
            .find(|w| w.id == workspace_id)
            .map(|w| w.root_path.clone())
            .ok_or_else(|| anyhow::anyhow!("workspace not found"))
    }
}

impl ShellData for FixtureShellData {
    fn workspaces(&self) -> DataFuture<WorkspaceList> {
        self.read(|f| Ok(f.workspaces.clone()))
    }

    fn select_workspace(&self, id: &str) -> DataFuture<()> {
        let id = id.to_owned();
        let found = {
            let mut s = self.state.lock().expect("fixture lock");
            let found = s.fixture.workspaces.workspaces.iter().any(|w| w.id == id);
            if found {
                s.fixture.workspaces.active_id = Some(id);
            }
            found
        };
        if !found {
            return future::ready(Err(anyhow::anyhow!("workspace not found"))).boxed();
        }
        self.notify(ShellChange::Workspaces);
        future::ready(Ok(())).boxed()
    }

    fn open_tabs(&self, workspace_id: &str) -> DataFuture<OpenTabs> {
        let id = workspace_id.to_owned();
        self.read(move |f| Ok(f.open_tabs.get(&id).cloned().unwrap_or_default()))
    }

    fn put_open_tabs(&self, workspace_id: &str, body: OpenTabsPut) -> DataFuture<()> {
        {
            let mut s = self.state.lock().expect("fixture lock");
            let entry = s
                .fixture
                .open_tabs
                .entry(workspace_id.to_owned())
                .or_default();
            if let Some(tabs) = body.tabs {
                entry.tabs = tabs;
            }
            if let Some(active) = body.active_id {
                entry.active_id = active;
            }
            if let Some(pinned) = body.pinned {
                entry.pinned = pinned;
            }
            if let Some(w) = body.label_max_width {
                entry.label_max_width = w;
            }
        }
        self.notify(ShellChange::OpenTabs {
            workspace_id: workspace_id.to_owned(),
        });
        future::ready(Ok(())).boxed()
    }

    fn sessions(&self, workspace_id: &str) -> DataFuture<Vec<SessionSummary>> {
        let id = workspace_id.to_owned();
        self.read(move |f| {
            // `?workspaceId=` of an unknown workspace lists every session.
            let root = Self::root_of(f, &id).ok();
            Ok(f.sessions
                .iter()
                .filter(|s| root.as_ref().is_none_or(|r| *r == s.cwd))
                .cloned()
                .collect())
        })
    }

    fn create_session(&self, workspace_id: &str) -> DataFuture<String> {
        let made = {
            let mut s = self.state.lock().expect("fixture lock");
            Self::root_of(&s.fixture, workspace_id).map(|cwd| {
                s.created += 1;
                let id = format!("5e55f1c7-0000-4000-8000-{:012x}", s.created);
                let created_at = s.now_ms + s.created as f64 * 1000.;
                s.fixture.sessions.push(SessionSummary {
                    id: id.clone(),
                    cwd,
                    model: None,
                    title: None,
                    created_at,
                    status: Some(LiveStatus::Idle),
                    account_id: None,
                    account_label: None,
                });
                id
            })
        };
        if made.is_ok() {
            self.notify(ShellChange::Sessions {
                workspace_id: workspace_id.to_owned(),
            });
        }
        future::ready(made).boxed()
    }

    fn active_session_state(&self, workspace_id: &str) -> Option<ActiveSessionState> {
        self.state
            .lock()
            .expect("fixture lock")
            .fixture
            .active_session
            .get(workspace_id)
            .copied()
    }

    fn subscribe(&self) -> UnboundedReceiver<ShellChange> {
        let (tx, rx) = unbounded();
        self.subscribers.lock().expect("subscribers lock").push(tx);
        rx
    }
}
