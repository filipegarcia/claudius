//! The token → `ThemeColor` mapping, with no window: the table against
//! gpui-component's field and key lists, the theme file applied to a bare
//! `Theme`, the resolved colors against `claudius-theme`, and a golden of
//! every field in every palette (`tests/fixtures/theme_colors.json`;
//! `CLAUDIUS_UPDATE_GOLDEN=1` rewrites it, then review the diff).

use std::{collections::BTreeSet, rc::Rc};

use claudius_gpui_theme::{
    ThemeName,
    colors::{self, COLORS, Source, UNUSED_KEYS},
    density, hsla, mode, theme_config, theme_json,
};
use claudius_theme::{Rgba, Theme as Tokens, color, tailwind};
use gpui_kit::component::{Theme, ThemeColor, ThemeConfigColors, ThemeMode};
use serde_json::{Map, Value};

fn keys(v: Value) -> Vec<String> {
    match v {
        Value::Object(m) => m.keys().cloned().collect(),
        other => panic!("not an object: {other}"),
    }
}

fn rgb8(hex: &str) -> [u8; 4] {
    let h = hex.strip_prefix('#').expect("a hex color");
    assert_eq!(h.len(), 8, "{hex}");
    std::array::from_fn(|i| u8::from_str_radix(&h[i * 2..i * 2 + 2], 16).unwrap())
}

/// The applied theme's colors by field, as gpui serializes `Hsla`
/// (`#rrggbbaa`).
fn applied(name: ThemeName) -> Map<String, Value> {
    let mut theme = Theme::default();
    theme.apply_config(&Rc::new(theme_config(name)));
    assert_eq!(theme.mode, mode(name));
    match serde_json::to_value(theme.colors).unwrap() {
        Value::Object(m) => m,
        _ => unreachable!(),
    }
}

#[test]
fn every_theme_color_field_has_one_row_in_order() {
    let fields = keys(serde_json::to_value(ThemeColor::default()).unwrap());
    let rows: Vec<&str> = COLORS.iter().map(|c| c.field).collect();
    assert_eq!(fields, rows);
}

#[test]
fn every_theme_file_key_is_used_once() {
    let file_keys: BTreeSet<String> =
        keys(serde_json::to_value(ThemeConfigColors::default()).unwrap())
            .into_iter()
            .collect();
    let mut ours = BTreeSet::new();
    for c in &COLORS {
        assert!(ours.insert(c.key.to_string()), "{} used twice", c.key);
    }
    for k in UNUSED_KEYS {
        assert!(ours.insert(k.to_string()), "{k} is in the table");
    }
    assert_eq!(ours, file_keys);
}

#[test]
fn rows_document_their_react_source() {
    for c in &COLORS {
        assert!(!c.react.is_empty(), "{} has no React note", c.field);
    }
}

#[test]
fn the_applied_theme_file_has_every_row_s_color() {
    for name in ThemeName::ALL {
        let tokens = Tokens::of(name);
        let got = applied(name);
        for c in &COLORS {
            let mut want = c.source.resolve(&tokens).to_rgba8();
            // `apply_config` caps three highlight alphas (gpui-component
            // 0.10's `clamp_alpha`): `apply` restores `selection`.
            let cap = match c.field {
                "list_active" | "table_active" => Some(0.2),
                "selection" => Some(0.3),
                _ => None,
            };
            if let Some(cap) = cap {
                let capped = (cap * 255.0f32).round() as u8;
                want[3] = want[3].min(capped);
            }
            let hex = got[c.field].as_str().unwrap();
            assert_eq!(
                rgb8(hex),
                want,
                "{} {} ({:?})",
                name.id(),
                c.field,
                c.source
            );
        }
    }
}

#[test]
fn sources_resolve_through_claudius_theme() {
    let t = Tokens::of(ThemeName::Midnight);
    let p = t.palette;
    assert_eq!(Source::Var("--panel-2").resolve(&t), p.panel_2);
    assert_eq!(Source::Var("--series-6").resolve(&t), p.series[5]);
    assert_eq!(
        Source::VarAlpha("--accent", 15.0).resolve(&t),
        color::with_opacity(p.accent, 15.0)
    );
    assert_eq!(
        Source::Step("red-300").resolve(&t),
        tailwind::color("red-300").unwrap()
    );
    assert_eq!(
        Source::StepAlpha("black", 60.0).resolve(&t),
        color::with_opacity(tailwind::color("black").unwrap(), 60.0)
    );
    assert_eq!(Source::Selection.resolve(&t), t.selection);
    assert_eq!(
        Source::ScrollbarThumbHover.resolve(&t),
        t.scrollbar_thumb_hover
    );
    assert_eq!(Source::Transparent.resolve(&t), Rgba::TRANSPARENT);
    let synthwave = Tokens::of(ThemeName::Synthwave);
    assert_ne!(Source::Selection.resolve(&synthwave), t.selection);
}

#[test]
#[should_panic(expected = "--nope is not a palette variable")]
fn an_unknown_variable_panics() {
    Source::Var("--nope").resolve(&Tokens::of(ThemeName::Dark));
}

#[test]
#[should_panic(expected = "red-950 is not a Tailwind step")]
fn an_unknown_step_panics() {
    Source::Step("red-950").resolve(&Tokens::of(ThemeName::Dark));
}

/// The decisions that matter most, against the palettes' CSS values.
#[test]
fn key_fields_pin_the_react_tokens() {
    let dark = applied(ThemeName::Dark);
    let pin = |m: &Map<String, Value>, field: &str| m[field].as_str().unwrap().to_string();
    assert_eq!(pin(&dark, "background"), "#0b0b0cff");
    assert_eq!(pin(&dark, "foreground"), "#e7e7eaff");
    assert_eq!(pin(&dark, "border"), "#2a2a31ff");
    assert_eq!(pin(&dark, "popover"), "#131316ff"); // --panel
    assert_eq!(pin(&dark, "accent"), "#1a1a1fff"); // hover: --panel-2
    assert_eq!(pin(&dark, "muted_foreground"), "#9a9aa3ff"); // --muted
    assert_eq!(pin(&dark, "primary"), "#d97757ff"); // --accent
    assert_eq!(pin(&dark, "primary_foreground"), "#ffffffff");
    assert_eq!(pin(&dark, "primary_hover"), "#d97757e5"); // opacity-90
    assert_eq!(pin(&dark, "ring"), "#d97757ff");
    assert_eq!(pin(&dark, "list_active"), "#d9775726"); // accent/15
    assert_eq!(pin(&dark, "overlay"), "#00000099"); // black/60
    assert_eq!(pin(&dark, "button"), "#00000000");
    assert_eq!(pin(&dark, "chart_1"), "#3987e5ff");
    assert_eq!(pin(&dark, "chart_5"), "#d55181ff");
    assert_eq!(pin(&dark, "title_bar"), "#1a1a1fff");
    assert_eq!(pin(&dark, "selection"), "#d977574d"); // capped at 0.3 until `apply`
    let light = applied(ThemeName::Light);
    assert_eq!(pin(&light, "background"), "#fafafaff");
    assert_eq!(pin(&light, "primary"), "#c0531aff");
    assert_eq!(pin(&light, "chart_1"), "#2a78d6ff"); // the light series
    assert_eq!(pin(&light, "scrollbar_thumb"), "#d8d4ccff");
}

#[test]
fn every_palette_gets_its_mode_and_name() {
    for name in ThemeName::ALL {
        let config = theme_config(name);
        assert_eq!(config.name.as_ref(), name.label());
        assert_eq!(config.mode, mode(name));
        assert_eq!(config.mode == ThemeMode::Dark, name.is_dark());
        assert!(config.highlight.is_some());
    }
    assert_eq!(mode(ThemeName::Paper), ThemeMode::Light);
    assert_eq!(mode(ThemeName::Synthwave), ThemeMode::Dark);
}

#[test]
fn the_theme_file_sets_type_size_and_radii() {
    let json = theme_json(ThemeName::Tui);
    assert_eq!(json["font.size"], 16.0);
    assert!((json["mono_font.size"].as_f64().unwrap() - 12.04).abs() < 1e-9);
    assert_eq!(json["radius"], 6);
    assert_eq!(json["radius.lg"], 8);
    let mut theme = Theme::default();
    theme.apply_config(&Rc::new(theme_config(ThemeName::Tui)));
    assert_eq!(f32::from(theme.font_size), 16.0);
    assert_eq!(f32::from(theme.radius), 6.0);
    assert_eq!(f32::from(theme.radius_lg), 8.0);
    assert!((f32::from(theme.mono_font_size) - density::MONO_FONT_SIZE as f32).abs() < 1e-6);
}

#[test]
fn hex_and_hsla_round_to_the_painted_pixel() {
    let c = color::with_opacity(Rgba::from_rgb8(217, 119, 87), 90.0);
    assert_eq!(colors::hex(c), "#d97757e5");
    // Out of gamut clips, as Chromium paints it.
    let wide = Rgba {
        r: 1.2,
        g: -0.1,
        b: 0.5,
        a: 1.0,
    };
    assert_eq!(colors::hex(wide), "#ff0080ff");
    let h = gpui_kit::Rgba::from(hsla(c));
    let back = [h.r, h.g, h.b, h.a].map(|v| (v * 255.0).round() as u8);
    assert_eq!(back, [217, 119, 87, 229]);
}

#[test]
fn chart_series_has_all_seven() {
    let s = claudius_gpui_theme::chart_series(ThemeName::Paper);
    let p = Tokens::of(ThemeName::Paper).palette;
    assert_eq!(s[0], hsla(p.series[0]));
    assert_eq!(s[5], hsla(p.series[5]));
    assert_eq!(s[6], hsla(p.series_other));
}

#[test]
fn golden_every_field_in_every_palette() {
    let path = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/tests/fixtures/theme_colors.json"
    );
    let mut all = Map::new();
    for name in ThemeName::ALL {
        let tokens = Tokens::of(name);
        let mut m = Map::new();
        for (field, c) in colors::resolve(&tokens) {
            m.insert(field.into(), colors::hex(c).into());
        }
        all.insert(name.id().into(), Value::Object(m));
    }
    let got = Value::Object(all);
    if std::env::var_os("CLAUDIUS_UPDATE_GOLDEN").is_some() {
        std::fs::write(path, serde_json::to_string_pretty(&got).unwrap() + "\n").unwrap();
    }
    let want: Value = serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
    assert_eq!(got, want);
}
