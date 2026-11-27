//! The cards' colors and the few controls they share (buttons, badges,
//! the modal backdrop), after the React cards' Tailwind classes.

use claudius_gpui_theme::{ThemeName, hsla, icons};
use claudius_theme::{Rgba, Theme as Tokens, color, tailwind};
use gpui_kit::component::Icon;
use gpui_kit::{
    Div, FontWeight, Hsla, InteractiveElement as _, ParentElement as _, SharedString, Stateful,
    Styled as _, div, px,
};

/// The palette colors the cards use.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Colors {
    pub background: Rgba,
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
            background: p.background,
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

/// The darker Tailwind v4 steps the light palettes take for the tints
/// (`theme.css`); claudius-theme lists only the steps the TS uses.
const LIGHT_STEPS: [(&str, &str); 5] = [
    ("amber-700", "oklch(55.5% 0.163 48.998)"),
    ("emerald-700", "oklch(50.8% 0.118 165.612)"),
    ("sky-700", "oklch(50% 0.134 242.749)"),
    ("violet-600", "oklch(54.1% 0.281 293.009)"),
    ("violet-700", "oklch(49.1% 0.27 292.581)"),
];

/// A Tailwind step (`amber-300`).
pub fn step(name: &str) -> Rgba {
    tailwind::color(name)
        .or_else(|| {
            LIGHT_STEPS
                .iter()
                .find(|(n, _)| *n == name)
                .and_then(|(_, src)| color::parse(src))
        })
        .unwrap_or_else(|| panic!("{name} is a Tailwind step"))
}

/// The light-on-dark Tailwind tints (`text-amber-300`) read badly on the
/// light palettes; there the card takes the darker step.
pub fn tint(c: &Colors, dark_step: &str, light_step: &str) -> Hsla {
    h(step(if c.dark { dark_step } else { light_step }))
}

pub fn white() -> Hsla {
    gpui_kit::white()
}

pub fn icon(name: &str, size: f32, color: Hsla) -> Option<Icon> {
    icons::icon(name).map(|i| Icon::new(i).size(px(size)).text_color(color))
}

/// A clickable element with an id and a test selector.
pub fn clickable(id: impl Into<SharedString>) -> Stateful<Div> {
    let id: SharedString = id.into();
    let sel = id.to_string();
    div().id(id).debug_selector(move || sel).cursor_pointer()
}

/// The button looks the cards use.
#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Look {
    /// `bg-[var(--accent)] text-white`.
    Primary,
    /// `border bg-[var(--panel)]`.
    Secondary,
    /// `border-red-500/40 bg-red-500/10 text-red-300`.
    Danger,
    /// `bg-red-500/90 text-white`.
    DangerSolid,
    /// The auto-mode tip's `border-[var(--accent)]/40 bg-[var(--accent)]/10`.
    AccentSoft,
}

/// A button: `px-3 py-1.5 text-sm rounded-md` (`small`: `text-xs`).
pub fn button(
    id: impl Into<SharedString>,
    label: impl Into<SharedString>,
    look: Look,
    small: bool,
    disabled: bool,
    c: &Colors,
) -> Stateful<Div> {
    let base = button_base(id, look, small, c).child(label.into());
    if disabled {
        base.opacity(0.4).cursor_default()
    } else {
        base
    }
}

fn button_base(id: impl Into<SharedString>, look: Look, small: bool, c: &Colors) -> Stateful<Div> {
    let base = clickable(id)
        .flex()
        .items_center()
        .gap(px(4.))
        .px(px(if small { 10. } else { 12. }))
        .py(px(if small { 4. } else { 6. }))
        .rounded(px(6.))
        .text_size(px(if small { 12. } else { 14. }))
        .line_height(px(if small { 16. } else { 20. }))
        .flex_none();
    match look {
        Look::Primary => base.bg(h(c.accent)).text_color(white()),
        Look::Secondary => base
            .border_1()
            .border_color(h(c.border))
            .bg(h(c.panel))
            .text_color(h(c.foreground)),
        Look::Danger => base
            .border_1()
            .border_color(a(step("red-500"), 40.))
            .bg(a(step("red-500"), 10.))
            .text_color(tint(c, "red-300", "red-600")),
        Look::DangerSolid => base.bg(a(step("red-500"), 90.)).text_color(white()),
        Look::AccentSoft => base
            .border_1()
            .border_color(a(c.accent, 40.))
            .bg(a(c.accent, 10.))
            .text_color(h(c.accent))
            .font_weight(FontWeight::MEDIUM),
    }
}

/// A [`button`] with a leading icon (`<Check /> Accept`).
pub fn icon_button(
    id: impl Into<SharedString>,
    icon_name: &str,
    label: impl Into<SharedString>,
    look: Look,
    c: &Colors,
) -> Stateful<Div> {
    let fg = match look {
        Look::Primary | Look::DangerSolid => white(),
        Look::Secondary => h(c.foreground),
        Look::Danger => tint(c, "red-300", "red-600"),
        Look::AccentSoft => h(c.accent),
    };
    button_base(id, look, false, c)
        .children(icon(icon_name, 14., fg))
        .child(label.into())
}

/// A rounded pill (`rounded-full border px-1.5 py-0.5 font-mono text-[9px]`).
pub fn pill(text: impl Into<SharedString>, fg: Hsla, border: Hsla, bg: Hsla) -> Div {
    div()
        .flex_none()
        .rounded_full()
        .border_1()
        .border_color(border)
        .bg(bg)
        .px(px(6.))
        .py(px(1.))
        .font_family(claudius_gpui_theme::fonts::MONO)
        .text_size(px(9.))
        .line_height(px(12.))
        .text_color(fg)
        .child(text.into())
}

/// The dimmed backdrop a modal card sits on (`fixed inset-0 bg-black/60`),
/// over the chat pane; it takes the pointer so nothing behind is clicked.
pub fn backdrop(id: &'static str) -> Stateful<Div> {
    div()
        .id(id)
        .debug_selector(move || id.to_owned())
        .absolute()
        .top_0()
        .left_0()
        .size_full()
        .flex()
        .items_center()
        .justify_center()
        .bg(gpui_kit::black().opacity(0.6))
        .occlude()
}

/// A card's panel: `rounded-xl border bg-[var(--panel)] shadow-2xl`.
pub fn panel(c: &Colors, width: f32) -> Div {
    div()
        .w(px(width))
        .max_w(gpui_kit::relative(0.92))
        .flex()
        .flex_col()
        .overflow_hidden()
        .rounded(px(12.))
        .border_1()
        .border_color(h(c.border))
        .bg(h(c.panel))
        .shadow_2xl()
        .text_color(h(c.foreground))
}

/// `text-[11px] uppercase tracking-wide text-[var(--muted)]`.
pub fn caps(text: impl Into<SharedString>, c: &Colors) -> Div {
    let t: SharedString = text.into();
    div()
        .text_size(px(11.))
        .line_height(px(14.))
        .text_color(h(c.muted))
        .child(SharedString::from(t.to_uppercase()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_step_the_cards_use_resolves() {
        for name in [
            "amber-200",
            "amber-300",
            "amber-400",
            "amber-500",
            "amber-700",
            "emerald-200",
            "emerald-300",
            "emerald-400",
            "emerald-700",
            "red-300",
            "red-400",
            "red-500",
            "red-600",
            "sky-200",
            "sky-500",
            "sky-700",
            "violet-200",
            "violet-300",
            "violet-500",
            "violet-600",
            "violet-700",
        ] {
            let _ = step(name);
        }
    }
}
