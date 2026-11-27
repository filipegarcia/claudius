//! The colors the rail's Tailwind classes name, as data: the pure model
//! says which (`border-sky-500/30 bg-sky-500/10 text-sky-200`), the view
//! resolves them against the palette.

/// A color: a palette token or a Tailwind step (`"sky-500"`).
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Paint {
    /// `var(--border)`.
    Border,
    /// `var(--panel)`.
    Panel,
    /// `var(--panel-2)`.
    Panel2,
    /// `var(--muted)`.
    Muted,
    /// `var(--foreground)`.
    Foreground,
    /// `var(--accent)`.
    Accent,
    /// No class: the inherited color (the border's default).
    Inherit,
    Step(&'static str),
}

/// A color at an opacity (`/30` is `30.`, none is `100.`).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Ink {
    pub paint: Paint,
    pub alpha: f64,
}

impl Ink {
    pub const fn of(paint: Paint) -> Ink {
        Ink { paint, alpha: 100. }
    }

    pub const fn at(paint: Paint, alpha: f64) -> Ink {
        Ink { paint, alpha }
    }
}

/// A box's border, background and text colors.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Look {
    pub border: Ink,
    pub bg: Ink,
    pub text: Ink,
}

impl Look {
    /// `border-<hue>-500/<b> bg-<hue>-500/<g> text-<hue>-<t>`.
    pub const fn tint(border: &'static str, b: f64, bg: f64, text: &'static str) -> Look {
        Look {
            border: Ink::at(Paint::Step(border), b),
            bg: Ink::at(Paint::Step(border), bg),
            text: Ink::of(Paint::Step(text)),
        }
    }

    /// `border-[var(--border)] bg-[var(--panel-2)]/<bg> text-[var(--muted)]`.
    pub const fn quiet(bg: f64) -> Look {
        Look {
            border: Ink::of(Paint::Border),
            bg: Ink::at(Paint::Panel2, bg),
            text: Ink::of(Paint::Muted),
        }
    }

    /// The same box with the inherited (foreground) text.
    pub const fn plain_text(self) -> Look {
        Look {
            text: Ink::of(Paint::Inherit),
            ..self
        }
    }
}

/// `TASK_TONES` (BackgroundTasksPanel.tsx:196), by task status.
pub fn task_tone(status: &str) -> Option<Look> {
    Some(match status {
        "pending" => Look::quiet(100.),
        "running" => Look::tint("sky-500", 30., 10., "sky-200"),
        "completed" => Look::tint("emerald-500", 30., 10., "emerald-200"),
        "failed" | "killed" => Look::tint("red-500", 30., 10., "red-200"),
        "stopped" | "paused" => Look::tint("amber-500", 30., 10., "amber-200"),
        _ => return None,
    })
}

/// `TASK_TONES[t.status] ?? TASK_TONES.running`.
pub fn task_tone_or_running(status: &str) -> Look {
    task_tone(status).unwrap_or_else(|| task_tone("running").expect("running has a tone"))
}
