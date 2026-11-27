//! [`StatusLineView`]: the status line on screen, with the classes of
//! `StatusLine.tsx` (`h-9`, `gap-3`, `px-4`, `text-xs`, the chips'
//! `text-[10px]` and tints), its mode selector's menu
//! (`ModeSelector.tsx`) and the model picker's popover
//! (`ModelPicker.tsx`), both opening under their trigger and closing on a
//! click outside.
//!
//! The view reads its [`StatusTarget`]'s state on each change, and keeps
//! what the hooks around `StatusLine` keep: the context poll
//! (`useContextWatcher`), the user settings (`useDisableAutoMode`,
//! `useMaxEffortLevel`) and the model list (fetched each time the picker
//! opens). It ticks once a second while a turn or a hook runs (the
//! elapsed timers). The row's width is measured each frame for the
//! `@3xl/statusline` labels (768 px and up).
//!
//! Not drawn yet (named seams): the workspace chip, the session picker,
//! the agent picker's menu (the pill shows), the Compact / Clear buttons,
//! the notification menu, the verbosity selector, the focus toggle and
//! the model picker's advisor and "More models" sections.

use std::sync::Arc;
use std::time::Duration;

use claudius_client::state::ChatState;
use claudius_gpui_theme::{ThemeName, fonts, hsla, icons};
use claudius_theme::{Rgba, Theme as Tokens, color, tailwind};
use futures::StreamExt as _;
use gpui_kit::component::Icon;
use gpui_kit::component::tooltip::Tooltip;
use gpui_kit::prelude::FluentBuilder as _;
use gpui_kit::{
    AnyElement, AnyView, App, Context, Div, ElementId, FontWeight, Hsla, InteractiveElement as _,
    IntoElement, ParentElement as _, Render, SharedString, StatefulInteractiveElement as _,
    Styled as _, Task, Window, deferred, div, px,
};

use crate::line::{CtxLevel, StatusLineModel, StatusProps, status_line};
use crate::modes;
use crate::picker::{
    self, ModelList, Pick, PickerInputs, StatusSettings, context_from, models_from, settings_from,
};
use crate::target::{StatusTarget, get};
use crate::tone::{Chip, Tone};

/// `@3xl/statusline`: 48rem of the row.
pub const WIDE_PX: f32 = 768.;

/// The popover that's open.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Popup {
    Mode,
    Model,
}

struct Colors {
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
            foreground: p.foreground,
            panel: p.panel,
            panel_2: p.panel_2,
            border: p.border,
            muted: p.muted,
            accent: p.accent,
        }
    }

    fn tone(&self, t: Tone) -> Hsla {
        match t {
            Tone::Muted => hsla(self.muted),
            Tone::Accent => hsla(self.accent),
            Tone::Foreground => hsla(self.foreground),
            other => step(other.step().expect("a Tailwind tone")),
        }
    }
}

fn step(name: &str) -> Hsla {
    hsla(tailwind::color(name).unwrap_or_else(|| panic!("{name} is a Tailwind step")))
}

/// Tailwind's `/N` on a color.
fn a(c: Rgba, pct: f64) -> Hsla {
    hsla(color::with_opacity(c, pct))
}

fn step_a(name: &str, pct: f64) -> Hsla {
    a(
        tailwind::color(name).unwrap_or_else(|| panic!("{name} is a Tailwind step")),
        pct,
    )
}

fn tip(text: String) -> impl Fn(&mut Window, &mut App) -> AnyView {
    move |window, cx| Tooltip::new(text.clone()).build(window, cx)
}

fn icon(name: &str, size: f32, color: Hsla) -> Option<Icon> {
    icons::icon(name).map(|i| Icon::new(i).size(px(size)).text_color(color))
}

fn sel(name: impl Into<String>) -> impl Fn() -> String + 'static {
    let name = name.into();
    move || name.clone()
}

fn id(name: impl Into<String>) -> ElementId {
    ElementId::Name(SharedString::from(name.into()))
}

/// A chip's border, background and text (`rounded border px-1.5 py-0.5
/// font-mono text-[10px]`).
fn chip(c: &Colors, look: Chip, name: &str) -> gpui_kit::Stateful<Div> {
    let (border, bg, text) = match look {
        Chip::Panel => (hsla(c.border), hsla(c.panel_2), hsla(c.muted)),
        Chip::Amber => (
            step_a("amber-500", 40.),
            step_a("amber-500", 10.),
            step("amber-200"),
        ),
        Chip::Red => (
            step_a("red-500", 40.),
            step_a("red-500", 10.),
            step("red-200"),
        ),
    };
    div()
        .id(id(name))
        .debug_selector(sel(name))
        .flex()
        .flex_none()
        .items_center()
        .gap(px(4.))
        .rounded(px(4.))
        .border_1()
        .border_color(border)
        .bg(bg)
        .px(px(6.))
        .py(px(2.))
        .font_family(fonts::MONO)
        .text_size(px(10.))
        .line_height(px(14.))
        .text_color(text)
}

fn sep() -> Div {
    div().flex_none().opacity(0.5).child("\u{b7}")
}

/// The status line of one chat.
pub struct StatusLineView {
    target: Arc<dyn StatusTarget>,
    theme: ThemeName,
    now_ms: Option<f64>,
    utc: bool,
    props: Option<StatusProps>,
    width: f32,
    open: Option<Popup>,
    models: ModelList,
    models_task: Option<Task<()>>,
    /// The settings and the cwd they were read for.
    settings: (Option<String>, StatusSettings),
    settings_task: Option<Task<()>>,
    /// The last context reading and its session.
    context: Option<(String, Option<f64>)>,
    /// The poll and the `(session, pending)` it runs for.
    context_task: Option<((String, bool), Task<()>)>,
    ticker: Option<Task<()>>,
    ticks: usize,
    _listen: Task<()>,
}

impl StatusLineView {
    pub fn new(target: Arc<dyn StatusTarget>, theme: ThemeName, cx: &mut Context<Self>) -> Self {
        let mut changes = target.changes();
        let listen = cx.spawn(async move |this, cx| {
            while changes.next().await.is_some() {
                if this.update(cx, |this, cx| this.refresh(cx)).is_err() {
                    break;
                }
            }
        });
        let mut view = StatusLineView {
            target,
            theme,
            now_ms: None,
            utc: false,
            props: None,
            width: 0.,
            open: None,
            models: ModelList::Loading,
            models_task: None,
            settings: (None, StatusSettings::default()),
            settings_task: None,
            context: None,
            context_task: None,
            ticker: None,
            ticks: 0,
            _listen: listen,
        };
        view.refresh(cx);
        view
    }

    pub fn set_theme(&mut self, theme: ThemeName, cx: &mut Context<Self>) {
        if self.theme != theme {
            self.theme = theme;
            cx.notify();
        }
    }

    /// Fixes the clock (the elapsed timers' now) and shows clock times in
    /// UTC: the tests and the screenshots.
    pub fn set_now(&mut self, now_ms: f64, cx: &mut Context<Self>) {
        self.now_ms = Some(now_ms);
        self.utc = true;
        cx.notify();
    }

    /// The view's clock: the fixed one, else the wall clock.
    pub fn clock_ms(&self) -> f64 {
        self.now_ms
            .unwrap_or_else(|| claudius_core::now_ms() as f64)
    }

    /// The props as last read, the host's parts in (`None`: no chat).
    pub fn props(&self) -> Option<&StatusProps> {
        self.props.as_ref()
    }

    /// The status line as it draws now.
    pub fn model(&self) -> Option<StatusLineModel> {
        let p = self.props.as_ref()?;
        let now = self.clock_ms();
        Some(if self.utc {
            status_line(p, now, &chrono::Utc)
        } else {
            status_line(p, now, &chrono::Local)
        })
    }

    pub fn open(&self) -> Option<Popup> {
        self.open
    }

    /// The model picker's list.
    pub fn models(&self) -> &ModelList {
        &self.models
    }

    pub fn settings(&self) -> &StatusSettings {
        &self.settings.1
    }

    /// Whether the one-second tick runs.
    pub fn ticking(&self) -> bool {
        self.ticker.is_some()
    }

    pub fn ticks(&self) -> usize {
        self.ticks
    }

    /// The row is at least [`WIDE_PX`] wide (`@3xl/statusline`).
    pub fn wide(&self) -> bool {
        self.width >= WIDE_PX
    }

    /// Opens a popover, or closes the one open (`setOpen((o) => !o)`).
    pub fn toggle(&mut self, popup: Popup, cx: &mut Context<Self>) {
        if self.open == Some(popup) {
            self.open = None;
        } else {
            self.open = Some(popup);
            if popup == Popup::Model {
                self.load_models(cx);
            }
        }
        cx.notify();
    }

    pub fn close(&mut self, cx: &mut Context<Self>) {
        if self.open.take().is_some() {
            cx.notify();
        }
    }

    /// Picks a permission mode (`onModeChange(m)`, then the menu closes).
    /// A mode the menu doesn't list (a disabled one) isn't picked.
    pub fn pick_mode(&mut self, mode: &str, cx: &mut Context<Self>) {
        let Some(p) = &self.props else { return };
        let listed = modes::menu(&p.permission_mode, &p.disabled_modes)
            .iter()
            .any(|o| o.meta.mode == mode);
        if !listed {
            return;
        }
        let m = mode.to_owned();
        self.target
            .act(Box::new(move |s, env| s.set_permission_mode(&m, env)));
        self.open = None;
        cx.notify();
    }

    /// Shift+Tab's `nextPermissionMode` (ChatSurface.tsx:1210).
    pub fn cycle_mode(&mut self, cx: &mut Context<Self>) {
        let Some(p) = &self.props else { return };
        let next = modes::next_permission_mode(&p.permission_mode, &p.disabled_modes);
        self.target
            .act(Box::new(move |s, env| s.set_permission_mode(next, env)));
        cx.notify();
    }

    /// A choice in the model picker.
    pub fn pick(&mut self, pick: Pick, cx: &mut Context<Self>) {
        let closes = pick.closes();
        self.target.act(Box::new(move |s, env| match pick {
            Pick::Model(v) => s.set_model(Some(&v), None, env),
            Pick::Effort(l) => s.set_effort(&l, false, env),
            Pick::Ultracode(on) => s.set_ultracode(on, env),
            Pick::Fast(on) => s.set_fast(on, env),
        }));
        if closes {
            self.open = None;
        }
        cx.notify();
    }

    /// The picker's inputs from the props (SessionCard.tsx:308).
    pub fn picker_inputs(&self) -> PickerInputs {
        let mut i = PickerInputs {
            max_effort_level: self.settings.1.max_effort_level.clone(),
            now_ms: self.clock_ms(),
            ..PickerInputs::default()
        };
        self.target.read(&mut |s: &ChatState| {
            i.current_model = s.model.as_str().map(str::to_owned);
            i.ultracode = s.ultracode;
            i.fast_mode = s.fast_mode;
            i.fast_mode_active = s.fast_mode_state.as_str() == Some("on");
        });
        i
    }

    fn load_models(&mut self, cx: &mut Context<Self>) {
        let sid = self.props.as_ref().and_then(|p| p.session_id.clone());
        let Some(url) = picker::models_url(sid.as_deref()) else {
            self.models = picker::no_session();
            self.models_task = None;
            return;
        };
        self.models = ModelList::Loading;
        let rx = self.target.fetch(get(url));
        self.models_task = Some(cx.spawn(async move |this, cx| {
            let outcome = rx.await.unwrap_or_else(|_| {
                claudius_client::effect::FetchOutcome::Failed("Failed to fetch".into())
            });
            let _ = this.update(cx, |this, cx| {
                this.models = models_from(&outcome);
                cx.notify();
            });
        }));
    }

    /// Re-reads the chat, then syncs the polls and the tick to it.
    fn refresh(&mut self, cx: &mut Context<Self>) {
        let mut next = None;
        self.target
            .read(&mut |s: &ChatState| next = Some(StatusProps::of(s)));
        if let Some(p) = next.as_mut() {
            p.disabled_modes = self.settings.1.disabled_modes();
            p.context_percent = match (&self.context, &p.session_id) {
                (Some((sid, pct)), Some(cur)) if sid == cur => *pct,
                _ => None,
            };
        }
        self.props = next;
        self.sync_settings(cx);
        self.sync_context(cx);
        self.sync_ticker(cx);
        cx.notify();
    }

    fn sync_settings(&mut self, cx: &mut Context<Self>) {
        let cwd = self.props.as_ref().and_then(|p| p.session_root.clone());
        if cwd == self.settings.0 {
            return;
        }
        self.settings = (cwd.clone(), StatusSettings::default());
        self.settings_task = None;
        let Some(url) = picker::settings_url(cwd.as_deref()) else {
            return;
        };
        let rx = self.target.fetch(get(url));
        self.settings_task = Some(cx.spawn(async move |this, cx| {
            let Ok(outcome) = rx.await else { return };
            let _ = this.update(cx, |this, cx| {
                if this.settings.0 == cwd {
                    this.settings.1 = settings_from(&outcome);
                    this.refresh(cx);
                }
            });
        }));
    }

    /// `useContextWatcher(sessionId, pending)`: a new poll loop on each
    /// change of either, its first poll 1.5 s in.
    fn sync_context(&mut self, cx: &mut Context<Self>) {
        let key = self.props.as_ref().and_then(|p| {
            p.session_id
                .clone()
                .filter(|s| !s.is_empty())
                .map(|s| (s, p.pending))
        });
        if key.as_ref() == self.context_task.as_ref().map(|(k, _)| k) {
            return;
        }
        self.context_task = None;
        let Some((sid, pending)) = key.clone() else {
            return;
        };
        let target = self.target.clone();
        let task = cx.spawn(async move |this, cx| {
            let mut delay = picker::CONTEXT_FIRST_POLL_MS;
            loop {
                cx.background_executor()
                    .timer(Duration::from_millis(delay))
                    .await;
                let rx = target.fetch(get(picker::context_url(&sid)));
                if let Ok(outcome) = rx.await
                    && let Some(pct) = context_from(&outcome)
                {
                    let sid = sid.clone();
                    let alive = this.update(cx, |this, cx| {
                        this.context = Some((sid, pct));
                        this.refresh(cx);
                    });
                    if alive.is_err() {
                        break;
                    }
                }
                delay = picker::context_poll_delay_ms(pending);
            }
        });
        self.context_task = Some((key.expect("checked"), task));
    }

    /// Ticks while the turn's or a hook's timer shows.
    fn sync_ticker(&mut self, cx: &mut Context<Self>) {
        let needs = self
            .model()
            .is_some_and(|m| m.elapsed.is_some() || m.hook.is_some());
        if needs == self.ticker.is_some() {
            return;
        }
        self.ticker = needs.then(|| {
            cx.spawn(async move |this, cx| {
                loop {
                    cx.background_executor().timer(Duration::from_secs(1)).await;
                    let alive = this.update(cx, |this, cx| {
                        this.ticks += 1;
                        cx.notify();
                    });
                    if alive.is_err() {
                        break;
                    }
                }
            })
        });
    }

    fn measured(&mut self, width: f32, cx: &mut Context<Self>) {
        let was = self.wide();
        self.width = width;
        if was != self.wide() {
            cx.notify();
        }
    }
}

impl Render for StatusLineView {
    fn render(&mut self, _window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let c = Colors::of(self.theme);
        let Some(m) = self.model() else {
            return div().into_any_element();
        };
        let wide = self.wide();
        let entity = cx.entity().downgrade();
        let left = left_cluster(self, &m, &c, cx);
        let right = right_cluster(self, &m, &c, wide, cx);
        div()
            .on_children_prepainted(move |bounds, _, cx| {
                if let Some(b) = bounds.first() {
                    let w = f32::from(b.size.width);
                    entity.update(cx, |this, cx| this.measured(w, cx)).ok();
                }
            })
            .w_full()
            .flex_none()
            .child(
                div()
                    .id("status-line")
                    .debug_selector(|| "status-line".into())
                    .relative()
                    .flex()
                    .items_center()
                    .h(px(36.))
                    .gap(px(12.))
                    .border_b_1()
                    .border_color(hsla(c.border))
                    .bg(hsla(c.panel))
                    .px(px(16.))
                    .text_size(px(12.))
                    .line_height(px(16.))
                    .text_color(hsla(c.muted))
                    .children(left)
                    .child(right),
            )
            .into_any_element()
    }
}

fn left_cluster(
    this: &StatusLineView,
    m: &StatusLineModel,
    c: &Colors,
    cx: &mut Context<StatusLineView>,
) -> Vec<AnyElement> {
    let mut out: Vec<AnyElement> = Vec::new();
    let tone = c.tone(m.status.tone());
    let status = m.status.as_str();
    // The dot (`status-line-dot`); busy, the ping's halo around it.
    out.push(
        div()
            .debug_selector(sel(format!("status-line-dot-{status}")))
            .relative()
            .flex()
            .flex_none()
            .items_center()
            .justify_center()
            .size(px(10.))
            .when(m.busy, |d| {
                d.child(
                    div()
                        .debug_selector(|| "status-line-dot-halo".into())
                        .absolute()
                        .size_full()
                        .rounded_full()
                        .bg(Hsla { a: 0.35, ..tone }),
                )
            })
            .child(
                div()
                    .size(px(if m.busy { 7. } else { 10. }))
                    .rounded_full()
                    .bg(tone),
            )
            .into_any_element(),
    );
    if let Some(w) = &m.worktree {
        out.push(
            chip(c, Chip::Amber, "status-line-worktree")
                .children(icon("GitBranch", 12., step("amber-200")))
                .child(div().max_w(px(192.)).truncate().child(w.text.clone()))
                .tooltip(tip(w.title.clone()))
                .into_any_element(),
        );
    }
    if let Some(title) = m.reconnecting {
        out.push(
            chip(c, Chip::Amber, "status-line-stream")
                .children(icon("WifiOff", 12., step("amber-200")))
                .child("Reconnecting")
                .tooltip(tip(title.to_owned()))
                .into_any_element(),
        );
    }
    out.push(sep().into_any_element());
    out.push(
        div()
            .id("status-line-text")
            .debug_selector(|| "status-line-text".into())
            .flex_none()
            .whitespace_nowrap()
            .child(m.label.clone())
            .when_some(m.label_title.clone(), |d, t| d.tooltip(tip(t)))
            .into_any_element(),
    );
    if let Some(model) = &m.model {
        out.push(sep().into_any_element());
        let open = this.open == Some(Popup::Model);
        let trigger = if model.deprecated {
            chip(c, Chip::Amber, "status-line-model-deprecated")
                .children(icon("AlertTriangle", 12., step("amber-200")))
                .child(div().max_w(px(224.)).truncate().child(model.text.clone()))
        } else {
            div()
                .id("status-line-model")
                .debug_selector(|| "status-line-model".into())
                .flex_none()
                .max_w(px(224.))
                .truncate()
                .rounded(px(4.))
                .px(px(2.))
                .font_family(fonts::MONO)
                .opacity(if open { 1. } else { 0.8 })
                .hover(|d| d.opacity(1.))
                .child(model.text.clone())
        };
        let trigger = trigger
            .cursor_pointer()
            .tooltip(tip(model.title.clone()))
            .on_click(cx.listener(|this, _, _, cx| this.toggle(Popup::Model, cx)));
        out.push(
            div()
                .relative()
                .flex_none()
                .child(trigger)
                .when(open, |d| d.child(model_panel(this, c, cx)))
                .into_any_element(),
        );
    }
    out.push(sep().into_any_element());
    let agent = &m.agent;
    out.push(
        chip(c, Chip::Panel, "status-line-agent")
            .px(px(4.))
            .opacity(if agent.named { 0.8 } else { 0.5 })
            .children(icon("Bot", 12., hsla(c.muted)))
            .child(div().max_w(px(128.)).truncate().child(agent.text.clone()))
            .tooltip(tip(agent.title.clone()))
            .into_any_element(),
    );
    if let Some(acct) = &m.account {
        out.push(sep().into_any_element());
        let name = if acct.drift {
            "status-line-account-drift"
        } else {
            "status-line-account"
        };
        let look = if acct.drift { Chip::Amber } else { Chip::Panel };
        let target = this.target.clone();
        out.push(
            chip(c, look, name)
                .children(icon(
                    "Users",
                    12.,
                    if acct.drift {
                        step("amber-200")
                    } else {
                        hsla(c.muted)
                    },
                ))
                .child(div().max_w(px(128.)).truncate().child(acct.text.clone()))
                .tooltip(tip(acct.title.clone()))
                .when(acct.drift, |d| {
                    d.cursor_pointer().on_click(move |_, _, _| {
                        target.act(Box::new(|s, env| s.move_to_active_account(env)));
                    })
                })
                .into_any_element(),
        );
    }
    out
}

fn right_cluster(
    this: &StatusLineView,
    m: &StatusLineModel,
    c: &Colors,
    wide: bool,
    cx: &mut Context<StatusLineView>,
) -> AnyElement {
    let mut row = div()
        .ml_auto()
        .flex()
        .flex_none()
        .items_center()
        .gap(px(8.));
    if m.zen {
        return row.into_any_element();
    }
    if let Some(cost) = &m.cost {
        row = row.child(
            chip(c, Chip::Panel, "status-line-cost")
                .rounded(px(6.))
                .hover(|d| d.bg(hsla(c.panel)))
                .child(cost.cost.clone())
                .when_some(cost.tokens.clone(), |d, t| {
                    d.child(div().ml(px(0.)).opacity(0.7).child(t))
                })
                .tooltip(tip(crate::line::COST_TITLE.into())),
        );
    }
    if let Some(f) = &m.fast {
        let look = if f.on { Chip::Amber } else { Chip::Panel };
        row = row.child(
            chip(c, look, "status-line-fast")
                .rounded(px(6.))
                .child(f.text.clone())
                .when(f.on && wide, |d| {
                    d.child(div().text_size(px(9.)).opacity(0.8).child("\u{b7} credits"))
                })
                .tooltip(tip(f.title.clone())),
        );
    }
    if let Some(ctx) = &m.context {
        row = row.child(
            chip(c, ctx.level.chip(), "status-line-context")
                .rounded(px(6.))
                .when(ctx.level != CtxLevel::Ok, |d| {
                    let col = if ctx.level == CtxLevel::Danger {
                        step("red-200")
                    } else {
                        step("amber-200")
                    };
                    d.children(icon("AlertTriangle", 12., col))
                })
                .child(ctx.text.clone())
                .tooltip(tip(ctx.level.title().into())),
        );
    }
    row = row.child(mode_selector(this, m, c, wide, cx));
    if let Some(e) = m.elapsed.as_ref().filter(|_| wide) {
        row = row.child(
            div()
                .id("status-line-elapsed")
                .debug_selector(|| "status-line-elapsed".into())
                .flex_none()
                .whitespace_nowrap()
                .font_family(fonts::MONO)
                .opacity(0.7)
                .child(e.clone())
                .tooltip(tip(crate::line::ELAPSED_TITLE.into())),
        );
    }
    if let Some(h) = &m.hook {
        row = row.child(
            div()
                .id("status-line-hook")
                .debug_selector(|| "status-line-hook".into())
                .flex_none()
                .whitespace_nowrap()
                .text_color(step("sky-400"))
                .child(h.text.clone())
                .tooltip(tip(h.title.clone())),
        );
    }
    if let Some(d) = m.done_at.as_ref().filter(|_| wide) {
        row = row.child(
            div()
                .id("status-line-done")
                .debug_selector(|| "status-line-done".into())
                .flex_none()
                .whitespace_nowrap()
                .opacity(0.7)
                .child(format!("done {d}"))
                .tooltip(tip(crate::line::DONE_TITLE.into())),
        );
    }
    row.into_any_element()
}

fn mode_selector(
    this: &StatusLineView,
    m: &StatusLineModel,
    c: &Colors,
    wide: bool,
    cx: &mut Context<StatusLineView>,
) -> AnyElement {
    let meta = m.mode.meta;
    let open = this.open == Some(Popup::Mode);
    let trigger = div()
        .id("mode-selector-trigger")
        .debug_selector(|| "mode-selector-trigger".into())
        .flex()
        .items_center()
        .gap(px(6.))
        .rounded(px(6.))
        .border_1()
        .border_color(hsla(c.border))
        .bg(hsla(if open { c.panel } else { c.panel_2 }))
        .hover(|d| d.bg(hsla(c.panel)))
        .px(px(8.))
        .py(px(4.))
        .text_size(px(12.))
        .cursor_pointer()
        .children(icon(meta.icon, 14., c.tone(meta.tone)))
        .when(wide, |d| {
            d.child(
                div()
                    .debug_selector(|| "mode-selector-label".into())
                    .text_color(hsla(c.foreground))
                    .child(meta.label),
            )
        })
        .children(icon("ChevronDown", 12., a(c.muted, 60.)))
        .tooltip(tip(m.mode.title.clone()))
        .on_click(cx.listener(|this, _, _, cx| this.toggle(Popup::Mode, cx)));
    div()
        .relative()
        .flex_none()
        .child(trigger)
        .when(open, |d| d.child(mode_menu(this, c, cx)))
        .into_any_element()
}

/// The open mode menu (`w-72`, under the trigger, right-aligned).
fn mode_menu(this: &StatusLineView, c: &Colors, cx: &mut Context<StatusLineView>) -> AnyElement {
    let (mode, disabled) = this
        .props
        .as_ref()
        .map(|p| (p.permission_mode.clone(), p.disabled_modes.clone()))
        .unwrap_or_default();
    let rows = modes::menu(&mode, &disabled).into_iter().map(|o| {
        let m = o.meta.mode;
        let name = format!("mode-selector-option-{m}");
        div()
            .id(id(name.clone()))
            .debug_selector(sel(name))
            .flex()
            .items_start()
            .gap(px(8.))
            .w_full()
            .px(px(12.))
            .py(px(8.))
            .text_size(px(12.))
            .line_height(px(16.))
            .cursor_pointer()
            .when(o.active, |d| d.bg(hsla(c.panel_2)))
            .hover(|d| d.bg(hsla(c.panel_2)))
            .child(div().mt(px(1.)).flex_none().children(icon(
                o.meta.icon,
                14.,
                c.tone(o.meta.tone),
            )))
            .child(
                div()
                    .flex_1()
                    .min_w_0()
                    .child(
                        div()
                            .font_weight(FontWeight::MEDIUM)
                            .text_color(hsla(c.foreground))
                            .child(o.meta.label),
                    )
                    .child(div().text_color(hsla(c.muted)).child(o.meta.description)),
            )
            .when(o.active, |d| {
                d.child(
                    div()
                        .flex_none()
                        .text_size(px(10.))
                        .text_color(hsla(c.accent))
                        .child("\u{25cf}"),
                )
            })
            .on_click(cx.listener(move |this, _, _, cx| this.pick_mode(m, cx)))
    });
    deferred(
        div()
            .id("mode-selector-menu")
            .debug_selector(|| "mode-selector-menu".into())
            .occlude()
            .absolute()
            .right_0()
            .top_full()
            .mt(px(4.))
            .w(px(288.))
            .rounded(px(8.))
            .border_1()
            .border_color(hsla(c.border))
            .bg(hsla(c.panel))
            .shadow_2xl()
            .overflow_hidden()
            .child(
                div()
                    .px(px(12.))
                    .py(px(8.))
                    .text_size(px(10.))
                    .text_color(hsla(c.muted))
                    .child(modes::MENU_HEADER.to_uppercase()),
            )
            .children(rows)
            .on_mouse_down_out(cx.listener(|this, _, _, cx| this.close(cx))),
    )
    .with_priority(1)
    .into_any_element()
}

/// The model picker's panel (`ModelPicker.tsx`), under the model chip.
fn model_panel(this: &StatusLineView, c: &Colors, cx: &mut Context<StatusLineView>) -> AnyElement {
    let header = |icon_name: &str, label: &str| {
        div()
            .flex()
            .items_center()
            .gap(px(6.))
            .px(px(12.))
            .py(px(8.))
            .children(icon(icon_name, 12., hsla(c.accent)))
            .child(
                div()
                    .text_size(px(11.))
                    .font_weight(FontWeight::MEDIUM)
                    .text_color(hsla(c.muted))
                    .child(label.to_uppercase()),
            )
    };
    let mut panel = div()
        .id("model-picker-panel")
        .debug_selector(|| "model-picker-panel".into())
        .occlude()
        .absolute()
        .left_0()
        .top_full()
        .mt(px(4.))
        .w(px(320.))
        .max_h(px(560.))
        .overflow_y_scroll()
        .rounded(px(6.))
        .border_1()
        .border_color(hsla(c.border))
        .bg(hsla(c.panel))
        .shadow_lg()
        .py(px(4.))
        .text_size(px(12.))
        .line_height(px(16.))
        .child(
            header("Cpu", "Model")
                .border_b_1()
                .border_color(a(c.border, 60.)),
        );
    match &this.models {
        ModelList::Loading => {
            panel = panel.child(
                div()
                    .debug_selector(|| "model-picker-loading".into())
                    .flex()
                    .items_center()
                    .gap(px(8.))
                    .px(px(12.))
                    .py(px(16.))
                    .children(icon("Loader2", 12., hsla(c.muted)))
                    .child("Loading models\u{2026}"),
            );
        }
        ModelList::Failed(e) => {
            panel = panel.child(
                div()
                    .debug_selector(|| "model-picker-error".into())
                    .px(px(12.))
                    .py(px(12.))
                    .child(
                        div()
                            .font_weight(FontWeight::MEDIUM)
                            .text_color(hsla(c.foreground))
                            .child("Couldn't load models"),
                    )
                    .child(div().mt(px(4.)).text_size(px(10.)).child(e.clone())),
            );
        }
        ModelList::Loaded(list) if list.is_empty() => {
            panel = panel.child(div().px(px(12.)).py(px(12.)).child("No models available."));
        }
        ModelList::Loaded(list) => {
            let pm = picker::picker(list, &this.picker_inputs());
            for row in pm.rows {
                let name = format!("model-picker-option-{}", row.value);
                let v = row.value.clone();
                panel =
                    panel.child(
                        div()
                            .id(id(name.clone()))
                            .debug_selector(sel(name))
                            .flex()
                            .items_start()
                            .gap(px(8.))
                            .px(px(12.))
                            .py(px(8.))
                            .cursor_pointer()
                            .when(row.current, |d| d.bg(a(c.panel_2, 40.)))
                            .hover(|d| d.bg(a(c.panel_2, 60.)))
                            .child(div().mt(px(2.)).flex_none().children(icon(
                                "Check",
                                12.,
                                if row.current {
                                    hsla(c.accent)
                                } else {
                                    Hsla::transparent_black()
                                },
                            )))
                            .child(
                                div()
                                    .flex_1()
                                    .min_w_0()
                                    .child(
                                        div()
                                            .flex()
                                            .items_center()
                                            .gap(px(8.))
                                            .child(
                                                div()
                                                    .truncate()
                                                    .font_weight(FontWeight::MEDIUM)
                                                    .text_color(hsla(c.foreground))
                                                    .child(row.label.clone()),
                                            )
                                            .when(row.effort_tag, |d| {
                                                d.child(tag(c, Chip::Panel, "effort"))
                                            })
                                            .when(row.fast_tag, |d| {
                                                d.child(tag(c, Chip::Amber, "fast"))
                                            }),
                                    )
                                    .when(!row.description.is_empty(), |d| {
                                        d.child(
                                            div()
                                                .mt(px(2.))
                                                .truncate()
                                                .text_size(px(10.))
                                                .child(row.description.clone()),
                                        )
                                    })
                                    .when(row.credits, |d| {
                                        d.child(
                                            div()
                                                .mt(px(2.))
                                                .text_size(px(9.))
                                                .text_color(step_a("amber-200", 80.))
                                                .child("Draws from usage credits"),
                                        )
                                    })
                                    .child(
                                        div()
                                            .mt(px(2.))
                                            .truncate()
                                            .font_family(fonts::MONO)
                                            .text_size(px(9.))
                                            .text_color(a(c.muted, 80.))
                                            .child(row.value.clone()),
                                    ),
                            )
                            .on_click(cx.listener(move |this, _, _, cx| {
                                this.pick(Pick::Model(v.clone()), cx)
                            })),
                    );
            }
            if let Some((name, chips)) = pm.effort {
                panel = panel.child(
                    header("Gauge", "Effort")
                        .border_t_1()
                        .border_color(a(c.border, 60.))
                        .child(
                            div()
                                .ml_auto()
                                .truncate()
                                .font_family(fonts::MONO)
                                .text_size(px(9.))
                                .text_color(a(c.muted, 80.))
                                .child(name),
                        ),
                );
                let chips = chips.into_iter().map(|ch| effort_chip(ch, c, cx));
                panel = panel
                    .child(
                        div()
                            .flex()
                            .flex_wrap()
                            .gap(px(6.))
                            .px(px(12.))
                            .pt(px(4.))
                            .pb(px(12.))
                            .children(chips),
                    )
                    .child(
                        div()
                            .px(px(12.))
                            .pb(px(8.))
                            .text_size(px(10.))
                            .child(picker::EFFORT_NOTE),
                    );
            }
            if let Some(u) = pm.ultracode {
                let p = u.pick.clone();
                panel = panel.child(toggle_row(
                    c,
                    "model-picker-ultracode",
                    (
                        "Workflow",
                        if u.enabled {
                            hsla(c.accent)
                        } else {
                            hsla(c.muted)
                        },
                    ),
                    "Dynamic Workflows",
                    &["Parallel subagents at any effort. Needs a Workflows-enabled plan."],
                    None,
                    u.enabled,
                    hsla(c.accent),
                    cx.listener(move |this, _, _, cx| this.pick(p.clone(), cx)),
                ));
            }
            if let Some(f) = pm.fast {
                let p = f.pick.clone();
                panel = panel.child(toggle_row(
                    c,
                    "model-picker-fast",
                    (
                        "Zap",
                        if f.enabled {
                            step("amber-300")
                        } else {
                            hsla(c.muted)
                        },
                    ),
                    &f.label,
                    &["Accelerated responses from the same model."],
                    Some("Draws from usage credits."),
                    f.enabled,
                    step("amber-500"),
                    cx.listener(move |this, _, _, cx| this.pick(p.clone(), cx)),
                ));
                if let Some(d) = f.deprecation {
                    panel = panel.child(
                        div().px(px(12.)).pb(px(8.)).child(
                            div()
                                .debug_selector(|| "model-picker-fast-deprecation".into())
                                .rounded(px(4.))
                                .border_1()
                                .border_color(step_a("amber-500", 30.))
                                .bg(step_a("amber-500", 10.))
                                .px(px(8.))
                                .py(px(4.))
                                .text_size(px(10.))
                                .text_color(step("amber-200"))
                                .child(d),
                        ),
                    );
                }
            }
        }
    }
    deferred(panel.on_mouse_down_out(cx.listener(|this, _, _, cx| this.close(cx))))
        .with_priority(1)
        .into_any_element()
}

fn tag(c: &Colors, look: Chip, text: &'static str) -> Div {
    let (border, bg, fg) = match look {
        Chip::Amber => (
            step_a("amber-500", 30.),
            step_a("amber-500", 10.),
            step("amber-200"),
        ),
        _ => (hsla(c.border), hsla(c.panel_2), hsla(c.muted)),
    };
    div()
        .flex_none()
        .rounded(px(4.))
        .border_1()
        .border_color(border)
        .bg(bg)
        .px(px(4.))
        .text_size(px(9.))
        .line_height(px(12.))
        .text_color(fg)
        .child(text)
}

/// An effort chip's tint (`EffortChip`'s `toneClass`): `adaptive` is the
/// neutral chip (`None`), and any tone the chain doesn't name falls to
/// its last branch, ultracode's fuchsia.
fn effort_tint(tone: &str) -> Option<&'static str> {
    Some(match tone {
        "adaptive" => return None,
        "low" => "sky",
        "medium" => "violet",
        "high" => "emerald",
        "xhigh" => "amber",
        "max" => "red",
        _ => "fuchsia",
    })
}

fn effort_chip(ch: picker::EffortChip, c: &Colors, cx: &mut Context<StatusLineView>) -> AnyElement {
    let name = format!("model-picker-effort-{}", ch.tone);
    let base = div()
        .id(id(name.clone()))
        .debug_selector(sel(name))
        .rounded(px(4.))
        .border_1()
        .px(px(8.))
        .py(px(4.))
        .text_size(px(10.))
        .font_weight(FontWeight::MEDIUM)
        .cursor_pointer();
    let styled = match effort_tint(&ch.tone) {
        Some(t) => {
            let hover = step_a(&format!("{t}-500"), 20.);
            base.border_color(step_a(&format!("{t}-500"), 30.))
                .bg(step_a(&format!("{t}-500"), 10.))
                .text_color(step(&format!("{t}-200")))
                .hover(move |d| d.bg(hover))
        }
        None => base
            .border_color(hsla(c.border))
            .bg(hsla(c.panel_2))
            .text_color(hsla(c.muted))
            .hover(|d| d.text_color(hsla(c.foreground))),
    };
    let pick = ch.pick.clone();
    styled
        .child(ch.label)
        .on_click(cx.listener(move |this, _, _, cx| this.pick(pick.clone(), cx)))
        .into_any_element()
}

#[allow(clippy::too_many_arguments)]
fn toggle_row(
    c: &Colors,
    name: &str,
    (icon_name, icon_color): (&str, Hsla),
    label: &str,
    lines: &[&str],
    credits: Option<&str>,
    enabled: bool,
    on_color: Hsla,
    on_click: impl Fn(&gpui_kit::ClickEvent, &mut Window, &mut App) + 'static,
) -> AnyElement {
    let knob = div()
        .relative()
        .flex_none()
        .w(px(28.))
        .h(px(16.))
        .rounded_full()
        .bg(if enabled { on_color } else { hsla(c.border) })
        .child(
            div()
                .absolute()
                .top(px(2.))
                .left(px(if enabled { 14. } else { 2. }))
                .size(px(12.))
                .rounded_full()
                .bg(step("white")),
        );
    div()
        .border_t_1()
        .border_color(a(c.border, 60.))
        .px(px(12.))
        .py(px(8.))
        .child(
            div()
                .id(id(name))
                .debug_selector(sel(format!(
                    "{name}-{}",
                    if enabled { "on" } else { "off" }
                )))
                .flex()
                .items_center()
                .gap(px(8.))
                .rounded(px(4.))
                .border_1()
                .border_color(if enabled {
                    Hsla { a: 0.4, ..on_color }
                } else {
                    hsla(c.border)
                })
                .bg(if enabled {
                    Hsla { a: 0.1, ..on_color }
                } else {
                    hsla(c.panel_2)
                })
                .px(px(8.))
                .py(px(6.))
                .cursor_pointer()
                .children(icon(icon_name, 14., icon_color))
                .child(
                    div()
                        .flex_1()
                        .min_w_0()
                        .child(
                            div()
                                .text_size(px(11.))
                                .font_weight(FontWeight::MEDIUM)
                                .text_color(hsla(c.foreground))
                                .child(label.to_owned()),
                        )
                        .children(lines.iter().map(|l| {
                            div()
                                .text_size(px(9.))
                                .line_height(px(12.))
                                .text_color(hsla(c.muted))
                                .child((*l).to_owned())
                        }))
                        .when_some(credits, |d, t| {
                            d.child(
                                div()
                                    .mt(px(2.))
                                    .text_size(px(9.))
                                    .line_height(px(12.))
                                    .text_color(step_a("amber-200", 80.))
                                    .child(t.to_owned()),
                            )
                        }),
                )
                .child(knob)
                .on_click(on_click),
        )
        .into_any_element()
}
