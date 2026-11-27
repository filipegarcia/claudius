//! The overlays on screen: [`frame::Overlay`] (the shared frame),
//! [`palette::CommandPaletteView`] and [`help::HelpOverlayView`], light and
//! dark, after the React components' Tailwind classes.

pub mod frame;
pub mod help;
pub mod palette;
pub mod style;

use gpui_kit::{App, KeyBinding};

/// Binds Escape in every overlay's key context and the palette's arrows.
pub(crate) fn bind(cx: &mut App) {
    cx.bind_keys([
        KeyBinding::new("escape", frame::Dismiss, Some(frame::CONTEXT)),
        KeyBinding::new("down", palette::SelectNext, Some(palette::CONTEXT)),
        KeyBinding::new("up", palette::SelectPrev, Some(palette::CONTEXT)),
    ]);
}
