//! [`Overlay`]: the frame every overlay sits in (`Overlay.tsx`): the
//! full-window layer (dimmed, or click-through without a backdrop), the
//! panel hanging 8vh down, its header (the subtitle over the title, the
//! minimize and close buttons) and the scrolling body.
//!
//! Escape closes through the layer's key context ([`Dismiss`], bound in
//! [`CONTEXT`]): give the frame the focus handle of what it shows
//! ([`Overlay::track_focus`]) or focus a field in its body, so the key
//! reaches it. A click on the dimmed layer closes; a click on the panel
//! doesn't. The rules are [`crate::frame`]'s.
//!
//! Not drawn: the backdrop's blur (`backdrop-blur-sm`: GPUI has no
//! backdrop filter) and the `draggable` header (its clamp and drag rules
//! are ported in [`crate::frame`]; no overlay here is draggable yet).

use std::rc::Rc;

use gpui_kit::prelude::FluentBuilder as _;
use gpui_kit::{
    AnyElement, App, FocusHandle, FontWeight, InteractiveElement as _, IntoElement,
    ParentElement as _, SharedString, StatefulInteractiveElement as _, Styled as _, Window, div,
    px,
};

use super::style::{Colors, h, icon, tagged};
use crate::frame::{FrameProps, SIDE_PADDING, top_offset};

gpui_kit::actions!(overlay, [Dismiss]);

/// The key context of the frame's layer.
pub const CONTEXT: &str = "ClaudiusOverlay";

/// A frame callback (close, minimize).
pub type Handler = Rc<dyn Fn(&mut Window, &mut App)>;

/// An overlay's frame, built per render: `Overlay::new(…).title(…)
/// .child(…).render(window, cx)`.
pub struct Overlay {
    id: SharedString,
    props: FrameProps,
    colors: Colors,
    title: Option<AnyElement>,
    subtitle: Option<SharedString>,
    on_close: Handler,
    on_minimize: Option<Handler>,
    focus: Option<FocusHandle>,
    children: Vec<AnyElement>,
}

impl Overlay {
    /// A frame whose elements' test selectors start with `id` (the panel is
    /// `id`, the layer `{id}-backdrop`, the close button `{id}-close`).
    pub fn new(
        id: impl Into<SharedString>,
        props: FrameProps,
        colors: Colors,
        on_close: Handler,
    ) -> Self {
        Overlay {
            id: id.into(),
            props,
            colors,
            title: None,
            subtitle: None,
            on_close,
            on_minimize: None,
            focus: None,
            children: Vec::new(),
        }
    }

    pub fn title(mut self, title: impl IntoElement) -> Self {
        self.title = Some(title.into_any_element());
        self
    }

    /// The line over the title; "Claudius" when none is given
    /// (Overlay.tsx:167, `subtitle ?? "Claudius"`). Drawn upper-cased.
    pub fn subtitle(mut self, subtitle: impl Into<SharedString>) -> Self {
        self.subtitle = Some(subtitle.into());
        self
    }

    /// `onMinimize`: the header's minimize button.
    pub fn on_minimize(mut self, f: Handler) -> Self {
        self.on_minimize = Some(f);
        self.props.minimizable = true;
        self
    }

    /// The focus the panel tracks, so Escape reaches the frame while
    /// nothing inside it has focus.
    pub fn track_focus(mut self, focus: &FocusHandle) -> Self {
        self.focus = Some(focus.clone());
        self
    }

    pub fn child(mut self, child: impl IntoElement) -> Self {
        self.children.push(child.into_any_element());
        self
    }

    pub fn render(self, window: &mut Window, _cx: &mut App) -> AnyElement {
        let Overlay {
            id,
            props,
            colors: c,
            title,
            subtitle,
            on_close,
            on_minimize,
            focus,
            children,
        } = self;
        let vp = window.viewport_size();
        let (vw, vh) = (f32::from(vp.width), f32::from(vp.height));
        let button = |name: &'static str, sel: String, f: Handler| {
            tagged(sel)
                .flex_none()
                .rounded(px(4.))
                .p(px(4.))
                .cursor_pointer()
                .hover(|d| d.bg(h(c.panel_2)))
                .children(icon(name, 16., h(c.muted)))
                .on_click(move |_, window, cx| {
                    cx.stop_propagation();
                    f(window, cx)
                })
        };
        let subtitle = caps(subtitle.as_deref().unwrap_or("Claudius"));
        let header = div()
            .flex()
            .flex_none()
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
                    .child(
                        div()
                            .debug_selector({
                                let id = id.clone();
                                move || format!("{id}-subtitle")
                            })
                            .text_size(px(11.))
                            .line_height(px(16.))
                            .text_color(h(c.muted))
                            .child(subtitle),
                    )
                    .child(
                        div()
                            .debug_selector({
                                let id = id.clone();
                                move || format!("{id}-title")
                            })
                            .mt(px(2.))
                            .text_size(px(14.))
                            .line_height(px(20.))
                            .font_weight(FontWeight::MEDIUM)
                            .children(title),
                    ),
            )
            .when_some(on_minimize, |d, f| {
                // `title="Minimize"`: the close button has no tooltip.
                d.child(
                    button("Minus", format!("{id}-minimize"), f).tooltip(|window, cx| {
                        gpui_kit::component::tooltip::Tooltip::new("Minimize").build(window, cx)
                    }),
                )
            })
            .child(button("X", format!("{id}-close"), on_close.clone()));
        let panel = tagged(id.clone())
            .w(px(props.panel_width(vw)))
            .max_h(px(props.max_height(vh)))
            .flex()
            .flex_col()
            .overflow_hidden()
            .rounded(px(12.))
            .border_1()
            .border_color(h(c.border))
            .bg(h(c.panel))
            .text_color(h(c.foreground))
            .shadow_2xl()
            // A click on the panel stays on the panel (`stopPropagation`):
            // it occludes the layer under it.
            .occlude()
            .when_some(focus, |d, f| d.track_focus(&f))
            .child(header)
            .child(
                tagged(format!("{id}-body"))
                    .flex()
                    .flex_col()
                    .min_h_0()
                    .flex_1()
                    .overflow_y_scroll()
                    .children(children),
            );
        let escape = on_close.clone();
        tagged(format!("{id}-backdrop"))
            .key_context(CONTEXT)
            .absolute()
            .top_0()
            .left_0()
            .size_full()
            .flex()
            .flex_col()
            .items_center()
            .pt(px(top_offset(vh)))
            .px(px(SIDE_PADDING))
            .on_action(move |_: &Dismiss, window, cx| {
                if props.escape_closes() {
                    escape(window, cx);
                } else {
                    cx.propagate();
                }
            })
            .when(props.layer_takes_pointer(), |d| {
                d.bg(gpui_kit::black().opacity(0.6)).occlude()
            })
            .when(props.backdrop_click_closes(), |d| {
                d.on_click(move |_, window, cx| on_close(window, cx))
            })
            .child(panel)
            .into_any_element()
    }
}

/// The header's subtitle as the TS draws it: `uppercase` text.
pub fn caps(text: &str) -> SharedString {
    text.to_uppercase().into()
}
