//! The palette the rail and the banner draw with, and the small element
//! builders they share: a [`Look`]'s / an [`Ink`]'s colors against the
//! theme's tokens, the icons by their lucide-react name, the debug
//! selectors the tests find elements by, the tooltips.

use claudius_gpui_theme::{ThemeName, hsla, icons};
use claudius_theme::{Rgba, Theme as Tokens, color, tailwind};
use gpui_kit::component::Icon;
use gpui_kit::component::tooltip::Tooltip;
use gpui_kit::{AnyView, App, Div, ElementId, Hsla, SharedString, Styled as _, Window, div, px};

use crate::look::{Ink, Look, Paint};

/// The theme's tokens the rail reads (`var(--…)`).
#[derive(Clone, Copy)]
pub struct Colors {
    pub foreground: Rgba,
    pub panel: Rgba,
    pub panel_2: Rgba,
    pub border: Rgba,
    pub muted: Rgba,
    pub accent: Rgba,
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
        }
    }

    fn rgba(&self, p: Paint) -> Rgba {
        match p {
            Paint::Border => self.border,
            Paint::Panel => self.panel,
            Paint::Panel2 => self.panel_2,
            Paint::Muted => self.muted,
            Paint::Foreground | Paint::Inherit => self.foreground,
            Paint::Accent => self.accent,
            Paint::Step(name) => step_rgba(name),
        }
    }

    /// An ink (`text-sky-300`, `bg-[var(--panel-2)]/40`).
    pub fn ink(&self, i: Ink) -> Hsla {
        a(self.rgba(i.paint), i.alpha)
    }

    /// A token at an opacity (Tailwind's `/N`).
    pub fn at(&self, p: Paint, pct: f64) -> Hsla {
        a(self.rgba(p), pct)
    }

    pub fn fg(&self) -> Hsla {
        hsla(self.foreground)
    }

    pub fn muted(&self) -> Hsla {
        hsla(self.muted)
    }

    pub fn border(&self) -> Hsla {
        hsla(self.border)
    }

    pub fn panel(&self) -> Hsla {
        hsla(self.panel)
    }

    pub fn accent(&self) -> Hsla {
        hsla(self.accent)
    }
}

fn step_rgba(name: &str) -> Rgba {
    tailwind::color(name).unwrap_or_else(|| panic!("{name} is a Tailwind step"))
}

/// A Tailwind step (`text-amber-300`).
pub fn step(name: &str) -> Hsla {
    hsla(step_rgba(name))
}

/// A Tailwind step at an opacity (`bg-amber-500/10`).
pub fn step_a(name: &str, pct: f64) -> Hsla {
    a(step_rgba(name), pct)
}

fn a(c: Rgba, pct: f64) -> Hsla {
    hsla(color::with_opacity(c, pct))
}

/// `rounded-md border px-2 py-1.5` in a look's colors.
pub fn boxed(c: &Colors, look: Look) -> Div {
    div()
        .rounded(px(6.))
        .border_1()
        .border_color(c.ink(look.border))
        .bg(c.ink(look.bg))
        .text_color(c.ink(look.text))
}

pub fn icon(name: &str, size: f32, color: Hsla) -> Option<Icon> {
    icons::icon(name).map(|i| Icon::new(i).size(px(size)).text_color(color))
}

pub fn sel(name: impl Into<String>) -> impl Fn() -> String + 'static {
    let name = name.into();
    move || name.clone()
}

pub fn id(name: impl Into<String>) -> ElementId {
    ElementId::Name(SharedString::from(name.into()))
}

pub fn tip(text: impl Into<String>) -> impl Fn(&mut Window, &mut App) -> AnyView {
    let text = text.into();
    move |window, cx| Tooltip::new(text.clone()).build(window, cx)
}

/// CSS `text-transform: uppercase` (the section labels).
pub fn upper(s: &str) -> String {
    s.to_uppercase()
}
