//! The Tailwind v4 defaults (`tailwindcss/theme.css`) behind the utilities
//! the React UI uses, and the font stacks.
//!
//! Scope: the theme variables Tailwind's compiler emits for the classes in
//! `app/`, `components/` and `lib/` (it only emits the ones a used utility
//! or rule reads), recorded as `themeVars` in the golden. Not ported: the
//! rest of the palette (only 40 of its 242 colors are used), the unused
//! scale steps (`text-4xl`+, `radius-xs`, `radius-3xl`+, `container-3xs`,
//! …), shadows, perspectives, aspect ratios, breakpoints, `--animate-bounce`
//! and the keyframes' bodies. Arbitrary values in class names
//! (`text-[11px]`, `max-w-[var(--chat-col)]`) aren't tokens; they belong to
//! the components that write them.

/// A CSS length in `rem`, and the root font size it is measured against.
/// The app never changes the root font size (no rule sets it, and the
/// Electron shell sets no zoom), so 1rem is the browser default 16px.
pub const REM_PX: f64 = 16.0;
/// Preflight's `html { line-height: 1.5 }`.
pub const ROOT_LINE_HEIGHT: f64 = 1.5;

/// A theme variable and its `theme.css` source text.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Token {
    pub name: &'static str,
    pub source: &'static str,
}

/// A length token: its source text and the number of `rem` it is.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Length {
    pub name: &'static str,
    pub source: &'static str,
    pub rem: f64,
}

impl Length {
    pub fn px(&self) -> f64 {
        self.rem * REM_PX
    }
}

/// `--spacing`: every spacing utility (`p-3`, `gap-1.5`, `-mt-2`, `w-64`,
/// `leading-5`, …) is `calc(var(--spacing) * <step>)`.
pub const SPACING: Length = Length {
    name: "--spacing",
    source: "0.25rem",
    rem: 0.25,
};

/// The px of a spacing step (`p-3` is `spacing_px(3.0)`, 12px).
pub fn spacing_px(step: f64) -> f64 {
    SPACING.px() * step
}

/// `max-w-*` / `w-*` container sizes the UI uses.
pub const CONTAINERS: [Length; 9] = [
    Length {
        name: "--container-xs",
        source: "20rem",
        rem: 20.0,
    },
    Length {
        name: "--container-sm",
        source: "24rem",
        rem: 24.0,
    },
    Length {
        name: "--container-md",
        source: "28rem",
        rem: 28.0,
    },
    Length {
        name: "--container-lg",
        source: "32rem",
        rem: 32.0,
    },
    Length {
        name: "--container-2xl",
        source: "42rem",
        rem: 42.0,
    },
    Length {
        name: "--container-3xl",
        source: "48rem",
        rem: 48.0,
    },
    Length {
        name: "--container-4xl",
        source: "56rem",
        rem: 56.0,
    },
    Length {
        name: "--container-5xl",
        source: "64rem",
        rem: 64.0,
    },
    Length {
        name: "--container-6xl",
        source: "72rem",
        rem: 72.0,
    },
];

/// `rounded-*` radii the UI uses.
pub const RADII: [Length; 5] = [
    Length {
        name: "--radius-sm",
        source: "0.25rem",
        rem: 0.25,
    },
    Length {
        name: "--radius-md",
        source: "0.375rem",
        rem: 0.375,
    },
    Length {
        name: "--radius-lg",
        source: "0.5rem",
        rem: 0.5,
    },
    Length {
        name: "--radius-xl",
        source: "0.75rem",
        rem: 0.75,
    },
    Length {
        name: "--radius-2xl",
        source: "1rem",
        rem: 1.0,
    },
];
/// Plain `rounded` (a literal in the utility, not a variable).
pub const ROUNDED_REM: f64 = 0.25;
/// `rounded-full` is `calc(infinity * 1px)`: a pill (half the shorter side).
pub const ROUNDED_FULL_PX: f64 = f64::INFINITY;

/// A `text-*` step: font size and its paired line height,
/// `calc(<num> / <den>)` (a ratio of the font size).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct TextStyle {
    /// The utility suffix (`xs` for `text-xs`).
    pub name: &'static str,
    pub size: Length,
    pub line_height_source: &'static str,
    pub line_height: (f64, f64),
}

impl TextStyle {
    pub fn size_px(&self) -> f64 {
        self.size.px()
    }

    pub fn line_height_ratio(&self) -> f64 {
        self.line_height.0 / self.line_height.1
    }

    pub fn line_height_px(&self) -> f64 {
        self.size_px() * self.line_height_ratio()
    }
}

macro_rules! text {
    ($n:literal, $size:literal, $rem:literal, $lh:literal, $num:literal, $den:literal) => {
        TextStyle {
            name: $n,
            size: Length {
                name: concat!("--text-", $n),
                source: $size,
                rem: $rem,
            },
            line_height_source: $lh,
            line_height: ($num, $den),
        }
    };
}

/// The type scale the UI uses (`text-xs` … `text-3xl`).
pub const TEXT: [TextStyle; 7] = [
    text!("xs", "0.75rem", 0.75, "calc(1 / 0.75)", 1.0, 0.75),
    text!("sm", "0.875rem", 0.875, "calc(1.25 / 0.875)", 1.25, 0.875),
    text!("base", "1rem", 1.0, "calc(1.5 / 1)", 1.5, 1.0),
    text!("lg", "1.125rem", 1.125, "calc(1.75 / 1.125)", 1.75, 1.125),
    text!("xl", "1.25rem", 1.25, "calc(1.75 / 1.25)", 1.75, 1.25),
    text!("2xl", "1.5rem", 1.5, "calc(2 / 1.5)", 2.0, 1.5),
    text!("3xl", "1.875rem", 1.875, "calc(2.25 / 1.875)", 2.25, 1.875),
];

/// `font-normal` / `font-medium` / `font-semibold`.
pub const WEIGHTS: [(Token, u16); 3] = [
    (
        Token {
            name: "--font-weight-normal",
            source: "400",
        },
        400,
    ),
    (
        Token {
            name: "--font-weight-medium",
            source: "500",
        },
        500,
    ),
    (
        Token {
            name: "--font-weight-semibold",
            source: "600",
        },
        600,
    ),
];

/// `tracking-*`, in `em` of the element's font size.
pub const TRACKING: [(Token, f64); 4] = [
    (
        Token {
            name: "--tracking-tight",
            source: "-0.025em",
        },
        -0.025,
    ),
    (
        Token {
            name: "--tracking-normal",
            source: "0em",
        },
        0.0,
    ),
    (
        Token {
            name: "--tracking-wide",
            source: "0.025em",
        },
        0.025,
    ),
    (
        Token {
            name: "--tracking-wider",
            source: "0.05em",
        },
        0.05,
    ),
];

/// `leading-*`, a ratio of the font size.
pub const LEADING: [(Token, f64); 3] = [
    (
        Token {
            name: "--leading-tight",
            source: "1.25",
        },
        1.25,
    ),
    (
        Token {
            name: "--leading-snug",
            source: "1.375",
        },
        1.375,
    ),
    (
        Token {
            name: "--leading-relaxed",
            source: "1.625",
        },
        1.625,
    ),
];

/// `blur-sm` / `blur-2xl` (backdrop and filter blur radii, px).
pub const BLUR: [(Token, f64); 2] = [
    (
        Token {
            name: "--blur-sm",
            source: "8px",
        },
        8.0,
    ),
    (
        Token {
            name: "--blur-2xl",
            source: "40px",
        },
        40.0,
    ),
];

/// `animate-spin` / `animate-ping` / `animate-pulse` (source text only).
pub const ANIMATIONS: [Token; 3] = [
    Token {
        name: "--animate-spin",
        source: "spin 1s linear infinite",
    },
    Token {
        name: "--animate-ping",
        source: "ping 1s cubic-bezier(0, 0, 0.2, 1) infinite",
    },
    Token {
        name: "--animate-pulse",
        source: "pulse 2s cubic-bezier(0.4, 0, 0.6, 1) infinite",
    },
];

/// `transition` / `transition-colors` defaults: 150 ms on
/// `cubic-bezier(0.4, 0, 0.2, 1)`.
pub const TRANSITION_DURATION: Token = Token {
    name: "--default-transition-duration",
    source: "150ms",
};
pub const TRANSITION_DURATION_MS: f64 = 150.0;
pub const TRANSITION_EASING: Token = Token {
    name: "--default-transition-timing-function",
    source: "cubic-bezier(0.4, 0, 0.2, 1)",
};
pub const TRANSITION_EASING_BEZIER: [f64; 4] = [0.4, 0.0, 0.2, 1.0];

/// The palette colors the UI's utilities use (`text-red-400`,
/// `bg-emerald-500/10`, …), as `theme.css` writes them. Resolve with
/// [`crate::color::parse`]; most of the saturated steps are outside sRGB.
pub const COLORS: [(&str, &str); 40] = [
    ("red-100", "oklch(93.6% 0.032 17.717)"),
    ("red-200", "oklch(88.5% 0.062 18.334)"),
    ("red-300", "oklch(80.8% 0.114 19.571)"),
    ("red-400", "oklch(70.4% 0.191 22.216)"),
    ("red-500", "oklch(63.7% 0.237 25.331)"),
    ("red-600", "oklch(57.7% 0.245 27.325)"),
    ("amber-100", "oklch(96.2% 0.059 95.617)"),
    ("amber-200", "oklch(92.4% 0.12 95.746)"),
    ("amber-300", "oklch(87.9% 0.169 91.605)"),
    ("amber-400", "oklch(82.8% 0.189 84.429)"),
    ("amber-500", "oklch(76.9% 0.188 70.08)"),
    ("emerald-100", "oklch(95% 0.052 163.051)"),
    ("emerald-200", "oklch(90.5% 0.093 164.15)"),
    ("emerald-300", "oklch(84.5% 0.143 164.978)"),
    ("emerald-400", "oklch(76.5% 0.177 163.223)"),
    ("emerald-500", "oklch(69.6% 0.17 162.48)"),
    ("teal-300", "oklch(85.5% 0.138 181.071)"),
    ("teal-500", "oklch(70.4% 0.14 182.503)"),
    ("cyan-400", "oklch(78.9% 0.154 211.53)"),
    ("sky-200", "oklch(90.1% 0.058 230.902)"),
    ("sky-300", "oklch(82.8% 0.111 230.318)"),
    ("sky-400", "oklch(74.6% 0.16 232.661)"),
    ("sky-500", "oklch(68.5% 0.169 237.323)"),
    ("violet-100", "oklch(94.3% 0.029 294.588)"),
    ("violet-200", "oklch(89.4% 0.057 293.283)"),
    ("violet-300", "oklch(81.1% 0.111 293.571)"),
    ("violet-400", "oklch(70.2% 0.183 293.541)"),
    ("violet-500", "oklch(60.6% 0.25 292.717)"),
    ("purple-300", "oklch(82.7% 0.119 306.383)"),
    ("purple-400", "oklch(71.4% 0.203 305.504)"),
    ("fuchsia-200", "oklch(90.3% 0.076 319.62)"),
    ("fuchsia-400", "oklch(74% 0.238 322.16)"),
    ("fuchsia-500", "oklch(66.7% 0.295 322.15)"),
    ("rose-300", "oklch(81% 0.117 11.638)"),
    ("rose-400", "oklch(71.2% 0.194 13.428)"),
    ("rose-500", "oklch(64.5% 0.246 16.439)"),
    ("zinc-300", "oklch(87.1% 0.006 286.286)"),
    ("zinc-500", "oklch(55.2% 0.016 285.938)"),
    ("black", "#000"),
    ("white", "#fff"),
];

/// A Tailwind palette color by utility name (`"red-400"`).
pub fn color(name: &str) -> Option<crate::color::Rgba> {
    COLORS
        .iter()
        .find(|(n, _)| *n == name)
        .and_then(|(_, src)| crate::color::parse(src))
}

/// globals.css's `@theme inline` font variables: `font-sans` / `font-mono`
/// (and preflight's defaults for `html` and `code` / `pre` / `kbd`) read the
/// two variables next/font sets on `<html>`.
pub const FONT_SANS_SOURCE: &str = "var(--font-geist-sans)";
pub const FONT_MONO_SOURCE: &str = "var(--font-geist-mono)";
/// `theme.css`'s `--default-font-family` / `--default-mono-font-family`,
/// which `@theme inline` turns into the two above.
pub const DEFAULT_FONT_FAMILY_SOURCE: &str = "--theme(--font-sans, initial)";
pub const DEFAULT_MONO_FONT_FAMILY_SOURCE: &str = "--theme(--font-mono, initial)";
/// What next/font writes for `--font-geist-sans` / `--font-geist-mono`:
/// Geist (Google Fonts, OFL) and a metric-matched local Arial face.
pub const FONT_SANS: [&str; 2] = ["Geist", "Geist Fallback"];
pub const FONT_MONO: [&str; 2] = ["Geist Mono", "Geist Mono Fallback"];
/// The `body` rule's stack after `var(--font-sans)`.
pub const BODY_FONT_FALLBACKS: [&str; 8] = [
    "ui-sans-serif",
    "system-ui",
    "-apple-system",
    "Segoe UI",
    "Roboto",
    "Helvetica",
    "Arial",
    "sans-serif",
];
/// The Shiki host's stack after `var(--font-mono)` (highlighted code).
pub const CODE_FONT_FALLBACKS: [&str; 6] = [
    "ui-monospace",
    "SFMono-Regular",
    "Menlo",
    "Monaco",
    "Liberation Mono",
    "monospace",
];

/// The body text's font families, first choice first.
pub fn body_font_family() -> Vec<&'static str> {
    FONT_SANS
        .iter()
        .chain(BODY_FONT_FALLBACKS.iter())
        .copied()
        .collect()
}

/// Highlighted code's font families (`.shiki-host pre`).
pub fn code_font_family() -> Vec<&'static str> {
    FONT_MONO
        .iter()
        .chain(CODE_FONT_FALLBACKS.iter())
        .copied()
        .collect()
}
