//! The overlays' colors and the few helpers they share, after the React
//! components' Tailwind classes (`bg-[var(--panel)]`, `text-[11px]`, …).

use claudius_gpui_theme::{ThemeName, hsla, icons};
use claudius_theme::{Rgba, Theme as Tokens, color, tailwind};
use gpui_kit::component::Icon;
use gpui_kit::{Div, Hsla, InteractiveElement as _, SharedString, Stateful, Styled as _, div, px};

/// The palette colors the overlays use.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Colors {
    pub foreground: Rgba,
    pub panel: Rgba,
    pub panel_2: Rgba,
    pub border: Rgba,
    pub muted: Rgba,
    pub accent: Rgba,
    pub dark: bool,
}

impl Colors {
    pub fn of(theme: ThemeName) -> Colors {
        let p = Tokens::of(theme).palette;
        Colors {
            foreground: p.foreground,
            panel: p.panel,
            panel_2: p.panel_2,
            border: p.border,
            muted: p.muted,
            accent: p.accent,
            dark: theme.is_dark(),
        }
    }
}

/// A palette color.
pub fn h(c: Rgba) -> Hsla {
    hsla(c)
}

/// Tailwind's `/N` on a color.
pub fn a(c: Rgba, pct: f64) -> Hsla {
    hsla(color::with_opacity(c, pct))
}

/// A Tailwind step (`emerald-400`).
pub fn step(name: &str) -> Rgba {
    tailwind::color(name).unwrap_or_else(|| panic!("{name} is a Tailwind step"))
}

pub fn icon(name: &str, size: f32, color: Hsla) -> Option<Icon> {
    icons::icon(name).map(|i| Icon::new(i).size(px(size)).text_color(color))
}

/// An element with an id and a test selector.
pub fn tagged(id: impl Into<SharedString>) -> Stateful<Div> {
    let id: SharedString = id.into();
    let sel = id.to_string();
    div().id(id).debug_selector(move || sel)
}
