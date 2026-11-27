//! The shortcut registry the command palette and the cheatsheet list (U10a)
//! against the React app's: `SHORTCUT_ACTIONS` entry by entry,
//! `formatBinding` / `formatCode`, and the palette's items built over
//! [`palette_rows`] against `CommandPalette`'s `items` memo. The fixture is
//! claudius-overlays' (`rust/scripts/overlays-golden.mjs`).

use claudius_app::shortcuts::{Binding, REGISTRY, format_binding, palette_rows, shortcuts};
use claudius_overlays::palette::build_items;
use claudius_overlays::slash::SLASH_COMMANDS;
use serde_json::Value;

fn fixture() -> Value {
    let path = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../claudius-overlays/tests/fixtures/overlays_golden.json"
    );
    serde_json::from_str(&std::fs::read_to_string(path).expect("the fixture")).unwrap()
}

fn cases<'a>(f: &'a Value, key: &str) -> &'a [Value] {
    f[key].as_array().unwrap_or_else(|| panic!("{key} cases"))
}

fn opt_str(v: &Value) -> Option<&str> {
    v.as_str()
}

/// A TS `KeyBinding` (`{ mod, alt, shift, code }`).
fn binding(v: &Value) -> Binding {
    let flag = |k: &str| v[k].as_bool().unwrap_or(false);
    Binding {
        cmd: flag("mod"),
        alt: flag("alt"),
        shift: flag("shift"),
        code: v["code"]
            .as_str()
            .map(|c| &*Box::leak(c.to_owned().into_boxed_str())),
    }
}

#[test]
fn the_registry_is_shortcut_actions() {
    let f = fixture();
    let ts = cases(&f, "shortcutActions");
    assert_eq!(REGISTRY.len(), ts.len());
    for (a, t) in REGISTRY.iter().zip(ts) {
        assert_eq!(a.id, t["id"], "id");
        assert_eq!(a.label, t["label"], "{}", a.id);
        assert_eq!(a.description, opt_str(&t["description"]), "{}", a.id);
        assert_eq!(a.category.id(), t["category"], "{}", a.id);
        let default = (!t["default"].is_null()).then(|| binding(&t["default"]));
        assert_eq!(a.default, default, "{}", a.id);
        assert_eq!(a.modifier_only, t["modifierOnly"] == true, "{}", a.id);
        assert_eq!(a.menu_owned, t["electronMenuOwned"] == true, "{}", a.id);
    }
}

#[test]
fn format_binding_is_the_ts_on_each_default() {
    let f = fixture();
    let rows = palette_rows(true);
    for ((a, t), row) in REGISTRY.iter().zip(cases(&f, "formatBinding")).zip(&rows) {
        assert_eq!(a.id, t["id"]);
        let Some(b) = a.default else {
            // No default: the cheatsheet's "—", the palette's "no default".
            assert_eq!(claudius_overlays::help::chord_text(row), t["mac"]);
            assert_eq!(
                claudius_overlays::palette::shortcut_detail(row),
                t["detailMac"]
            );
            continue;
        };
        assert_eq!(format_binding(b, true), t["mac"], "{}", a.id);
        assert_eq!(format_binding(b, false), t["other"], "{}", a.id);
        assert_eq!(format_binding(b, true), t["detailMac"], "{}", a.id);
        assert_eq!(format_binding(b, false), t["detailOther"], "{}", a.id);
    }
}

#[test]
fn format_code_is_the_ts_on_every_key() {
    let f = fixture();
    let unbound = palette_rows(true)
        .into_iter()
        .find(|r| r.chord.is_none())
        .expect("window.zoom has no default");
    for case in cases(&f, "formatCode") {
        if case["args"][0].is_null() {
            // `formatBinding(null)`: the cheatsheet's unbound chord.
            assert_eq!(
                claudius_overlays::help::chord_text(&unbound),
                case["out"]["mac"]
            );
            assert_eq!(
                claudius_overlays::help::chord_text(&unbound),
                case["out"]["other"]
            );
            continue;
        }
        let b = binding(&case["args"][0]);
        assert_eq!(format_binding(b, true), case["out"]["mac"], "{case}");
        assert_eq!(format_binding(b, false), case["out"]["other"], "{case}");
    }
}

#[test]
fn palette_rows_are_the_registry_with_the_platform_s_chords() {
    let f = fixture();
    let fmt = cases(&f, "formatBinding");
    for mac in [true, false] {
        let rows = palette_rows(mac);
        assert_eq!(rows.len(), REGISTRY.len());
        for ((row, a), t) in rows.iter().zip(&REGISTRY).zip(fmt) {
            assert_eq!(row.id, a.id);
            assert_eq!(row.label, a.label);
            assert_eq!(row.description.as_deref(), a.description);
            assert_eq!(row.category, a.category.id());
            let want = a
                .default
                .map(|_| t[if mac { "mac" } else { "other" }].as_str().unwrap());
            assert_eq!(row.chord.as_deref(), want, "{}", a.id);
        }
    }
}

/// `CommandPalette`'s `items` memo, over the app's registry rows.
#[test]
fn the_palette_items_over_the_registry_are_the_ts() {
    let f = fixture();
    for case in cases(&f, "items") {
        let ws = case["args"][0].as_str();
        let mac = case["args"][1] == "mac";
        let items = build_items(ws, SLASH_COMMANDS, &palette_rows(mac));
        let want = case["out"].as_array().unwrap();
        assert_eq!(items.len(), want.len(), "{ws:?}");
        for (i, w) in items.iter().zip(want) {
            assert_eq!(i.id, w["id"]);
            assert_eq!(i.kind.id(), w["kind"]);
            assert_eq!(i.label, w["label"]);
            assert_eq!(i.detail.as_deref(), opt_str(&w["detail"]), "{}", i.id);
            assert_eq!(i.href.as_deref(), opt_str(&w["href"]), "{}", i.id);
        }
    }
}

/// The shell's bindings are the registry's defaults, under the registry's
/// labels: `tab.selectByNumber` per digit (its modifiers), and the native
/// shell's own three (browser history, the appearance toggle) outside it.
#[test]
fn the_shell_bindings_are_the_registry_defaults() {
    const NATIVE: [&str; 3] = ["history.back", "history.forward", "view.appearance"];
    let mut bound = std::collections::HashSet::new();
    for s in shortcuts() {
        if NATIVE.contains(&s.id) {
            assert!(REGISTRY.iter().all(|a| a.id != s.id), "{}", s.id);
            continue;
        }
        let a = REGISTRY
            .iter()
            .find(|a| a.id == s.id)
            .unwrap_or_else(|| panic!("{} is in the registry", s.id));
        let default = a.default.expect("a bound action has a default");
        if a.modifier_only {
            let digit = s.binding.code.and_then(|c| c.strip_prefix("Digit"));
            assert!(
                digit.is_some_and(|d| ("1"..="9").contains(&d) && d.len() == 1),
                "{}",
                s.id
            );
            assert_eq!(
                (s.binding.cmd, s.binding.alt, s.binding.shift),
                (default.cmd, default.alt, default.shift)
            );
        } else {
            assert_eq!(s.binding, default, "{}", s.id);
            assert_eq!(s.label, a.label, "{}", s.id);
        }
        bound.insert(s.id);
    }
    // The palette and the cheatsheet are bound (U10a).
    assert!(bound.contains("nav.commandPalette"));
    assert!(bound.contains("nav.cheatsheet"));
}
