//! The React UI's fonts, Geist and Geist Mono, bundled (U03c).
//!
//! `app/layout.tsx` loads both through `next/font/google` with no `weight`
//! and no `style`: the browser gets Google Fonts' variable Geist 1.800 and
//! Geist Mono 1.701, upright only. The UI's text uses four weights:
//! `font-normal`, `font-medium` and `font-semibold` (`tailwind::WEIGHTS`:
//! 400, 500, 600, also the charts' `fontWeight={600}`) and bold (700:
//! Markdown's `<strong>` is `bolder` over 400 or 500, and Shiki bolds some
//! scopes in code). Mono text uses the same four (`font-mono` with
//! `font-medium` / `font-semibold`, bold highlighting). So [`FILES`] is
//! those four weights of each family, the static `ttf/` files of
//! vercel/geist-font release 1.8.0 (Geist 1.800, Geist Mono 1.700; OFL-1.1,
//! `assets/fonts/OFL.txt`): 1,107,444 bytes.
//!
//! Static files, not the variable ones: gpui's macOS text system loads a
//! variable font as one face at its default instance and matches weights
//! among a family's faces, so `Geist[wght].ttf` draws every weight as 400.
//!
//! Not bundled: italics. The React UI never loads them, and Chromium slants
//! the upright face for `italic` and `<em>`. gpui doesn't synthesize an
//! oblique, so italic text is drawn upright (`tests/fonts.rs` pins it).
//!
//! Ligatures: globals.css turns `liga` and `calt` off for `code`, `pre`,
//! `kbd`, `samp`, `.font-mono` and `.shiki-host`, everywhere mono text is
//! drawn. [`code_features`] is that setting. Geist Mono 1.700 / 1.701 has
//! neither feature, so it changes nothing today; Geist (sans) does have
//! `liga` (`fi`, `->`, `!=`), which stays on for the sans text, as in the
//! browser. A theme file has no font features, so code surfaces take them
//! from [`code_font`] or [`code_style`] (a `TextViewStyle::code_block`, or
//! the element around a code editor, whose text inherits them).

use std::{borrow::Cow, sync::Arc};

use claudius_theme::tailwind;
use gpui_kit::{
    App, Font, FontFeatures, FontStyle, FontWeight, Global, Result, StyleRefinement, Styled,
};

/// The sans family: `--font-sans` (Geist), the body's font.
pub const SANS: &str = tailwind::FONT_SANS[0];

/// The mono family: `--font-mono` (Geist Mono).
pub const MONO: &str = tailwind::FONT_MONO[0];

/// A bundled font file.
#[derive(Clone, Copy, Debug)]
pub struct Face {
    pub family: &'static str,
    pub weight: FontWeight,
    /// The file under `assets/fonts/`.
    pub file: &'static str,
    pub data: &'static [u8],
}

/// The bundled faces: Geist and Geist Mono at 400, 500, 600 and 700.
pub const FILES: [Face; 8] = [
    Face {
        family: SANS,
        weight: FontWeight::NORMAL,
        file: "Geist-Regular.ttf",
        data: include_bytes!("../assets/fonts/Geist-Regular.ttf"),
    },
    Face {
        family: SANS,
        weight: FontWeight::MEDIUM,
        file: "Geist-Medium.ttf",
        data: include_bytes!("../assets/fonts/Geist-Medium.ttf"),
    },
    Face {
        family: SANS,
        weight: FontWeight::SEMIBOLD,
        file: "Geist-SemiBold.ttf",
        data: include_bytes!("../assets/fonts/Geist-SemiBold.ttf"),
    },
    Face {
        family: SANS,
        weight: FontWeight::BOLD,
        file: "Geist-Bold.ttf",
        data: include_bytes!("../assets/fonts/Geist-Bold.ttf"),
    },
    Face {
        family: MONO,
        weight: FontWeight::NORMAL,
        file: "GeistMono-Regular.ttf",
        data: include_bytes!("../assets/fonts/GeistMono-Regular.ttf"),
    },
    Face {
        family: MONO,
        weight: FontWeight::MEDIUM,
        file: "GeistMono-Medium.ttf",
        data: include_bytes!("../assets/fonts/GeistMono-Medium.ttf"),
    },
    Face {
        family: MONO,
        weight: FontWeight::SEMIBOLD,
        file: "GeistMono-SemiBold.ttf",
        data: include_bytes!("../assets/fonts/GeistMono-SemiBold.ttf"),
    },
    Face {
        family: MONO,
        weight: FontWeight::BOLD,
        file: "GeistMono-Bold.ttf",
        data: include_bytes!("../assets/fonts/GeistMono-Bold.ttf"),
    },
];

/// Marks the app whose text system has the bundled faces.
struct Loaded;

impl Global for Loaded {}

/// Adds the bundled faces to the app's text system, once per app (a second
/// call does nothing: the text system would list each face twice).
/// [`crate::init`] calls it.
pub fn load(cx: &mut App) -> Result<()> {
    if cx.has_global::<Loaded>() {
        return Ok(());
    }
    let fonts = FILES.iter().map(|face| Cow::Borrowed(face.data)).collect();
    cx.text_system().add_fonts(fonts)?;
    cx.set_global(Loaded);
    Ok(())
}

/// globals.css's `font-feature-settings: "liga" 0, "calt" 0` for code.
pub fn code_features() -> FontFeatures {
    FontFeatures(Arc::new(vec![("liga".into(), 0), ("calt".into(), 0)]))
}

/// Geist Mono at a weight, with ligatures off: the font of code text.
pub fn code_font(weight: FontWeight) -> Font {
    Font {
        family: MONO.into(),
        features: code_features(),
        fallbacks: None,
        weight,
        style: FontStyle::Normal,
    }
}

/// The text style of a code surface: Geist Mono, ligatures off. Sizes stay
/// the caller's (`mono_font_size` is the chat code block's).
pub fn code_style() -> StyleRefinement {
    StyleRefinement::default()
        .font_family(MONO)
        .font_features(code_features())
}
