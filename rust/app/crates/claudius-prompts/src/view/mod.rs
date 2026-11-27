//! The cards on screen (GPUI), mounted in the chat route the way
//! ChatSurface mounts them: [`ChatPrompts`] is one chat's set, the plan-mode
//! banner above the transcript, the live ask below it, and the modal layer
//! over the chat pane.

mod ask;
mod elicitation;
mod overlays;
mod permission;
mod plan;
pub mod style;

use std::sync::Arc;

use claudius_gpui_theme::ThemeName;
use gpui_kit::{App, AppContext as _, Entity, KeyDownEvent, Window};
use serde_json::Value;

pub use ask::{AskEvent, AskView};
pub use elicitation::{ElicitationEvent, ElicitationView};
pub use overlays::{FieldProbe, InlineAsk, PromptOverlays, TOAST_MS};
pub use permission::{PermissionEvent, PermissionView};
pub use plan::{PlanBanner, PlanEvent, PlanView};

use crate::target::PromptTarget;

/// One chat's prompt views.
#[derive(Clone)]
pub struct ChatPrompts {
    /// `PlanModeBanner`: above the transcript.
    pub banner: Entity<PlanBanner>,
    /// The live ask: below the transcript.
    pub inline: Entity<InlineAsk>,
    /// The plan overlay, the permission and elicitation cards, the
    /// resurrected ask and the toast: over the chat pane (an absolutely
    /// positioned layer; its parent is `relative`).
    pub overlays: Entity<PromptOverlays>,
}

impl ChatPrompts {
    pub fn new(target: Arc<dyn PromptTarget>, theme: ThemeName, cx: &mut App) -> Self {
        ChatPrompts {
            banner: cx.new(|cx| PlanBanner::new(target.clone(), theme, cx)),
            inline: cx.new(|cx| InlineAsk::new(target.clone(), theme, cx)),
            overlays: cx.new(|cx| PromptOverlays::new(target, theme, cx)),
        }
    }

    pub fn set_theme(&self, theme: ThemeName, cx: &mut App) {
        self.banner.update(cx, |v, cx| v.set_theme(theme, cx));
        self.inline.update(cx, |v, cx| v.set_theme(theme, cx));
        self.overlays.update(cx, |v, cx| v.set_theme(theme, cx));
    }

    /// A key the window saw; `true` when a card took it (stop it there).
    pub fn key_down(&self, event: &KeyDownEvent, window: &mut Window, cx: &mut App) -> bool {
        self.overlays
            .update(cx, |v, cx| v.key_down(event, window, cx))
    }

    /// A transcript ask row's "Reopen" (U06's row calls it); `true` when it
    /// is the live ask, which the caller scrolls into view.
    pub fn reopen_ask(&self, tool_use_id: &str, input: &Value, cx: &mut App) -> bool {
        self.overlays
            .update(cx, |v, cx| v.reopen_ask(tool_use_id, input, cx))
    }
}
