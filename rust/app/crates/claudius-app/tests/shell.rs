//! The shell in a headless GPUI window (`TestAppContext`, CoreText for real
//! glyph widths): clicks on the rails, tabs and title bar, the shortcuts as
//! key presses, focus mode, the overflow menu, "Close all", the appearance
//! toggle and a data-source change. macOS (the CoreText text system).

#![cfg(target_os = "macos")]

use std::sync::Arc;

use claudius_app::data::{ShellChange, ShellData};
use claudius_app::fixture::FixtureShellData;
use claudius_app::nav::FocusLevel;
use claudius_app::route::{Route, WorkspacePage};
use claudius_app::shell::{Appearance, Shell};
use claudius_gpui_theme::{ThemeName, hsla};
use claudius_theme::Theme as Tokens;
use gpui::{
    Entity, Modifiers, TestAppContext, TestDispatcher, VisualTestContext, WindowAppearance, px,
    size,
};
use gpui_apple::AppleTextSystem;
use gpui_kit::component::ActiveTheme as _;

const W1: &str = "wks_3f2a9c81d0e4";
const W2: &str = "wks_7b41e05c92aa";
const W3: &str = "wks_c09d4e7f1b36";
const PINNED: &str = "8c1f0b2e-5d4a-4f7e-9a61-2b3c4d5e6f70";
const RUNNING: &str = "3e9a7c41-0b2d-4e8f-8c6a-1d2e3f405162";
const NEEDS: &str = "b7d24f19-6c3e-4a5b-9d8e-7f6a5b4c3d2e";
const UNTITLED: &str = "51c0e8a3-9f7b-4d2c-a1e6-0b9c8d7e6f5a";
const NO_ROW: &str = "0f4b8c2a-7e6d-4c5b-9a3f-2e1d0c9b8a7f";

fn app() -> TestAppContext {
    let cx = TestAppContext::build_with_text_system(
        TestDispatcher::new(0),
        None,
        Arc::new(AppleTextSystem::new()),
    );
    cx.update(|cx| claudius_app::init(ThemeName::Dark, cx));
    cx
}

fn open(
    app: &mut TestAppContext,
    data: Arc<FixtureShellData>,
    appearance: Appearance,
) -> (Entity<Shell>, &mut VisualTestContext) {
    let data: Arc<dyn ShellData> = data;
    let (shell, cx) = app.add_window_view(|window, cx| Shell::new(data, appearance, window, cx));
    cx.simulate_resize(size(px(1440.), px(900.)));
    settle(cx);
    (shell, cx)
}

fn builtin(app: &mut TestAppContext) -> (Entity<Shell>, &mut VisualTestContext) {
    open(
        app,
        Arc::new(FixtureShellData::builtin()),
        Appearance::Fixed(ThemeName::Dark),
    )
}

/// Runs the tasks, then draws (twice: the strip measures, then fits).
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

fn drawn(cx: &mut VisualTestContext, selector: &'static str) -> bool {
    cx.debug_bounds(selector).is_some()
}

fn click(cx: &mut VisualTestContext, selector: &'static str) {
    let b = cx
        .debug_bounds(selector)
        .unwrap_or_else(|| panic!("{selector} isn't on screen"));
    cx.simulate_click(b.center(), Modifiers::none());
    settle(cx);
}

fn keys(cx: &mut VisualTestContext, keystrokes: &str) {
    cx.simulate_keystrokes(keystrokes);
    settle(cx);
}

fn route(shell: &Entity<Shell>, cx: &mut VisualTestContext) -> Route {
    cx.read(|cx| shell.read(cx).state().route().clone())
}

fn active_tab(shell: &Entity<Shell>, cx: &mut VisualTestContext) -> Option<String> {
    cx.read(|cx| {
        let s = shell.read(cx).state();
        let ws = s.active_workspace()?.id.clone();
        s.strip(&ws)?.active().map(str::to_owned)
    })
}

fn tabs(shell: &Entity<Shell>, cx: &mut VisualTestContext) -> Vec<String> {
    cx.read(|cx| {
        let s = shell.read(cx).state();
        let ws = s.active_workspace().unwrap().id.clone();
        s.strip(&ws).unwrap().tabs().to_vec()
    })
}

fn workspace(shell: &Entity<Shell>, cx: &mut VisualTestContext) -> String {
    cx.read(|cx| {
        shell
            .read(cx)
            .state()
            .active_workspace()
            .unwrap()
            .id
            .clone()
    })
}

#[test]
fn boot_draws_the_rails_the_tabs_and_the_bound_session() {
    let mut app = app();
    let (shell, cx) = builtin(&mut app);
    assert_eq!(route(&shell, cx), Route::chat(W1));
    for sel in [
        "workspace-rail",
        "nav-rail",
        "session-tabs",
        "ws-0",
        "ws-1",
        "ws-2",
        "nav-nav.chat",
        "nav-nav.workspace",
        "sys-Settings",
        "tab-0",
        "tab-5",
        "tabs-new",
        "tabs-close-all",
        "chat-session",
        "history-back",
        "appearance",
    ] {
        assert!(drawn(cx, sel), "{sel}");
    }
    // The gated tiles hide until the customizations are known.
    assert!(!drawn(cx, "nav-nav.docker"));
    // Wide enough for every tab: no overflow chevron.
    assert!(!drawn(cx, "tabs-overflow"));
    assert_eq!(active_tab(&shell, cx).as_deref(), Some(RUNNING));
    // The rails sit left to right, the tabs over the screen.
    let ws = cx.debug_bounds("workspace-rail").unwrap();
    let nav = cx.debug_bounds("nav-rail").unwrap();
    let strip = cx.debug_bounds("session-tabs").unwrap();
    let screen = cx.debug_bounds("screen").unwrap();
    assert_eq!(f32::from(ws.size.width), 56.);
    assert_eq!(f32::from(nav.size.width), 56.);
    assert_eq!(f32::from(strip.size.height), 36.);
    assert!(nav.origin.x >= ws.origin.x + ws.size.width);
    assert!(strip.origin.x >= nav.origin.x + nav.size.width);
    assert!(screen.origin.y >= strip.origin.y + strip.size.height);
    // The pinned tab is compact; the active one is wider than its label's
    // minimum.
    let pinned = cx.debug_bounds("tab-0").unwrap();
    let active = cx.debug_bounds("tab-1").unwrap();
    assert!(pinned.size.width < px(48.), "{:?}", pinned.size);
    assert!(active.size.width > pinned.size.width);
}

#[test]
fn nav_tiles_and_history_route() {
    let mut app = app();
    let (shell, cx) = builtin(&mut app);
    click(cx, "nav-nav.git");
    assert_eq!(route(&shell, cx), Route::page(W1, WorkspacePage::Git));
    // The strip is the chat's.
    assert!(!drawn(cx, "session-tabs"));
    assert!(drawn(cx, "placeholder"));
    click(cx, "nav-nav.sessions");
    assert_eq!(route(&shell, cx), Route::page(W1, WorkspacePage::Sessions));
    click(cx, "history-back");
    assert_eq!(route(&shell, cx), Route::page(W1, WorkspacePage::Git));
    click(cx, "history-back");
    assert_eq!(route(&shell, cx), Route::chat(W1));
    assert!(drawn(cx, "session-tabs"));
    click(cx, "history-forward");
    assert_eq!(route(&shell, cx), Route::page(W1, WorkspacePage::Git));
    click(cx, "sys-Plugins");
    assert_eq!(route(&shell, cx), Route::Plugins);
    click(cx, "sys-Account");
    assert_eq!(route(&shell, cx), Route::Usage);
    // A global page keeps the rails.
    assert!(drawn(cx, "nav-rail") && drawn(cx, "workspace-rail"));
    click(cx, "nav-nav.chat");
    assert_eq!(route(&shell, cx), Route::chat(W1));
    assert_eq!(active_tab(&shell, cx).as_deref(), Some(RUNNING));
}

#[test]
fn nav_and_history_shortcuts() {
    let mut app = app();
    let (shell, cx) = builtin(&mut app);
    keys(cx, "cmd-alt-g");
    assert_eq!(route(&shell, cx), Route::page(W1, WorkspacePage::Git));
    keys(cx, "cmd-alt-f");
    assert_eq!(
        route(&shell, cx),
        Route::page(
            W1,
            WorkspacePage::Files {
                root: None,
                path: None
            }
        )
    );
    keys(cx, "cmd-alt-w");
    assert_eq!(route(&shell, cx), Route::page(W1, WorkspacePage::Workspace));
    keys(cx, "cmd-alt-m");
    assert_eq!(route(&shell, cx), Route::page(W1, WorkspacePage::Memory));
    keys(cx, "cmd-[");
    assert_eq!(route(&shell, cx), Route::page(W1, WorkspacePage::Workspace));
    keys(cx, "cmd-]");
    assert_eq!(route(&shell, cx), Route::page(W1, WorkspacePage::Memory));
    keys(cx, "cmd-,");
    assert_eq!(route(&shell, cx), Route::Settings);
    // The nav shortcuts work off the workspace pages too.
    keys(cx, "cmd-alt-c");
    assert_eq!(route(&shell, cx), Route::chat(W1));
    // A gated tile's shortcut does nothing while it's hidden.
    keys(cx, "cmd-alt-d");
    assert_eq!(route(&shell, cx), Route::chat(W1));
}

#[test]
fn tab_clicks_activate_close_and_open() {
    let mut app = app();
    let (shell, cx) = builtin(&mut app);
    click(cx, "tab-2");
    assert_eq!(active_tab(&shell, cx).as_deref(), Some(NEEDS));
    click(cx, "tab-0");
    assert_eq!(active_tab(&shell, cx).as_deref(), Some(PINNED));
    // Active, the pinned tab draws its label and buttons.
    assert!(drawn(cx, "tab-close-0"));
    click(cx, "tab-close-0");
    assert_eq!(tabs(&shell, cx).len(), 5);
    assert!(!tabs(&shell, cx).contains(&PINNED.to_owned()));
    // The first tab's "left neighbour" is the new first tab.
    assert_eq!(active_tab(&shell, cx).as_deref(), Some(RUNNING));
    click(cx, "tabs-new");
    let all = tabs(&shell, cx);
    assert_eq!(all.len(), 6);
    let new = active_tab(&shell, cx).unwrap();
    assert_eq!(all.last(), Some(&new));
    assert!(drawn(cx, "chat-session"));
    // Pin from the strip: it moves first.
    click(cx, "tab-pin-1");
    assert_eq!(tabs(&shell, cx)[0], NEEDS);
}

#[test]
fn tab_shortcuts() {
    let mut app = app();
    let (shell, cx) = builtin(&mut app);
    keys(cx, "cmd-alt-right");
    assert_eq!(active_tab(&shell, cx).as_deref(), Some(NEEDS));
    keys(cx, "cmd-alt-left");
    keys(cx, "cmd-alt-left");
    assert_eq!(active_tab(&shell, cx).as_deref(), Some(PINNED));
    keys(cx, "cmd-alt-left");
    assert_eq!(active_tab(&shell, cx).as_deref(), Some(NO_ROW));
    keys(cx, "cmd-4");
    assert_eq!(active_tab(&shell, cx).as_deref(), Some(UNTITLED));
    keys(cx, "cmd-shift-2");
    assert_eq!(active_tab(&shell, cx).as_deref(), Some(RUNNING));
    // macOS can report ⌘⇧3 as ⌘#.
    keys(cx, "cmd-#");
    assert_eq!(active_tab(&shell, cx).as_deref(), Some(NEEDS));
    keys(cx, "cmd-9");
    assert_eq!(active_tab(&shell, cx).as_deref(), Some(NO_ROW));
    keys(cx, "cmd-w");
    assert_eq!(tabs(&shell, cx).len(), 5);
    assert_eq!(
        active_tab(&shell, cx).as_deref(),
        Some("e2a96d07-4b1c-4f3e-8d5a-6c7b8a9f0e1d")
    );
    keys(cx, "cmd-shift-t");
    assert_eq!(tabs(&shell, cx).len(), 6);
    assert_eq!(active_tab(&shell, cx).as_deref(), Some(NO_ROW));
    keys(cx, "cmd-t");
    assert_eq!(tabs(&shell, cx).len(), 7);
    // Off the chat the tab shortcuts do nothing.
    keys(cx, "cmd-alt-g");
    let before = tabs(&shell, cx);
    keys(cx, "cmd-w");
    keys(cx, "cmd-t");
    keys(cx, "cmd-1");
    assert_eq!(tabs(&shell, cx), before);
}

#[test]
fn workspace_tiles_and_shortcuts_switch() {
    let mut app = app();
    let data = Arc::new(FixtureShellData::builtin());
    let (shell, cx) = open(&mut app, data.clone(), Appearance::Fixed(ThemeName::Dark));
    click(cx, "ws-1");
    assert_eq!(workspace(&shell, cx), W2);
    assert_eq!(route(&shell, cx), Route::chat(W2));
    assert_eq!(tabs(&shell, cx).len(), 3);
    // The store heard the selection.
    assert_eq!(data.snapshot().workspaces.active_id.as_deref(), Some(W2));
    // W2's rail is in its saved order: Files third.
    let files = cx.debug_bounds("nav-nav.files").unwrap();
    let sessions = cx.debug_bounds("nav-nav.sessions").unwrap();
    assert!(files.origin.y < sessions.origin.y);
    keys(cx, "cmd-alt-g");
    keys(cx, "cmd-shift-]");
    assert_eq!(route(&shell, cx), Route::chat(W3));
    keys(cx, "cmd-}");
    assert_eq!(workspace(&shell, cx), W1);
    keys(cx, "cmd-shift-[");
    assert_eq!(workspace(&shell, cx), W3);
    keys(cx, "cmd-{");
    // Back on W2: the page last open there.
    assert_eq!(route(&shell, cx), Route::page(W2, WorkspacePage::Git));
    keys(cx, "cmd-alt-1");
    assert_eq!(route(&shell, cx), Route::chat(W1));
    keys(cx, "cmd-alt-9");
    assert_eq!(workspace(&shell, cx), W1);
    click(cx, "ws-2");
    assert_eq!(workspace(&shell, cx), W3);
}

#[test]
fn focus_mode_hides_the_rails_on_the_chat() {
    let mut app = app();
    let (shell, cx) = builtin(&mut app);
    keys(cx, "cmd-.");
    assert_eq!(
        cx.read(|cx| shell.read(cx).state().focus()),
        FocusLevel::Focus
    );
    assert!(!drawn(cx, "nav-rail"));
    assert!(drawn(cx, "workspace-rail"));
    keys(cx, "cmd-.");
    assert!(!drawn(cx, "nav-rail") && !drawn(cx, "workspace-rail"));
    // The strip stays.
    assert!(drawn(cx, "session-tabs"));
    // Other pages show the rails, and ⌘. does nothing there.
    keys(cx, "cmd-alt-g");
    assert!(drawn(cx, "nav-rail") && drawn(cx, "workspace-rail"));
    keys(cx, "cmd-.");
    assert_eq!(
        cx.read(|cx| shell.read(cx).state().focus()),
        FocusLevel::Zen
    );
    keys(cx, "cmd-alt-c");
    assert!(!drawn(cx, "nav-rail"));
    keys(cx, "cmd-.");
    assert!(drawn(cx, "nav-rail") && drawn(cx, "workspace-rail"));
}

#[test]
fn close_all_asks_first() {
    let mut app = app();
    let (shell, cx) = builtin(&mut app);
    click(cx, "tabs-close-all");
    let message = cx.read(|cx| shell.read(cx).confirm().map(|c| c.message.clone()));
    assert_eq!(
        message.as_deref(),
        Some("Close 5 unpinned tabs? 1 pinned tab and sessions on disk remain.")
    );
    assert!(drawn(cx, "confirm-yes"));
    click(cx, "confirm-no");
    assert!(cx.read(|cx| shell.read(cx).confirm().is_none()));
    assert_eq!(tabs(&shell, cx).len(), 6);
    click(cx, "tabs-close-all");
    click(cx, "confirm-yes");
    assert_eq!(tabs(&shell, cx), [PINNED]);
    assert!(!drawn(cx, "confirm-yes"));
    // The bound session lingers: the chat still shows it, no tab is active.
    assert_eq!(active_tab(&shell, cx), None);
}

#[test]
fn narrow_windows_overflow_into_the_menu() {
    let mut app = app();
    let (shell, cx) = builtin(&mut app);
    cx.simulate_resize(size(px(760.), px(600.)));
    settle(cx);
    let hidden = cx.read(|cx| shell.read(cx).hidden_tabs().to_vec());
    assert!(!hidden.is_empty());
    assert!(
        !hidden.contains(&RUNNING.to_owned()),
        "the active tab stays"
    );
    assert!(drawn(cx, "tabs-overflow"));
    // The drawn tabs fit the strip minus the trailer.
    let strip = cx.debug_bounds("session-tabs").unwrap();
    let last = (0..6)
        .rev()
        .find_map(|i| {
            let sel: &'static str = ["tab-0", "tab-1", "tab-2", "tab-3", "tab-4", "tab-5"][i];
            cx.debug_bounds(sel)
        })
        .unwrap();
    assert!(last.origin.x + last.size.width <= strip.origin.x + strip.size.width);
    click(cx, "tabs-overflow");
    assert!(cx.read(|cx| shell.read(cx).overflow_open()));
    assert!(drawn(cx, "overflow-5"));
    click(cx, "overflow-5");
    assert_eq!(active_tab(&shell, cx).as_deref(), Some(NO_ROW));
    assert!(!cx.read(|cx| shell.read(cx).overflow_open()));
    // The newly active tab is drawn now; something else is hidden.
    assert!(drawn(cx, "tab-5"));
    let hidden = cx.read(|cx| shell.read(cx).hidden_tabs().to_vec());
    assert!(!hidden.contains(&NO_ROW.to_owned()));
    // Closing a hidden tab from the menu keeps the menu open.
    click(cx, "tabs-overflow");
    let first_hidden = cx.read(|cx| shell.read(cx).hidden_tabs()[0].clone());
    let idx = tabs(&shell, cx)
        .iter()
        .position(|t| *t == first_hidden)
        .unwrap();
    let sel: &'static str = [
        "overflow-close-0",
        "overflow-close-1",
        "overflow-close-2",
        "overflow-close-3",
        "overflow-close-4",
        "overflow-close-5",
    ][idx];
    click(cx, sel);
    assert!(!tabs(&shell, cx).contains(&first_hidden));
    assert!(cx.read(|cx| shell.read(cx).overflow_open()));
    // Wide again: everything fits.
    cx.simulate_resize(size(px(1600.), px(900.)));
    settle(cx);
    assert!(cx.read(|cx| shell.read(cx).hidden_tabs().is_empty()));
    assert!(!drawn(cx, "tabs-overflow"));
}

#[test]
fn appearance_follows_the_system_and_switches() {
    let mut app = app();
    let (shell, cx) = open(
        &mut app,
        Arc::new(FixtureShellData::builtin()),
        Appearance::System,
    );
    let theme = |cx: &mut VisualTestContext| cx.read(|cx| shell.read(cx).theme());
    let system = cx.update(|window, _| window.appearance());
    let expect = Appearance::System.theme(system);
    assert_eq!(theme(cx), expect);
    assert_eq!(
        cx.read(|cx| cx.theme().background),
        hsla(Tokens::of(expect).palette.background)
    );
    click(cx, "appearance");
    assert_eq!(theme(cx), ThemeName::Light);
    assert_eq!(
        cx.read(|cx| cx.theme().background),
        hsla(Tokens::of(ThemeName::Light).palette.background)
    );
    keys(cx, "cmd-alt-shift-l");
    assert_eq!(theme(cx), ThemeName::Dark);
    assert!(cx.read(|cx| cx.theme().mode.is_dark()));
    click(cx, "appearance");
    assert_eq!(
        cx.read(|cx| shell.read(cx).appearance()),
        Appearance::System
    );
    assert_eq!(theme(cx), expect);

    assert_eq!(
        Appearance::System.theme(WindowAppearance::VibrantDark),
        ThemeName::Dark
    );
    assert_eq!(
        Appearance::System.theme(WindowAppearance::VibrantLight),
        ThemeName::Light
    );
    assert_eq!(
        Appearance::Fixed(ThemeName::Paper).theme(WindowAppearance::Dark),
        ThemeName::Paper
    );
    assert_eq!(Appearance::parse("system"), Some(Appearance::System));
    assert_eq!(
        Appearance::parse("synthwave"),
        Some(Appearance::Fixed(ThemeName::Synthwave))
    );
    assert_eq!(Appearance::parse("nope"), None);
}

#[test]
fn data_changes_reach_the_screen() {
    let mut app = app();
    let data = Arc::new(FixtureShellData::builtin());
    let (shell, cx) = open(&mut app, data.clone(), Appearance::Fixed(ThemeName::Light));
    // A session renamed and finishing its turn elsewhere.
    data.change(
        ShellChange::Sessions {
            workspace_id: W1.into(),
        },
        |f| {
            let s = f.sessions.iter_mut().find(|s| s.id == UNTITLED).unwrap();
            s.title = Some("Renamed elsewhere".into());
        },
    );
    settle(cx);
    let label = cx.read(|cx| {
        let views = shell.read(cx).state().tab_views(None, 2026);
        views
            .iter()
            .find(|v| v.id == UNTITLED)
            .unwrap()
            .label
            .clone()
    });
    assert_eq!(label, "Renamed elsewhere");
    // A workspace added in another window shows on the rail.
    data.change(ShellChange::Workspaces, |f| {
        let mut w = f.workspaces.workspaces[2].clone();
        w.id = "wks_0123456789ab".into();
        w.name = "added".into();
        f.workspaces.workspaces.push(w);
    });
    settle(cx);
    assert!(drawn(cx, "ws-3"));
    // The tab changes were saved as they happened.
    click(cx, "tab-3");
    assert_eq!(
        data.snapshot().open_tabs[W1].active_id.as_deref(),
        Some(UNTITLED)
    );
}
