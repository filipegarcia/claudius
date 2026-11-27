//! [`CommandPaletteView`]: `CommandPalette.tsx` on screen, in the
//! [`Overlay`] frame (680 wide): the search box (focused as it opens),
//! the result rows and "No matches.". ↑ / ↓ move the selection, Enter
//! activates it, a hovered row is selected, a clicked one activated. The
//! host (the app's shell) opens and closes it and follows its
//! [`PaletteEvent`]s.

use std::rc::Rc;

use claudius_gpui_theme::ThemeName;
use gpui_kit::component::input::{Input, InputEvent, InputState};
use gpui_kit::prelude::FluentBuilder as _;
use gpui_kit::{
    AnyElement, AppContext as _, Context, Entity, EventEmitter, FocusHandle, Focusable as _,
    FontWeight, InteractiveElement as _, IntoElement, ParentElement as _, Render, SharedString,
    StatefulInteractiveElement as _, Styled as _, Subscription, Window, div, px,
};

use super::frame::Overlay;
use super::style::{Colors, a, h, icon, tagged};
use crate::frame::FrameProps;
use crate::palette::{Activation, Item, ItemKind, NO_MATCHES, PLACEHOLDER, Palette, PaletteKey};

gpui_kit::actions!(command_palette, [SelectNext, SelectPrev]);

/// The palette's key context (its arrows).
pub const CONTEXT: &str = "CommandPalette";

/// `<Overlay title="Command palette" subtitle="Cmd+K" width={680}>`.
pub const TITLE: &str = "Command palette";
pub const SUBTITLE: &str = "Cmd+K";
pub const WIDTH: f32 = 680.;

/// What the palette asks of its host.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum PaletteEvent {
    /// Close it (Escape, the backdrop, the X, an informational row).
    Close,
    /// Close it and go to a page (`router.push(href)`).
    Navigate(String),
}

pub struct CommandPaletteView {
    model: Palette,
    colors: Colors,
    input: Entity<InputState>,
    _subs: Vec<Subscription>,
}

impl EventEmitter<PaletteEvent> for CommandPaletteView {}

impl CommandPaletteView {
    /// A palette as `togglePalette` opens it: an empty query, the first row
    /// selected, the search box focused.
    pub fn new(
        items: Vec<Item>,
        theme: ThemeName,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Self {
        let input = cx.new(|cx| InputState::new(window, cx).placeholder(PLACEHOLDER));
        let sub = cx.subscribe(
            &input,
            |this: &mut Self, input, ev: &InputEvent, cx| match ev {
                InputEvent::Change => {
                    let text = input.read(cx).value().to_string();
                    this.model.set_query(&text);
                    cx.notify();
                }
                InputEvent::PressEnter { .. } => this.key(PaletteKey::Enter, cx),
                _ => {}
            },
        );
        let focus = input.focus_handle(cx);
        window.focus(&focus, cx);
        CommandPaletteView {
            model: Palette::new(items),
            colors: Colors::of(theme),
            input,
            _subs: vec![sub],
        }
    }

    /// The palette colors it draws with (its theme's).
    pub fn colors(&self) -> Colors {
        self.colors
    }

    pub fn model(&self) -> &Palette {
        &self.model
    }

    /// The search box's focus.
    pub fn focus(&self, cx: &gpui_kit::App) -> FocusHandle {
        self.input.focus_handle(cx)
    }

    pub fn set_theme(&mut self, theme: ThemeName, cx: &mut Context<Self>) {
        let colors = Colors::of(theme);
        if colors != self.colors {
            self.colors = colors;
            cx.notify();
        }
    }

    /// Types into the search box (as the keyboard would).
    pub fn type_query(&mut self, text: &str, window: &mut Window, cx: &mut Context<Self>) {
        self.input
            .update(cx, |s, cx| s.set_value(text.to_owned(), window, cx));
        self.model.set_query(text);
        cx.notify();
    }

    /// A search-box key.
    pub fn key(&mut self, key: PaletteKey, cx: &mut Context<Self>) {
        if let Some(a) = self.model.key(key) {
            self.activate(a, cx);
        }
        cx.notify();
    }

    fn activate(&mut self, a: Activation, cx: &mut Context<Self>) {
        cx.emit(match a {
            Activation::Close => PaletteEvent::Close,
            Activation::Navigate(href) => PaletteEvent::Navigate(href),
        });
    }

    pub fn close(&mut self, cx: &mut Context<Self>) {
        cx.emit(PaletteEvent::Close);
    }

    fn row(&self, i: usize, item: &Item, active: bool, cx: &mut Context<Self>) -> AnyElement {
        let c = self.colors;
        let name = match item.kind {
            ItemKind::Nav => "Navigation",
            ItemKind::Slash => "Terminal",
            ItemKind::Shortcut => "Keyboard",
        };
        tagged(SharedString::from(format!("command-palette-row-{i}")))
            .flex()
            .items_center()
            .gap(px(8.))
            .px(px(12.))
            .py(px(8.))
            .text_size(px(14.))
            .line_height(px(20.))
            .cursor_pointer()
            .when(active, |d| {
                d.bg(a(c.accent, 12.)).text_color(h(c.foreground))
            })
            .when(!active, |d| {
                d.text_color(a(c.foreground, 90.))
                    .hover(|d| d.bg(h(c.panel_2)))
            })
            .on_hover(cx.listener(move |this, hovered: &bool, _, cx| {
                if *hovered && this.model.active() != i as i64 {
                    this.model.hover(i);
                    cx.notify();
                }
            }))
            .on_click(cx.listener(move |this, _, _, cx| {
                if let Some(a) = this.model.click(i) {
                    this.activate(a, cx);
                }
            }))
            .children(icon(name, 14., h(c.muted)).map(|i| i.flex_none()))
            .child(
                div()
                    .min_w_0()
                    .truncate()
                    .font_weight(FontWeight::MEDIUM)
                    .child(item.label.clone()),
            )
            .when_some(item.detail.clone(), |d, detail| {
                d.child(
                    div()
                        .ml_auto()
                        .min_w_0()
                        .truncate()
                        .text_size(px(11.))
                        .line_height(px(16.))
                        .text_color(h(c.muted))
                        .child(detail),
                )
            })
            .when(item.href.is_some() && active, |d| {
                d.children(icon("ArrowRight", 12., h(c.muted)).map(|i| i.flex_none().ml(px(4.))))
            })
            .into_any_element()
    }
}

impl Render for CommandPaletteView {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let c = self.colors;
        let vh = f32::from(window.viewport_size().height);
        let active = self.model.active();
        let rows: Vec<AnyElement> = if self.model.rows().is_empty() {
            vec![
                div()
                    .debug_selector(|| "command-palette-empty".into())
                    .px(px(16.))
                    .py(px(24.))
                    .flex()
                    .justify_center()
                    .text_size(px(12.))
                    .line_height(px(16.))
                    .text_color(h(c.muted))
                    .child(NO_MATCHES)
                    .into_any_element(),
            ]
        } else {
            let items: Vec<Item> = self.model.rows().to_vec();
            items
                .iter()
                .enumerate()
                .map(|(i, it)| self.row(i, it, i as i64 == active, cx))
                .collect()
        };
        let search = div()
            .flex()
            .flex_none()
            .items_center()
            .gap(px(8.))
            .border_b_1()
            .border_color(h(c.border))
            .px(px(12.))
            .py(px(10.))
            .children(icon("Search", 16., h(c.muted)).map(|i| i.flex_none()))
            .child(
                div()
                    .debug_selector(|| "command-palette-input".into())
                    .flex_1()
                    .min_w_0()
                    .child(Input::new(&self.input).appearance(false).text_size(px(14.))),
            )
            .child(
                div()
                    .flex_none()
                    .rounded(px(4.))
                    .border_1()
                    .border_color(h(c.border))
                    .bg(h(c.panel_2))
                    .px(px(6.))
                    .py(px(2.))
                    .text_size(px(10.))
                    .line_height(px(12.))
                    .text_color(h(c.muted))
                    .child("ESC"),
            );
        let results = tagged("command-palette-results")
            .max_h(px(vh * 0.6))
            .overflow_y_scroll()
            .py(px(4.))
            .flex()
            .flex_col()
            .children(rows);
        let this = cx.entity().downgrade();
        let on_close = Rc::new(move |_: &mut Window, cx: &mut gpui_kit::App| {
            this.update(cx, |v, cx| v.close(cx)).ok();
        });
        Overlay::new(
            "command-palette",
            FrameProps::with_width(WIDTH),
            c,
            on_close,
        )
        .title(TITLE)
        .subtitle(SUBTITLE)
        .child(
            div()
                .key_context(CONTEXT)
                .flex()
                .flex_col()
                .min_h_0()
                .on_action(
                    cx.listener(|this, _: &SelectNext, _, cx| this.key(PaletteKey::Down, cx)),
                )
                .on_action(cx.listener(|this, _: &SelectPrev, _, cx| this.key(PaletteKey::Up, cx)))
                .child(search)
                .child(results),
        )
        .render(window, cx)
    }
}
