//! The chat reading column: `--chat-col` / `--chat-text` from
//! `app/globals.css` as functions of the viewport width, and the user's
//! overrides from Settings → Chat size (`lib/client/chat-size.ts`).
//!
//! This is the app's only size setting: there is no density setting, and
//! nothing changes the root font size, so `rem` is 16px
//! ([`crate::tailwind::REM_PX`]).

use crate::client::{Host, StorageError};
use crate::js;
use crate::tailwind::REM_PX;

/// `clamp(<min>rem, <base>rem + <vw>vw, <max>rem)`.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct FluidRem {
    pub min_rem: f64,
    pub base_rem: f64,
    pub vw: f64,
    pub max_rem: f64,
}

impl FluidRem {
    /// The CSS text, as globals.css writes it.
    pub fn source(&self) -> String {
        format!(
            "clamp({}rem, {}rem + {}vw, {}rem)",
            self.min_rem, self.base_rem, self.vw, self.max_rem
        )
    }

    /// The px at a viewport width (px). CSS `clamp()` is
    /// `max(min, min(value, max))`.
    pub fn px(&self, viewport_px: f64) -> f64 {
        let value = self.base_rem * REM_PX + self.vw / 100.0 * viewport_px;
        (self.min_rem * REM_PX).max(value.min(self.max_rem * REM_PX))
    }
}

/// `:root { --chat-col: 48rem }` (max-w-3xl) below the fluid tier.
pub const CHAT_COL_REM: f64 = 48.0;
/// `:root { --chat-text: 0.875rem }` (text-sm) below the fluid tier.
pub const CHAT_TEXT_REM: f64 = 0.875;
/// `@media (min-width: 1536px)`: the fluid tier starts here.
pub const FLUID_MIN_VIEWPORT_PX: f64 = 1536.0;
pub const CHAT_COL_FLUID: FluidRem = FluidRem {
    min_rem: 60.0,
    base_rem: 32.0,
    vw: 30.0,
    max_rem: 96.0,
};
pub const CHAT_TEXT_FLUID: FluidRem = FluidRem {
    min_rem: 1.0625,
    base_rem: 0.6,
    vw: 0.5,
    max_rem: 1.75,
};

/// The stylesheet's `(--chat-col, --chat-text)` in px at a viewport width
/// (CSS px, the width media queries and `vw` see): the column's max width
/// and the chat's base font size.
pub fn chat_column(viewport_px: f64) -> (f64, f64) {
    if viewport_px >= FLUID_MIN_VIEWPORT_PX {
        (
            CHAT_COL_FLUID.px(viewport_px),
            CHAT_TEXT_FLUID.px(viewport_px),
        )
    } else {
        (CHAT_COL_REM * REM_PX, CHAT_TEXT_REM * REM_PX)
    }
}

/// [`chat_column`] with the user's overrides, which the client writes as
/// inline variables on `<html>` and so win at every width.
pub fn chat_column_with(viewport_px: f64, size: ChatSize) -> (f64, f64) {
    let (col, text) = chat_column(viewport_px);
    (
        size.col_rem.map_or(col, |r| r * REM_PX),
        size.text_px.unwrap_or(text),
    )
}

/// `ChatSize`: `None` is "auto" (the stylesheet's values).
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct ChatSize {
    pub col_rem: Option<f64>,
    pub text_px: Option<f64>,
}

/// `CHAT_SIZE_BOUNDS`.
pub const COL_MIN_REM: f64 = 36.0;
pub const COL_MAX_REM: f64 = 400.0;
pub const TEXT_MIN_PX: f64 = 13.0;
pub const TEXT_MAX_PX: f64 = 48.0;

pub const COL_KEY: &str = "claudius.chatColRem";
pub const TEXT_KEY: &str = "claudius.chatTextPx";
pub const CHAT_SIZE_CHANGED_EVENT: &str = "claudius.chatSize.changed";

/// `clampCol`: a non-finite input is the minimum (Infinity too).
pub fn clamp_col(n: f64) -> f64 {
    if !n.is_finite() {
        return COL_MIN_REM;
    }
    COL_MIN_REM.max(COL_MAX_REM.min(n))
}

/// `clampText`.
pub fn clamp_text(n: f64) -> f64 {
    if !n.is_finite() {
        return TEXT_MIN_PX;
    }
    TEXT_MIN_PX.max(TEXT_MAX_PX.min(n))
}

fn read_one(host: &mut dyn Host, key: &str, clamp: fn(f64) -> f64) -> Option<f64> {
    let saved = host.get_item(key).ok()??;
    if saved.is_empty() {
        return None;
    }
    let n = js::to_number(&saved);
    n.is_finite().then(|| clamp(n))
}

/// `readSnapshot`: each key read on its own (a throw only loses that one),
/// with `Number()` (so `" "` is 0, clamped to the minimum, and `"40rem"`
/// is unset).
pub fn read_chat_size(host: &mut dyn Host) -> ChatSize {
    let col_rem = read_one(host, COL_KEY, clamp_col);
    let text_px = read_one(host, TEXT_KEY, clamp_text);
    ChatSize { col_rem, text_px }
}

/// `getSnapshot`'s memo: the hook hands back the previous object while
/// `"<colRem>:<textPx>"` is unchanged.
#[derive(Clone, Debug, PartialEq)]
pub struct ChatSizeStore {
    cached: ChatSize,
    key: String,
}

impl Default for ChatSizeStore {
    fn default() -> Self {
        ChatSizeStore {
            cached: ChatSize::default(),
            key: ":".to_string(),
        }
    }
}

fn opt(n: Option<f64>) -> String {
    n.map(js::number_to_string).unwrap_or_default()
}

impl ChatSizeStore {
    /// The snapshot, and whether it is the cached one (`===` the previous).
    pub fn get_snapshot(&mut self, host: &mut dyn Host) -> (ChatSize, bool) {
        let fresh = read_chat_size(host);
        let key = format!("{}:{}", opt(fresh.col_rem), opt(fresh.text_px));
        if key == self.key {
            return (self.cached, true);
        }
        self.key = key;
        self.cached = fresh;
        (fresh, false)
    }
}

/// `applyToDom`: inline variables for the set values, removed for "auto".
pub fn apply_chat_size(host: &mut dyn Host, size: ChatSize) {
    match size.col_rem {
        None => host.remove_style_property("--chat-col"),
        Some(r) => {
            host.set_style_property("--chat-col", &format!("{}rem", js::number_to_string(r)))
        }
    }
    match size.text_px {
        None => host.remove_style_property("--chat-text"),
        Some(p) => {
            host.set_style_property("--chat-text", &format!("{}px", js::number_to_string(p)))
        }
    }
}

/// `setColRem`.
pub fn set_col_rem(host: &mut dyn Host, rem: f64) {
    let _ = host.set_item(COL_KEY, &js::number_to_string(clamp_col(rem)));
    host.dispatch_event(CHAT_SIZE_CHANGED_EVENT);
}

/// `setTextPx`.
pub fn set_text_px(host: &mut dyn Host, px: f64) {
    let _ = host.set_item(TEXT_KEY, &js::number_to_string(clamp_text(px)));
    host.dispatch_event(CHAT_SIZE_CHANGED_EVENT);
}

/// `reset`: both removals in one `try`, so a refused first one skips the
/// second.
pub fn reset_chat_size(host: &mut dyn Host) {
    let _ = (|| -> Result<(), StorageError> {
        host.remove_item(COL_KEY)?;
        host.remove_item(TEXT_KEY)
    })();
    host.dispatch_event(CHAT_SIZE_CHANGED_EVENT);
}
