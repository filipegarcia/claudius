//! The overlays over the shell (U10a): ⌘K's command palette and ⌘/'s
//! cheatsheet from every route, the palette's search, selection and
//! navigation through the shell's router, Escape and an outside click
//! closing them, and the focus going back where it was.
//! macOS (the CoreText text system).

#![cfg(target_os = "macos")]

use std::sync::Arc;

use claudius_app::data::ShellData;
use claudius_app::fixture::FixtureShellData;
use claudius_app::overlays::OverlayKind;
use claudius_app::route::{Route, WorkspacePage};
use claudius_app::shell::{Appearance, Shell};
use claudius_chat::TranscriptSource;
use claudius_chat::fixture::FixtureTranscripts;
use claudius_composer::fixture::FixtureComposer;
use claudius_gpui_theme::ThemeName;
use claudius_overlays::view::help::HelpContent;
use gpui::{
    Entity, Focusable as _, Modifiers, TestAppContext, TestDispatcher, VisualTestContext, point,
    px, size,
};
use gpui_apple::AppleTextSystem;

const W1: &str = "wks_3f2a9c81d0e4";

fn app() -> TestAppContext {
    TestAppContext::build_with_text_system(
        TestDispatcher::new(0),
        None,
        Arc::new(AppleTextSystem::new()),
    )
}

/// The fixture shell on its chat route, with a composer.
fn open(app: &mut TestAppContext) -> (Entity<Shell>, &mut VisualTestContext) {
    app.update(|cx| claudius_app::init(ThemeName::Dark, cx));
    let data: Arc<dyn ShellData> = Arc::new(FixtureShellData::builtin());
    let src = FixtureTranscripts::builtin();
    let fx = FixtureComposer::builtin(src.clone(), None);
    let transcripts: Arc<dyn TranscriptSource> = src;
    let (shell, cx) = app.add_window_view(|window, cx| {
        Shell::with_transcripts(
            data,
            transcripts,
            Appearance::Fixed(ThemeName::Dark),
            window,
            cx,
        )
    });
    cx.simulate_resize(size(px(1440.), px(900.)));
    shell.update(cx, |s, cx| s.set_composer_target(fx, cx));
    settle(cx);
    (shell, cx)
}

/// The fixture shell on the Git page.
fn open_git(app: &mut TestAppContext) -> (Entity<Shell>, &mut VisualTestContext) {
    let (shell, cx) = open(app);
    shell.update(cx, |s, cx| {
        s.navigate(Route::page(W1, WorkspacePage::Git), cx)
    });
    settle(cx);
    (shell, cx)
}

fn settle(cx: &mut VisualTestContext) {
    for _ in 0..3 {
        cx.run_until_parked();
        cx.update(|window, cx| {
            window.refresh();
            window.draw(cx).clear(cx);
        });
    }
    cx.run_until_parked();
}

fn keys(cx: &mut VisualTestContext, keys: &str) {
    cx.simulate_keystrokes(keys);
    settle(cx);
}

fn kind(shell: &Entity<Shell>, cx: &mut VisualTestContext) -> Option<OverlayKind> {
    cx.read(|cx| shell.read(cx).overlay_kind())
}

fn route(shell: &Entity<Shell>, cx: &mut VisualTestContext) -> Route {
    cx.read(|cx| shell.read(cx).state().route().clone())
}

/// The palette's query, its rows' labels and the selected row.
fn palette(shell: &Entity<Shell>, cx: &mut VisualTestContext) -> (String, Vec<String>, i64) {
    cx.read(|cx| {
        let p = shell
            .read(cx)
            .command_palette()
            .expect("the palette is open");
        let m = p.read(cx).model();
        let labels = m.rows().iter().map(|r| r.label.clone()).collect();
        (m.query().to_owned(), labels, m.active())
    })
}

fn palette_focused(shell: &Entity<Shell>, cx: &mut VisualTestContext) -> bool {
    cx.update(|window, cx| {
        let p = shell
            .read(cx)
            .command_palette()
            .expect("the palette is open");
        p.read(cx).focus(cx).is_focused(window)
    })
}

fn focus_composer(shell: &Entity<Shell>, cx: &mut VisualTestContext) {
    cx.update(|window, cx| {
        let c = shell.read(cx).composer().expect("the composer");
        let f = c.read(cx).focus_handle(cx);
        window.focus(&f, cx);
    });
    settle(cx);
}

fn composer_focused(shell: &Entity<Shell>, cx: &mut VisualTestContext) -> bool {
    cx.update(|window, cx| {
        let c = shell.read(cx).composer().expect("the composer");
        c.read(cx).focus_handle(cx).is_focused(window)
    })
}

#[test]
fn cmd_k_opens_the_palette_on_a_page_route() {
    let mut app = app();
    let (shell, cx) = open_git(&mut app);
    assert_eq!(kind(&shell, cx), None);
    assert!(cx.debug_bounds("command-palette").is_none());
    keys(cx, "cmd-k");
    assert_eq!(kind(&shell, cx), Some(OverlayKind::Palette));
    let panel = cx.debug_bounds("command-palette").expect("the panel");
    assert_eq!(panel.size.width, px(680.));
    assert!(cx.debug_bounds("command-palette-backdrop").is_some());
    assert!(cx.debug_bounds("command-palette-input").is_some());
    assert!(cx.debug_bounds("command-palette-row-0").is_some());
    let (query, rows, active) = palette(&shell, cx);
    assert_eq!(query, "");
    assert_eq!(rows.len(), 60, "MAX_ROWS");
    assert_eq!(active, 0);
    assert!(
        palette_focused(&shell, cx),
        "the search box takes the focus"
    );
}

#[test]
fn cmd_k_opens_the_palette_from_the_composer_on_the_chat_route() {
    let mut app = app();
    let (shell, cx) = open(&mut app);
    assert!(matches!(route(&shell, cx), Route::Workspace { .. }));
    focus_composer(&shell, cx);
    assert!(composer_focused(&shell, cx));
    keys(cx, "cmd-k");
    assert_eq!(kind(&shell, cx), Some(OverlayKind::Palette));
    assert!(palette_focused(&shell, cx));
    // Over the composer.
    let panel = cx.debug_bounds("command-palette").expect("the panel");
    let composer = cx.debug_bounds("composer").expect("the composer");
    assert!(composer.top() > panel.top());
}

#[test]
fn typing_filters_the_rows() {
    let mut app = app();
    let (shell, cx) = open_git(&mut app);
    keys(cx, "cmd-k");
    keys(cx, "g i t");
    let (query, rows, active) = palette(&shell, cx);
    assert_eq!(query, "git");
    assert_eq!(rows.first().map(String::as_str), Some("Git"));
    assert!(rows.len() < 60);
    assert_eq!(active, 0);
    assert!(cx.debug_bounds("command-palette-empty").is_none());
    keys(cx, "q q q");
    let (query, rows, _) = palette(&shell, cx);
    assert_eq!(query, "gitqqq");
    assert!(rows.is_empty());
    assert!(cx.debug_bounds("command-palette-empty").is_some());
    assert!(cx.debug_bounds("command-palette-row-0").is_none());
}

#[test]
fn arrows_move_the_selection() {
    let mut app = app();
    let (shell, cx) = open_git(&mut app);
    keys(cx, "cmd-k");
    keys(cx, "down");
    assert_eq!(palette(&shell, cx).2, 1);
    keys(cx, "down down");
    assert_eq!(palette(&shell, cx).2, 3);
    keys(cx, "up");
    assert_eq!(palette(&shell, cx).2, 2);
    keys(cx, "up up up");
    assert_eq!(palette(&shell, cx).2, 0, "Math.max(0, i - 1)");
    assert_eq!(kind(&shell, cx), Some(OverlayKind::Palette));
}

#[test]
fn enter_on_a_nav_row_routes_there_and_closes() {
    let mut app = app();
    let (shell, cx) = open_git(&mut app);
    keys(cx, "cmd-k");
    keys(cx, "c o s t");
    assert_eq!(
        palette(&shell, cx).1.first().map(String::as_str),
        Some("Cost")
    );
    keys(cx, "enter");
    assert_eq!(kind(&shell, cx), None);
    assert!(cx.debug_bounds("command-palette").is_none());
    assert_eq!(route(&shell, cx), Route::page(W1, WorkspacePage::Cost));
    // A global destination.
    keys(cx, "cmd-k");
    keys(cx, "s e t t i n g s");
    keys(cx, "enter");
    assert_eq!(kind(&shell, cx), None);
    assert_eq!(route(&shell, cx), Route::Settings);
}

#[test]
fn enter_on_an_informational_row_only_closes() {
    let mut app = app();
    let (shell, cx) = open_git(&mut app);
    keys(cx, "cmd-k");
    keys(cx, "c l e a r");
    let first = cx.read(|cx| {
        let p = shell.read(cx).command_palette().unwrap();
        p.read(cx).model().active_item().map(|i| i.id.clone())
    });
    assert!(first.is_some_and(|id| id.starts_with("slash:")));
    keys(cx, "enter");
    assert_eq!(kind(&shell, cx), None);
    assert_eq!(route(&shell, cx), Route::page(W1, WorkspacePage::Git));
}

#[test]
fn escape_closes_and_cmd_k_toggles() {
    let mut app = app();
    let (shell, cx) = open_git(&mut app);
    keys(cx, "cmd-k");
    keys(cx, "escape");
    assert_eq!(kind(&shell, cx), None);
    assert!(cx.debug_bounds("command-palette").is_none());
    keys(cx, "cmd-k");
    assert_eq!(kind(&shell, cx), Some(OverlayKind::Palette));
    keys(cx, "cmd-k");
    assert_eq!(kind(&shell, cx), None);
    // Reopened fresh.
    keys(cx, "cmd-k");
    keys(cx, "g i t down");
    keys(cx, "escape");
    keys(cx, "cmd-k");
    let (query, _, active) = palette(&shell, cx);
    assert_eq!((query.as_str(), active), ("", 0));
}

#[test]
fn an_outside_click_closes_and_a_click_inside_does_not() {
    let mut app = app();
    let (shell, cx) = open_git(&mut app);
    keys(cx, "cmd-k");
    let panel = cx.debug_bounds("command-palette").expect("the panel");
    cx.simulate_click(panel.origin + point(px(8.), px(8.)), Modifiers::none());
    settle(cx);
    assert_eq!(kind(&shell, cx), Some(OverlayKind::Palette));
    // The backdrop takes the click: the Git page under it doesn't.
    cx.simulate_click(point(px(20.), px(880.)), Modifiers::none());
    settle(cx);
    assert_eq!(kind(&shell, cx), None);
    assert_eq!(route(&shell, cx), Route::page(W1, WorkspacePage::Git));
    // The header's X.
    keys(cx, "cmd-k");
    let x = cx.debug_bounds("command-palette-close").expect("the X");
    cx.simulate_click(x.center(), Modifiers::none());
    settle(cx);
    assert_eq!(kind(&shell, cx), None);
}

#[test]
fn a_clicked_row_activates_and_a_hovered_one_is_selected() {
    let mut app = app();
    let (shell, cx) = open_git(&mut app);
    keys(cx, "cmd-k");
    let row = cx.debug_bounds("command-palette-row-2").expect("row 2");
    cx.simulate_mouse_move(row.center(), None, Modifiers::none());
    settle(cx);
    assert_eq!(palette(&shell, cx).2, 2);
    let href = cx.read(|cx| {
        let p = shell.read(cx).command_palette().unwrap();
        p.read(cx).model().rows()[2]
            .href
            .clone()
            .expect("a nav row")
    });
    cx.simulate_click(row.center(), Modifiers::none());
    settle(cx);
    assert_eq!(kind(&shell, cx), None);
    assert_eq!(cx.read(|cx| shell.read(cx).state().route().path()), href);
}

#[test]
fn cmd_slash_opens_the_cheatsheet_with_the_bindings_labels() {
    let mut app = app();
    let (shell, cx) = open_git(&mut app);
    keys(cx, "cmd-/");
    assert_eq!(kind(&shell, cx), Some(OverlayKind::Cheatsheet));
    assert!(cx.debug_bounds("help-overlay").is_some());
    assert!(cx.debug_bounds("help-group-tabs").is_some());
    assert!(cx.debug_bounds("help-shortcut-tab.next").is_some());
    let rows = cx.read(|cx| {
        let v = shell.read(cx).help_overlay().expect("the cheatsheet");
        let HelpContent::Shortcuts(m) = v.read(cx).content() else {
            panic!("the shortcuts")
        };
        m.groups()
            .into_iter()
            .flat_map(|g| g.rows)
            .map(|r| (r.id.clone(), r.label.clone(), r.chord.clone()))
            .collect::<Vec<_>>()
    });
    assert_eq!(rows.len(), 61);
    let row = |id: &str| rows.iter().find(|r| r.0 == id).cloned().unwrap();
    assert_eq!(
        row("nav.commandPalette"),
        (
            "nav.commandPalette".into(),
            "Open command palette".into(),
            Some("⌘K".into())
        )
    );
    assert_eq!(row("nav.cheatsheet").2.as_deref(), Some("⌘/"));
    assert_eq!(row("tab.next").2.as_deref(), Some("⌘⌥→"));
    assert_eq!(row("window.zoom").2, None);
    // Its filter takes the keys.
    keys(cx, "p a l e t t e");
    assert!(
        cx.debug_bounds("help-shortcut-nav.commandPalette")
            .is_some()
    );
    assert!(cx.debug_bounds("help-shortcut-tab.next").is_none());
    keys(cx, "escape");
    assert_eq!(kind(&shell, cx), None);
    assert!(cx.debug_bounds("help-overlay").is_none());
}

#[test]
fn the_chords_switch_and_toggle_the_overlays() {
    let mut app = app();
    let (shell, cx) = open_git(&mut app);
    keys(cx, "cmd-/");
    keys(cx, "cmd-k");
    assert_eq!(kind(&shell, cx), Some(OverlayKind::Palette));
    assert!(cx.debug_bounds("help-overlay").is_none());
    keys(cx, "cmd-/");
    assert_eq!(kind(&shell, cx), Some(OverlayKind::Cheatsheet));
    assert!(cx.debug_bounds("command-palette").is_none());
    keys(cx, "cmd-/");
    assert_eq!(kind(&shell, cx), None);
}

#[test]
fn focus_returns_to_the_composer_after_closing() {
    let mut app = app();
    let (shell, cx) = open(&mut app);
    focus_composer(&shell, cx);
    keys(cx, "cmd-k");
    assert!(!composer_focused(&shell, cx));
    keys(cx, "escape");
    assert!(composer_focused(&shell, cx), "after Escape");
    keys(cx, "cmd-k");
    cx.simulate_click(point(px(20.), px(880.)), Modifiers::none());
    settle(cx);
    assert_eq!(kind(&shell, cx), None);
    assert!(composer_focused(&shell, cx), "after an outside click");
    // ⌘/ from the composer too.
    keys(cx, "cmd-/");
    assert_eq!(kind(&shell, cx), Some(OverlayKind::Cheatsheet));
    keys(cx, "cmd-k");
    assert_eq!(kind(&shell, cx), Some(OverlayKind::Palette));
    keys(cx, "cmd-k");
    assert_eq!(kind(&shell, cx), None);
    assert!(composer_focused(&shell, cx), "after switching overlays");
}

#[test]
fn the_shell_keeps_the_keys_after_the_palette_navigates() {
    let mut app = app();
    let (shell, cx) = open(&mut app);
    focus_composer(&shell, cx);
    keys(cx, "cmd-k");
    keys(cx, "g i t enter");
    assert_eq!(route(&shell, cx), Route::page(W1, WorkspacePage::Git));
    assert!(cx.update(|window, cx| window.focused(cx).is_some()));
    // The shell's chords still answer.
    keys(cx, "cmd-k");
    assert_eq!(kind(&shell, cx), Some(OverlayKind::Palette));
}

#[test]
fn the_help_overlay_shows_a_topic_s_usage() {
    let mut app = app();
    let (shell, cx) = open(&mut app);
    cx.update(|window, cx| shell.update(cx, |s, cx| s.open_help(Some("clear".into()), window, cx)));
    settle(cx);
    assert_eq!(kind(&shell, cx), Some(OverlayKind::Help));
    assert!(cx.debug_bounds("help-usage").is_some());
    assert!(cx.debug_bounds("help-group-session").is_some());
    keys(cx, "escape");
    assert_eq!(kind(&shell, cx), None);
    cx.update(|window, cx| shell.update(cx, |s, cx| s.open_help(Some("nope".into()), window, cx)));
    settle(cx);
    assert!(cx.debug_bounds("help-usage-missing").is_some());
}

/// The composer takes the focus as it binds a tab; leaving the chat route
/// unmounts it. The shell takes the focus back (GPUI's focus-lost
/// fallback), so ⌘K and the shell's other chords keep answering there.
#[test]
fn the_shell_keeps_the_keys_after_the_composer_unmounts() {
    let mut app = app();
    let (shell, cx) = open(&mut app);
    assert!(composer_focused(&shell, cx), "the composer auto-focuses");
    keys(cx, "cmd-alt-g");
    assert_eq!(route(&shell, cx), Route::page(W1, WorkspacePage::Git));
    keys(cx, "cmd-alt-b");
    assert_eq!(route(&shell, cx), Route::page(W1, WorkspacePage::Cost));
    keys(cx, "cmd-k");
    assert_eq!(kind(&shell, cx), Some(OverlayKind::Palette));
}

/// An open overlay is modal: a reopened ask's window keys (1–9, Escape)
/// don't reach it while the palette's field has them.
#[test]
fn an_open_overlay_keeps_the_keys_from_the_prompt_cards() {
    use claudius_prompts::target::samples;
    use claudius_prompts::{FixturePromptSource, PromptSource};
    let mut app = app();
    let (shell, cx) = open(&mut app);
    let fx = FixturePromptSource::new();
    let tab = cx
        .read(|cx| shell.read(cx).chat_tab())
        .expect("the chat tab");
    let _target = fx.session(&tab);
    let source: Arc<dyn PromptSource> = fx;
    shell.update(cx, |s, cx| s.set_prompt_source(source, cx));
    settle(cx);
    let input = serde_json::json!({ "questions": samples::ask_two("old")["questions"].clone() });
    cx.update(|_, cx| {
        let p = shell.read(cx).chat_prompts(&tab).expect("the cards");
        p.reopen_ask("toolu_old", &input, cx)
    });
    settle(cx);
    assert!(cx.debug_bounds("ask-backdrop").is_some());
    keys(cx, "cmd-k");
    keys(cx, "1");
    assert_eq!(palette(&shell, cx).0, "1", "the digit is the query's");
    keys(cx, "escape");
    assert_eq!(kind(&shell, cx), None);
    assert!(cx.debug_bounds("ask-backdrop").is_some(), "the ask stays");
}

/// The open overlay draws in the shell's theme, through an appearance
/// change.
#[test]
fn the_overlays_follow_the_shell_s_theme() {
    use claudius_overlays::view::style::Colors;
    let mut app = app();
    let (shell, cx) = open_git(&mut app);
    let light = Colors::of(ThemeName::Light);
    let dark = Colors::of(ThemeName::Dark);
    keys(cx, "cmd-k");
    let palette = |cx: &mut VisualTestContext| {
        cx.read(|cx| shell.read(cx).command_palette().unwrap().read(cx).colors())
    };
    assert_eq!(palette(cx), dark);
    cx.update(|window, cx| {
        shell.update(cx, |s, cx| {
            s.set_appearance(Appearance::Fixed(ThemeName::Light), window, cx)
        })
    });
    settle(cx);
    assert_eq!(palette(cx), light);
    keys(cx, "cmd-/");
    let cheatsheet = cx.read(|cx| shell.read(cx).help_overlay().unwrap().read(cx).colors());
    assert_eq!(cheatsheet, light);
    cx.update(|window, cx| {
        shell.update(cx, |s, cx| {
            s.set_appearance(Appearance::Fixed(ThemeName::Dark), window, cx)
        })
    });
    settle(cx);
    let cheatsheet = cx.read(|cx| shell.read(cx).help_overlay().unwrap().read(cx).colors());
    assert_eq!(cheatsheet, dark);
}
