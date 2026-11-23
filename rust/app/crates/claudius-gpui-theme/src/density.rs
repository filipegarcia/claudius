//! The React UI's sizes (`claudius-theme`'s Tailwind tokens) as GPUI
//! `Pixels`.
//!
//! The React UI has **one density**. There is no compact / comfortable
//! setting: no `data-density` attribute, no density key in storage or
//! settings, and the root font size never changes (1rem is 16px). The only
//! user scale is Settings → Chat size (the chat column's max width and base
//! text size), which [`chat_column`] applies. So this module has no density
//! levels; a GPUI `rems(1.)` is a Tailwind `1rem` because [`FONT_SIZE`]
//! becomes the window's rem size.

use claudius_theme::{
    chat::{self, ChatSize},
    tailwind,
};
use gpui_kit::{Pixels, px};

fn pixels(v: f64) -> Pixels {
    px(v as f32)
}

/// The theme's `font_size`, which gpui-component makes the window's rem
/// size: Tailwind's 1rem ([`tailwind::REM_PX`]).
pub fn font_size() -> Pixels {
    pixels(tailwind::REM_PX)
}

/// `font_size` as a number (the theme file's `font.size`).
pub const FONT_SIZE: f64 = tailwind::REM_PX;

/// CodeBlock.tsx's `text-[0.86em]` (a component literal): highlighted code
/// relative to the chat text.
pub const CODE_EM: f64 = 0.86;

/// The theme's `mono_font_size`: a chat code block's size at the default
/// chat text (`--chat-text`, 0.875rem below the fluid breakpoint), 12.04px.
/// Code elsewhere (`font-mono text-xs`, `text-[11px]`) sets its own size.
pub const MONO_FONT_SIZE: f64 = chat::CHAT_TEXT_REM * tailwind::REM_PX * CODE_EM;

/// The theme's `radius` (general controls: `rounded-md`, 6px) and
/// `radius_lg` (dialogs, popovers, cards: `rounded-lg`, 8px), the two radii
/// gpui-component's theme holds.
pub const RADIUS: &str = "--radius-md";
pub const RADIUS_LG: &str = "--radius-lg";

/// A spacing step (`p-3` is `spacing(3.0)`, 12px).
pub fn spacing(step: f64) -> Pixels {
    pixels(tailwind::spacing_px(step))
}

/// A `rounded-*` radius by its variable (`"--radius-md"`), plain `rounded`
/// as `"rounded"`, and `rounded-full` as `"full"` (a pill: GPUI clamps any
/// radius past half the shorter side).
pub fn radius(name: &str) -> Option<Pixels> {
    match name {
        "rounded" => Some(pixels(tailwind::ROUNDED_REM * tailwind::REM_PX)),
        "full" => Some(px(9999.)),
        _ => tailwind::RADII
            .iter()
            .find(|r| r.name == name)
            .map(|r| pixels(r.px())),
    }
}

/// A `text-*` step's size and line height.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct TextSize {
    pub size: Pixels,
    pub line_height: Pixels,
}

/// `text-xs` … `text-3xl` by suffix (`"sm"`).
pub fn text(name: &str) -> Option<TextSize> {
    tailwind::TEXT
        .iter()
        .find(|t| t.name == name)
        .map(|t| TextSize {
            size: pixels(t.size_px()),
            line_height: pixels(t.line_height_px()),
        })
}

/// The chat column's max width and base text size for a window width and
/// the user's Settings → Chat size ([`chat::chat_column_with`]).
pub fn chat_column(window_width: Pixels, size: ChatSize) -> (Pixels, Pixels) {
    let (col, text) = chat::chat_column_with(f64::from(f32::from(window_width)), size);
    (pixels(col), pixels(text))
}

/// A radius token in whole px, as the theme file's `radius` fields take.
pub(crate) fn radius_px(name: &str) -> usize {
    let r = radius(name).unwrap_or_else(|| panic!("{name} is not a radius"));
    f32::from(r).round() as usize
}
