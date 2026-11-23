//! Every gpui-component `ThemeColor` field, and where its color comes from
//! in the React UI.
//!
//! gpui-component names colors by component role (`button_primary`,
//! `list_hover`, `tab_active`), the React UI by surface (`--panel`,
//! `--panel-2`, `--accent`) plus the Tailwind steps its class names use
//! (`text-red-300`, `bg-amber-500/10`). [`COLORS`] is the bridge: one row per
//! field, naming the token (or the derivation from tokens) and the React
//! class it stands for. No row holds a color literal: every color resolves
//! through `claudius-theme` ([`Source::resolve`]).
//!
//! Two name clashes to keep in mind. gpui's `accent` is the hover fill of
//! menu items and list rows (React's `hover:bg-[var(--panel-2)]`), while
//! React's `--accent` is the brand color, which is gpui's `primary`. And
//! gpui's `muted` is a background (skeletons, an off switch), while React's
//! `--muted` is a text color, which is gpui's `muted_foreground`.

use claudius_theme::{Rgba, Theme as Tokens, color, tailwind};

/// Where a [`COLORS`] row's color comes from.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Source {
    /// A palette custom property (`var(--panel-2)`, `var(--series-3)`).
    Var(&'static str),
    /// The same with Tailwind's `/N` opacity modifier
    /// (`bg-[var(--accent)]/15`): `color-mix(in oklab, … N%, transparent)`.
    VarAlpha(&'static str, f64),
    /// A Tailwind palette step (`text-red-300`, `text-white`).
    Step(&'static str),
    /// The same with `/N` (`bg-red-500/10`, `bg-black/60`).
    StepAlpha(&'static str, f64),
    /// `::selection`'s background (theme-dependent: synthwave has its own).
    Selection,
    /// `.scroll-thin`'s thumb on hover,
    /// `color-mix(in oklab, var(--border) 60%, var(--foreground) 40%)`.
    ScrollbarThumbHover,
    /// CSS `transparent`: the React element paints no background.
    Transparent,
}

impl Source {
    /// The color in a theme, as Chromium resolves it (unclamped sRGB).
    ///
    /// Panics on a name `claudius-theme` doesn't have: the table is static,
    /// and `tests/mapping.rs` resolves every row in every theme.
    pub fn resolve(self, theme: &Tokens) -> Rgba {
        let var = |name: &str| {
            theme
                .palette
                .var(name)
                .unwrap_or_else(|| panic!("{name} is not a palette variable"))
        };
        let step = |name: &str| {
            tailwind::color(name).unwrap_or_else(|| panic!("{name} is not a Tailwind step"))
        };
        match self {
            Source::Var(name) => var(name),
            Source::VarAlpha(name, pct) => color::with_opacity(var(name), pct),
            Source::Step(name) => step(name),
            Source::StepAlpha(name, pct) => color::with_opacity(step(name), pct),
            Source::Selection => theme.selection,
            Source::ScrollbarThumbHover => theme.scrollbar_thumb_hover,
            Source::Transparent => Rgba::TRANSPARENT,
        }
    }
}

/// One `ThemeColor` field.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Color {
    /// The `ThemeColor` field.
    pub field: &'static str,
    /// Its key in a gpui-component theme file (`ThemeConfigColors`).
    pub key: &'static str,
    pub source: Source,
    /// What it stands for in the React UI (the class names, and the reason
    /// where the mapping isn't 1:1).
    pub react: &'static str,
}

const fn c(field: &'static str, key: &'static str, source: Source, react: &'static str) -> Color {
    Color {
        field,
        key,
        source,
        react,
    }
}

use Source::{ScrollbarThumbHover, Selection, Step, StepAlpha, Transparent, Var, VarAlpha};

/// Every `ThemeColor` field of gpui-component 0.10, in declaration order.
/// `tests/mapping.rs` fails when a gpui-component bump adds, renames or
/// drops one.
pub const COLORS: [Color; 140] = [
    c(
        "accent",
        "accent.background",
        Var("--panel-2"),
        "hover:bg-[var(--panel-2)], the UI's row and menu-item hover (204 uses); not React's --accent, which is `primary`",
    ),
    c(
        "accent_foreground",
        "accent.foreground",
        Var("--foreground"),
        "a hovered row keeps its text color",
    ),
    c(
        "accordion",
        "accordion.background",
        Var("--panel"),
        "collapsible cards and sections sit on bg-[var(--panel)]",
    ),
    c(
        "background",
        "background",
        Var("--background"),
        "body { background: var(--background) }",
    ),
    c(
        "border",
        "border",
        Var("--border"),
        "* { border-color: var(--border) }",
    ),
    c(
        "button",
        "button.background",
        Transparent,
        "most <button>s have no background (136 of 262) and only fill on hover",
    ),
    c(
        "button_active",
        "button.active.background",
        Var("--panel-2"),
        "the UI has no :active styles: the hover fill",
    ),
    c(
        "button_foreground",
        "button.foreground",
        Var("--muted"),
        "text-[var(--muted)], the commonest text class on a <button> (78), with hover:text-[var(--foreground)]",
    ),
    c(
        "button_hover",
        "button.hover.background",
        Var("--panel-2"),
        "hover:bg-[var(--panel-2)]",
    ),
    c(
        "button_danger",
        "button.danger.background",
        StepAlpha("red-500", 10.0),
        "destructive buttons are soft: bg-red-500/10",
    ),
    c(
        "button_danger_active",
        "button.danger.active.background",
        StepAlpha("red-500", 20.0),
        "no :active styles: the hover fill",
    ),
    c(
        "button_danger_foreground",
        "button.danger.foreground",
        Step("red-300"),
        "text-red-300",
    ),
    c(
        "button_danger_hover",
        "button.danger.hover.background",
        StepAlpha("red-500", 20.0),
        "hover:bg-red-500/20",
    ),
    c(
        "button_info",
        "button.info.background",
        StepAlpha("sky-500", 10.0),
        "the soft danger / warning pattern in sky, the UI's info hue (53 sky classes)",
    ),
    c(
        "button_info_active",
        "button.info.active.background",
        StepAlpha("sky-500", 20.0),
        "no :active styles: the hover fill",
    ),
    c(
        "button_info_foreground",
        "button.info.foreground",
        Step("sky-300"),
        "text-sky-300",
    ),
    c(
        "button_info_hover",
        "button.info.hover.background",
        StepAlpha("sky-500", 20.0),
        "the soft pattern's hover (/20)",
    ),
    c(
        "button_primary",
        "button.primary.background",
        Var("--accent"),
        "bg-[var(--accent)] text-white hover:opacity-90 (43 <button>s)",
    ),
    c(
        "button_primary_active",
        "button.primary.active.background",
        VarAlpha("--accent", 90.0),
        "no :active styles: the hover fill",
    ),
    c(
        "button_primary_foreground",
        "button.primary.foreground",
        Step("white"),
        "text-white",
    ),
    c(
        "button_primary_hover",
        "button.primary.hover.background",
        VarAlpha("--accent", 90.0),
        "hover:opacity-90: the fill at 90% over what is behind it (the label stays opaque here)",
    ),
    c(
        "button_secondary",
        "button.secondary.background",
        Var("--panel-2"),
        "filled neutral buttons: bg-[var(--panel-2)] (33 <button>s)",
    ),
    c(
        "button_secondary_active",
        "button.secondary.active.background",
        Var("--panel"),
        "no :active styles: the hover fill",
    ),
    c(
        "button_secondary_foreground",
        "button.secondary.foreground",
        Var("--foreground"),
        "hover:text-[var(--foreground)]; at rest they inherit the foreground",
    ),
    c(
        "button_secondary_hover",
        "button.secondary.hover.background",
        Var("--panel"),
        "hover:bg-[var(--panel)] (83, tied with a no-op hover:bg-[var(--panel-2)])",
    ),
    c(
        "button_success",
        "button.success.background",
        StepAlpha("emerald-500", 10.0),
        "bg-emerald-500/10",
    ),
    c(
        "button_success_active",
        "button.success.active.background",
        StepAlpha("emerald-500", 20.0),
        "no :active styles: the hover fill",
    ),
    c(
        "button_success_foreground",
        "button.success.foreground",
        Step("emerald-300"),
        "text-emerald-300",
    ),
    c(
        "button_success_hover",
        "button.success.hover.background",
        StepAlpha("emerald-500", 20.0),
        "the soft pattern's hover (/20)",
    ),
    c(
        "button_warning",
        "button.warning.background",
        StepAlpha("amber-500", 10.0),
        "bg-amber-500/10",
    ),
    c(
        "button_warning_active",
        "button.warning.active.background",
        StepAlpha("amber-500", 20.0),
        "no :active styles: the hover fill",
    ),
    c(
        "button_warning_foreground",
        "button.warning.foreground",
        Step("amber-300"),
        "text-amber-300",
    ),
    c(
        "button_warning_hover",
        "button.warning.hover.background",
        StepAlpha("amber-500", 20.0),
        "hover:bg-amber-500/20",
    ),
    c(
        "group_box",
        "group_box.background",
        Var("--panel"),
        "bordered panels: rounded-lg border bg-[var(--panel)]",
    ),
    c(
        "group_box_foreground",
        "group_box.foreground",
        Var("--foreground"),
        "their text",
    ),
    c(
        "caret",
        "caret",
        Var("--foreground"),
        "no caret-color rule: Chromium draws the caret in currentColor",
    ),
    c("chart_1", "chart.1", Var("--series-1"), "--series-1"),
    c("chart_2", "chart.2", Var("--series-2"), "--series-2"),
    c("chart_3", "chart.3", Var("--series-3"), "--series-3"),
    c("chart_4", "chart.4", Var("--series-4"), "--series-4"),
    c(
        "chart_5",
        "chart.5",
        Var("--series-5"),
        "--series-5 (--series-6 and --series-other have no field: crate::chart_series)",
    ),
    c(
        "chart_bullish",
        "chart.bullish",
        Step("emerald-400"),
        "no candlestick charts in the UI: its success text, text-emerald-400",
    ),
    c(
        "chart_bearish",
        "chart.bearish",
        Step("red-400"),
        "no candlestick charts in the UI: its error text, text-red-400",
    ),
    c(
        "chart_grid",
        "chart.grid",
        StepAlpha("white", 5.0),
        "<CartesianGrid stroke=\"rgba(255,255,255,0.05)\"> (white/5, the same on light themes)",
    ),
    c(
        "danger",
        "danger.background",
        Step("red-500"),
        "solid destructive fills: bg-red-500 (TrafficLights, CommitBox)",
    ),
    c(
        "danger_active",
        "danger.active.background",
        Step("red-600"),
        "no :active styles: the hover fill",
    ),
    c(
        "danger_foreground",
        "danger.foreground",
        Step("white"),
        "hover:text-white on them",
    ),
    c(
        "danger_hover",
        "danger.hover.background",
        Step("red-600"),
        "hover:bg-red-600",
    ),
    c(
        "description_list_label",
        "description_list.label.background",
        Transparent,
        "key / value grids put the label in text-[var(--muted)] on no background",
    ),
    c(
        "description_list_label_foreground",
        "description_list.label.foreground",
        Var("--muted"),
        "text-[var(--muted)]",
    ),
    c(
        "drag_border",
        "drag.border",
        Var("--accent"),
        "drop zones: border-[var(--accent)]",
    ),
    c(
        "drop_target",
        "drop_target.background",
        VarAlpha("--accent", 10.0),
        "bg-[var(--accent)]/10",
    ),
    c(
        "foreground",
        "foreground",
        Var("--foreground"),
        "body { color: var(--foreground) }",
    ),
    c(
        "info",
        "info.background",
        Step("sky-500"),
        "no solid info fill in the UI: sky-500, the soft pattern's step",
    ),
    c(
        "info_active",
        "info.active.background",
        StepAlpha("sky-500", 90.0),
        "the solid fills' hover:opacity-90",
    ),
    c(
        "info_foreground",
        "info.foreground",
        Step("white"),
        "text-white, as on the accent fill",
    ),
    c(
        "info_hover",
        "info.hover.background",
        StepAlpha("sky-500", 90.0),
        "hover:opacity-90",
    ),
    c(
        "input",
        "input.border",
        Var("--border"),
        "inputs: border border-[var(--border)]",
    ),
    c(
        "link",
        "link",
        Var("--accent"),
        "text-[var(--accent)] hover:underline",
    ),
    c(
        "link_active",
        "link.active",
        Var("--accent"),
        "no :active styles",
    ),
    c(
        "link_hover",
        "link.hover",
        Var("--accent"),
        "hover only adds the underline",
    ),
    c(
        "list",
        "list.background",
        Transparent,
        "rows have no background until hovered",
    ),
    c(
        "list_active",
        "list.active.background",
        VarAlpha("--accent", 15.0),
        "selected rows: bg-[var(--accent)]/15 text-[var(--accent)] (gpui caps this field at 20% alpha)",
    ),
    c(
        "list_active_border",
        "list.active.border",
        Var("--accent"),
        "the accent of the selected row",
    ),
    c(
        "list_even",
        "list.even.background",
        Transparent,
        "no striped lists",
    ),
    c(
        "list_head",
        "list.head.background",
        Var("--panel"),
        "sticky list headers sit on bg-[var(--panel)]",
    ),
    c(
        "list_hover",
        "list.hover.background",
        Var("--panel-2"),
        "hover:bg-[var(--panel-2)]",
    ),
    c(
        "list_highlight_foreground",
        "list.highlight.foreground",
        Var("--accent"),
        "matched characters in pickers: text-[var(--accent)]",
    ),
    c(
        "muted",
        "muted.background",
        Var("--panel-2"),
        "muted fills (skeletons, off tracks): bg-[var(--panel-2)]; React's --muted is a text color",
    ),
    c(
        "muted_foreground",
        "muted.foreground",
        Var("--muted"),
        "text-[var(--muted)]",
    ),
    c(
        "popover",
        "popover.background",
        Var("--panel"),
        "menus and popovers: bg-[var(--panel)] shadow-lg / shadow-2xl",
    ),
    c(
        "popover_foreground",
        "popover.foreground",
        Var("--foreground"),
        "their text",
    ),
    c(
        "primary",
        "primary.background",
        Var("--accent"),
        "bg-[var(--accent)], the brand fill",
    ),
    c(
        "primary_active",
        "primary.active.background",
        VarAlpha("--accent", 90.0),
        "no :active styles: the hover fill",
    ),
    c(
        "primary_foreground",
        "primary.foreground",
        Step("white"),
        "text-white on the accent (76 of 129)",
    ),
    c(
        "primary_hover",
        "primary.hover.background",
        VarAlpha("--accent", 90.0),
        "hover:opacity-90 (59)",
    ),
    c(
        "progress_bar",
        "progress.bar.background",
        Var("--accent"),
        "progress fills: bg-[var(--accent)]",
    ),
    c(
        "ring",
        "ring",
        Var("--accent"),
        "focus:ring-[var(--accent)] / focus:border-[var(--accent)]",
    ),
    c(
        "scrollbar",
        "scrollbar.background",
        Transparent,
        ".scroll-thin styles no track: it is transparent",
    ),
    c(
        "scrollbar_thumb",
        "scrollbar.thumb.background",
        Var("--border"),
        ".scroll-thin::-webkit-scrollbar-thumb { background: var(--border) }",
    ),
    c(
        "scrollbar_thumb_hover",
        "scrollbar.thumb.hover.background",
        ScrollbarThumbHover,
        ".scroll-thin::-webkit-scrollbar-thumb:hover",
    ),
    c(
        "secondary",
        "secondary.background",
        Var("--panel-2"),
        "filled neutral surfaces: bg-[var(--panel-2)]",
    ),
    c(
        "secondary_active",
        "secondary.active.background",
        Var("--panel"),
        "no :active styles: the hover fill",
    ),
    c(
        "secondary_foreground",
        "secondary.foreground",
        Var("--foreground"),
        "their text",
    ),
    c(
        "secondary_hover",
        "secondary.hover.background",
        Var("--panel"),
        "hover:bg-[var(--panel)]",
    ),
    c(
        "selection",
        "selection.background",
        Selection,
        "::selection (35% / synthwave 40% alpha; gpui's theme file caps it at 30%, crate::apply restores it)",
    ),
    c(
        "sidebar",
        "sidebar.background",
        Var("--panel"),
        "the session rail: bg-[var(--panel)]",
    ),
    c(
        "sidebar_accent",
        "sidebar.accent.background",
        Var("--panel-2"),
        "rail rows: hover:bg-[var(--panel-2)]",
    ),
    c(
        "sidebar_accent_foreground",
        "sidebar.accent.foreground",
        Var("--foreground"),
        "a hovered row keeps its text color",
    ),
    c(
        "sidebar_border",
        "sidebar.border",
        Var("--border"),
        "border-[var(--border)]",
    ),
    c(
        "sidebar_foreground",
        "sidebar.foreground",
        Var("--foreground"),
        "the rail's text",
    ),
    c(
        "sidebar_primary",
        "sidebar.primary.background",
        Var("--accent"),
        "the rail's accent fill",
    ),
    c(
        "sidebar_primary_foreground",
        "sidebar.primary.foreground",
        Step("white"),
        "text-white on it",
    ),
    c(
        "skeleton",
        "skeleton.background",
        Var("--panel-2"),
        "animate-pulse placeholders: bg-[var(--panel-2)]",
    ),
    c(
        "slider_bar",
        "slider.background",
        Var("--accent"),
        "range inputs take accent-[var(--accent)]: Chromium fills the track with it",
    ),
    c(
        "slider_thumb",
        "slider.thumb.background",
        Var("--accent"),
        "and the thumb",
    ),
    c(
        "success",
        "success.background",
        Step("emerald-500"),
        "solid success fills: bg-emerald-500",
    ),
    c(
        "success_foreground",
        "success.foreground",
        Step("white"),
        "text-white, as on the accent fill",
    ),
    c(
        "success_hover",
        "success.hover.background",
        StepAlpha("emerald-500", 90.0),
        "hover:opacity-90",
    ),
    c(
        "success_active",
        "success.active.background",
        StepAlpha("emerald-500", 90.0),
        "no :active styles: the hover fill",
    ),
    c(
        "switch",
        "switch.background",
        Var("--border"),
        "no switch control in the UI: the off track takes the border color (on is `primary`)",
    ),
    c(
        "switch_thumb",
        "switch.thumb.background",
        Step("white"),
        "a white knob, as text-white on the accent",
    ),
    c(
        "tab",
        "tab.background",
        Transparent,
        "inactive tabs have no background",
    ),
    c(
        "tab_active",
        "tab.active.background",
        VarAlpha("--accent", 20.0),
        "the selected tab: bg-[var(--accent)]/20 text-[var(--foreground)] (GitFileView's role=tab)",
    ),
    c(
        "tab_active_foreground",
        "tab.active.foreground",
        Var("--foreground"),
        "text-[var(--foreground)]",
    ),
    c(
        "tab_bar",
        "tab_bar.background",
        Var("--panel"),
        "tab strips sit on bg-[var(--panel)]",
    ),
    c(
        "tab_bar_segmented",
        "tab_bar.segmented.background",
        Var("--panel-2"),
        "segmented controls: a bg-[var(--panel-2)] trough",
    ),
    c(
        "tab_foreground",
        "tab.foreground",
        Var("--muted"),
        "inactive tabs: text-[var(--muted)]",
    ),
    c(
        "table",
        "table.background",
        Transparent,
        "tables paint no background",
    ),
    c(
        "table_active",
        "table.active.background",
        VarAlpha("--accent", 15.0),
        "selected rows: bg-[var(--accent)]/15 (capped at 20% like list_active)",
    ),
    c(
        "table_active_border",
        "table.active.border",
        Var("--accent"),
        "the accent of the selected row",
    ),
    c(
        "table_even",
        "table.even.background",
        Transparent,
        "no striped tables",
    ),
    c(
        "table_head",
        "table.head.background",
        Var("--panel-2"),
        "header rows: bg-[var(--panel-2)], as the title bar and code-block headers",
    ),
    c(
        "table_head_foreground",
        "table.head.foreground",
        Var("--muted"),
        "header text: text-[var(--muted)]",
    ),
    c(
        "table_foot",
        "table.foot.background",
        Var("--panel-2"),
        "as the header",
    ),
    c(
        "table_foot_foreground",
        "table.foot.foreground",
        Var("--muted"),
        "as the header",
    ),
    c(
        "table_hover",
        "table.hover.background",
        Var("--panel-2"),
        "hover:bg-[var(--panel-2)]",
    ),
    c(
        "table_row_border",
        "table.row.border",
        Var("--border"),
        "border-[var(--border)]",
    ),
    c(
        "title_bar",
        "title_bar.background",
        Var("--panel-2"),
        "TitleBar.tsx: bg-[var(--panel-2)] text-[var(--muted)]",
    ),
    c(
        "title_bar_border",
        "title_bar.border",
        Var("--border"),
        "border-b border-[var(--border)]",
    ),
    c(
        "status_bar",
        "status_bar.background",
        Var("--panel"),
        "the status line: bg-[var(--panel)]",
    ),
    c(
        "status_bar_border",
        "status_bar.border",
        Var("--border"),
        "border-[var(--border)]",
    ),
    c(
        "warning",
        "warning.background",
        Step("amber-500"),
        "solid warning fills: bg-amber-500",
    ),
    c(
        "warning_active",
        "warning.active.background",
        StepAlpha("amber-500", 90.0),
        "no :active styles: the hover fill",
    ),
    c(
        "warning_hover",
        "warning.hover.background",
        StepAlpha("amber-500", 90.0),
        "hover:opacity-90",
    ),
    c(
        "warning_foreground",
        "warning.foreground",
        Step("black"),
        "text on amber-500 is dark (white would be under 2:1)",
    ),
    c(
        "overlay",
        "overlay",
        StepAlpha("black", 60.0),
        "modal backdrops: fixed inset-0 bg-black/60",
    ),
    c(
        "window_border",
        "window.border",
        Var("--border"),
        "the frame's border-[var(--border)] (Linux only in gpui)",
    ),
    c("red", "base.red", Step("red-400"), "text-red-400 (75)"),
    c(
        "red_light",
        "base.red.light",
        Step("red-300"),
        "text-red-300 (94)",
    ),
    c(
        "green",
        "base.green",
        Step("emerald-400"),
        "text-emerald-400 (40): the UI's green is emerald",
    ),
    c(
        "green_light",
        "base.green.light",
        Step("emerald-300"),
        "text-emerald-300 (36)",
    ),
    c(
        "blue",
        "base.blue",
        Step("sky-400"),
        "text-sky-400: the UI's blue is sky",
    ),
    c(
        "blue_light",
        "base.blue.light",
        Step("sky-300"),
        "text-sky-300",
    ),
    c(
        "yellow",
        "base.yellow",
        Step("amber-400"),
        "text-amber-400 (76): the UI's yellow is amber",
    ),
    c(
        "yellow_light",
        "base.yellow.light",
        Step("amber-300"),
        "text-amber-300 (61)",
    ),
    c(
        "magenta",
        "base.magenta",
        Step("violet-400"),
        "text-violet-400: the UI's magenta is violet (27, fuchsia 3)",
    ),
    c(
        "magenta_light",
        "base.magenta.light",
        Step("violet-300"),
        "text-violet-300",
    ),
    c(
        "cyan",
        "base.cyan",
        Step("cyan-400"),
        "text-cyan-400, the UI's one cyan step",
    ),
    c(
        "cyan_light",
        "base.cyan.light",
        Step("cyan-400"),
        "the UI has no lighter cyan: the same step",
    ),
];

/// A theme-file key the table leaves out on purpose:
/// `group_box.title.foreground` is parsed by gpui-component 0.10 but has no
/// `ThemeColor` field and nothing reads it.
pub const UNUSED_KEYS: [&str; 1] = ["group_box.title.foreground"];

/// `#rrggbbaa` of what Chromium paints on an 8-bit sRGB surface.
pub fn hex(c: Rgba) -> String {
    let [r, g, b, a] = c.to_rgba8();
    format!("#{r:02x}{g:02x}{b:02x}{a:02x}")
}

/// A theme's [`COLORS`] as `(field, color)`.
pub fn resolve(theme: &Tokens) -> Vec<(&'static str, Rgba)> {
    COLORS
        .iter()
        .map(|c| (c.field, c.source.resolve(theme)))
        .collect()
}
