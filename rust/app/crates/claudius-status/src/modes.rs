//! The permission modes: `lib/shared/permission-modes.ts`
//! (`PERMISSION_MODE_ORDER`, `nextPermissionMode`) and
//! `components/chat/ModeSelector.tsx` (`PERMISSION_MODE_META`, the menu's
//! `visibleOrder`, the trigger's title and the screen-reader
//! announcement).

use crate::tone::Tone;

/// `PERMISSION_MODE_ORDER` (permission-modes.ts:10): the Shift+Tab cycle
/// and the menu's order.
pub const PERMISSION_MODE_ORDER: [&str; 6] = [
    "default",
    "acceptEdits",
    "auto",
    "plan",
    "dontAsk",
    "bypassPermissions",
];

/// One row of `PERMISSION_MODE_META` (ModeSelector.tsx:12): the label,
/// the description, the lucide icon (its React name) and the tone.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ModeMeta {
    pub mode: &'static str,
    pub label: &'static str,
    pub description: &'static str,
    pub icon: &'static str,
    pub tone: Tone,
}

/// `PERMISSION_MODE_META`, in [`PERMISSION_MODE_ORDER`].
pub const MODE_META: [ModeMeta; 6] = [
    ModeMeta {
        mode: "default",
        label: "Default",
        description: "Prompt for risky tools",
        icon: "Shield",
        tone: Tone::Muted,
    },
    ModeMeta {
        mode: "acceptEdits",
        label: "Accept edits",
        description: "Auto-approve file edits, prompt for the rest",
        icon: "ShieldCheck",
        tone: Tone::Emerald400,
    },
    ModeMeta {
        mode: "auto",
        label: "Auto",
        description: "Auto-approve with background safety checks",
        icon: "Wand2",
        tone: Tone::Sky400,
    },
    ModeMeta {
        mode: "plan",
        label: "Plan",
        description: "Read-only \u{2014} produce a plan, no tool side effects",
        icon: "ListChecks",
        tone: Tone::Violet400,
    },
    ModeMeta {
        mode: "dontAsk",
        label: "Don't ask",
        description: "Never prompt \u{2014} auto-deny anything not pre-approved",
        icon: "ShieldAlert",
        tone: Tone::Amber400,
    },
    ModeMeta {
        mode: "bypassPermissions",
        label: "Bypass",
        description: "Never prompt \u{2014} auto-allow everything (dangerous)",
        icon: "ShieldOff",
        tone: Tone::Red400,
    },
];

/// `PERMISSION_MODE_META[mode]`, `None` for a mode it doesn't list.
pub fn mode_meta(mode: &str) -> Option<&'static ModeMeta> {
    MODE_META.iter().find(|m| m.mode == mode)
}

/// `PERMISSION_MODE_META[mode]` for the trigger. The TS reads `meta.icon`
/// off it, so a mode it doesn't list throws and takes the chat down; the
/// port shows `default`'s row instead (the server only ever sends listed
/// modes).
pub fn trigger_meta(mode: &str) -> &'static ModeMeta {
    mode_meta(mode).unwrap_or(&MODE_META[0])
}

/// The cycle with `disabled_modes` left out, the current mode kept
/// (permission-modes.ts:31 and ModeSelector.tsx:67, the same filter):
/// `disabledModes?.length ? ORDER.filter((m) => m === mode ||
/// !disabledModes.includes(m)) : ORDER`.
pub fn visible_order(mode: &str, disabled_modes: &[String]) -> Vec<&'static str> {
    PERMISSION_MODE_ORDER
        .into_iter()
        .filter(|m| {
            disabled_modes.is_empty() || *m == mode || !disabled_modes.iter().any(|d| d == m)
        })
        .collect()
}

/// `nextPermissionMode(mode, disabledModes)` (permission-modes.ts:27): the
/// next mode of [`visible_order`], wrapping; `default` for a mode the cycle
/// doesn't hold.
pub fn next_permission_mode(mode: &str, disabled_modes: &[String]) -> &'static str {
    let cycle = visible_order(mode, disabled_modes);
    match cycle.iter().position(|m| *m == mode) {
        Some(i) => cycle[(i + 1) % cycle.len()],
        None => "default",
    }
}

/// The trigger's `title` (ModeSelector.tsx:137): the mode, its
/// description and the shortcut.
pub fn trigger_title(meta: &ModeMeta) -> String {
    format!(
        "Permission mode: {} \u{2014} {}\nShift+Tab to cycle",
        meta.label, meta.description
    )
}

/// The `aria-live` announcement after a mode change (ModeSelector.tsx:95).
pub fn announcement(meta: &ModeMeta) -> String {
    format!(
        "Permission mode: {} \u{2014} {}",
        meta.label, meta.description
    )
}

/// The menu's header (ModeSelector.tsx:158).
pub const MENU_HEADER: &str = "Permission mode \u{b7} Shift+Tab cycles";

/// One row of the open menu.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ModeOption {
    pub meta: &'static ModeMeta,
    /// The session's mode (the row's `●`).
    pub active: bool,
}

/// The open menu's rows: [`visible_order`], the current one marked. A
/// disabled mode has no row, so it can't be picked.
pub fn menu(mode: &str, disabled_modes: &[String]) -> Vec<ModeOption> {
    visible_order(mode, disabled_modes)
        .into_iter()
        .filter_map(mode_meta)
        .map(|meta| ModeOption {
            meta,
            active: meta.mode == mode,
        })
        .collect()
}
