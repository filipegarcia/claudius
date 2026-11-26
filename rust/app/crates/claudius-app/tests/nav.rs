//! The rails' contents and the shortcut registry: `SideNav`'s tiles, gate
//! and order, the system tiles, workspace icons, the default bindings as
//! GPUI keystrokes and as the UI writes them.

use claudius_app::data::{Workspace, WorkspaceIcon};
use claudius_app::nav::{
    FocusLevel, apply_nav_order, is_active, items, system_tiles, visible_items,
};
use claudius_app::route::{Route, WorkspacePage};
use claudius_app::shortcuts::{Binding, binding_of, format_binding, keystrokes, shortcuts};
use serde_json::json;

const A: &str = "wks_3f2a9c81d0e4";

fn s(v: &[&str]) -> Vec<String> {
    v.iter().map(|x| (*x).to_owned()).collect()
}

#[test]
fn the_rail_lists_sidenav_s_tiles_in_order() {
    let labels: Vec<&str> = items().iter().map(|i| i.label).collect();
    assert_eq!(
        labels,
        [
            "Chat",
            "Git",
            "Sessions",
            "Files",
            "Memory",
            "Assets",
            "Cost",
            "Agents",
            "Skills",
            "MCP",
            "Hooks",
            "Schedule",
            "Permissions",
            "Docker",
            "Tracker",
            "Database",
            "Notebooks",
            "Workspace",
        ]
    );
    // Every tile's page is a workspace page, and its action is a shortcut.
    for it in items() {
        let route = Route::page(A, it.page.clone());
        assert_eq!(Route::parse(&route.path()), Some(route), "{}", it.label);
        assert!(binding_of(it.action_id).is_some(), "{}", it.action_id);
    }
    // The gated tiles hide until their customization is known and on.
    let shown: Vec<&str> = visible_items(None, None).iter().map(|i| i.label).collect();
    assert_eq!(shown.len(), 14);
    assert!(!shown.contains(&"Docker"));
    let on = s(&["tracker", "Database Console"]);
    let shown: Vec<&str> = visible_items(Some(&on), None)
        .iter()
        .map(|i| i.label)
        .collect();
    assert_eq!(shown.len(), 16);
    assert!(shown.contains(&"Tracker") && shown.contains(&"Database"));
    assert!(!shown.contains(&"Notebooks"));
}

#[test]
fn a_saved_order_goes_first_then_the_rest_in_place() {
    let order = s(&[
        "nav.git",
        "nav.nope",
        "nav.chat",
        "nav.git",
        "nav.workspace",
    ]);
    let ids: Vec<&str> = apply_nav_order(items(), Some(&order))
        .iter()
        .map(|i| i.action_id)
        .collect();
    assert_eq!(
        &ids[..4],
        ["nav.git", "nav.chat", "nav.workspace", "nav.sessions"]
    );
    assert_eq!(ids.len(), items().len());
    let empty: Vec<String> = Vec::new();
    assert_eq!(apply_nav_order(items(), Some(&empty)), items());
    assert_eq!(apply_nav_order(items(), None), items());
}

#[test]
fn a_tile_lights_on_its_exact_page() {
    let git = items().into_iter().find(|i| i.label == "Git").unwrap();
    let sessions = items().into_iter().find(|i| i.label == "Sessions").unwrap();
    let files = items().into_iter().find(|i| i.label == "Files").unwrap();
    let chat = items().into_iter().find(|i| i.label == "Chat").unwrap();
    assert!(is_active(&git, &Route::page(A, WorkspacePage::Git)));
    assert!(!is_active(
        &git,
        &Route::page(
            A,
            WorkspacePage::GitFile {
                path: "x".into(),
                mode: None
            }
        )
    ));
    assert!(!is_active(
        &sessions,
        &Route::page(A, WorkspacePage::Session { id: "s".into() })
    ));
    assert!(is_active(
        &files,
        &Route::page(
            A,
            WorkspacePage::Files {
                root: Some("r".into()),
                path: None
            }
        )
    ));
    assert!(is_active(
        &chat,
        &Route::page(
            A,
            WorkspacePage::Chat {
                session: Some("s".into())
            }
        )
    ));
    assert!(!is_active(&chat, &Route::Settings));

    let tiles = system_tiles();
    let labels: Vec<&str> = tiles.iter().map(|t| t.label).collect();
    assert_eq!(labels, ["Community", "Plugins", "Settings", "Account"]);
    for t in &tiles {
        assert!(t.route.path().starts_with(t.prefix));
    }
}

#[test]
fn focus_levels_cycle_and_hide_rails() {
    assert_eq!(FocusLevel::Off.next(), FocusLevel::Focus);
    assert_eq!(FocusLevel::Focus.next(), FocusLevel::Zen);
    assert_eq!(FocusLevel::Zen.next(), FocusLevel::Off);
    assert!(FocusLevel::Off.shows_nav_rail() && FocusLevel::Off.shows_workspace_rail());
    assert!(!FocusLevel::Focus.shows_nav_rail() && FocusLevel::Focus.shows_workspace_rail());
    assert!(!FocusLevel::Zen.shows_nav_rail() && !FocusLevel::Zen.shows_workspace_rail());
    assert_eq!(
        [FocusLevel::Off, FocusLevel::Focus, FocusLevel::Zen].map(FocusLevel::as_str),
        ["off", "focus", "zen"]
    );
}

fn workspace(v: serde_json::Value) -> Workspace {
    serde_json::from_value(v).unwrap()
}

#[test]
fn workspace_icons_read_like_workspaceicon_tsx() {
    let base = |icon: serde_json::Value, name: &str| {
        workspace(json!({
            "id": A, "name": name, "rootPath": "/r", "icon": icon,
            "createdAt": 1, "updatedAt": 2, "pinned": true
        }))
    };
    let w = base(
        json!({"kind": "letter", "letter": "Q", "color": "#5588dd"}),
        "x",
    );
    assert_eq!(
        w.icon(),
        WorkspaceIcon::Letter {
            letter: "Q".into(),
            color: "#5588dd".into()
        }
    );
    assert_eq!(w.letter(), "Q");
    // Unknown fields survive a round trip (`extra`).
    assert_eq!(serde_json::to_value(&w).unwrap()["pinned"], json!(true));
    assert_eq!(
        base(json!({"kind": "letter", "letter": ""}), "ñandu").letter(),
        "Ñ"
    );
    assert_eq!(base(json!({}), "").letter(), "?");
    let img = base(json!({"kind": "image", "ext": "png"}), "docs");
    assert_eq!(img.icon(), WorkspaceIcon::Image { ext: "png".into() });
    assert_eq!(img.letter(), "D");
    assert!(!img.is_customization());
    let mut c = base(json!({}), "c");
    c.kind = Some("customization".into());
    assert!(c.is_customization());
}

#[test]
fn bindings_become_gpui_keystrokes() {
    let b = |cmd, alt, shift, code| Binding {
        cmd,
        alt,
        shift,
        code: Some(code),
    };
    assert_eq!(
        keystrokes(b(true, true, false, "ArrowRight"), true),
        ["cmd-alt-right"]
    );
    assert_eq!(
        keystrokes(b(true, true, false, "ArrowRight"), false),
        ["ctrl-alt-right"]
    );
    // A shifted digit or bracket also matches the character it types.
    assert_eq!(
        keystrokes(b(true, false, true, "BracketRight"), true),
        ["cmd-shift-]", "cmd-}"]
    );
    assert_eq!(
        keystrokes(b(true, false, true, "Digit3"), true),
        ["cmd-shift-3", "cmd-#"]
    );
    assert_eq!(
        keystrokes(b(true, false, true, "KeyT"), true),
        ["cmd-shift-t"]
    );
    assert_eq!(keystrokes(b(true, false, false, "Period"), true), ["cmd-."]);
    assert!(keystrokes(b(true, false, false, "F13"), true).is_empty());
    assert!(
        keystrokes(
            Binding {
                code: None,
                ..b(true, false, true, "KeyA")
            },
            true
        )
        .is_empty()
    );
}

#[test]
fn the_registry_defaults() {
    let mac = |id: &str| format_binding(binding_of(id).unwrap(), true);
    let pc = |id: &str| format_binding(binding_of(id).unwrap(), false);
    assert_eq!(mac("tab.next"), "⌘⌥→");
    assert_eq!(pc("tab.next"), "Ctrl+Alt+Right");
    assert_eq!(mac("tab.prev"), "⌘⌥←");
    assert_eq!(mac("tab.selectByNumber"), "⌘⇧1");
    assert_eq!(mac("workspace.next"), "⌘⇧]");
    assert_eq!(mac("workspace.prev"), "⌘⇧[");
    assert_eq!(mac("workspace.go3"), "⌘⌥3");
    assert_eq!(mac("nav.chat"), "⌘⌥C");
    assert_eq!(mac("nav.workspace"), "⌘⌥W");
    assert_eq!(mac("tab.new"), "⌘T");
    assert_eq!(mac("tab.close"), "⌘W");
    assert_eq!(mac("tab.reopen"), "⌘⇧T");
    assert_eq!(mac("tab.last"), "⌘9");
    assert_eq!(mac("tab.go8"), "⌘8");
    assert_eq!(mac("view.focusMode"), "⌘.");
    assert_eq!(pc("app.preferences"), "Ctrl+,");
    assert_eq!(mac("history.back"), "⌘[");
    assert_eq!(mac("history.forward"), "⌘]");
    let modifier_only = Binding {
        code: None,
        ..binding_of("tab.selectByNumber").unwrap()
    };
    assert_eq!(format_binding(modifier_only, true), "⌘⇧1…9");
    assert_eq!(format_binding(modifier_only, false), "Ctrl+Shift+1-9");
    assert_eq!(binding_of("nope"), None);

    // No two shortcuts share a key.
    let mut seen = std::collections::HashSet::new();
    for sc in shortcuts() {
        for k in keystrokes(sc.binding, true) {
            assert!(seen.insert(k.clone()), "{k} is bound twice");
        }
    }
    assert_eq!(seen.len(), 68);
}

#[test]
fn the_version_is_package_json_s() {
    assert_eq!(claudius_app::VERSION_DISPLAY, "v0.3.327.0");
    // `CLAUDIUS_VERSION_DISPLAY` is `v<package.json version>.<release>`,
    // the release `0` locally. The repo's package.json, when built in it.
    let pkg = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../../package.json");
    if let Ok(text) = std::fs::read_to_string(pkg) {
        let v: serde_json::Value = serde_json::from_str(&text).unwrap();
        let version = v["version"].as_str().unwrap();
        assert_eq!(claudius_app::VERSION_DISPLAY, format!("v{version}.0"));
    }
}
