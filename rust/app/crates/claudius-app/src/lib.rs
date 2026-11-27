//! The native app shell (U04a): the window, the workspace rail, the nav
//! rail, the session tab strip and the content area, routed as the React
//! app's pages are, over a [`ShellData`](data::ShellData) source.
//!
//! [`state::ShellState`] holds the logic (routing, the redirects, the tab
//! strip, focus mode) without GPUI; [`shell::Shell`] puts it on screen and
//! runs its effects against the data source.

pub mod data;
pub mod fixture;
pub mod nav;
pub mod route;
mod screens;
pub mod sessions;
pub mod shell;
pub mod shortcuts;
pub mod state;
pub mod tabs;
mod ui;

use claudius_gpui_theme::ThemeName;
use gpui_kit::App;

pub use ui::VERSION_DISPLAY;

/// Initializes gpui-component, the theme (`theme` until the window reads
/// its appearance) and the shortcuts. Call once, before
/// [`shell::open_main_window`].
pub fn init(theme: ThemeName, cx: &mut App) {
    gpui_kit::init(cx);
    claudius_gpui_theme::init(theme, cx);
    shortcuts::bind(cx);
    sessions::view::bind(cx);
}
