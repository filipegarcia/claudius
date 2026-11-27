//! The colors the status line's Tailwind classes name, as data: the pure
//! model says which, the view resolves them against the palette.

/// A text / icon color (`text-amber-400`, `text-[var(--accent)]`, …).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Tone {
    /// `text-[var(--muted)]`.
    Muted,
    /// `text-[var(--accent)]`.
    Accent,
    /// `text-[var(--foreground)]`.
    Foreground,
    Amber400,
    Sky400,
    Emerald400,
    Violet400,
    Red400,
}

impl Tone {
    /// The Tailwind step, `None` for a palette token.
    pub fn step(self) -> Option<&'static str> {
        match self {
            Tone::Muted | Tone::Accent | Tone::Foreground => None,
            Tone::Amber400 => Some("amber-400"),
            Tone::Sky400 => Some("sky-400"),
            Tone::Emerald400 => Some("emerald-400"),
            Tone::Violet400 => Some("violet-400"),
            Tone::Red400 => Some("red-400"),
        }
    }
}

/// A chip's look: the quiet panel chip, or a tinted warning one
/// (`border-amber-500/40 bg-amber-500/10 text-amber-200`).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Chip {
    /// `border-[var(--border)] bg-[var(--panel-2)]`.
    Panel,
    /// `border-amber-500/40 bg-amber-500/10 text-amber-200`.
    Amber,
    /// `border-red-500/40 bg-red-500/10 text-red-200`.
    Red,
}
