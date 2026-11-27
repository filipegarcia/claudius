//! The plan approval on screen: `PlanOverlay.tsx` (the review panel and
//! its minimized pill) and `PlanModeBanner.tsx`.

use gpui_kit::Focusable as _;
use gpui_kit::component::input::{InputEvent, Textarea, TextareaState};
use gpui_kit::component::text::{TextView, TextViewStyle};
use gpui_kit::prelude::FluentBuilder as _;
use gpui_kit::{
    AppContext as _, Context, Entity, EventEmitter, FontWeight, HighlightStyle,
    InteractiveElement as _, IntoElement, ParentElement as _, Render, SharedString,
    StatefulInteractiveElement as _, Styled as _, StyledText, Subscription, Window, div, px,
};

use super::style::{Colors, Look, a, caps, clickable, h, icon, icon_button, panel, step, tint};
use std::sync::Arc;

use claudius_gpui_theme::ThemeName;
use gpui_kit::Task;

use crate::plan::{PLAN_EXIT_MODE, PendingPlan, PlanForm, PlanResolution};
use crate::target::{PromptState, PromptTarget};

/// What the overlay asks for.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum PlanEvent {
    Resolve(PlanResolution),
}

/// The overlay over a pending plan. ChatSurface mounts it unkeyed while a
/// plan is pending, so its form outlives a plan that replaces the shown one.
pub struct PlanView {
    pub(crate) plan: PendingPlan,
    pub(crate) form: PlanForm,
    colors: Colors,
    editor: Option<Entity<TextareaState>>,
    _subs: Vec<Subscription>,
}

impl EventEmitter<PlanEvent> for PlanView {}

impl PlanView {
    pub fn new(plan: PendingPlan, colors: Colors) -> Self {
        PlanView {
            form: PlanForm::new(&plan),
            plan,
            colors,
            editor: None,
            _subs: Vec::new(),
        }
    }

    pub fn form(&self) -> &PlanForm {
        &self.form
    }

    pub fn plan(&self) -> &PendingPlan {
        &self.plan
    }

    /// The editor (made on the first "Edit").
    pub fn editor(&self) -> Option<Entity<TextareaState>> {
        self.editor.clone()
    }

    pub fn set_colors(&mut self, colors: Colors) {
        self.colors = colors;
    }

    /// The pending plan changed (a re-emit or a replacement): the form stays.
    pub fn refresh(&mut self, plan: PendingPlan, cx: &mut Context<Self>) {
        if plan != self.plan {
            self.plan = plan;
            cx.notify();
        }
    }

    fn emit(&mut self, r: PlanResolution, cx: &mut Context<Self>) {
        cx.emit(PlanEvent::Resolve(r));
    }

    pub fn accept(&mut self, cx: &mut Context<Self>) {
        let r = self.form.accept(&self.plan.plan);
        self.emit(r, cx);
    }

    pub fn reject(&mut self, cx: &mut Context<Self>) {
        self.emit(PlanForm::reject(), cx);
    }

    /// The header's X (`onClose`): a soft reject.
    pub fn dismiss(&mut self, cx: &mut Context<Self>) {
        self.emit(PlanForm::dismiss(), cx);
    }

    pub fn set_minimized(&mut self, minimized: bool, cx: &mut Context<Self>) {
        self.form.minimized = minimized;
        cx.notify();
    }

    /// "Edit": the editor over the draft, focused (`autoFocus`).
    pub fn edit(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.form.edit();
        let draft = self.form.draft.clone();
        let editor = match &self.editor {
            Some(e) => {
                e.update(cx, |e, cx| e.set_value(draft, window, cx));
                e.clone()
            }
            None => {
                let e = cx.new(|cx| TextareaState::new(window, cx).rows(24).default_value(draft));
                let sub = cx.subscribe_in(
                    &e,
                    window,
                    |this: &mut Self, e, ev: &InputEvent, window, cx| match ev {
                        InputEvent::Change => {
                            this.form.draft = e.read(cx).value().to_string();
                            cx.notify();
                        }
                        // ⌘/Ctrl+Enter accepts (the edited plan when dirty).
                        InputEvent::PressEnter {
                            secondary: true, ..
                        } => this.accept(cx),
                        _ => {
                            let _ = window;
                        }
                    },
                );
                self._subs.push(sub);
                self.editor = Some(e.clone());
                e
            }
        };
        let handle = editor.focus_handle(cx);
        window.focus(&handle, cx);
        cx.notify();
    }

    /// "Discard edits", and Escape in the editor.
    pub fn discard(&mut self, cx: &mut Context<Self>) {
        self.form.discard(&self.plan.plan);
        cx.notify();
    }

    /// An Escape the shell saw: in the editor it discards the edits; the
    /// overlay itself ignores Escape (`dismissOnBackdrop={false}`).
    pub fn escape(&mut self, window: &Window, cx: &mut Context<Self>) -> bool {
        let in_editor = self
            .editor
            .as_ref()
            .is_some_and(|e| e.focus_handle(cx).is_focused(window));
        if self.form.editing && in_editor {
            self.discard(cx);
            return true;
        }
        false
    }

    fn render_pill(&self, cx: &mut Context<Self>) -> gpui_kit::AnyElement {
        let c = self.colors;
        div()
            .absolute()
            .bottom(px(96.))
            .right(px(24.))
            .child(
                clickable("plan-overlay-restore")
                    .flex()
                    .items_center()
                    .gap(px(8.))
                    .rounded_full()
                    .border_1()
                    .border_color(a(step("violet-500"), 40.))
                    .bg(h(c.panel))
                    .px(px(16.))
                    .py(px(8.))
                    .text_size(px(14.))
                    .text_color(h(c.foreground))
                    .shadow_2xl()
                    .children(icon(
                        "ListChecks",
                        16.,
                        tint(&c, "violet-300", "violet-600"),
                    ))
                    .child(
                        div()
                            .font_weight(FontWeight::MEDIUM)
                            .child("Plan ready for review"),
                    )
                    .children(icon("Maximize2", 14., h(c.muted)))
                    .on_click(cx.listener(|this, _, _, cx| this.set_minimized(false, cx))),
            )
            .into_any_element()
    }
}

impl Render for PlanView {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        if self.form.minimized {
            return self.render_pill(cx);
        }
        let c = self.colors;
        let plan = self.plan.plan.clone();
        let editing = self.form.editing;
        let violet_fg = tint(&c, "violet-200", "violet-700");
        let header_btn = |id: &'static str, name: &str| {
            clickable(id)
                .rounded(px(4.))
                .p(px(4.))
                .children(icon(name, 16., h(c.muted)))
        };
        let header = div()
            .flex()
            .items_start()
            .gap(px(12.))
            .border_b_1()
            .border_color(h(c.border))
            .px(px(16.))
            .py(px(12.))
            .child(
                div()
                    .min_w_0()
                    .flex_1()
                    .child(caps("ExitPlanMode", &c))
                    .child(
                        div()
                            .mt(px(2.))
                            .text_size(px(14.))
                            .font_weight(FontWeight::MEDIUM)
                            .child("Plan ready for review"),
                    ),
            )
            .child(
                header_btn("plan-overlay-minimize", "Minus")
                    .on_click(cx.listener(|this, _, _, cx| this.set_minimized(true, cx))),
            )
            .child(
                header_btn("plan-overlay-close", "X")
                    .on_click(cx.listener(|this, _, _, cx| this.dismiss(cx))),
            );

        let mut note = div()
            .flex()
            .flex_wrap()
            .items_center()
            .gap(px(4.))
            .border_b_1()
            .border_color(a(step("violet-500"), 30.))
            .bg(a(step("violet-500"), 10.))
            .px(px(16.))
            .py(px(8.))
            .text_size(px(11.))
            .text_color(violet_fg)
            .children(icon("ListChecks", 14., violet_fg))
            .child("Claude has produced a plan. Accepting will switch this session to")
            .child(
                div()
                    .font_family(claudius_gpui_theme::fonts::MONO)
                    .child("acceptEdits"),
            )
            .child("so the agent can execute it.");
        if editing {
            note = note.child(
                div()
                    .ml(px(8.))
                    .opacity(0.8)
                    .child("\u{00B7} Editing \u{2014} your changes ship to the SDK as the tool\u{2019}s effective input."),
            );
        }

        let body = match (&self.editor, editing) {
            (Some(editor), true) => div()
                .debug_selector(|| "plan-overlay-editor".into())
                .px(px(16.))
                .py(px(16.))
                .font_family(claudius_gpui_theme::fonts::MONO)
                .text_size(px(12.))
                .child(Textarea::new(editor).h(px(440.)))
                .into_any_element(),
            _ => div()
                .id("plan-overlay-preview")
                .debug_selector(|| "plan-overlay-preview".into())
                .max_h(window.viewport_size().height * 0.6)
                .overflow_y_scroll()
                .px(px(16.))
                .py(px(16.))
                .text_size(px(15.))
                .line_height(px(28.))
                .child(
                    TextView::markdown(
                        "plan-overlay-markdown",
                        SharedString::from(self.form.draft.clone()),
                    )
                    .style(TextViewStyle {
                        is_dark: c.dark,
                        ..Default::default()
                    })
                    .w_full(),
                )
                .into_any_element(),
        };

        let accept_label = self.form.accept_label(&plan);
        let footer = div()
            .flex()
            .items_center()
            .gap(px(8.))
            .border_t_1()
            .border_color(h(c.border))
            .bg(a(c.panel_2, 50.))
            .px(px(16.))
            .py(px(12.))
            .child(
                icon_button(
                    "plan-overlay-accept",
                    "Check",
                    accept_label,
                    Look::Primary,
                    &c,
                )
                .on_click(cx.listener(|this, _, _, cx| this.accept(cx))),
            )
            .map(|f| {
                if editing {
                    f.child(
                        icon_button(
                            "plan-overlay-discard",
                            "X",
                            "Discard edits",
                            Look::Secondary,
                            &c,
                        )
                        .on_click(cx.listener(|this, _, _, cx| this.discard(cx))),
                    )
                } else {
                    f.child(
                        icon_button("plan-overlay-edit", "Pencil", "Edit", Look::Secondary, &c)
                            .on_click(cx.listener(|this, _, window, cx| this.edit(window, cx))),
                    )
                }
            })
            .child(
                icon_button(
                    "plan-overlay-reject",
                    "X",
                    "Reject & iterate",
                    Look::Secondary,
                    &c,
                )
                .on_click(cx.listener(|this, _, _, cx| this.reject(cx))),
            )
            .child(
                div()
                    .ml_auto()
                    .font_family(claudius_gpui_theme::fonts::MONO)
                    .text_size(px(10.))
                    .text_color(h(c.muted))
                    .child(format!("tool_use_id={}", self.plan.tool_use_id)),
            );

        div()
            .id("plan-overlay-backdrop")
            .debug_selector(|| "plan-overlay".into())
            .absolute()
            .top_0()
            .left_0()
            .size_full()
            .flex()
            .flex_col()
            .items_center()
            .pt(window.viewport_size().height * 0.08)
            .px(px(16.))
            .bg(gpui_kit::black().opacity(0.6))
            .occlude()
            .child(
                panel(&c, 1024.)
                    .max_h(window.viewport_size().height * 0.88)
                    .child(header)
                    .child(note)
                    .child(body)
                    .child(footer),
            )
            .into_any_element()
    }
}

/// The banner's text; its first two words are bold.
const BANNER: &str = "Plan mode \u{2014} Claude will produce a plan and propose it before any tool side effects. Use the plan overlay to accept (switches to acceptEdits) or stay in plan mode to iterate.";

/// The violet strip under the chat header while the session is in plan
/// mode (`PlanModeBanner`); "Exit" sets the mode to `default`.
pub struct PlanBanner {
    target: Arc<dyn PromptTarget>,
    pub(crate) mode: Option<String>,
    colors: Colors,
    _listen: Task<()>,
}

impl PlanBanner {
    pub fn new(target: Arc<dyn PromptTarget>, theme: ThemeName, cx: &mut Context<Self>) -> Self {
        let listen = super::overlays::listen(&target, cx, Self::sync);
        let mut this = PlanBanner {
            target,
            mode: None,
            colors: Colors::of(theme),
            _listen: listen,
        };
        this.sync(cx);
        this
    }

    pub fn shows(&self) -> bool {
        crate::plan::plan_mode_banner(self.mode.as_deref())
    }

    pub fn set_theme(&mut self, theme: ThemeName, cx: &mut Context<Self>) {
        self.colors = Colors::of(theme);
        cx.notify();
    }

    fn sync(&mut self, cx: &mut Context<Self>) {
        let mode = PromptState::read(&*self.target).permission_mode;
        if mode != self.mode {
            self.mode = mode;
            cx.notify();
        }
    }

    pub fn exit(&mut self) {
        self.target.act(Box::new(|s, env| {
            s.set_permission_mode(PLAN_EXIT_MODE, env)
        }));
    }
}

impl Render for PlanBanner {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let c = self.colors;
        let fg = tint(&c, "violet-200", "violet-700");
        div().when(self.shows(), |d| {
            d.debug_selector(|| "plan-mode-banner".into())
                .flex()
                .items_center()
                .gap(px(8.))
                .border_b_1()
                .border_color(a(step("violet-500"), 30.))
                .bg(a(step("violet-500"), 10.))
                .px(px(16.))
                .py(px(6.))
                .text_size(px(11.))
                .text_color(fg)
                .children(icon("ListChecks", 14., fg))
                .child(
                    div()
                        .flex_1()
                        .min_w_0()
                        .child(StyledText::new(BANNER).with_highlights([(
                            0.."Plan mode".len(),
                            HighlightStyle {
                                font_weight: Some(FontWeight::BOLD),
                                ..Default::default()
                            },
                        )])),
                )
                .child(
                    clickable("plan-mode-exit")
                        .ml_auto()
                        .flex()
                        .items_center()
                        .gap(px(4.))
                        .rounded(px(6.))
                        .border_1()
                        .border_color(a(step("violet-500"), 30.))
                        .bg(a(step("violet-500"), 10.))
                        .px(px(8.))
                        .py(px(2.))
                        .text_size(px(10.))
                        .children(icon("X", 12., fg))
                        .child("Exit")
                        .on_click(cx.listener(|this, _, _, _| this.exit())),
                )
        })
    }
}
