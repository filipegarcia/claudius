//! The overlays (U10): `components/overlays/`'s shared [`Overlay`]
//! frame, the command palette (`CommandPalette.tsx`, mounted in
//! `app/layout.tsx` so `nav.commandPalette` opens it on every route), the
//! slash commands' help (`HelpOverlay.tsx`, ChatSurface's
//! `overlay === "help"`) and the keyboard cheatsheet `nav.cheatsheet`
//! opens.
//!
//! Pure models first, each rule citing its TS line:
//! - [`frame`]: the frame's props, what closes it, its size, the dragged
//!   panel's clamp.
//! - [`palette`]: the palette's rows (`WORKSPACE_NAV`, `GLOBAL_NAV`, the
//!   slash commands, the shortcuts), `fuzzyMatch` and the ranking, the
//!   selection and what Enter does.
//! - [`slash`]: `lib/shared/slash-commands.ts`' registry, its categories
//!   and `mergeSuggestions`, and `slash-help.ts`' `findHelpTopic` /
//!   `usageLine`.
//! - [`help`]: the help overlay's groups and usage card, and the
//!   cheatsheet's sections over the shortcut rows the app hands it
//!   ([`ShortcutRow`]: the registry lives in claudius-app's
//!   `shortcuts.rs`, which this crate doesn't depend on).
//!
//! Then the views ([`view`]): [`Overlay`], [`CommandPaletteView`] and
//! [`HelpOverlayView`], light and dark. Replayed against the TS by
//! `tests/overlays_golden.rs` (and, for the rows built over the app's
//! registry, claudius-app's `tests/palette_golden.rs`).

pub mod frame;
pub mod help;
pub mod palette;
pub mod slash;
pub mod view;

pub use view::frame::{Dismiss, Overlay};
pub use view::help::{HelpEvent, HelpOverlayView};
pub use view::palette::{CommandPaletteView, PaletteEvent};

/// A keyboard shortcut as the palette and the cheatsheet show it: one
/// `SHORTCUT_ACTIONS` entry with its binding already formatted
/// (`formatBinding`).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ShortcutRow {
    /// The registry id (`"tab.next"`).
    pub id: String,
    pub label: String,
    pub description: Option<String>,
    /// The `ShortcutCategory` (`"tabs"`, `"navigation"`, …).
    pub category: String,
    /// The binding as `formatBinding` prints it; `None` when the action has
    /// no binding (`default: null`).
    pub chord: Option<String>,
}

/// Binds the overlays' keys (Escape, the palette's arrows). Call once,
/// with gpui-component's own `init`.
pub fn bind(cx: &mut gpui_kit::App) {
    view::bind(cx);
}

/// JS string semantics the models lean on.
pub(crate) mod js {
    /// `String.prototype.trim`.
    pub fn trim(s: &str) -> &str {
        claudius_theme::js::trim(s)
    }

    /// `String.prototype.toLowerCase` (Rust's full Unicode mapping, final
    /// sigma included, is the one V8 uses).
    pub fn lower(s: &str) -> String {
        s.to_lowercase()
    }

    /// The string's UTF-16 code units (JS indexes and measures in them).
    pub fn units(s: &str) -> Vec<u16> {
        s.encode_utf16().collect()
    }
}
