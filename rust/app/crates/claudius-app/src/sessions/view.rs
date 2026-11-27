//! [`SessionsScreen`]: the Sessions page and the one-session page on screen,
//! over a [`SessionsData`]. The shell keeps one, tells it the route
//! ([`sync`], after every state change), and draws it as the content area on
//! `/<ws>/sessions` and `/<ws>/sessions/<id>`. Its links go back through the
//! shell's redirect rules (`/?session=<id>` binds a chat tab, as the React
//! `router.push` does).

use std::collections::HashSet;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use claudius_gpui_theme::{ThemeName, fonts, hsla};
use claudius_theme::{color, tailwind};
use futures::StreamExt as _;
use gpui_kit::component::input::{Escape as InputEscape, Input, InputEvent, InputState};
use gpui_kit::component::{Icon, tooltip::Tooltip};
use gpui_kit::prelude::FluentBuilder as _;
use gpui_kit::{
    AnyElement, AnyWindowHandle, App, AppContext as _, Context, Div, ElementId, Entity,
    FocusHandle, FontWeight, Hsla, InteractiveElement as _, IntoElement, KeyBinding,
    ParentElement as _, Render, SharedString, StatefulInteractiveElement as _, Styled, Task,
    WeakEntity, Window, assets::IconName, div, px,
};

use super::data::{SessionsChange, SessionsData};
use super::detail::{DetailEffect, SessionDetail};
use super::list::{EmptyState, ListEffect, RowView, SessionsList, badge_count};
use super::transcript::{Block, COMPACTION_LABEL, Row};
use crate::route::{Route, WorkspacePage};
use crate::shell::Shell;
use crate::ui::Colors;

gpui_kit::actions!(
    sessions,
    [
        SelectNext,
        SelectPrev,
        SelectFirst,
        SelectLast,
        OpenSelected,
        FindSession,
        Dismiss
    ]
);

/// The screen's key context.
pub const CONTEXT: &str = "SessionsScreen";

/// The screen's keys: ↑ ↓ Home End move the selection, Enter opens it (or
/// answers a confirm), Escape dismisses, and `nav.findSession` (⌘F)
/// focuses the search box.
pub fn bind(cx: &mut App) {
    let find = if cfg!(target_os = "macos") {
        "cmd-f"
    } else {
        "ctrl-f"
    };
    cx.bind_keys([
        KeyBinding::new("down", SelectNext, Some(CONTEXT)),
        KeyBinding::new("up", SelectPrev, Some(CONTEXT)),
        KeyBinding::new("home", SelectFirst, Some(CONTEXT)),
        KeyBinding::new("end", SelectLast, Some(CONTEXT)),
        KeyBinding::new("enter", OpenSelected, Some(CONTEXT)),
        KeyBinding::new("escape", Dismiss, Some(CONTEXT)),
        KeyBinding::new(find, FindSession, Some(CONTEXT)),
    ]);
}

/// The page on screen.
#[derive(Clone, Debug)]
pub enum Page {
    None,
    List(Box<SessionsList>),
    Detail(Box<SessionDetail>),
}

/// The workspace the page belongs to.
#[derive(Clone, Debug, PartialEq, Eq)]
struct Scope {
    id: String,
    name: String,
    root: String,
}

pub struct SessionsScreen {
    data: Arc<dyn SessionsData>,
    shell: WeakEntity<Shell>,
    window: AnyWindowHandle,
    shell_focus: FocusHandle,
    focus: FocusHandle,
    page: Page,
    /// Bumped with each new page: an answer for an older one is dropped.
    generation: u64,
    scope: Option<Scope>,
    search: Entity<InputState>,
    rename: Entity<InputState>,
    content_timer: Option<Task<()>>,
    settle_timer: Option<Task<()>>,
    clock: Option<f64>,
    export_dir: Option<PathBuf>,
    /// The open compaction summaries, thinking and tool blocks.
    open: HashSet<String>,
    _tasks: Vec<Task<()>>,
    _subscriptions: Vec<gpui_kit::Subscription>,
}

/// `Date.now()`.
fn now_ms() -> f64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as f64)
        .unwrap_or(0.)
}

impl SessionsScreen {
    pub fn new(
        data: Arc<dyn SessionsData>,
        shell: WeakEntity<Shell>,
        shell_focus: FocusHandle,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Self {
        let search =
            cx.new(|cx| InputState::new(window, cx).placeholder("Search titles… (n: names only)"));
        let rename = cx.new(|cx| InputState::new(window, cx));
        let subscriptions = vec![
            cx.subscribe(
                &search,
                |this: &mut Self, input, ev: &InputEvent, cx| match ev {
                    InputEvent::Change => {
                        let text = input.read(cx).value().to_string();
                        this.filter_changed(&text, cx);
                    }
                    InputEvent::PressEnter { .. } => {
                        if let Page::List(l) = &this.page {
                            let effects = l.open_best();
                            this.run_list(effects, cx);
                        }
                    }
                    _ => {}
                },
            ),
            cx.subscribe(
                &rename,
                |this: &mut Self, input, ev: &InputEvent, cx| match ev {
                    InputEvent::Change => {
                        let text = input.read(cx).value().to_string();
                        if let Page::Detail(d) = &mut this.page {
                            d.set_draft(&text);
                        }
                    }
                    InputEvent::PressEnter { .. } => this.save_rename(cx),
                    _ => {}
                },
            ),
        ];
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
        SessionsScreen {
            data,
            shell,
            window: window.window_handle(),
            shell_focus,
            focus: cx.focus_handle(),
            page: Page::None,
            generation: 0,
            scope: None,
            search,
            rename,
            content_timer: None,
            settle_timer: None,
            clock: None,
            export_dir: None,
            open: HashSet::new(),
            _tasks: vec![listen],
            _subscriptions: subscriptions,
        }
    }

    // ---- reads (tests, the screenshots) ----------------------------------

    pub fn page(&self) -> &Page {
        &self.page
    }

    pub fn list(&self) -> Option<&SessionsList> {
        match &self.page {
            Page::List(l) => Some(l),
            _ => None,
        }
    }

    pub fn detail(&self) -> Option<&SessionDetail> {
        match &self.page {
            Page::Detail(d) => Some(d),
            _ => None,
        }
    }

    /// Fixes the clock (the relative times), for tests and screenshots.
    pub fn set_clock(&mut self, now_ms: f64, cx: &mut Context<Self>) {
        self.clock = Some(now_ms);
        cx.notify();
    }

    /// Writes exports into `dir` instead of asking where.
    pub fn set_export_dir(&mut self, dir: PathBuf) {
        self.export_dir = Some(dir);
    }

    fn now(&self) -> f64 {
        self.clock.unwrap_or_else(now_ms)
    }

    fn now_year(&self) -> i32 {
        use chrono::{Datelike, TimeZone};
        match self.clock {
            Some(ms) => chrono::Local
                .timestamp_millis_opt(ms as i64)
                .single()
                .map_or_else(crate::tabs::current_year, |d| d.year()),
            None => crate::tabs::current_year(),
        }
    }

    // ---- the route --------------------------------------------------------

    /// The shell's route changed (or its workspaces did).
    fn sync_route(&mut self, route: &Route, scope: Option<Scope>, cx: &mut Context<Self>) {
        let root = scope.as_ref().map(|s| s.root.clone());
        self.scope = scope;
        match route {
            Route::Workspace {
                id,
                page: WorkspacePage::Sessions,
            } => {
                if let Page::List(l) = &mut self.page
                    && l.workspace_id() == id
                {
                    let effects = l.set_root(root.as_deref());
                    if !effects.is_empty() {
                        self.restart_content_timer(cx);
                    }
                    self.run_list(effects, cx);
                    return;
                }
                let mut list = SessionsList::new(id, root.as_deref());
                list.set_unread(self.data.unread(id));
                let effects = list.start();
                self.arrive(Page::List(Box::new(list)), cx);
                self.restart_content_timer(cx);
                self.run_list(effects, cx);
            }
            Route::Workspace {
                page: WorkspacePage::Session { id, dir },
                ..
            } => {
                if let Page::Detail(d) = &self.page
                    && d.id() == id
                    && d.dir() == dir.as_deref()
                {
                    return;
                }
                let mut detail = SessionDetail::new(id, dir.as_deref());
                let effects = detail.load();
                self.arrive(Page::Detail(Box::new(detail)), cx);
                self.run_detail(effects, cx);
            }
            _ => {
                if !matches!(self.page, Page::None) {
                    self.page = Page::None;
                    self.generation += 1;
                    self.content_timer = None;
                    self.settle_timer = None;
                    // Hand the keyboard back to the shell.
                    let (focus, shell_focus, window) =
                        (self.focus.clone(), self.shell_focus.clone(), self.window);
                    cx.defer(move |cx| {
                        window
                            .update(cx, |_, window, cx| {
                                if focus.contains_focused(window, cx) {
                                    shell_focus.focus(window, cx);
                                }
                            })
                            .ok();
                    });
                }
            }
        }
    }

    /// A new page: fresh state (the React page remounts), the search box
    /// cleared, the keyboard on the screen.
    fn arrive(&mut self, page: Page, cx: &mut Context<Self>) {
        self.page = page;
        self.generation += 1;
        self.open.clear();
        self.content_timer = None;
        self.settle_timer = None;
        let (focus, search, window) = (self.focus.clone(), self.search.clone(), self.window);
        cx.defer(move |cx| {
            window
                .update(cx, |_, window, cx| {
                    search.update(cx, |s, cx| s.set_value("", window, cx));
                    focus.focus(window, cx);
                })
                .ok();
        });
        cx.notify();
    }

    fn on_change(&mut self, change: SessionsChange, cx: &mut Context<Self>) {
        match (&mut self.page, change) {
            (Page::List(l), SessionsChange::List { dir }) => {
                if dir.is_none() || dir.as_deref() == l.root() {
                    let effects = l.changed();
                    self.run_list(effects, cx);
                }
            }
            (Page::List(l), SessionsChange::Unread { workspace_id }) => {
                if workspace_id == l.workspace_id() {
                    l.set_unread(self.data.unread(&workspace_id));
                    let effects = l.drive();
                    self.run_list(effects, cx);
                }
            }
            (Page::Detail(d), SessionsChange::Session { id }) if id == d.id() => {
                let effects = d.load();
                self.run_detail(effects, cx);
            }
            _ => {}
        }
    }

    // ---- effects ----------------------------------------------------------

    fn open_url(&mut self, url: String, cx: &mut Context<Self>) {
        let shell = self.shell.clone();
        // After this update: the shell's route change syncs this screen.
        cx.defer(move |cx| {
            shell.update(cx, |shell, cx| shell.open_url(&url, cx)).ok();
        });
    }

    fn save(&mut self, filename: String, text: String, cx: &mut Context<Self>) {
        let generation = self.generation;
        let fixed = self.export_dir.clone();
        let dialog = fixed.is_none().then(|| {
            let dir = std::env::var_os("HOME")
                .map(|h| PathBuf::from(h).join("Downloads"))
                .unwrap_or_else(std::env::temp_dir);
            cx.prompt_for_new_path(&dir, Some(&filename))
        });
        cx.spawn(async move |this, cx| {
            let path = match (fixed, dialog) {
                (Some(dir), _) => Some(dir.join(&filename)),
                (None, Some(rx)) => match rx.await {
                    Ok(Ok(Some(p))) => Some(p),
                    _ => None,
                },
                _ => None,
            };
            let Some(path) = path else {
                return;
            };
            let result = std::fs::write(&path, text)
                .map(|()| path.display().to_string())
                .map_err(|e| e.to_string());
            this.update(cx, |this, cx| {
                if this.generation != generation {
                    return;
                }
                match &mut this.page {
                    Page::List(l) => l.saved(result),
                    Page::Detail(d) => d.saved(result),
                    Page::None => {}
                }
                cx.notify();
            })
            .ok();
        })
        .detach();
    }

    fn run_list(&mut self, effects: Vec<ListEffect>, cx: &mut Context<Self>) {
        for effect in effects {
            match effect {
                ListEffect::Send(call, request) => {
                    let fut = self.data.send(request);
                    let generation = self.generation;
                    cx.spawn(async move |this, cx| {
                        let reply = fut.await.map_err(|e| e.to_string());
                        this.update(cx, |this, cx| {
                            if this.generation != generation {
                                return;
                            }
                            if let Page::List(l) = &mut this.page {
                                let more = l.replied(call, reply);
                                this.run_list(more, cx);
                            }
                        })
                        .ok();
                    })
                    .detach();
                }
                ListEffect::Open(url) => self.open_url(url, cx),
                ListEffect::Save { filename, text } => self.save(filename, text, cx),
            }
        }
        if let Page::List(l) = &mut self.page {
            let more = l.drive();
            if !more.is_empty() {
                self.run_list(more, cx);
            }
        }
        cx.notify();
    }

    fn run_detail(&mut self, effects: Vec<DetailEffect>, cx: &mut Context<Self>) {
        for effect in effects {
            match effect {
                DetailEffect::Send(call, request) => {
                    let fut = self.data.send(request);
                    let generation = self.generation;
                    cx.spawn(async move |this, cx| {
                        let reply = fut.await.map_err(|e| e.to_string());
                        this.update(cx, |this, cx| {
                            if this.generation != generation {
                                return;
                            }
                            if let Page::Detail(d) = &mut this.page {
                                let renaming = d.renaming();
                                let more = d.replied(call, reply);
                                this.run_detail(more, cx);
                                // The rename box closed: keys back to the page.
                                if renaming && !this.detail().is_some_and(|d| d.renaming()) {
                                    this.refocus(cx);
                                }
                            }
                        })
                        .ok();
                    })
                    .detach();
                }
                DetailEffect::Open(url) => self.open_url(url, cx),
                DetailEffect::Save { filename, text } => self.save(filename, text, cx),
            }
        }
        cx.notify();
    }

    fn refocus(&self, cx: &mut Context<Self>) {
        let (focus, window) = (self.focus.clone(), self.window);
        cx.defer(move |cx| {
            window
                .update(cx, |_, window, cx| focus.focus(window, cx))
                .ok();
        });
    }

    // ---- the list's handlers ----------------------------------------------

    fn list_mut(&mut self) -> Option<&mut SessionsList> {
        match &mut self.page {
            Page::List(l) => Some(l),
            _ => None,
        }
    }

    fn filter_changed(&mut self, text: &str, cx: &mut Context<Self>) {
        let Some(l) = self.list_mut() else {
            return;
        };
        if l.filter() == text {
            return;
        }
        l.set_filter(text);
        self.restart_content_timer(cx);
        self.restart_settle_timer(cx);
        self.run_list(Vec::new(), cx);
    }

    fn restart_content_timer(&mut self, cx: &mut Context<Self>) {
        let generation = self.generation;
        self.content_timer = Some(cx.spawn(async move |this, cx| {
            cx.background_executor()
                .timer(Duration::from_millis(250))
                .await;
            this.update(cx, |this, cx| {
                if this.generation != generation {
                    return;
                }
                if let Some(l) = this.list_mut() {
                    let effects = l.content_search_due();
                    this.run_list(effects, cx);
                }
            })
            .ok();
        }));
    }

    fn restart_settle_timer(&mut self, cx: &mut Context<Self>) {
        let generation = self.generation;
        self.settle_timer = Some(cx.spawn(async move |this, cx| {
            cx.background_executor()
                .timer(Duration::from_millis(300))
                .await;
            this.update(cx, |this, cx| {
                if this.generation != generation {
                    return;
                }
                if let Some(l) = this.list_mut() {
                    l.settle();
                    this.run_list(Vec::new(), cx);
                }
            })
            .ok();
        }));
    }

    /// Types into the search box (as the keyboard would).
    pub fn type_query(&mut self, text: &str, window: &mut Window, cx: &mut Context<Self>) {
        self.search
            .update(cx, |s, cx| s.set_value(text.to_owned(), window, cx));
        self.filter_changed(text, cx);
    }

    fn list_action(
        &mut self,
        cx: &mut Context<Self>,
        f: impl FnOnce(&mut SessionsList) -> Vec<ListEffect>,
    ) {
        if let Some(l) = self.list_mut() {
            let effects = f(l);
            self.run_list(effects, cx);
        }
    }

    fn detail_action(
        &mut self,
        cx: &mut Context<Self>,
        f: impl FnOnce(&mut SessionDetail) -> Vec<DetailEffect>,
    ) {
        if let Page::Detail(d) = &mut self.page {
            let effects = f(d);
            self.run_detail(effects, cx);
        }
    }

    // ---- what a click or a key does, by name (the screenshots, tests) -----

    /// Selects the `i`-th listed row (as ↓ would reach it).
    pub fn select_row(&mut self, i: usize, cx: &mut Context<Self>) {
        if let Some(l) = self.list_mut()
            && let Some(id) = l.filtered().get(i).map(|s| s.session_id.clone())
        {
            l.select(&id);
            cx.notify();
        }
    }

    /// "Search in transcripts".
    pub fn toggle_transcripts(&mut self, cx: &mut Context<Self>) {
        if let Some(l) = self.list_mut() {
            let on = l.search_transcripts();
            l.set_search_transcripts(!on);
        }
        self.restart_content_timer(cx);
        self.run_list(Vec::new(), cx);
    }

    /// A branch chip (`None`: "all").
    pub fn pick_branch(&mut self, branch: Option<&str>, cx: &mut Context<Self>) {
        self.list_action(cx, |l| {
            l.set_branch(branch);
            Vec::new()
        });
    }

    /// The `i`-th row's "Delete".
    pub fn ask_delete_row(&mut self, i: usize, cx: &mut Context<Self>) {
        self.list_action(cx, |l| {
            if let Some(id) = l.filtered().get(i).map(|s| s.session_id.clone()) {
                l.select(&id);
                l.ask_delete(&id);
            }
            Vec::new()
        });
    }

    /// Opens every compaction summary, thinking and tool block.
    pub fn open_all_blocks(&mut self, cx: &mut Context<Self>) {
        let Page::Detail(d) = &self.page else {
            return;
        };
        for row in d.rows() {
            match row {
                Row::Compaction { uuid, .. } => {
                    self.open.insert(format!("compaction:{uuid}"));
                }
                Row::Assistant { uuid, blocks } => {
                    for j in 0..blocks.len() {
                        self.open.insert(format!("block:{uuid}:{j}"));
                    }
                }
                _ => {}
            }
        }
        cx.notify();
    }

    /// The pencil.
    pub fn begin_rename(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.start_rename(window, cx);
    }

    /// The one-session page's "Delete".
    pub fn ask_delete_session(&mut self, cx: &mut Context<Self>) {
        self.detail_action(cx, |d| {
            d.ask_delete();
            Vec::new()
        });
    }

    /// "Raw" / "Pretty".
    pub fn toggle_raw(&mut self, cx: &mut Context<Self>) {
        self.detail_action(cx, |d| {
            d.toggle_raw();
            Vec::new()
        });
    }

    // ---- the detail's handlers --------------------------------------------

    fn start_rename(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Page::Detail(d) = &mut self.page else {
            return;
        };
        d.start_rename();
        let draft = d.title_draft().to_owned();
        self.rename.update(cx, |s, cx| {
            s.set_value(draft, window, cx);
            s.focus(window, cx);
        });
        cx.notify();
    }

    fn save_rename(&mut self, cx: &mut Context<Self>) {
        self.detail_action(cx, |d| d.save_rename());
    }

    fn cancel_rename(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if let Page::Detail(d) = &mut self.page {
            d.cancel_rename();
            self.focus.focus(window, cx);
            cx.notify();
        }
    }

    // ---- keys -------------------------------------------------------------

    fn on_enter(&mut self, cx: &mut Context<Self>) {
        match &mut self.page {
            Page::List(l) if l.confirming_delete().is_some() => {
                let effects = l.confirm_delete(true);
                self.run_list(effects, cx);
            }
            Page::List(l) => {
                let effects = l.open_selected();
                self.run_list(effects, cx);
            }
            Page::Detail(d) if d.confirming_delete() => {
                let effects = d.confirm_delete(true);
                self.run_detail(effects, cx);
            }
            _ => {}
        }
    }

    fn on_dismiss(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        match &mut self.page {
            Page::List(l) if l.confirming_delete().is_some() => {
                l.confirm_delete(false);
            }
            Page::Detail(d) if d.confirming_delete() => {
                d.confirm_delete(false);
            }
            Page::Detail(d) if d.renaming() => {
                d.cancel_rename();
                self.focus.focus(window, cx);
            }
            _ => {}
        }
        cx.notify();
    }

    fn find_session(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if matches!(self.page, Page::List(_)) {
            self.search.update(cx, |s, cx| {
                s.focus(window, cx);
                s.select_all(window, cx);
            });
        }
    }
}

/// After every shell state change: the screen follows the route.
pub(crate) fn sync(shell: &Shell, cx: &mut Context<Shell>) {
    let Some(screen) = shell.sessions.clone() else {
        return;
    };
    let state = shell.state();
    let route = state.route().clone();
    let scope = route.workspace().and_then(|id| {
        state
            .workspaces()
            .iter()
            .find(|w| w.id == id)
            .map(|w| Scope {
                id: w.id.clone(),
                name: w.name.clone(),
                root: w.root_path.clone(),
            })
    });
    screen.update(cx, |screen, cx| screen.sync_route(&route, scope, cx));
}

impl Shell {
    /// Adds the sessions browser over `data` (the Sessions routes draw a
    /// placeholder without it).
    pub fn with_sessions(
        mut self,
        data: Arc<dyn SessionsData>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Self {
        let shell = cx.weak_entity();
        let focus = self.focus.clone();
        self.sessions = Some(cx.new(|cx| SessionsScreen::new(data, shell, focus, window, cx)));
        self
    }

    /// The sessions browser, when the shell has one.
    pub fn sessions_screen(&self) -> Option<&Entity<SessionsScreen>> {
        self.sessions.as_ref()
    }
}

/// The content area on the Sessions routes, when the shell has the screen.
pub(crate) fn element(shell: &Shell) -> Option<AnyElement> {
    shell.sessions.clone().map(IntoElement::into_any_element)
}

// ---- drawing ---------------------------------------------------------------

/// A Tailwind step at an opacity (`bg-red-500/10`).
fn tw(name: &str, pct: f64) -> Hsla {
    let c = tailwind::color(name).unwrap_or_else(|| panic!("{name} is a Tailwind step"));
    if pct >= 100. {
        hsla(c)
    } else {
        hsla(color::with_opacity(c, pct))
    }
}

fn icon(name: IconName, size: f32, color: Hsla) -> Icon {
    Icon::new(name).size(px(size)).text_color(color)
}

fn tooltip(text: String) -> impl Fn(&mut Window, &mut App) -> gpui_kit::AnyView {
    move |window, cx| Tooltip::new(text.clone()).build(window, cx)
}

fn text_px<E: Styled>(size: f32, line: f32) -> impl Fn(E) -> E {
    move |d: E| d.text_size(px(size)).line_height(px(line))
}

fn dot(c: &Colors) -> Div {
    div().opacity(0.5).child("·").text_color(c.foreground)
}

/// A header button (`rounded-md border px-2 py-0.5`).
fn button(id: impl Into<ElementId>, selector: String, c: &Colors) -> gpui_kit::Stateful<Div> {
    div()
        .id(id)
        .debug_selector(move || selector.clone())
        .flex()
        .flex_none()
        .items_center()
        .gap(px(4.))
        .px(px(8.))
        .py(px(2.))
        .rounded(px(6.))
        .border_1()
        .border_color(c.border)
        .bg(c.panel_2)
}

/// [`button`] with the default hover.
fn plain_button(id: impl Into<ElementId>, selector: String, c: &Colors) -> gpui_kit::Stateful<Div> {
    let hover = c.panel;
    button(id, selector, c).hover(move |d| d.bg(hover))
}

impl Render for SessionsScreen {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = self
            .shell
            .upgrade()
            .map_or(ThemeName::Dark, |s| s.read(cx).theme());
        let c = Colors::of(theme);
        let body = match &self.page {
            Page::List(_) => self.render_list(&c, window, cx),
            Page::Detail(_) => self.render_detail(&c, window, cx),
            Page::None => div().into_any_element(),
        };
        let confirm = match &self.page {
            Page::List(l) => l.delete_question(),
            Page::Detail(d) if d.confirming_delete() => {
                Some(SessionDetail::DELETE_QUESTION.to_owned())
            }
            _ => None,
        };
        div()
            .id("sessions-screen")
            .debug_selector(|| "sessions-screen".into())
            .key_context(CONTEXT)
            .track_focus(&self.focus)
            .relative()
            .flex()
            .flex_col()
            .flex_1()
            .min_h_0()
            .size_full()
            .overflow_hidden()
            .text_color(c.foreground)
            .on_action(cx.listener(|this, _: &SelectNext, _, cx| {
                if let Some(l) = this.list_mut() {
                    l.move_selection(true);
                    cx.notify();
                }
            }))
            .on_action(cx.listener(|this, _: &SelectPrev, _, cx| {
                if let Some(l) = this.list_mut() {
                    l.move_selection(false);
                    cx.notify();
                }
            }))
            .on_action(cx.listener(|this, _: &SelectFirst, _, cx| {
                if let Some(l) = this.list_mut() {
                    l.select_edge(false);
                    cx.notify();
                }
            }))
            .on_action(cx.listener(|this, _: &SelectLast, _, cx| {
                if let Some(l) = this.list_mut() {
                    l.select_edge(true);
                    cx.notify();
                }
            }))
            .on_action(cx.listener(|this, _: &OpenSelected, _, cx| this.on_enter(cx)))
            .on_action(cx.listener(|this, _: &Dismiss, window, cx| this.on_dismiss(window, cx)))
            .on_action(
                cx.listener(|this, _: &FindSession, window, cx| this.find_session(window, cx)),
            )
            .child(body)
            .when_some(confirm, |d, q| d.child(confirm_dialog(&q, &c, cx)))
    }
}

impl SessionsScreen {
    fn render_list(&self, c: &Colors, _window: &mut Window, cx: &mut Context<Self>) -> AnyElement {
        let Page::List(l) = &self.page else {
            return div().into_any_element();
        };
        let now = self.now();
        let rows = l.rows(now, self.now_year());
        let scoped = l.scoped().len();
        let muted = |s: String| div().flex_none().text_color(c.muted).child(s);
        let red = tw("red-400", 100.);
        let ws_name = self
            .scope
            .as_ref()
            .map(|s| (s.name.clone(), s.root.clone()));
        let header = div()
            .id("sessions-header")
            .debug_selector(|| "sessions-header".into())
            .flex()
            .flex_none()
            .items_center()
            .h(px(36.))
            .gap(px(12.))
            .px(px(16.))
            .border_b_1()
            .border_color(c.border)
            .bg(c.panel)
            .map(text_px(12., 16.))
            .child(
                div()
                    .id("sessions-back-chat")
                    .debug_selector(|| "sessions-back-chat".into())
                    .flex()
                    .flex_none()
                    .items_center()
                    .gap(px(4.))
                    .text_color(c.muted)
                    .hover(|d| d.text_color(c.foreground))
                    .child(icon(IconName::ArrowLeft, 14., c.muted))
                    .child("Chat")
                    .on_click(cx.listener(|this, _, _, cx| this.open_url("/".into(), cx))),
            )
            .child(dot(c))
            .child(icon(IconName::FolderTree, 14., c.muted))
            .child(
                div()
                    .flex_none()
                    .font_weight(FontWeight::MEDIUM)
                    .child("Sessions"),
            )
            .when_some(ws_name, |d, (name, root)| {
                d.child(
                    div()
                        .id("sessions-workspace")
                        .min_w_0()
                        .truncate()
                        .text_color(c.muted)
                        .child(name)
                        .tooltip(tooltip(root)),
                )
            })
            .child(muted(format!("({scoped})")))
            .when_some(l.unread_pill(), |d, (label, title)| {
                let on = l.filter_unread();
                d.child(
                    div()
                        .id("sessions-unread-filter")
                        .debug_selector(|| "sessions-unread-filter".into())
                        .flex()
                        .flex_none()
                        .items_center()
                        .gap(px(4.))
                        .px(px(8.))
                        .py(px(2.))
                        .rounded_full()
                        .border_1()
                        .map(text_px(10., 12.))
                        .font_weight(FontWeight::MEDIUM)
                        .text_color(c.accent)
                        .when(on, |d| d.border_color(c.accent).bg(c.alpha(c.accent, 15.)))
                        .when(!on, |d| {
                            d.border_color(c.alpha(c.accent, 40.))
                                .hover(|d| d.bg(c.alpha(c.accent, 10.)))
                        })
                        .child(icon(IconName::Bell, 12., c.accent))
                        .child(label)
                        .tooltip(tooltip(title))
                        .on_click(cx.listener(|this, _, _, cx| {
                            if let Some(l) = this.list_mut() {
                                l.toggle_unread_only();
                            }
                            this.run_list(Vec::new(), cx);
                        })),
                )
            })
            .when(l.loading(), |d| d.child(muted("loading…".into())))
            .when(l.search_transcripts() && l.content_searching(), |d| {
                d.child(muted("searching transcripts…".into()))
            })
            .when_some(l.error(), |d, e| {
                d.child(div().flex_none().text_color(red).child(e.to_owned()))
            })
            .when_some(l.action_error(), |d, e| {
                d.child(
                    div()
                        .id("sessions-action-error")
                        .debug_selector(|| "sessions-action-error".into())
                        .min_w_0()
                        .truncate()
                        .text_color(red)
                        .child(e.to_owned())
                        .tooltip(tooltip(e.to_owned())),
                )
            })
            .when_some(l.notice(), |d, n| {
                d.child(
                    div()
                        .debug_selector(|| "sessions-notice".into())
                        .min_w_0()
                        .truncate()
                        .text_color(c.muted)
                        .child(n.to_owned()),
                )
            })
            .child(
                div()
                    .flex()
                    .flex_1()
                    .min_w_0()
                    .items_center()
                    .justify_center()
                    .gap(px(8.))
                    .px(px(12.))
                    .child(
                        div()
                            .debug_selector(|| "sessions-search".into())
                            .w_full()
                            .max_w(px(448.))
                            .child(
                                Input::new(&self.search)
                                    .prefix(icon(IconName::Search, 14., c.muted))
                                    .cleanable(true)
                                    .h(px(26.))
                                    .text_size(px(12.)),
                            ),
                    )
                    .child(self.transcripts_toggle(l.search_transcripts(), c, cx)),
            )
            .child(
                plain_button("sessions-refresh", "sessions-refresh".into(), c)
                    .child("Refresh")
                    .on_click(cx.listener(|this, _, _, cx| this.list_action(cx, |l| l.refresh()))),
            );

        let branches = l.branches();
        let branch_bar = (branches.len() > 1).then(|| {
            let chip = |id: String, active: bool, c: &Colors| {
                div()
                    .id(ElementId::Name(id.clone().into()))
                    .debug_selector(move || id.clone())
                    .flex()
                    .flex_none()
                    .items_center()
                    .gap(px(4.))
                    .px(px(8.))
                    .py(px(2.))
                    .rounded(px(6.))
                    .border_1()
                    .map(text_px(11., 16.))
                    .when(active, |d| d.border_color(c.accent).bg(c.panel_2))
                    .when(!active, |d| {
                        d.border_color(c.border)
                            .bg(c.panel)
                            .hover(|d| d.bg(c.panel_2))
                    })
            };
            div()
                .id("sessions-branches")
                .debug_selector(|| "sessions-branches".into())
                .flex()
                .flex_none()
                .items_center()
                .gap(px(8.))
                .px(px(16.))
                .py(px(6.))
                .overflow_x_scroll()
                .border_b_1()
                .border_color(c.border)
                .bg(c.alpha(c.panel, 30.))
                .child(
                    div()
                        .flex_none()
                        .map(text_px(10., 12.))
                        .text_color(c.muted)
                        .child("BRANCH"),
                )
                .child(
                    chip("branch-all".into(), l.branch().is_none(), c)
                        .child("all")
                        .on_click(cx.listener(|this, _, _, cx| {
                            this.list_action(cx, |l| {
                                l.set_branch(None);
                                Vec::new()
                            })
                        })),
                )
                .children(branches.into_iter().enumerate().map(|(i, (b, n))| {
                    let active = l.branch() == Some(b.as_str());
                    let pick = b.clone();
                    chip(format!("branch-{i}"), active, c)
                        .child(div().font_family(fonts::MONO).child(b))
                        .child(
                            div()
                                .ml(px(4.))
                                .map(text_px(10., 12.))
                                .text_color(c.muted)
                                .child(n.to_string()),
                        )
                        .on_click(cx.listener(move |this, _, _, cx| {
                            let pick = pick.clone();
                            this.list_action(cx, move |l| {
                                l.set_branch(Some(&pick));
                                Vec::new()
                            })
                        }))
                }))
        });

        let empty = l.empty_state();
        let list_body = match &empty {
            Some(state) => self.empty_state(state, c, cx),
            None => div()
                .flex()
                .flex_col()
                .children(
                    rows.into_iter()
                        .enumerate()
                        .map(|(i, r)| self.row(i, r, c, cx)),
                )
                .into_any_element(),
        };
        let load_more = l.load_more_button().map(|enabled| {
            div().mt(px(12.)).mb(px(12.)).flex().justify_center().child(
                plain_button("sessions-load-more", "sessions-load-more".into(), c)
                    .px(px(12.))
                    .py(px(4.))
                    .text_color(c.muted)
                    .when(!enabled, |d| d.opacity(0.4))
                    .child(if enabled {
                        "Load more sessions"
                    } else {
                        "Loading…"
                    })
                    .when(enabled, |d| {
                        d.on_click(
                            cx.listener(|this, _, _, cx| this.list_action(cx, |l| l.load_more())),
                        )
                    }),
            )
        });
        div()
            .flex()
            .flex_col()
            .flex_1()
            .min_h_0()
            .size_full()
            .child(header)
            .children(branch_bar)
            .child(
                div()
                    .id("sessions-list")
                    .debug_selector(|| "sessions-list".into())
                    .flex_1()
                    .min_h_0()
                    .overflow_y_scroll()
                    .child(list_body)
                    .children(load_more),
            )
            .into_any_element()
    }

    fn transcripts_toggle(&self, on: bool, c: &Colors, cx: &mut Context<Self>) -> AnyElement {
        div()
            .id("sessions-search-transcripts")
            .debug_selector(|| "sessions-search-transcripts".into())
            .flex()
            .flex_none()
            .items_center()
            .gap(px(6.))
            .map(text_px(11., 16.))
            .text_color(c.muted)
            .hover(|d| d.text_color(c.foreground))
            .child(
                div()
                    .flex()
                    .items_center()
                    .justify_center()
                    .size(px(12.))
                    .rounded(px(3.))
                    .border_1()
                    .border_color(if on { c.accent } else { c.border })
                    .when(on, |d| {
                        d.bg(c.accent)
                            .child(icon(IconName::Check, 10., Colors::white()))
                    }),
            )
            .child("Search in transcripts")
            .tooltip(tooltip("Also search inside message transcripts".into()))
            .on_click(cx.listener(move |this, _, _, cx| {
                if let Some(l) = this.list_mut() {
                    l.set_search_transcripts(!on);
                }
                this.restart_content_timer(cx);
                this.run_list(Vec::new(), cx);
            }))
            .into_any_element()
    }

    fn empty_state(&self, state: &EmptyState, c: &Colors, cx: &mut Context<Self>) -> AnyElement {
        div()
            .debug_selector(|| "sessions-search-status".into())
            .flex()
            .flex_col()
            .items_center()
            .gap(px(12.))
            .px(px(24.))
            .py(px(64.))
            .map(text_px(14., 20.))
            .text_color(c.muted)
            .child(state.message())
            .when_some(state.button(), |d, label| {
                d.child(
                    plain_button("sessions-search-older", "sessions-search-older".into(), c)
                        .px(px(12.))
                        .py(px(4.))
                        .map(text_px(12., 16.))
                        .child(label)
                        .on_click(
                            cx.listener(|this, _, _, cx| {
                                this.list_action(cx, |l| l.search_older())
                            }),
                        ),
                )
            })
            .into_any_element()
    }

    fn row(&self, i: usize, r: RowView, c: &Colors, cx: &mut Context<Self>) -> AnyElement {
        let id = r.id.clone();
        let unread = r.unread;
        let sep = || div().opacity(0.5).child("·");
        let href = r.href.clone();
        let meta = div()
            .mt(px(2.))
            .flex()
            .flex_wrap()
            .items_center()
            .gap(px(8.))
            .map(text_px(11., 16.))
            .text_color(c.muted)
            .child(div().child(r.relative.clone()))
            .child(sep())
            .child(div().child(r.bytes.clone()))
            .when_some(r.branch.clone(), |d, b| {
                d.child(sep())
                    .child(div().font_family(fonts::MONO).child(b))
            })
            .when_some(r.cwd.clone(), |d, cwd| {
                d.child(sep()).child(
                    div()
                        .min_w_0()
                        .truncate()
                        .font_family(fonts::MONO)
                        .child(cwd),
                )
            })
            .when_some(r.account.clone(), |d, a| {
                d.child(sep()).child(
                    div()
                        .id(ElementId::Name(format!("account-{id}").into()))
                        .debug_selector({
                            let s = format!("session-account-{i}");
                            move || s.clone()
                        })
                        .min_w_0()
                        .truncate()
                        .child(a.clone())
                        .tooltip(tooltip(format!("This session runs under account: {a}"))),
                )
            });
        let title_line = div()
            .flex()
            .items_baseline()
            .gap(px(8.))
            .min_w_0()
            .child(
                div()
                    .min_w_0()
                    .truncate()
                    .map(text_px(14., 20.))
                    .font_weight(FontWeight::MEDIUM)
                    .child(r.title.clone()),
            )
            .child(
                div()
                    .flex_none()
                    .map(text_px(10., 14.))
                    .font_family(fonts::MONO)
                    .text_color(c.muted)
                    .child(r.short_id.clone()),
            )
            .when(unread > 0, |d| {
                d.child(
                    div()
                        .id(ElementId::Name(format!("unread-{id}").into()))
                        .debug_selector({
                            let s = format!("session-row-unread-{i}");
                            move || s.clone()
                        })
                        .flex_none()
                        .px(px(6.))
                        .py(px(1.))
                        .rounded_full()
                        .map(text_px(9., 10.))
                        .font_weight(FontWeight::SEMIBOLD)
                        .bg(c.alpha(c.accent, 85.))
                        .text_color(c.background)
                        .child(format!("{} new", badge_count(unread)))
                        .tooltip(tooltip(format!(
                            "{unread} new notification{} — open the session to clear",
                            if unread == 1 { "" } else { "s" }
                        ))),
                )
            });
        let open_href = href.clone();
        let main = div()
            .id(ElementId::Name(format!("open-{id}").into()))
            .debug_selector({
                let s = format!("session-open-{i}");
                move || s.clone()
            })
            .flex_1()
            .min_w_0()
            .child(title_line)
            .child(meta)
            .when_some(r.first_prompt.clone(), |d, p| {
                d.child(
                    div()
                        .mt(px(4.))
                        .line_clamp(2)
                        .map(text_px(12., 16.))
                        .text_color(c.muted)
                        .child(p),
                )
            })
            .when_some(r.snippet.clone(), |d, s| {
                d.child(
                    div()
                        .debug_selector({
                            let s = format!("session-snippet-{i}");
                            move || s.clone()
                        })
                        .mt(px(4.))
                        .flex()
                        .gap(px(4.))
                        .items_center()
                        .map(text_px(12., 16.))
                        .text_color(c.muted)
                        .child(
                            div()
                                .flex_none()
                                .px(px(4.))
                                .rounded(px(4.))
                                .bg(c.panel_2)
                                .map(text_px(10., 14.))
                                .text_color(c.accent)
                                .child("IN TRANSCRIPT"),
                        )
                        .child(div().min_w_0().truncate().font_family(fonts::MONO).child(s)),
                )
            })
            .on_click(cx.listener(move |this, _, _, cx| this.open_url(open_href.clone(), cx)));
        let shown = r.selected;
        let action = |name: &str, label: &'static str, danger: bool| {
            let sel = format!("session-{name}-{i}");
            div()
                .id(ElementId::Name(format!("{name}-{id}").into()))
                .debug_selector(move || sel.clone())
                .px(px(8.))
                .py(px(4.))
                .rounded(px(6.))
                .border_1()
                .map(text_px(11., 14.))
                .when(!danger, |d| {
                    d.border_color(c.border)
                        .bg(c.panel_2)
                        .hover(|d| d.bg(c.panel))
                })
                .when(danger, |d| {
                    d.border_color(tw("red-500", 30.))
                        .bg(tw("red-500", 10.))
                        .text_color(tw("red-300", 100.))
                        .hover(|d| d.bg(tw("red-500", 20.)))
                })
                .child(label)
        };
        let (resume_id, export_id, delete_id) = (id.clone(), id.clone(), id.clone());
        let actions = div()
            .flex()
            .flex_none()
            .items_center()
            .gap(px(4.))
            .when(!shown, |d| {
                d.opacity(0.).group_hover("session-row", |s| s.opacity(1.))
            })
            .child(action("resume", "Resume", false).on_click(cx.listener(
                move |this, _, _, cx| {
                    let id = resume_id.clone();
                    this.list_action(cx, |l| l.resume(&id))
                },
            )))
            .child(action("export", "Export", false).on_click(cx.listener(
                move |this, _, _, cx| {
                    let id = export_id.clone();
                    this.list_action(cx, |l| l.export(&id))
                },
            )))
            .child(action("delete", "Delete", true).on_click(cx.listener(
                move |this, _, _, cx| {
                    let id = delete_id.clone();
                    this.list_action(cx, |l| {
                        l.ask_delete(&id);
                        Vec::new()
                    })
                },
            )));
        let select_id = id.clone();
        div()
            .id(ElementId::Name(format!("row-{id}").into()))
            .debug_selector({
                let s = format!("session-row-{i}");
                move || s.clone()
            })
            .group("session-row")
            .flex()
            .items_start()
            .gap(px(12.))
            .px(px(16.))
            .py(px(12.))
            .relative()
            .border_b_1()
            .border_color(c.border)
            .when(unread > 0, |d| {
                // `border-l-2 border-l-[var(--accent)]`.
                d.bg(c.alpha(c.accent, 5.)).child(
                    div()
                        .absolute()
                        .left_0()
                        .top_0()
                        .bottom_0()
                        .w(px(2.))
                        .bg(c.accent),
                )
            })
            .when(shown, |d| d.bg(c.alpha(c.panel_2, 60.)))
            .hover(|d| d.bg(c.alpha(c.panel, 40.)))
            .child(main)
            .child(actions)
            .on_mouse_down(
                gpui_kit::MouseButton::Left,
                cx.listener(move |this, _, _, cx| {
                    if let Some(l) = this.list_mut() {
                        l.select(&select_id);
                        cx.notify();
                    }
                }),
            )
            .into_any_element()
    }

    fn render_detail(
        &self,
        c: &Colors,
        _window: &mut Window,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let Page::Detail(d) = &self.page else {
            return div().into_any_element();
        };
        let red = tw("red-400", 100.);
        let title_part = if d.renaming() {
            div()
                .flex()
                .flex_none()
                .items_center()
                .gap(px(8.))
                .child(
                    div()
                        .debug_selector(|| "session-rename-input".into())
                        .w(px(260.))
                        .on_action(cx.listener(|this, _: &InputEscape, window, cx| {
                            this.cancel_rename(window, cx)
                        }))
                        .child(Input::new(&self.rename).h(px(24.)).text_size(px(12.))),
                )
                .child(
                    div()
                        .id("session-rename-save")
                        .debug_selector(|| "session-rename-save".into())
                        .text_color(c.accent)
                        .hover(|d| d.underline())
                        .child("Save")
                        .on_click(cx.listener(|this, _, _, cx| this.save_rename(cx))),
                )
                .child(
                    div()
                        .id("session-rename-cancel")
                        .debug_selector(|| "session-rename-cancel".into())
                        .text_color(c.muted)
                        .hover(|d| d.underline())
                        .child("Cancel")
                        .on_click(
                            cx.listener(|this, _, window, cx| this.cancel_rename(window, cx)),
                        ),
                )
        } else {
            div()
                .flex()
                .min_w_0()
                .items_center()
                .gap(px(8.))
                .child(
                    div()
                        .debug_selector(|| "session-title".into())
                        .min_w_0()
                        .truncate()
                        .font_weight(FontWeight::MEDIUM)
                        .child(d.title(self.now_year())),
                )
                .child(
                    div()
                        .id("session-rename")
                        .debug_selector(|| "session-rename".into())
                        .flex_none()
                        .p(px(2.))
                        .rounded(px(4.))
                        .hover(|d| d.bg(c.panel_2))
                        .child(icon(IconName::Pen, 12., c.muted))
                        .tooltip(tooltip("Rename".into()))
                        .on_click(cx.listener(|this, _, window, cx| this.start_rename(window, cx))),
                )
        };
        let header_button =
            |name: &'static str, glyph: IconName, label: &'static str, c: &Colors| {
                plain_button(name, name.to_owned(), c)
                    .child(icon(glyph, 12., c.foreground))
                    .child(label)
            };
        let actions = div()
            .ml_auto()
            .flex()
            .flex_none()
            .items_center()
            .gap(px(4.))
            .child(
                button("session-resume", "session-resume".into(), c)
                    .bg(c.alpha(c.accent, 10.))
                    .text_color(c.accent)
                    .hover(|d| d.bg(c.alpha(c.accent, 20.)))
                    .child(icon(IconName::Play, 12., c.accent))
                    .child("Resume")
                    .on_click(cx.listener(|this, _, _, cx| this.detail_action(cx, |d| d.resume()))),
            )
            .child(
                header_button("session-fork", IconName::GitBranch, "Fork", c)
                    .on_click(cx.listener(|this, _, _, cx| this.detail_action(cx, |d| d.fork()))),
            )
            .child(
                header_button("session-export", IconName::Download, "Export", c)
                    .on_click(cx.listener(|this, _, _, cx| this.detail_action(cx, |d| d.export()))),
            )
            .child(
                plain_button("session-raw", "session-raw".into(), c)
                    .when(d.show_raw(), |b| b.bg(c.panel))
                    .child(icon(IconName::FileBraces, 12., c.foreground))
                    .child(if d.show_raw() { "Pretty" } else { "Raw" })
                    .on_click(cx.listener(|this, _, _, cx| {
                        this.detail_action(cx, |d| {
                            d.toggle_raw();
                            Vec::new()
                        })
                    })),
            )
            .child(
                button("session-delete", "session-delete".into(), c)
                    .border_color(tw("red-500", 30.))
                    .bg(tw("red-500", 10.))
                    .text_color(tw("red-300", 100.))
                    .hover(|d| d.bg(tw("red-500", 20.)))
                    .child(icon(IconName::Trash, 12., tw("red-300", 100.)))
                    .child("Delete")
                    .on_click(cx.listener(|this, _, _, cx| {
                        this.detail_action(cx, |d| {
                            d.ask_delete();
                            Vec::new()
                        })
                    })),
            );
        let header = div()
            .id("session-header")
            .debug_selector(|| "session-header".into())
            .flex()
            .flex_none()
            .items_center()
            .h(px(36.))
            .gap(px(12.))
            .px(px(16.))
            .border_b_1()
            .border_color(c.border)
            .bg(c.panel)
            .map(text_px(12., 16.))
            .child(
                div()
                    .id("session-back")
                    .debug_selector(|| "session-back".into())
                    .flex()
                    .flex_none()
                    .items_center()
                    .gap(px(4.))
                    .text_color(c.muted)
                    .hover(|d| d.text_color(c.foreground))
                    .child(icon(IconName::ArrowLeft, 14., c.muted))
                    .child("Sessions")
                    .on_click(cx.listener(|this, _, _, cx| this.open_url("/sessions".into(), cx))),
            )
            .child(dot(c))
            .child(title_part)
            .child(
                div()
                    .flex_none()
                    .map(text_px(10., 14.))
                    .font_family(fonts::MONO)
                    .text_color(c.muted)
                    .child(crate::tabs::short_id(d.id())),
            )
            .when_some(d.error(), |h, e| {
                h.child(
                    div()
                        .debug_selector(|| "session-detail-error".into())
                        .min_w_0()
                        .truncate()
                        .text_color(red)
                        .child(e.to_owned()),
                )
            })
            .when_some(d.notice(), |h, n| {
                h.child(
                    div()
                        .debug_selector(|| "session-notice".into())
                        .min_w_0()
                        .truncate()
                        .text_color(c.muted)
                        .child(n.to_owned()),
                )
            })
            .when(d.loading(), |h| {
                h.child(div().flex_none().text_color(c.muted).child("loading…"))
            })
            .child(actions);
        let meta = d.meta();
        let meta_bar = (!meta.is_empty()).then(|| {
            let mono = |i: usize, s: &str| {
                i == 0 && !s.starts_with("updated ") && !s.starts_with("created ")
            };
            div()
                .debug_selector(|| "session-meta".into())
                .flex()
                .flex_none()
                .flex_wrap()
                .items_center()
                .gap(px(12.))
                .px(px(16.))
                .py(px(8.))
                .border_b_1()
                .border_color(c.border)
                .bg(c.alpha(c.panel, 40.))
                .map(text_px(11., 16.))
                .text_color(c.muted)
                .children(meta.into_iter().enumerate().map(|(i, s)| {
                    div()
                        .when(mono(i, &s) || s.starts_with("branch: "), |d| {
                            d.font_family(fonts::MONO)
                        })
                        .child(s)
                }))
        });
        let partial = d.history_error().map(|e| {
            div()
                .id("session-history-partial")
                .debug_selector(|| "session-history-partial".into())
                .flex_none()
                .px(px(16.))
                .py(px(6.))
                .border_b_1()
                .border_color(c.border)
                .bg(tw("amber-500", 10.))
                .map(text_px(11., 16.))
                .text_color(tw("amber-300", 100.))
                .child("Showing only the messages since the last compaction. The earlier ones couldn't be read.")
                .tooltip(tooltip(e.to_owned()))
        });
        let body = if d.show_raw() {
            div()
                .debug_selector(|| "session-raw-text".into())
                .mx_auto()
                .w_full()
                .max_w(px(896.))
                .px(px(16.))
                .py(px(24.))
                .font_family(fonts::MONO)
                .map(text_px(10.5, 16.))
                .text_color(c.muted)
                .child(d.raw())
                .into_any_element()
        } else {
            let rewinding = d.rewinding().map(str::to_owned);
            div()
                .debug_selector(|| "session-transcript".into())
                .mx_auto()
                .w_full()
                .max_w(px(896.))
                .px(px(16.))
                .py(px(24.))
                .flex()
                .flex_col()
                .gap(px(24.))
                .children(
                    d.rows()
                        .into_iter()
                        .enumerate()
                        .map(|(i, row)| self.transcript_row(i, row, rewinding.as_deref(), c, cx)),
                )
                .into_any_element()
        };
        div()
            .flex()
            .flex_col()
            .flex_1()
            .min_h_0()
            .size_full()
            .child(header)
            .children(meta_bar)
            .children(partial)
            .child(
                div()
                    .id("session-body")
                    .flex_1()
                    .min_h_0()
                    .overflow_y_scroll()
                    .child(body),
            )
            .into_any_element()
    }

    fn toggle_open(&mut self, key: String, cx: &mut Context<Self>) {
        if !self.open.remove(&key) {
            self.open.insert(key);
        }
        cx.notify();
    }

    fn transcript_row(
        &self,
        i: usize,
        row: Row,
        rewinding: Option<&str>,
        c: &Colors,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        match row {
            Row::Compaction {
                uuid,
                stats,
                summary,
            } => {
                let key = format!("compaction:{uuid}");
                let expanded = self.open.contains(&key);
                let line = || div().h(px(1.)).flex_1().bg(c.border);
                div()
                    .debug_selector({
                        let s = format!("transcript-compaction-{i}");
                        move || s.clone()
                    })
                    .flex()
                    .flex_col()
                    .gap(px(4.))
                    .map(text_px(11., 16.))
                    .text_color(c.muted)
                    .child(
                        div()
                            .flex()
                            .items_center()
                            .gap(px(12.))
                            .child(line())
                            .child(
                                div()
                                    .flex()
                                    .items_center()
                                    .gap(px(8.))
                                    .child(icon(IconName::GitMerge, 14., tw("violet-400", 100.)))
                                    .child(
                                        div()
                                            .font_weight(FontWeight::MEDIUM)
                                            .child(COMPACTION_LABEL),
                                    )
                                    .when_some(stats, |d, s| {
                                        d.child(div().opacity(0.7).child(format!("· {s}")))
                                    })
                                    .when(summary.as_ref().is_some_and(|s| !s.is_empty()), |d| {
                                        d.child(
                                            div()
                                                .id(ElementId::Name(
                                                    format!("summary-{uuid}").into(),
                                                ))
                                                .debug_selector({
                                                    let s = format!("transcript-summary-{i}");
                                                    move || s.clone()
                                                })
                                                .px(px(6.))
                                                .py(px(2.))
                                                .rounded(px(4.))
                                                .border_1()
                                                .border_color(c.border)
                                                .bg(c.panel_2)
                                                .map(text_px(10., 12.))
                                                .hover(|d| d.bg(c.panel))
                                                .child(if expanded {
                                                    "▾ hide summary"
                                                } else {
                                                    "▸ show summary"
                                                })
                                                .on_click(cx.listener(move |this, _, _, cx| {
                                                    this.toggle_open(key.clone(), cx)
                                                })),
                                        )
                                    }),
                            )
                            .child(line()),
                    )
                    .when(expanded, |d| {
                        d.child(
                            div()
                                .mt(px(4.))
                                .p(px(12.))
                                .rounded(px(6.))
                                .border_1()
                                .border_color(c.border)
                                .bg(c.alpha(c.panel, 50.))
                                .map(text_px(12., 18.))
                                .child(summary.unwrap_or_default()),
                        )
                    })
                    .into_any_element()
            }
            Row::System { text, .. } => div()
                .map(text_px(11., 16.))
                .text_color(c.muted)
                .child(div().opacity(0.6).child(text))
                .into_any_element(),
            Row::User { uuid, text } => {
                let busy = rewinding == Some(uuid.as_str());
                let rewind_uuid = uuid.clone();
                div()
                    .id(ElementId::Name(format!("user-{uuid}").into()))
                    .debug_selector({
                        let s = format!("transcript-user-{i}");
                        move || s.clone()
                    })
                    .group("transcript-user")
                    .flex()
                    .justify_end()
                    .child(
                        div()
                            .max_w(gpui_kit::relative(0.8))
                            .px(px(16.))
                            .py(px(8.))
                            .rounded(px(16.))
                            .border_1()
                            .border_color(c.border)
                            .bg(c.panel_2)
                            .map(text_px(14., 24.))
                            .child(text)
                            .child(
                                div().mt(px(8.)).flex().justify_end().child(
                                    div()
                                        .id(ElementId::Name(format!("rewind-{uuid}").into()))
                                        .debug_selector({
                                            let s = format!("transcript-rewind-{i}");
                                            move || s.clone()
                                        })
                                        .map(text_px(10., 14.))
                                        .text_color(c.muted)
                                        .when(busy, |d| d.opacity(0.4))
                                        .when(!busy, |d| {
                                            d.opacity(0.)
                                                .group_hover("transcript-user", |s| s.opacity(1.))
                                                .hover(|d| d.text_color(c.foreground))
                                        })
                                        .child(if busy {
                                            "Forking…"
                                        } else {
                                            "↺ Rewind here"
                                        })
                                        .when(!busy, |d| {
                                            d.on_click(cx.listener(move |this, _, _, cx| {
                                                let uuid = rewind_uuid.clone();
                                                this.detail_action(cx, |d| d.rewind(&uuid))
                                            }))
                                        }),
                                ),
                            ),
                    )
                    .into_any_element()
            }
            Row::Assistant { uuid, blocks } => div()
                .debug_selector({
                    let s = format!("transcript-assistant-{i}");
                    move || s.clone()
                })
                .flex()
                .flex_col()
                .gap(px(4.))
                .child(
                    div()
                        .flex()
                        .items_center()
                        .gap(px(8.))
                        .map(text_px(11., 16.))
                        .text_color(c.muted)
                        .child(div().size(px(6.)).rounded_full().bg(c.accent))
                        .child("Claude"),
                )
                .child(
                    div()
                        .flex()
                        .flex_col()
                        .gap(px(8.))
                        .map(text_px(14., 28.))
                        .children(
                            blocks
                                .into_iter()
                                .enumerate()
                                .map(|(j, b)| self.block(&uuid, j, b, c, cx)),
                        ),
                )
                .into_any_element(),
        }
    }

    fn block(
        &self,
        uuid: &str,
        j: usize,
        b: Block,
        c: &Colors,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let key = format!("block:{uuid}:{j}");
        let expanded = self.open.contains(&key);
        let details = |summary: AnyElement, inner: AnyElement, bg: f64| {
            let key = key.clone();
            div()
                .flex()
                .flex_col()
                .rounded(px(6.))
                .border_1()
                .border_color(c.border)
                .bg(c.alpha(c.panel, bg))
                .map(text_px(12., 16.))
                .child(
                    div()
                        .id(ElementId::Name(key.clone().into()))
                        .flex()
                        .items_center()
                        .gap(px(4.))
                        .px(px(12.))
                        .py(px(6.))
                        .child(icon(
                            if expanded {
                                IconName::ChevronDown
                            } else {
                                IconName::ChevronRight
                            },
                            12.,
                            c.muted,
                        ))
                        .child(summary)
                        .on_click(
                            cx.listener(move |this, _, _, cx| this.toggle_open(key.clone(), cx)),
                        ),
                )
                .when(expanded, |d| d.child(inner))
                .into_any_element()
        };
        match b {
            Block::Text(t) => div().child(t).into_any_element(),
            Block::Thinking(t) => details(
                div()
                    .text_color(c.muted)
                    .child("Thinking")
                    .into_any_element(),
                div()
                    .px(px(12.))
                    .py(px(8.))
                    .border_t_1()
                    .border_color(c.border)
                    .font_family(fonts::MONO)
                    .text_color(c.muted)
                    .child(t)
                    .into_any_element(),
                50.,
            ),
            Block::ToolUse { name, input, .. } => details(
                div()
                    .flex()
                    .items_center()
                    .gap(px(4.))
                    .child(icon(IconName::Wrench, 12., c.accent))
                    .child(name)
                    .into_any_element(),
                div()
                    .p(px(8.))
                    .max_h(px(240.))
                    .overflow_hidden()
                    .bg(c.panel_2)
                    .font_family(fonts::MONO)
                    .child(input)
                    .into_any_element(),
                40.,
            ),
            Block::ToolResult { .. } => div().into_any_element(),
        }
    }
}

/// The browser's `confirm()`, over the screen.
fn confirm_dialog(message: &str, c: &Colors, cx: &mut Context<SessionsScreen>) -> AnyElement {
    let choice = |id: &'static str, label: &'static str, primary: bool| {
        div()
            .id(id)
            .debug_selector(move || id.into())
            .px(px(12.))
            .py(px(6.))
            .rounded(px(6.))
            .border_1()
            .border_color(c.border)
            .text_size(px(12.))
            .when(primary, |d| {
                d.bg(c.accent)
                    .text_color(Colors::white())
                    .border_color(c.accent)
            })
            .when(!primary, |d| d.bg(c.panel).hover(|d| d.bg(c.panel_2)))
            .child(label)
    };
    let answer = |yes: bool| {
        cx.listener(
            move |this: &mut SessionsScreen, _, _, cx| match &mut this.page {
                Page::List(l) => {
                    let effects = l.confirm_delete(yes);
                    this.run_list(effects, cx);
                }
                Page::Detail(d) => {
                    let effects = d.confirm_delete(yes);
                    this.run_detail(effects, cx);
                }
                Page::None => {}
            },
        )
    };
    div()
        .id("sessions-confirm")
        .debug_selector(|| "sessions-confirm".into())
        .absolute()
        .inset_0()
        .flex()
        .items_center()
        .justify_center()
        .bg(tw("black", 40.))
        .occlude()
        .child(
            div()
                .w(px(380.))
                .p(px(16.))
                .rounded(px(8.))
                .border_1()
                .border_color(c.border)
                .bg(c.panel)
                .shadow_2xl()
                .flex()
                .flex_col()
                .gap(px(12.))
                .child(
                    div()
                        .text_size(px(13.))
                        .child(SharedString::from(message.to_owned())),
                )
                .child(
                    div()
                        .flex()
                        .justify_end()
                        .gap(px(8.))
                        .child(
                            choice("sessions-confirm-no", "Cancel", false).on_click(answer(false)),
                        )
                        .child(choice("sessions-confirm-yes", "OK", true).on_click(answer(true))),
                ),
        )
        .into_any_element()
}
