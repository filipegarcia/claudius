//! The window's root view: [`ShellState`] on screen, its actions bound to
//! the shortcuts, its [`Effect`]s run against the [`ShellData`].

use std::collections::HashMap;
use std::sync::Arc;

use claudius_chat::fixture::FixtureTranscripts;
use claudius_chat::{TranscriptSource, TranscriptView};
use claudius_gpui_theme::ThemeName;
use futures::StreamExt as _;
use gpui_kit::{
    App, AppContext as _, Context, Entity, FocusHandle, InteractiveElement as _, IntoElement,
    ParentElement as _, Render, Styled as _, Task, Window, WindowAppearance, div,
};

use crate::data::{ShellChange, ShellData};
use crate::nav::FocusLevel;
use crate::route::Route;
use crate::shortcuts::{self, *};
use crate::state::{Effect, ShellState};

/// Light and dark: the system's, or a palette the user picked.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Appearance {
    /// `light` or `dark` as the window's appearance says.
    System,
    Fixed(ThemeName),
}

impl Appearance {
    /// `CLAUDIUS_APP_THEME`: `system`, or a `data-theme` id (`dark`,
    /// `paper`, …).
    pub fn parse(s: &str) -> Option<Appearance> {
        if s == "system" {
            return Some(Appearance::System);
        }
        ThemeName::from_id(s).map(Appearance::Fixed)
    }

    /// The palette for a window appearance.
    pub fn theme(self, window: WindowAppearance) -> ThemeName {
        match self {
            Appearance::Fixed(name) => name,
            Appearance::System => match window {
                WindowAppearance::Dark | WindowAppearance::VibrantDark => ThemeName::Dark,
                WindowAppearance::Light | WindowAppearance::VibrantLight => ThemeName::Light,
            },
        }
    }

    /// The title bar toggle: system → light → dark → system.
    pub fn next(self) -> Appearance {
        match self {
            Appearance::System => Appearance::Fixed(ThemeName::Light),
            Appearance::Fixed(ThemeName::Light) => Appearance::Fixed(ThemeName::Dark),
            Appearance::Fixed(_) => Appearance::System,
        }
    }

    pub fn label(self) -> &'static str {
        match self {
            Appearance::System => "System appearance",
            Appearance::Fixed(name) => name.label(),
        }
    }
}

/// The "Close all tabs" question on screen.
#[derive(Clone, Debug, PartialEq)]
pub struct Confirm {
    pub workspace: String,
    pub message: String,
}

/// Transcript views kept for recently shown tabs (each keeps its scroll
/// position and parsed markdown while you switch away and back).
const KEPT_CHAT_VIEWS: usize = 8;

pub struct Shell {
    pub(crate) state: ShellState,
    pub(crate) data: Arc<dyn ShellData>,
    /// The chat transcripts' states (U05; U04b's live transport).
    transcripts: Arc<dyn TranscriptSource>,
    /// One view per recently shown tab, most recent last.
    chat_views: Vec<(String, Entity<TranscriptView>)>,
    pub(crate) focus: FocusHandle,
    pub(crate) appearance: Appearance,
    pub(crate) theme: ThemeName,
    pub(crate) overflow_open: bool,
    pub(crate) confirm: Option<Confirm>,
    /// Each tab's last measured width, px (kept while it's hidden).
    pub(crate) tab_widths: HashMap<String, f32>,
    pub(crate) strip_width: f32,
    pub(crate) hidden: Vec<String>,
    pub(crate) now_year: i32,
    /// The sessions browser (U11), when [`Shell::with_sessions`] added it.
    pub(crate) sessions: Option<gpui_kit::Entity<crate::sessions::view::SessionsScreen>>,
    _tasks: Vec<Task<()>>,
    _appearance: gpui_kit::Subscription,
}

impl Shell {
    /// The shell with no transcripts: every session shows the splash.
    pub fn new(
        data: Arc<dyn ShellData>,
        appearance: Appearance,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Self {
        Self::with_transcripts(
            data,
            Arc::new(FixtureTranscripts::new()),
            appearance,
            window,
            cx,
        )
    }

    /// The shell over a data source and the transcripts' source.
    pub fn with_transcripts(
        data: Arc<dyn ShellData>,
        transcripts: Arc<dyn TranscriptSource>,
        appearance: Appearance,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Self {
        let focus = cx.focus_handle();
        window.focus(&focus, cx);
        let mut changes = data.subscribe();
        let listen = cx.spawn(async move |this, cx| {
            while let Some(change) = changes.next().await {
                if this
                    .update(cx, |this, cx| this.on_change(change, cx))
                    .is_err()
                {
                    break;
                }
            }
        });
        let observe = cx.observe_window_appearance(window, |this: &mut Shell, window, cx| {
            this.apply_theme(window, cx);
        });
        let theme = appearance.theme(window.appearance());
        claudius_gpui_theme::apply(theme, cx);
        let mut shell = Shell {
            state: ShellState::new(),
            data,
            transcripts,
            chat_views: Vec::new(),
            focus,
            appearance,
            theme,
            overflow_open: false,
            confirm: None,
            tab_widths: HashMap::new(),
            strip_width: 0.,
            hidden: Vec::new(),
            now_year: crate::tabs::current_year(),
            sessions: None,
            _tasks: vec![listen],
            _appearance: observe,
        };
        shell.load_workspaces(cx);
        shell
    }

    /// The chat route's bound session: the active tab of the active
    /// workspace, when the route is the chat.
    pub fn chat_tab(&self) -> Option<String> {
        let state = &self.state;
        if !matches!(
            state.route(),
            Route::Workspace {
                page: crate::route::WorkspacePage::Chat { .. },
                ..
            }
        ) {
            return None;
        }
        let ws = state.active_workspace()?;
        let bound = self.data.active_session_state(&ws.id);
        let views = state.tab_views(bound, self.now_year);
        views.into_iter().find(|t| t.active).map(|t| t.id)
    }

    /// The transcript view of a tab, when it was shown recently.
    pub fn chat_view(&self, tab_id: &str) -> Option<Entity<TranscriptView>> {
        self.chat_views
            .iter()
            .find(|(id, _)| id == tab_id)
            .map(|(_, v)| v.clone())
    }

    /// Makes the bound tab's transcript view (and keeps the recent ones).
    fn sync_chat_view(&mut self, cx: &mut Context<Self>) {
        let Some(tab) = self.chat_tab() else { return };
        let theme = self.theme;
        if let Some(i) = self.chat_views.iter().position(|(id, _)| *id == tab) {
            let entry = self.chat_views.remove(i);
            entry.1.update(cx, |v, cx| v.set_theme(theme, cx));
            self.chat_views.push(entry);
            return;
        }
        let source = self.transcripts.clone();
        let id = tab.clone();
        let view = cx.new(|cx| TranscriptView::new(source, id, theme, cx));
        self.chat_views.push((tab, view));
        if self.chat_views.len() > KEPT_CHAT_VIEWS {
            self.chat_views.remove(0);
        }
    }

    /// The state, for tests and the screens.
    pub fn state(&self) -> &ShellState {
        &self.state
    }

    pub fn appearance(&self) -> Appearance {
        self.appearance
    }

    pub fn theme(&self) -> ThemeName {
        self.theme
    }

    pub fn confirm(&self) -> Option<&Confirm> {
        self.confirm.as_ref()
    }

    pub fn overflow_open(&self) -> bool {
        self.overflow_open
    }

    /// The tabs the strip hides behind its overflow menu.
    pub fn hidden_tabs(&self) -> &[String] {
        &self.hidden
    }

    /// Opens a URL as a link would (the redirect rules apply).
    pub fn open_url(&mut self, url: &str, cx: &mut Context<Self>) {
        let effects = self.state.open_url(url);
        self.run(effects, cx);
    }

    /// Goes to a page.
    pub fn navigate(&mut self, route: Route, cx: &mut Context<Self>) {
        let effects = self.state.navigate(route);
        self.run(effects, cx);
    }

    /// Opens or closes the hidden tabs' menu.
    pub fn toggle_overflow(&mut self, cx: &mut Context<Self>) {
        self.overflow_open = !self.overflow_open;
        cx.notify();
    }

    /// Changes the state, then runs the effects it asked for (and closes
    /// the overflow menu, as any click outside it does).
    pub fn update_state(
        &mut self,
        cx: &mut Context<Self>,
        f: impl FnOnce(&mut ShellState) -> Vec<Effect>,
    ) {
        let effects = f(&mut self.state);
        self.overflow_open = false;
        self.run(effects, cx);
    }

    fn load_workspaces(&mut self, cx: &mut Context<Self>) {
        let fut = self.data.workspaces();
        cx.spawn(async move |this, cx| {
            let list = fut.await.unwrap_or_default();
            this.update(cx, |this, cx| {
                let effects = this.state.workspaces_loaded(list);
                this.run(effects, cx);
            })
            .ok();
        })
        .detach();
    }

    fn load_sessions(&mut self, workspace: String, cx: &mut Context<Self>) {
        let fut = self.data.sessions(&workspace);
        cx.spawn(async move |this, cx| {
            if let Ok(rows) = fut.await {
                this.update(cx, |this, cx| {
                    this.state.sessions_loaded(&workspace, rows);
                    cx.notify();
                })
                .ok();
            }
        })
        .detach();
    }

    fn on_change(&mut self, change: ShellChange, cx: &mut Context<Self>) {
        match change {
            ShellChange::Workspaces => self.load_workspaces(cx),
            ShellChange::Sessions { workspace_id } => self.load_sessions(workspace_id, cx),
            // The shell writes the strip; the chat doesn't re-read it either.
            ShellChange::OpenTabs { .. } => {}
        }
    }

    /// Runs what the state asked for.
    pub(crate) fn run(&mut self, effects: Vec<Effect>, cx: &mut Context<Self>) {
        for effect in effects {
            match effect {
                Effect::SelectWorkspace(id) => {
                    let fut = self.data.select_workspace(&id);
                    cx.background_spawn(async move {
                        let _ = fut.await;
                    })
                    .detach();
                }
                Effect::LoadWorkspace(id) => {
                    let tabs = self.data.open_tabs(&id);
                    let sessions = self.data.sessions(&id);
                    cx.spawn(async move |this, cx| {
                        let (tabs, sessions) = futures::join!(tabs, sessions);
                        // A failed read hydrates with nothing, as the chat's
                        // `catch` does.
                        let tabs = tabs.unwrap_or_default();
                        let sessions = sessions.unwrap_or_default();
                        this.update(cx, |this, cx| {
                            let effects = this.state.workspace_loaded(&id, tabs, sessions);
                            this.run(effects, cx);
                        })
                        .ok();
                    })
                    .detach();
                }
                Effect::LoadSessions(id) => self.load_sessions(id, cx),
                Effect::PersistTabs(id, body) => {
                    let fut = self.data.put_open_tabs(&id, body);
                    cx.background_spawn(async move {
                        let _ = fut.await;
                    })
                    .detach();
                }
                Effect::CreateSession(id) => {
                    let fut = self.data.create_session(&id);
                    cx.spawn(async move |this, cx| {
                        if let Ok(session) = fut.await {
                            this.update(cx, |this, cx| {
                                let effects = this.state.session_created(&id, &session);
                                this.run(effects, cx);
                            })
                            .ok();
                        }
                    })
                    .detach();
                }
                Effect::ConfirmCloseAll { workspace, message } => {
                    self.confirm = Some(Confirm { workspace, message });
                }
            }
        }
        crate::sessions::view::sync(self, cx);
        cx.notify();
    }

    /// The confirm's answer.
    pub fn answer_confirm(&mut self, yes: bool, cx: &mut Context<Self>) {
        if let Some(c) = self.confirm.take()
            && yes
        {
            let effects = self.state.close_all_confirmed(&c.workspace);
            self.run(effects, cx);
        }
        cx.notify();
    }

    /// Re-picks the palette (the appearance setting or the system's
    /// changed).
    pub(crate) fn apply_theme(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let theme = self.appearance.theme(window.appearance());
        if theme != self.theme {
            self.theme = theme;
            claudius_gpui_theme::apply(theme, cx);
        }
        cx.notify();
    }

    pub fn set_appearance(
        &mut self,
        appearance: Appearance,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.appearance = appearance;
        self.apply_theme(window, cx);
    }

    /// The strip measured its tabs: re-fit them.
    pub(crate) fn measured(
        &mut self,
        strip_width: Option<f32>,
        widths: Vec<(String, f32)>,
        cx: &mut Context<Self>,
    ) {
        let mut changed = false;
        if let Some(w) = strip_width
            && (w - self.strip_width).abs() > 0.5
        {
            self.strip_width = w;
            changed = true;
        }
        for (id, w) in widths {
            if w > 0.
                && self
                    .tab_widths
                    .get(&id)
                    .is_none_or(|old| (old - w).abs() > 0.5)
            {
                self.tab_widths.insert(id, w);
                changed = true;
            }
        }
        if changed && self.refit() {
            cx.notify();
        }
    }

    /// Recomputes the hidden tabs; whether they changed.
    pub(crate) fn refit(&mut self) -> bool {
        let (tabs, active) = match self.state.active_workspace() {
            Some(ws) => match self.state.strip(&ws.id) {
                Some(s) => (s.tabs().to_vec(), s.active().map(str::to_owned)),
                None => (Vec::new(), None),
            },
            None => (Vec::new(), None),
        };
        let hidden = crate::tabs::hidden_tabs(
            &tabs,
            |id| self.tab_widths.get(id).copied(),
            self.strip_width,
            active.as_deref(),
        );
        if hidden != self.hidden {
            self.hidden = hidden;
            true
        } else {
            false
        }
    }

    fn act(&mut self, cx: &mut Context<Self>, f: impl FnOnce(&mut ShellState) -> Vec<Effect>) {
        self.update_state(cx, f);
    }
}

/// Every shortcut's action handler on the shell's root element.
pub(crate) fn on_actions(
    el: gpui_kit::Div,
    cx: &mut Context<Shell>,
) -> gpui_kit::Stateful<gpui_kit::Div> {
    macro_rules! on {
        ($el:expr, $action:ty, |$this:ident, $cx:ident| $body:expr) => {
            $el.on_action(cx.listener(|$this: &mut Shell, _: &$action, _, $cx| $body))
        };
    }
    let el = el.key_context(shortcuts::CONTEXT);
    let el = on!(el, NextTab, |this, cx| this.act(cx, |s| s.cycle_tab(true)));
    let el = on!(el, PrevTab, |this, cx| this.act(cx, |s| s.cycle_tab(false)));
    let el = on!(el, NewTab, |this, cx| this.act(cx, ShellState::new_tab));
    let el = on!(el, CloseTab, |this, cx| this
        .act(cx, ShellState::close_active_tab));
    let el = on!(el, ReopenTab, |this, cx| this
        .act(cx, ShellState::reopen_tab));
    let el = on!(el, LastTab, |this, cx| this.act(cx, ShellState::last_tab));
    let el = on!(el, GoTab1, |this, cx| this.act(cx, |s| s.go_tab(1)));
    let el = on!(el, GoTab2, |this, cx| this.act(cx, |s| s.go_tab(2)));
    let el = on!(el, GoTab3, |this, cx| this.act(cx, |s| s.go_tab(3)));
    let el = on!(el, GoTab4, |this, cx| this.act(cx, |s| s.go_tab(4)));
    let el = on!(el, GoTab5, |this, cx| this.act(cx, |s| s.go_tab(5)));
    let el = on!(el, GoTab6, |this, cx| this.act(cx, |s| s.go_tab(6)));
    let el = on!(el, GoTab7, |this, cx| this.act(cx, |s| s.go_tab(7)));
    let el = on!(el, GoTab8, |this, cx| this.act(cx, |s| s.go_tab(8)));
    let el = on!(el, SelectTab1, |this, cx| this
        .act(cx, |s| s.select_tab_by_number(1)));
    let el = on!(el, SelectTab2, |this, cx| this
        .act(cx, |s| s.select_tab_by_number(2)));
    let el = on!(el, SelectTab3, |this, cx| this
        .act(cx, |s| s.select_tab_by_number(3)));
    let el = on!(el, SelectTab4, |this, cx| this
        .act(cx, |s| s.select_tab_by_number(4)));
    let el = on!(el, SelectTab5, |this, cx| this
        .act(cx, |s| s.select_tab_by_number(5)));
    let el = on!(el, SelectTab6, |this, cx| this
        .act(cx, |s| s.select_tab_by_number(6)));
    let el = on!(el, SelectTab7, |this, cx| this
        .act(cx, |s| s.select_tab_by_number(7)));
    let el = on!(el, SelectTab8, |this, cx| this
        .act(cx, |s| s.select_tab_by_number(8)));
    let el = on!(el, SelectTab9, |this, cx| this
        .act(cx, |s| s.select_tab_by_number(9)));
    let el = on!(el, NextWorkspace, |this, cx| this
        .act(cx, |s| s.cycle_workspace(true)));
    let el = on!(el, PrevWorkspace, |this, cx| this
        .act(cx, |s| s.cycle_workspace(false)));
    let el = on!(el, GoWorkspace1, |this, cx| this
        .act(cx, |s| s.go_workspace(1)));
    let el = on!(el, GoWorkspace2, |this, cx| this
        .act(cx, |s| s.go_workspace(2)));
    let el = on!(el, GoWorkspace3, |this, cx| this
        .act(cx, |s| s.go_workspace(3)));
    let el = on!(el, GoWorkspace4, |this, cx| this
        .act(cx, |s| s.go_workspace(4)));
    let el = on!(el, GoWorkspace5, |this, cx| this
        .act(cx, |s| s.go_workspace(5)));
    let el = on!(el, GoWorkspace6, |this, cx| this
        .act(cx, |s| s.go_workspace(6)));
    let el = on!(el, GoWorkspace7, |this, cx| this
        .act(cx, |s| s.go_workspace(7)));
    let el = on!(el, GoWorkspace8, |this, cx| this
        .act(cx, |s| s.go_workspace(8)));
    let el = on!(el, GoWorkspace9, |this, cx| this
        .act(cx, |s| s.go_workspace(9)));
    let el = on!(el, NavChat, |this, cx| this.act(cx, |s| s.nav("nav.chat")));
    let el = on!(el, NavGit, |this, cx| this.act(cx, |s| s.nav("nav.git")));
    let el = on!(el, NavSessions, |this, cx| this
        .act(cx, |s| s.nav("nav.sessions")));
    let el = on!(el, NavFiles, |this, cx| this
        .act(cx, |s| s.nav("nav.files")));
    let el = on!(el, NavMemory, |this, cx| this
        .act(cx, |s| s.nav("nav.memory")));
    let el = on!(el, NavAssets, |this, cx| this
        .act(cx, |s| s.nav("nav.assets")));
    let el = on!(el, NavCost, |this, cx| this.act(cx, |s| s.nav("nav.cost")));
    let el = on!(el, NavAgents, |this, cx| this
        .act(cx, |s| s.nav("nav.agents")));
    let el = on!(el, NavSkills, |this, cx| this
        .act(cx, |s| s.nav("nav.skills")));
    let el = on!(el, NavMcp, |this, cx| this.act(cx, |s| s.nav("nav.mcp")));
    let el = on!(el, NavHooks, |this, cx| this
        .act(cx, |s| s.nav("nav.hooks")));
    let el = on!(el, NavSchedule, |this, cx| this
        .act(cx, |s| s.nav("nav.schedule")));
    let el = on!(el, NavPermissions, |this, cx| this
        .act(cx, |s| s.nav("nav.permissions")));
    let el = on!(el, NavDocker, |this, cx| this
        .act(cx, |s| s.nav("nav.docker")));
    let el = on!(el, NavTracker, |this, cx| this
        .act(cx, |s| s.nav("nav.tracker")));
    let el = on!(el, NavDatabase, |this, cx| this
        .act(cx, |s| s.nav("nav.database")));
    let el = on!(el, NavNotebooks, |this, cx| this
        .act(cx, |s| s.nav("nav.notebooks")));
    let el = on!(el, NavWorkspace, |this, cx| this
        .act(cx, |s| s.nav("nav.workspace")));
    let el = on!(el, OpenSettings, |this, cx| this
        .act(cx, |s| s.navigate(Route::Settings)));
    let el = on!(el, GoBack, |this, cx| this.act(cx, ShellState::back));
    let el = on!(el, GoForward, |this, cx| this.act(cx, ShellState::forward));
    let el = on!(el, CycleFocus, |this, cx| {
        this.state.cycle_focus();
        cx.notify();
    });
    el.on_action(
        cx.listener(|this: &mut Shell, _: &CycleAppearance, window, cx| {
            let next = this.appearance.next();
            this.set_appearance(next, window, cx);
        }),
    )
    .id("claudius-shell")
}

impl Render for Shell {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        self.refit();
        self.sync_chat_view(cx);
        let root = div().track_focus(&self.focus).size_full();
        on_actions(root, cx).child(crate::ui::shell(self, window, cx))
    }
}

/// The level the chat's rails are at (for the screens).
pub fn focus_label(level: FocusLevel) -> &'static str {
    match level {
        FocusLevel::Off => "Off",
        FocusLevel::Focus => "Focus",
        FocusLevel::Zen => "Zen",
    }
}

/// Opens the main window over a data source, the transcripts' source and
/// the sessions browser's.
pub fn open_main_window(
    data: Arc<dyn ShellData>,
    transcripts: Arc<dyn TranscriptSource>,
    sessions: Arc<dyn crate::sessions::data::SessionsData>,
    appearance: Appearance,
    cx: &mut App,
) -> anyhow::Result<gpui_kit::Entity<Shell>> {
    use gpui_kit::{Bounds, TitlebarOptions, WindowBounds, WindowOptions, point, px, size};
    let options = WindowOptions {
        window_bounds: Some(WindowBounds::Windowed(Bounds::centered(
            None,
            size(px(1280.), px(820.)),
            cx,
        ))),
        titlebar: Some(TitlebarOptions {
            title: Some("Claudius".into()),
            appears_transparent: true,
            traffic_light_position: Some(point(px(12.), px(10.))),
        }),
        ..Default::default()
    };
    let (_, shell) = gpui_kit::open_window(options, cx, move |window, cx| {
        cx.new(|cx| {
            Shell::with_transcripts(data, transcripts, appearance, window, cx)
                .with_sessions(sessions, window, cx)
        })
    })?;
    Ok(shell)
}
