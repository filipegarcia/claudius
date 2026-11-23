//! Sizes: the Tailwind tokens as GPUI pixels (one density level).

use claudius_gpui_theme::density::{self, TextSize};
use claudius_theme::chat::ChatSize;
use gpui_kit::px;

#[test]
fn rem_and_code_sizes() {
    assert_eq!(density::font_size(), px(16.));
    assert_eq!(density::FONT_SIZE, 16.0);
    assert!((density::MONO_FONT_SIZE - 12.04).abs() < 1e-9);
}

#[test]
fn spacing_steps() {
    assert_eq!(density::spacing(0.0), px(0.));
    assert_eq!(density::spacing(0.5), px(2.));
    assert_eq!(density::spacing(1.5), px(6.));
    assert_eq!(density::spacing(3.0), px(12.));
    assert_eq!(density::spacing(64.0), px(256.));
}

#[test]
fn radii() {
    assert_eq!(density::radius("--radius-sm"), Some(px(4.)));
    assert_eq!(density::radius(density::RADIUS), Some(px(6.)));
    assert_eq!(density::radius(density::RADIUS_LG), Some(px(8.)));
    assert_eq!(density::radius("--radius-xl"), Some(px(12.)));
    assert_eq!(density::radius("--radius-2xl"), Some(px(16.)));
    assert_eq!(density::radius("rounded"), Some(px(4.)));
    assert_eq!(density::radius("full"), Some(px(9999.)));
    assert_eq!(density::radius("--radius-3xl"), None);
}

#[test]
fn type_scale() {
    let t = |n| density::text(n).unwrap();
    assert_eq!(
        t("xs"),
        TextSize {
            size: px(12.),
            line_height: px(16.)
        }
    );
    assert_eq!(
        t("sm"),
        TextSize {
            size: px(14.),
            line_height: px(20.)
        }
    );
    assert_eq!(
        t("base"),
        TextSize {
            size: px(16.),
            line_height: px(24.)
        }
    );
    assert_eq!(
        t("3xl"),
        TextSize {
            size: px(30.),
            line_height: px(36.)
        }
    );
    assert_eq!(density::text("4xl"), None);
}

#[test]
fn chat_column_follows_the_window_and_the_user_s_size() {
    let auto = ChatSize::default();
    assert_eq!(density::chat_column(px(1200.), auto), (px(768.), px(14.)));
    let (col, text) = density::chat_column(px(3072.), auto);
    assert!(col > px(768.) && text > px(14.), "fluid past 1536px");
    let user = ChatSize {
        col_rem: Some(40.0),
        text_px: Some(17.0),
    };
    assert_eq!(density::chat_column(px(1200.), user), (px(640.), px(17.)));
}
