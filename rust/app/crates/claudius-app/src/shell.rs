//! The window's root view: [`ShellState`] on screen, its actions bound to
//! the shortcuts, its [`Effect`]s run against the [`ShellData`].
//!
//! **The live chat (U04b).** Over a data source with an engine behind it
//! ([`ShellData::open_chat`]), the chat route mounts one [`LiveChat`] for
//! its workspace, as `ChatSurface` mounts `useSession` once per page: at
//! the page's URL when the chat comes on screen, unmounted when the route
//! leaves it. The strip and the chat follow each other: a tab the user
//! picks (or a close that moves the strip) is the chat's `switchSession`,
//! and a session the chat binds (its boot, "+", a switch) joins the strip
//! ([`ShellState::chat_bound`]). A snapshot older than the shell's last
//! switch is not followed back ([`ChatSync`]). The bound tab's dot reads the chat's state
//! (`activeTabStatus`); the chat's `?session=` writer replaces the route's
//! URL, and a page load it asks for remounts it there.
//!
//! The window coming to the front re-reads the workspaces and the
//! customizations (`useWorkspaces`' focus refetch); its visibility is the
//! chat's `document.hidden`. Focus mode and the route memory persist in
//! the [`LocalStore`].

use std::collections::HashMap;
use std::sync::Arc;

use claudius_chat::fixture::FixtureTranscripts;
use claudius_chat::{TranscriptSource, TranscriptView};
use claudius_client::effect::Effect as ChatEffect;
use claudius_composer::{ComposerTarget, ComposerView};
use claudius_gpui_theme::ThemeName;
use claudius_prompts::{ChatPrompts, PromptSource};
use futures::StreamExt as _;
use gpui_kit::{
    App, AppContext as _, Context, Entity, FocusHandle, Image, ImageFormat,
    InteractiveElement as _, IntoElement, KeyDownEvent, ParentElement as _, Render, Styled as _,
    Task, Window, WindowAppearance, WindowVisibility, div,
};

use crate::chat::{ChatPage, ChatSync, LiveChat, bound_tab_state};
use crate::data::{ActiveSessionState, ShellChange, ShellData, WorkspaceIcon};
use crate::nav::FocusLevel;
use crate::rail::LiveRail;
use crate::route::{Route, WorkspacePage};
use crate::shortcuts::{self, *};
use crate::state::{Effect, ShellState};
use crate::status::LiveStatus;
use crate::store::LocalStore;
use crate::targets::{LiveComposer, LivePromptSource};
use crate::transcripts::LiveTranscripts;

/// The origin the chat's page URL is on (`window.location.origin`).
pub const PAGE_ORIGIN: &str = claudius_transport::in_process::IN_PROCESS_ORIGIN;

/// The mounted chat of the workspace on screen.
pub(crate) struct ChatSlot {
    pub(crate) workspace: String,
    pub(crate) chat: LiveChat,
    sync: ChatSync,
    _task: Task<()>,
}

/// A workspace's uploaded icon: which upload, and its image once read.
struct IconEntry {
    key: String,
    image: Option<Arc<Image>>,
}

/// The image format for an icon's `Content-Type` (the route's
/// `mimeFor`), else for its extension.
pub fn icon_format(content_type: &str, ext: &str) -> Option<ImageFormat> {
    let mime = content_type
        .split(';')
        .next()
        .unwrap_or_default()
        .trim()
        .to_ascii_lowercase();
    let by_mime = match mime.as_str() {
        "image/png" => Some(ImageFormat::Png),
        "image/jpeg" | "image/jpg" => Some(ImageFormat::Jpeg),
        "image/webp" => Some(ImageFormat::Webp),
        "image/gif" => Some(ImageFormat::Gif),
        "image/svg+xml" => Some(ImageFormat::Svg),
        _ => None,
    };
    by_mime.or_else(|| match ext.to_ascii_lowercase().as_str() {
        "png" => Some(ImageFormat::Png),
        "jpg" | "jpeg" => Some(ImageFormat::Jpeg),
        "webp" => Some(ImageFormat::Webp),
        "gif" => Some(ImageFormat::Gif),
        "svg" => Some(ImageFormat::Svg),
        _ => None,
    })
}

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
    pub(crate) transcripts: Arc<dyn TranscriptSource>,
    /// Over a live chat, the mounted chat's transcripts (U04h); then
    /// `transcripts` is this.
    live_transcripts: Option<LiveTranscripts>,
    /// Over a live chat, the composer's target (U07e): the mounted chat.
    live_composer: Option<Arc<LiveComposer>>,
    /// One view per recently shown tab, most recent last.
    chat_views: Vec<(String, Entity<TranscriptView>)>,
    /// What the transcripts' cards read from their host (U06a).
    pub(crate) cards: crate::card_host::CardHost,
    /// Over a live chat, the mounted chat for the status line (U09a), and
    /// its view once the chat route showed it.
    live_status: Option<LiveStatus>,
    status_view: Option<Entity<claudius_status::StatusLineView>>,
    /// Over a live chat, the rail's and the goal banner's target (U09b),
    /// and their views, made with the status line's.
    live_rail: Option<Arc<LiveRail>>,
    rail_view: Option<Entity<claudius_panels::RailPanel>>,
    goal_view: Option<Entity<claudius_panels::GoalBannerView>>,
    _rail_subs: Vec<gpui_kit::Subscription>,
    /// The chat route's composer (U07), once a target is set: one view,
    /// bound to whichever tab is shown.
    composer_target: Option<Arc<dyn ComposerTarget>>,
    composer: Option<Entity<ComposerView>>,
    /// The chats' prompt cards (U08a), when a source is set.
    prompt_source: Option<Arc<dyn PromptSource>>,
    prompts: Vec<(String, ChatPrompts)>,
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
    /// The Git page (U12a), when [`Shell::set_git_data`] added it.
    pub(crate) git: Option<Entity<claudius_git::view::GitScreen>>,
    /// The Files page (U12c), once [`Shell::set_files_data`] gave it data.
    pub(crate) files: crate::files::FilesSlot,
    /// The open overlay (U10a): the palette, the cheatsheet or the help.
    pub(crate) overlay: crate::overlays::OverlaySlot,
    pub(crate) chat: Option<ChatSlot>,
    icons: HashMap<String, IconEntry>,
    pub(crate) store: LocalStore,
    window_hidden: bool,
    _tasks: Vec<Task<()>>,
    _subscriptions: Vec<gpui_kit::Subscription>,
}

impl Shell {
    /// The shell with no transcripts: every session shows the splash.
    pub fn new(
        data: Arc<dyn ShellData>,
        appearance: Appearance,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Self {
        Self::with_parts(
            data,
            Arc::new(FixtureTranscripts::new()),
            appearance,
            LocalStore::in_memory(),
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
        Self::with_parts(
            data,
            transcripts,
            appearance,
            LocalStore::in_memory(),
            window,
            cx,
        )
    }

    /// The shell with its `localStorage` (focus mode, route memory).
    pub fn with_store(
        data: Arc<dyn ShellData>,
        appearance: Appearance,
        store: LocalStore,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Self {
        Self::with_parts(
            data,
            Arc::new(FixtureTranscripts::new()),
            appearance,
            store,
            window,
            cx,
        )
    }

    /// The shell over a data source, the transcripts' source and its
    /// `localStorage`.
    pub fn with_parts(
        data: Arc<dyn ShellData>,
        transcripts: Arc<dyn TranscriptSource>,
        appearance: Appearance,
        store: LocalStore,
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
        let activation = cx.observe_window_activation(window, |this: &mut Shell, window, cx| {
            if window.is_window_active() {
                this.load_workspaces(cx);
                this.load_customizations(cx);
            }
        });
        let visibility =
            cx.observe_window_visibility(window, |this: &mut Shell, v, _window, cx| {
                this.set_window_hidden(v == WindowVisibility::Hidden, cx);
            });
        let theme = appearance.theme(window.appearance());
        claudius_gpui_theme::apply(theme, cx);
        let mut state = ShellState::new();
        state.set_live_chat(data.has_live_chat());
        // Over a live chat, the transcripts are the mounted chat's (U04h).
        let live_transcripts = data.has_live_chat().then(LiveTranscripts::new);
        let live_status = data.has_live_chat().then(LiveStatus::new);
        let transcripts = match &live_transcripts {
            Some(l) => Arc::new(l.clone()) as Arc<dyn TranscriptSource>,
            None => transcripts,
        };
        // And so are the composer's target (U07e) and the prompt cards'
        // (U08c).
        let live_composer = live_transcripts
            .clone()
            .map(|l| Arc::new(LiveComposer::new(l)));
        let live_rail = live_status
            .clone()
            .map(|s| Arc::new(LiveRail::new(s, live_composer.clone())));
        let live_prompts = live_transcripts
            .clone()
            .map(|l| Arc::new(LivePromptSource::new(l)) as Arc<dyn PromptSource>);
        state.set_focus(store.focus());
        for (id, page) in store.remembered_pages() {
            state.remember_page(&id, page);
        }
        let mut shell = Shell {
            state,
            data,
            transcripts,
            live_transcripts,
            composer_target: live_composer.clone().map(|c| c as Arc<dyn ComposerTarget>),
            live_composer,
            chat_views: Vec::new(),
            cards: Default::default(),
            live_status,
            status_view: None,
            live_rail,
            rail_view: None,
            goal_view: None,
            _rail_subs: Vec::new(),
            composer: None,
            prompt_source: live_prompts,
            prompts: Vec::new(),
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
            git: None,
            files: Default::default(),
            overlay: Default::default(),
            chat: None,
            icons: HashMap::new(),
            store,
            window_hidden: false,
            _tasks: vec![listen],
            _subscriptions: vec![observe, activation, visibility],
        };
        shell.load_workspaces(cx);
        shell.load_customizations(cx);
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

    /// Whether the transcripts' source holds the session (else the chat
    /// route shows the live chat's state).
    pub fn has_transcript(&self, session_id: &str) -> bool {
        self.transcripts.read(session_id, &mut |_| {})
    }

    /// The transcript view of a tab, when it was shown recently.
    pub fn chat_view(&self, tab_id: &str) -> Option<Entity<TranscriptView>> {
        self.chat_views
            .iter()
            .find(|(id, _)| id == tab_id)
            .map(|(_, v)| v.clone())
    }

    /// Shows each chat's prompt cards from `source` (U04b's live chats).
    pub fn set_prompt_source(&mut self, source: Arc<dyn PromptSource>, cx: &mut Context<Self>) {
        self.prompt_source = Some(source);
        self.prompts.clear();
        cx.notify();
    }

    /// The prompt cards of a tab, when it was shown recently.
    pub fn chat_prompts(&self, tab_id: &str) -> Option<ChatPrompts> {
        self.prompts
            .iter()
            .find(|(id, _)| id == tab_id)
            .map(|(_, p)| p.clone())
    }

    /// Makes the bound tab's prompt cards (and keeps the recent ones).
    fn sync_chat_prompts(&mut self, cx: &mut Context<Self>) {
        let (Some(tab), Some(source)) = (self.chat_tab(), self.prompt_source.clone()) else {
            return;
        };
        let theme = self.theme;
        if let Some(i) = self.prompts.iter().position(|(id, _)| *id == tab) {
            let entry = self.prompts.remove(i);
            entry.1.set_theme(theme, cx);
            self.prompts.push(entry);
            return;
        }
        let Some(target) = source.target(&tab) else {
            return;
        };
        self.prompts
            .push((tab, ChatPrompts::new(target, theme, cx)));
        if self.prompts.len() > KEPT_CHAT_VIEWS {
            self.prompts.remove(0);
        }
    }

    /// A key the window saw: the shown chat's prompt cards answer Escape
    /// (and the resurrected ask its shortcuts), as their `window` listeners.
    fn prompt_key(&mut self, e: &KeyDownEvent, window: &mut Window, cx: &mut Context<Self>) {
        // An open overlay (U10a) is modal: its field keeps the keys.
        if self.overlay_kind().is_some() {
            return;
        }
        let prompts = self.chat_tab().and_then(|t| self.chat_prompts(&t));
        if prompts.is_some_and(|p| p.key_down(e, window, cx)) {
            cx.stop_propagation();
        }
    }

    /// Makes the bound tab's transcript view (and keeps the recent ones),
    /// and hands it what its cards read from the host (U06a).
    fn sync_chat_view(&mut self, cx: &mut Context<Self>) {
        let Some(tab) = self.chat_tab() else { return };
        let theme = self.theme;
        let view = if let Some(i) = self.chat_views.iter().position(|(id, _)| *id == tab) {
            let entry = self.chat_views.remove(i);
            entry.1.update(cx, |v, cx| v.set_theme(theme, cx));
            let view = entry.1.clone();
            self.chat_views.push(entry);
            view
        } else {
            let source = self.transcripts.clone();
            let on_action = crate::card_host::on_action(cx.entity().downgrade(), tab.clone());
            let id = tab.clone();
            let view = cx.new(|cx| {
                let mut v = TranscriptView::new(source, id, theme, cx);
                v.set_on_action(on_action);
                v
            });
            self.chat_views.push((tab, view.clone()));
            if self.chat_views.len() > KEPT_CHAT_VIEWS {
                self.chat_views.remove(0);
            }
            view
        };
        crate::card_host::sync(self, &view, cx);
    }

    /// The status line's view (U09a): over a live chat, made the first
    /// time the chat route shows a session; its theme follows the shell's.
    pub fn status_view(&self) -> Option<Entity<claudius_status::StatusLineView>> {
        self.status_view.clone()
    }

    fn sync_status_view(&mut self, cx: &mut Context<Self>) {
        let Some(target) = self.live_status.clone() else {
            return;
        };
        let theme = self.theme;
        match &self.status_view {
            Some(v) => v.update(cx, |v, cx| v.set_theme(theme, cx)),
            None if self.chat_tab().is_some() => {
                let target: Arc<dyn claudius_status::StatusTarget> = Arc::new(target);
                self.status_view =
                    Some(cx.new(|cx| claudius_status::StatusLineView::new(target, theme, cx)));
            }
            None => {}
        }
    }

    /// The rail (U09b): over a live chat, made with the status line.
    pub fn rail_view(&self) -> Option<Entity<claudius_panels::RailPanel>> {
        self.rail_view.clone()
    }

    /// The session header's goal row (U09b), made with the rail.
    pub fn goal_view(&self) -> Option<Entity<claudius_panels::GoalBannerView>> {
        self.goal_view.clone()
    }

    /// The rail's `setGoal` calls still waiting, over a live chat.
    pub fn live_rail_waiting(&self) -> Option<usize> {
        self.live_rail.as_ref().map(|r| r.waiting())
    }

    /// The rail and the goal banner over the live chat, once the status
    /// line is (the card opens its model picker): their prefs read from
    /// the store and written back, "Message" drafting into the composer;
    /// their theme follows the shell's.
    fn sync_rail_view(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some(target) = self.live_rail.clone() else {
            return;
        };
        let theme = self.theme;
        let viewport = f32::from(window.viewport_size().width);
        if let Some(r) = &self.rail_view {
            r.update(cx, |r, cx| {
                r.set_theme(theme, cx);
                r.set_viewport_width(viewport);
            });
            if let Some(g) = &self.goal_view {
                g.update(cx, |g, cx| g.set_theme(theme, cx));
            }
            return;
        }
        let Some(status) = self.status_view.clone() else {
            return;
        };
        let prefs: claudius_panels::rail::Prefs = claudius_panels::rail::pref_keys()
            .into_iter()
            .filter_map(|k| self.store.get(&k).map(|v| (k.clone(), v.to_owned())))
            .collect();
        let hidden = self
            .store
            .get(claudius_panels::goal::GOAL_HIDDEN_KEY)
            .map(str::to_owned);
        let target: Arc<dyn claudius_panels::RailTarget> = target;
        let t = target.clone();
        let rail = cx.new(|cx| {
            let mut r = claudius_panels::RailPanel::new(t, Some(status), theme, prefs, cx);
            r.set_message_wired(true, cx);
            r.set_viewport_width(viewport);
            r
        });
        let goal =
            cx.new(|cx| claudius_panels::GoalBannerView::new(target, theme, hidden.as_deref(), cx));
        self._rail_subs = vec![
            cx.subscribe_in(&rail, window, |this, _, ev, window, cx| {
                this.on_rail_event(ev, window, cx)
            }),
            cx.subscribe_in(&goal, window, |this, _, ev, window, cx| {
                this.on_rail_event(ev, window, cx)
            }),
        ];
        self.rail_view = Some(rail);
        self.goal_view = Some(goal);
    }

    fn on_rail_event(
        &mut self,
        ev: &claudius_panels::RailEvent,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        match ev {
            claudius_panels::RailEvent::Pref { key, value } => self.store.set(key, value),
            claudius_panels::RailEvent::Draft(text) => {
                if let Some(c) = self.composer.clone() {
                    c.update(cx, |c, cx| c.inject(text, window, cx));
                }
            }
            // Not ported yet: the transcript jump, the output viewer and
            // the context overlay.
            _ => {}
        }
    }

    /// Puts the composer under the chat's transcript, over `target` (the
    /// view is made on the next render).
    pub fn set_composer_target(&mut self, target: Arc<dyn ComposerTarget>, cx: &mut Context<Self>) {
        self.composer_target = Some(target);
        self.composer = None;
        cx.notify();
    }

    /// The calls the live composer still waits on (U07e), over a live
    /// chat.
    pub fn live_composer_waiting(&self) -> Option<usize> {
        self.live_composer.as_ref().map(|c| c.waiting())
    }

    /// The composer, once shown.
    pub fn composer(&self) -> Option<Entity<ComposerView>> {
        self.composer.clone()
    }

    /// Binds the composer to the shown tab (none off the chat route).
    fn sync_composer(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some(target) = self.composer_target.clone() else {
            return;
        };
        let theme = self.theme;
        let composer = self
            .composer
            .get_or_insert_with(|| cx.new(|cx| ComposerView::new(target, theme, window, cx)))
            .clone();
        let tab = self.chat_tab();
        composer.update(cx, |v, cx| {
            v.set_theme(theme, cx);
            v.set_session(tab.as_deref(), window, cx);
        });
    }

    /// The mounted chat (the workspace on screen's), if any.
    pub fn live_chat(&self) -> Option<&LiveChat> {
        self.chat.as_ref().map(|c| &c.chat)
    }

    /// The live chat bound to `session_id`, for a transcript view.
    pub fn chat_for_session(&self, session_id: &str) -> Option<LiveChat> {
        self.live_chat()
            .filter(|c| c.session_id().as_deref() == Some(session_id))
            .cloned()
    }

    /// The `localStorage` the shell writes.
    pub fn store(&self) -> &LocalStore {
        &self.store
    }

    /// The decoded icon of a workspace with an uploaded one.
    pub fn icon_image(&self, workspace: &str) -> Option<Arc<Image>> {
        self.icons.get(workspace).and_then(|e| e.image.clone())
    }

    /// The bound session's state for the active tab's dot: the live
    /// chat's (`starting` while it isn't bound to the strip's session
    /// yet), else the data source's.
    pub fn bound_state(&self, workspace: &str) -> Option<ActiveSessionState> {
        let Some(slot) = self.chat.as_ref().filter(|c| c.workspace == workspace) else {
            return self.data.active_session_state(workspace);
        };
        let bound = self.state.strip(workspace).and_then(|s| s.bound());
        Some(bound_tab_state(&slot.chat.state(), bound))
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
                this.load_icons(cx);
                this.run(effects, cx);
            })
            .ok();
        })
        .detach();
    }

    /// `SideNav`'s `/api/customizations` read: the gated tiles' names.
    fn load_customizations(&mut self, cx: &mut Context<Self>) {
        let fut = self.data.customizations();
        cx.spawn(async move |this, cx| {
            let names = match fut.await {
                Ok(Some(names)) => names,
                Ok(None) => return,
                Err(_) => Vec::new(),
            };
            this.update(cx, |this, cx| {
                this.state.set_enabled_customizations(names);
                cx.notify();
            })
            .ok();
        })
        .detach();
    }

    /// Reads the uploaded icons not read yet (or re-uploaded: the
    /// workspace's `updatedAt` moved).
    fn load_icons(&mut self, cx: &mut Context<Self>) {
        let wanted: Vec<(String, String, String)> = self
            .state
            .workspaces()
            .iter()
            .filter_map(|w| match w.icon() {
                WorkspaceIcon::Image { ext } => {
                    Some((w.id.clone(), format!("{ext}:{}", w.updated_at), ext))
                }
                WorkspaceIcon::Letter { .. } => None,
            })
            .collect();
        self.icons
            .retain(|id, _| wanted.iter().any(|(w, _, _)| w == id));
        for (id, key, ext) in wanted {
            if self.icons.get(&id).is_some_and(|e| e.key == key) {
                continue;
            }
            self.icons.insert(
                id.clone(),
                IconEntry {
                    key: key.clone(),
                    image: None,
                },
            );
            let fut = self.data.workspace_icon(&id);
            cx.spawn(async move |this, cx| {
                let Ok(Some(icon)) = fut.await else {
                    return;
                };
                let Some(format) = icon_format(&icon.content_type, &ext) else {
                    return;
                };
                let image = Arc::new(Image::from_bytes(format, icon.bytes));
                this.update(cx, |this, cx| {
                    if let Some(e) = this.icons.get_mut(&id).filter(|e| e.key == key) {
                        e.image = Some(image);
                        cx.notify();
                    }
                })
                .ok();
            })
            .detach();
        }
    }

    fn load_sessions(&mut self, workspace: String, cx: &mut Context<Self>) {
        // The mounted chat's workspace reads the chat's merged list, as
        // `ChatSurface` reads `session.sessions` (U04e); the others ask the
        // data source.
        if let Some(slot) = self.chat.as_ref().filter(|c| c.workspace == workspace) {
            let rows = crate::chat::session_rows(&slot.chat.state().sessions);
            self.state.sessions_loaded(&workspace, rows);
            cx.notify();
            return;
        }
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
                Effect::CreateSession(id)
                    if self.chat.as_ref().is_some_and(|c| c.workspace == id) =>
                {
                    // "+" on a live chat: `session.createNewSession()`; the
                    // strip follows what it binds.
                    if let Some(slot) = &self.chat {
                        slot.chat.act(|s, env| s.create_new_session(env));
                    }
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
        self.sync_git(cx);
        self.sync_chat(cx);
        self.persist_ui();
        cx.notify();
    }

    /// Adds the Git page over `data` (its route draws a placeholder
    /// without it); its links go through [`Shell::open_url`].
    pub fn set_git_data(
        &mut self,
        data: Arc<dyn claudius_git::data::GitData>,
        cx: &mut Context<Self>,
    ) {
        let screen = cx.new(|cx| claudius_git::view::GitScreen::new(data, cx));
        let sub = cx.subscribe(
            &screen,
            |this: &mut Shell, _, ev: &claudius_git::view::GitEvent, cx| {
                if let claudius_git::view::GitEvent::Navigate(url) = ev {
                    this.open_url(url, cx);
                }
            },
        );
        self._subscriptions.push(sub);
        self.git = Some(screen);
        self.sync_git(cx);
    }

    /// The Git page, when the shell has one.
    pub fn git_screen(&self) -> Option<&Entity<claudius_git::view::GitScreen>> {
        self.git.as_ref()
    }

    /// After every state change: the Git page follows the route (mounted on
    /// `/<ws>/git`, unmounted elsewhere), as the sessions browser does.
    fn sync_git(&mut self, cx: &mut Context<Self>) {
        let Some(screen) = self.git.clone() else {
            return;
        };
        let state = &self.state;
        let scope =
            match state.route() {
                Route::Workspace {
                    id,
                    page: WorkspacePage::Git,
                } => state.workspaces().iter().find(|w| &w.id == id).map(|w| {
                    claudius_git::page::Scope {
                        id: w.id.clone(),
                        name: w.name.clone(),
                        root_path: w.root_path.clone(),
                        commit_prefix: w
                            .extra
                            .get("commitPrefix")
                            .and_then(claudius_git::types::CommitPrefixConfig::from_value),
                    }
                }),
                _ => None,
            };
        let theme = self.theme;
        screen.update(cx, |s, cx| s.sync(scope, theme, cx));
    }

    /// Focus mode and the route memory into the store (`useFocusMode`'s
    /// write, `WorkspaceSwitcher`'s `setLastPath` on each pathname).
    fn persist_ui(&mut self) {
        self.store.set_focus(self.state.focus());
        if let Some(id) = self.state.route().workspace().map(str::to_owned) {
            let pathname = self.state.route().pathname();
            self.store.set_last_path(&id, &pathname);
        }
    }

    /// Mounts, unmounts or switches the live chat to match the route and
    /// the strip (see the module docs).
    fn sync_chat(&mut self, cx: &mut Context<Self>) {
        if !self.state.is_live_chat() {
            return;
        }
        let want = match self.state.route() {
            Route::Workspace {
                id,
                page: WorkspacePage::Chat { .. },
            } if self.state.is_loaded(id) => Some(id.clone()),
            _ => None,
        };
        if self.chat.as_ref().map(|c| &c.workspace) != want.as_ref() {
            self.chat = None;
            if let Some(ws) = want {
                self.mount_chat(&ws, cx);
            }
        }
        if let Some(l) = &self.live_transcripts {
            l.set_chat(self.chat.as_ref().map(|c| c.chat.clone()));
        }
        if let Some(l) = &self.live_status {
            l.set_chat(self.chat.as_ref().map(|c| c.chat.clone()));
        }
        let Some(slot) = self.chat.as_mut() else {
            return;
        };
        let bound = self.state.strip(&slot.workspace).and_then(|s| s.bound());
        if let Some(id) = slot.sync.on_strip(bound) {
            let seq = slot.chat.act(move |s, env| s.switch_session(&id, env));
            slot.sync.switching(seq);
        }
    }

    fn mount_chat(&mut self, ws: &str, cx: &mut Context<Self>) {
        let route = self.state.route();
        let href = format!("{PAGE_ORIGIN}{}", route.path());
        let Some(ChatPage { chat, mut ui }) = self.data.open_chat(ws, &href, &route.pathname())
        else {
            return;
        };
        if self.window_hidden {
            chat.act(|s, env| s.visibility_changed(true, env));
        }
        let mut changes = chat.changes();
        let workspace = ws.to_owned();
        let task = cx.spawn(async move |this, cx| {
            loop {
                let next = {
                    let changed = Box::pin(changes.changed());
                    match futures::future::select(changed, ui.next()).await {
                        futures::future::Either::Left((Ok(()), _)) => None,
                        futures::future::Either::Right((Some(e), _)) => Some(e),
                        _ => break,
                    }
                };
                if this
                    .update(cx, |this, cx| this.on_chat(&workspace, next, cx))
                    .is_err()
                {
                    break;
                }
            }
        });
        // The strip's bound tab is where the chat's boot lands anyway (the
        // route persisted it); the chat binds on its own.
        let synced = self
            .state
            .strip(ws)
            .and_then(|s| s.bound())
            .map(str::to_owned);
        self.chat = Some(ChatSlot {
            workspace: ws.to_owned(),
            chat,
            sync: ChatSync::new(synced),
            _task: task,
        });
    }

    /// The live chat changed (`None`) or asked the page for something.
    fn on_chat(&mut self, ws: &str, effect: Option<ChatEffect>, cx: &mut Context<Self>) {
        let Some(slot) = self.chat.as_mut().filter(|c| c.workspace == ws) else {
            return;
        };
        match effect {
            None => {
                if let Some(id) = slot.sync.on_snapshot(&slot.chat.snapshot()) {
                    let effects = self.state.chat_bound(ws, &id);
                    self.run(effects, cx);
                }
                if let Some(l) = &self.live_transcripts {
                    l.changed();
                }
                if let Some(l) = &self.live_status {
                    l.changed();
                }
                cx.notify();
            }
            Some(ChatEffect::ReplaceUrl { url }) => {
                let on_chat = matches!(
                    self.state.route(),
                    Route::Workspace { id, page: WorkspacePage::Chat { .. } } if id == ws
                );
                if on_chat && let Some(path) = url.strip_prefix(PAGE_ORIGIN) {
                    let effects = self.state.replace_location(path);
                    self.run(effects, cx);
                }
            }
            Some(ChatEffect::AssignUrl { url }) => {
                // A page load: the chat mounts again at the new URL.
                if let Some(path) = url.strip_prefix(PAGE_ORIGIN) {
                    self.chat = None;
                    let effects = self.state.open_url(path);
                    self.run(effects, cx);
                }
            }
            // A composer call's promise (U07e).
            Some(e @ ChatEffect::ActionResolved { .. }) => {
                let taken = self.live_composer.as_ref().is_some_and(|c| c.resolve(&e));
                // The rail's `setGoal` (U09b).
                if !taken && let Some(r) = &self.live_rail {
                    r.resolve(&e);
                }
            }
            Some(ChatEffect::ConsoleWarn { text }) => eprintln!("[chat] {text}"),
            Some(ChatEffect::BadPayload { error }) => {
                eprintln!("[chat] bad SSE payload: {}: {}", error.name, error.message)
            }
            Some(ChatEffect::UnhandledRejection { error }) => {
                eprintln!("[chat] unhandled rejection: {error}")
            }
            Some(_) => {}
        }
    }

    /// The window was hidden or shown (`document.hidden`).
    fn set_window_hidden(&mut self, hidden: bool, cx: &mut Context<Self>) {
        if self.window_hidden == hidden {
            return;
        }
        self.window_hidden = hidden;
        if let Some(slot) = &self.chat {
            slot.chat
                .act(move |s, env| s.visibility_changed(hidden, env));
        }
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
        this.persist_ui();
        cx.notify();
    });
    // The overlays (U10a).
    let el = el.on_action(
        cx.listener(|this: &mut Shell, _: &ToggleCommandPalette, w, cx| {
            this.toggle_command_palette(w, cx)
        }),
    );
    let el = el.on_action(
        cx.listener(|this: &mut Shell, _: &ToggleCheatsheet, w, cx| this.toggle_cheatsheet(w, cx)),
    );
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
        self.sync_status_view(cx);
        self.sync_rail_view(window, cx);
        self.sync_composer(window, cx);
        crate::files::sync(self, window, cx);
        crate::overlays::sync(self, window, cx);
        self.sync_chat_prompts(cx);
        let root = div()
            .track_focus(&self.focus)
            .size_full()
            .on_key_down(cx.listener(Self::prompt_key));
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

/// Opens the main window over a data source, the transcripts' source,
/// the sessions browser's and the store.
pub fn open_main_window(
    data: Arc<dyn ShellData>,
    transcripts: Arc<dyn TranscriptSource>,
    sessions: Arc<dyn crate::sessions::data::SessionsData>,
    appearance: Appearance,
    store: LocalStore,
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
            Shell::with_parts(data, transcripts, appearance, store, window, cx)
                .with_sessions(sessions, window, cx)
        })
    })?;
    Ok(shell)
}
