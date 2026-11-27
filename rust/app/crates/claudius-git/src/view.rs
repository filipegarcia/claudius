//! [`GitScreen`]: the Git page on screen over a [`GitData`]. The host keeps
//! one, tells it the workspace whenever the route shows the page
//! ([`GitScreen::sync`]: `None` unmounts it, as leaving the route does),
//! and draws it as the content area. The page's rules are [`GitPage`]'s;
//! this carries out its [`Out`]s (the requests, the poll's timer, the
//! questions) and draws its state.
//!
//! U12b's seams, each a [`GitEvent`] the host may handle (none is drawn
//! here yet):
//! - `FileEditor`: the TS diff pane mounts the editor for a file that is on
//!   disk (`canEdit`); [`GitScreen`] draws the read-only `DiffViewer` for
//!   every file and leaves the Unified / Split toggle to the editor.
//! - `GitConsole`: "View in console →" opens [`GitPage::console`] and emits
//!   [`GitEvent::ShowConsole`].
//! - `ChangeContextMenu`: a row's right click selects it and emits
//!   [`GitEvent::ContextMenu`].
//! - `GitFileView` / `Window`: a row's double click (or its "Open in new
//!   window" button) emits [`GitEvent::OpenInWindow`].

use std::sync::Arc;
use std::time::{Duration, Instant};

use claudius_gpui_theme::{ThemeName, fonts, hsla, icons};
use claudius_theme::{Rgba, Theme as Tokens, color, tailwind};
use futures::FutureExt as _;
use futures::future::BoxFuture;
use gpui_kit::component::Icon;
use gpui_kit::component::input::{Input, InputEvent, InputState, Textarea, TextareaState};
use gpui_kit::component::tooltip::Tooltip;
use gpui_kit::prelude::FluentBuilder as _;
use gpui_kit::{
    AnyElement, App, AppContext as _, Context, Div, ElementId, Entity, EventEmitter, FocusHandle,
    FontWeight, Hsla, InteractiveElement as _, IntoElement, KeyBinding, MouseButton,
    ParentElement as _, Pixels, Point, Render, SharedString, Stateful,
    StatefulInteractiveElement as _, Styled, Subscription, Task, Window, WindowVisibility,
    deferred, div, px,
};

use crate::branches::{self, BranchAction, BranchPrompt};
use crate::changes::{self, DiffMode, DiffSelection, DirNode, GROUPS};
use crate::commit_box::CommitBox;
use crate::data::GitData;
use crate::diff::{DiffView, Line, diff_view};
use crate::page::{self, GitPage, Out, Reply, Req, Scope};
use crate::pr_badge::{self, BadgeTone};
use crate::types::{BranchInfo, GitFileChange, js_number, plural};

gpui_kit::actions!(
    git,
    [
        SelectNext,
        SelectPrev,
        DeleteSelected,
        Dismiss,
        CommitAndPush
    ]
);

/// The screen's key context.
pub const CONTEXT: &str = "GitScreen";
/// The commit box's key context (⌘⇧⏎).
pub const COMMIT_CONTEXT: &str = "GitCommitBox";

/// The page's keys: ↑ ↓ walk the changes, Delete / Backspace delete the
/// selected one (asking first), Escape closes the popover, and ⌘⇧⏎ in the
/// message runs Commit & Push (⌘⏎, the text area's secondary Enter, commits).
pub fn bind(cx: &mut App) {
    let combo = if cfg!(target_os = "macos") {
        "cmd-shift-enter"
    } else {
        "ctrl-shift-enter"
    };
    cx.bind_keys([
        KeyBinding::new("down", SelectNext, Some(CONTEXT)),
        KeyBinding::new("up", SelectPrev, Some(CONTEXT)),
        KeyBinding::new("delete", DeleteSelected, Some(CONTEXT)),
        KeyBinding::new("backspace", DeleteSelected, Some(CONTEXT)),
        KeyBinding::new("escape", Dismiss, Some(CONTEXT)),
        KeyBinding::new(combo, CommitAndPush, Some(COMMIT_CONTEXT)),
    ]);
}

/// What the screen asks its host for.
#[derive(Clone, Debug, PartialEq)]
pub enum GitEvent {
    /// `router.push(url)` (the Chat link, a conflict's new chat).
    Navigate(String),
    /// `GitFileView` / `Window` (U12b): the change in its own window.
    OpenInWindow(DiffSelection),
    /// `GitConsole` (U12b): "View in console →".
    ShowConsole,
    /// `ChangeContextMenu` (U12b): a row's right click, at the pointer.
    ContextMenu {
        path: String,
        mode: DiffMode,
        position: Point<Pixels>,
    },
}

/// The page's palette colors and the Tailwind steps it uses.
#[derive(Clone, Copy)]
struct Colors {
    background: Rgba,
    foreground: Rgba,
    panel: Rgba,
    panel_2: Rgba,
    border: Rgba,
    muted: Rgba,
    accent: Rgba,
}

impl Colors {
    fn of(theme: ThemeName) -> Colors {
        let p = Tokens::of(theme).palette;
        Colors {
            background: p.background,
            foreground: p.foreground,
            panel: p.panel,
            panel_2: p.panel_2,
            border: p.border,
            muted: p.muted,
            accent: p.accent,
        }
    }
}

fn h(c: Rgba) -> Hsla {
    hsla(c)
}

/// Tailwind's `/N`.
fn a(c: Rgba, pct: f64) -> Hsla {
    hsla(color::with_opacity(c, pct))
}

fn step(name: &str) -> Rgba {
    tailwind::color(name).unwrap_or_else(|| panic!("{name} is a Tailwind step"))
}

fn icon(name: &str, size: f32, color: Hsla) -> AnyElement {
    match icons::icon(name) {
        Some(i) => Icon::new(i)
            .size(px(size))
            .text_color(color)
            .into_any_element(),
        None => div().size(px(size)).into_any_element(),
    }
}

fn tooltip(text: String) -> impl Fn(&mut Window, &mut App) -> gpui_kit::AnyView {
    move |window, cx| Tooltip::new(text.clone()).build(window, cx)
}

fn text_px<E: Styled>(size: f32, line: f32) -> impl Fn(E) -> E {
    move |d: E| d.text_size(px(size)).line_height(px(line))
}

fn sel(id: String) -> impl Fn() -> String {
    move || id.clone()
}

/// A clickable element with a test selector.
fn hit(id: impl Into<String>) -> Stateful<Div> {
    let id: String = id.into();
    div()
        .id(ElementId::Name(id.clone().into()))
        .debug_selector(sel(id))
}

/// A checkbox (`accent-[var(--accent)]`): `Some(true)` checked, `None`
/// indeterminate.
fn checkbox(id: String, state: Option<bool>, enabled: bool, c: &Colors) -> Stateful<Div> {
    let on = state != Some(false);
    hit(id)
        .flex()
        .flex_none()
        .items_center()
        .justify_center()
        .size(px(12.))
        .rounded(px(3.))
        .border_1()
        .border_color(if on { h(c.accent) } else { h(c.muted) })
        .when(on, |d| d.bg(h(c.accent)))
        .when(!enabled, |d| d.opacity(0.4))
        .when(state == Some(true), |d| {
            d.child(icon("Check", 9., h(step("white"))))
        })
        .when(state.is_none(), |d| {
            d.child(div().w(px(6.)).h(px(1.5)).bg(h(step("white"))))
        })
}

/// A header button (`flex h-6 items-center gap-1 rounded px-1.5`).
fn header_button(id: &str, enabled: bool, c: &Colors) -> Stateful<Div> {
    header_button_hover(id, enabled, c, h(c.panel_2), h(c.foreground))
}

/// [`header_button`] with its own hover colors.
fn header_button_hover(
    id: &str,
    enabled: bool,
    c: &Colors,
    panel_2: Hsla,
    fg: Hsla,
) -> Stateful<Div> {
    hit(id)
        .flex()
        .flex_none()
        .items_center()
        .gap(px(4.))
        .h(px(24.))
        .px(px(6.))
        .rounded(px(4.))
        .text_color(h(c.muted))
        .when(enabled, |d| d.hover(move |d| d.bg(panel_2).text_color(fg)))
        .when(!enabled, |d| d.opacity(0.4))
}

/// A count pill on a sync button.
fn count_badge(id: &str, n: f64, c: &Colors) -> Div {
    let id = id.to_owned();
    div()
        .debug_selector(sel(id))
        .ml(px(2.))
        .min_w(px(14.))
        .px(px(4.))
        .flex()
        .justify_center()
        .rounded_full()
        .bg(a(c.accent, 20.))
        .font_family(fonts::MONO)
        .map(text_px(10., 12.))
        .text_color(h(c.accent))
        .child(js_number(n))
}

/// `StatusIcon` (ChangesList.tsx:1031).
fn status_icon(code: &str, c: &Colors) -> AnyElement {
    let (name, tone) = match code {
        "A" => ("FilePlus", h(step("emerald-400"))),
        "M" | "T" => ("FileDiff", h(step("amber-400"))),
        "D" => ("FileX", h(step("red-400"))),
        "R" | "C" => ("ArrowRightLeft", h(step("sky-400"))),
        "?" => ("FileQuestion", h(c.muted)),
        _ => ("FileDiff", h(c.muted)),
    };
    icon(name, 12., tone)
}

const ROW_INSET_PX: f32 = 12.;
const INDENT_STEP_PX: f32 = 18.;
const PANEL_WIDTH: f32 = 360.;

/// The page's ids for its requests: the page they belong to and the ticket.
struct Mounted {
    page: GitPage,
    generation: u64,
}

pub struct GitScreen {
    data: Arc<dyn GitData>,
    mounted: Option<Mounted>,
    generation: u64,
    theme: ThemeName,
    /// `claudius.git.groupByDirectory`: kept across mounts.
    group_by_directory: bool,
    view_options_open: bool,
    hidden: bool,
    focus: Option<FocusHandle>,
    message: Option<Entity<TextareaState>>,
    /// The commit box revision the text area shows.
    shown_revision: Option<(u64, u64)>,
    /// The placeholder and disabled state the text area shows.
    shown_placeholder: Option<(&'static str, bool)>,
    branch_filter: Option<Entity<InputState>>,
    prompt_input: Option<Entity<InputState>>,
    /// The prompt the input was last filled for.
    prompt_shown: Option<BranchPrompt>,
    /// Where the press that closed the branch popover from outside was:
    /// the chip's click on that same press doesn't reopen it (the TS
    /// outside-click `ref` wraps the chip too, BranchSwitcher.tsx:447).
    popover_closed_at: Option<Point<Pixels>>,
    poll_timer: Option<Task<()>>,
    _subscriptions: Vec<Subscription>,
}

impl EventEmitter<GitEvent> for GitScreen {}

/// The request `req` answered, as a [`Reply`].
fn request(data: &Arc<dyn GitData>, ws: &str, req: Req) -> BoxFuture<'static, Reply> {
    match req {
        Req::Status => {
            let started = Instant::now();
            let f = data.status(ws);
            async move {
                let r = f.await;
                Reply::Status(r, started.elapsed().as_secs_f64() * 1000.)
            }
            .boxed()
        }
        Req::Diff { path, mode } => data.diff(ws, &path, mode).map(Reply::Diff).boxed(),
        Req::Stage { paths, op } => data.stage(ws, &paths, op).map(Reply::Done).boxed(),
        Req::Commit {
            message,
            stage_paths,
        } => data
            .commit(ws, &message, &stage_paths)
            .map(Reply::Commit)
            .boxed(),
        Req::CommitMessage { paths } => data.commit_message(ws, &paths).map(Reply::Text).boxed(),
        Req::GetDraft => data.commit_draft(ws).map(Reply::Text).boxed(),
        Req::SaveDraft { message } => data
            .save_commit_draft(ws, &message)
            .map(Reply::Done)
            .boxed(),
        Req::ClearDraft => data.clear_commit_draft(ws).map(Reply::Done).boxed(),
        Req::Branches => data.branches(ws).map(Reply::Branches).boxed(),
        Req::Checkout {
            name,
            create,
            start_point,
        } => data
            .checkout(ws, &name, create, start_point.as_deref())
            .map(Reply::Done)
            .boxed(),
        Req::Rename { old_name, new_name } => data
            .rename_branch(ws, &old_name, &new_name)
            .map(Reply::Output)
            .boxed(),
        Req::Delete { name, target } => data
            .delete_branch(ws, &name, target)
            .map(Reply::Output)
            .boxed(),
        Req::Compare { base, head } => data
            .compare_branches(ws, &base, &head)
            .map(Reply::Output)
            .boxed(),
        Req::DiffWithWorktree { head } => data
            .diff_with_worktree(ws, &head)
            .map(Reply::Output)
            .boxed(),
        Req::Merge { name } => data.merge(ws, &name).map(Reply::Merge).boxed(),
        Req::Rebase {
            onto,
            checkout_branch,
        } => data
            .rebase(ws, &onto, checkout_branch.as_deref())
            .map(Reply::Merge)
            .boxed(),
        Req::PullMerge => data.pull_merge(ws).map(Reply::Merge).boxed(),
        Req::Remote { op } => data.remote(ws, op).map(Reply::Output).boxed(),
        Req::PrStatus => data.pr_status(ws).map(Reply::Pr).boxed(),
    }
}

impl GitScreen {
    /// The screen over `data`, showing nothing until [`Self::sync`].
    pub fn new(data: Arc<dyn GitData>, _cx: &mut Context<Self>) -> Self {
        GitScreen {
            data,
            mounted: None,
            generation: 0,
            theme: ThemeName::Dark,
            group_by_directory: false,
            view_options_open: false,
            hidden: false,
            focus: None,
            message: None,
            shown_revision: None,
            shown_placeholder: None,
            branch_filter: None,
            prompt_input: None,
            prompt_shown: None,
            popover_closed_at: None,
            poll_timer: None,
            _subscriptions: Vec::new(),
        }
    }

    /// The page state (tests, the screenshots).
    pub fn page(&self) -> Option<&GitPage> {
        self.mounted.as_ref().map(|m| &m.page)
    }

    /// The route showed (`Some`) or left (`None`) the Git page of a
    /// workspace: a new workspace mounts a new page, the same one keeps it.
    pub fn sync(&mut self, scope: Option<Scope>, theme: ThemeName, cx: &mut Context<Self>) {
        let theme_changed = self.theme != theme;
        self.theme = theme;
        match (scope, self.mounted.as_mut()) {
            (None, None) => {}
            (None, Some(_)) => self.unmount(),
            (Some(s), Some(m)) if m.page.scope().id == s.id => {
                if m.page.scope() != &s {
                    m.page.set_scope(s);
                    cx.notify();
                }
            }
            (Some(s), _) => {
                self.unmount();
                self.generation += 1;
                let (mut page, outs) = GitPage::new(s);
                page.group_by_directory = self.group_by_directory;
                self.mounted = Some(Mounted {
                    page,
                    generation: self.generation,
                });
                self.shown_revision = None;
                self.run(outs, cx);
            }
        }
        if theme_changed {
            cx.notify();
        }
    }

    fn unmount(&mut self) {
        if let Some(mut m) = self.mounted.take() {
            m.page.dispose();
        }
        self.poll_timer = None;
        self.view_options_open = false;
        self.prompt_shown = None;
    }

    /// Runs a page step and carries out what it returns.
    pub fn act(&mut self, f: impl FnOnce(&mut GitPage) -> Vec<Out>, cx: &mut Context<Self>) {
        let Some(m) = self.mounted.as_mut() else {
            return;
        };
        let outs = f(&mut m.page);
        self.run(outs, cx);
    }

    fn run(&mut self, outs: Vec<Out>, cx: &mut Context<Self>) {
        let Some(m) = self.mounted.as_ref() else {
            return;
        };
        let generation = m.generation;
        let ws = m.page.scope().id.clone();
        for out in outs {
            match out {
                Out::Send(ticket, req) => {
                    let fut = request(&self.data, &ws, req);
                    cx.spawn(async move |this, cx| {
                        let reply = fut.await;
                        this.update(cx, |this, cx| {
                            if this.mounted.as_ref().map(|m| m.generation) == Some(generation) {
                                this.act(|p| p.reply(ticket, reply), cx);
                            }
                        })
                        .ok();
                    })
                    .detach();
                }
                Out::Arm { timer, ms } => {
                    let delay = Duration::from_millis(ms.max(0.) as u64);
                    self.poll_timer = Some(cx.spawn(async move |this, cx| {
                        cx.background_executor().timer(delay).await;
                        this.update(cx, |this, cx| {
                            if this.mounted.as_ref().map(|m| m.generation) == Some(generation) {
                                let visible = !this.hidden;
                                this.act(|p| p.timer_fired(timer, visible), cx);
                            }
                        })
                        .ok();
                    }));
                }
                Out::Navigate(url) => cx.emit(GitEvent::Navigate(url)),
            }
        }
        cx.notify();
    }

    fn set_hidden(&mut self, hidden: bool, cx: &mut Context<Self>) {
        if self.hidden == hidden {
            return;
        }
        self.hidden = hidden;
        if !hidden {
            self.act(GitPage::became_visible, cx);
        }
    }

    /// The text inputs, the focus and the visibility observer, at the first
    /// draw (the host makes the screen without a window).
    fn ensure_window_parts(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.focus.is_some() {
            return;
        }
        self.focus = Some(cx.focus_handle());
        let message = cx.new(|cx| TextareaState::new(window, cx).rows(3));
        let filter = cx.new(|cx| InputState::new(window, cx).placeholder("Search branches…"));
        let prompt = cx.new(|cx| InputState::new(window, cx));
        self._subscriptions = vec![
            cx.subscribe(
                &message,
                |this: &mut Self, input, ev: &InputEvent, cx| match ev {
                    InputEvent::Change => {
                        let text = input.read(cx).value().to_string();
                        if let Some(m) = this.mounted.as_mut()
                            && m.page.commit_box.message() != text
                        {
                            m.page.commit_box.set_message(&text);
                            cx.notify();
                        }
                    }
                    InputEvent::PressEnter {
                        secondary: true,
                        shift,
                    } => {
                        if *shift {
                            this.act(GitPage::combo, cx);
                        } else {
                            this.act(GitPage::submit, cx);
                        }
                    }
                    _ => {}
                },
            ),
            cx.subscribe(&filter, |this: &mut Self, input, ev: &InputEvent, cx| {
                if let InputEvent::Change = ev {
                    let text = input.read(cx).value().to_string();
                    if let Some(m) = this.mounted.as_mut() {
                        m.page.branches.filter = text;
                        cx.notify();
                    }
                }
            }),
            cx.subscribe(&prompt, |this: &mut Self, input, ev: &InputEvent, cx| {
                if let InputEvent::PressEnter { .. } = ev {
                    let text = input.read(cx).value().to_string();
                    this.act(|p| p.answer_branch_prompt(Some(&text)), cx);
                }
            }),
            cx.observe_window_visibility(window, |this: &mut Self, v, _window, cx| {
                this.set_hidden(v == WindowVisibility::Hidden, cx);
            }),
        ];
        self.message = Some(message);
        self.branch_filter = Some(filter);
        self.prompt_input = Some(prompt);
    }

    /// The model's text into the inputs: a reset of the commit box, the
    /// popover's filter, the prompt's default.
    fn sync_inputs(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some(m) = self.mounted.as_ref() else {
            return;
        };
        let cb = &m.page.commit_box;
        let rev = (m.generation, cb.revision());
        if self.shown_revision != Some(rev) {
            self.shown_revision = Some(rev);
            let text = cb.message().to_owned();
            if let Some(input) = &self.message {
                input.update(cx, |s, cx| s.set_value(text, window, cx));
            }
        }
        let placeholder = cb.placeholder();
        let generating = cb.generating;
        if self.shown_placeholder != Some((placeholder, generating))
            && let Some(input) = &self.message
        {
            self.shown_placeholder = Some((placeholder, generating));
            input.update(cx, |s, cx| {
                s.set_placeholder(placeholder, window, cx);
                s.set_disabled(generating, cx);
            });
        }
        let filter = m.page.branches.filter.clone();
        if let Some(input) = &self.branch_filter
            && input.read(cx).value().as_ref() != filter
        {
            input.update(cx, |s, cx| s.set_value(filter, window, cx));
        }
        let prompt = m.page.branches.prompt.clone();
        if prompt != self.prompt_shown {
            if let (Some(p), Some(input)) = (&prompt, &self.prompt_input) {
                let value = p.default_value();
                input.update(cx, |s, cx| {
                    s.set_value(value, window, cx);
                    s.focus(window, cx);
                });
            }
            self.prompt_shown = prompt;
        }
    }

    // ---- drawing ----------------------------------------------------------

    fn header(&self, p: &GitPage, c: &Colors, cx: &mut Context<Self>) -> AnyElement {
        let busy = p.busy;
        let repo = p.is_repo();
        let sync_ok = p.sync_enabled();
        let stage_ok = p.stage_enabled();
        let ahead = p.ahead();
        let behind = p.behind();
        let label = |b: page::Busy, idle: &'static str, running: &'static str| {
            if busy == Some(b) { running } else { idle }
        };
        let (fg, muted) = (h(c.foreground), h(c.muted));
        let mut row = div()
            .flex()
            .flex_none()
            .items_center()
            .gap(px(12.))
            .h(px(36.))
            .px(px(16.))
            .border_b_1()
            .border_color(h(c.border))
            .bg(h(c.panel))
            .map(text_px(12., 16.))
            .child(
                hit("git-chat-link")
                    .flex()
                    .items_center()
                    .gap(px(4.))
                    .text_color(muted)
                    .hover(move |d| d.text_color(fg))
                    .child(icon("ArrowLeft", 14., muted))
                    .child("Chat")
                    .on_click(cx.listener(|_, _, _, cx| {
                        cx.emit(GitEvent::Navigate("/".into()));
                    })),
            )
            .child(div().opacity(0.5).child("·"))
            .child(icon("GitBranch", 14., muted))
            .child(div().font_weight(FontWeight::MEDIUM).child("Git"))
            .child(
                // Shrinks (with an ellipsis) before the buttons do.
                div()
                    .min_w_0()
                    .truncate()
                    .font_family(fonts::MONO)
                    .text_color(muted)
                    .child(p.scope().root_path.clone()),
            );
        if repo {
            row = row
                .child(div().opacity(0.5).child("·"))
                .child(self.branch_chip(p, c, cx));
        }
        if let Some(ab) = page::ahead_behind(p.data.as_ref()) {
            row = row.child(
                div()
                    .debug_selector(|| "ahead-behind".into())
                    .rounded(px(4.))
                    .bg(h(c.panel_2))
                    .px(px(6.))
                    .py(px(2.))
                    .font_family(fonts::MONO)
                    .map(text_px(10., 12.))
                    .text_color(muted)
                    .child(ab),
            );
        }
        if let Some(badge) = &p.pr_badge {
            row = row.child(pr_badge_element(badge, c, cx));
        }
        let remote = |id: &str, op: crate::data::RemoteOp, cx: &mut Context<Self>| {
            header_button(id, sync_ok, c).when(sync_ok, |d| {
                d.on_click(cx.listener(move |this, _, _, cx| {
                    this.act(|p| p.run_remote(op), cx);
                }))
            })
        };
        let stage = |id: &str, op: crate::data::StageOp, cx: &mut Context<Self>| {
            header_button(id, stage_ok, c).when(stage_ok, |d| {
                d.on_click(cx.listener(move |this, _, _, cx| {
                    this.act(|p| p.run_stage(op), cx);
                }))
            })
        };
        use crate::data::{RemoteOp, StageOp};
        let small = |s: &'static str| div().map(text_px(11., 14.)).child(s);
        let red300 = h(step("red-300"));
        let red_hover = a(step("red-500"), 15.);
        let refresh_ok = !p.status_loading;
        let buttons = div()
            .ml_auto()
            .flex_none()
            .flex()
            .items_center()
            .gap(px(4.))
            .child(
                remote("git-fetch", RemoteOp::Fetch, cx)
                    .tooltip(tooltip("git fetch --all --prune".into()))
                    .child(icon("CloudDownload", 12., muted))
                    .child(small(label(page::Busy::Fetch, "Fetch", "Fetching…"))),
            )
            .child(
                remote("git-pull", RemoteOp::Pull, cx)
                    .tooltip(tooltip(page::pull_title(behind)))
                    .child(icon("ArrowDownToLine", 12., muted))
                    .child(small(label(page::Busy::Pull, "Pull", "Pulling…")))
                    .when(behind > 0., |d| {
                        d.child(count_badge("pull-badge", behind, c))
                    }),
            )
            .child(
                header_button("pull-with-claude-button", sync_ok, c)
                    .when(sync_ok, |d| {
                        d.on_click(cx.listener(|this, _, _, cx| {
                            this.act(GitPage::run_pull_with_claude, cx);
                        }))
                    })
                    .tooltip(tooltip(page::pull_resolve_title(behind)))
                    .child(icon("Sparkles", 12., muted))
                    .child(icon("ArrowDownToLine", 12., muted))
                    .child(small(label(page::Busy::Pull, "Pull + resolve", "Pulling…")))
                    .when(behind > 0., |d| {
                        d.child(count_badge("pull-resolve-badge", behind, c))
                    }),
            )
            .child(
                remote("git-push", RemoteOp::Push, cx)
                    .tooltip(tooltip(page::push_title(ahead)))
                    .child(icon("ArrowUpFromLine", 12., muted))
                    .child(small(label(page::Busy::Push, "Push", "Pushing…")))
                    .when(ahead > 0., |d| d.child(count_badge("push-badge", ahead, c))),
            )
            .child(div().mx(px(4.)).h(px(12.)).w(px(1.)).bg(h(c.border)))
            .child(
                stage("git-stage", StageOp::Stage, cx)
                    .tooltip(tooltip("Stage selected".into()))
                    .child(icon("Plus", 12., muted))
                    .child(small("Stage")),
            )
            .child(
                stage("git-unstage", StageOp::Unstage, cx)
                    .tooltip(tooltip("Unstage selected".into()))
                    .child(icon("Minus", 12., muted))
                    .child(small("Unstage")),
            )
            .child(
                header_button_hover("git-rollback", stage_ok, c, red_hover, red300)
                    .when(stage_ok, |d| {
                        d.on_click(cx.listener(|this, _, _, cx| {
                            this.act(|p| p.run_stage(StageOp::Discard), cx);
                        }))
                    })
                    .text_color(red300)
                    .tooltip(tooltip("Discard local changes (rollback)".into()))
                    .child(icon("Undo2", 12., red300))
                    .child(small("Rollback")),
            )
            .child(
                header_button("git-refresh", refresh_ok, c)
                    .w(px(24.))
                    .justify_center()
                    .tooltip(tooltip("Refresh".into()))
                    .child(icon("RefreshCw", 14., muted))
                    .when(refresh_ok, |d| {
                        d.on_click(cx.listener(|this, _, _, cx| this.act(GitPage::refresh, cx)))
                    }),
            );
        row.child(buttons).into_any_element()
    }

    fn branch_chip(&self, p: &GitPage, c: &Colors, cx: &mut Context<Self>) -> AnyElement {
        let current = p.branch_label();
        let enabled = p.busy.is_none() && current.is_some();
        let open = p.branches.open;
        let (panel_2, fg, muted) = (h(c.panel_2), h(c.foreground), h(c.muted));
        let chip = header_button("branch-switcher-button", enabled, c)
            .map(text_px(12., 16.))
            .when(open, |d| d.bg(panel_2).text_color(fg))
            .when(!open, |d| d.text_color(muted))
            .tooltip(tooltip(branches::chip_title(current.as_deref())))
            .child(
                div()
                    .font_family(fonts::MONO)
                    .when(p.detached(), |d| d.text_color(h(step("amber-300"))))
                    .child(branches::chip_label(current.as_deref())),
            )
            .child(div().opacity(0.6).child(icon("ChevronDown", 12., muted)))
            .when(enabled || open, |d| {
                d.on_click(cx.listener(|this, ev: &gpui_kit::ClickEvent, window, cx| {
                    let closed_by_this_press = match ev {
                        gpui_kit::ClickEvent::Mouse(m) => {
                            this.popover_closed_at.take() == Some(m.down.position)
                        }
                        _ => {
                            this.popover_closed_at = None;
                            false
                        }
                    };
                    if closed_by_this_press {
                        return;
                    }
                    this.act(GitPage::toggle_branches, cx);
                    this.focus_filter(window, cx);
                }))
            });
        div()
            .relative()
            .flex_none()
            .child(chip)
            .when(open, |d| d.child(self.branch_popover(p, c, cx)))
            .into_any_element()
    }

    fn focus_filter(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let open = self.page().is_some_and(|p| p.branches.open);
        if open && let Some(f) = &self.branch_filter {
            f.update(cx, |s, cx| s.focus(window, cx));
        }
    }

    fn branch_popover(&self, p: &GitPage, c: &Colors, cx: &mut Context<Self>) -> AnyElement {
        let b = &p.branches;
        let current = p.branch_label();
        let sections = b.sections();
        let muted = h(c.muted);
        let red300 = h(step("red-300"));
        let mut list = div()
            .id("branch-switcher-list")
            .max_h(px(320.))
            .overflow_y_scroll();
        let section = |label: String| {
            div()
                .px(px(12.))
                .py(px(4.))
                .map(text_px(10., 14.))
                .text_color(muted)
                .child(label.to_uppercase())
        };
        if let Some(cur) = &sections.current {
            list = list.child(
                div()
                    .py(px(4.))
                    .child(section("Current".into()))
                    .child(self.branch_row(b, cur, true, c, cx)),
            );
        }
        if !sections.locals.is_empty() {
            let rows: Vec<AnyElement> = sections
                .other_locals()
                .map(|br| self.branch_row(b, br, false, c, cx))
                .collect();
            list = list.child(
                div()
                    .py(px(4.))
                    .child(section(branches::local_label(p.detached()).into()))
                    .children(rows),
            );
        }
        if !sections.remotes.is_empty() {
            let rows: Vec<AnyElement> = sections
                .remotes
                .iter()
                .map(|br| self.branch_row(b, br, false, c, cx))
                .collect();
            list = list.child(
                div()
                    .py(px(4.))
                    .child(section("Remote".into()))
                    .children(rows),
            );
        }
        if let Some(t) = b.empty_text() {
            list = list.child(
                div()
                    .debug_selector(|| "branch-switcher-empty".into())
                    .px(px(12.))
                    .py(px(16.))
                    .flex()
                    .justify_center()
                    .map(text_px(11., 14.))
                    .text_color(muted)
                    .child(t),
            );
        }
        let error_box = |id: &'static str, text: String| {
            div()
                .debug_selector(move || id.into())
                .flex()
                .items_start()
                .gap(px(6.))
                .px(px(12.))
                .py(px(6.))
                .border_b_1()
                .border_color(a(step("red-500"), 30.))
                .bg(a(step("red-500"), 10.))
                .map(text_px(11., 14.))
                .text_color(red300)
                .child(text)
        };
        let panel_2 = h(c.panel_2);
        let mut pop = div()
            .id("branch-switcher-popover")
            .debug_selector(|| "branch-switcher-popover".into())
            .occlude()
            .w(px(320.))
            .rounded(px(8.))
            .border_1()
            .border_color(h(c.border))
            .bg(h(c.panel))
            .shadow_2xl()
            .text_color(h(c.foreground))
            .child(
                div()
                    .flex()
                    .items_center()
                    .gap(px(8.))
                    .px(px(8.))
                    .py(px(6.))
                    .border_b_1()
                    .border_color(h(c.border))
                    .child(icon("GitBranch", 12., muted))
                    .child(
                        div()
                            .flex_1()
                            .debug_selector(|| "branch-switcher-search".into())
                            .when_some(self.branch_filter.as_ref(), |d, f| {
                                d.child(
                                    Input::new(f)
                                        .appearance(false)
                                        .h(px(20.))
                                        .text_size(px(12.)),
                                )
                            }),
                    )
                    .child(
                        header_button("branch-switcher-refresh", !b.loading, c)
                            .w(px(20.))
                            .h(px(20.))
                            .justify_center()
                            .tooltip(tooltip("Refresh".into()))
                            .child(icon("RefreshCw", 12., muted))
                            .when(!b.loading, |d| {
                                d.on_click(cx.listener(|this, _, _, cx| {
                                    this.act(GitPage::reload_branches, cx);
                                }))
                            }),
                    ),
            );
        if let Some(e) = &b.action_error {
            pop = pop.child(error_box("branch-switcher-action-error", e.clone()));
        }
        if let Some(e) = &b.load_error {
            pop = pop.child(error_box("branch-switcher-load-error", e.clone()));
        }
        pop = pop.child(list).child(
            div().border_t_1().border_color(h(c.border)).child(
                hit("branch-switcher-new")
                    .flex()
                    .items_center()
                    .gap(px(8.))
                    .px(px(12.))
                    .py(px(8.))
                    .hover(move |d| d.bg(panel_2))
                    .child(icon("Plus", 14., h(c.foreground)))
                    .child("New branch…")
                    .on_click(cx.listener(|this, _, _, cx| {
                        this.act(
                            |p| p.branch_action(BranchAction::NewBranch { start_point: None }),
                            cx,
                        );
                    })),
            ),
        );
        let mut menu_el = None;
        if let Some(key) = &b.menu_for
            && let Some(br) = b.branch_for_key(key)
        {
            let items = branches::actions_for(br, current.as_deref());
            let mut menu = div()
                .debug_selector({
                    let id = format!("branch-menu-{}-{}", br.kind, br.name);
                    sel(id)
                })
                .occlude()
                .w(px(288.))
                .rounded(px(8.))
                .border_1()
                .border_color(h(c.border))
                .bg(h(c.panel))
                .shadow_2xl()
                .overflow_hidden()
                .child(
                    div()
                        .px(px(12.))
                        .py(px(6.))
                        .border_b_1()
                        .border_color(h(c.border))
                        .font_family(fonts::MONO)
                        .map(text_px(10., 14.))
                        .child(br.name.clone()),
                );
            for (i, item) in items.into_iter().enumerate() {
                let enabled = b.item_enabled(&item);
                let danger = item.danger;
                let red_hover = a(step("red-500"), 15.);
                let action = item.action.clone();
                menu = menu.child(
                    hit(format!("branch-menu-item-{i}"))
                        .px(px(12.))
                        .py(px(6.))
                        .map(text_px(12., 16.))
                        .when(danger, |d| d.text_color(red300))
                        .when(!enabled, |d| d.opacity(0.4))
                        .when(enabled, |d| {
                            d.hover(move |d| d.bg(if danger { red_hover } else { panel_2 }))
                                .on_click(cx.listener(move |this, _, _, cx| {
                                    let action = action.clone();
                                    this.act(|p| p.branch_action(action), cx);
                                }))
                        })
                        .child(item.label),
                );
            }
            menu_el = Some(menu);
        }
        // The submenu beside the list, in one box (a click in it isn't
        // outside the popover).
        let outer = div()
            .absolute()
            .left_0()
            .top_full()
            .mt(px(4.))
            .flex()
            .items_start()
            .gap(px(4.))
            .child(pop)
            .children(menu_el);
        deferred(outer.on_mouse_down_out(cx.listener(
            |this, ev: &gpui_kit::MouseDownEvent, _, cx| {
                if let Some(m) = this.mounted.as_mut()
                    && m.page.question.is_none()
                    && m.page.branches.prompt.is_none()
                {
                    m.page.branches.close();
                    this.popover_closed_at = Some(ev.position);
                    cx.notify();
                }
            },
        )))
        .with_priority(1)
        .into_any_element()
    }

    fn branch_row(
        &self,
        b: &branches::BranchSwitcher,
        br: &BranchInfo,
        current: bool,
        c: &Colors,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let tag = if current {
            "current"
        } else if br.is_remote() {
            "remote"
        } else {
            "local"
        };
        let key = format!("{tag}:{}", br.name);
        let menu_open = b.menu_for.as_deref() == Some(key.as_str());
        let busy = b.busy_name.as_deref() == Some(br.name.as_str());
        let (panel, panel_2, muted, fg) = (h(c.panel), h(c.panel_2), h(c.muted), h(c.foreground));
        let lead = if current {
            icon("Check", 12., h(c.accent))
        } else if br.is_remote() {
            icon("Cloud", 12., muted)
        } else {
            icon("GitBranch", 12., muted)
        };
        let name = br.name.clone();
        let pick = hit(format!("branch-row-{}-{}", br.kind, br.name))
            .flex()
            .flex_1()
            .min_w_0()
            .items_center()
            .gap(px(8.))
            .px(px(12.))
            .py(px(6.))
            .map(text_px(12., 16.))
            .when(busy, |d| d.opacity(0.6))
            .when(!busy, |d| {
                d.hover(move |d| d.bg(panel_2))
                    .on_click(cx.listener(move |this, _, _, cx| {
                        let name = name.clone();
                        this.act(|p| p.branch_action(BranchAction::Checkout(name)), cx);
                    }))
            })
            .tooltip(tooltip(br.name.clone()))
            .child(lead)
            .child(
                div()
                    .flex_1()
                    .min_w_0()
                    .truncate()
                    .font_family(fonts::MONO)
                    .child(br.name.clone()),
            )
            .when_some(br.upstream.clone().filter(|_| br.is_local()), |d, up| {
                d.child(
                    div()
                        .flex_none()
                        .font_family(fonts::MONO)
                        .map(text_px(10., 14.))
                        .text_color(muted)
                        .child(up),
                )
            });
        let toggle = hit(format!("branch-actions-{}-{}", br.kind, br.name))
            .mr(px(4.))
            .flex()
            .flex_none()
            .items_center()
            .justify_center()
            .size(px(20.))
            .rounded(px(4.))
            .hover(move |d| d.bg(panel).text_color(fg))
            .tooltip(tooltip(
                if menu_open {
                    "Hide branch actions"
                } else {
                    "Show branch actions"
                }
                .into(),
            ))
            .child(icon(
                "ChevronRight",
                12.,
                if menu_open { fg } else { muted },
            ))
            .on_click(cx.listener(move |this, _, _, cx| {
                cx.stop_propagation();
                if let Some(m) = this.mounted.as_mut() {
                    m.page.branches.toggle_menu(&key);
                    cx.notify();
                }
            }));
        div()
            .relative()
            .when(current, |d| d.bg(a(c.panel_2, 60.)))
            .when(menu_open, |d| d.bg(panel_2))
            .child(
                div()
                    .flex()
                    .w_full()
                    .items_center()
                    .child(pick)
                    .child(toggle),
            )
            .into_any_element()
    }

    fn banner(&self, p: &GitPage, c: &Colors, cx: &mut Context<Self>) -> Option<AnyElement> {
        let text = p.banner()?.to_owned();
        let red300 = h(step("red-300"));
        let _ = c;
        Some(
            div()
                .debug_selector(|| "git-banner".into())
                .flex()
                .flex_none()
                .items_center()
                .gap(px(8.))
                .px(px(12.))
                .py(px(4.))
                .border_b_1()
                .border_color(a(step("red-500"), 30.))
                .bg(a(step("red-500"), 10.))
                .map(text_px(11., 14.))
                .text_color(red300)
                .child(icon("AlertTriangle", 12., red300))
                .child(
                    div()
                        .flex_1()
                        .min_w_0()
                        .truncate()
                        .font_family(fonts::MONO)
                        .child(text),
                )
                .child(
                    hit("git-banner-console")
                        .flex_none()
                        .child("View in console →")
                        .on_click(cx.listener(|this, _, _, cx| {
                            if let Some(m) = this.mounted.as_mut() {
                                m.page.console.open = true;
                            }
                            cx.emit(GitEvent::ShowConsole);
                            cx.notify();
                        })),
                )
                .into_any_element(),
        )
    }

    fn empty(id: &'static str, text: &'static str, c: &Colors) -> AnyElement {
        div()
            .debug_selector(move || id.into())
            .px(px(16.))
            .py(px(48.))
            .flex()
            .justify_center()
            .map(text_px(14., 20.))
            .text_color(h(c.muted))
            .child(text)
            .into_any_element()
    }

    fn changes(&self, p: &GitPage, c: &Colors, cx: &mut Context<Self>) -> AnyElement {
        let Some(data) = &p.data else {
            return Self::empty("git-empty", "Loading…", c);
        };
        if !data.is_repo {
            return Self::empty("git-empty", "This workspace isn't a git repository.", c);
        }
        let groups = p.groups();
        let n = groups.visible_len();
        let all = p.all_checked();
        let muted = h(c.muted);
        let (panel_2, fg) = (h(c.panel_2), h(c.foreground));
        let refreshing = p.status_loading;
        let header = div()
            .flex()
            .items_center()
            .gap(px(8.))
            .px(px(12.))
            .py(px(6.))
            .border_b_1()
            .border_color(h(c.border))
            .map(text_px(11., 14.))
            .text_color(muted)
            .child(
                checkbox("changes-select-all".into(), all, n > 0, c).when(n > 0, |d| {
                    let next = all != Some(true);
                    d.on_click(cx.listener(move |this, _, _, cx| {
                        if let Some(m) = this.mounted.as_mut() {
                            m.page.toggle_all(next);
                            cx.notify();
                        }
                    }))
                }),
            )
            .child("CHANGES")
            .child(div().ml_auto().child(format!("{n} file{}", plural(n))))
            .child(self.view_options(c, cx))
            .child(
                hit("changes-refresh")
                    .flex()
                    .items_center()
                    .justify_center()
                    .size(px(20.))
                    .rounded(px(4.))
                    .when(refreshing, |d| d.opacity(0.4))
                    .when(!refreshing, |d| {
                        d.hover(move |d| d.bg(panel_2).text_color(fg))
                            .on_click(cx.listener(|this, _, _, cx| this.act(GitPage::refresh, cx)))
                    })
                    .tooltip(tooltip("Refresh — re-run git status".into()))
                    .child(icon("RefreshCw", 12., muted)),
            );
        if n == 0 {
            return div()
                .map(text_px(12., 16.))
                .child(header)
                .child(Self::empty(
                    "git-empty",
                    "No changes — working tree is clean.",
                    c,
                ))
                .into_any_element();
        }
        let mut list = div()
            .debug_selector(|| "changes-list".into())
            .map(text_px(12., 16.))
            .child(header);
        for (key, mode, title) in GROUPS {
            let items = groups.get(key);
            if items.is_empty() {
                continue;
            }
            let collapsed = p.collapsed_groups.contains(&key);
            let fg80 = a(c.foreground, 80.);
            let mut group = div().border_b_1().border_color(a(c.border, 60.)).child(
                hit(format!("changes-group-{}", key.as_str()))
                    .flex()
                    .w_full()
                    .items_center()
                    .gap(px(4.))
                    .px(px(12.))
                    .py(px(4.))
                    .map(text_px(11., 14.))
                    .font_weight(FontWeight::MEDIUM)
                    .text_color(fg80)
                    .hover(move |d| d.bg(panel_2))
                    .child(icon(
                        if collapsed {
                            "ChevronRight"
                        } else {
                            "ChevronDown"
                        },
                        12.,
                        muted,
                    ))
                    .child(title)
                    .child(
                        div()
                            .ml(px(4.))
                            .text_color(muted)
                            .child(items.len().to_string()),
                    )
                    .on_click(cx.listener(move |this, _, _, cx| {
                        if let Some(m) = this.mounted.as_mut() {
                            m.page.toggle_group(key);
                            cx.notify();
                        }
                    })),
            );
            if !collapsed {
                if p.group_by_directory {
                    let tree = changes::build_dir_tree(items);
                    group = group.children(self.dir_children(p, &tree, mode, 0, c, cx));
                } else {
                    for f in items {
                        group = group.child(self.file_row(p, f, mode, 0, false, c, cx));
                    }
                }
            }
            list = list.child(group);
        }
        list.into_any_element()
    }

    fn view_options(&self, c: &Colors, cx: &mut Context<Self>) -> AnyElement {
        let open = self.view_options_open;
        let (panel_2, fg, muted) = (h(c.panel_2), h(c.foreground), h(c.muted));
        let button = hit("changes-view-options")
            .flex()
            .items_center()
            .justify_center()
            .size(px(20.))
            .rounded(px(4.))
            .when(open, |d| d.bg(panel_2))
            .hover(move |d| d.bg(panel_2).text_color(fg))
            .tooltip(tooltip("View options".into()))
            .child(icon("Eye", 12., if open { fg } else { muted }))
            .on_click(cx.listener(|this, _, _, cx| {
                this.view_options_open = !this.view_options_open;
                cx.notify();
            }));
        let by_dir = self.group_by_directory;
        div()
            .relative()
            .child(button)
            .when(open, |d| {
                d.child(
                    deferred(
                        div()
                            .id("changes-view-options-menu")
                            .occlude()
                            .absolute()
                            .right_0()
                            .top_full()
                            .mt(px(4.))
                            .min_w(px(160.))
                            .rounded(px(6.))
                            .border_1()
                            .border_color(h(c.border))
                            .bg(h(c.panel))
                            .p(px(4.))
                            .shadow_lg()
                            .map(text_px(12., 16.))
                            .child(
                                div()
                                    .px(px(8.))
                                    .pb(px(4.))
                                    .pt(px(2.))
                                    .map(text_px(11., 14.))
                                    .text_color(muted)
                                    .child("Group By"),
                            )
                            .child(
                                hit("changes-group-by-directory")
                                    .flex()
                                    .items_center()
                                    .gap(px(8.))
                                    .rounded(px(4.))
                                    .px(px(8.))
                                    .py(px(4.))
                                    .text_color(fg)
                                    .hover(move |d| d.bg(panel_2))
                                    .child(
                                        div()
                                            .size(px(12.))
                                            .when(by_dir, |d| d.child(icon("Check", 12., fg))),
                                    )
                                    .child("Directory")
                                    .on_click(cx.listener(move |this, _, _, cx| {
                                        this.group_by_directory = !by_dir;
                                        this.view_options_open = false;
                                        if let Some(m) = this.mounted.as_mut() {
                                            m.page.group_by_directory = !by_dir;
                                        }
                                        cx.notify();
                                    })),
                            )
                            .on_mouse_down_out(cx.listener(|this, _, _, cx| {
                                this.view_options_open = false;
                                cx.notify();
                            })),
                    )
                    .with_priority(1),
                )
            })
            .into_any_element()
    }

    fn dir_children(
        &self,
        p: &GitPage,
        node: &DirNode,
        mode: DiffMode,
        depth: usize,
        c: &Colors,
        cx: &mut Context<Self>,
    ) -> Vec<AnyElement> {
        let mut out = Vec::new();
        for d in &node.dirs {
            out.extend(self.dir_row(p, d, mode, depth, c, cx));
        }
        for f in &node.files {
            out.push(self.file_row(p, f, mode, depth, true, c, cx));
        }
        out
    }

    fn dir_row(
        &self,
        p: &GitPage,
        node: &DirNode,
        mode: DiffMode,
        depth: usize,
        c: &Colors,
        cx: &mut Context<Self>,
    ) -> Vec<AnyElement> {
        let key = changes::dir_key(mode, &node.path);
        let collapsed = p.collapsed_dirs.contains(&key);
        let state = changes::dir_checked(node, |path| p.checked.contains(path));
        let (panel_2, muted) = (h(c.panel_2), h(c.muted));
        let paths = node.file_paths.clone();
        let next = state != Some(true);
        let k1 = key.clone();
        let row = hit(format!("changes-dir-{}-{}", mode.as_str(), node.path))
            .flex()
            .items_center()
            .gap(px(6.))
            .py(px(2.))
            .pr(px(12.))
            .pl(px(ROW_INSET_PX + depth as f32 * INDENT_STEP_PX))
            .hover(move |d| d.bg(panel_2))
            .tooltip(tooltip(node.path.clone()))
            .child(icon(
                if collapsed {
                    "ChevronRight"
                } else {
                    "ChevronDown"
                },
                12.,
                muted,
            ))
            .child(
                checkbox(
                    format!("changes-dir-check-{}-{}", mode.as_str(), node.path),
                    state,
                    true,
                    c,
                )
                .on_click(cx.listener(move |this, _, _, cx| {
                    cx.stop_propagation();
                    if let Some(m) = this.mounted.as_mut() {
                        m.page.toggle_dir(&paths, next);
                        cx.notify();
                    }
                })),
            )
            .child(icon("Folder", 12., muted))
            .child(
                div()
                    .min_w_0()
                    .truncate()
                    .font_family(fonts::MONO)
                    .child(node.name.clone()),
            )
            .child(
                div()
                    .flex_none()
                    .text_color(muted)
                    .child(node.file_paths.len().to_string()),
            )
            .on_click(cx.listener(move |this, _, _, cx| {
                if let Some(m) = this.mounted.as_mut() {
                    m.page.toggle_dir_collapsed(&k1);
                    cx.notify();
                }
            }));
        let mut out = vec![row.into_any_element()];
        if !collapsed {
            out.extend(self.dir_children(p, node, mode, depth + 1, c, cx));
        }
        out
    }

    #[allow(clippy::too_many_arguments)]
    fn file_row(
        &self,
        p: &GitPage,
        f: &GitFileChange,
        mode: DiffMode,
        depth: usize,
        grouped: bool,
        c: &Colors,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let is_sel = p
            .selected
            .as_ref()
            .is_some_and(|s| s.path == f.path && s.mode == mode);
        let deleting = p.deleting_path.as_deref() == Some(f.path.as_str());
        let untracked_row = mode == DiffMode::Untracked;
        let (panel, panel_2, muted, fg) = (h(c.panel), h(c.panel_2), h(c.muted), h(c.foreground));
        let group = SharedString::from(format!("row-{}-{}", mode.as_str(), f.path));
        let hover_action = |id: String| {
            hit(id)
                .flex()
                .flex_none()
                .items_center()
                .justify_center()
                .size(px(16.))
                .rounded(px(4.))
                .when(!is_sel, |d| d.opacity(0.))
                .group_hover(group.clone(), |s| s.opacity(1.))
                .when(deleting, |d| d.opacity(0.4))
        };
        let path = f.path.clone();
        let check_path = f.path.clone();
        let checked = p.checked.contains(&f.path);
        let selection = DiffSelection::new(&f.path, mode);
        let (s1, s2, s3) = (selection.clone(), selection.clone(), selection.clone());
        let mut label = div()
            .flex()
            .flex_1()
            .min_w_0()
            .items_center()
            .gap(px(6.))
            .child(status_icon(changes::status_char_for_group(f, mode), c));
        if changes::is_partial_stage(f) {
            label = label.child(
                div()
                    .id(ElementId::Name(
                        format!("partial-{}-{}", mode.as_str(), f.path).into(),
                    ))
                    .flex_none()
                    .rounded(px(3.))
                    .bg(a(step("amber-500"), 15.))
                    .px(px(4.))
                    .font_family(fonts::MONO)
                    .map(text_px(9., 12.))
                    .text_color(h(step("amber-300")))
                    .tooltip(tooltip(changes::partial_title(f)))
                    .child(format!("+{}", f.worktree)),
            );
        }
        label = label.child(
            div()
                .min_w_0()
                .truncate()
                .font_family(fonts::MONO)
                .child(changes::display_path(f, mode, grouped)),
        );
        let row = div()
            .id(ElementId::Name(
                format!("change-row-{}-{}", mode.as_str(), f.path).into(),
            ))
            .debug_selector(sel(format!("change-row-{}-{}", mode.as_str(), f.path)))
            .group(group.clone())
            .flex()
            .items_center()
            .gap(px(6.))
            .py(px(2.))
            .pr(px(12.))
            .pl(px(ROW_INSET_PX + depth as f32 * INDENT_STEP_PX))
            .hover(move |d| d.bg(panel_2))
            .when(is_sel, |d| d.bg(panel_2))
            .tooltip(tooltip(changes::row_title(f, mode, true)))
            .child(
                checkbox(
                    format!("change-check-{}-{}", mode.as_str(), f.path),
                    Some(checked),
                    true,
                    c,
                )
                .on_click(cx.listener(move |this, _, _, cx| {
                    cx.stop_propagation();
                    if let Some(m) = this.mounted.as_mut() {
                        m.page.toggle_check(&check_path, !checked);
                        cx.notify();
                    }
                })),
            )
            .child(label)
            .child(
                hover_action(format!("changes-open-window-{}-{}", mode.as_str(), f.path))
                    .hover(move |d| d.bg(panel).text_color(fg))
                    .tooltip(tooltip("Open in new window".into()))
                    .child(icon("ExternalLink", 12., muted))
                    .on_click(cx.listener(move |_, _, _, cx| {
                        cx.stop_propagation();
                        cx.emit(GitEvent::OpenInWindow(s1.clone()));
                    })),
            )
            .when(!untracked_row, |d| {
                let path = path.clone();
                let amber = a(step("amber-500"), 15.);
                d.child(
                    hover_action(format!("changes-revert-{}-{}", mode.as_str(), f.path))
                        .when(!deleting, |d| d.hover(move |d| d.bg(amber)))
                        .tooltip(tooltip("Revert change (restore to HEAD)".into()))
                        .child(icon("Undo2", 12., muted))
                        .when(!deleting, |d| {
                            d.on_click(cx.listener(move |this, _, _, cx| {
                                cx.stop_propagation();
                                let path = path.clone();
                                this.act(|p| p.revert_single(&path), cx);
                            }))
                        }),
                )
            })
            .child({
                let path = path.clone();
                let red = a(step("red-500"), 15.);
                hover_action(format!("changes-delete-{}-{}", mode.as_str(), f.path))
                    .when(!deleting, |d| d.hover(move |d| d.bg(red)))
                    .tooltip(tooltip(
                        if untracked_row {
                            "Delete file from disk"
                        } else {
                            "Delete file (git rm — stages deletion)"
                        }
                        .into(),
                    ))
                    .child(icon("Trash2", 12., muted))
                    .when(!deleting, |d| {
                        d.on_click(cx.listener(move |this, _, _, cx| {
                            cx.stop_propagation();
                            let path = path.clone();
                            this.act(|p| p.remove_single(&path), cx);
                        }))
                    })
            })
            .on_click(
                cx.listener(move |this, ev: &gpui_kit::ClickEvent, window, cx| {
                    if ev.click_count() >= 2 {
                        cx.emit(GitEvent::OpenInWindow(s2.clone()));
                        return;
                    }
                    let s = s2.clone();
                    this.act(|p| p.select_change(Some(s)), cx);
                    if let Some(f) = &this.focus {
                        window.focus(f, cx);
                    }
                }),
            )
            .on_mouse_down(
                MouseButton::Right,
                cx.listener(move |this, ev: &gpui_kit::MouseDownEvent, _, cx| {
                    let s = s3.clone();
                    let position = ev.position;
                    this.act(|p| p.select_change(Some(s.clone())), cx);
                    cx.emit(GitEvent::ContextMenu {
                        path: s.path,
                        mode: s.mode,
                        position,
                    });
                }),
            );
        row.into_any_element()
    }

    fn commit_box(&self, p: &GitPage, c: &Colors, cx: &mut Context<Self>) -> AnyElement {
        let cb = &p.commit_box;
        let n = p.checked.len();
        let busy = p.busy == Some(page::Busy::Commit);
        let can_commit = cb.can_commit(busy, n);
        let can_generate = cb.can_generate(busy, n);
        let combo_enabled = cb.combo_enabled(busy, n);
        let (muted, fg) = (h(c.muted), h(c.foreground));
        let white = h(step("white"));
        let branch = p.branch_label();
        let header = div()
            .debug_selector(|| "commit-header".into())
            .flex()
            .items_center()
            .gap(px(8.))
            .px(px(12.))
            .py(px(4.))
            .map(text_px(11., 14.))
            .text_color(muted)
            .child(icon("GitCommit", 12., muted))
            .child(
                div()
                    .flex()
                    .child("Commit ")
                    .child(
                        div()
                            .font_weight(FontWeight::BOLD)
                            .text_color(fg)
                            .child(n.to_string()),
                    )
                    .child(format!(" file{}", plural(n)))
                    .when_some(branch, |d, b| {
                        d.child(" to ")
                            .child(div().font_family(fonts::MONO).text_color(fg).child(b))
                    }),
            );
        let area = div()
            .key_context(COMMIT_CONTEXT)
            .debug_selector(|| "commit-message".into())
            .border_y_1()
            .border_color(h(c.border))
            .bg(h(c.background))
            .font_family(fonts::MONO)
            .when(cb.generating, |d| d.opacity(0.6))
            .when_some(self.message.as_ref(), |d, m| {
                d.child(
                    Textarea::new(m)
                        .appearance(false)
                        .disabled(cb.generating)
                        .text_size(px(12.))
                        .px(px(12.))
                        .py(px(8.)),
                )
            })
            .on_action(cx.listener(|this, _: &CommitAndPush, _, cx| {
                this.act(GitPage::combo, cx);
            }));
        let error = cb.error.clone().map(|e| {
            div()
                .debug_selector(|| "commit-error".into())
                .border_b_1()
                .border_color(a(step("red-500"), 30.))
                .bg(a(step("red-500"), 10.))
                .px(px(12.))
                .py(px(4.))
                .map(text_px(11., 14.))
                .text_color(h(step("red-300")))
                .child(e)
        });
        let panel = h(c.panel);
        let generate = hit("commit-generate")
            .flex()
            .items_center()
            .gap(px(4.))
            .rounded(px(6.))
            .border_1()
            .border_color(h(c.border))
            .bg(h(c.panel_2))
            .px(px(10.))
            .py(px(4.))
            .map(text_px(11., 14.))
            .font_weight(FontWeight::MEDIUM)
            .text_color(fg)
            .when(!can_generate, |d| d.opacity(0.4))
            .when(can_generate, |d| {
                d.hover(move |d| d.bg(panel))
                    .on_click(cx.listener(|this, _, _, cx| this.act(GitPage::generate, cx)))
            })
            .tooltip(tooltip(CommitBox::generate_title(n).into()))
            .child(icon("Sparkles", 12., fg))
            .child(cb.generate_label());
        let commit = hit("commit-button")
            .flex()
            .items_center()
            .gap(px(4.))
            .rounded(px(6.))
            .bg(h(c.accent))
            .px(px(12.))
            .py(px(4.))
            .map(text_px(11., 14.))
            .font_weight(FontWeight::MEDIUM)
            .text_color(white)
            .when(!can_commit, |d| d.opacity(0.4))
            .when(can_commit, |d| {
                d.hover(|d| d.opacity(0.9))
                    .on_click(cx.listener(|this, _, _, cx| this.act(GitPage::submit, cx)))
            })
            .child(icon("GitCommit", 12., white))
            .child(CommitBox::commit_label(busy));
        let in_flight = cb.combo_step.is_some();
        let combo_bg = if cb.cancelling {
            h(c.panel_2)
        } else if in_flight {
            h(step("red-600"))
        } else {
            h(c.accent)
        };
        let combo_fg = if cb.cancelling { muted } else { white };
        let combo = hit("commit-and-push-button")
            .flex()
            .items_center()
            .gap(px(6.))
            .whitespace_nowrap()
            .rounded(px(6.))
            .bg(combo_bg)
            .px(px(10.))
            .py(px(4.))
            .map(text_px(11., 14.))
            .font_weight(FontWeight::MEDIUM)
            .text_color(combo_fg)
            .when(!combo_enabled, |d| d.opacity(0.4))
            .when(combo_enabled, |d| {
                d.hover(|d| d.opacity(0.9))
                    .on_click(cx.listener(|this, _, _, cx| this.act(GitPage::combo, cx)))
            })
            .tooltip(tooltip(cb.combo_title(n)))
            .map(|d| {
                if cb.cancelling {
                    d.child(icon("Loader2", 12., combo_fg))
                } else if in_flight {
                    d.child(icon("StopCircle", 12., combo_fg))
                } else {
                    d.child(icon("Sparkles", 12., combo_fg)).child(icon(
                        "ArrowUpFromLine",
                        12.,
                        combo_fg,
                    ))
                }
            })
            .child(cb.combo_label());
        div()
            .debug_selector(|| "commit-box".into())
            .flex()
            .flex_none()
            .flex_col()
            .border_t_1()
            .border_color(h(c.border))
            .bg(h(c.panel))
            .child(header)
            .child(area)
            .children(error)
            .child(
                div()
                    .flex()
                    .flex_wrap()
                    .items_center()
                    .justify_between()
                    .gap_x(px(8.))
                    .gap_y(px(6.))
                    .px(px(12.))
                    .py(px(8.))
                    .child(
                        div()
                            .id("commit-hint")
                            .min_w_0()
                            .truncate()
                            .map(text_px(10., 14.))
                            .text_color(muted)
                            .tooltip(tooltip(
                                "⌘/Ctrl + Enter to commit · add ⇧ to also push".into(),
                            ))
                            .child("⌘/Ctrl + ⏎ · ⇧⏎ for + push"),
                    )
                    .child(
                        div()
                            .flex()
                            .flex_wrap()
                            .items_center()
                            .justify_end()
                            .gap(px(6.))
                            .child(generate)
                            .child(div().h(px(14.)).w(px(1.)).bg(h(c.border)))
                            .child(commit)
                            .child(combo),
                    ),
            )
            .into_any_element()
    }

    fn diff_pane(&self, p: &GitPage, c: &Colors, cx: &mut Context<Self>) -> AnyElement {
        let muted = h(c.muted);
        let Some(selected) = p.selected.clone() else {
            return div()
                .debug_selector(|| "diff-none".into())
                .flex()
                .flex_1()
                .items_center()
                .justify_center()
                .map(text_px(14., 20.))
                .text_color(muted)
                .child("Pick a changed file to see the diff.")
                .into_any_element();
        };
        let (panel, panel_2, fg) = (h(c.panel), h(c.panel_2), h(c.foreground));
        let accent20 = a(c.accent, 20.);
        let mode_tab = |m: DiffMode, cx: &mut Context<Self>| {
            let on = selected.mode == m;
            hit(format!("diff-mode-{}", m.as_str()))
                .px(px(8.))
                .py(px(2.))
                .when(m == DiffMode::Worktree, |d| {
                    d.border_l_1().border_color(h(c.border))
                })
                .when(on, |d| d.bg(accent20).text_color(fg))
                .when(!on, |d| d.text_color(muted).hover(move |d| d.bg(panel_2)))
                .child(m.label())
                .on_click(cx.listener(move |this, _, _, cx| {
                    this.act(|p| p.set_diff_mode(m), cx);
                }))
        };
        let mode = if p.needs_mode_toggle() {
            div()
                .debug_selector(|| "diff-mode-toggle".into())
                .flex()
                .flex_none()
                .overflow_hidden()
                .rounded(px(4.))
                .border_1()
                .border_color(h(c.border))
                .bg(panel)
                .map(text_px(10., 14.))
                .child(mode_tab(DiffMode::Staged, cx))
                .child(mode_tab(DiffMode::Worktree, cx))
                .into_any_element()
        } else {
            div()
                .debug_selector(|| "diff-mode-label".into())
                .flex_none()
                .rounded(px(4.))
                .bg(panel)
                .px(px(6.))
                .py(px(2.))
                .map(text_px(10., 14.))
                .text_color(muted)
                .child(selected.mode.label())
                .into_any_element()
        };
        let s = selected.clone();
        let header = div()
            .debug_selector(|| "diff-header".into())
            .flex()
            .flex_none()
            .items_center()
            .gap(px(8.))
            .h(px(36.))
            .px(px(12.))
            .border_b_1()
            .border_color(h(c.border))
            .bg(a(c.panel_2, 40.))
            .map(text_px(12., 16.))
            .child(
                div()
                    .id("diff-path")
                    .min_w_0()
                    .truncate()
                    .font_family(fonts::MONO)
                    .tooltip(tooltip(selected.path.clone()))
                    .child(selected.path.clone()),
            )
            .child(mode)
            .child(
                hit("diff-open-window")
                    .ml_auto()
                    .flex()
                    .flex_none()
                    .items_center()
                    .justify_center()
                    .size(px(20.))
                    .rounded(px(4.))
                    .hover(move |d| d.bg(panel_2).text_color(fg))
                    .tooltip(tooltip("Open in new window".into()))
                    .child(icon("ExternalLink", 12., muted))
                    .on_click(cx.listener(move |_, _, _, cx| {
                        cx.emit(GitEvent::OpenInWindow(s.clone()));
                    })),
            );
        let d = &p.diff;
        let payload = d.payload.clone().unwrap_or_default();
        let body = match diff_view(&payload.diff, payload.binary, d.loading, d.error.as_deref()) {
            DiffView::Loading => centered("diff-loading", "Loading diff…", c),
            DiffView::Binary => centered("diff-binary", "Binary file — diff not shown.", c),
            DiffView::Empty => centered("diff-empty", "No textual changes.", c),
            DiffView::Error(e) => div()
                .debug_selector(|| "diff-error".into())
                .m(px(12.))
                .rounded(px(6.))
                .border_1()
                .border_color(a(step("red-500"), 30.))
                .bg(a(step("red-500"), 10.))
                .px(px(12.))
                .py(px(8.))
                .map(text_px(12., 16.))
                .text_color(h(step("red-300")))
                .child(e)
                .into_any_element(),
            DiffView::Rows(lines) => diff_rows(&lines, c),
        };
        div()
            .debug_selector(|| "diff-pane".into())
            .flex()
            .flex_col()
            .flex_1()
            .min_h_0()
            .child(header)
            .child(body)
            .into_any_element()
    }

    fn question(&self, p: &GitPage, c: &Colors, cx: &mut Context<Self>) -> Option<AnyElement> {
        let q = p.question.as_ref()?;
        let card =
            div()
                .debug_selector(|| "git-question".into())
                .child(div().text_size(px(13.)).child(q.message.clone()))
                .child(
                    div()
                        .flex()
                        .justify_end()
                        .gap(px(8.))
                        .child(
                            dialog_button("git-question-cancel", "Cancel", false, c).on_click(
                                cx.listener(|this, _, _, cx| this.act(|p| p.answer(false), cx)),
                            ),
                        )
                        .child(dialog_button("git-question-ok", "OK", true, c).on_click(
                            cx.listener(|this, _, _, cx| this.act(|p| p.answer(true), cx)),
                        )),
                );
        Some(dialog(card, c))
    }

    fn prompt(&self, p: &GitPage, c: &Colors, cx: &mut Context<Self>) -> Option<AnyElement> {
        let prompt = p.branches.prompt.as_ref()?;
        let input = self.prompt_input.clone()?;
        let card =
            div()
                .debug_selector(|| "git-prompt".into())
                .child(div().text_size(px(13.)).child(prompt.label()))
                .child(
                    div()
                        .debug_selector(|| "git-prompt-input".into())
                        .child(Input::new(&input).h(px(26.)).text_size(px(12.))),
                )
                .child(
                    div()
                        .flex()
                        .justify_end()
                        .gap(px(8.))
                        .child(
                            dialog_button("git-prompt-cancel", "Cancel", false, c).on_click(
                                cx.listener(|this, _, _, cx| {
                                    this.act(|p| p.answer_branch_prompt(None), cx)
                                }),
                            ),
                        )
                        .child(dialog_button("git-prompt-ok", "OK", true, c).on_click(
                            cx.listener(move |this, _, _, cx| {
                                let text = input.read(cx).value().to_string();
                                this.act(|p| p.answer_branch_prompt(Some(&text)), cx);
                            }),
                        )),
                );
        Some(dialog(card, c))
    }
}

fn centered(id: &'static str, text: &'static str, c: &Colors) -> AnyElement {
    div()
        .debug_selector(move || id.into())
        .flex()
        .flex_1()
        .items_center()
        .justify_center()
        .map(text_px(12., 16.))
        .text_color(h(c.muted))
        .child(text)
        .into_any_element()
}

/// The `DiffViewer` table (DiffViewer.tsx:96).
fn diff_rows(lines: &[Line], c: &Colors) -> AnyElement {
    let muted = h(c.muted);
    let gutter_border = a(c.border, 40.);
    let width = |n: usize| px(16. + 7. * n.max(1) as f32);
    let left_w = width(
        lines
            .iter()
            .map(|l| l.gutter_left().len())
            .max()
            .unwrap_or(1),
    );
    let right_w = width(
        lines
            .iter()
            .map(|l| l.gutter_right().len())
            .max()
            .unwrap_or(1),
    );
    let rows = lines.iter().enumerate().map(|(i, l)| {
        let (bg, fg) = match l {
            Line::Add { .. } => (
                Some(a(step("emerald-500"), 10.)),
                Some(h(step("emerald-100"))),
            ),
            Line::Del { .. } => (Some(a(step("red-500"), 10.)), Some(h(step("red-100")))),
            Line::Hunk { .. } => (Some(a(c.panel_2, 60.)), Some(muted)),
            Line::Meta { .. } => (None, Some(muted)),
            Line::Ctx { .. } => (None, None),
        };
        let gutter = |text: String, w: Pixels| {
            div()
                .flex_none()
                .w(w)
                .px(px(8.))
                .flex()
                .justify_end()
                .border_r_1()
                .border_color(gutter_border)
                .text_size(px(10.))
                .text_color(muted)
                .child(text)
        };
        div()
            .debug_selector(sel(format!("diff-row-{i}")))
            .flex()
            .min_w_full()
            .when_some(bg, |d, bg| d.bg(bg))
            .when_some(fg, |d, fg| d.text_color(fg))
            .child(gutter(l.gutter_left(), left_w))
            .child(gutter(l.gutter_right(), right_w))
            .child(
                div()
                    .flex_none()
                    .px(px(8.))
                    .text_color(muted)
                    .child(l.prefix()),
            )
            .child(
                div()
                    .flex_none()
                    .px(px(8.))
                    .whitespace_nowrap()
                    .child(SharedString::from(l.text().to_owned())),
            )
    });
    div()
        .id("diff-rows")
        .debug_selector(|| "diff-rows".into())
        .flex_1()
        .min_h_0()
        .overflow_scroll()
        .bg(h(c.background))
        .font_family(fonts::MONO)
        .map(text_px(12., 20.))
        .children(rows)
        .into_any_element()
}

fn dialog_button(
    id: &'static str,
    label: &'static str,
    primary: bool,
    c: &Colors,
) -> Stateful<Div> {
    let (panel, panel_2) = (h(c.panel), h(c.panel_2));
    hit(id)
        .px(px(12.))
        .py(px(6.))
        .rounded(px(6.))
        .border_1()
        .border_color(h(c.border))
        .text_size(px(12.))
        .when(primary, |d| {
            d.bg(h(c.accent))
                .text_color(h(step("white")))
                .border_color(h(c.accent))
        })
        .when(!primary, |d| d.bg(panel).hover(move |d| d.bg(panel_2)))
        .child(label)
}

/// A `confirm()` / `prompt()` in the window.
fn dialog(card: Div, c: &Colors) -> AnyElement {
    deferred(
        div()
            .id("git-dialog")
            .absolute()
            .inset_0()
            .flex()
            .items_center()
            .justify_center()
            .bg(a(step("black"), 40.))
            .occlude()
            .child(
                card.w(px(420.))
                    .p(px(16.))
                    .rounded(px(8.))
                    .border_1()
                    .border_color(h(c.border))
                    .bg(h(c.panel))
                    .text_color(h(c.foreground))
                    .shadow_2xl()
                    .flex()
                    .flex_col()
                    .gap(px(12.)),
            ),
    )
    .with_priority(2)
    .into_any_element()
}

fn pr_badge_element(
    badge: &crate::types::PrBadge,
    c: &Colors,
    cx: &mut Context<GitScreen>,
) -> AnyElement {
    let (border, bg, fg) = match pr_badge::pr_badge_tone(badge) {
        BadgeTone::Merged => (
            a(step("purple-400"), 40.),
            a(step("purple-400"), 10.),
            h(step("purple-300")),
        ),
        BadgeTone::Closed => (
            a(step("red-400"), 40.),
            a(step("red-400"), 10.),
            h(step("red-300")),
        ),
        BadgeTone::Draft => (h(c.border), h(c.panel_2), h(c.muted)),
        BadgeTone::Open => (
            a(step("emerald-400"), 40.),
            a(step("emerald-400"), 10.),
            h(step("emerald-300")),
        ),
    };
    let mark = pr_badge::pr_checks_mark(badge).map(|m| {
        let tone = match badge.checks.as_str() {
            "passing" => h(step("emerald-400")),
            "failing" => h(step("red-400")),
            _ => h(step("amber-400")),
        };
        div().text_color(tone).child(m)
    });
    let href = pr_badge::pr_badge_href(badge).map(str::to_owned);
    hit("pr-badge")
        .flex()
        .flex_none()
        .items_center()
        .gap(px(4.))
        .rounded_full()
        .border_1()
        .border_color(border)
        .bg(bg)
        .px(px(6.))
        .py(px(2.))
        .map(text_px(10., 12.))
        .font_weight(FontWeight::MEDIUM)
        .text_color(fg)
        .tooltip(tooltip(pr_badge::pr_badge_title(badge)))
        .child(icon("GitPullRequest", 12., fg))
        .child(pr_badge::pr_badge_label(badge))
        .when(badge.state == "draft", |d| {
            d.child(div().opacity(0.8).child("draft"))
        })
        .children(mark)
        .when_some(href, |d, url| {
            d.on_click(cx.listener(move |_, _, _, cx| cx.open_url(&url)))
        })
        .into_any_element()
}

impl Render for GitScreen {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        self.ensure_window_parts(window, cx);
        self.sync_inputs(window, cx);
        let c = Colors::of(self.theme);
        let focus = self.focus.clone().expect("made above");
        let root = div()
            .id("git-screen")
            .debug_selector(|| "git-screen".into())
            .key_context(CONTEXT)
            .track_focus(&focus)
            .relative()
            .flex()
            .flex_col()
            .flex_1()
            .min_h_0()
            .size_full()
            .overflow_hidden()
            .bg(h(c.background))
            .text_color(h(c.foreground))
            .font_family(fonts::SANS)
            .on_action(cx.listener(|this, _: &SelectNext, _, cx| {
                this.act(|p| p.step(true), cx);
            }))
            .on_action(cx.listener(|this, _: &SelectPrev, _, cx| {
                this.act(|p| p.step(false), cx);
            }))
            .on_action(cx.listener(|this, _: &DeleteSelected, _, cx| {
                let free = this.page().is_some_and(|p| {
                    p.question.is_none() && p.branches.prompt.is_none() && !p.branches.open
                });
                if free {
                    this.act(GitPage::delete_key, cx);
                }
            }))
            .on_action(cx.listener(|this, _: &Dismiss, _, cx| {
                if let Some(m) = this.mounted.as_mut() {
                    if m.page.question.is_some() {
                        let outs = m.page.answer(false);
                        this.run(outs, cx);
                    } else if m.page.branches.open || m.page.branches.prompt.is_some() {
                        m.page.branches.escape();
                    }
                    this.view_options_open = false;
                    cx.notify();
                }
            }));
        let Some(m) = self.mounted.as_ref() else {
            return root.child(Self::empty("git-empty", "No active workspace.", &c));
        };
        let p = &m.page;
        let header = self.header(p, &c, cx);
        let banner = self.banner(p, &c, cx);
        let changes = self.changes(p, &c, cx);
        let commit = self.commit_box(p, &c, cx);
        let diff = self.diff_pane(p, &c, cx);
        let question = self.question(p, &c, cx);
        let prompt = self.prompt(p, &c, cx);
        root.child(header)
            .children(banner)
            .child(
                div()
                    .flex()
                    .flex_1()
                    .min_h_0()
                    .overflow_hidden()
                    .child(
                        div()
                            .flex()
                            .flex_none()
                            .flex_col()
                            .w(px(PANEL_WIDTH))
                            .border_r_1()
                            .border_color(h(c.border))
                            .child(
                                div()
                                    .id("changes-scroll")
                                    .flex_1()
                                    .min_h_0()
                                    .overflow_y_scroll()
                                    .child(changes),
                            )
                            .child(commit),
                    )
                    .child(
                        div()
                            .flex()
                            .flex_col()
                            .flex_1()
                            .min_w_0()
                            .overflow_hidden()
                            .child(diff),
                    ),
            )
            .children(question)
            .children(prompt)
    }
}
