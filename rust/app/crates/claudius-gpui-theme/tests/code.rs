//! Code highlighting: `code::SYNTAX` against the React UI's Shiki theme.
//!
//! `tests/fixtures/github-dark-default.json` is the theme as
//! `@shikijs/themes` 4.0.2 ships it (MIT, from GitHub's VS Code theme);
//! `drift_*` compares it with node_modules when that is installed.

use std::{collections::BTreeSet, fs, path::Path};

use claudius_gpui_theme::code::{self, SYNTAX, Style};
use gpui_kit::{FontStyle, FontWeight, component::highlighter::SyntaxColors};
use serde_json::Value;

fn fixture() -> Value {
    let path = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/tests/fixtures/github-dark-default.json"
    );
    serde_json::from_str(&fs::read_to_string(path).unwrap()).unwrap()
}

/// TextMate's choice for one scope with no parents: of the selectors equal
/// to the scope or a dotted prefix of it, the longest wins, and a later rule
/// wins a tie. Descendant selectors (`string variable`) need a parent scope,
/// so they never match here. Returns `(selector, foreground, fontStyle)`.
fn resolve(theme: &Value, scope: &str) -> Option<(String, Option<String>, String)> {
    let mut best: Option<((usize, usize), String, &Value)> = None;
    for (i, rule) in theme["tokenColors"].as_array().unwrap().iter().enumerate() {
        let settings = &rule["settings"];
        if settings.get("foreground").is_none() && settings.get("fontStyle").is_none() {
            continue;
        }
        let selectors: Vec<String> = match &rule["scope"] {
            Value::String(s) => s.split(',').map(|s| s.trim().to_string()).collect(),
            Value::Array(a) => a.iter().map(|s| s.as_str().unwrap().to_string()).collect(),
            _ => continue,
        };
        for sel in selectors.into_iter().filter(|s| !s.contains(' ')) {
            let matches = scope == sel || scope.starts_with(&format!("{sel}."));
            let rank = (sel.split('.').count(), i);
            if matches && best.as_ref().is_none_or(|(r, _, _)| rank >= *r) {
                best = Some((rank, sel, settings));
            }
        }
    }
    best.map(|(_, sel, s)| {
        (
            sel,
            s["foreground"].as_str().map(str::to_lowercase),
            s["fontStyle"].as_str().unwrap_or("").to_string(),
        )
    })
}

#[test]
fn each_name_has_the_color_shiki_gives_its_scope() {
    let theme = fixture();
    for s in SYNTAX {
        let got = resolve(&theme, s.scope);
        assert_eq!(got.as_ref().map(|g| g.0.as_str()), s.rule, "{}", s.name);
        let (fg, font) = got.map_or((None, String::new()), |g| (g.1, g.2));
        assert_eq!(
            fg.as_deref().unwrap_or(code::FOREGROUND),
            s.color,
            "{}",
            s.name
        );
        let style = if font.contains("bold") {
            Style::Bold
        } else if font.contains("italic") {
            Style::Italic
        } else {
            Style::Plain
        };
        assert_eq!(style, s.style, "{}", s.name);
    }
}

#[test]
fn the_editor_colors_are_the_theme_s() {
    let colors = &fixture()["colors"];
    let c = |k: &str| colors[k].as_str().unwrap().to_lowercase();
    assert_eq!(c("editor.foreground"), code::FOREGROUND);
    assert_eq!(c("editorLineNumber.foreground"), code::LINE_NUMBER);
    assert_eq!(
        c("editorLineNumber.activeForeground"),
        code::ACTIVE_LINE_NUMBER
    );
    assert_eq!(c("editor.lineHighlightBackground"), code::ACTIVE_LINE);
    assert_eq!(c("editorWhitespace.foreground"), code::INVISIBLE);
    // The block itself is CodeBlock.tsx's bg-[#0a0a0a], not the theme's.
    assert_eq!(c("editor.background"), "#0d1117");
    assert_eq!(code::CODE_BLOCK_BACKGROUND, "#0a0a0a");
}

#[test]
fn names_are_unique() {
    let names: BTreeSet<&str> = SYNTAX.iter().map(|s| s.name).collect();
    assert_eq!(names.len(), SYNTAX.len());
}

#[test]
#[should_panic(expected = "enum is not a highlight name the syntect backend produces")]
fn a_name_the_backend_never_produces_is_refused() {
    code::set_style(&mut SyntaxColors::default(), "enum", &SYNTAX[0]);
}

#[test]
fn the_highlight_style_parses_to_these_colors() {
    let style = code::highlight_style();
    let hex = |h: &str| gpui_kit::Hsla::from(gpui_kit::Rgba::try_from(h).unwrap());
    for s in SYNTAX {
        let hs = style
            .syntax
            .style(s.name)
            .unwrap_or_else(|| panic!("{}", s.name));
        assert_eq!(hs.color, Some(hex(s.color)), "{}", s.name);
        assert_eq!(
            hs.font_weight,
            (s.style == Style::Bold).then_some(FontWeight::BOLD),
            "{}",
            s.name
        );
        assert_eq!(
            hs.font_style,
            (s.style == Style::Italic).then_some(FontStyle::Italic),
            "{}",
            s.name
        );
    }
    for unset in [
        "constructor",
        "embedded",
        "enum",
        "link_text",
        "variant",
        "hint",
    ] {
        assert!(style.syntax.style(unset).is_none(), "{unset}");
    }
    assert_eq!(
        style.editor_background,
        Some(hex(code::CODE_BLOCK_BACKGROUND))
    );
    assert_eq!(style.editor_foreground, Some(hex(code::FOREGROUND)));
    assert_eq!(style.editor_line_number, Some(hex(code::LINE_NUMBER)));
    assert_eq!(
        style.editor_active_line_number,
        Some(hex(code::ACTIVE_LINE_NUMBER))
    );
    assert_eq!(style.editor_active_line, Some(hex(code::ACTIVE_LINE)));
    assert_eq!(style.editor_invisible, Some(hex(code::INVISIBLE)));
}

#[test]
fn drift_the_fixture_is_the_installed_shiki_theme() {
    let root = std::env::var_os("CLAUDIUS_DRIFT_ROOT")
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|| Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../.."));
    let mjs = root.join("node_modules/@shikijs/themes/dist/github-dark-default.mjs");
    let Ok(src) = fs::read_to_string(&mjs) else {
        // A checkout without node_modules: the theme comes from the pinned
        // version.
        let Ok(lock) = fs::read_to_string(root.join("bun.lock")) else {
            eprintln!("no node_modules or bun.lock: skipped");
            return;
        };
        assert!(
            lock.contains("\"@shikijs/themes\": [\"@shikijs/themes@4.0.2\""),
            "shiki's themes moved: re-record the fixture"
        );
        return;
    };
    // `export default Object.freeze(JSON.parse("…"));`
    let start = src.find("JSON.parse(").unwrap() + "JSON.parse(".len();
    let end = src.rfind("))").unwrap();
    let literal: String = serde_json::from_str(&src[start..end]).unwrap();
    let installed: Value = serde_json::from_str(&literal).unwrap();
    assert_eq!(installed, fixture());
}
