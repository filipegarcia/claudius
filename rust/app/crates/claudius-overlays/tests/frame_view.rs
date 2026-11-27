//! The shared [`Overlay`] frame on screen (U10a, reused by U10b's
//! overlays): the panel's place and size, Escape, the backdrop and panel
//! clicks, `dismissOnBackdrop`, `backdrop={false}` and the minimize button.
//! macOS (the CoreText text system).

#![cfg(target_os = "macos")]

use std::cell::Cell;
use std::rc::Rc;
use std::sync::Arc;

use claudius_gpui_theme::ThemeName;
use claudius_overlays::Overlay;
use claudius_overlays::frame::FrameProps;
use claudius_overlays::view::frame::caps;
use claudius_overlays::view::style::Colors;
use gpui::{
    Context, FocusHandle, InteractiveElement as _, IntoElement, Modifiers, ParentElement as _,
    Render, StatefulInteractiveElement as _, Styled as _, TestAppContext, TestDispatcher,
    VisualTestContext, Window, div, point, px, size,
};
use gpui_apple::AppleTextSystem;

#[derive(Default)]
struct Counts {
    closed: Cell<u32>,
    minimized: Cell<u32>,
    under: Cell<u32>,
}

/// A page with a button under the overlay's layer, and the overlay.
struct Host {
    props: FrameProps,
    minimizable: bool,
    focus: FocusHandle,
    counts: Rc<Counts>,
}

impl Render for Host {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let c = self.counts.clone();
        let mut overlay = Overlay::new(
            "frame",
            self.props,
            Colors::of(ThemeName::Dark),
            Rc::new(move |_, _| c.closed.set(c.closed.get() + 1)),
        )
        .title("Frame")
        .subtitle("Sub")
        .track_focus(&self.focus)
        .child(div().h(px(2000.)).child("Body"));
        if self.minimizable {
            let c = self.counts.clone();
            overlay =
                overlay.on_minimize(Rc::new(move |_, _| c.minimized.set(c.minimized.get() + 1)));
        }
        let c = self.counts.clone();
        div()
            .size_full()
            .child(
                div()
                    .id("under")
                    .debug_selector(|| "under".into())
                    .absolute()
                    .left(px(0.))
                    .bottom(px(0.))
                    .size(px(40.))
                    .on_click(move |_, _, _| c.under.set(c.under.get() + 1)),
            )
            .child(overlay.render(window, cx))
    }
}

fn open(
    app: &mut TestAppContext,
    props: FrameProps,
    minimizable: bool,
) -> (Rc<Counts>, &mut VisualTestContext) {
    app.update(|cx| {
        gpui_kit::init(cx);
        claudius_gpui_theme::init(ThemeName::Dark, cx);
        claudius_overlays::bind(cx);
    });
    let counts = Rc::new(Counts::default());
    let c = counts.clone();
    let (_, cx) = app.add_window_view(move |window, cx| {
        let focus = cx.focus_handle();
        window.focus(&focus, cx);
        Host {
            props,
            minimizable,
            focus,
            counts: c,
        }
    });
    cx.simulate_resize(size(px(1000.), px(800.)));
    settle(cx);
    (counts, cx)
}

fn settle(cx: &mut VisualTestContext) {
    for _ in 0..3 {
        cx.run_until_parked();
        cx.update(|window, cx| {
            window.refresh();
            window.draw(cx).clear(cx);
        });
    }
    cx.run_until_parked();
}

fn app() -> TestAppContext {
    TestAppContext::build_with_text_system(
        TestDispatcher::new(0),
        None,
        Arc::new(AppleTextSystem::new()),
    )
}

fn click(cx: &mut VisualTestContext, at: gpui::Point<gpui::Pixels>) {
    cx.simulate_click(at, Modifiers::none());
    settle(cx);
}

#[test]
fn the_panel_hangs_8vh_down_at_its_width_and_at_most_80vh_tall() {
    let mut app = app();
    let (_, cx) = open(&mut app, FrameProps::default(), false);
    let layer = cx.debug_bounds("frame-backdrop").expect("the layer");
    assert_eq!(layer.size, size(px(1000.), px(800.)));
    let panel = cx.debug_bounds("frame").expect("the panel");
    assert_eq!(panel.size.width, px(640.));
    assert_eq!(panel.top(), px(64.), "pt-[8vh]");
    assert_eq!(panel.size.height, px(640.), "maxHeight 80vh");
    assert_eq!(panel.center().x, px(500.), "centered");
    assert!(cx.debug_bounds("frame-title").is_some());
    assert!(cx.debug_bounds("frame-subtitle").is_some());
    assert!(cx.debug_bounds("frame-close").is_some());
    assert!(cx.debug_bounds("frame-body").is_some());
    // min(width, 92vw).
    cx.simulate_resize(size(px(500.), px(800.)));
    settle(cx);
    let panel = cx.debug_bounds("frame").expect("the panel");
    assert_eq!(panel.size.width, px(460.));
}

#[test]
fn escape_closes() {
    let mut app = app();
    let (counts, cx) = open(&mut app, FrameProps::default(), false);
    cx.simulate_keystrokes("escape");
    settle(cx);
    assert_eq!(counts.closed.get(), 1);
}

#[test]
fn a_backdrop_click_closes_and_a_panel_click_does_not() {
    let mut app = app();
    let (counts, cx) = open(&mut app, FrameProps::default(), false);
    let panel = cx.debug_bounds("frame").expect("the panel");
    click(cx, panel.center());
    assert_eq!(counts.closed.get(), 0);
    // The dimmed layer is modal: the page's button under it doesn't fire.
    let under = cx.debug_bounds("under").expect("the button");
    click(cx, under.center());
    assert_eq!(counts.closed.get(), 1);
    assert_eq!(counts.under.get(), 0);
    let x = cx.debug_bounds("frame-close").expect("the X");
    click(cx, x.center());
    assert_eq!(counts.closed.get(), 2);
}

#[test]
fn without_dismiss_on_backdrop_only_the_x_closes() {
    let mut app = app();
    let props = FrameProps {
        dismiss_on_backdrop: false,
        ..Default::default()
    };
    let (counts, cx) = open(&mut app, props, false);
    cx.simulate_keystrokes("escape");
    settle(cx);
    click(cx, point(px(4.), px(400.)));
    assert_eq!(counts.closed.get(), 0);
    let x = cx.debug_bounds("frame-close").expect("the X");
    click(cx, x.center());
    assert_eq!(counts.closed.get(), 1);
}

#[test]
fn without_a_backdrop_the_page_takes_the_clicks_around_the_panel() {
    let mut app = app();
    let props = FrameProps {
        backdrop: false,
        ..Default::default()
    };
    let (counts, cx) = open(&mut app, props, false);
    let under = cx.debug_bounds("under").expect("the button");
    click(cx, under.center());
    assert_eq!(counts.under.get(), 1);
    assert_eq!(counts.closed.get(), 0);
    // Escape still closes (`dismissOnBackdrop`).
    cx.simulate_keystrokes("escape");
    settle(cx);
    assert_eq!(counts.closed.get(), 1);
}

#[test]
fn the_minimize_button_comes_with_on_minimize() {
    let mut app = app();
    let (_, cx) = open(&mut app, FrameProps::default(), false);
    assert!(cx.debug_bounds("frame-minimize").is_none());
    let mut app = self::app();
    let (counts, cx) = open(&mut app, FrameProps::default(), true);
    let m = cx.debug_bounds("frame-minimize").expect("the button");
    let x = cx.debug_bounds("frame-close").expect("the X");
    assert!(m.right() <= x.left(), "minimize, then close");
    click(cx, m.center());
    assert_eq!(counts.minimized.get(), 1);
    assert_eq!(counts.closed.get(), 0);
}

#[test]
fn the_subtitle_is_upper_cased() {
    assert_eq!(caps("Cmd+K"), "CMD+K");
    assert_eq!(caps("Help · 86 commands"), "HELP · 86 COMMANDS");
}
