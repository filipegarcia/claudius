//! [`GoalBannerView`]: `GoalBanner` on screen, as `ChatSurface` mounts it
//! (`embedded`, in the session header: `border-b
//! border-[var(--border)] bg-[var(--panel-2)]/40`, the row centered in the
//! chat column, `px-4 text-xs pt-0.5 pb-2`).
//!
//! It reads the bound session's goal from its [`RailTarget`] and keeps
//! the banner's own state: editing (the inline editor), and the hidden
//! setting (`useGoalBannerHidden`, `claudius.goalBannerHidden`, handed in
//! and reported back as [`RailEvent::Pref`]). Submitting runs
//! `handleGoalSubmit` (ChatSurface.tsx:2090): `setGoal(text)`, awaited,
//! then `send(text, { fromGoal: true })`.
//!
//! The editor is a plain one-line input (the React editor is the chat's
//! `PromptInput`: images and @-mentions are not here). The session
//! header's title row (`RecapBanner`, its "show the goal" affordance) is
//! not drawn: the frame draws only around a goal row.

use std::sync::Arc;

use claudius_client::queue::SendOpts;
use claudius_client::state::ChatState;
use claudius_gpui_theme::ThemeName;
use claudius_theme::chat::{ChatSize, chat_column_with};
use futures::StreamExt as _;
use gpui_kit::component::input::{Input, InputEvent, InputState};
use gpui_kit::prelude::FluentBuilder as _;
use gpui_kit::{
    AnyElement, AppContext as _, Context, Entity, EventEmitter, FontWeight,
    InteractiveElement as _, IntoElement, ParentElement as _, Render,
    StatefulInteractiveElement as _, Styled as _, Subscription, Task, Window, div, px,
};

use crate::goal::{self, Banner, GOAL_HIDDEN_KEY};
use crate::look::Paint;
use crate::paint::{Colors, icon, step, step_a, tip, upper};
use crate::target::RailTarget;
use crate::view::RailEvent;

/// The goal row of one chat's session header.
pub struct GoalBannerView {
    target: Arc<dyn RailTarget>,
    theme: ThemeName,
    hidden: bool,
    editing: bool,
    editor: Option<Entity<InputState>>,
    _editor_sub: Option<Subscription>,
    /// The banner as it draws (`None`: no bound session).
    banner: Option<Banner>,
    submit: Option<Task<()>>,
    renders: usize,
    _listen: Task<()>,
}

impl EventEmitter<RailEvent> for GoalBannerView {}

impl GoalBannerView {
    /// Over `target`, with `claudius.goalBannerHidden`'s stored value.
    pub fn new(
        target: Arc<dyn RailTarget>,
        theme: ThemeName,
        hidden_pref: Option<&str>,
        cx: &mut Context<Self>,
    ) -> Self {
        let mut changes = target.changes();
        let listen = cx.spawn(async move |this, cx| {
            while changes.next().await.is_some() {
                if this.update(cx, |this, cx| this.refresh(cx)).is_err() {
                    break;
                }
            }
        });
        let mut view = GoalBannerView {
            target,
            theme,
            hidden: goal::goal_hidden(hidden_pref),
            editing: false,
            editor: None,
            _editor_sub: None,
            banner: None,
            submit: None,
            renders: 0,
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

    /// The banner as it draws (`None`: no bound session).
    pub fn banner(&self) -> Option<&Banner> {
        self.banner.as_ref()
    }

    pub fn hidden(&self) -> bool {
        self.hidden
    }

    pub fn editing(&self) -> bool {
        self.editing
    }

    pub fn renders(&self) -> usize {
        self.renders
    }

    /// The editor's text, while editing.
    pub fn draft(&self, cx: &gpui_kit::App) -> Option<String> {
        self.editor
            .as_ref()
            .filter(|_| self.editing)
            .map(|e| e.read(cx).value().to_string())
    }

    /// `setHidden(next)`: the × hides the empty prompt; Settings (or the
    /// title row) shows it again. `removeItem` is a `"0"` here.
    pub fn set_hidden(&mut self, hidden: bool, cx: &mut Context<Self>) {
        if self.hidden == hidden {
            return;
        }
        self.hidden = hidden;
        cx.emit(RailEvent::Pref {
            key: GOAL_HIDDEN_KEY.into(),
            value: if hidden { "1" } else { "0" }.into(),
        });
        self.refresh(cx);
    }

    /// "Set a session goal", the pencil, and `/goal` with no argument
    /// (`openEditNonce`): the editor over the goal's text, focused.
    pub fn open_editor(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let mut prefill = String::new();
        self.target.read(&mut |s: &ChatState| {
            if let Banner::Editor { prefill: p } = goal::banner(s.goal.as_ref(), true, false) {
                prefill = p;
            }
        });
        let editor = match &self.editor {
            Some(e) => {
                e.update(cx, |e, cx| e.set_value(prefill, window, cx));
                e.clone()
            }
            None => {
                let e = cx.new(|cx| {
                    InputState::new(window, cx)
                        .placeholder(goal::EDITOR_PLACEHOLDER)
                        .default_value(prefill)
                });
                let sub = cx.subscribe_in(
                    &e,
                    window,
                    |this: &mut Self, _, ev: &InputEvent, _window, cx| {
                        if let InputEvent::PressEnter { shift: false, .. } = ev {
                            this.submit(cx);
                        }
                    },
                );
                self._editor_sub = Some(sub);
                self.editor = Some(e.clone());
                e
            }
        };
        self.editing = true;
        editor.update(cx, |e, cx| e.focus(window, cx));
        self.refresh(cx);
    }

    /// Types into the editor (tests).
    pub fn set_draft(&mut self, text: &str, window: &mut Window, cx: &mut Context<Self>) {
        if let Some(e) = &self.editor {
            let t = text.to_owned();
            e.update(cx, |e, cx| e.set_value(t, window, cx));
        }
    }

    /// The editor's × and Escape.
    pub fn cancel_edit(&mut self, cx: &mut Context<Self>) {
        if self.editing {
            self.editing = false;
            self.refresh(cx);
        }
    }

    /// Enter in the editor: a blank goal sends nothing (the composer
    /// doesn't send an empty prompt); else the editor closes and
    /// `handleGoalSubmit` runs.
    pub fn submit(&mut self, cx: &mut Context<Self>) {
        let Some(text) = self.draft(cx) else { return };
        let Some(text) = goal::goal_submit_text(&text) else {
            return;
        };
        self.editing = false;
        let target = self.target.clone();
        let rx = target.set_goal(text.clone());
        self.submit = Some(cx.spawn(async move |_, _| {
            // `await session.setGoal(trimmed)`: its outcome isn't read.
            let _ = rx.await;
            drop(target.send(
                text,
                SendOpts {
                    from_goal: true,
                    ..SendOpts::default()
                },
            ));
        }));
        self.refresh(cx);
    }

    /// The ×: `onClear` (`session.clearGoal`).
    pub fn clear(&mut self) {
        self.target.act(Box::new(|s, env| s.clear_goal(env)));
    }

    fn refresh(&mut self, cx: &mut Context<Self>) {
        let (editing, hidden) = (self.editing, self.hidden);
        let mut next = None;
        self.target.read(&mut |s: &ChatState| {
            if s.session_id.as_deref().is_some_and(|x| !x.is_empty()) {
                next = Some(goal::banner(s.goal.as_ref(), editing, hidden));
            }
        });
        if next != self.banner {
            self.banner = next;
            cx.notify();
        }
    }
}

impl Render for GoalBannerView {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        self.renders += 1;
        let c = Colors::of(self.theme);
        let Some(b) = self.banner.clone().filter(|b| *b != Banner::Hidden) else {
            return div().into_any_element();
        };
        let (col, _) = chat_column_with(
            f64::from(f32::from(window.viewport_size().width)),
            ChatSize {
                col_rem: None,
                text_px: None,
            },
        );
        let row = match b {
            Banner::Hidden => unreachable!("filtered"),
            Banner::Editor { .. } => editor(self, &c, cx),
            Banner::Empty => empty(&c, cx),
            Banner::Goal {
                text,
                achieved,
                summary,
                edit_label,
            } => goal_row(&text, achieved, summary.as_deref(), edit_label, &c, cx),
        };
        div()
            .debug_selector(|| "session-header".into())
            .flex_none()
            .w_full()
            .border_b_1()
            .border_color(c.border())
            .bg(c.at(Paint::Panel2, 40.))
            .pt(px(4.))
            .child(div().mx_auto().w_full().max_w(px(col as f32)).child(row))
            .into_any_element()
    }
}

fn editor(this: &GoalBannerView, c: &Colors, cx: &mut Context<GoalBannerView>) -> AnyElement {
    let Some(input) = this.editor.clone() else {
        return div().into_any_element();
    };
    div()
        .debug_selector(|| "goal-banner-editor".into())
        .px(px(8.))
        .pt(px(2.))
        .pb(px(4.))
        .capture_key_down(cx.listener(|this, ev: &gpui_kit::KeyDownEvent, _, cx| {
            if ev.keystroke.key == "escape" {
                cx.stop_propagation();
                this.cancel_edit(cx);
            }
        }))
        .child(
            div()
                .mb(px(4.))
                .flex()
                .items_center()
                .justify_between()
                .px(px(8.))
                .text_size(px(10.))
                .line_height(px(14.))
                .text_color(c.muted())
                .child(
                    div()
                        .flex()
                        .items_center()
                        .gap(px(6.))
                        .children(icon("Target", 12., c.accent()))
                        .child(upper(goal::EDITOR_HEADER)),
                )
                .child(
                    div()
                        .id("goal-banner-cancel")
                        .debug_selector(|| "goal-banner-cancel".into())
                        .rounded(px(4.))
                        .p(px(2.))
                        .cursor_pointer()
                        .children(icon("X", 12., c.muted()))
                        .tooltip(tip("Cancel (Esc)"))
                        .on_click(cx.listener(|this, _, _, cx| this.cancel_edit(cx))),
                ),
        )
        .child(
            div()
                .debug_selector(|| "goal-prompt-input".into())
                .rounded(px(8.))
                .border_1()
                .border_color(c.border())
                .bg(c.panel())
                .px(px(4.))
                .py(px(2.))
                .child(Input::new(&input).text_size(px(13.))),
        )
        .into_any_element()
}

fn empty(c: &Colors, cx: &mut Context<GoalBannerView>) -> AnyElement {
    div()
        .debug_selector(|| "goal-banner-empty".into())
        .flex()
        .items_center()
        .px(px(16.))
        .pt(px(2.))
        .pb(px(8.))
        .text_size(px(12.))
        .line_height(px(16.))
        .child(
            div()
                .id("goal-banner-set")
                .debug_selector(|| "goal-banner-set".into())
                .flex()
                .items_center()
                .gap(px(6.))
                .rounded(px(4.))
                .text_color(c.muted())
                .cursor_pointer()
                .hover(|d| d.text_color(c.fg()))
                .children(icon("Target", 14., c.muted()))
                .child(goal::SET_LABEL)
                .tooltip(tip(goal::SET_TITLE))
                .on_click(cx.listener(|this, _, window, cx| this.open_editor(window, cx))),
        )
        .child(
            div()
                .id("goal-banner-hide")
                .debug_selector(|| "goal-banner-hide".into())
                .ml_auto()
                .rounded(px(4.))
                .p(px(4.))
                .opacity(0.6)
                .cursor_pointer()
                .hover(|d| d.opacity(1.).bg(c.panel()))
                .children(icon("X", 12., c.muted()))
                .tooltip(tip(goal::HIDE_TITLE))
                .on_click(cx.listener(|this, _, _, cx| this.set_hidden(true, cx))),
        )
        .into_any_element()
}

fn goal_row(
    text: &str,
    achieved: bool,
    summary: Option<&str>,
    edit_label: &'static str,
    c: &Colors,
    cx: &mut Context<GoalBannerView>,
) -> AnyElement {
    let mark = if achieved {
        div()
            .mt(px(2.))
            .flex()
            .flex_none()
            .items_center()
            .justify_center()
            .size(px(14.))
            .rounded_full()
            .bg(step_a("emerald-500", 20.))
            .children(icon("Check", 10., step("emerald-300")))
    } else {
        div()
            .mt(px(2.))
            .flex_none()
            .children(icon("Target", 14., c.accent()))
    };
    let action = |name: &'static str, glyph: &'static str, title: &'static str| {
        div()
            .id(name)
            .debug_selector(move || name.into())
            .rounded(px(4.))
            .p(px(4.))
            .cursor_pointer()
            .hover(|d| d.bg(c.panel()))
            .children(icon(glyph, 12., c.muted()))
            .tooltip(tip(title))
    };
    div()
        .debug_selector(|| "goal-banner".into())
        .flex()
        .items_start()
        .gap(px(8.))
        .px(px(16.))
        .pt(px(2.))
        .pb(px(8.))
        .text_size(px(12.))
        .line_height(px(16.))
        .child(mark)
        .child(
            div()
                .flex()
                .min_w_0()
                .flex_1()
                .flex_col()
                .gap(px(2.))
                .child(
                    div()
                        .flex()
                        .min_w_0()
                        .items_center()
                        .gap(px(8.))
                        .child(
                            div()
                                .debug_selector(|| "goal-banner-text".into())
                                .min_w_0()
                                .truncate()
                                .text_color(c.at(Paint::Foreground, 90.))
                                .when(achieved, |d| d.line_through())
                                .child(text.to_owned()),
                        )
                        .when(achieved, |d| {
                            d.child(
                                div()
                                    .debug_selector(|| "goal-banner-achieved".into())
                                    .flex()
                                    .flex_none()
                                    .items_center()
                                    .gap(px(4.))
                                    .text_size(px(10.))
                                    .font_weight(FontWeight::SEMIBOLD)
                                    .text_color(step("emerald-300"))
                                    .children(icon("Sparkles", 12., step("emerald-300")))
                                    .child("GOAL ACHIEVED"),
                            )
                        }),
                )
                .children(summary.map(|s| {
                    div()
                        .debug_selector(|| "goal-banner-summary".into())
                        .text_size(px(11.))
                        .italic()
                        .text_color(c.muted())
                        .child(s.to_owned())
                })),
        )
        .child(
            div()
                .flex()
                .flex_none()
                .items_center()
                .gap(px(2.))
                .child(
                    action("goal-banner-edit", "Pencil", edit_label)
                        .on_click(cx.listener(|this, _, window, cx| this.open_editor(window, cx))),
                )
                .child(
                    action("goal-banner-clear", "X", "Clear goal")
                        .on_click(cx.listener(|this, _, _, _| this.clear())),
                ),
        )
        .into_any_element()
}
