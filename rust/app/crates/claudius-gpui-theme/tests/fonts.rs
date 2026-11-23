//! The bundled Geist fonts: the theme files name them, `init` adds them,
//! and with gpui's CoreText text system (macOS, no window) each weight
//! resolves to its own face and code text shapes without ligatures.

use std::{
    borrow::Cow,
    collections::BTreeSet,
    fs,
    path::Path,
    sync::{Arc, Mutex},
};

use claudius_gpui_theme::{
    ThemeName, apply,
    fonts::{self, FILES, MONO, SANS},
    init, theme_config, theme_json,
};
use claudius_theme::tailwind;
use gpui::{
    Bounds, DevicePixels, Font, FontId, FontMetrics, FontRun, FontStyle, FontWeight, GlyphId,
    LineLayout, NoopTextSystem, Pixels, PlatformTextSystem, RenderGlyphParams, Size,
    TestAppContext, TestDispatcher, TextRenderingMode,
};
use gpui_kit::component::{ActiveTheme, Theme, ThemeMode};

fn assert_families(cx: &gpui::App) {
    assert_eq!(cx.theme().font_family.as_ref(), "Geist");
    assert_eq!(cx.theme().mono_font_family.as_ref(), "Geist Mono");
}

#[test]
fn the_families_are_the_stylesheet_s() {
    assert_eq!(tailwind::body_font_family()[0], SANS);
    assert_eq!(tailwind::code_font_family()[0], MONO);
    for name in ThemeName::ALL {
        let json = theme_json(name);
        assert_eq!(json["font.family"], "Geist", "{}", name.id());
        assert_eq!(json["mono_font.family"], "Geist Mono");
        let config = theme_config(name);
        assert_eq!(config.font_family.as_deref(), Some("Geist"));
        assert_eq!(config.mono_font_family.as_deref(), Some("Geist Mono"));
    }
}

#[test]
fn the_bundle_is_the_weights_the_ui_uses() {
    // `font-normal` / `font-medium` / `font-semibold`, and bold
    // (`<strong>`, Shiki's bold scopes).
    let want: BTreeSet<u16> = tailwind::WEIGHTS
        .iter()
        .map(|(_, w)| *w)
        .chain([700])
        .collect();
    assert_eq!(want, BTreeSet::from([400, 500, 600, 700]));
    for family in [SANS, MONO] {
        let have: Vec<u16> = FILES
            .iter()
            .filter(|f| f.family == family)
            .map(|f| f.weight.0 as u16)
            .collect();
        assert_eq!(have.iter().copied().collect::<BTreeSet<_>>(), want);
        assert_eq!(have.len(), want.len(), "{family}: one face per weight");
    }
    let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("assets/fonts");
    for face in FILES {
        // TrueType outlines (the `ttf/` files).
        assert_eq!(face.data[..4], [0, 1, 0, 0], "{}", face.file);
        assert_eq!(fs::read(dir.join(face.file)).unwrap(), face.data);
        // Release 1.8.0: the React UI's Geist 1.800 (Google Fonts), and Geist
        // Mono 1.700 for its 1.701 (no release has 1.701).
        let version = if face.family == SANS {
            "1.800"
        } else {
            "1.700"
        };
        let name: Vec<u8> = format!("Version {version};")
            .encode_utf16()
            .flat_map(u16::to_be_bytes)
            .collect();
        assert!(
            face.data.windows(name.len()).any(|w| w == name),
            "{} is not {version}",
            face.file
        );
    }
    let ofl = fs::read_to_string(dir.join("OFL.txt")).unwrap();
    assert!(ofl.contains("SIL OPEN FONT LICENSE Version 1.1"));
    assert!(ofl.contains("The Geist Project Authors"));
}

#[test]
fn code_text_turns_ligatures_off() {
    let features = fonts::code_features();
    assert_eq!(
        features.tag_value_list(),
        [("liga".to_string(), 0), ("calt".to_string(), 0)]
    );
    assert_eq!(features.is_calt_enabled(), Some(false));
    let font = fonts::code_font(FontWeight::MEDIUM);
    assert_eq!(font.family.as_ref(), "Geist Mono");
    assert_eq!(font.features, features);
    assert_eq!(font.weight, FontWeight::MEDIUM);
    assert_eq!(font.style, FontStyle::Normal);
    let style = fonts::code_style();
    assert_eq!(style.text.font_family.as_deref(), Some("Geist Mono"));
    assert_eq!(style.text.font_features, Some(features));
    assert_eq!(style.text.font_size, None, "the caller's size");
}

#[gpui::test]
fn init_installs_the_fonts_in_the_theme(cx: &mut TestAppContext) {
    cx.update(|cx| {
        gpui_kit::component::init(cx);
        init(ThemeName::Midnight, cx);
        assert_families(cx);
        // gpui-component's probes leave a family set explicitly alone.
        Theme::change(ThemeMode::Light, None, cx);
        assert_families(cx);
        apply(ThemeName::Synthwave, cx);
        assert_families(cx);
        // Loading again is a no-op.
        fonts::load(cx).unwrap();
        init(ThemeName::Paper, cx);
        assert_families(cx);
    });
}

/// A text system that records the font data it is given (and has no fonts,
/// as `TestAppContext`'s default).
#[derive(Default)]
struct Recording(Mutex<Vec<Vec<u8>>>);

impl PlatformTextSystem for Recording {
    fn add_fonts(&self, fonts: Vec<Cow<'static, [u8]>>) -> gpui::Result<()> {
        let mut added = self.0.lock().unwrap();
        added.extend(fonts.into_iter().map(Cow::into_owned));
        Ok(())
    }
    fn all_font_names(&self) -> Vec<String> {
        NoopTextSystem.all_font_names()
    }
    fn font_id(&self, font: &Font) -> gpui::Result<FontId> {
        NoopTextSystem.font_id(font)
    }
    fn font_metrics(&self, id: FontId) -> FontMetrics {
        NoopTextSystem.font_metrics(id)
    }
    fn typographic_bounds(&self, id: FontId, glyph: GlyphId) -> gpui::Result<Bounds<f32>> {
        NoopTextSystem.typographic_bounds(id, glyph)
    }
    fn advance(&self, id: FontId, glyph: GlyphId) -> gpui::Result<Size<f32>> {
        NoopTextSystem.advance(id, glyph)
    }
    fn glyph_for_char(&self, id: FontId, ch: char) -> Option<GlyphId> {
        NoopTextSystem.glyph_for_char(id, ch)
    }
    fn glyph_raster_bounds(
        &self,
        params: &RenderGlyphParams,
    ) -> gpui::Result<Bounds<DevicePixels>> {
        NoopTextSystem.glyph_raster_bounds(params)
    }
    fn rasterize_glyph(
        &self,
        params: &RenderGlyphParams,
        bounds: Bounds<DevicePixels>,
    ) -> gpui::Result<(Size<DevicePixels>, Vec<u8>)> {
        NoopTextSystem.rasterize_glyph(params, bounds)
    }
    fn layout_line(&self, text: &str, size: Pixels, runs: &[FontRun]) -> LineLayout {
        NoopTextSystem.layout_line(text, size, runs)
    }
    fn recommended_rendering_mode(&self, id: FontId, size: Pixels) -> TextRenderingMode {
        NoopTextSystem.recommended_rendering_mode(id, size)
    }
}

#[test]
fn init_adds_every_face_once() {
    let text = Arc::new(Recording::default());
    let cx = TestAppContext::build_with_text_system(TestDispatcher::new(0), None, text.clone());
    cx.update(|cx| {
        gpui_kit::component::init(cx);
        init(ThemeName::Dark, cx);
        init(ThemeName::Light, cx);
        fonts::load(cx).unwrap();
    });
    let added = text.0.lock().unwrap();
    let want: Vec<&[u8]> = FILES.iter().map(|f| f.data).collect();
    assert_eq!(added.iter().map(Vec::as_slice).collect::<Vec<_>>(), want);
}

/// gpui's macOS text system (CoreText), in a headless `TestAppContext`.
#[cfg(target_os = "macos")]
mod core_text {
    use std::{collections::BTreeSet, sync::Arc};

    use claudius_gpui_theme::{
        ThemeName,
        fonts::{self, MONO, SANS},
        init,
    };
    use gpui::{
        Font, FontRun, FontStyle, FontWeight, GlyphId, PlatformTextSystem, TestAppContext,
        TestDispatcher, font, px,
    };
    use gpui_apple::AppleTextSystem;
    use gpui_kit::component::ActiveTheme;

    const WEIGHTS: [FontWeight; 4] = [
        FontWeight::NORMAL,
        FontWeight::MEDIUM,
        FontWeight::SEMIBOLD,
        FontWeight::BOLD,
    ];

    fn app() -> (TestAppContext, Arc<AppleTextSystem>) {
        let text = Arc::new(AppleTextSystem::new());
        let cx = TestAppContext::build_with_text_system(TestDispatcher::new(0), None, text.clone());
        (cx, text)
    }

    fn weighted(family: &str, weight: FontWeight) -> Font {
        Font {
            weight,
            ..font(family.to_string())
        }
    }

    #[test]
    fn the_families_resolve_after_init() {
        let (cx, text) = app();
        // Not installed on macOS (unless the user added them).
        let installed = AppleTextSystem::new().font_id(&font(SANS)).is_ok();
        if !installed {
            assert!(text.font_id(&font(SANS)).is_err());
            assert!(text.font_id(&font(MONO)).is_err());
        }
        cx.update(|cx| {
            gpui_kit::component::init(cx);
            init(ThemeName::Dark, cx);
            let names = cx.text_system().all_font_names();
            assert!(names.iter().any(|n| n == SANS), "{names:?}");
            assert!(names.iter().any(|n| n == MONO));
            // The theme's families resolve directly, not through gpui's
            // fallback stack.
            let theme = cx.theme().clone();
            for family in [theme.font_family, theme.mono_font_family] {
                let id = cx.text_system().resolve_font(&font(family.clone()));
                let got = cx.text_system().get_font_for_id(id).map(|f| f.family);
                assert_eq!(got, Some(family));
            }
        });
        for family in [SANS, MONO] {
            // One face per weight.
            let ids: BTreeSet<usize> = WEIGHTS
                .iter()
                .map(|w| text.font_id(&weighted(family, *w)).unwrap().0)
                .collect();
            assert_eq!(ids.len(), 4, "{family}");
            // Italics aren't bundled: gpui draws the upright face.
            let upright = text.font_id(&font(family.to_string())).unwrap();
            let italic = Font {
                style: FontStyle::Italic,
                ..font(family.to_string())
            };
            assert_eq!(text.font_id(&italic).unwrap(), upright);
        }
        // Geist is proportional and its weights are drawn wider; Geist Mono
        // keeps one advance.
        let advance = |font: &Font| {
            let id = text.font_id(font).unwrap();
            let glyph = text.glyph_for_char(id, 'm').unwrap();
            text.advance(id, glyph).unwrap().width
        };
        let sans: Vec<f32> = WEIGHTS.map(|w| advance(&weighted(SANS, w))).to_vec();
        assert!(sans.windows(2).all(|w| w[0] < w[1]), "{sans:?}");
        let mono: Vec<f32> = WEIGHTS.map(|w| advance(&weighted(MONO, w))).to_vec();
        assert!(mono.iter().all(|a| *a == mono[0]), "{mono:?}");
    }

    #[test]
    fn code_text_has_no_ligatures() {
        let (cx, text) = app();
        cx.update(|cx| fonts::load(cx).unwrap());
        let line = "fi -> => != == ffl";
        // `(shaped glyphs, one cmap glyph per character)`.
        let shape = |font: &Font| -> (Vec<GlyphId>, Vec<GlyphId>) {
            let id = text.font_id(font).unwrap();
            let layout = text.layout_line(
                line,
                px(13.),
                &[FontRun {
                    len: line.len(),
                    font_id: id,
                }],
            );
            let shaped = layout
                .runs
                .iter()
                .flat_map(|r| r.glyphs.iter().map(|g| g.id))
                .collect();
            let plain = line
                .chars()
                .map(|c| text.glyph_for_char(id, c).unwrap())
                .collect();
            (shaped, plain)
        };
        // Geist's `liga` fuses `fi`, the arrows and `!=` by default; the code
        // features turn it off through gpui's CoreText shaping.
        let (shaped, plain) = shape(&font(SANS));
        assert_ne!(shaped, plain);
        let (shaped, plain) = shape(&Font {
            features: fonts::code_features(),
            ..font(SANS)
        });
        assert_eq!(shaped, plain);
        // Geist Mono 1.700 has no `liga` / `calt` (nor has the 1.701 Google
        // Fonts serves the React UI), so its defaults already draw plain
        // glyphs. Code text turns both off anyway, as globals.css does.
        let (shaped, plain) = shape(&font(MONO));
        assert_eq!(shaped, plain);
        for weight in WEIGHTS {
            let (shaped, plain) = shape(&fonts::code_font(weight));
            assert_eq!(shaped, plain, "{weight:?}");
        }
    }
}
