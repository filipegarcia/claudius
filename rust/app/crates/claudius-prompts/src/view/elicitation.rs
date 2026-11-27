//! The MCP elicitation card on screen (`McpElicitationPrompt.tsx`): the
//! schema-driven form, or the sign-in link. One view per request.

use gpui_kit::component::input::{Input, InputEvent, InputState};
use gpui_kit::prelude::FluentBuilder as _;
use gpui_kit::{
    AnyElement, AppContext as _, Context, Div, Entity, EventEmitter, FontWeight,
    InteractiveElement as _, IntoElement, ParentElement as _, Render,
    StatefulInteractiveElement as _, Styled as _, Subscription, Window, div, px,
};

use super::style::{
    Colors, Look, a, backdrop, button, caps, clickable, h, icon, icon_button, panel, pill, step,
    tint, white,
};
use crate::elicitation::{
    ElicitationCard, ElicitationDecision, ElicitationForm, ElicitationStep, Field, FieldKind,
    FieldValue,
};

/// What the card asks for.
#[derive(Clone, Debug, PartialEq)]
pub enum ElicitationEvent {
    Resolve(ElicitationDecision),
    /// Open this link (the overlay opens it through the platform).
    Open(String),
}

pub struct ElicitationView {
    pub(crate) card: ElicitationCard,
    pub(crate) form: ElicitationForm,
    colors: Colors,
    /// The text fields' inputs by field key (made on the first render).
    inputs: Vec<(String, Entity<InputState>)>,
    _subs: Vec<Subscription>,
}

impl EventEmitter<ElicitationEvent> for ElicitationView {}

impl ElicitationView {
    pub fn new(card: ElicitationCard, colors: Colors) -> Self {
        let form = ElicitationForm::new(&card);
        ElicitationView {
            card,
            form,
            colors,
            inputs: Vec::new(),
            _subs: Vec::new(),
        }
    }

    pub fn card(&self) -> &ElicitationCard {
        &self.card
    }

    pub fn form(&self) -> &ElicitationForm {
        &self.form
    }

    /// A text field's input, once drawn.
    pub fn input(&self, key: &str) -> Option<Entity<InputState>> {
        self.inputs
            .iter()
            .find(|(k, _)| k == key)
            .map(|(_, i)| i.clone())
    }

    pub fn set_colors(&mut self, colors: Colors) {
        self.colors = colors;
    }

    pub fn refresh(&mut self, card: ElicitationCard, cx: &mut Context<Self>) {
        if card != self.card {
            self.card = card;
            cx.notify();
        }
    }

    pub fn set(&mut self, key: &str, value: FieldValue, cx: &mut Context<Self>) {
        self.form.set(key, value);
        cx.notify();
    }

    fn step(&mut self, step: ElicitationStep, cx: &mut Context<Self>) {
        match step {
            ElicitationStep::Resolve(d) => cx.emit(ElicitationEvent::Resolve(d)),
            ElicitationStep::OpenAndWait(url) => cx.emit(ElicitationEvent::Open(url)),
            ElicitationStep::OpenAndAccept(url) => {
                cx.emit(ElicitationEvent::Open(url));
                cx.emit(ElicitationEvent::Resolve(ElicitationDecision::Accept(None)));
            }
            ElicitationStep::Stay => {}
        }
        cx.notify();
    }

    pub fn submit(&mut self, cx: &mut Context<Self>) {
        let step = self.form.submit(&self.card);
        self.step(step, cx);
    }

    pub fn open_link(&mut self, cx: &mut Context<Self>) {
        let step = self.form.open_link(&self.card);
        self.step(step, cx);
    }

    pub fn resolve(&mut self, d: ElicitationDecision, cx: &mut Context<Self>) {
        cx.emit(ElicitationEvent::Resolve(d));
    }

    fn ensure_inputs(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if !self.inputs.is_empty() {
            return;
        }
        let text_fields: Vec<Field> = self
            .card
            .fields
            .iter()
            .filter(|f| matches!(f.kind, FieldKind::String { .. } | FieldKind::Number { .. }))
            .cloned()
            .collect();
        for f in text_fields {
            let start = match self.form.value(&f.key) {
                Some(FieldValue::Text(t)) => t.clone(),
                _ => String::new(),
            };
            let input = cx.new(|cx| InputState::new(window, cx).default_value(start));
            let key = f.key.clone();
            let sub = cx.subscribe(&input, move |this: &mut Self, input, e: &InputEvent, cx| {
                if matches!(e, InputEvent::Change) {
                    let v = input.read(cx).value().to_string();
                    this.set(&key, FieldValue::Text(v), cx);
                }
            });
            self._subs.push(sub);
            self.inputs.push((f.key.clone(), input));
        }
    }

    fn label(&self, f: &Field) -> Div {
        div()
            .mb(px(4.))
            .flex()
            .text_size(px(12.))
            .font_weight(FontWeight::MEDIUM)
            .child(f.label.clone())
            .when(f.required, |d| {
                d.child(div().ml(px(2.)).text_color(h(step("red-400"))).child("*"))
            })
    }

    fn tick(on: bool, round: bool, c: &Colors) -> Div {
        div()
            .size(px(14.))
            .flex_none()
            .flex()
            .items_center()
            .justify_center()
            .border_1()
            .map(|d| {
                if round {
                    d.rounded_full()
                } else {
                    d.rounded(px(3.))
                }
            })
            .border_color(if on { h(c.accent) } else { h(c.border) })
            .when(on, |d| d.bg(h(c.accent)))
            .children(on.then(|| icon("Check", 10., white())).flatten())
    }

    fn field(&self, f: &Field, cx: &mut Context<Self>) -> AnyElement {
        let c = self.colors;
        let error = self.form.error(&f.key).map(str::to_owned);
        let help = f.description.clone().map(|d| {
            div()
                .mt(px(4.))
                .text_size(px(11.))
                .text_color(h(c.muted))
                .child(d)
        });
        let err = error.clone().map(|e| {
            let key = f.key.clone();
            div()
                .debug_selector(move || format!("mcp-elicitation-error-{key}"))
                .mt(px(4.))
                .text_size(px(11.))
                .text_color(h(step("red-400")))
                .child(e)
        });
        let key = f.key.clone();
        let body: AnyElement =
            match &f.kind {
                FieldKind::Boolean { .. } => {
                    let on = matches!(self.form.value(&key), Some(FieldValue::Bool(true)));
                    let k = key.clone();
                    clickable(format!("mcp-elicitation-field-{key}"))
                        .flex()
                        .items_center()
                        .gap(px(8.))
                        .text_size(px(14.))
                        .child(Self::tick(on, false, &c))
                        .child(div().font_weight(FontWeight::MEDIUM).child(f.label.clone()))
                        .on_click(cx.listener(move |this, _, _, cx| {
                            this.set(&k, FieldValue::Bool(!on), cx)
                        }))
                        .into_any_element()
                }
                FieldKind::MultiEnum { options, .. } => {
                    let picked = match self.form.value(&key) {
                        Some(FieldValue::Multi(p)) => p.clone(),
                        _ => Vec::new(),
                    };
                    let mut list = div().flex().flex_col().gap(px(4.));
                    for (i, o) in options.iter().enumerate() {
                        let on = picked.contains(&o.value);
                        let (k, v) = (key.clone(), o.value.clone());
                        list = list.child(
                            clickable(format!("mcp-elicitation-option-{key}-{i}"))
                                .flex()
                                .items_center()
                                .gap(px(8.))
                                .text_size(px(14.))
                                .child(Self::tick(on, false, &c))
                                .child(o.label.clone())
                                .on_click(cx.listener(move |this, _, _, cx| {
                                    this.form.toggle_multi(&k, &v, !on);
                                    cx.notify();
                                })),
                        );
                    }
                    div().child(self.label(f)).child(list).into_any_element()
                }
                FieldKind::Enum { options, .. } => {
                    // The `<select>` as option rows: "Choose…" (empty) and each
                    // option, the picked one ticked.
                    let cur = match self.form.value(&key) {
                        Some(FieldValue::Text(t)) => t.clone(),
                        _ => String::new(),
                    };
                    let border = if error.is_some() {
                        a(step("red-500"), 60.)
                    } else {
                        h(c.border)
                    };
                    let mut list = div()
                        .debug_selector({
                            let key = key.clone();
                            move || format!("mcp-elicitation-field-{key}")
                        })
                        .flex()
                        .flex_wrap()
                        .gap(px(4.))
                        .rounded(px(6.))
                        .border_1()
                        .border_color(border)
                        .bg(h(c.panel_2))
                        .p(px(4.));
                    let rows = std::iter::once(("Choose\u{2026}".to_owned(), String::new()))
                        .chain(options.iter().map(|o| (o.label.clone(), o.value.clone())));
                    for (i, (label, value)) in rows.enumerate() {
                        let on = cur == value;
                        let k = key.clone();
                        list = list.child(
                            clickable(format!("mcp-elicitation-option-{key}-{i}"))
                                .flex()
                                .items_center()
                                .gap(px(6.))
                                .rounded(px(4.))
                                .px(px(8.))
                                .py(px(2.))
                                .text_size(px(13.))
                                .when(on, |d| d.bg(a(c.accent, 15.)))
                                .text_color(if value.is_empty() {
                                    h(c.muted)
                                } else {
                                    h(c.foreground)
                                })
                                .child(Self::tick(on, true, &c))
                                .child(label)
                                .on_click(cx.listener(move |this, _, _, cx| {
                                    this.set(&k, FieldValue::Text(value.clone()), cx)
                                })),
                        );
                    }
                    div().child(self.label(f)).child(list).into_any_element()
                }
                FieldKind::String { .. } | FieldKind::Number { .. } => {
                    let input = self.input(&key);
                    let border = if error.is_some() {
                        a(step("red-500"), 60.)
                    } else {
                        h(c.border)
                    };
                    let k = key.clone();
                    div()
                        .child(self.label(f))
                        .child(
                            div()
                                .debug_selector(move || format!("mcp-elicitation-field-{k}"))
                                .rounded(px(6.))
                                .border_1()
                                .border_color(border)
                                .bg(h(c.panel_2))
                                .children(input.map(|i| {
                                    Input::new(&i).appearance(false).px(px(8.)).py(px(4.))
                                })),
                        )
                        .into_any_element()
                }
            };
        div()
            .child(body)
            .children(help)
            .children(err)
            .into_any_element()
    }
}

impl Render for ElicitationView {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        self.ensure_inputs(window, cx);
        let c = self.colors;
        let card = self.card.clone();
        let amber = tint(&c, "amber-300", "amber-700");

        let mut tags = div()
            .flex()
            .items_center()
            .gap(px(8.))
            .child(caps("MCP server request", &c))
            .child(
                pill(
                    card.server_name.clone(),
                    h(c.accent),
                    a(c.accent, 30.),
                    a(c.accent, 10.),
                )
                .debug_selector(|| "mcp-elicitation-server".into()),
            );
        if let Some(q) = &card.queue_label {
            tags = tags.child(
                pill(q.clone(), h(c.foreground), h(c.border), h(c.panel_2))
                    .debug_selector(|| "mcp-elicitation-queue-count".into()),
            );
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
                    .children(icon(
                        if card.is_url {
                            "KeyRound"
                        } else {
                            "ClipboardList"
                        },
                        14.,
                        h(c.accent),
                    )),
            )
            .child(
                div()
                    .min_w_0()
                    .flex_1()
                    .child(tags)
                    .child(
                        div()
                            .debug_selector(|| "mcp-elicitation-heading".into())
                            .mt(px(2.))
                            .text_size(px(14.))
                            .font_weight(FontWeight::MEDIUM)
                            .child(card.heading.clone()),
                    )
                    .children(card.description.clone().map(|d| {
                        div()
                            .mt(px(4.))
                            .text_size(px(12.))
                            .text_color(h(c.muted))
                            .child(d)
                    })),
            );

        let mut body = div()
            .id("mcp-elicitation-body")
            .max_h(window.viewport_size().height * 0.6)
            .overflow_y_scroll()
            .px(px(16.))
            .py(px(12.));
        if let Some(m) = &card.message {
            body = body.child(
                div()
                    .debug_selector(|| "mcp-elicitation-message".into())
                    .text_size(px(14.))
                    .child(m.clone()),
            );
        }
        if card.is_url {
            body = body.child(match &card.url {
                Some(u) => div()
                    .mt(px(12.))
                    .rounded(px(6.))
                    .border_1()
                    .border_color(h(c.border))
                    .bg(h(c.panel_2))
                    .px(px(12.))
                    .py(px(8.))
                    .child(caps("Opens", &c).text_size(px(10.)))
                    .child(
                        div()
                            .debug_selector(|| "mcp-elicitation-host".into())
                            .font_weight(FontWeight::MEDIUM)
                            .child(u.host.clone()),
                    )
                    .child(
                        div()
                            .mt(px(2.))
                            .font_family(claudius_gpui_theme::fonts::MONO)
                            .text_size(px(11.))
                            .text_color(h(c.muted))
                            .child(u.href.clone()),
                    ),
                None => div()
                    .debug_selector(|| "mcp-elicitation-unsafe-url".into())
                    .mt(px(12.))
                    .flex()
                    .items_start()
                    .gap(px(8.))
                    .rounded(px(6.))
                    .border_1()
                    .border_color(a(step("amber-500"), 30.))
                    .bg(a(step("amber-500"), 10.))
                    .px(px(12.))
                    .py(px(8.))
                    .text_size(px(12.))
                    .text_color(amber)
                    .children(icon("TriangleAlert", 14., amber))
                    .child("This server sent a link that can\u{2019}t be opened safely (only http and https links are allowed)."),
            });
        } else if !card.fields.is_empty() {
            let mut list = div().mt(px(12.)).flex().flex_col().gap(px(12.));
            for f in &card.fields {
                list = list.child(self.field(f, cx));
            }
            body = body.child(list);
        }

        let primary =
            if card.is_url {
                if self.form.shows_done(&card) {
                    button(
                        "mcp-elicitation-done",
                        "I\u{2019}m done, continue",
                        Look::Primary,
                        false,
                        false,
                        &c,
                    )
                    .on_click(cx.listener(|this, _, _, cx| {
                        this.resolve(ElicitationDecision::Accept(None), cx)
                    }))
                } else {
                    let disabled = card.url.is_none();
                    icon_button(
                        "mcp-elicitation-open",
                        "ExternalLink",
                        "Open link",
                        Look::Primary,
                        &c,
                    )
                    .when(disabled, |b| b.opacity(0.4).cursor_default())
                    .when(!disabled, |b| {
                        b.on_click(cx.listener(|this, _, _, cx| this.open_link(cx)))
                    })
                }
            } else {
                button(
                    "mcp-elicitation-submit",
                    card.submit_label(),
                    Look::Primary,
                    false,
                    false,
                    &c,
                )
                .on_click(cx.listener(|this, _, _, cx| this.submit(cx)))
            };
        let footer =
            div()
                .flex()
                .flex_wrap()
                .items_center()
                .gap(px(8.))
                .border_t_1()
                .border_color(h(c.border))
                .bg(a(c.panel_2, 50.))
                .px(px(16.))
                .py(px(12.))
                .child(primary)
                .child(
                    div().ml_auto().child(
                        button(
                            "mcp-elicitation-decline",
                            "Decline",
                            Look::Danger,
                            false,
                            false,
                            &c,
                        )
                        .on_click(cx.listener(|this, _, _, cx| {
                            this.resolve(ElicitationDecision::Decline, cx)
                        })),
                    ),
                );

        backdrop("mcp-elicitation-backdrop").child(
            panel(&c, 560.)
                .debug_selector(|| "mcp-elicitation-modal".into())
                .child(header)
                .child(body)
                .child(footer),
        )
    }
}
