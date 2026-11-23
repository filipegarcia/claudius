//! The native UI's gpui-component theme, built from `claudius-theme` (U03b).
//!
//! - [`colors`]: every `ThemeColor` field and the React token (or the
//!   derivation from tokens) it comes from.
//! - [`theme_config`]: one `data-theme` palette as a gpui-component theme
//!   file (`ThemeConfig`): the colors, the code highlighting ([`code`]), the
//!   type size and radii ([`density`]).
//! - [`apply`] installs a palette at run time: it registers the config for
//!   its mode (the seven palettes split four dark, three light, as
//!   `ThemeName::is_dark`) and switches to it. After that, gpui-component's
//!   own `Theme::change(mode)` switches between the last light and the last
//!   dark palette applied; [`init`] registers `light` and `dark` first.
//! - [`icons`]: the React UI's lucide-react icons as GPUI Kit icons, with
//!   lucide-react's own drawings of the five Lucide redrew since.
//! - [`fonts`]: the React UI's Geist and Geist Mono, bundled (macOS has
//!   neither). [`init`] adds them to the text system, and every theme file
//!   names them (`font.family`, `mono_font.family`); code text turns
//!   ligatures off with [`fonts::code_style`].

pub mod code;
pub mod colors;
pub mod density;
pub mod fonts;
pub mod icons;

use std::rc::Rc;

pub use claudius_theme::ThemeName;
use claudius_theme::{Rgba, Theme as Tokens};
use gpui_kit::{
    App, Hsla,
    component::{Theme, ThemeConfig, ThemeMode},
};
use serde_json::{Map, Value, json};

/// gpui-component's mode for a palette.
pub fn mode(name: ThemeName) -> ThemeMode {
    if name.is_dark() {
        ThemeMode::Dark
    } else {
        ThemeMode::Light
    }
}

/// A `claudius-theme` color as GPUI's, from the 8-bit sRGB Chromium paints
/// (the theme file's precision too).
pub fn hsla(c: Rgba) -> Hsla {
    let [r, g, b, a] = c.to_rgba8();
    gpui_kit::Rgba {
        r: f32::from(r) / 255.,
        g: f32::from(g) / 255.,
        b: f32::from(b) / 255.,
        a: f32::from(a) / 255.,
    }
    .into()
}

/// The theme file for a palette, as JSON (`ThemeConfig`'s serde form),
/// without the code highlighting.
pub fn theme_json(name: ThemeName) -> Value {
    let tokens = Tokens::of(name);
    let mut colors = Map::new();
    for c in &colors::COLORS {
        colors.insert(c.key.into(), colors::hex(c.source.resolve(&tokens)).into());
    }
    json!({
        "name": name.label(),
        "mode": mode(name).name(),
        "font.family": fonts::SANS,
        "font.size": density::FONT_SIZE,
        "mono_font.family": fonts::MONO,
        "mono_font.size": density::MONO_FONT_SIZE,
        "radius": density::radius_px(density::RADIUS),
        "radius.lg": density::radius_px(density::RADIUS_LG),
        "colors": colors,
    })
}

/// The gpui-component theme file for a palette, with the code highlighting
/// ([`code::highlight_style`]).
pub fn theme_config(name: ThemeName) -> ThemeConfig {
    let mut config: ThemeConfig =
        serde_json::from_value(theme_json(name)).expect("the theme table is a valid theme file");
    config.highlight = Some(code::highlight_style());
    config
}

/// Installs a palette in the running app and refreshes every window.
///
/// The theme file caps `selection` at 30% alpha, under `::selection`'s 35%
/// (synthwave 40%), so the exact color is set again after the config.
/// Plain `Theme::change` reloads the file and shows the capped value.
pub fn apply(name: ThemeName, cx: &mut App) {
    let config = Rc::new(theme_config(name));
    let selection = hsla(Tokens::of(name).selection);
    Theme::update(cx, |theme| {
        theme.apply_config(&config);
        theme.selection = selection;
    });
}

/// Adds the bundled fonts ([`fonts::load`]), registers `light` and `dark`
/// as the two modes' palettes, then applies `name` (the user's saved
/// `data-theme`, `ThemeName::DEFAULT` when none). Call after
/// `gpui_kit::init`.
///
/// # Panics
///
/// If the text system rejects the bundled fonts (a corrupt build).
pub fn init(name: ThemeName, cx: &mut App) {
    fonts::load(cx).expect("the bundled Geist fonts load");
    let light = Rc::new(theme_config(ThemeName::Light));
    let dark = Rc::new(theme_config(ThemeName::Dark));
    Theme::update(cx, |theme| {
        theme.light_theme = light;
        theme.dark_theme = dark;
    });
    apply(name, cx);
}

/// The palette's seven chart colors (`--series-1` … `--series-6`,
/// `--series-other`). `ThemeColor` has room for five (`chart_1` …
/// `chart_5`); charts with more series read these.
pub fn chart_series(name: ThemeName) -> [Hsla; 7] {
    let p = Tokens::of(name).palette;
    let s = p.series;
    [s[0], s[1], s[2], s[3], s[4], s[5], p.series_other].map(hsla)
}
