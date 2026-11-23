//! A window with the theme for a manual look: the seven palettes (click one
//! to apply it), the main `ThemeColor` fields, the chart series, a
//! highlighted code block and the React UI's icons.
//!
//! `cargo run --example swatches` (from rust/app). Not run by the tests.

use claudius_gpui_theme::{ThemeName, apply, chart_series, density, icons};
use gpui_kit::{
    App, Context, Hsla, IntoElement, ParentElement, Render, SharedString, Styled, Window,
    WindowOptions, component::ActiveTheme, component::Icon, component::text::TextView, div,
    prelude::*, px,
};

const CODE: &str = "```rust\n/// A palette.\nfn mode(name: ThemeName) -> ThemeMode {\n    if name.is_dark() { ThemeMode::Dark } else { ThemeMode::Light }\n}\nlet n = 42; // \"answer\"\n```\n\n```ts\nexport function highlight(code: string): Promise<string> {\n  return getHighlighter().then((hl) => hl.codeToHtml(code, { theme: \"github-dark-default\" }));\n}\n```";

struct Swatches;

fn swatch(label: &'static str, color: Hsla, cx: &App) -> impl IntoElement {
    div()
        .flex()
        .flex_col()
        .gap(density::spacing(1.0))
        .child(
            div()
                .size(px(48.))
                .rounded(px(6.))
                .border_1()
                .border_color(cx.theme().border)
                .bg(color),
        )
        .child(
            div()
                .text_xs()
                .text_color(cx.theme().muted_foreground)
                .child(label),
        )
}

impl Render for Swatches {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let t = cx.theme().clone();
        let current: SharedString = t.theme_name().clone();
        let palettes = ThemeName::ALL.into_iter().map(|name| {
            let selected = current.as_ref() == name.label();
            div()
                .id(name.id())
                .px(density::spacing(3.0))
                .py(density::spacing(1.5))
                .rounded(t.radius)
                .when(selected, |d| {
                    d.bg(t.primary).text_color(t.primary_foreground)
                })
                .when(!selected, |d| d.hover(|d| d.bg(t.list_hover)))
                .child(name.label())
                .on_click(move |_, _, cx| apply(name, cx))
        });
        let fields = [
            ("background", t.background),
            ("foreground", t.foreground),
            ("popover", t.popover),
            ("accent", t.accent),
            ("border", t.border),
            ("muted_fg", t.muted_foreground),
            ("primary", t.primary),
            ("danger", t.danger),
            ("success", t.success),
            ("warning", t.warning),
            ("selection", t.selection),
        ];
        let name = ThemeName::ALL
            .into_iter()
            .find(|n| n.label() == current.as_ref())
            .unwrap_or(ThemeName::DEFAULT);
        let series = chart_series(name);
        div()
            .id("root")
            .size_full()
            .overflow_y_scroll()
            .bg(t.background)
            .text_color(t.foreground)
            .p(density::spacing(4.0))
            .flex()
            .flex_col()
            .gap(density::spacing(4.0))
            .child(div().flex().gap(density::spacing(2.0)).children(palettes))
            .child(
                div()
                    .flex()
                    .flex_wrap()
                    .gap(density::spacing(3.0))
                    .children(fields.map(|(l, c)| swatch(l, c, cx))),
            )
            .child(
                div().flex().gap(density::spacing(3.0)).children(
                    ["s1", "s2", "s3", "s4", "s5", "s6", "other"]
                        .into_iter()
                        .zip(series)
                        .map(|(l, c)| swatch(l, c, cx)),
                ),
            )
            .child(
                div()
                    .max_w(px(720.))
                    .child(TextView::markdown("code", CODE)),
            )
            .child(
                div()
                    .flex()
                    .flex_wrap()
                    .gap(density::spacing(2.0))
                    .text_color(t.muted_foreground)
                    .children(icons::ICONS.map(|(_, icon)| Icon::new(icon).size(px(16.)))),
            )
    }
}

fn main() {
    gpui_kit::application()
        .with_assets(icons::IconAssets)
        .run(|cx| {
            gpui_kit::init(cx);
            claudius_gpui_theme::init(ThemeName::DEFAULT, cx);
            gpui_kit::open_window(WindowOptions::default(), cx, |_, cx| cx.new(|_| Swatches))
                .expect("failed to open window");
            cx.activate(true);
        });
}
