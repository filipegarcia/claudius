//! What the shell reads and writes, as the [`ShellData`] trait, in the shapes
//! the real API answers:
//!
//! | Method | Route | Shape |
//! |---|---|---|
//! | [`ShellData::workspaces`] | `GET /api/workspaces` | [`WorkspaceList`] |
//! | [`ShellData::select_workspace`] | `POST /api/workspaces/<id>/select` | |
//! | [`ShellData::open_tabs`] | `GET /api/sessions/open-tabs` | [`OpenTabs`] |
//! | [`ShellData::put_open_tabs`] | `PUT /api/sessions/open-tabs` | [`OpenTabsPut`] |
//! | [`ShellData::sessions`] | `GET /api/sessions?workspaceId=<id>` | [`SessionSummary`] rows |
//! | [`ShellData::create_session`] | `POST /api/sessions` | the new id |
//! | [`ShellData::workspace_icon`] | `GET /api/workspaces/<id>/icon` | [`IconImage`] |
//! | [`ShellData::customizations`] | `GET /api/customizations` | the enabled names |
//! | [`ShellData::open_chat`] | the chat's own requests | a [`ChatPage`] |
//!
//! The open-tabs routes scope to the active workspace's cwd through the
//! `claudius.workspace` cookie. The trait names the workspace instead:
//! [`crate::live::TransportShellData`] gives each workspace its own cookie
//! jar holding it, as the front door sets it on a `/<id>` page.
//!
//! Every call returns a `Send` future, so an implementation can run on any
//! executor, and [`ShellData::subscribe`] streams [`ShellChange`]s: the shell
//! reloads what changed. [`crate::fixture::FixtureShellData`] is the
//! fixture-backed implementation, [`crate::live::TransportShellData`] the
//! engine's (U04b).

use claudius_client::effect::{FetchOutcome, FetchRequest};
use futures::channel::mpsc::UnboundedReceiver;
use futures::channel::oneshot;
use futures::future::{BoxFuture, FutureExt as _};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use crate::chat::ChatPage;

/// An answer from the data source.
pub type DataFuture<T> = BoxFuture<'static, anyhow::Result<T>>;

/// `GET /api/workspaces`: `{workspaces, activeId}`. `activeId` is the
/// server's `resolveActiveWorkspace` (the cookie's workspace, else the
/// store's hint, else the first), or `null` with no workspace.
#[derive(Clone, Debug, Default, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceList {
    pub workspaces: Vec<Workspace>,
    pub active_id: Option<String>,
}

/// One store entry (`workspaces-store.ts` `Workspace`). Fields the shell
/// doesn't read (`defaults`, `commitPrefix`, …) stay in `extra`.
#[derive(Clone, Debug, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Workspace {
    pub id: String,
    pub name: String,
    pub root_path: String,
    /// `{kind: "letter", letter, color}` or `{kind: "image", ext}`, kept as
    /// the store holds it; [`Workspace::icon`] reads it.
    #[serde(default)]
    pub icon: Value,
    #[serde(default)]
    pub created_at: f64,
    #[serde(default)]
    pub updated_at: f64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_opened_at: Option<f64>,
    /// `"project"` or `"customization"`; absent on older files (a project).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub kind: Option<String>,
    /// The rail's saved tile order, by action id (`"nav.git"`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub nav_order: Option<Vec<String>>,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

/// A workspace tile's mark (`WorkspaceIcon.tsx`).
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum WorkspaceIcon {
    /// A letter on a color (`#d97757`).
    Letter { letter: String, color: String },
    /// An uploaded image (`/api/workspaces/<id>/icon`). The shell draws the
    /// letter fallback until the icon route is wired (U04b).
    Image { ext: String },
}

impl Workspace {
    /// The icon as `WorkspaceIcon.tsx` reads it. A letter icon with an empty
    /// letter shows the name's first character, then `?`.
    pub fn icon(&self) -> WorkspaceIcon {
        let field = |k: &str| {
            self.icon
                .get(k)
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_owned()
        };
        match self.icon.get("kind").and_then(Value::as_str) {
            Some("image") => WorkspaceIcon::Image { ext: field("ext") },
            _ => WorkspaceIcon::Letter {
                letter: field("letter"),
                color: field("color"),
            },
        }
    }

    /// The letter a tile shows: the icon's, else the name's first
    /// character upper-cased (JS `charAt(0).toUpperCase()`), else `?`.
    pub fn letter(&self) -> String {
        if let WorkspaceIcon::Letter { letter, .. } = self.icon()
            && !letter.is_empty()
        {
            return letter;
        }
        self.name
            .chars()
            .next()
            .map(|c| c.to_uppercase().collect())
            .unwrap_or_else(|| "?".into())
    }

    pub fn is_customization(&self) -> bool {
        self.kind.as_deref() == Some("customization")
    }
}

/// `GET /api/sessions/open-tabs`: `{tabs, activeId, labelMaxWidth, titles,
/// pinned}` for the active workspace's cwd. `titles` holds each tab's
/// trimmed title from the sessions table, when it has one.
#[derive(Clone, Debug, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenTabs {
    pub tabs: Vec<String>,
    pub active_id: Option<String>,
    pub label_max_width: f64,
    pub titles: Map<String, Value>,
    pub pinned: Vec<String>,
}

impl Default for OpenTabs {
    /// What the route answers for a cwd with nothing stored.
    fn default() -> Self {
        OpenTabs {
            tabs: Vec::new(),
            active_id: None,
            label_max_width: TAB_LABEL_DEFAULT,
            titles: Map::new(),
            pinned: Vec::new(),
        }
    }
}

/// `open-tabs-store.ts`'s `TAB_LABEL_DEFAULT` (and `SessionTabs`' fallback).
pub const TAB_LABEL_DEFAULT: f64 = 180.;

/// `PUT /api/sessions/open-tabs`: each present field is written. The chat
/// sends `{tabs, activeId, pinned}` after every strip change and
/// `{labelMaxWidth}` after a resize.
#[derive(Clone, Debug, Default, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenTabsPut {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tabs: Option<Vec<String>>,
    /// `Some(None)` writes `null` (no active tab).
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        with = "double_option"
    )]
    pub active_id: Option<Option<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pinned: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub label_max_width: Option<f64>,
}

/// `Option<Option<T>>` as "absent / null / value".
mod double_option {
    use serde::{Deserialize, Deserializer, Serialize, Serializer};

    pub fn serialize<S: Serializer, T: Serialize>(
        v: &Option<Option<T>>,
        s: S,
    ) -> Result<S::Ok, S::Error> {
        match v {
            Some(inner) => inner.serialize(s),
            None => s.serialize_none(),
        }
    }

    pub fn deserialize<'de, D: Deserializer<'de>, T: Deserialize<'de>>(
        d: D,
    ) -> Result<Option<Option<T>>, D::Error> {
        Option::<T>::deserialize(d).map(Some)
    }
}

/// A live session's coarse state (`turn_status`), as `GET /api/sessions`
/// reports it.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum LiveStatus {
    Running,
    Idle,
    NeedsInput,
}

/// One row of `GET /api/sessions` (a session the server holds in memory),
/// or of a live chat's merged list (`useSession().sessions`, U04e), whose
/// disk-only rows have no status, no `createdAt` and maybe no `cwd`.
#[derive(Clone, Debug, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionSummary {
    pub id: String,
    /// `""` when the row has none (`undefined` in the TS: no root matches).
    #[serde(default)]
    pub cwd: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    /// The user's (or the SDK's) title; `null` until there is one.
    #[serde(default)]
    pub title: Option<String>,
    /// Epoch ms the server built the session; `0` when unknown.
    #[serde(default)]
    pub created_at: f64,
    /// `None` on a disk-only row: its tab's dot is "background".
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub status: Option<LiveStatus>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub account_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub account_label: Option<String>,
}

/// The dot on a tab (`SessionTabs.tsx` `TabStatus`).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum TabStatus {
    Running,
    Idle,
    Starting,
    Error,
    /// Not held by the server (reaped, or never resumed): resumes from disk
    /// on click.
    Background,
    NeedsInput,
}

impl TabStatus {
    /// The `data-status` / tooltip word.
    pub fn as_str(self) -> &'static str {
        match self {
            TabStatus::Running => "running",
            TabStatus::Idle => "idle",
            TabStatus::Starting => "starting",
            TabStatus::Error => "error",
            TabStatus::Background => "background",
            TabStatus::NeedsInput => "needs_input",
        }
    }
}

impl From<LiveStatus> for TabStatus {
    fn from(s: LiveStatus) -> Self {
        match s {
            LiveStatus::Running => TabStatus::Running,
            LiveStatus::Idle => TabStatus::Idle,
            LiveStatus::NeedsInput => TabStatus::NeedsInput,
        }
    }
}

/// The bound session's own state, which the chat (`useSession`) holds and
/// the active tab's dot reads (`activeTabStatus`). U05 owns it; the fixture
/// can set it per workspace.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ActiveSessionState {
    pub ready: bool,
    pub pending: bool,
    pub has_error: bool,
    #[serde(default)]
    pub needs_input: bool,
}

/// `activeTabStatus`: error, then not ready (starting), then blocked on a
/// prompt, then mid-turn, else idle.
pub fn active_tab_status(s: ActiveSessionState) -> TabStatus {
    if s.has_error {
        TabStatus::Error
    } else if !s.ready {
        TabStatus::Starting
    } else if s.needs_input {
        TabStatus::NeedsInput
    } else if s.pending {
        TabStatus::Running
    } else {
        TabStatus::Idle
    }
}

/// Something the shell shows changed at the source.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ShellChange {
    /// The workspace list or the active workspace.
    Workspaces,
    /// A workspace's persisted strip.
    OpenTabs { workspace_id: String },
    /// A workspace's live sessions (a status or a title).
    Sessions { workspace_id: String },
}

/// An uploaded workspace icon: the bytes and the route's `Content-Type`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct IconImage {
    pub bytes: Vec<u8>,
    pub content_type: String,
}

/// The shell's data source. See the module docs for the routes.
pub trait ShellData: Send + Sync + 'static {
    fn workspaces(&self) -> DataFuture<WorkspaceList>;
    fn select_workspace(&self, id: &str) -> DataFuture<()>;
    fn open_tabs(&self, workspace_id: &str) -> DataFuture<OpenTabs>;
    fn put_open_tabs(&self, workspace_id: &str, body: OpenTabsPut) -> DataFuture<()>;
    fn sessions(&self, workspace_id: &str) -> DataFuture<Vec<SessionSummary>>;
    /// A new session in the workspace (the chat's "+ New session"); its id.
    fn create_session(&self, workspace_id: &str) -> DataFuture<String>;
    /// The bound session's state for the active tab's dot, from a source
    /// with no live chat (see [`Self::open_chat`]). `None`: the dot reads
    /// the live status.
    fn active_session_state(&self, _workspace_id: &str) -> Option<ActiveSessionState> {
        None
    }
    /// A workspace's uploaded icon (`<img src="/api/workspaces/<id>/icon">`);
    /// `None` when the route has none (the tile draws its letter).
    fn workspace_icon(&self, _id: &str) -> DataFuture<Option<IconImage>> {
        futures::future::ready(Ok(None)).boxed()
    }
    /// The names (lower-cased) of the published customizations, which
    /// un-hide the rail's gated tiles (`SideNav`'s `enabledCustNames`).
    /// `Ok(None)`: not known (the tiles stay hidden); an error counts as
    /// none published, as `SideNav`'s `catch` does.
    fn customizations(&self) -> DataFuture<Option<Vec<String>>> {
        futures::future::ready(Ok(None)).boxed()
    }
    /// Mounts the workspace's chat (`useSession`) at `href` (the page's
    /// URL, `http://localhost/<id>?…`) with the route's `pathname`. `None`
    /// for a source with no engine behind it: the shell then boots the
    /// strip itself and the bound tab's dot reads
    /// [`Self::active_session_state`].
    fn open_chat(&self, _workspace_id: &str, _href: &str, _pathname: &str) -> Option<ChatPage> {
        None
    }
    /// Whether [`Self::open_chat`] mounts chats (the shell then lets them
    /// boot the strip).
    fn has_live_chat(&self) -> bool {
        false
    }
    /// Runs one of workspace `workspace_id`'s page requests that isn't the
    /// chat's own (the composer's draft, `!` bash, the prompt color: a
    /// relative URL, as the page's `fetch`). A source with no server drops
    /// the sender, which reads as a failed request.
    fn page_fetch(
        &self,
        _workspace_id: &str,
        _req: FetchRequest,
    ) -> oneshot::Receiver<FetchOutcome> {
        oneshot::channel().1
    }
    /// Change notifications, from now on. Each call is a new stream.
    fn subscribe(&self) -> UnboundedReceiver<ShellChange>;
}
