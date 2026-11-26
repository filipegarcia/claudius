//! The shell's state without GPUI: the workspaces, the route and its
//! history, each workspace's tab strip and live sessions, focus mode. Every
//! user action is a method; what it needs from the data source comes back
//! as [`Effect`]s, which [`crate::shell::Shell`] runs against
//! [`crate::data::ShellData`].

use std::collections::HashMap;

use crate::data::{ActiveSessionState, OpenTabs, SessionSummary, Workspace, WorkspaceList};
use crate::nav::{self, FocusLevel, NavItem};
use crate::route::{self, Route, WorkspacePage};
use crate::tabs::{TabStrip, TabView};

/// Work for the data source.
#[derive(Clone, Debug, PartialEq)]
pub enum Effect {
    /// `POST /api/workspaces/<id>/select`.
    SelectWorkspace(String),
    /// Read a workspace's strip and live sessions, then
    /// [`ShellState::workspace_loaded`].
    LoadWorkspace(String),
    /// Re-read a workspace's live sessions ([`ShellState::sessions_loaded`]).
    LoadSessions(String),
    /// `PUT /api/sessions/open-tabs` for a workspace.
    PersistTabs(String, crate::data::OpenTabsPut),
    /// `POST /api/sessions` in a workspace, then
    /// [`ShellState::session_created`].
    CreateSession(String),
    /// Ask before closing the unpinned tabs (`confirm()`), then
    /// [`ShellState::close_all_confirmed`].
    ConfirmCloseAll { workspace: String, message: String },
}

#[derive(Debug, Default)]
struct WorkspaceData {
    strip: TabStrip,
    sessions: Vec<SessionSummary>,
    loaded: bool,
    loading: bool,
    /// The strip's active tab as first read, until the chat first boots.
    saved_active: Option<String>,
}

#[derive(Debug)]
pub struct ShellState {
    workspaces: Vec<Workspace>,
    /// The store's answer (`resolveActiveWorkspace`).
    store_active: Option<String>,
    /// The workspace the user is in (the `claudius.workspace` cookie).
    selected: Option<String>,
    history: Vec<Route>,
    index: usize,
    data: HashMap<String, WorkspaceData>,
    /// Per-workspace route memory (`workspace-route-memory.ts`).
    last_page: HashMap<String, WorkspacePage>,
    focus: FocusLevel,
    listed: bool,
    /// The published customizations' names (`None`: not known yet).
    enabled_customizations: Option<Vec<String>>,
}

impl Default for ShellState {
    fn default() -> Self {
        ShellState {
            workspaces: Vec::new(),
            store_active: None,
            selected: None,
            history: vec![Route::Welcome],
            index: 0,
            data: HashMap::new(),
            last_page: HashMap::new(),
            focus: FocusLevel::Off,
            listed: false,
            enabled_customizations: None,
        }
    }
}

impl route::Workspaces for ShellState {
    fn exists(&self, id: &str) -> bool {
        self.workspaces.iter().any(|w| w.id == id)
    }
    fn active(&self) -> Option<String> {
        self.selected
            .clone()
            .filter(|s| self.exists(s))
            .or_else(|| self.store_active.clone().filter(|s| self.exists(s)))
            .or_else(|| self.first())
    }
    fn first(&self) -> Option<String> {
        self.workspaces.first().map(|w| w.id.clone())
    }
}

impl ShellState {
    pub fn new() -> Self {
        Self::default()
    }

    // ---- reads ------------------------------------------------------------

    pub fn route(&self) -> &Route {
        &self.history[self.index]
    }

    /// Whether the workspace list has arrived.
    pub fn is_listed(&self) -> bool {
        self.listed
    }

    pub fn workspaces(&self) -> &[Workspace] {
        &self.workspaces
    }

    /// The workspace the rails and shortcuts act on.
    pub fn active_workspace(&self) -> Option<&Workspace> {
        let id = route::Workspaces::active(self)?;
        self.workspaces.iter().find(|w| w.id == id)
    }

    pub fn focus(&self) -> FocusLevel {
        self.focus
    }

    /// The rails' focus level on this route: only the chat applies it.
    pub fn effective_focus(&self) -> FocusLevel {
        if self.on_chat() {
            self.focus
        } else {
            FocusLevel::Off
        }
    }

    pub fn can_go_back(&self) -> bool {
        self.index > 0
    }

    pub fn can_go_forward(&self) -> bool {
        self.index + 1 < self.history.len()
    }

    /// The chat of a workspace is on screen (where the strip, its shortcuts
    /// and focus mode live).
    pub fn on_chat(&self) -> bool {
        matches!(
            self.route(),
            Route::Workspace {
                page: WorkspacePage::Chat { .. },
                ..
            }
        )
    }

    pub fn strip(&self, workspace: &str) -> Option<&TabStrip> {
        self.data.get(workspace).map(|d| &d.strip)
    }

    pub fn sessions(&self, workspace: &str) -> &[SessionSummary] {
        self.data
            .get(workspace)
            .map(|d| d.sessions.as_slice())
            .unwrap_or_default()
    }

    pub fn is_loaded(&self, workspace: &str) -> bool {
        self.data.get(workspace).is_some_and(|d| d.loaded)
    }

    /// The active workspace's tabs as drawn, in strip order.
    pub fn tab_views(
        &self,
        bound_state: Option<ActiveSessionState>,
        now_year: i32,
    ) -> Vec<TabView> {
        let Some(ws) = self.active_workspace() else {
            return Vec::new();
        };
        let Some(d) = self.data.get(&ws.id) else {
            return Vec::new();
        };
        d.strip
            .tabs()
            .iter()
            .map(|id| d.strip.view(id, &d.sessions, bound_state, now_year))
            .collect()
    }

    /// The nav-icon rail's tiles for the active workspace.
    pub fn nav_items(&self) -> Vec<NavItem> {
        let order = self.active_workspace().and_then(|w| w.nav_order.as_deref());
        nav::visible_items(self.enabled_customizations.as_deref(), order)
    }

    /// Sets the published customizations (U17 reads them).
    pub fn set_enabled_customizations(&mut self, names: Vec<String>) {
        self.enabled_customizations = Some(names);
    }

    // ---- data -------------------------------------------------------------

    /// `GET /api/workspaces` answered. The first answer opens `/`; later
    /// ones re-check the route (a deleted workspace's page goes to `/`).
    pub fn workspaces_loaded(&mut self, list: WorkspaceList) -> Vec<Effect> {
        self.workspaces = list.workspaces;
        self.store_active = list.active_id;
        let first = !self.listed;
        self.listed = true;
        if first {
            return self.replace_url("/");
        }
        if let Some(id) = self.route().workspace()
            && !route::Workspaces::exists(self, id)
        {
            return self.replace_url("/");
        }
        Vec::new()
    }

    /// A workspace's strip and sessions arrived: hydrate, then boot its chat
    /// if it's on screen.
    pub fn workspace_loaded(
        &mut self,
        workspace: &str,
        tabs: OpenTabs,
        sessions: Vec<SessionSummary>,
    ) -> Vec<Effect> {
        let d = self.data.entry(workspace.to_owned()).or_default();
        d.strip.hydrate(&tabs);
        d.sessions = sessions;
        d.loaded = true;
        d.loading = false;
        d.saved_active = tabs.active_id.filter(|a| !a.is_empty());
        self.boot(workspace)
    }

    /// A workspace's live sessions were re-read.
    pub fn sessions_loaded(&mut self, workspace: &str, sessions: Vec<SessionSummary>) {
        self.data.entry(workspace.to_owned()).or_default().sessions = sessions;
    }

    /// `POST /api/sessions` answered: the chat binds it, and it joins the
    /// strip.
    pub fn session_created(&mut self, workspace: &str, id: &str) -> Vec<Effect> {
        let d = self.data.entry(workspace.to_owned()).or_default();
        d.strip.bind(id);
        let mut out = vec![Effect::LoadSessions(workspace.to_owned())];
        out.extend(self.persist(workspace));
        out
    }

    /// The chat's boot (`useSession`), each time the chat comes on screen:
    /// `?session=` if the URL has one, else the strip's active tab (at the
    /// first boot, the one the route saved), else a new session.
    fn boot(&mut self, workspace: &str) -> Vec<Effect> {
        let explicit = match self.route() {
            Route::Workspace {
                id,
                page: WorkspacePage::Chat { session },
            } if id == workspace => session.clone(),
            _ => return Vec::new(),
        };
        let Some(d) = self.data.get_mut(workspace) else {
            return Vec::new();
        };
        if !d.loaded {
            return Vec::new();
        }
        let resume = explicit.or_else(|| match d.strip.bound() {
            None => d.saved_active.take(),
            Some(_) => d.strip.active().map(str::to_owned),
        });
        match resume {
            Some(id) => {
                d.strip.select(&id);
                self.persist(workspace)
            }
            None => vec![Effect::CreateSession(workspace.to_owned())],
        }
    }

    fn persist(&self, workspace: &str) -> Vec<Effect> {
        let Some(d) = self.data.get(workspace) else {
            return Vec::new();
        };
        let root = self
            .workspaces
            .iter()
            .find(|w| w.id == workspace)
            .map(|w| w.root_path.as_str())
            .unwrap_or_default();
        d.strip
            .persist(root, &d.sessions)
            .map(|body| Effect::PersistTabs(workspace.to_owned(), body))
            .into_iter()
            .collect()
    }

    // ---- navigation -------------------------------------------------------

    /// Opens a URL through the redirect rules, as a new history entry.
    pub fn open_url(&mut self, url: &str) -> Vec<Effect> {
        let route = route::resolve(url, self);
        self.navigate(route)
    }

    /// The same, replacing the current entry (`router.replace`).
    fn replace_url(&mut self, url: &str) -> Vec<Effect> {
        let route = route::resolve(url, self);
        self.history[self.index] = route;
        self.arrive()
    }

    /// A new history entry for a page (a link, a tile, a shortcut). The
    /// same page again adds none.
    pub fn navigate(&mut self, route: Route) -> Vec<Effect> {
        if *self.route() == route {
            return Vec::new();
        }
        self.history.truncate(self.index + 1);
        self.history.push(route);
        self.index = self.history.len() - 1;
        self.arrive()
    }

    /// Back (⌘[), as the browser's.
    pub fn back(&mut self) -> Vec<Effect> {
        if !self.can_go_back() {
            return Vec::new();
        }
        self.index -= 1;
        self.arrive()
    }

    /// Forward (⌘]).
    pub fn forward(&mut self) -> Vec<Effect> {
        if !self.can_go_forward() {
            return Vec::new();
        }
        self.index += 1;
        self.arrive()
    }

    /// What landing on the current route does: a workspace page selects its
    /// workspace (the front door's cookie) and is remembered for it; the
    /// workspace's data loads once; its chat boots.
    fn arrive(&mut self) -> Vec<Effect> {
        let mut out = Vec::new();
        let Route::Workspace { id, page } = self.route().clone() else {
            return out;
        };
        if self.selected.as_deref() != Some(id.as_str()) {
            self.selected = Some(id.clone());
            out.push(Effect::SelectWorkspace(id.clone()));
        }
        self.last_page.insert(id.clone(), page.without_query());
        let d = self.data.entry(id.clone()).or_default();
        if !d.loaded {
            if !d.loading {
                d.loading = true;
                out.push(Effect::LoadWorkspace(id));
            }
            return out;
        }
        out.extend(self.boot(&id));
        out
    }

    /// Where a workspace tile goes: the page last visited in it, else its
    /// chat.
    pub fn workspace_target(&self, id: &str) -> Route {
        Route::page(
            id,
            self.last_page
                .get(id)
                .cloned()
                .unwrap_or(WorkspacePage::Chat { session: None }),
        )
    }

    /// A workspace tile click.
    pub fn select_workspace(&mut self, id: &str) -> Vec<Effect> {
        if !route::Workspaces::exists(self, id) {
            return Vec::new();
        }
        let target = self.workspace_target(id);
        self.navigate(target)
    }

    /// ⌘⇧] / ⌘⇧[: the next / previous workspace in the rail, wrapping.
    pub fn cycle_workspace(&mut self, forward: bool) -> Vec<Effect> {
        let len = self.workspaces.len() as isize;
        if len == 0 {
            return Vec::new();
        }
        let active = route::Workspaces::active(self);
        let cur = self
            .workspaces
            .iter()
            .position(|w| Some(&w.id) == active.as_ref())
            .map_or(-1, |i| i as isize);
        let dir = if forward { 1 } else { -1 };
        let target = self.workspaces[(cur + dir + len).rem_euclid(len) as usize]
            .id
            .clone();
        if Some(&target) == active.as_ref() {
            return Vec::new();
        }
        self.select_workspace(&target)
    }

    /// ⌘⌥1 … ⌘⌥9: the workspace at that place in the rail, if another.
    pub fn go_workspace(&mut self, n: usize) -> Vec<Effect> {
        let Some(target) = n
            .checked_sub(1)
            .and_then(|i| self.workspaces.get(i))
            .map(|w| w.id.clone())
        else {
            return Vec::new();
        };
        if route::Workspaces::active(self).as_deref() == Some(target.as_str()) {
            return Vec::new();
        }
        self.select_workspace(&target)
    }

    /// A nav tile or its ⌘⌥ shortcut: the page under the active workspace,
    /// when the tile is on the rail.
    pub fn nav(&mut self, action_id: &str) -> Vec<Effect> {
        let Some(ws) = self.active_workspace().map(|w| w.id.clone()) else {
            return Vec::new();
        };
        let Some(item) = self
            .nav_items()
            .into_iter()
            .find(|it| it.action_id == action_id)
        else {
            return Vec::new();
        };
        self.navigate(Route::page(&ws, item.page))
    }

    /// ⌘. on the chat: off → focus → zen.
    pub fn cycle_focus(&mut self) {
        if self.on_chat() {
            self.focus = self.focus.next();
        }
    }

    /// Sets focus mode (the status line's toggle).
    pub fn set_focus(&mut self, level: FocusLevel) {
        self.focus = level;
    }

    // ---- tabs -------------------------------------------------------------

    /// Runs a strip change on the chat's workspace and persists it. Off the
    /// chat there is no strip, so the tab shortcuts do nothing.
    fn on_strip(&mut self, f: impl FnOnce(&mut TabStrip)) -> Vec<Effect> {
        if !self.on_chat() {
            return Vec::new();
        }
        let Some(ws) = self.route().workspace().map(str::to_owned) else {
            return Vec::new();
        };
        let Some(d) = self.data.get_mut(&ws) else {
            return Vec::new();
        };
        if !d.loaded {
            return Vec::new();
        }
        let before = d.strip.clone();
        f(&mut d.strip);
        if d.strip == before {
            return Vec::new();
        }
        self.persist(&ws)
    }

    pub fn select_tab(&mut self, id: &str) -> Vec<Effect> {
        self.on_strip(|s| s.select(id))
    }

    pub fn close_tab(&mut self, id: &str) -> Vec<Effect> {
        self.on_strip(|s| s.close(id))
    }

    pub fn close_active_tab(&mut self) -> Vec<Effect> {
        self.on_strip(TabStrip::close_active)
    }

    pub fn reopen_tab(&mut self) -> Vec<Effect> {
        self.on_strip(TabStrip::reopen)
    }

    pub fn toggle_pin(&mut self, id: &str) -> Vec<Effect> {
        self.on_strip(|s| s.toggle_pin(id))
    }

    pub fn reorder_tab(&mut self, from: usize, to: usize) -> Vec<Effect> {
        self.on_strip(|s| s.reorder(from, to))
    }

    pub fn cycle_tab(&mut self, forward: bool) -> Vec<Effect> {
        self.on_strip(|s| s.cycle(forward))
    }

    pub fn go_tab(&mut self, n: usize) -> Vec<Effect> {
        self.on_strip(|s| s.go_to(n))
    }

    pub fn last_tab(&mut self) -> Vec<Effect> {
        self.on_strip(TabStrip::go_to_last)
    }

    pub fn select_tab_by_number(&mut self, n: usize) -> Vec<Effect> {
        self.on_strip(|s| s.select_by_number(n))
    }

    /// `+` / ⌘T on the chat: a new session.
    pub fn new_tab(&mut self) -> Vec<Effect> {
        match self.route() {
            Route::Workspace {
                id,
                page: WorkspacePage::Chat { .. },
            } if self.is_loaded(id) => vec![Effect::CreateSession(id.clone())],
            _ => Vec::new(),
        }
    }

    /// "Close all tabs": asks first (`confirm()`), naming what stays.
    pub fn close_all_tabs(&mut self) -> Vec<Effect> {
        if !self.on_chat() {
            return Vec::new();
        }
        let Some(ws) = self.route().workspace().map(str::to_owned) else {
            return Vec::new();
        };
        let Some(strip) = self.strip(&ws) else {
            return Vec::new();
        };
        let closable = strip.closable().len();
        if closable == 0 {
            return Vec::new();
        }
        let kept = strip.tabs().len() - closable;
        let s = |n: usize| if n == 1 { "" } else { "s" };
        let message = if kept > 0 {
            format!(
                "Close {closable} unpinned tab{}? {kept} pinned tab{} and sessions on disk remain.",
                s(closable),
                s(kept)
            )
        } else {
            format!("Close all {closable} tabs? Sessions remain on disk.")
        };
        vec![Effect::ConfirmCloseAll {
            workspace: ws,
            message,
        }]
    }

    /// The confirm said yes.
    pub fn close_all_confirmed(&mut self, workspace: &str) -> Vec<Effect> {
        let Some(d) = self.data.get_mut(workspace) else {
            return Vec::new();
        };
        d.strip.close_all();
        self.persist(workspace)
    }

    /// The labels' width after a resize drag: `PUT {labelMaxWidth}`.
    pub fn set_label_width(&mut self, width: f64) -> Vec<Effect> {
        let Some(ws) = self.route().workspace().map(str::to_owned) else {
            return Vec::new();
        };
        let Some(d) = self.data.get_mut(&ws) else {
            return Vec::new();
        };
        let w = d.strip.set_label_max_width(width);
        vec![Effect::PersistTabs(
            ws,
            crate::data::OpenTabsPut {
                label_max_width: Some(w),
                ..Default::default()
            },
        )]
    }
}
