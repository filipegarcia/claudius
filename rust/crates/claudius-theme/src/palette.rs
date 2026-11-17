//! The seven `data-theme` palettes of `app/globals.css`, their chart series
//! colors, and the few theme-dependent chrome colors the stylesheet sets
//! outside the palette (selection, scrollbar, find highlight).

use crate::color::{self, Rgba};

/// A `data-theme` value (`ThemeId` in `lib/client/theme.ts`), in the order
/// of its `THEMES` list.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum ThemeName {
    Dark,
    Light,
    Midnight,
    Paper,
    Tui,
    TuiLight,
    Synthwave,
}

impl ThemeName {
    /// `THEMES` order.
    pub const ALL: [ThemeName; 7] = [
        ThemeName::Dark,
        ThemeName::Light,
        ThemeName::Midnight,
        ThemeName::Paper,
        ThemeName::Tui,
        ThemeName::TuiLight,
        ThemeName::Synthwave,
    ];

    /// The TS `DEFAULT`, and what `:root` alone (no or an unknown
    /// `data-theme`) resolves to in the stylesheet.
    pub const DEFAULT: ThemeName = ThemeName::Dark;

    /// The `data-theme` / storage id.
    pub fn id(self) -> &'static str {
        match self {
            ThemeName::Dark => "dark",
            ThemeName::Light => "light",
            ThemeName::Midnight => "midnight",
            ThemeName::Paper => "paper",
            ThemeName::Tui => "tui",
            ThemeName::TuiLight => "tui-light",
            ThemeName::Synthwave => "synthwave",
        }
    }

    /// The exact id (case-sensitive, untrimmed), as `THEMES.some((t) =>
    /// t.id === saved)` matches.
    pub fn from_id(id: &str) -> Option<ThemeName> {
        ThemeName::ALL.into_iter().find(|t| t.id() == id)
    }

    /// The `THEMES` label shown by the settings picker.
    pub fn label(self) -> &'static str {
        match self {
            ThemeName::Dark => "Dark",
            ThemeName::Light => "Light",
            ThemeName::Midnight => "Midnight",
            ThemeName::Paper => "Paper",
            ThemeName::Tui => "TUI",
            ThemeName::TuiLight => "TUI Light",
            ThemeName::Synthwave => "Synthwave",
        }
    }

    /// The `THEMES` swatch (`preview.bg`, `preview.accent`): the TS copies
    /// them by hand; they equal the palette's `--background` / `--accent`.
    pub fn preview(self) -> (&'static str, &'static str) {
        let p = self.source();
        (p.background, p.accent)
    }

    /// Whether the theme takes the dark chart series steps (the
    /// stylesheet's grouping, which is also the light / dark split for a
    /// toolkit theme mode).
    pub fn is_dark(self) -> bool {
        matches!(
            self,
            ThemeName::Dark | ThemeName::Midnight | ThemeName::Tui | ThemeName::Synthwave
        )
    }

    /// The palette's CSS source text.
    pub fn source(self) -> &'static PaletteSource {
        match self {
            ThemeName::Dark => &DARK,
            ThemeName::Light => &LIGHT,
            ThemeName::Midnight => &MIDNIGHT,
            ThemeName::Paper => &PAPER,
            ThemeName::Tui => &TUI,
            ThemeName::TuiLight => &TUI_LIGHT,
            ThemeName::Synthwave => &SYNTHWAVE,
        }
    }

    /// The chart series' CSS source text.
    pub fn series_source(self) -> &'static SeriesSource {
        if self.is_dark() {
            &SERIES_DARK
        } else {
            &SERIES_LIGHT
        }
    }

    /// The theme the stylesheet applies for a `data-theme` attribute value:
    /// a known id is that theme, and anything else (no attribute,
    /// `"toString"`, `"Dark"`) only matches `:root`, the dark values.
    pub fn for_attribute(attr: Option<&str>) -> ThemeName {
        attr.and_then(ThemeName::from_id)
            .unwrap_or(ThemeName::DEFAULT)
    }
}

/// One palette block's declarations, as written (`--background` …
/// `--accent`).
#[derive(Debug, PartialEq, Eq)]
pub struct PaletteSource {
    pub background: &'static str,
    pub foreground: &'static str,
    pub panel: &'static str,
    pub panel_2: &'static str,
    pub border: &'static str,
    pub muted: &'static str,
    pub accent: &'static str,
}

impl PaletteSource {
    /// `(custom property, source text)` in declaration order.
    pub fn entries(&self) -> [(&'static str, &'static str); 7] {
        [
            ("--background", self.background),
            ("--foreground", self.foreground),
            ("--panel", self.panel),
            ("--panel-2", self.panel_2),
            ("--border", self.border),
            ("--muted", self.muted),
            ("--accent", self.accent),
        ]
    }
}

/// A chart series block (`--series-1` … `--series-6`, `--series-other`).
#[derive(Debug, PartialEq, Eq)]
pub struct SeriesSource {
    pub series: [&'static str; 6],
    pub other: &'static str,
}

impl SeriesSource {
    /// `(custom property, source text)` in declaration order.
    pub fn entries(&self) -> [(&'static str, &'static str); 7] {
        let s = &self.series;
        [
            ("--series-1", s[0]),
            ("--series-2", s[1]),
            ("--series-3", s[2]),
            ("--series-4", s[3]),
            ("--series-5", s[4]),
            ("--series-6", s[5]),
            ("--series-other", self.other),
        ]
    }
}

pub const DARK: PaletteSource = PaletteSource {
    background: "#0b0b0c",
    foreground: "#e7e7ea",
    panel: "#131316",
    panel_2: "#1a1a1f",
    border: "#2a2a31",
    muted: "#9a9aa3",
    accent: "#d97757",
};
pub const LIGHT: PaletteSource = PaletteSource {
    background: "#fafafa",
    foreground: "#1a1a1f",
    panel: "#ffffff",
    panel_2: "#f1efe9",
    border: "#d8d4cc",
    muted: "#6b6b71",
    accent: "#c0531a",
};
pub const MIDNIGHT: PaletteSource = PaletteSource {
    background: "#070914",
    foreground: "#d7defa",
    panel: "#0c0f1d",
    panel_2: "#131831",
    border: "#1f2747",
    muted: "#6f7aa3",
    accent: "#8b9bff",
};
pub const PAPER: PaletteSource = PaletteSource {
    background: "#f6f1e7",
    foreground: "#2a2118",
    panel: "#fbf7ee",
    panel_2: "#efe8d7",
    border: "#d6cdb8",
    muted: "#7d6e58",
    accent: "#7c4a2a",
};
pub const TUI: PaletteSource = PaletteSource {
    background: "#000000",
    foreground: "#e6e6e3",
    panel: "#0a0a0a",
    panel_2: "#141414",
    border: "#2d2d2d",
    muted: "#707070",
    accent: "#f5a524",
};
pub const TUI_LIGHT: PaletteSource = PaletteSource {
    background: "#fafaf7",
    foreground: "#0a0a0a",
    panel: "#ffffff",
    panel_2: "#f0eee8",
    border: "#d4d0c4",
    muted: "#6b6b6b",
    accent: "#b45309",
};
pub const SYNTHWAVE: PaletteSource = PaletteSource {
    background: "#14092b",
    foreground: "#f8e6ff",
    panel: "#1c1138",
    panel_2: "#261a4a",
    border: "#4a2d7a",
    muted: "#a98ad1",
    accent: "#ff6ad5",
};

/// The dark steps (`:root` and the dark themes).
pub const SERIES_DARK: SeriesSource = SeriesSource {
    series: [
        "#3987e5", "#d95926", "#199e70", "#c98500", "#d55181", "#008300",
    ],
    other: "#5f5f66",
};
/// The light steps (light, paper, tui-light).
pub const SERIES_LIGHT: SeriesSource = SeriesSource {
    series: [
        "#2a78d6", "#eb6834", "#1baf7a", "#eda100", "#e87ba4", "#008300",
    ],
    other: "#b9b6ae",
};

/// `@theme inline`'s color names: Tailwind utilities (`bg-panel`,
/// `text-muted`, …) that read the palette variable of the same name.
pub const INLINE_COLORS: [(&str, &str); 7] = [
    ("--color-background", "var(--background)"),
    ("--color-foreground", "var(--foreground)"),
    ("--color-panel", "var(--panel)"),
    ("--color-panel-2", "var(--panel-2)"),
    ("--color-border", "var(--border)"),
    ("--color-muted", "var(--muted)"),
    ("--color-accent", "var(--accent)"),
];

/// `::selection`'s background on every theme but synthwave.
pub const SELECTION: &str = "rgba(217, 119, 87, 0.35)";
/// `:root[data-theme="synthwave"] ::selection`.
pub const SELECTION_SYNTHWAVE: &str = "rgba(255, 106, 213, 0.4)";
/// `::highlight(transcript-find)` (every Cmd+F hit) and its text color.
pub const FIND_HIGHLIGHT: &str = "#ffe14d";
/// `::highlight(transcript-find-current)`.
pub const FIND_HIGHLIGHT_CURRENT: &str = "#ff9632";
/// The text color of both find highlights.
pub const FIND_HIGHLIGHT_TEXT: &str = "#111";
/// `.scroll-thin::-webkit-scrollbar` width and height, and the thumb's
/// radius (px). The thumb is `var(--border)`.
pub const SCROLLBAR_PX: f64 = 8.0;
pub const SCROLLBAR_THUMB_RADIUS_PX: f64 = 4.0;
/// `.scroll-thin::-webkit-scrollbar-thumb:hover`'s background.
pub const SCROLLBAR_THUMB_HOVER: &str =
    "color-mix(in oklab, var(--border) 60%, var(--foreground) 40%)";
/// `--titlebar-height`: 0 in the browser, 32px under `html[data-electron]`
/// (the frameless window's title bar, also the body's top padding there).
pub const TITLEBAR_HEIGHT_PX: f64 = 0.0;
pub const TITLEBAR_HEIGHT_ELECTRON_PX: f64 = 32.0;

/// A palette resolved to sRGB.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Palette {
    pub background: Rgba,
    pub foreground: Rgba,
    pub panel: Rgba,
    pub panel_2: Rgba,
    pub border: Rgba,
    pub muted: Rgba,
    pub accent: Rgba,
    /// `--series-1` … `--series-6`.
    pub series: [Rgba; 6],
    pub series_other: Rgba,
}

fn hex(s: &str) -> Rgba {
    color::parse(s).unwrap_or_else(|| panic!("token {s:?} is not a color"))
}

impl Palette {
    pub fn of(name: ThemeName) -> Palette {
        let p = name.source();
        let s = name.series_source();
        Palette {
            background: hex(p.background),
            foreground: hex(p.foreground),
            panel: hex(p.panel),
            panel_2: hex(p.panel_2),
            border: hex(p.border),
            muted: hex(p.muted),
            accent: hex(p.accent),
            series: s.series.map(hex),
            series_other: hex(s.other),
        }
    }

    /// A palette or series custom property by name (`--panel-2`,
    /// `--series-other`, or an `@theme inline` alias like
    /// `--color-accent`).
    pub fn var(&self, name: &str) -> Option<Rgba> {
        let name = INLINE_COLORS
            .iter()
            .find(|(alias, _)| *alias == name)
            .map_or(name, |(_, v)| &v[4..v.len() - 1]);
        Some(match name {
            "--background" => self.background,
            "--foreground" => self.foreground,
            "--panel" => self.panel,
            "--panel-2" => self.panel_2,
            "--border" => self.border,
            "--muted" => self.muted,
            "--accent" => self.accent,
            "--series-1" => self.series[0],
            "--series-2" => self.series[1],
            "--series-3" => self.series[2],
            "--series-4" => self.series[3],
            "--series-5" => self.series[4],
            "--series-6" => self.series[5],
            "--series-other" => self.series_other,
            _ => return None,
        })
    }
}

/// One theme: its name, resolved palette and chrome colors.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Theme {
    pub name: ThemeName,
    pub palette: Palette,
    /// `::selection`'s background.
    pub selection: Rgba,
    /// The `.scroll-thin` thumb on hover.
    pub scrollbar_thumb_hover: Rgba,
}

impl Theme {
    pub fn of(name: ThemeName) -> Theme {
        let palette = Palette::of(name);
        let selection = if name == ThemeName::Synthwave {
            SELECTION_SYNTHWAVE
        } else {
            SELECTION
        };
        Theme {
            name,
            palette,
            selection: hex(selection),
            scrollbar_thumb_hover: color::mix_oklab(palette.border, 60.0, palette.foreground, 40.0)
                .unwrap_or(palette.border),
        }
    }

    pub fn is_dark(&self) -> bool {
        self.name.is_dark()
    }

    /// The color of any element's border. globals.css's unlayered
    /// `* { border-color: var(--border) }` beats every Tailwind border
    /// color utility (they sit in `@layer utilities`), so in Chromium a
    /// `border-red-500` / `border-[var(--accent)]` / `focus-within:` border
    /// class never shows: only an inline `style={{ borderColor }}` does.
    pub fn border_color(&self, inline: Option<Rgba>) -> Rgba {
        inline.unwrap_or(self.palette.border)
    }
}
