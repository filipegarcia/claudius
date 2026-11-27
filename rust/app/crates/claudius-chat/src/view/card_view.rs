//! The tool cards on screen (U06): [`crate::cards`]' models drawn with the
//! classes of `ToolCall.tsx`, `TaskBlock.tsx`, `WorkflowBlock.tsx`,
//! `ProposeGoalBlock.tsx`, `JsonBlock.tsx` and `FilePreview.tsx`.
//!
//! A running call's timer reads the view's clock when the row renders;
//! the view ticks once a second while any card on the list shows one
//! (`useElapsedSeconds`' interval). Links ("Open", the path, the
//! AskUserQuestion pill) are [`CardAction`]s the host handles.

use std::path::PathBuf;

use claudius_gpui_theme::fonts;
use gpui_kit::component::tooltip::Tooltip;
use gpui_kit::prelude::FluentBuilder as _;
use gpui_kit::{
    AnyElement, AnyView, App, Context, Div, FontWeight, HighlightStyle, Hsla,
    InteractiveElement as _, IntoElement, ObjectFit, ParentElement as _, SharedString,
    StatefulInteractiveElement as _, Styled as _, StyledImage as _, StyledText, Window, div, img,
    px,
};

use super::{Colors, TranscriptView, a, h, icon, kb, step, text_px};
use crate::cards::{
    CallBody, CallCard, CallMain, CallStatus, Card, Chip, ChipMark, ChipTone, Details, EditorLink,
    FilePreviewCard, FilesLink, GoalCard, GoalState, JsonView, MdText, PreFold, PreText,
    ResultTone, SubBlock, SubMessage, TaskCard, WorkflowCard,
};
use crate::rows::{Fold, ToolRow};
use crate::tool_text::{JsonTokenType, PreviewType, elapsed_seconds, format_elapsed};

/// What a card asks its host to do (U12 / U04b open files, U08 the
/// question).
#[derive(Clone, Debug, PartialEq)]
pub enum CardAction {
    /// The path link: the Files browser.
    OpenFiles(FilesLink),
    /// "Open": the file in the user's editor.
    OpenInEditor(EditorLink),
    /// The AskUserQuestion pill: re-show the question.
    ReopenAsk { tool_use_id: String },
}

/// A card's `my-2`: CSS collapses the 8px margins of neighbouring cards
/// (and adds the message column's 4px gap to none of them), so two cards
/// sit 8px apart; flex doesn't collapse, so each side takes 2px of it.
const CARD_MY: f32 = 2.;

fn tip(text: String) -> impl Fn(&mut Window, &mut App) -> AnyView {
    move |window, cx| Tooltip::new(text.clone()).build(window, cx)
}

fn sid(s: String) -> SharedString {
    SharedString::from(s)
}

/// A section label (`text-[10px] uppercase tracking-wide text-muted`).
fn label(c: &Colors, text: &str) -> Div {
    text_px(div(), 10., 14.)
        .mb(px(4.))
        .text_color(h(c.muted))
        .child(text.to_uppercase())
}

/// `STATUS_CHIP`'s border, background and text.
fn chip_colors(c: &Colors, tone: ChipTone) -> (Hsla, Hsla, Hsla) {
    let tint = |name: &str, text: &str| (a(step(name), 30.), a(step(name), 10.), h(step(text)));
    match tone {
        ChipTone::Pending => (h(c.border), h(c.panel_2), h(c.muted)),
        ChipTone::Sky => tint("sky-400", "sky-300"),
        ChipTone::Emerald => tint("emerald-400", "emerald-300"),
        ChipTone::Red => tint("red-400", "red-300"),
        ChipTone::Amber => tint("amber-400", "amber-300"),
    }
}

fn chip(c: &Colors, chip: &Chip) -> Div {
    let (border, bg, fg) = chip_colors(c, chip.tone);
    let dot = |dim: bool| {
        div()
            .size(px(6.))
            .rounded_full()
            .bg(fg)
            .when(dim, |d| d.opacity(0.4))
    };
    text_px(div(), 10., 14.)
        .debug_selector(|| "status-chip".into())
        .flex()
        .items_center()
        .gap(px(4.))
        .rounded(px(6.))
        .border_1()
        .border_color(border)
        .bg(bg)
        .px(px(6.))
        .py(px(2.))
        .font_weight(FontWeight::MEDIUM)
        .text_color(fg)
        .when(chip.dim, |d| d.opacity(0.6))
        .map(|d| match chip.mark {
            ChipMark::Pulse { dim } => d.child(dot(dim)),
            ChipMark::Dot => d.child(dot(false)),
            ChipMark::Check => d.children(icon("CheckCircle2", 12., fg)),
            ChipMark::Alert => d.children(icon("AlertCircle", 12., fg)),
            ChipMark::None => d,
        })
        .child(chip.label.clone())
}

/// A tinted badge (`rounded-md border … px-1.5 py-0.5 text-[10px]`).
fn badge(name: &str, text_step: &str) -> Div {
    text_px(div(), 10., 14.)
        .flex()
        .items_center()
        .gap(px(4.))
        .rounded(px(6.))
        .border_1()
        .border_color(a(step(name), 30.))
        .bg(a(step(name), 10.))
        .px(px(6.))
        .py(px(2.))
        .font_weight(FontWeight::MEDIUM)
        .text_color(h(step(text_step)))
}

/// The accent-tinted pill (the agent type, the workflow name).
fn accent_pill(c: &Colors, text: String) -> Div {
    text_px(div(), 10., 14.)
        .min_w_0()
        .overflow_hidden()
        .whitespace_nowrap()
        .text_ellipsis()
        .rounded(px(6.))
        .border_1()
        .border_color(a(c.accent, 30.))
        .bg(a(c.accent, 10.))
        .px(px(6.))
        .py(px(2.))
        .font_family(fonts::MONO)
        .text_color(h(c.accent))
        .child(text)
}

fn chevron(open: bool, size: f32, color: Hsla) -> Option<gpui_kit::component::Icon> {
    icon(
        if open { "ChevronDown" } else { "ChevronRight" },
        size,
        color,
    )
}

/// `JsonBlock`'s `TOKEN_CLASS`.
fn token_color(c: &Colors, t: JsonTokenType) -> Hsla {
    match t {
        JsonTokenType::Key => h(step("sky-300")),
        JsonTokenType::String => h(step("emerald-300")),
        JsonTokenType::Number => h(step("amber-300")),
        JsonTokenType::Boolean => h(step("purple-300")),
        JsonTokenType::Null => h(c.muted),
        JsonTokenType::Punct => a(c.foreground, 80.),
    }
}

impl TranscriptView {
    /// Runs (and records) a card's link.
    pub(super) fn act(&mut self, action: CardAction, window: &mut Window, cx: &mut Context<Self>) {
        if let Some(f) = &self.on_action {
            f(&action, window, cx);
        }
        self.actions.push(action);
    }

    /// The running timer's label at the view's clock.
    pub fn elapsed_label(&self, since: Option<f64>) -> Option<String> {
        elapsed_seconds(since, true, self.clock_ms()).map(format_elapsed)
    }

    pub(super) fn tool_card(
        &mut self,
        t: &ToolRow,
        c: &Colors,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        match &t.card {
            Card::Call(call) => self.call(call, Some(&t.id), c, cx),
            Card::Task(task) => self.task(task, c, cx),
            Card::Workflow(w) => self.workflow(w, c, cx),
            Card::Goal(g) => goal(g, c, cx),
        }
    }

    /// The "Show more (N KB)" / "Show less" under a folded `<pre>`.
    fn more(
        &self,
        key: &str,
        fold: PreFold,
        c: &Colors,
        cx: &mut Context<Self>,
    ) -> Option<AnyElement> {
        let text = match fold {
            PreFold::Whole => return None,
            PreFold::Folded { hidden_bytes } => format!("Show more ({})", kb(hidden_bytes)),
            PreFold::Expanded => "Show less".to_owned(),
        };
        let k = key.to_owned();
        Some(
            div()
                .flex()
                .child(
                    text_px(div(), 11., 16.)
                        .id(sid(format!("more-{key}")))
                        .debug_selector(|| "card-more".into())
                        .mt(px(4.))
                        .px(px(8.))
                        .py(px(2.))
                        .rounded(px(6.))
                        .border_1()
                        .border_color(h(c.border))
                        .bg(h(c.panel_2))
                        .text_color(h(c.muted))
                        .cursor_pointer()
                        .hover(|s| s.text_color(h(c.foreground)))
                        .child({
                            let label = text.clone();
                            div()
                                .debug_selector(move || format!("card-more-label:{label}"))
                                .child(text)
                        })
                        .on_click(cx.listener(move |this, _, _, cx| this.toggle(k.clone(), cx))),
                )
                .into_any_element(),
        )
    }

    /// A `<pre>`: a scroll box of at most `max_h`, then its fold button.
    #[allow(clippy::too_many_arguments)]
    fn pre(
        &self,
        p: &PreText,
        max_h: f32,
        size: f32,
        color: Hsla,
        selector: &'static str,
        c: &Colors,
        cx: &mut Context<Self>,
    ) -> Div {
        div()
            .flex()
            .flex_col()
            .child(
                text_px(div(), size, size * 4. / 3.)
                    .id(sid(format!("pre-{}", p.key)))
                    .debug_selector(move || selector.into())
                    .max_h(px(max_h))
                    .overflow_y_scroll()
                    .rounded(px(4.))
                    .bg(h(c.panel_2))
                    .p(px(8.))
                    .font_family(fonts::MONO)
                    .text_color(color)
                    .child(p.text.to_string()),
            )
            .children(self.more(&p.key, p.fold, c, cx))
    }

    /// A `<details>`'s summary line, `▸` / `▾` as the browser draws it.
    fn summary<T>(&self, d: &Details<T>, c: &Colors, cx: &mut Context<Self>) -> AnyElement {
        let key = d.key.clone();
        let open = d.body.is_some();
        text_px(div(), 10., 14.)
            .id(sid(format!("details-{}", d.key)))
            .debug_selector(move || format!("details:{}", d.summary))
            .flex()
            .gap(px(4.))
            .cursor_pointer()
            .text_color(h(c.muted))
            .child(if open { "▾" } else { "▸" })
            .child(d.summary.to_uppercase())
            .on_click(cx.listener(move |this, _, _, cx| this.toggle(key.clone(), cx)))
            .into_any_element()
    }

    /// Markdown inside a card, folded as message text.
    fn md_section(
        &mut self,
        m: &MdText,
        text_size: f32,
        c: &Colors,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let (cache_key, shown) = match &m.fold {
            Fold::Folded { shown, .. } => (format!("fold:{}", m.key), shown.clone()),
            _ => (m.key.clone(), m.text.clone()),
        };
        let md = self.markdown(cache_key, &shown, text_size, cx);
        let fold = match m.fold {
            Fold::Whole => PreFold::Whole,
            Fold::Folded { hidden_bytes, .. } => PreFold::Folded { hidden_bytes },
            Fold::Expanded => PreFold::Expanded,
        };
        div()
            .flex()
            .flex_col()
            .child(md)
            .children(self.more(&format!("fold:{}", m.key), fold, c, cx))
            .into_any_element()
    }

    /// `JsonBlock`: the colored dump, behind "N lines — click to expand"
    /// past 12 lines.
    fn json(&self, j: &JsonView, max_h: f32, c: &Colors, cx: &mut Context<Self>) -> AnyElement {
        let foldable = j.lines > crate::cards::JSON_COLLAPSED_LINES;
        let key = j.key.clone();
        let mut out = div().flex().flex_col();
        if foldable {
            out = out.child(
                text_px(div(), 10., 14.)
                    .id(sid(format!("json-fold-{}", j.key)))
                    .debug_selector(|| "json-block-fold".into())
                    .cursor_pointer()
                    .text_color(h(c.muted))
                    .child(format!("{} lines — click to expand", j.lines))
                    .on_click(cx.listener(move |this, _, _, cx| this.toggle(key.clone(), cx))),
            );
        }
        if let Some(tokens) = &j.tokens {
            let mut text = String::new();
            let mut runs = Vec::new();
            for (t, kind) in tokens.iter() {
                let start = text.len();
                text.push_str(t);
                runs.push((
                    start..text.len(),
                    HighlightStyle {
                        color: Some(token_color(c, *kind)),
                        ..Default::default()
                    },
                ));
            }
            out = out
                .child(
                    text_px(div(), 11., 15.)
                        .id(sid(format!("json-{}", j.key)))
                        .debug_selector(|| "json-block".into())
                        .when(foldable, |d| d.mt(px(4.)))
                        .max_h(px(max_h))
                        .overflow_y_scroll()
                        .rounded(px(4.))
                        .bg(h(c.panel_2))
                        .p(px(8.))
                        .font_family(fonts::MONO)
                        .text_color(a(c.foreground, 80.))
                        .child(StyledText::new(text).with_highlights(runs)),
                )
                .children(self.more(&format!("{}/more", j.key), j.more, c, cx));
        }
        out.into_any_element()
    }

    /// `ToolCall`.
    pub(super) fn call(
        &mut self,
        t: &CallCard,
        tool_use_id: Option<&str>,
        c: &Colors,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let key = t.key.clone();
        let name = t.name.clone();
        let toggle = div()
            .id(sid(format!("toggle-{}", t.key)))
            .debug_selector(move || format!("tool-toggle:{name}"))
            .flex()
            .items_center()
            .gap(px(8.))
            .py(px(6.))
            .pl(px(12.))
            .min_w_0()
            .map(|d| {
                if t.path.is_some() {
                    d.flex_none()
                } else {
                    d.flex_1()
                }
            })
            .cursor_pointer()
            .children(chevron(t.open, 14., h(c.foreground)))
            .children(icon(t.icon, 14., h(c.accent)))
            .child(
                div()
                    .font_family(fonts::MONO)
                    .whitespace_nowrap()
                    .child(t.title.clone()),
            )
            .when(t.plan_suffix, |d| {
                d.child(
                    text_px(div(), 10., 14.)
                        .text_color(h(c.muted))
                        .child("— Plan"),
                )
            })
            .when_some(t.schedule_action.clone(), |d, act| {
                d.child(
                    text_px(div(), 10., 14.)
                        .text_color(h(c.muted))
                        .child(format!("— {act}")),
                )
            })
            .on_click(cx.listener(move |this, _, _, cx| this.toggle(key.clone(), cx)));
        let path = t.path.as_ref().map(|p| {
            let row = text_px(div(), 10., 14.)
                .id(sid(format!("path-{}", t.key)))
                .debug_selector(|| "tool-call-path".into())
                .flex()
                .flex_1()
                .min_w_0()
                .font_family(fonts::MONO)
                .text_color(h(c.muted))
                .when(!p.head.is_empty(), |d| {
                    d.child(
                        div()
                            .min_w_0()
                            .overflow_hidden()
                            .whitespace_nowrap()
                            .text_ellipsis()
                            .child(p.head.clone()),
                    )
                })
                .child(div().flex_none().whitespace_nowrap().child(p.tail.clone()))
                .tooltip(tip(p.full.clone()));
            match &p.files {
                Some(link) => {
                    let link = link.clone();
                    row.cursor_pointer()
                        .hover(|s| s.text_color(h(c.accent)))
                        .on_click(cx.listener(move |this, _, window, cx| {
                            this.act(CardAction::OpenFiles(link.clone()), window, cx)
                        }))
                }
                None => row,
            }
        });
        let answer = t.answer.map(|pill| {
            let id = tool_use_id.unwrap_or_default().to_owned();
            let (border, bg, fg) = if pill.live {
                (a(c.accent, 50.), a(c.accent, 15.), h(c.accent))
            } else {
                (h(c.border), h(c.panel_2), h(c.muted))
            };
            text_px(div(), 10., 14.)
                .id(sid(format!("answer-{}", t.key)))
                .debug_selector(|| "tool-call-answer-pill".into())
                .flex()
                .items_center()
                .gap(px(4.))
                .rounded(px(6.))
                .border_1()
                .border_color(border)
                .bg(bg)
                .px(px(8.))
                .py(px(2.))
                .font_weight(FontWeight::MEDIUM)
                .text_color(fg)
                .cursor_pointer()
                .children(icon("MessageCircleQuestion", 12., fg))
                .child(pill.label())
                .tooltip(tip(pill.title().into()))
                .on_click(cx.listener(move |this, _, window, cx| {
                    this.act(
                        CardAction::ReopenAsk {
                            tool_use_id: id.clone(),
                        },
                        window,
                        cx,
                    )
                }))
        });
        let status = self.call_status(t, c);
        let header = text_px(div(), 12., 16.)
            .flex()
            .w_full()
            .items_center()
            .gap(px(8.))
            .pr(px(12.))
            .text_color(h(c.foreground))
            .hover(|s| s.bg(h(c.panel_2)))
            .child(toggle)
            .children(path)
            .children(answer)
            .child(status);
        let name = t.name.clone();
        let mut card = div()
            .debug_selector(move || format!("tool-call:{name}"))
            .my(px(CARD_MY))
            .rounded(px(8.))
            .border_1()
            .border_color(h(c.border))
            .bg(a(c.panel, 40.))
            .flex()
            .flex_col()
            .when(t.dim(), |d| d.opacity(0.6))
            .child(header);
        if let Some(p) = &t.preview {
            card = card.child(self.preview(p, c, cx));
        }
        if let Some(body) = &t.body {
            card = card.child(self.call_body(body, t.status, c, cx));
        }
        card.into_any_element()
    }

    /// The header's right-hand cluster: badges, then the status.
    fn call_status(&self, t: &CallCard, c: &Colors) -> Div {
        let muted = h(c.muted);
        let mut d = div().flex().items_center().gap(px(4.)).text_color(muted);
        if let Some(n) = t.resource_count {
            d = d.child(
                text_px(div(), 10., 14.)
                    .id("tool-call-resource-links-badge")
                    .debug_selector(|| "tool-call-resource-links-badge".into())
                    .flex()
                    .items_center()
                    .gap(px(2.))
                    .children(icon("Paperclip", 12., muted))
                    .child(n.to_string())
                    .tooltip(tip(format!(
                        "{n} file{} returned",
                        if n == 1 { "" } else { "s" }
                    ))),
            );
        }
        if t.staged {
            d = d.child(
                badge("amber-500", "amber-300")
                    .id("tool-call-staged-badge")
                    .debug_selector(|| "tool-call-staged-badge".into())
                    .children(icon("Clock", 12., h(step("amber-300"))))
                    .child("Staged")
                    .tooltip(tip(
                        "Held for review — the file was not written to disk".into()
                    )),
            );
        }
        if t.detached {
            d = d.child(
                badge("sky-500", "sky-300")
                    .id("tool-call-detached-badge")
                    .debug_selector(|| "tool-call-detached-badge".into())
                    .children(icon("Clock", 12., h(step("sky-300"))))
                    .child("Continuing in background")
                    .tooltip(tip("Moved to the background so your message could go first — the result arrives in a later turn".into())),
            );
        }
        match t.status {
            CallStatus::Running {
                since,
                disconnected,
            } => {
                if let Some(label) = self.elapsed_label(since) {
                    let sel = label.clone();
                    d = d.child(
                        text_px(div(), 10., 14.)
                            .debug_selector(move || format!("tool-call-elapsed:{sel}"))
                            .text_color(muted)
                            .child(label),
                    );
                }
                d = d.child(
                    div()
                        .debug_selector(|| "tool-call-running".into())
                        .size(px(8.))
                        .rounded_full()
                        .bg(h(c.accent))
                        .when(disconnected, |d| d.opacity(0.4)),
                );
            }
            CallStatus::Ok => {
                d = d.child(
                    div()
                        .debug_selector(|| "tool-call-ok".into())
                        .children(icon("CheckCircle2", 14., h(step("emerald-500")))),
                );
            }
            CallStatus::Error => {
                d = d.child(
                    div()
                        .debug_selector(|| "tool-call-error".into())
                        .children(icon("AlertCircle", 14., h(step("red-500")))),
                );
            }
            CallStatus::Interrupted(reason) => {
                let amber = h(step("amber-400"));
                d = d.child(
                    text_px(div(), 10., 14.)
                        .id("tool-call-interrupted")
                        .debug_selector(|| "tool-call-interrupted".into())
                        .flex()
                        .items_center()
                        .gap(px(4.))
                        .text_color(amber)
                        .children(icon("CircleStop", 14., amber))
                        .child(reason.label())
                        .tooltip(tip(reason.title().into())),
                );
            }
            CallStatus::NotRun { rejected } => {
                let (text, title) = CallStatus::not_run_text(rejected);
                d = d.child(
                    text_px(div(), 10., 14.)
                        .id("tool-call-not-run")
                        .debug_selector(|| "tool-call-not-run".into())
                        .flex()
                        .items_center()
                        .gap(px(4.))
                        .text_color(muted)
                        .children(icon("MinusCircle", 14., muted))
                        .child(text)
                        .tooltip(tip(title.into())),
                );
            }
        }
        d
    }

    fn call_body(
        &mut self,
        body: &CallBody,
        status: CallStatus,
        c: &Colors,
        cx: &mut Context<Self>,
    ) -> Div {
        let mut d = div()
            .debug_selector(|| "tool-call-body".into())
            .border_t_1()
            .border_color(h(c.border))
            .flex()
            .flex_col();
        let section = || div().px(px(12.)).py(px(8.)).flex().flex_col();
        d = d.child(match &body.main {
            CallMain::Plan(md) => section().child(label(c, "plan")).child(
                div()
                    .debug_selector(|| "tool-call-plan-preview".into())
                    .rounded(px(4.))
                    .bg(h(c.panel_2))
                    .px(px(12.))
                    .py(px(8.))
                    .child(self.md_section(md, 14., c, cx)),
            ),
            CallMain::Feedback(md) => section()
                .child(label(c, "drafted report"))
                .child(
                    div()
                        .rounded(px(4.))
                        .bg(h(c.panel_2))
                        .px(px(12.))
                        .py(px(8.))
                        .child(self.md_section(md, 14., c, cx)),
                )
                .child(
                    text_px(div(), 10., 14.)
                        .mt(px(4.))
                        .flex()
                        .gap(px(4.))
                        .text_color(h(c.muted))
                        .child("Review and send this report from")
                        .child(div().font_family(fonts::MONO).child("/feedback"))
                        .child("."),
                ),
            CallMain::Input { editor, json } => {
                let head = text_px(div(), 10., 14.)
                    .mb(px(4.))
                    .flex()
                    .items_center()
                    .gap(px(8.))
                    .text_color(h(c.muted))
                    .child("INPUT")
                    .when_some(editor.clone(), |d, link| {
                        let title = link.title();
                        d.child(
                            text_px(div(), 10., 14.)
                                .id("tool-call-open")
                                .debug_selector(|| "tool-call-open".into())
                                .ml_auto()
                                .flex()
                                .items_center()
                                .gap(px(4.))
                                .rounded(px(6.))
                                .border_1()
                                .border_color(h(c.border))
                                .bg(h(c.panel_2))
                                .px(px(6.))
                                .py(px(2.))
                                .text_color(h(c.foreground))
                                .cursor_pointer()
                                .hover(|s| s.bg(h(c.panel)))
                                .children(icon("ExternalLink", 12., h(c.foreground)))
                                .child("Open")
                                .tooltip(tip(title))
                                .on_click(cx.listener(move |this, _, window, cx| {
                                    this.act(CardAction::OpenInEditor(link.clone()), window, cx)
                                })),
                        )
                    });
                section().child(head).child(self.pre(
                    json,
                    240.,
                    12.,
                    h(c.foreground),
                    "tool-call-input",
                    c,
                    cx,
                ))
            }
        });
        if let Some(r) = &body.result {
            let not_run = matches!(status, CallStatus::NotRun { .. });
            let color = match r.tone {
                ResultTone::Plain => h(c.foreground),
                ResultTone::Error => h(step("red-400")),
                ResultTone::Muted => h(c.muted),
            };
            let selector = if r.tone == ResultTone::Error {
                "tool-call-result-error"
            } else {
                "tool-call-result"
            };
            let _ = not_run;
            d = d.child(
                div()
                    .px(px(12.))
                    .pb(px(8.))
                    .flex()
                    .flex_col()
                    .child(label(c, r.label))
                    .child(self.pre(&r.text, 320., 12., color, selector, c, cx)),
            );
        }
        if !body.links.is_empty() {
            let mut list = div().flex().flex_col().gap(px(2.));
            for (i, l) in body.links.iter().enumerate() {
                list = list.child(
                    text_px(div(), 12., 16.)
                        .id(sid(format!("link-{i}-{}", l.uri)))
                        .flex()
                        .items_center()
                        .gap(px(6.))
                        .overflow_hidden()
                        .whitespace_nowrap()
                        .font_family(fonts::MONO)
                        .text_color(h(c.muted))
                        .children(icon("Paperclip", 12., h(c.muted)))
                        .child(l.label.clone())
                        .tooltip(tip(l.title.clone())),
                );
            }
            d = d.child(
                div()
                    .debug_selector(|| "tool-call-resource-links".into())
                    .px(px(12.))
                    .pb(px(8.))
                    .child(label(c, "files returned"))
                    .child(list),
            );
        }
        d
    }

    /// `FilePreview`.
    fn preview(&mut self, p: &FilePreviewCard, c: &Colors, cx: &mut Context<Self>) -> AnyElement {
        let key = p.key.clone();
        let head = text_px(div(), 11., 16.)
            .id(sid(format!("preview-{}", p.key)))
            .debug_selector(|| "file-preview-toggle".into())
            .flex()
            .items_center()
            .gap(px(8.))
            .px(px(8.))
            .py(px(4.))
            .cursor_pointer()
            .hover(|s| s.bg(h(c.panel_2)))
            .children(chevron(p.open, 12., h(c.muted)))
            .children(icon(
                if p.kind == PreviewType::Image {
                    "ImageIcon"
                } else {
                    "Globe"
                },
                12.,
                h(c.accent),
            ))
            .child(
                text_px(div(), 10., 14.)
                    .min_w_0()
                    .overflow_hidden()
                    .whitespace_nowrap()
                    .text_ellipsis()
                    .font_family(fonts::MONO)
                    .text_color(h(c.muted))
                    .child(p.file_name.clone()),
            )
            .child(
                text_px(div(), 10., 14.)
                    .ml_auto()
                    .flex_none()
                    .text_color(h(c.muted))
                    .child(p.label().to_uppercase()),
            )
            .on_click(cx.listener(move |this, _, _, cx| this.toggle(key.clone(), cx)));
        let body = p.open.then(|| {
            let inner = match p.kind {
                PreviewType::Image => {
                    let root = self
                        .opts
                        .file_link
                        .as_ref()
                        .map(|l| PathBuf::from(&l.cwd))
                        .unwrap_or_default();
                    div().flex().justify_center().p(px(8.)).child(
                        div()
                            .overflow_hidden()
                            .rounded(px(4.))
                            .border_1()
                            .border_color(h(c.border))
                            .child(
                                img(root.join(&p.rel_path))
                                    .max_h(px(320.))
                                    .max_w_full()
                                    .object_fit(ObjectFit::Contain),
                            ),
                    )
                }
                // An `<iframe>` of the page: the embedded web view (U12).
                PreviewType::Html => div().p(px(8.)).child(
                    text_px(div(), 11., 16.)
                        .italic()
                        .text_color(h(c.muted))
                        .child(format!("Preview of {}", p.file_name)),
                ),
            };
            inner.border_t_1().border_color(h(c.border))
        });
        div()
            .debug_selector(|| "file-preview".into())
            .mx(px(12.))
            .mb(px(8.))
            .overflow_hidden()
            .rounded(px(6.))
            .border_1()
            .border_color(h(c.border))
            .bg(a(c.panel, 60.))
            .flex()
            .flex_col()
            .child(head)
            .children(body)
            .into_any_element()
    }

    /// `TaskBlock`.
    fn task(&mut self, t: &TaskCard, c: &Colors, cx: &mut Context<Self>) -> AnyElement {
        let key = t.key.clone();
        let muted = h(c.muted);
        let header = text_px(div(), 12., 16.)
            .id(sid(format!("task-{}", t.key)))
            .debug_selector(|| "task-toggle".into())
            .flex()
            .w_full()
            .min_w_0()
            .items_center()
            .gap(px(8.))
            .px(px(12.))
            .py(px(6.))
            .cursor_pointer()
            .hover(|s| s.bg(a(c.panel_2, 40.)))
            .children(chevron(t.open, 14., muted))
            .children(icon("Bot", 14., h(c.accent)))
            .child(accent_pill(c, t.agent.clone()).flex_shrink(1.))
            .when_some(t.title.clone(), |d, title| {
                d.child(
                    div()
                        .min_w_0()
                        .flex_1()
                        .overflow_hidden()
                        .whitespace_nowrap()
                        .text_ellipsis()
                        .text_color(muted)
                        .child(match &t.activity {
                            Some(act) => format!("— {title} · {act}"),
                            None => format!("— {title}"),
                        }),
                )
            })
            .child(
                div()
                    .ml_auto()
                    .flex()
                    .flex_none()
                    .items_center()
                    .gap(px(8.))
                    .whitespace_nowrap()
                    .when_some(t.retrying.clone(), |d, (text, title)| {
                        d.child(
                            badge("amber-500", "amber-300")
                                .id("subagent-retry-badge")
                                .debug_selector(|| "subagent-retry-badge".into())
                                .child(text)
                                .tooltip(tip(title)),
                        )
                    })
                    .when(t.disconnected, |d| {
                        d.child(
                            badge("amber-500", "amber-300")
                                .debug_selector(|| "subagent-disconnected-badge".into())
                                .children(icon("WifiOff", 12., h(step("amber-300"))))
                                .child("disconnected"),
                        )
                    })
                    .child(chip(c, &t.chip))
                    .when_some(t.stats.clone(), |d, s| {
                        d.child(text_px(div(), 10., 14.).text_color(muted).child(s))
                    }),
            )
            .on_click(cx.listener(move |this, _, _, cx| this.toggle(key.clone(), cx)));
        let body = t.body.as_ref().map(|body| {
            let mut d = div()
                .debug_selector(|| "task-body".into())
                .border_t_1()
                .border_color(a(c.accent, 20.))
                .px(px(12.))
                .py(px(8.))
                .flex()
                .flex_col();
            if let Some(p) = &body.prompt {
                d = d.child(div().mb(px(8.)).child(self.summary(p, c, cx)).when_some(
                    p.body.as_ref(),
                    |el, text| {
                        el.child(div().mt(px(4.)).child(self.pre(
                            text,
                            160.,
                            11.,
                            h(c.foreground),
                            "task-prompt",
                            c,
                            cx,
                        )))
                    },
                ));
            }
            if let Some(err) = &body.error {
                d = d.child(
                    text_px(div(), 11., 16.)
                        .mb(px(8.))
                        .rounded(px(6.))
                        .border_1()
                        .border_color(a(step("red-500"), 30.))
                        .bg(a(step("red-500"), 10.))
                        .px(px(8.))
                        .py(px(4.))
                        .text_color(h(step("red-300")))
                        .child(err.clone()),
                );
            }
            if let Some(note) = body.empty_note {
                d = d.child(
                    text_px(div(), 11., 16.)
                        .italic()
                        .text_color(muted)
                        .child(note),
                );
            } else {
                let mut list = div().flex().flex_col().gap(px(8.));
                for m in &body.inner {
                    list = list.child(self.sub_message(m, c, cx));
                }
                d = d.child(list);
            }
            if let Some(r) = &body.returned {
                d = d.child(
                    div()
                        .mt(px(8.))
                        .debug_selector(|| "task-returned-to-parent".into())
                        .child(self.summary(r, c, cx))
                        .when_some(r.body.as_ref(), |el, ret| {
                            let color = if ret.error {
                                h(step("red-300"))
                            } else {
                                h(c.foreground)
                            };
                            let mut col = div().mt(px(4.)).flex().flex_col().child(self.pre(
                                &ret.text,
                                288.,
                                11.,
                                color,
                                "task-returned",
                                c,
                                cx,
                            ));
                            for note in &ret.provenance {
                                col = col.child(
                                    text_px(div(), 10., 14.)
                                        .debug_selector(|| "task-handback-provenance".into())
                                        .mt(px(4.))
                                        .italic()
                                        .text_color(muted)
                                        .child(note.clone()),
                                );
                            }
                            el.child(col)
                        }),
                );
            }
            d
        });
        div()
            .debug_selector(|| "task-block".into())
            .my(px(CARD_MY))
            .rounded(px(8.))
            .border_1()
            .border_color(a(c.accent, 30.))
            .bg(a(c.accent, 5.))
            .flex()
            .flex_col()
            .child(header)
            .children(body)
            .into_any_element()
    }

    /// `SubMessage`.
    fn sub_message(&mut self, m: &SubMessage, c: &Colors, cx: &mut Context<Self>) -> AnyElement {
        let muted = h(c.muted);
        match m {
            SubMessage::User { text, .. } => text_px(div(), 11., 16.)
                .debug_selector(|| "subagent-prompt".into())
                .rounded(px(6.))
                .bg(a(c.panel_2, 60.))
                .px(px(8.))
                .py(px(4.))
                .child(
                    text_px(div(), 10., 14.)
                        .mb(px(2.))
                        .text_color(muted)
                        .child("→ SUBAGENT"),
                )
                .child(div().font_family(fonts::MONO).child(text.to_string()))
                .into_any_element(),
            SubMessage::Assistant { blocks, .. } => {
                let mut col = div().flex().flex_col().gap(px(6.));
                for b in blocks {
                    col = col.child(match b {
                        SubBlock::Text(md) => div()
                            .text_size(px(12.))
                            .line_height(px(20.))
                            .child(self.md_section(md, 12., c, cx))
                            .into_any_element(),
                        SubBlock::Thinking {
                            key,
                            label,
                            open,
                            body,
                        } => super::thinking(key.clone(), label, *open, body, c, cx),
                        SubBlock::Tool(call) => self.call(call, None, c, cx),
                    });
                }
                text_px(div(), 11., 16.)
                    .debug_selector(|| "subagent-message".into())
                    .rounded(px(6.))
                    .bg(a(c.panel, 40.))
                    .px(px(8.))
                    .py(px(4.))
                    .child(
                        text_px(div(), 10., 14.)
                            .mb(px(2.))
                            .flex()
                            .items_center()
                            .gap(px(6.))
                            .text_color(muted)
                            .child(div().size(px(4.)).rounded_full().bg(h(c.accent)))
                            .child("Subagent"),
                    )
                    .child(col)
                    .into_any_element()
            }
        }
    }

    /// `WorkflowBlock`.
    fn workflow(&mut self, w: &WorkflowCard, c: &Colors, cx: &mut Context<Self>) -> AnyElement {
        let key = w.key.clone();
        let muted = h(c.muted);
        let header = text_px(div(), 12., 16.)
            .id(sid(format!("workflow-{}", w.key)))
            .debug_selector(|| "workflow-toggle".into())
            .flex()
            .w_full()
            .min_w_0()
            .items_center()
            .gap(px(8.))
            .px(px(12.))
            .py(px(6.))
            .cursor_pointer()
            .hover(|s| s.bg(a(c.panel_2, 40.)))
            .children(chevron(w.open, 14., muted))
            .children(icon("Workflow", 14., h(c.accent)))
            .child(div().flex_none().text_color(muted).child("Workflow"))
            .child(accent_pill(c, w.name.clone()).flex_shrink(1.))
            .when_some(w.phases_label.clone(), |d, l| {
                d.child(text_px(div(), 10., 14.).flex_none().text_color(muted).child(l))
            })
            .when_some(w.size.clone(), |d, s| {
                d.child(
                    text_px(div(), 9., 12.)
                        .id("workflow-size")
                        .debug_selector(|| "workflow-size".into())
                        .flex_none()
                        .rounded(px(4.))
                        .border_1()
                        .border_color(h(c.border))
                        .px(px(4.))
                        .text_color(muted)
                        .child(s.to_uppercase())
                        .tooltip(tip("Dynamic-workflow size guideline — change it in Settings → Model & behavior".into())),
                )
            })
            .child(
                div()
                    .ml_auto()
                    .flex()
                    .flex_none()
                    .items_center()
                    .gap(px(8.))
                    .whitespace_nowrap()
                    .child(chip(c, &w.chip))
                    .when_some(w.stats.clone(), |d, s| {
                        d.child(text_px(div(), 10., 14.).text_color(muted).child(s))
                    }),
            )
            .on_click(cx.listener(move |this, _, _, cx| this.toggle(key.clone(), cx)));
        let body = w.body.as_ref().map(|b| {
            let mut d = text_px(div(), 11., 16.)
                .debug_selector(|| "workflow-body".into())
                .border_t_1()
                .border_color(a(c.accent, 20.))
                .px(px(12.))
                .py(px(8.))
                .flex()
                .flex_col()
                .gap(px(8.));
            if let Some(desc) = &b.description {
                d = d.child(div().text_color(muted).child(desc.clone()));
            }
            if let Some((summary, pulse)) = &b.live_summary {
                d = d.child(
                    div()
                        .flex()
                        .items_start()
                        .gap(px(6.))
                        .rounded(px(6.))
                        .bg(a(c.panel_2, 60.))
                        .px(px(8.))
                        .py(px(4.))
                        .child(
                            div()
                                .mt(px(4.))
                                .flex_none()
                                .size(px(6.))
                                .rounded_full()
                                .bg(h(c.accent))
                                .when(!pulse, |d| d.opacity(0.4)),
                        )
                        .child(div().text_color(a(c.foreground, 80.)).child(summary.clone())),
                );
            }
            if b.preparing {
                d = d.child(div().italic().text_color(muted).child("Preparing workflow…"));
            }
            if !b.phases.is_empty() {
                let mut ol = div().flex().flex_col().gap(px(4.));
                for (n, title, detail) in &b.phases {
                    ol = ol.child(
                        div()
                            .flex()
                            .gap(px(8.))
                            .child(
                                text_px(div(), 9., 12.)
                                    .mt(px(2.))
                                    .flex_none()
                                    .size(px(16.))
                                    .flex()
                                    .items_center()
                                    .justify_center()
                                    .rounded_full()
                                    .border_1()
                                    .border_color(h(c.border))
                                    .bg(h(c.panel_2))
                                    .font_family(fonts::MONO)
                                    .text_color(muted)
                                    .child(n.to_string()),
                            )
                            .child(
                                div()
                                    .min_w_0()
                                    .flex()
                                    .flex_wrap()
                                    .child(
                                        div()
                                            .font_weight(FontWeight::MEDIUM)
                                            .text_color(a(c.foreground, 90.))
                                            .child(title.clone()),
                                    )
                                    .when_some(detail.clone(), |d, t| {
                                        d.child(div().text_color(muted).child(format!("\u{a0}— {t}")))
                                    }),
                            ),
                    );
                }
                d = d.child(
                    div()
                        .child(label(c, "Phases"))
                        .child(ol)
                        .child(
                            text_px(div(), 9., 12.)
                                .mt(px(4.))
                                .text_color(a(c.muted, 70.))
                                .child("Declared phases. Per-agent progress runs out-of-band — watch the rolling status above."),
                        ),
                );
            }
            if let Some(err) = &b.error {
                d = d.child(
                    div()
                        .debug_selector(|| "workflow-error".into())
                        .rounded(px(6.))
                        .border_1()
                        .border_color(a(step("red-500"), 30.))
                        .bg(a(step("red-500"), 10.))
                        .px(px(8.))
                        .py(px(4.))
                        .text_color(h(step("red-300")))
                        .child(err.clone()),
                );
            }
            if let Some(result) = &b.result {
                d = d.child(
                    div().child(label(c, "Result")).child(
                        text_px(div(), 11., 20.)
                            .rounded(px(4.))
                            .bg(h(c.panel_2))
                            .px(px(8.))
                            .py(px(6.))
                            .child(result.clone()),
                    ),
                );
            }
            if b.run_id.is_some() || b.transcript_dir.is_some() {
                d = d.child(
                    text_px(div(), 10., 14.)
                        .flex()
                        .flex_col()
                        .gap(px(2.))
                        .font_family(fonts::MONO)
                        .text_color(muted)
                        .when_some(b.run_id.clone(), |d, id| {
                            d.child(div().overflow_hidden().whitespace_nowrap().text_ellipsis().child(format!("run: {id}")))
                        })
                        .when_some(b.transcript_dir.clone(), |d, dir| {
                            d.child(
                                div()
                                    .overflow_hidden()
                                    .whitespace_nowrap()
                                    .text_ellipsis()
                                    .child(format!("transcripts: {dir}")),
                            )
                        }),
                );
            }
            if let Some(args) = &b.args {
                d = d.child(
                    div().child(self.summary(args, c, cx)).when_some(args.body.as_ref(), |el, j| {
                        el.child(div().mt(px(4.)).child(self.json(j, 160., c, cx)))
                    }),
                );
            }
            if let Some(raw) = &b.raw {
                d = d.child(
                    div().child(self.summary(raw, c, cx)).when_some(raw.body.as_ref(), |el, j| {
                        el.child(div().mt(px(4.)).child(self.json(j, 288., c, cx)))
                    }),
                );
            }
            if let Some(script) = &b.script {
                d = d.child(
                    div().child(self.summary(script, c, cx)).when_some(script.body.as_ref(), |el, p| {
                        el.child(div().mt(px(4.)).child(self.pre(
                            p,
                            288.,
                            11.,
                            h(c.foreground),
                            "workflow-script",
                            c,
                            cx,
                        )))
                    }),
                );
            }
            d
        });
        div()
            .debug_selector(|| "workflow-block".into())
            .my(px(CARD_MY))
            .rounded(px(8.))
            .border_1()
            .border_color(a(c.accent, 30.))
            .bg(a(c.accent, 5.))
            .flex()
            .flex_col()
            .child(header)
            .children(body)
            .into_any_element()
    }
}

/// `ProposeGoalBlock`.
fn goal(g: &GoalCard, c: &Colors, cx: &mut Context<TranscriptView>) -> AnyElement {
    let key = g.key.clone();
    let muted = h(c.muted);
    let (border, bg, fg) = match g.state {
        GoalState::Error => (
            a(step("red-400"), 30.),
            a(step("red-400"), 10.),
            h(step("red-300")),
        ),
        GoalState::Proposing => (
            a(step("sky-400"), 30.),
            a(step("sky-400"), 10.),
            h(step("sky-300")),
        ),
        GoalState::AwaitingApproval => (
            a(step("amber-400"), 30.),
            a(step("amber-400"), 10.),
            h(step("amber-200")),
        ),
        GoalState::GoalSet => (
            a(step("emerald-400"), 30.),
            a(step("emerald-400"), 10.),
            h(step("emerald-300")),
        ),
    };
    let header = text_px(div(), 12., 16.)
        .id(sid(format!("goal-{}", g.key)))
        .debug_selector(|| "propose-goal-toggle".into())
        .flex()
        .w_full()
        .min_w_0()
        .items_center()
        .gap(px(8.))
        .px(px(12.))
        .py(px(6.))
        .cursor_pointer()
        .hover(|s| s.bg(a(c.panel_2, 40.)))
        .children(chevron(g.open, 14., muted))
        .children(icon("Target", 14., h(c.accent)))
        .child(div().flex_none().text_color(muted).child("Proposed goal"))
        .when_some(g.condition.clone(), |d, cond| {
            d.child(
                text_px(div(), 11., 16.)
                    .min_w_0()
                    .overflow_hidden()
                    .whitespace_nowrap()
                    .text_ellipsis()
                    .text_color(a(c.foreground, 80.))
                    .child(cond),
            )
        })
        .child(
            div().ml_auto().flex_none().child(
                text_px(div(), 10., 14.)
                    .debug_selector(|| "goal-chip".into())
                    .flex()
                    .items_center()
                    .gap(px(4.))
                    .rounded(px(6.))
                    .border_1()
                    .border_color(border)
                    .bg(bg)
                    .px(px(6.))
                    .py(px(2.))
                    .font_weight(FontWeight::MEDIUM)
                    .text_color(fg)
                    .when(g.state == GoalState::GoalSet, |d| {
                        d.children(icon("CheckCircle2", 12., fg))
                    })
                    .child(g.state.label()),
            ),
        )
        .on_click(cx.listener(move |this, _, _, cx| this.toggle(key.clone(), cx)));
    let body = g.body.as_ref().map(|b| {
        text_px(div(), 11., 16.)
            .border_t_1()
            .border_color(a(c.accent, 20.))
            .px(px(12.))
            .py(px(8.))
            .flex()
            .flex_col()
            .gap(px(8.))
            .child(
                div()
                    .child(label(c, "Completion condition"))
                    .child(match &b.condition {
                        Some(cond) => text_px(div(), 11., 20.)
                            .rounded(px(4.))
                            .bg(h(c.panel_2))
                            .px(px(8.))
                            .py(px(6.))
                            .text_color(a(c.foreground, 90.))
                            .child(cond.clone()),
                        None => div().italic().text_color(muted).child("Proposing a goal…"),
                    }),
            )
            .child(
                text_px(div(), 10., 14.)
                    .text_color(a(c.muted, 80.))
                    .child(b.note),
            )
    });
    div()
        .debug_selector(|| "propose-goal-block".into())
        .my(px(CARD_MY))
        .rounded(px(8.))
        .border_1()
        .border_color(a(c.accent, 30.))
        .bg(a(c.accent, 5.))
        .flex()
        .flex_col()
        .child(header)
        .children(body)
        .into_any_element()
}
