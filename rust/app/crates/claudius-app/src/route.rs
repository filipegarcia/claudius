//! The React app's page routes as [`Route`], their URLs ([`Route::path`],
//! [`Route::parse`]), and the redirects between them ([`resolve`]).
//!
//! Every `page.tsx` under `app/` is a route here, except the redirect-only
//! stubs, which are rules: `/` (R1), the 20 bare workspace-scoped paths like
//! `/git` (R2), an unknown workspace id (R4) and `/welcome` once a workspace
//! exists (R5), as `claudius_server::pages` and
//! `components/nav/WorkspaceRedirects.tsx` decide them.

use std::fmt::Write as _;

/// A page.
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub enum Route {
    /// `app/[workspaceId]/…`.
    Workspace { id: String, page: WorkspacePage },
    /// `/welcome`: the first-run splash, while no workspace exists.
    Welcome,
    /// `/settings`.
    Settings,
    /// `/plugins`.
    Plugins,
    /// `/usage` (the rail's Account tile).
    Usage,
    /// `/community`.
    Community,
    /// `/doctor`, `?section=prompt-audit` scrolls to that section.
    Doctor { section: Option<String> },
    /// `/release-notes`.
    ReleaseNotes,
    /// `/updater`.
    Updater,
    /// `/customize`.
    Customize,
    /// `/customize/settings`.
    CustomizeSettings,
    /// `/customize/<id>`.
    CustomizeDetail { id: String },
    /// `/customize/<id>/chat`.
    CustomizeChat { id: String },
    /// No page has this path (Next's 404).
    NotFound { path: String },
}

/// A page under `app/[workspaceId]/`.
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub enum WorkspacePage {
    /// The workspace root: the chat. `?session=<id>` binds that session.
    Chat {
        session: Option<String>,
    },
    Agents,
    Assets,
    Cost,
    Database,
    Docker,
    /// `/files?root=<id>&path=<p>`.
    Files {
        root: Option<String>,
        path: Option<String>,
    },
    Git,
    /// `/git/file?path=<p>&mode=staged|worktree|untracked`.
    GitFile {
        path: String,
        mode: Option<String>,
    },
    Hooks,
    Keybindings,
    Mcp,
    Memory,
    Notebooks,
    Permissions,
    Pipeline,
    Schedule,
    Sessions,
    /// `/sessions/<id>?dir=<project dir>`.
    Session {
        id: String,
        dir: Option<String>,
    },
    Skills,
    Tracker,
    /// The workspace's own settings (the rail's Workspace tile).
    Workspace,
    /// `/dev/<page>`: the design previews.
    Dev(DevPage),
}

/// `app/[workspaceId]/dev/*`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum DevPage {
    ActivityRunning,
    AskRailPreview,
    ChatAsk,
    ChatEmpty,
    ChatPeerMessage,
    ChatTodos,
    ChatUserMarkdown,
    ChatVerbose,
    ChatWorkflowCompleted,
    ChatWorkflow,
    MinecraftPreview,
    ToolCallPreview,
    TranscriptViewerMarkdown,
    WorkflowStates,
}

impl DevPage {
    pub const ALL: [DevPage; 14] = [
        DevPage::ActivityRunning,
        DevPage::AskRailPreview,
        DevPage::ChatAsk,
        DevPage::ChatEmpty,
        DevPage::ChatPeerMessage,
        DevPage::ChatTodos,
        DevPage::ChatUserMarkdown,
        DevPage::ChatVerbose,
        DevPage::ChatWorkflowCompleted,
        DevPage::ChatWorkflow,
        DevPage::MinecraftPreview,
        DevPage::ToolCallPreview,
        DevPage::TranscriptViewerMarkdown,
        DevPage::WorkflowStates,
    ];

    /// The directory name.
    pub fn slug(self) -> &'static str {
        match self {
            DevPage::ActivityRunning => "activity-running",
            DevPage::AskRailPreview => "ask-rail-preview",
            DevPage::ChatAsk => "chat-ask",
            DevPage::ChatEmpty => "chat-empty",
            DevPage::ChatPeerMessage => "chat-peer-message",
            DevPage::ChatTodos => "chat-todos",
            DevPage::ChatUserMarkdown => "chat-user-markdown",
            DevPage::ChatVerbose => "chat-verbose",
            DevPage::ChatWorkflowCompleted => "chat-workflow-completed",
            DevPage::ChatWorkflow => "chat-workflow",
            DevPage::MinecraftPreview => "minecraft-preview",
            DevPage::ToolCallPreview => "tool-call-preview",
            DevPage::TranscriptViewerMarkdown => "transcript-viewer-markdown",
            DevPage::WorkflowStates => "workflow-states",
        }
    }

    fn from_slug(s: &str) -> Option<DevPage> {
        DevPage::ALL.into_iter().find(|p| p.slug() == s)
    }
}

/// The workspace pages with no parameters, by directory name.
const PLAIN: [(&str, WorkspacePage); 19] = [
    ("agents", WorkspacePage::Agents),
    ("assets", WorkspacePage::Assets),
    ("cost", WorkspacePage::Cost),
    ("database", WorkspacePage::Database),
    ("docker", WorkspacePage::Docker),
    ("git", WorkspacePage::Git),
    ("hooks", WorkspacePage::Hooks),
    ("keybindings", WorkspacePage::Keybindings),
    ("mcp", WorkspacePage::Mcp),
    ("memory", WorkspacePage::Memory),
    ("notebooks", WorkspacePage::Notebooks),
    ("permissions", WorkspacePage::Permissions),
    ("pipeline", WorkspacePage::Pipeline),
    ("schedule", WorkspacePage::Schedule),
    ("sessions", WorkspacePage::Sessions),
    ("skills", WorkspacePage::Skills),
    ("tracker", WorkspacePage::Tracker),
    ("workspace", WorkspacePage::Workspace),
    // `files` takes a query but no segment.
    (
        "files",
        WorkspacePage::Files {
            root: None,
            path: None,
        },
    ),
];

/// The top-level segments that live under `app/[workspaceId]/` (R2's
/// `SCOPED`): a bare one belongs to the active workspace.
pub const SCOPED: [&str; 20] = [
    "agents",
    "assets",
    "cost",
    "database",
    "dev",
    "docker",
    "files",
    "git",
    "hooks",
    "keybindings",
    "mcp",
    "memory",
    "notebooks",
    "permissions",
    "pipeline",
    "schedule",
    "sessions",
    "skills",
    "tracker",
    "workspace",
];

/// The two bare stubs that catch every depth (`[[...rest]]`).
const CATCH_ALL: [&str; 2] = ["sessions", "dev"];

/// `wks_<12 hex>`, the id shape the store mints.
pub fn is_workspace_id(s: &str) -> bool {
    s.len() == 16
        && s.starts_with("wks_")
        && s[4..]
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

impl WorkspacePage {
    /// The path under `/<workspace id>` with its query: `""` for the chat,
    /// `/git/file?path=a.rs&mode=staged`.
    pub fn inner_path(&self) -> String {
        let mut out = self.inner_pathname();
        let query: Vec<(&str, &str)> = match self {
            WorkspacePage::Chat { session } => session
                .as_deref()
                .map(|s| vec![("session", s)])
                .unwrap_or_default(),
            WorkspacePage::Files { root, path } => [("root", root), ("path", path)]
                .into_iter()
                .filter_map(|(k, v)| v.as_deref().map(|v| (k, v)))
                .collect(),
            WorkspacePage::GitFile { path, mode } => {
                let mut q = vec![("path", path.as_str())];
                if let Some(m) = mode {
                    q.push(("mode", m));
                }
                q
            }
            WorkspacePage::Session { dir, .. } => {
                dir.as_deref().map(|d| vec![("dir", d)]).unwrap_or_default()
            }
            _ => Vec::new(),
        };
        push_query(&mut out, &query);
        out
    }

    /// The inner path without the query: what the nav tiles' active state
    /// and the per-workspace route memory compare (`usePathname`).
    pub fn inner_pathname(&self) -> String {
        match self {
            WorkspacePage::Chat { .. } => String::new(),
            WorkspacePage::GitFile { .. } => "/git/file".into(),
            WorkspacePage::Session { id, .. } => format!("/sessions/{}", encode(id)),
            WorkspacePage::Dev(p) => format!("/dev/{}", p.slug()),
            page => {
                let (name, _) = PLAIN
                    .iter()
                    .find(|(_, p)| std::mem::discriminant(p) == std::mem::discriminant(page))
                    .expect("every plain page has a directory");
                format!("/{name}")
            }
        }
    }

    /// The page as the route memory keeps it: the pathname only, so the
    /// query (`?session=`, a file path) is dropped (`setLastPath(id,
    /// pathname)`).
    pub fn without_query(&self) -> WorkspacePage {
        match self {
            WorkspacePage::Chat { .. } => WorkspacePage::Chat { session: None },
            WorkspacePage::Files { .. } => WorkspacePage::Files {
                root: None,
                path: None,
            },
            WorkspacePage::GitFile { .. } => WorkspacePage::GitFile {
                path: String::new(),
                mode: None,
            },
            WorkspacePage::Session { id, .. } => WorkspacePage::Session {
                id: id.clone(),
                dir: None,
            },
            page => page.clone(),
        }
    }

    /// The screen's heading.
    pub fn title(&self) -> String {
        match self {
            WorkspacePage::Chat { .. } => "Chat".into(),
            WorkspacePage::Agents => "Agents".into(),
            WorkspacePage::Assets => "Assets".into(),
            WorkspacePage::Cost => "Cost".into(),
            WorkspacePage::Database => "Database".into(),
            WorkspacePage::Docker => "Docker".into(),
            WorkspacePage::Files { .. } => "Files".into(),
            WorkspacePage::Git => "Git".into(),
            WorkspacePage::GitFile { .. } => "Git file".into(),
            WorkspacePage::Hooks => "Hooks".into(),
            WorkspacePage::Keybindings => "Keybindings".into(),
            WorkspacePage::Mcp => "MCP".into(),
            WorkspacePage::Memory => "Memory".into(),
            WorkspacePage::Notebooks => "Notebooks".into(),
            WorkspacePage::Permissions => "Permissions".into(),
            WorkspacePage::Pipeline => "Pipeline".into(),
            WorkspacePage::Schedule => "Schedule".into(),
            WorkspacePage::Sessions => "Sessions".into(),
            WorkspacePage::Session { .. } => "Session".into(),
            WorkspacePage::Skills => "Skills".into(),
            WorkspacePage::Tracker => "Tracker".into(),
            WorkspacePage::Workspace => "Workspace settings".into(),
            WorkspacePage::Dev(p) => format!("Dev preview: {}", p.slug()),
        }
    }

    /// The page's parameters, for its placeholder.
    pub fn params(&self) -> Vec<(&'static str, String)> {
        let opt = |v: &Option<String>| v.clone().unwrap_or_else(|| "(none)".into());
        match self {
            WorkspacePage::Chat { session } => vec![("session", opt(session))],
            WorkspacePage::Files { root, path } => vec![("root", opt(root)), ("path", opt(path))],
            WorkspacePage::GitFile { path, mode } => {
                vec![("path", path.clone()), ("mode", opt(mode))]
            }
            WorkspacePage::Session { id, dir } => vec![("id", id.clone()), ("dir", opt(dir))],
            _ => Vec::new(),
        }
    }

    fn parse(segments: &[&str], query: &[(String, String)]) -> Option<WorkspacePage> {
        let q = |k: &str| query.iter().find(|(n, _)| n == k).map(|(_, v)| v.clone());
        let page = match segments {
            [] => WorkspacePage::Chat {
                session: q("session").filter(|s| !s.is_empty()),
            },
            ["files"] => WorkspacePage::Files {
                root: q("root"),
                path: q("path"),
            },
            ["git", "file"] => WorkspacePage::GitFile {
                path: q("path").unwrap_or_default(),
                mode: q("mode")
                    .filter(|m| matches!(m.as_str(), "staged" | "worktree" | "untracked")),
            },
            ["sessions", id] => WorkspacePage::Session {
                id: decode(id),
                dir: q("dir").filter(|d| !d.is_empty()),
            },
            ["dev", slug] => WorkspacePage::Dev(DevPage::from_slug(slug)?),
            [name] => PLAIN.iter().find(|(n, _)| n == name)?.1.clone(),
            _ => return None,
        };
        Some(page)
    }
}

/// The global pages (`app/<name>/page.tsx`), by path.
const GLOBAL: [(&str, Route); 10] = [
    ("/welcome", Route::Welcome),
    ("/settings", Route::Settings),
    ("/plugins", Route::Plugins),
    ("/usage", Route::Usage),
    ("/community", Route::Community),
    ("/doctor", Route::Doctor { section: None }),
    ("/release-notes", Route::ReleaseNotes),
    ("/updater", Route::Updater),
    ("/customize", Route::Customize),
    ("/customize/settings", Route::CustomizeSettings),
];

impl Route {
    /// The chat of a workspace.
    pub fn chat(workspace: &str) -> Route {
        Route::Workspace {
            id: workspace.into(),
            page: WorkspacePage::Chat { session: None },
        }
    }

    /// A page of a workspace.
    pub fn page(workspace: &str, page: WorkspacePage) -> Route {
        Route::Workspace {
            id: workspace.into(),
            page,
        }
    }

    /// The URL, path and query.
    pub fn path(&self) -> String {
        match self {
            Route::Workspace { id, page } => format!("/{}{}", encode(id), page.inner_path()),
            Route::Doctor { section } => {
                let mut out = "/doctor".to_owned();
                if let Some(s) = section {
                    push_query(&mut out, &[("section", s)]);
                }
                out
            }
            Route::CustomizeDetail { id } => format!("/customize/{}", encode(id)),
            Route::CustomizeChat { id } => format!("/customize/{}/chat", encode(id)),
            Route::NotFound { path } => path.clone(),
            global => GLOBAL
                .iter()
                .find(|(_, r)| r == global)
                .map(|(p, _)| (*p).to_owned())
                .expect("every global page has a path"),
        }
    }

    /// The URL's pathname (no query).
    pub fn pathname(&self) -> String {
        let p = self.path();
        match p.find('?') {
            Some(at) => p[..at].to_owned(),
            None => p,
        }
    }

    /// The page a URL names, without the redirect rules: a bare scoped path
    /// (`/git`) or `/` is `None` (only [`resolve`] knows where they go), as
    /// is a path no page has.
    pub fn parse(url: &str) -> Option<Route> {
        let (path, query) = split_url(url);
        let segments: Vec<&str> = path.split('/').filter(|s| !s.is_empty()).collect();
        let q = |k: &str| query.iter().find(|(n, _)| n == k).map(|(_, v)| v.clone());
        match segments.as_slice() {
            [] => None,
            ["doctor"] => Some(Route::Doctor {
                section: q("section"),
            }),
            ["customize", "settings"] => Some(Route::CustomizeSettings),
            ["customize", id] => Some(Route::CustomizeDetail { id: decode(id) }),
            ["customize", id, "chat"] => Some(Route::CustomizeChat { id: decode(id) }),
            [first, rest @ ..] => {
                let bare = format!("/{}", segments.join("/"));
                if let Some((_, r)) = GLOBAL.iter().find(|(p, _)| *p == bare) {
                    return Some(r.clone());
                }
                if SCOPED.contains(first) || is_global_name(first) {
                    return None;
                }
                let page = WorkspacePage::parse(rest, &query)?;
                Some(Route::Workspace {
                    id: decode(first),
                    page,
                })
            }
        }
    }

    /// The workspace the page belongs to.
    pub fn workspace(&self) -> Option<&str> {
        match self {
            Route::Workspace { id, .. } => Some(id),
            _ => None,
        }
    }

    /// The screen's heading.
    pub fn title(&self) -> String {
        match self {
            Route::Workspace { page, .. } => page.title(),
            Route::Welcome => "Welcome".into(),
            Route::Settings => "Settings".into(),
            Route::Plugins => "Plugins".into(),
            Route::Usage => "Account".into(),
            Route::Community => "Community".into(),
            Route::Doctor { .. } => "Doctor".into(),
            Route::ReleaseNotes => "Release notes".into(),
            Route::Updater => "Updater".into(),
            Route::Customize => "Customize".into(),
            Route::CustomizeSettings => "Customize settings".into(),
            Route::CustomizeDetail { .. } => "Customization".into(),
            Route::CustomizeChat { .. } => "Customization chat".into(),
            Route::NotFound { .. } => "This page could not be found.".into(),
        }
    }

    /// The page's parameters, for its placeholder.
    pub fn params(&self) -> Vec<(&'static str, String)> {
        match self {
            Route::Workspace { id, page } => {
                let mut out = vec![("workspace", id.clone())];
                out.extend(page.params());
                out
            }
            Route::Doctor { section } => vec![(
                "section",
                section.clone().unwrap_or_else(|| "(none)".into()),
            )],
            Route::CustomizeDetail { id } | Route::CustomizeChat { id } => {
                vec![("customization", id.clone())]
            }
            Route::NotFound { path } => vec![("path", path.clone())],
            _ => Vec::new(),
        }
    }

    /// Whether the per-workspace route memory keeps this page
    /// (`isWorkspaceScopedPath`: everything but the global pages).
    pub fn is_workspace_scoped(&self) -> bool {
        matches!(self, Route::Workspace { .. })
    }
}

/// A first segment that is a global page's (`/doctor/x` is a 404, not a
/// workspace).
fn is_global_name(first: &str) -> bool {
    GLOBAL
        .iter()
        .any(|(p, _)| p[1..].split('/').next() == Some(first))
}

/// What the redirect rules read.
pub trait Workspaces {
    fn exists(&self, id: &str) -> bool;
    /// `resolveActiveWorkspace`: the selected workspace, else the store's
    /// hint, else the first; `None` with no workspace.
    fn active(&self) -> Option<String>;
    fn first(&self) -> Option<String>;
}

/// Where a URL leads.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Resolution {
    Page(Route),
    /// A redirect (`router.replace`, or the front door's 307) to this URL.
    Redirect(String),
}

/// One step of the redirect rules, in the order the front door applies
/// them (`claudius_server::pages::decide`, for a page render with the
/// active workspace as the cookie).
pub fn resolve_step(url: &str, ws: &dyn Workspaces) -> Resolution {
    let (path, _) = split_url(url);
    let raw_query = url.find('?').map(|at| &url[at..]).unwrap_or("");
    let first = path.split('/').nth(1).unwrap_or("");

    // R4: an id the store doesn't have; the redirect drops the query.
    if is_workspace_id(first) {
        if !ws.exists(first) {
            return Resolution::Redirect("/".into());
        }
        return match Route::parse(url) {
            Some(route) => Resolution::Page(route),
            None => Resolution::Page(Route::NotFound { path: path.into() }),
        };
    }

    // R2: a bare scoped path goes under the active workspace, at any depth
    // (the cookie's rule); with none, the stubs go to `/` and a deeper path
    // has no page.
    if SCOPED.contains(&first) {
        if let Some(id) = ws.active() {
            return Resolution::Redirect(format!("/{id}{path}{raw_query}"));
        }
        let stubbed = CATCH_ALL.contains(&first) || path == format!("/{first}");
        return if stubbed {
            Resolution::Redirect(format!("/{raw_query}"))
        } else {
            Resolution::Page(Route::NotFound { path: path.into() })
        };
    }

    // R1: the chat root.
    if path == "/" || path.is_empty() {
        return match ws.active().or_else(|| ws.first()) {
            Some(id) => Resolution::Redirect(format!("/{id}{raw_query}")),
            None => Resolution::Redirect("/welcome".into()),
        };
    }

    // R5: the splash, once a workspace exists.
    if path == "/welcome" && ws.first().is_some() {
        return Resolution::Redirect("/".into());
    }

    match Route::parse(url) {
        // Any other first segment is `[workspaceId]` to Next; the layout's
        // guard sends an id the store doesn't know to `/`.
        Some(Route::Workspace { id, .. }) if !ws.exists(&id) => Resolution::Redirect("/".into()),
        Some(route) => Resolution::Page(route),
        None => Resolution::Page(Route::NotFound { path: path.into() }),
    }
}

/// Follows the redirects to a page (at most 8 hops; a loop is a 404).
pub fn resolve(url: &str, ws: &dyn Workspaces) -> Route {
    let mut url = url.to_owned();
    for _ in 0..8 {
        match resolve_step(&url, ws) {
            Resolution::Page(route) => return route,
            Resolution::Redirect(next) => url = next,
        }
    }
    Route::NotFound { path: url }
}

/// `(path, decoded query pairs)`; a `#fragment` is dropped.
fn split_url(url: &str) -> (&str, Vec<(String, String)>) {
    let url = url.split('#').next().unwrap_or("");
    let (path, query) = match url.find('?') {
        Some(at) => (&url[..at], &url[at + 1..]),
        None => (url, ""),
    };
    let pairs = query
        .split('&')
        .filter(|p| !p.is_empty())
        .map(|p| match p.find('=') {
            Some(at) => (form_decode(&p[..at]), form_decode(&p[at + 1..])),
            None => (form_decode(p), String::new()),
        })
        .collect();
    (path, pairs)
}

/// `URLSearchParams`' decoding: `+` is a space, then percent-decoding
/// (a malformed escape stays as written).
fn form_decode(s: &str) -> String {
    decode(&s.replace('+', " "))
}

/// Percent-decoding of a path segment (bytes that aren't UTF-8 are
/// replaced).
fn decode(s: &str) -> String {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%'
            && i + 2 < b.len()
            && let (Some(h), Some(l)) = (hex(b[i + 1]), hex(b[i + 2]))
        {
            out.push(h * 16 + l);
            i += 3;
            continue;
        }
        out.push(b[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn hex(b: u8) -> Option<u8> {
    match b {
        b'0'..=b'9' => Some(b - b'0'),
        b'a'..=b'f' => Some(b - b'a' + 10),
        b'A'..=b'F' => Some(b - b'A' + 10),
        _ => None,
    }
}

/// `encodeURIComponent`.
pub(crate) fn encode_uri_component(s: &str) -> String {
    encode(s)
}

fn encode(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for &b in s.as_bytes() {
        if b.is_ascii_alphanumeric() || b"-_.!~*'()".contains(&b) {
            out.push(b as char);
        } else {
            let _ = write!(out, "%{b:02X}");
        }
    }
    out
}

/// `?k=v&…` as `URLSearchParams.toString()` writes it (a space is `+`).
fn push_query(out: &mut String, pairs: &[(&str, &str)]) {
    for (i, (k, v)) in pairs.iter().enumerate() {
        out.push(if i == 0 { '?' } else { '&' });
        out.push_str(&form_encode(k));
        out.push('=');
        out.push_str(&form_encode(v));
    }
}

/// `application/x-www-form-urlencoded` (`URLSearchParams`).
pub(crate) fn form_encode(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for &b in s.as_bytes() {
        if b.is_ascii_alphanumeric() || b"*-._".contains(&b) {
            out.push(b as char);
        } else if b == b' ' {
            out.push('+');
        } else {
            let _ = write!(out, "%{b:02X}");
        }
    }
    out
}
