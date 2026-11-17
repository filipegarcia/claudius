//! Design tokens of the React UI as typed data, with no UI toolkit (U03a).
//!
//! The sources of truth are `app/globals.css` (the seven `data-theme`
//! palettes, their chart series, `@theme inline`, the chat column, the
//! chrome colors) and the Tailwind v4 defaults it imports
//! (`tailwindcss/theme.css`), scoped to what the UI's class names use.
//! Every token keeps its CSS source text, and colors also resolve to sRGB
//! the way Chromium does. `tests/drift.rs` fails when either stylesheet
//! changes a token; `tests/theme_golden.rs` replays what Chromium computed
//! for them (`getComputedStyle` on the stylesheet compiled by Tailwind's
//! own compiler, recorded by `rust/scripts/theme-golden.mjs`) and what the
//! real client TS does with storage.
//!
//! # What U03b consumes
//!
//! U03b builds the gpui-component `Theme` from this crate:
//! - [`Theme::of`] per [`ThemeName`]: the palette ([`Palette`]: background,
//!   foreground, panel, panel-2, border, muted, accent, six chart series
//!   and "other"), the selection and scrollbar-hover colors, and
//!   [`ThemeName::is_dark`] for `Theme::change` (light / dark mode). Colors
//!   are [`Rgba`]; draw them with [`Rgba::to_rgba8`] (sRGB, clipped like
//!   Chromium on an sRGB display) or the unclamped floats.
//! - Tailwind's `/N` opacity modifier is [`color::with_opacity`] (an
//!   `oklab` mix with transparent), and the palette steps the UI's
//!   utilities name are [`tailwind::color`].
//! - Sizes in px ([`tailwind::REM_PX`] is 16): [`tailwind::spacing_px`],
//!   [`tailwind::RADII`], [`tailwind::TEXT`] (size and line height),
//!   [`tailwind::WEIGHTS`], [`tailwind::TRACKING`], [`tailwind::LEADING`],
//!   the font stacks ([`tailwind::body_font_family`],
//!   [`tailwind::code_font_family`]: Geist and Geist Mono, which the app
//!   gets from next/font and the native app has to bundle).
//! - The chat column: [`chat::chat_column`] / [`chat::chat_column_with`]
//!   (max width and base text size for a window width and the user's
//!   Settings → Chat size overrides). There is no density setting.
//! - The client's choices: [`client::read_theme`] / [`client::set_theme`]
//!   over a [`client::Host`] (its storage), `/theme`
//!   ([`client::theme_command`]), `/color` ([`prompt::color_command`],
//!   [`prompt::PromptColorState`] for the per-session pick) and the
//!   composer frame ([`prompt::composer_frame`]).
//!
//! Two browser facts to keep in mind there: an element's border color is
//! always `--border` unless set inline ([`Theme::border_color`]), and a
//! `data-theme` that isn't one of the seven shows the dark values
//! ([`ThemeName::for_attribute`]).

pub mod chat;
pub mod client;
pub mod color;
pub mod js;
pub mod palette;
pub mod prompt;
pub mod tailwind;

pub use color::Rgba;
pub use palette::{Palette, Theme, ThemeName};
