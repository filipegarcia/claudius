//! The permission card on screen (`PermissionPrompt.tsx`): one view per
//! request (ChatSurface keys it by `requestId`), reporting the user's
//! choice as a [`PermissionEvent`].

use gpui_kit::Focusable as _;
use gpui_kit::component::input::{InputEvent, Textarea, TextareaState};
use gpui_kit::prelude::FluentBuilder as _;
use gpui_kit::{
    AppContext as _, Context, Entity, EventEmitter, FocusHandle, FontWeight,
    InteractiveElement as _, IntoElement, ParentElement as _, Render, SharedString,
    StatefulInteractiveElement as _, Styled as _, Subscription, Window, div, px,
};

use super::style::{
    Colors, Look, a, backdrop, button, caps, clickable, h, icon, panel, pill, step, tint,
};
use crate::permission::{
    AlwaysRule, Decision, PermissionAction, PermissionCard, PermissionForm, hidden_chars_text,
};

/// What the user chose.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum PermissionEvent {
    Act(PermissionAction),
}

pub struct PermissionView {
    pub(crate) card: PermissionCard,
    pub(crate) form: PermissionForm,
    colors: Colors,
    feedback: Option<Entity<TextareaState>>,
    /// "Deny without feedback", the decline `defaultToNo` focuses.
    pub(crate) decline: FocusHandle,
    _subs: Vec<Subscription>,
}

impl EventEmitter<PermissionEvent> for PermissionView {}

impl PermissionView {
    pub fn new(card: PermissionCard, colors: Colors, cx: &mut Context<Self>) -> Self {
        let form = PermissionForm::new(&card);
        PermissionView {
            card,
            form,
            colors,
            feedback: None,
            decline: cx.focus_handle(),
            _subs: Vec::new(),
        }
    }

    pub fn card(&self) -> &PermissionCard {
        &self.card
    }

    pub fn form(&self) -> &PermissionForm {
        &self.form
    }

    /// "Deny without feedback" (the decline `defaultToNo` focuses).
    pub fn decline_handle(&self) -> &FocusHandle {
        &self.decline
    }

    pub fn set_colors(&mut self, colors: Colors) {
        self.colors = colors;
    }

    /// The deny-feedback box (made when the decline panel first shows).
    pub fn feedback_input(&self) -> Option<Entity<TextareaState>> {
        self.feedback.clone()
    }

    /// Updates the card for the latest request JSON of the same id (a
    /// re-emit) and the queue count; the form stays.
    pub fn refresh(&mut self, card: PermissionCard, cx: &mut Context<Self>) {
        if card != self.card {
            self.card = card;
            cx.notify();
        }
    }

    pub fn act(&mut self, action: PermissionAction, cx: &mut Context<Self>) {
        cx.emit(PermissionEvent::Act(action));
    }

    pub fn resolve(&mut self, d: Decision, cx: &mut Context<Self>) {
        self.act(PermissionAction::Resolve(d), cx);
    }

    fn ensure_feedback(
        &mut self,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Entity<TextareaState> {
        if let Some(f) = &self.feedback {
            return f.clone();
        }
        let input = cx.new(|cx| {
            TextareaState::new(window, cx)
                .rows(2)
                .placeholder("Why are you denying this? (sent back to Claude as the deny message)")
        });
        let sub = cx.subscribe(&input, |this: &mut Self, input, e: &InputEvent, cx| {
            if matches!(e, InputEvent::Change) {
                this.form.feedback = input.read(cx).value().to_string();
            }
        });
        self._subs.push(sub);
        self.feedback = Some(input.clone());
        input
    }

    /// Opens or closes the decline panel; opening focuses the feedback box
    /// (its `autoFocus`), unless `defaultToNo` focuses the decline.
    pub fn toggle_deny(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.form.toggle_deny();
        if self.form.show_deny && !self.card.default_to_no {
            let input = self.ensure_feedback(window, cx);
            let handle = input.focus_handle(cx);
            window.focus(&handle, cx);
        }
        cx.notify();
    }
}

impl Render for PermissionView {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let c = self.colors;
        let card = self.card.clone();
        let show_deny = self.form.show_deny;
        let feedback = show_deny.then(|| self.ensure_feedback(window, cx));
        let amber_fg = tint(&c, "amber-300", "amber-700");

        // Header: the shield, the labels and badges, the summary rows.
        let mut badges = div()
            .flex()
            .flex_wrap()
            .items_center()
            .gap(px(8.))
            .child(caps("Permission required", &c));
        if let Some(q) = &card.queue_label {
            badges = badges.child(
                pill(q.clone(), h(c.foreground), h(c.border), h(c.panel_2))
                    .debug_selector(|| "permission-queue-count".into()),
            );
        }
        if let Some(agent) = &card.agent_badge {
            badges = badges.child(
                pill(
                    agent.clone(),
                    h(c.accent),
                    a(c.accent, 30.),
                    a(c.accent, 10.),
                )
                .debug_selector(|| "permission-agent-badge".into()),
            );
        }
        if let Some(m) = &card.mcp_badge {
            let (fg, border, bg) = if m.sdk {
                (h(c.accent), a(c.accent, 30.), a(c.accent, 10.))
            } else {
                (
                    amber_fg,
                    a(step("amber-500"), 30.),
                    a(step("amber-500"), 10.),
                )
            };
            badges = badges.child(
                pill(m.text.clone(), fg, border, bg)
                    .debug_selector(|| "permission-mcp-source-badge".into()),
            );
        }
        let note = |sel: &'static str, icon_name: &str, fg, border, bg, body: SharedString| {
            div()
                .debug_selector(move || sel.into())
                .mt(px(6.))
                .flex()
                .items_start()
                .gap(px(6.))
                .rounded(px(4.))
                .border_1()
                .border_color(border)
                .bg(bg)
                .px(px(8.))
                .py(px(4.))
                .text_size(px(12.))
                .line_height(px(16.))
                .text_color(fg)
                .children(icon(icon_name, 12., fg))
                .child(div().min_w_0().flex_1().child(body))
        };
        let mut head = div().min_w_0().flex_1().child(badges).child(
            div()
                .debug_selector(|| "permission-summary".into())
                .mt(px(2.))
                .text_size(px(14.))
                .font_weight(FontWeight::MEDIUM)
                .child(card.summary.clone()),
        );
        if let Some(d) = &card.description {
            head = head.child(
                div()
                    .mt(px(4.))
                    .text_size(px(12.))
                    .text_color(h(c.muted))
                    .child(d.clone()),
            );
        }
        if let Some(t) = card.hook_text() {
            head = head.child(note(
                "permission-hook-reason",
                "Webhook",
                tint(&c, "sky-200", "sky-700"),
                a(step("sky-500"), 30.),
                a(step("sky-500"), 10.),
                t.into(),
            ));
        }
        if let Some(s) = &card.symlink {
            head = head.child(note(
                "permission-symlink-target",
                "Link2",
                tint(&c, "amber-200", "amber-700"),
                a(step("amber-500"), 40.),
                a(step("amber-500"), 10.),
                s.text().into(),
            ));
        }
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
                    .mt(px(2.))
                    .size(px(28.))
                    .flex_none()
                    .flex()
                    .items_center()
                    .justify_center()
                    .rounded(px(6.))
                    .bg(a(c.accent, 15.))
                    .children(icon("Shield", 14., h(c.accent))),
            )
            .child(head);

        // The tool input, folded; the hidden-character banner.
        let mut input = div().px(px(16.)).py(px(12.)).child(
            clickable("permission-input-toggle")
                .mb(px(8.))
                .flex()
                .items_center()
                .gap(px(6.))
                .text_size(px(10.))
                .text_color(h(c.muted))
                .children(icon(
                    if self.form.show_input {
                        "ChevronDown"
                    } else {
                        "ChevronRight"
                    },
                    12.,
                    h(c.muted),
                ))
                .child(SharedString::from(card.input_toggle_label().to_uppercase()))
                .on_click(cx.listener(|this, _, _, cx| {
                    this.form.toggle_input();
                    cx.notify();
                })),
        );
        if card.hidden_char_count > 0 {
            input = input.child(
                note(
                    "permission-hidden-chars",
                    "Shield",
                    amber_fg,
                    a(step("amber-500"), 40.),
                    a(step("amber-500"), 10.),
                    hidden_chars_text(card.hidden_char_count).into(),
                )
                .mt_0()
                .mb(px(8.)),
            );
        }
        if self.form.show_input {
            input = input.child(
                div()
                    .id("permission-input")
                    .debug_selector(|| "permission-input".into())
                    .max_h(px(240.))
                    .overflow_y_scroll()
                    .rounded(px(4.))
                    .bg(h(c.panel_2))
                    .p(px(8.))
                    .font_family(claudius_gpui_theme::fonts::MONO)
                    .text_size(px(12.))
                    .line_height(px(16.))
                    .child(card.input_text.clone()),
            );
        }

        let mut root = panel(&c, 620.)
            .debug_selector(|| "permission-modal".into())
            .child(header)
            .child(input);

        if card.auto_mode_tip {
            root = root.child(
                div()
                    .debug_selector(|| "permission-auto-mode-tip".into())
                    .flex()
                    .flex_wrap()
                    .items_center()
                    .gap(px(8.))
                    .border_t_1()
                    .border_color(h(c.border))
                    .bg(a(c.accent, 5.))
                    .px(px(16.))
                    .py(px(8.))
                    .text_size(px(12.))
                    .text_color(h(c.muted))
                    .children(icon("Lightbulb", 14., h(c.accent)))
                    .child("Tip: Auto mode runs safe commands like this without asking each time.")
                    .child(
                        div().ml_auto().child(
                            button(
                                "permission-auto-mode-switch",
                                "Yes, and switch to auto mode",
                                Look::AccentSoft,
                                true,
                                false,
                                &c,
                            )
                            .on_click(cx.listener(|this, _, _, cx| {
                                this.act(PermissionAction::SwitchToAutoAndAllow, cx)
                            })),
                        ),
                    ),
            );
        }

        if let Some(rule) = &card.always_rule {
            let code = |t: String, fg| {
                div()
                    .rounded(px(3.))
                    .bg(h(c.panel))
                    .px(px(4.))
                    .font_family(claudius_gpui_theme::fonts::MONO)
                    .text_color(fg)
                    .child(t)
            };
            let line = match rule {
                AlwaysRule::Narrow(labels) => {
                    let mut l = div()
                        .flex()
                        .flex_wrap()
                        .items_center()
                        .gap(px(3.))
                        .child("\u{201C}Always\u{201D} saves");
                    for (i, label) in labels.iter().enumerate() {
                        let sep = if i + 1 < labels.len() { "," } else { "" };
                        l = l.child(
                            div()
                                .flex()
                                .child(code(label.clone(), h(c.foreground)))
                                .child(sep),
                        );
                    }
                    l.child("\u{2014} not the whole tool.")
                }
                AlwaysRule::WholeTool(tool) => div()
                    .flex()
                    .flex_wrap()
                    .items_center()
                    .gap(px(3.))
                    .text_color(tint(&c, "amber-400", "amber-700"))
                    .child("\u{201C}Always\u{201D} saves the whole")
                    .child(code(tool.clone(), tint(&c, "amber-400", "amber-700")))
                    .child("tool \u{2014} every call it can make, not just this one."),
            };
            root = root.child(
                div()
                    .debug_selector(|| "permission-always-rule".into())
                    .border_t_1()
                    .border_color(h(c.border))
                    .bg(a(c.panel_2, 50.))
                    .px(px(16.))
                    .pt(px(8.))
                    .text_size(px(11.))
                    .text_color(h(c.muted))
                    .child(line),
            );
        }

        let mut buttons = div()
            .flex()
            .flex_wrap()
            .items_center()
            .gap(px(8.))
            .border_t_1()
            .border_color(h(c.border))
            .bg(a(c.panel_2, 50.))
            .px(px(16.))
            .py(px(12.))
            .child(
                button(
                    "permission-allow-once",
                    "Allow once",
                    Look::Primary,
                    false,
                    false,
                    &c,
                )
                .on_click(cx.listener(|this, _, _, cx| this.resolve(Decision::AllowOnce, cx))),
            );
        if !card.hide_always_buttons {
            buttons =
                buttons
                    .child(
                        button(
                            "permission-allow-session",
                            "Always (session)",
                            Look::Secondary,
                            false,
                            false,
                            &c,
                        )
                        .on_click(cx.listener(|this, _, _, cx| {
                            this.resolve(Decision::AllowAlwaysSession, cx)
                        })),
                    )
                    .child(
                        button(
                            "permission-allow-project",
                            "Always (project)",
                            Look::Secondary,
                            false,
                            false,
                            &c,
                        )
                        .on_click(cx.listener(|this, _, _, cx| {
                            this.resolve(Decision::AllowAlwaysSave("projectSettings"), cx)
                        })),
                    )
                    .child(
                        button(
                            "permission-allow-user",
                            "Always (user)",
                            Look::Secondary,
                            false,
                            false,
                            &c,
                        )
                        .on_click(cx.listener(|this, _, _, cx| {
                            this.resolve(Decision::AllowAlwaysSave("userSettings"), cx)
                        })),
                    );
        }
        buttons = buttons.child(
            div().ml_auto().child(
                button(
                    "permission-deny-toggle",
                    if show_deny {
                        "Cancel deny"
                    } else {
                        "Deny\u{2026}"
                    },
                    Look::Danger,
                    false,
                    false,
                    &c,
                )
                .on_click(cx.listener(|this, _, window, cx| this.toggle_deny(window, cx))),
            ),
        );
        root = root.child(buttons);

        if let Some(feedback) = feedback {
            let decline_focused = self.decline.is_focused(window);
            root = root.child(
                div()
                    .debug_selector(|| "permission-deny-panel".into())
                    .border_t_1()
                    .border_color(h(c.border))
                    .bg(a(c.panel, 60.))
                    .px(px(16.))
                    .py(px(12.))
                    .child(
                        caps("Optional feedback for Claude", &c)
                            .text_size(px(10.))
                            .mb(px(4.)),
                    )
                    .child(
                        div()
                            .debug_selector(|| "permission-deny-feedback".into())
                            .child(Textarea::new(&feedback).h(px(56.))),
                    )
                    .child(
                        div()
                            .mt(px(8.))
                            .flex()
                            .justify_end()
                            .gap(px(8.))
                            .child(
                                button(
                                    "permission-deny-plain",
                                    "Deny without feedback",
                                    Look::Secondary,
                                    true,
                                    false,
                                    &c,
                                )
                                .track_focus(&self.decline)
                                .when(decline_focused, |b| b.border_color(h(c.accent)))
                                .on_click(cx.listener(
                                    |this, _, _, cx| this.resolve(Decision::Deny(None), cx),
                                )),
                            )
                            .child(
                                button(
                                    "permission-deny-with-feedback",
                                    "Deny with feedback",
                                    Look::DangerSolid,
                                    true,
                                    false,
                                    &c,
                                )
                                .on_click(cx.listener(
                                    |this, _, _, cx| {
                                        let d = Decision::deny_with(&this.form.feedback);
                                        this.resolve(d, cx)
                                    },
                                )),
                            ),
                    ),
            );
        }

        backdrop("permission-backdrop").child(root)
    }
}
