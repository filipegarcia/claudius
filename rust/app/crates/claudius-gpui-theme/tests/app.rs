//! The theme applied in a headless gpui app (`TestAppContext`): colors read
//! back through `cx.theme()`, and `Theme::change` switching light / dark.

use claudius_gpui_theme::{ThemeName, apply, code, hsla, init};
use claudius_theme::Theme as Tokens;
use gpui::TestAppContext;
use gpui_kit::component::{ActiveTheme, Theme, ThemeMode};

fn assert_palette(cx: &gpui::App, name: ThemeName) {
    let theme = cx.theme();
    let p = Tokens::of(name).palette;
    assert_eq!(theme.mode.is_dark(), name.is_dark(), "{}", name.id());
    assert_eq!(theme.theme_name().as_ref(), name.label());
    assert_eq!(theme.background, hsla(p.background), "{}", name.id());
    assert_eq!(theme.foreground, hsla(p.foreground));
    assert_eq!(theme.primary, hsla(p.accent));
    assert_eq!(theme.popover, hsla(p.panel));
    assert_eq!(theme.list_hover, hsla(p.panel_2));
    assert_eq!(theme.muted_foreground, hsla(p.muted));
    // The components paint from the tokens: they follow the colors.
    assert_eq!(theme.tokens.background.color, theme.background);
}

#[gpui::test]
fn init_apply_and_change_modes(cx: &mut TestAppContext) {
    cx.update(|cx| {
        gpui_kit::component::init(cx);
        init(ThemeName::Midnight, cx);
        assert_palette(cx, ThemeName::Midnight);
        // `apply` puts back the selection alpha the theme file caps.
        let sel = Tokens::of(ThemeName::Midnight).selection;
        assert_eq!(cx.theme().selection, hsla(sel));
        assert_eq!(cx.theme().tokens.selection.color, hsla(sel));
        assert_eq!(cx.theme().highlight_theme.style, code::highlight_style());

        // `init` registered `light` for the light mode.
        Theme::change(ThemeMode::Light, None, cx);
        assert_palette(cx, ThemeName::Light);
        // Back to dark: the last dark palette applied.
        Theme::change(ThemeMode::Dark, None, cx);
        assert_palette(cx, ThemeName::Midnight);

        apply(ThemeName::Paper, cx);
        assert_palette(cx, ThemeName::Paper);
        Theme::change(ThemeMode::Dark, None, cx);
        assert_palette(cx, ThemeName::Midnight);
        Theme::change(ThemeMode::Light, None, cx);
        assert_palette(cx, ThemeName::Paper);

        apply(ThemeName::Synthwave, cx);
        assert_palette(cx, ThemeName::Synthwave);
        assert_eq!(
            cx.theme().selection,
            hsla(Tokens::of(ThemeName::Synthwave).selection)
        );
        assert_eq!(f32::from(cx.theme().radius), 6.0);
    });
}

#[gpui::test]
fn every_palette_applies(cx: &mut TestAppContext) {
    cx.update(|cx| {
        gpui_kit::component::init(cx);
        for name in ThemeName::ALL {
            apply(name, cx);
            assert_palette(cx, name);
            // The Base layer (scrollbars, resize handles) follows.
            assert_eq!(
                gpui_kit::base::Theme::global(cx).tokens.colors.background,
                hsla(Tokens::of(name).palette.background)
            );
        }
    });
}
