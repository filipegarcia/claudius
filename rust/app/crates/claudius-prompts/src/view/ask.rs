//! The AskUserQuestion card on screen (`AskUserQuestionPrompt.tsx`): the
//! live ask inline at the end of the transcript, or the resurrected modal.

use gpui_kit::Focusable as _;
use gpui_kit::component::input::{InputEvent, Textarea, TextareaState};
use gpui_kit::prelude::FluentBuilder as _;
use gpui_kit::{
    AnyElement, AppContext as _, Context, Div, Entity, EventEmitter, FontWeight,
    InteractiveElement as _, IntoElement, ParentElement as _, Render,
    StatefulInteractiveElement as _, Styled as _, Subscription, Window, div, px, rgb,
};

use claudius_gpui_theme::density;
use claudius_theme::chat::ChatSize;

use super::style::{Colors, Look, a, button, caps, clickable, h, icon, step, tint, white};
use crate::ask::{
    AskAnswer, AskForm, AskKey, AskMode, AskQuestion, AskStep, PreviewContent, RightPane,
    session_chip,
};

/// What the card asks for.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum AskEvent {
    /// `onSubmit(answers)`.
    Submit(Vec<AskAnswer>),
    /// The header's X (`onCancel`).
    Cancel,
    /// Esc / the minimize button / a click outside the modal
    /// (`onMinimize ?? onCancel`).
    Dismiss,
}

pub struct AskView {
    pub(crate) form: AskForm,
    mode: AskMode,
    has_minimize: bool,
    session_label: Option<String>,
    colors: Colors,
    /// The "Other" field, shared by the questions (it shows the active one's
    /// draft).
    other: Option<Entity<TextareaState>>,
    /// The question the field holds the draft of.
    other_for: Option<usize>,
    /// The `focus_other` bump last acted on.
    focused_gen: u64,
    _subs: Vec<Subscription>,
}

impl EventEmitter<AskEvent> for AskView {}

impl AskView {
    pub fn new(
        request_id: String,
        questions: Vec<AskQuestion>,
        mode: AskMode,
        session_label: Option<String>,
        colors: Colors,
    ) -> Self {
        AskView {
            form: AskForm::new(request_id, questions),
            mode,
            // The resurrected modal minimizes (it closes); the inline card
            // has no minimize.
            has_minimize: mode == AskMode::Modal,
            session_label,
            colors,
            other: None,
            other_for: None,
            focused_gen: 0,
            _subs: Vec::new(),
        }
    }

    pub fn form(&self) -> &AskForm {
        &self.form
    }

    pub fn request_id(&self) -> &str {
        &self.form.request_id
    }

    /// The "Other" field, once drawn.
    pub fn other_input(&self) -> Option<Entity<TextareaState>> {
        self.other.clone()
    }

    pub fn set_colors(&mut self, colors: Colors, session_label: Option<String>) {
        self.colors = colors;
        self.session_label = session_label;
    }

    pub fn other_focused(&self, window: &Window, cx: &gpui_kit::App) -> bool {
        self.other
            .as_ref()
            .is_some_and(|o| o.focus_handle(cx).is_focused(window))
    }

    fn step(&mut self, step: AskStep, cx: &mut Context<Self>) {
        match step {
            AskStep::Stay => {}
            AskStep::Submit(answers) => cx.emit(AskEvent::Submit(answers)),
            AskStep::Dismiss => cx.emit(AskEvent::Dismiss),
        }
        cx.notify();
    }

    /// The modal's keyboard (forwarded by the overlays; the inline card
    /// takes none).
    pub fn key(&mut self, key: AskKey, in_field: bool, cx: &mut Context<Self>) -> bool {
        if self.mode != AskMode::Modal {
            return false;
        }
        let step = self.form.key(key, in_field);
        let handled = key == AskKey::Escape || !in_field;
        self.step(step, cx);
        handled
    }

    pub fn pick(&mut self, i: usize, cx: &mut Context<Self>) {
        let Some(label) = self
            .form
            .question()
            .and_then(|q| q.options.get(i))
            .map(|o| o.label.clone())
        else {
            return;
        };
        self.form.pick(&label);
        self.form.focused_option = i;
        cx.notify();
    }

    pub fn pick_other(&mut self, cx: &mut Context<Self>) {
        self.form.pick_other();
        cx.notify();
    }

    pub fn set_active(&mut self, i: usize, cx: &mut Context<Self>) {
        self.form.set_active(i);
        cx.notify();
    }

    pub fn submit(&mut self, cx: &mut Context<Self>) {
        let step = self.form.submit();
        self.step(step, cx);
    }

    /// Text into "Other" as if typed (the tests; a drop's text).
    pub fn append_to_other(&mut self, text: &str, cx: &mut Context<Self>) {
        self.form.append_to_other(text);
        self.other_for = None;
        cx.notify();
    }

    /// A paste outside a text field: into "Other" (`onPaste`).
    pub fn paste(&mut self, text: &str, cx: &mut Context<Self>) -> bool {
        let taken = self.form.paste(text);
        if taken {
            self.other_for = None;
            cx.notify();
        }
        taken
    }

    /// Keeps the "Other" field on the active question's draft, and focuses
    /// it when the form asked to.
    fn sync_other(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if !self.form.working().show_other {
            return;
        }
        let other = match &self.other {
            Some(o) => o.clone(),
            None => {
                let o = cx.new(|cx| {
                    TextareaState::new(window, cx)
                        .rows(2)
                        .placeholder("Type your answer\u{2026}")
                });
                let sub = cx.subscribe(&o, |this: &mut Self, o, e: &InputEvent, cx| match e {
                    InputEvent::Change => {
                        let v = o.read(cx).value().to_string();
                        if this.form.working().custom != v {
                            this.form.set_custom(&v);
                            cx.notify();
                        }
                    }
                    // ⌘/Ctrl+Enter (`onSubmitShortcut`).
                    InputEvent::PressEnter {
                        secondary: true, ..
                    } => {
                        let step = this.form.advance();
                        this.step(step, cx);
                    }
                    _ => {}
                });
                self._subs.push(sub);
                self.other = Some(o.clone());
                o
            }
        };
        let custom = self.form.working().custom;
        if self.other_for != Some(self.form.active) || other.read(cx).value().as_ref() != custom {
            other.update(cx, |o, cx| o.set_value(custom, window, cx));
            self.other_for = Some(self.form.active);
        }
        if self.form.focus_other != self.focused_gen {
            self.focused_gen = self.form.focus_other;
            let handle = other.focus_handle(cx);
            window.focus(&handle, cx);
        }
    }

    fn tick(on: bool, square: bool, c: &Colors) -> Div {
        div()
            .mt(px(2.))
            .size(px(16.))
            .flex_none()
            .flex()
            .items_center()
            .justify_center()
            .border_1()
            .map(|d| {
                if square {
                    d.rounded(px(3.))
                } else {
                    d.rounded_full()
                }
            })
            .border_color(if on { h(c.accent) } else { h(c.border) })
            .when(on, |d| d.bg(h(c.accent)))
            .children(on.then(|| icon("Check", 12., white())).flatten())
    }

    fn other_box(&self, selector: &'static str, height: f32) -> Option<AnyElement> {
        let other = self.other.as_ref()?;
        Some(
            div()
                .debug_selector(move || selector.into())
                .child(Textarea::new(other).h(px(height)))
                .into_any_element(),
        )
    }

    fn header(&self, q: &AskQuestion, cx: &mut Context<Self>) -> Div {
        let c = self.colors;
        let green = tint(&c, "emerald-300", "emerald-700");
        let mut row = div()
            .flex()
            .items_center()
            .gap(px(12.))
            .border_b_1()
            .border_color(h(c.border))
            .px(px(16.))
            .py(px(12.))
            .text_size(px(12.))
            .child(
                div()
                    .rounded(px(6.))
                    .bg(a(c.accent, 15.))
                    .px(px(8.))
                    .py(px(2.))
                    .font_weight(FontWeight::MEDIUM)
                    .text_color(h(c.accent))
                    .child("QUESTION"),
            );
        if let Some(label) = session_chip(self.session_label.as_deref()) {
            row = row.child(
                div()
                    .debug_selector(|| "ask-session-label".into())
                    .max_w(px(256.))
                    .truncate()
                    .rounded(px(6.))
                    .border_1()
                    .border_color(h(c.border))
                    .bg(h(c.panel_2))
                    .px(px(8.))
                    .py(px(2.))
                    .child(label.to_owned()),
            );
        }
        row = row.child(
            div()
                .debug_selector(|| "ask-position".into())
                .text_color(h(c.muted))
                .child(self.form.position()),
        );
        if q.multi_select {
            row = row.child(
                div()
                    .debug_selector(|| "ask-multiselect-badge".into())
                    .flex()
                    .items_center()
                    .gap(px(4.))
                    .rounded(px(6.))
                    .border_1()
                    .border_color(a(step("emerald-400"), 40.))
                    .bg(a(step("emerald-400"), 10.))
                    .px(px(8.))
                    .py(px(2.))
                    .text_size(px(10.))
                    .font_weight(FontWeight::MEDIUM)
                    .text_color(green)
                    .children(icon("CheckSquare", 12., green))
                    .child("MULTIPLE CHOICE"),
            );
        }
        let chips = self.form.chips();
        if !chips.is_empty() {
            let mut strip = div().ml(px(8.)).flex().flex_1().items_center().gap(px(4.));
            for (i, chip) in chips.into_iter().enumerate() {
                let active = i == self.form.active;
                let ready = self.form.is_ready(i);
                let (border, bg, fg) = if active {
                    (h(c.accent), a(c.accent, 15.), h(c.foreground))
                } else if ready {
                    (
                        a(step("emerald-400"), 40.),
                        a(step("emerald-400"), 10.),
                        tint(&c, "emerald-200", "emerald-700"),
                    )
                } else {
                    (h(c.border), h(c.panel_2), h(c.muted))
                };
                strip = strip.child(
                    clickable(format!("ask-tab-{i}"))
                        .flex_none()
                        .flex()
                        .items_center()
                        .gap(px(4.))
                        .rounded(px(6.))
                        .border_1()
                        .border_color(border)
                        .bg(bg)
                        .px(px(8.))
                        .py(px(2.))
                        .text_size(px(10.))
                        .text_color(fg)
                        .children(ready.then(|| icon("Check", 12., fg)).flatten())
                        .child(chip)
                        .on_click(cx.listener(move |this, _, _, cx| this.set_active(i, cx))),
                );
            }
            row = row.child(strip);
        }
        let mut first_right = true;
        if self.has_minimize {
            first_right = false;
            row = row.child(
                clickable("ask-minimize")
                    .ml_auto()
                    .rounded(px(4.))
                    .p(px(4.))
                    .children(icon("Minus", 16., h(c.muted)))
                    .on_click(cx.listener(|_, _, _, cx| cx.emit(AskEvent::Dismiss))),
            );
        }
        row.child(
            clickable("ask-cancel")
                .when(first_right, |d| d.ml_auto())
                .rounded(px(4.))
                .p(px(4.))
                .children(icon("X", 16., h(c.muted)))
                .on_click(cx.listener(|_, _, _, cx| cx.emit(AskEvent::Cancel))),
        )
    }

    fn options(&self, q: &AskQuestion, pane: RightPane, cx: &mut Context<Self>) -> Div {
        let c = self.colors;
        let w = self.form.working();
        let green = tint(&c, "emerald-300", "emerald-700");
        let mut intro = div().px(px(20.)).pb(px(12.)).pt(px(16.));
        if !q.header.is_empty() {
            intro = intro.child(
                caps(q.header.clone(), &c)
                    .text_size(px(10.))
                    .font_weight(FontWeight::MEDIUM)
                    .mb(px(4.))
                    .debug_selector(|| "ask-question-header".into()),
            );
        }
        intro = intro.child(
            div()
                .debug_selector(|| "ask-question".into())
                .text_size(px(14.))
                .font_weight(FontWeight::MEDIUM)
                .child(q.question.clone()),
        );
        if let Some((hint, count)) = self.form.multi_hint() {
            intro = intro.child(
                div()
                    .debug_selector(|| "ask-multiselect-hint".into())
                    .mt(px(4.))
                    .flex()
                    .items_center()
                    .gap(px(6.))
                    .text_size(px(11.))
                    .font_weight(FontWeight::MEDIUM)
                    .text_color(green)
                    .children(icon("CheckSquare", 12., green))
                    .child(hint)
                    .children(count.map(|n| div().text_color(h(c.muted)).child(n))),
            );
        }
        let mut list = div().flex_1().px(px(8.)).pb(px(8.));
        for (i, opt) in q.options.iter().enumerate() {
            let selected = w.selected_labels.contains(&opt.label);
            let focused = i == self.form.focused_option;
            let (border, bg) = if selected {
                (h(c.accent), a(c.accent, 10.))
            } else if focused {
                (h(c.border), h(c.panel_2))
            } else {
                (gpui_kit::transparent_black(), gpui_kit::transparent_black())
            };
            list = list.child(
                clickable(format!("ask-option-{i}"))
                    .mb(px(4.))
                    .flex()
                    .items_start()
                    .gap(px(12.))
                    .rounded(px(8.))
                    .border_1()
                    .border_color(border)
                    .bg(bg)
                    .px(px(12.))
                    .py(px(8.))
                    .child(Self::tick(selected, q.multi_select, &c))
                    .child(
                        div()
                            .min_w_0()
                            .flex_1()
                            .child(div().text_size(px(14.)).truncate().child(opt.label.clone()))
                            .when(!opt.description.is_empty(), |d| {
                                d.child(
                                    div()
                                        .mt(px(2.))
                                        .text_size(px(11.))
                                        .text_color(h(c.muted))
                                        .child(opt.description.clone()),
                                )
                            }),
                    )
                    .child(
                        div()
                            .ml(px(8.))
                            .mt(px(2.))
                            .flex_none()
                            .rounded(px(3.))
                            .border_1()
                            .border_color(h(c.border))
                            .bg(h(c.panel_2))
                            .px(px(4.))
                            .font_family(claudius_gpui_theme::fonts::MONO)
                            .text_size(px(10.))
                            .text_color(h(c.muted))
                            .child(format!("{}", i + 1)),
                    )
                    .on_hover(cx.listener(move |this, hovered: &bool, _, cx| {
                        if *hovered && this.form.focused_option != i {
                            this.form.focused_option = i;
                            cx.notify();
                        }
                    }))
                    .on_click(cx.listener(move |this, _, _, cx| this.pick(i, cx))),
            );
        }
        let (border, bg) = if w.show_other {
            (h(c.accent), a(c.accent, 10.))
        } else {
            (gpui_kit::transparent_black(), gpui_kit::transparent_black())
        };
        list = list.child(
            clickable("ask-option-other")
                .mb(px(4.))
                .flex()
                .items_start()
                .gap(px(12.))
                .rounded(px(8.))
                .border_1()
                .border_color(border)
                .bg(bg)
                .px(px(12.))
                .py(px(8.))
                .child(Self::tick(w.show_other, q.multi_select, &c))
                .child(
                    div()
                        .min_w_0()
                        .flex_1()
                        .child(div().text_size(px(14.)).child("Other"))
                        .child(
                            div()
                                .mt(px(2.))
                                .text_size(px(11.))
                                .text_color(h(c.muted))
                                .child("Provide your own answer"),
                        ),
                )
                .on_click(cx.listener(|this, _, _, cx| this.pick_other(cx))),
        );
        // The field under "Other" when the right pane holds a preview.
        if w.show_other && pane != RightPane::Other {
            list = list.children(
                self.other_box("ask-other-input-inline", 56.)
                    .map(|b| div().mb(px(8.)).px(px(12.)).child(b)),
            );
        }
        div()
            .flex()
            .flex_col()
            .min_w_0()
            .map(|d| {
                if pane == RightPane::Empty {
                    d.w_full()
                } else {
                    d.w(gpui_kit::relative(0.4))
                        .flex_none()
                        .border_r_1()
                        .border_color(h(c.border))
                }
            })
            .child(intro)
            .child(list)
    }

    fn right(&self, pane: RightPane) -> Option<AnyElement> {
        let c = self.colors;
        match pane {
            RightPane::Empty => None,
            RightPane::Other => Some(
                div()
                    .min_w_0()
                    .flex_1()
                    .flex()
                    .flex_col()
                    .p(px(16.))
                    .child(
                        div()
                            .mb(px(8.))
                            .flex()
                            .items_center()
                            .gap(px(8.))
                            .children(icon("Pencil", 12., h(c.muted)))
                            .child(caps("Your answer", &c).text_size(px(10.))),
                    )
                    .children(self.other_box("ask-other-input", 180.))
                    .into_any_element(),
            ),
            RightPane::Preview => {
                let (content, label) = self.form.preview();
                let mut pane = div()
                    .id("ask-preview")
                    .debug_selector(|| "ask-preview".into())
                    .min_w_0()
                    .flex_1()
                    .flex()
                    .flex_col()
                    .overflow_y_scroll()
                    .p(px(16.));
                if !label.is_empty() {
                    pane = pane.child(
                        caps(format!("Preview \u{00B7} {label}"), &c)
                            .text_size(px(10.))
                            .mb(px(8.))
                            .debug_selector(|| "ask-preview-label".into()),
                    );
                }
                pane = pane.child(match content {
                    PreviewContent::None => div()
                        .text_size(px(11.))
                        .italic()
                        .text_color(h(c.muted))
                        .child("No preview for this option."),
                    // U08b's seam: the sandboxed HTML pane. Until then the
                    // markup shows as text on the light box the TS draws.
                    PreviewContent::Html(html) => div()
                        .debug_selector(|| "ask-preview-html".into())
                        .rounded(px(6.))
                        .border_1()
                        .border_color(h(c.border))
                        .bg(rgb(0xffffff))
                        .p(px(12.))
                        .font_family(claudius_gpui_theme::fonts::MONO)
                        .text_size(px(12.))
                        .text_color(rgb(0x1a1a1a))
                        .child(html),
                    PreviewContent::Text(text) => div()
                        .debug_selector(|| "ask-preview-text".into())
                        .rounded(px(6.))
                        .border_1()
                        .border_color(h(c.border))
                        .bg(a(c.panel_2, 40.))
                        .p(px(12.))
                        .font_family(claudius_gpui_theme::fonts::MONO)
                        .text_size(px(12.))
                        .whitespace_nowrap()
                        .children(
                            text.split('\n')
                                .map(|l| div().child(l.to_owned()))
                                .collect::<Vec<_>>(),
                        ),
                });
                Some(pane.into_any_element())
            }
        }
    }

    fn footer(&self, cx: &mut Context<Self>) -> Div {
        let c = self.colors;
        let ready = self.form.is_ready(self.form.active);
        let mut right = div().ml_auto().flex().items_center().gap(px(8.));
        if self.form.active > 0 {
            right = right.child(
                button("ask-prev", "Back", Look::Secondary, true, false, &c).on_click(cx.listener(
                    |this, _, _, cx| {
                        this.form.back();
                        cx.notify();
                    },
                )),
            );
        }
        right = if !self.form.is_last() {
            right.child(
                button("ask-next", "Next", Look::Primary, true, !ready, &c)
                    .children(icon("ArrowRight", 12., white()))
                    .when(ready, |b| {
                        b.on_click(cx.listener(|this, _, _, cx| {
                            this.form.next();
                            cx.notify();
                        }))
                    }),
            )
        } else {
            let all = self.form.all_ready();
            right.child(
                button("ask-submit", "Submit", Look::Primary, true, !all, &c).when(all, |b| {
                    b.on_click(cx.listener(|this, _, _, cx| this.submit(cx)))
                }),
            )
        };
        div()
            .flex()
            .items_center()
            .gap(px(8.))
            .border_t_1()
            .border_color(h(c.border))
            .bg(a(c.panel_2, 40.))
            .px(px(16.))
            .py(px(8.))
            .text_size(px(12.))
            .child(
                div()
                    .debug_selector(|| "ask-hint".into())
                    .text_color(h(c.muted))
                    .child(self.form.hint(self.mode, self.has_minimize)),
            )
            .child(right)
    }
}

impl Render for AskView {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let Some(q) = self.form.question().cloned() else {
            return div().into_any_element();
        };
        self.sync_other(window, cx);
        let c = self.colors;
        let inline = self.mode == AskMode::Inline;
        let pane = self.form.right_pane();

        let mut card = div()
            .debug_selector(|| "ask-user-question".into())
            .flex()
            .flex_col()
            .w_full()
            .overflow_hidden()
            .rounded(px(16.))
            .bg(h(c.panel))
            .text_color(h(c.foreground))
            .border_1();
        card = if inline {
            card.max_h(window.viewport_size().height * 0.7)
                .border_color(a(c.accent, 50.))
                .shadow_lg()
        } else {
            card.max_w(px(896.))
                .max_h(window.viewport_size().height * 0.85)
                .border_color(h(c.border))
                .shadow_2xl()
        };
        if inline {
            card = card.child(
                div()
                    .flex()
                    .items_center()
                    .gap(px(8.))
                    .border_b_1()
                    .border_color(h(c.border))
                    .bg(a(c.panel_2, 40.))
                    .px(px(16.))
                    .py(px(6.))
                    .text_size(px(12.))
                    .children(icon("Wrench", 14., h(c.accent)))
                    .child(
                        div()
                            .font_family(claudius_gpui_theme::fonts::MONO)
                            .child("AskUserQuestion"),
                    )
                    .child(
                        div()
                            .ml_auto()
                            .flex()
                            .items_center()
                            .gap(px(6.))
                            .text_size(px(10.))
                            .text_color(h(c.accent))
                            .child(div().size(px(8.)).rounded_full().bg(h(c.accent)))
                            .child("Waiting for your answer"),
                    ),
            );
        }
        card = card
            .child(self.header(&q, cx))
            .child(
                div()
                    .flex()
                    .min_h_0()
                    .flex_1()
                    .child(self.options(&q, pane, cx))
                    .children(self.right(pane)),
            )
            .child(self.footer(cx));

        if inline {
            // In the chat column, as the transcript's rows are.
            let (col, _) = density::chat_column(window.viewport_size().width, ChatSize::default());
            return div()
                .debug_selector(|| "ask-user-question-inline".into())
                .w_full()
                .px(px(16.))
                .pt(px(8.))
                .pb(px(12.))
                .child(div().mx_auto().w_full().max_w(col).child(card))
                .into_any_element();
        }
        // The modal: a click on the dimmed area dismisses.
        div()
            .id("ask-backdrop")
            .debug_selector(|| "ask-backdrop".into())
            .absolute()
            .top_0()
            .left_0()
            .size_full()
            .flex()
            .items_center()
            .justify_center()
            .p(px(16.))
            .bg(gpui_kit::black().opacity(0.6))
            .occlude()
            .on_click(cx.listener(|_, _, _, cx| cx.emit(AskEvent::Dismiss)))
            .child(
                div()
                    .id("ask-modal")
                    .w_full()
                    .flex()
                    .justify_center()
                    // Clicks on the card stay on the card.
                    .on_click(|_, _, cx| cx.stop_propagation())
                    .child(card),
            )
            .into_any_element()
    }
}
