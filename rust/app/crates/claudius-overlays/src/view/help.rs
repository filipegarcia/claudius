//! [`HelpOverlayView`]: `HelpOverlay.tsx` on screen, in the [`Overlay`]
//! frame (760 wide): the filter box (focused as it opens), the usage card
//! a topic opens on, the categories' sections in two columns (one under
//! 768px, `md:grid-cols-2`) and the handler legend. The same layout shows
//! the keyboard cheatsheet ([`HelpContent::Shortcuts`]): each shortcut's
//! label, chord and description, by `ShortcutsSection`'s categories.

use std::rc::Rc;

use claudius_gpui_theme::{ThemeName, fonts};
use gpui_kit::component::input::{Input, InputEvent, InputState};
use gpui_kit::prelude::FluentBuilder as _;
use gpui_kit::{
    AnyElement, App, AppContext as _, Context, Entity, EventEmitter, FocusHandle, Focusable as _,
    FontWeight, InteractiveElement as _, IntoElement, ParentElement as _, Render, SharedString,
    StatefulInteractiveElement as _, Styled as _, Subscription, Window, div, px,
};

use super::frame::{Overlay, caps};
use super::style::{Colors, a, h, icon, step, tagged};
use crate::ShortcutRow;
use crate::frame::FrameProps;
use crate::help::{
    CHEATSHEET_PLACEHOLDER, CHEATSHEET_TITLE, CheatsheetModel, HELP_LEGEND, HELP_PLACEHOLDER,
    HELP_TITLE, HelpModel, TopicCard, chord_text,
};
use crate::slash::{Handler, SdkCommandInfo, SlashSuggestion};

/// `<Overlay … width={760}>`.
pub const WIDTH: f32 = 760.;

/// Tailwind's `md` breakpoint: two columns from here.
const MD: f32 = 768.;

/// What the overlay lists.
#[derive(Clone, Debug)]
pub enum HelpContent {
    /// The slash commands (`HelpOverlay`).
    Commands(HelpModel),
    /// The keyboard shortcuts (the cheatsheet).
    Shortcuts(CheatsheetModel),
}

/// What the overlay asks of its host.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum HelpEvent {
    Close,
}

pub struct HelpOverlayView {
    content: HelpContent,
    colors: Colors,
    input: Entity<InputState>,
    _subs: Vec<Subscription>,
}

impl EventEmitter<HelpEvent> for HelpOverlayView {}

impl HelpOverlayView {
    /// The overlay over `content`, its filter box focused (`autoFocus`)
    /// and holding the content's filter (the topic it opens on).
    pub fn new(
        content: HelpContent,
        theme: ThemeName,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Self {
        let (start, placeholder) = match &content {
            HelpContent::Commands(m) => (m.filter().to_owned(), HELP_PLACEHOLDER),
            HelpContent::Shortcuts(m) => (m.filter().to_owned(), CHEATSHEET_PLACEHOLDER),
        };
        let input = cx.new(|cx| {
            InputState::new(window, cx)
                .placeholder(placeholder)
                .default_value(start)
        });
        let sub = cx.subscribe(&input, |this: &mut Self, input, ev: &InputEvent, cx| {
            if let InputEvent::Change = ev {
                let text = input.read(cx).value().to_string();
                this.set_filter(&text, cx);
            }
        });
        let focus = input.focus_handle(cx);
        window.focus(&focus, cx);
        HelpOverlayView {
            content,
            colors: Colors::of(theme),
            input,
            _subs: vec![sub],
        }
    }

    /// The palette colors it draws with (its theme's).
    pub fn colors(&self) -> Colors {
        self.colors
    }

    pub fn content(&self) -> &HelpContent {
        &self.content
    }

    /// The filter box's focus.
    pub fn focus(&self, cx: &App) -> FocusHandle {
        self.input.focus_handle(cx)
    }

    pub fn set_theme(&mut self, theme: ThemeName, cx: &mut Context<Self>) {
        let colors = Colors::of(theme);
        if colors != self.colors {
            self.colors = colors;
            cx.notify();
        }
    }

    /// The session's rich command list arrived (`useSdkCommands`).
    pub fn set_rich_commands(&mut self, rich: Option<Vec<SdkCommandInfo>>, cx: &mut Context<Self>) {
        if let HelpContent::Commands(m) = &mut self.content {
            m.set_rich(rich);
            cx.notify();
        }
    }

    fn set_filter(&mut self, text: &str, cx: &mut Context<Self>) {
        let changed = match &mut self.content {
            HelpContent::Commands(m) if m.filter() != text => {
                m.set_filter(text);
                true
            }
            HelpContent::Shortcuts(m) if m.filter() != text => {
                m.set_filter(text);
                true
            }
            _ => false,
        };
        if changed {
            cx.notify();
        }
    }

    /// Types into the filter box (as the keyboard would).
    pub fn type_filter(&mut self, text: &str, window: &mut Window, cx: &mut Context<Self>) {
        self.input
            .update(cx, |s, cx| s.set_value(text.to_owned(), window, cx));
        self.set_filter(text, cx);
    }

    pub fn close(&mut self, cx: &mut Context<Self>) {
        cx.emit(HelpEvent::Close);
    }

    fn section(&self, sel: String, heading: String, items: Vec<AnyElement>) -> AnyElement {
        let c = self.colors;
        tagged(SharedString::from(sel))
            .flex()
            .flex_col()
            .child(
                div()
                    .mb(px(8.))
                    .text_size(px(10.))
                    .line_height(px(14.))
                    .font_weight(FontWeight::MEDIUM)
                    .text_color(h(c.muted))
                    .child(caps(&heading)),
            )
            .child(div().flex().flex_col().gap(px(6.)).children(items))
            .into_any_element()
    }

    fn item_box(&self) -> gpui_kit::Div {
        let c = self.colors;
        div()
            .rounded(px(6.))
            .border_1()
            .border_color(h(c.border))
            .bg(a(c.panel, 40.))
            .px(px(12.))
            .py(px(6.))
    }

    fn command(&self, cmd: &SlashSuggestion) -> AnyElement {
        let c = self.colors;
        let badge = match cmd.handler {
            Handler::Native => h(step("emerald-400")),
            Handler::Sdk => h(step("sky-400")),
            Handler::External => h(c.muted),
        };
        self.item_box()
            .debug_selector({
                let id = cmd.id.clone();
                move || format!("help-command-{id}")
            })
            .child(
                div()
                    .flex()
                    .items_baseline()
                    .justify_between()
                    .gap(px(8.))
                    .child(
                        div()
                            .flex()
                            .min_w_0()
                            .font_family(fonts::MONO)
                            .text_size(px(12.))
                            .line_height(px(16.))
                            .child(div().text_color(h(c.accent)).child("/"))
                            .child(cmd.name.clone())
                            .when_some(cmd.args_hint.clone(), |d, hint| {
                                d.child(div().text_color(h(c.muted)).child(format!(" {hint}")))
                            }),
                    )
                    .child(
                        div()
                            .flex_none()
                            .text_size(px(9.))
                            .line_height(px(12.))
                            .text_color(badge)
                            .child(caps(cmd.handler.id())),
                    ),
            )
            .child(
                div()
                    .mt(px(2.))
                    .text_size(px(11.))
                    .line_height(px(16.))
                    .text_color(h(c.muted))
                    .child(cmd.description.clone()),
            )
            .into_any_element()
    }

    fn shortcut(&self, row: &ShortcutRow) -> AnyElement {
        let c = self.colors;
        self.item_box()
            .debug_selector({
                let id = row.id.clone();
                move || format!("help-shortcut-{id}")
            })
            .child(
                div()
                    .flex()
                    .items_baseline()
                    .justify_between()
                    .gap(px(8.))
                    .child(
                        div()
                            .min_w_0()
                            .truncate()
                            .text_size(px(12.))
                            .line_height(px(16.))
                            .font_weight(FontWeight::MEDIUM)
                            .child(row.label.clone()),
                    )
                    .child(
                        div()
                            .flex_none()
                            .rounded(px(4.))
                            .border_1()
                            .border_color(h(c.border))
                            .bg(h(c.panel_2))
                            .px(px(6.))
                            .font_family(fonts::MONO)
                            .text_size(px(11.))
                            .line_height(px(16.))
                            .text_color(h(c.foreground))
                            .child(chord_text(row).to_owned()),
                    ),
            )
            .when_some(row.description.clone(), |d, desc| {
                d.child(
                    div()
                        .mt(px(2.))
                        .text_size(px(11.))
                        .line_height(px(16.))
                        .text_color(h(c.muted))
                        .child(desc),
                )
            })
            .into_any_element()
    }

    fn card(&self, card: TopicCard) -> AnyElement {
        let c = self.colors;
        match card {
            TopicCard::Missing { topic } => div()
                .debug_selector(|| "help-usage-missing".into())
                .mb(px(12.))
                .flex()
                .flex_wrap()
                .rounded(px(6.))
                .border_1()
                .border_color(h(c.border))
                .bg(a(c.panel_2, 40.))
                .px(px(12.))
                .py(px(8.))
                .text_size(px(12.))
                .line_height(px(16.))
                .text_color(h(c.muted))
                .child("No command named\u{a0}")
                .child(
                    div()
                        .font_family(fonts::MONO)
                        .text_color(h(c.foreground))
                        .child(format!("/{topic}")),
                )
                .child(".")
                .into_any_element(),
            TopicCard::Usage {
                usage,
                description,
                aliases,
            } => div()
                .debug_selector(|| "help-usage".into())
                .mb(px(12.))
                .rounded(px(6.))
                .border_1()
                .border_color(a(c.accent, 40.))
                .bg(a(c.accent, 5.))
                .px(px(12.))
                .py(px(8.))
                .child(
                    div()
                        .text_size(px(10.))
                        .line_height(px(14.))
                        .font_weight(FontWeight::MEDIUM)
                        .text_color(h(c.muted))
                        .child("USAGE"),
                )
                .child(
                    div()
                        .debug_selector(|| "help-usage-line".into())
                        .mt(px(2.))
                        .font_family(fonts::MONO)
                        .text_size(px(14.))
                        .line_height(px(20.))
                        .child(usage),
                )
                .child(
                    div()
                        .mt(px(4.))
                        .text_size(px(12.))
                        .line_height(px(16.))
                        .text_color(h(c.muted))
                        .child(description),
                )
                .when(!aliases.is_empty(), |d| {
                    let also: Vec<String> = aliases.iter().map(|a| format!("/{a}")).collect();
                    d.child(
                        div()
                            .mt(px(4.))
                            .text_size(px(11.))
                            .line_height(px(16.))
                            .text_color(h(c.muted))
                            .child(format!("Also: {}", also.join(", "))),
                    )
                })
                .into_any_element(),
        }
    }

    fn legend(&self) -> AnyElement {
        let c = self.colors;
        div()
            .debug_selector(|| "help-legend".into())
            .flex()
            .flex_none()
            .flex_wrap()
            .border_t_1()
            .border_color(h(c.border))
            .bg(a(c.panel_2, 40.))
            .px(px(16.))
            .py(px(8.))
            .text_size(px(11.))
            .line_height(px(16.))
            .text_color(h(c.muted))
            .children(HELP_LEGEND.iter().map(|(code, rest)| {
                div()
                    .flex()
                    .child(div().font_family(fonts::MONO).child(*code))
                    .child(div().whitespace_nowrap().child(*rest))
            }))
            .into_any_element()
    }
}

impl Render for HelpOverlayView {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let c = self.colors;
        let two = f32::from(window.viewport_size().width) >= MD;
        let (title, subtitle, card, sections) = match &self.content {
            HelpContent::Commands(m) => {
                let sections: Vec<AnyElement> = m
                    .groups()
                    .into_iter()
                    .map(|g| {
                        let items = g.commands.iter().map(|cmd| self.command(cmd)).collect();
                        self.section(format!("help-group-{}", g.category.id()), g.heading, items)
                    })
                    .collect();
                (
                    HELP_TITLE,
                    m.subtitle(),
                    m.card().map(|k| self.card(k)),
                    sections,
                )
            }
            HelpContent::Shortcuts(m) => {
                let sections: Vec<AnyElement> = m
                    .groups()
                    .into_iter()
                    .map(|g| {
                        let items = g.rows.iter().map(|r| self.shortcut(r)).collect();
                        self.section(format!("help-group-{}", g.category), g.heading, items)
                    })
                    .collect();
                (CHEATSHEET_TITLE, m.subtitle(), None, sections)
            }
        };
        let legend = matches!(self.content, HelpContent::Commands(_)).then(|| self.legend());
        let search = div()
            .flex()
            .flex_none()
            .items_center()
            .gap(px(8.))
            .border_b_1()
            .border_color(h(c.border))
            .bg(h(c.panel))
            .px(px(16.))
            .py(px(8.))
            .children(icon("Search", 14., h(c.muted)).map(|i| i.flex_none()))
            .child(
                div()
                    .debug_selector(|| "help-filter".into())
                    .flex_1()
                    .min_w_0()
                    .child(Input::new(&self.input).appearance(false).text_size(px(14.))),
            );
        let body = tagged("help-body")
            .flex_1()
            .min_h_0()
            .overflow_y_scroll()
            .flex()
            .flex_col()
            .child(
                div().px(px(16.)).py(px(12.)).children(card).child(
                    div()
                        .grid()
                        .grid_cols(if two { 2 } else { 1 })
                        .gap(px(16.))
                        .children(sections),
                ),
            )
            .children(legend);
        let this = cx.entity().downgrade();
        let on_close = Rc::new(move |_: &mut Window, cx: &mut App| {
            this.update(cx, |v, cx| v.close(cx)).ok();
        });
        Overlay::new("help-overlay", FrameProps::with_width(WIDTH), c, on_close)
            .title(title)
            .subtitle(subtitle)
            .child(
                div()
                    .flex()
                    .flex_col()
                    .flex_1()
                    .min_h_0()
                    .child(search)
                    .child(body),
            )
            .render(window, cx)
    }
}
