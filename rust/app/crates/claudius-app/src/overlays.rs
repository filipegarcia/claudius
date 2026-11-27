//! The overlays over the shell (U10a, claudius-overlays): the command
//! palette (`nav.commandPalette`, ⌘K), mounted for every route as
//! `app/layout.tsx` mounts it; the keyboard cheatsheet (`nav.cheatsheet`,
//! ⌘/); and the slash commands' help (ChatSurface's `overlay === "help"`,
//! [`Shell::open_help`]).
//!
//! One shows at a time: opening one replaces the other, and its chord
//! closes it again (`togglePalette`). Closing gives the focus back to what
//! had it before the first one opened, or to the shell when that left
//! with the page (a palette row's navigation goes through the shell's
//! router, [`Shell::open_url`], as `router.push`; [`sync`]'s fallback).

use claudius_overlays::help::{CheatsheetModel, HelpModel};
use claudius_overlays::palette::{build_items, workspace_id_from_pathname};
use claudius_overlays::slash::SLASH_COMMANDS;
use claudius_overlays::view::help::HelpContent;
use claudius_overlays::{CommandPaletteView, HelpEvent, HelpOverlayView, PaletteEvent};
use gpui_kit::{
    AnyElement, AppContext as _, Context, Entity, FocusHandle, IntoElement as _, Subscription,
    Window,
};

use crate::shell::Shell;

/// Which overlay is open.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum OverlayKind {
    Palette,
    Cheatsheet,
    Help,
}

enum OverlayView {
    Palette(Entity<CommandPaletteView>),
    Help(Entity<HelpOverlayView>),
}

/// The shell's open overlay, and the focus to give back when it closes.
#[derive(Default)]
pub(crate) struct OverlaySlot {
    view: Option<(OverlayKind, OverlayView)>,
    restore: Option<FocusHandle>,
    _sub: Option<Subscription>,
    /// The shell's focus-lost fallback, once [`sync`] registered it.
    focus_lost: Option<Subscription>,
}

fn mac() -> bool {
    cfg!(target_os = "macos")
}

impl Shell {
    /// The open overlay.
    pub fn overlay_kind(&self) -> Option<OverlayKind> {
        self.overlay.view.as_ref().map(|(k, _)| *k)
    }

    /// The command palette, while it's open.
    pub fn command_palette(&self) -> Option<Entity<CommandPaletteView>> {
        match &self.overlay.view {
            Some((_, OverlayView::Palette(v))) => Some(v.clone()),
            _ => None,
        }
    }

    /// The cheatsheet or the help overlay, while one is open.
    pub fn help_overlay(&self) -> Option<Entity<HelpOverlayView>> {
        match &self.overlay.view {
            Some((_, OverlayView::Help(v))) => Some(v.clone()),
            _ => None,
        }
    }

    /// `nav.commandPalette`: opens the palette fresh (an empty query, the
    /// first row), or closes it.
    pub fn toggle_command_palette(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.overlay_kind() == Some(OverlayKind::Palette) {
            return self.close_overlay(window, cx);
        }
        // The workspace in the URL (`workspaceIdFromPathname`).
        let pathname = self.state.route().pathname();
        let items = build_items(
            workspace_id_from_pathname(&pathname),
            SLASH_COMMANDS,
            &crate::shortcuts::palette_rows(mac()),
        );
        self.remember_focus(window, cx);
        let theme = self.theme;
        let view = cx.new(|cx| CommandPaletteView::new(items, theme, window, cx));
        let sub = cx.subscribe_in(
            &view,
            window,
            |this: &mut Shell, _, e: &PaletteEvent, window, cx| match e {
                PaletteEvent::Close => this.close_overlay(window, cx),
                PaletteEvent::Navigate(href) => {
                    let href = href.clone();
                    this.close_overlay(window, cx);
                    this.open_url(&href, cx);
                }
            },
        );
        self.show(
            OverlayKind::Palette,
            OverlayView::Palette(view),
            sub,
            window,
            cx,
        );
    }

    /// `nav.cheatsheet`: opens the keyboard cheatsheet, or closes it.
    pub fn toggle_cheatsheet(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.overlay_kind() == Some(OverlayKind::Cheatsheet) {
            return self.close_overlay(window, cx);
        }
        let model = CheatsheetModel::new(crate::shortcuts::palette_rows(mac()));
        self.open_help_view(
            OverlayKind::Cheatsheet,
            HelpContent::Shortcuts(model),
            window,
            cx,
        );
    }

    /// ChatSurface's `setOverlay("help")` (`/help [command]`, `/<command>
    /// --help`): the slash commands' help over the mounted chat's SDK
    /// commands and skills, on `topic`'s usage when one is given.
    pub fn open_help(
        &mut self,
        topic: Option<String>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let (commands, skills) = match self.live_chat() {
            Some(chat) => {
                let s = chat.state();
                (s.slash_commands.clone(), s.skills.clone())
            }
            None => (Vec::new(), Vec::new()),
        };
        let model = HelpModel::new(commands, skills, topic);
        self.open_help_view(OverlayKind::Help, HelpContent::Commands(model), window, cx);
    }

    fn open_help_view(
        &mut self,
        kind: OverlayKind,
        content: HelpContent,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.remember_focus(window, cx);
        let theme = self.theme;
        let view = cx.new(|cx| HelpOverlayView::new(content, theme, window, cx));
        let sub = cx.subscribe_in(
            &view,
            window,
            |this: &mut Shell, _, e: &HelpEvent, window, cx| match e {
                HelpEvent::Close => this.close_overlay(window, cx),
            },
        );
        self.show(kind, OverlayView::Help(view), sub, window, cx);
    }

    /// The focus to give back: what had it before the first overlay (the
    /// one being replaced has had it since). Read before the new overlay's
    /// field takes it.
    fn remember_focus(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.overlay.view.is_none() {
            self.overlay.restore = window.focused(cx);
        }
    }

    fn show(
        &mut self,
        kind: OverlayKind,
        view: OverlayView,
        sub: Subscription,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.overlay.view = Some((kind, view));
        self.overlay._sub = Some(sub);
        self.overlay_focus(window, cx);
        cx.notify();
    }

    /// Focuses the open overlay's field.
    fn overlay_focus(&self, window: &mut Window, cx: &mut Context<Self>) {
        let focus = match &self.overlay.view {
            Some((_, OverlayView::Palette(v))) => v.read(cx).focus(cx),
            Some((_, OverlayView::Help(v))) => v.read(cx).focus(cx),
            None => return,
        };
        window.focus(&focus, cx);
    }

    /// Closes the open overlay and gives the focus back.
    pub fn close_overlay(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.overlay.view.take().is_none() {
            return;
        }
        self.overlay._sub = None;
        let restore = self
            .overlay
            .restore
            .take()
            .unwrap_or_else(|| self.focus.clone());
        window.focus(&restore, cx);
        cx.notify();
    }
}

/// Registers the shell as the window's focus-lost fallback (once): when
/// the focused element leaves the tree (the composer as the chat route
/// unmounts it, an overlay's field), the shell's root takes the focus, so
/// its chords (⌘K, ⌘/, the nav shortcuts) keep answering. GPUI dispatches
/// an unrendered focus from the window's root view, outside the shell's
/// key context.
pub(crate) fn sync(shell: &mut Shell, window: &mut Window, cx: &mut Context<Shell>) {
    if shell.overlay.focus_lost.is_none() {
        let sub = cx.on_focus_lost(window, |this: &mut Shell, window, cx| {
            window.focus(&this.focus, cx);
        });
        shell.overlay.focus_lost = Some(sub);
    }
}

/// The open overlay, over the whole window (its theme follows the shell's).
pub(crate) fn element(shell: &Shell, cx: &mut Context<Shell>) -> Option<AnyElement> {
    let theme = shell.theme;
    match &shell.overlay.view {
        Some((_, OverlayView::Palette(v))) => {
            v.update(cx, |v, cx| v.set_theme(theme, cx));
            Some(v.clone().into_any_element())
        }
        Some((_, OverlayView::Help(v))) => {
            v.update(cx, |v, cx| v.set_theme(theme, cx));
            Some(v.clone().into_any_element())
        }
        None => None,
    }
}
