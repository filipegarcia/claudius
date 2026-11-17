//! The per-session prompt accent (`/color`): `lib/shared/prompt-colors.ts`,
//! the `/color` case of `components/chat/ChatSurface.tsx`'s slash handler,
//! and how `components/chat/PromptInput.tsx` paints the composer's frame.

use crate::color::{self, Rgba};
use crate::js;
use crate::palette::Theme;

/// `PROMPT_COLORS`, in its key order (`PROMPT_COLOR_NAMES`).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum PromptColor {
    Red,
    Orange,
    Yellow,
    Green,
    Cyan,
    Blue,
    Purple,
    Pink,
}

impl PromptColor {
    pub const ALL: [PromptColor; 8] = [
        PromptColor::Red,
        PromptColor::Orange,
        PromptColor::Yellow,
        PromptColor::Green,
        PromptColor::Cyan,
        PromptColor::Blue,
        PromptColor::Purple,
        PromptColor::Pink,
    ];

    pub fn name(self) -> &'static str {
        match self {
            PromptColor::Red => "red",
            PromptColor::Orange => "orange",
            PromptColor::Yellow => "yellow",
            PromptColor::Green => "green",
            PromptColor::Cyan => "cyan",
            PromptColor::Blue => "blue",
            PromptColor::Purple => "purple",
            PromptColor::Pink => "pink",
        }
    }

    pub fn hex(self) -> &'static str {
        match self {
            PromptColor::Red => "#e5484d",
            PromptColor::Orange => "#e8590c",
            PromptColor::Yellow => "#f5a524",
            PromptColor::Green => "#46a758",
            PromptColor::Cyan => "#00a3c4",
            PromptColor::Blue => "#3b82f6",
            PromptColor::Purple => "#8b5cf6",
            PromptColor::Pink => "#e93d82",
        }
    }

    pub fn rgba(self) -> Rgba {
        color::parse(self.hex()).unwrap_or(Rgba::TRANSPARENT)
    }

    /// `isPromptColorName`: an own key of `PROMPT_COLORS`, exactly.
    pub fn from_name(name: &str) -> Option<PromptColor> {
        PromptColor::ALL.into_iter().find(|c| c.name() == name)
    }
}

/// `PROMPT_COLOR_RESET_WORDS`: clear the session's color.
pub const RESET_WORDS: [&str; 5] = ["default", "none", "off", "clear", "reset"];

/// `resolvePromptColor`: a stored name to its hex, `None` when unset or
/// unknown.
pub fn resolve_prompt_color(name: Option<&str>) -> Option<&'static str> {
    name.and_then(PromptColor::from_name).map(PromptColor::hex)
}

/// What `/color <args>` did, in the order the TS does it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ColorCommand {
    /// No session to color: just the toast.
    NoSession { toast: String },
    /// Not a color name or reset word: just the toast.
    Unknown { toast: String },
    /// Set (or cleared, `None`) for the session: the optimistic UI state,
    /// then `POST /api/sessions/<id>/prompt-color` with `body` (fire and
    /// forget), then the toast.
    Set {
        session_id: String,
        color: Option<PromptColor>,
        url: String,
        body: String,
        toast: String,
    },
}

/// `/color <args>`. `current` is the color the session shows now, and
/// `random` stands in for `Math.random()`, in `0..1` (a cosmetic pick: no
/// argument picks one of the other seven, or of all eight when none is
/// set).
pub fn color_command(
    session_id: Option<&str>,
    args: &str,
    current: Option<PromptColor>,
    random: f64,
) -> ColorCommand {
    let Some(id) = session_id.filter(|s| !s.is_empty()) else {
        return ColorCommand::NoSession {
            toast: "No active session".to_string(),
        };
    };
    let raw = js::trim(args).to_lowercase();
    let color = if raw.is_empty() {
        let choices: Vec<PromptColor> = PromptColor::ALL
            .into_iter()
            .filter(|c| Some(*c) != current)
            .collect();
        let i = (random * choices.len() as f64).floor() as usize;
        Some(choices[i.min(choices.len() - 1)])
    } else if RESET_WORDS.contains(&raw.as_str()) {
        None
    } else if let Some(c) = PromptColor::from_name(&raw) {
        Some(c)
    } else {
        let names: Vec<&str> = PromptColor::ALL.iter().map(|c| c.name()).collect();
        return ColorCommand::Unknown {
            toast: format!(
                "Unknown color: {raw} \u{2014} try {}, or default",
                names.join(", ")
            ),
        };
    };
    ColorCommand::Set {
        session_id: id.to_string(),
        color,
        url: format!("/api/sessions/{id}/prompt-color"),
        body: match color {
            Some(c) => format!("{{\"color\":\"{}\"}}", c.name()),
            None => "{\"color\":null}".to_string(),
        },
        toast: match color {
            Some(c) => format!("Session color set to: {}", c.name()),
            None => "Session color cleared".to_string(),
        },
    }
}

/// ChatSurface's `promptColor` state: a color and the session it was set
/// or loaded for, so a tab switch shows the theme default at once.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct PromptColorState {
    pub session_id: Option<String>,
    pub color: Option<PromptColor>,
}

impl PromptColorState {
    /// `activePromptColor`: the color only shows on its own session.
    pub fn active(&self, session_id: Option<&str>) -> Option<PromptColor> {
        if self.session_id.as_deref() == session_id {
            self.color
        } else {
            None
        }
    }

    /// `/color`'s optimistic set.
    pub fn set(&mut self, session_id: &str, color: Option<PromptColor>) {
        *self = PromptColorState {
            session_id: Some(session_id.to_string()),
            color,
        };
    }

    /// The bind-load's `GET /api/sessions/<id>/prompt-color` reply (`None`
    /// for a non-2xx; `color` is its `color` field when that is a string).
    /// A palette name or nothing, and never over a `/color` the user ran
    /// for this session while the load was in flight. A failed fetch (or
    /// the abort on a switch) doesn't call this: the state stays.
    pub fn loaded(&mut self, session_id: &str, ok: bool, color: Option<&str>) {
        if self.session_id.as_deref() == Some(session_id) {
            return;
        }
        let color = if ok {
            color.and_then(PromptColor::from_name)
        } else {
            None
        };
        self.set(session_id, color);
    }
}

/// The composer's state, as PromptInput reads it.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct ComposerState {
    pub prompt_color: Option<PromptColor>,
    /// The page-wide drop target is active (the composer then keeps its
    /// idle look while dragging).
    pub wide_drop_target: bool,
    pub drag_over: bool,
    /// The draft starts with `!`.
    pub bash_mode: bool,
    /// Focus is inside the composer (`:focus-within`).
    pub focused: bool,
}

/// The composer frame's colors.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct ComposerFrame {
    pub border: Rgba,
    pub background: Rgba,
}

/// The inline `borderColor` PromptInput sets: the session color, unless
/// a drag is over the composer itself or the draft is a `!` command.
pub fn inline_border(s: &ComposerState) -> Option<PromptColor> {
    let dragging_here = !s.wide_drop_target && s.drag_over;
    s.prompt_color.filter(|_| !dragging_here && !s.bash_mode)
}

/// The frame as Chromium paints it. The TS's border classes (accent on
/// drag-over, amber in bash mode, accent/60 on focus) lose to globals.css's
/// unlayered `* { border-color: var(--border) }` (see
/// [`Theme::border_color`]), so only the inline session color changes the
/// border. The drag-over background (`bg-[var(--accent)]/5`, which
/// tailwind-merge keeps over the base `bg-[var(--panel-2)]`) does show.
/// `focused` changes nothing.
pub fn composer_frame(theme: &Theme, s: &ComposerState) -> ComposerFrame {
    let border = theme.border_color(inline_border(s).map(PromptColor::rgba));
    let background = if !s.wide_drop_target && s.drag_over {
        color::with_opacity(theme.palette.accent, 5.0)
    } else {
        theme.palette.panel_2
    };
    ComposerFrame { border, background }
}
