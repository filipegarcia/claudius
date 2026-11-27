//! The pickers in a headless GPUI window (`TestAppContext`, CoreText) over
//! the fixture target: `/` opens the slash commands (the registry and the
//! session's SDK commands), typing filters, ↑ / ↓ / Tab / Enter / Escape
//! as the TS, a pick inserts; `@` lists the fixture's files and agents and
//! shows a failed search; `:smi` offers shortcodes; the setting turns emoji
//! completion off; Enter with a picker open picks instead of sending.
//! macOS (the CoreText text system).

#![cfg(target_os = "macos")]

use std::sync::Arc;

use claudius_chat::fixture::{EventLine, FixtureTranscripts};
use claudius_composer::fixture::FixtureComposer;
use claudius_composer::model::Menu;
use claudius_composer::{ComposerTarget, ComposerView};
use claudius_gpui_theme::ThemeName;
use gpui::{
    AppContext as _, Context, Entity, IntoElement, Modifiers, ParentElement as _, Render,
    Styled as _, TestAppContext, TestDispatcher, VisualTestContext, Window, div, px, size,
};
use gpui_apple::AppleTextSystem;
use serde_json::json;

const S1: &str = "pickers-s1";

fn app() -> TestAppContext {
    let cx = TestAppContext::build_with_text_system(
        TestDispatcher::new(0),
        None,
        Arc::new(AppleTextSystem::new()),
    );
    cx.update(|cx| {
        gpui_kit::init(cx);
        claudius_gpui_theme::init(ThemeName::Dark, cx);
    });
    cx
}

fn fixture() -> Arc<FixtureComposer> {
    FixtureComposer::new(Arc::new(FixtureTranscripts::new()), None)
}

/// The composer at the bottom of the window, as the chat route stacks it
/// under the transcript (the panels open above it).
struct Host(Entity<ComposerView>);

impl Render for Host {
    fn render(&mut self, _: &mut Window, _: &mut Context<Self>) -> impl IntoElement {
        div()
            .size_full()
            .flex()
            .flex_col()
            .justify_end()
            .child(self.0.clone())
    }
}

fn open<'a>(
    app: &'a mut TestAppContext,
    fx: &Arc<FixtureComposer>,
) -> (Entity<ComposerView>, &'a mut VisualTestContext) {
    let target: Arc<dyn ComposerTarget> = fx.clone();
    let (host, cx) = app.add_window_view(|window, cx| {
        Host(cx.new(|cx| ComposerView::new(target, ThemeName::Dark, window, cx)))
    });
    let view = cx.update(|_, cx| host.read(cx).0.clone());
    cx.simulate_resize(size(px(900.), px(700.)));
    view.update_in(cx, |v, window, cx| v.set_session(Some(S1), window, cx));
    settle(cx);
    (view, cx)
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

fn drawn(cx: &mut VisualTestContext, selector: &'static str) -> bool {
    cx.debug_bounds(selector).is_some()
}

fn keys(cx: &mut VisualTestContext, k: &str) {
    cx.simulate_keystrokes(k);
    settle(cx);
}

fn typed(cx: &mut VisualTestContext, text: &str) {
    cx.simulate_input(text);
    settle(cx);
}

fn click(cx: &mut VisualTestContext, selector: &'static str) {
    let b = cx
        .debug_bounds(selector)
        .unwrap_or_else(|| panic!("{selector} is drawn"));
    cx.simulate_click(b.center(), Modifiers::default());
    settle(cx);
}

fn editor_text(view: &Entity<ComposerView>, cx: &mut VisualTestContext) -> String {
    cx.update(|_, cx| view.read(cx).editor().read(cx).value().to_string())
}

fn menu(view: &Entity<ComposerView>, cx: &mut VisualTestContext) -> Option<Menu> {
    cx.update(|_, cx| view.read(cx).model().menu())
}

/// The open picker's row labels and highlight.
fn rows(view: &Entity<ComposerView>, cx: &mut VisualTestContext) -> (Vec<String>, usize) {
    match menu(view, cx) {
        Some(Menu::Slash(m)) => (
            m.rows.iter().map(|r| r.suggestion.name.clone()).collect(),
            m.hi,
        ),
        Some(Menu::At(m)) => (m.rows.iter().map(|r| r.label().to_owned()).collect(), m.hi),
        Some(Menu::Emoji(m)) => (m.rows.iter().map(|r| r.0.to_owned()).collect(), m.hi),
        None => (Vec::new(), 0),
    }
}

fn sent(fx: &FixtureComposer) -> usize {
    let mut n = 0;
    fx.read(S1, &mut |s| n = s.messages.len());
    n
}

#[test]
fn a_slash_opens_the_commands_and_typing_filters_them() {
    let mut app = app();
    let fx = fixture();
    let (view, cx) = open(&mut app, &fx);
    assert!(!drawn(cx, "composer-slash-picker"));
    typed(cx, "/");
    assert!(drawn(cx, "composer-slash-picker"));
    assert!(drawn(cx, "composer-slash-row-0"));
    let (names, hi) = rows(&view, cx);
    assert_eq!((names.len(), hi), (16, 0));
    assert_eq!(names[0], "clear");
    // The session's SDK commands (the fixture's `supportedCommands()`).
    typed(cx, "dep");
    assert_eq!(editor_text(&view, cx), "/dep");
    let (names, _) = rows(&view, cx);
    assert_eq!(names[0], "deploy");
    let Some(Menu::Slash(m)) = menu(&view, cx) else {
        panic!("the slash picker")
    };
    assert_eq!(m.rows[0].name[0], ("dep".to_owned(), true));
    assert_eq!(
        m.rows[0].suggestion.args_hint.as_deref(),
        Some("<staging|production>")
    );
    typed(cx, "zzz");
    assert!(!drawn(cx, "composer-slash-picker"));
}

#[test]
fn arrows_enter_and_escape_drive_the_slash_picker() {
    let mut app = app();
    let fx = fixture();
    let (view, cx) = open(&mut app, &fx);
    typed(cx, "/re");
    let (names, _) = rows(&view, cx);
    keys(cx, "down");
    assert_eq!(rows(&view, cx).1, 1);
    keys(cx, "up");
    keys(cx, "up");
    assert_eq!(rows(&view, cx).1, names.len() - 1);
    keys(cx, "down");
    // Escape closes it; the text stays.
    keys(cx, "escape");
    assert!(menu(&view, cx).is_none());
    assert_eq!(editor_text(&view, cx), "/re");
    // An edit brings it back; Enter on a leading `/word` runs the top
    // (confident) match instead of sending.
    typed(cx, "s");
    let top = rows(&view, cx).0[0].clone();
    keys(cx, "enter");
    assert_eq!(editor_text(&view, cx), format!("/{top} "));
    assert!(menu(&view, cx).is_none());
    assert_eq!(sent(&fx), 0);
}

#[test]
fn tab_inserts_a_command_mid_prompt_and_enter_still_sends() {
    let mut app = app();
    let fx = fixture();
    let (view, cx) = open(&mut app, &fx);
    typed(cx, "please /comp");
    assert!(drawn(cx, "composer-slash-picker"));
    keys(cx, "tab");
    assert_eq!(editor_text(&view, cx), "please /compact ");
    typed(cx, "now /comp");
    keys(cx, "enter");
    assert_eq!(editor_text(&view, cx), "");
    assert!(sent(&fx) > 0);
}

#[test]
fn a_click_picks_a_command() {
    let mut app = app();
    let fx = fixture();
    let (view, cx) = open(&mut app, &fx);
    typed(cx, "/co");
    let second = rows(&view, cx).0[1].clone();
    click(cx, "composer-slash-row-1");
    assert_eq!(editor_text(&view, cx), format!("/{second} "));
}

#[test]
fn an_at_lists_the_fixtures_files_and_a_pick_inserts_the_path() {
    let mut app = app();
    let fx = fixture();
    let (view, cx) = open(&mut app, &fx);
    typed(cx, "look at @slash");
    assert!(drawn(cx, "composer-at-picker"));
    let (names, _) = rows(&view, cx);
    assert_eq!(
        names,
        [
            "rust/app/crates/claudius-composer/src/slash.rs",
            "components/chat/SlashCommandPicker.tsx",
            "lib/shared/slash-commands.ts"
        ]
    );
    // The search went with the session's cwd.
    let asked = fx
        .requests()
        .into_iter()
        .any(|(_, url, _)| url == "/api/fs/list?q=slash&limit=50&cwd=%2Fdemo%2Fclaudius");
    assert!(asked);
    keys(cx, "down");
    keys(cx, "down");
    keys(cx, "enter");
    assert_eq!(
        editor_text(&view, cx),
        "look at @lib/shared/slash-commands.ts "
    );
    assert!(!drawn(cx, "composer-at-picker"));
    assert_eq!(sent(&fx), 0);
}

#[test]
fn an_agent_mention_lists_the_sessions_agents() {
    let mut app = app();
    let fx = fixture();
    let (view, cx) = open(&mut app, &fx);
    typed(cx, "@agent-");
    let (names, _) = rows(&view, cx);
    assert_eq!(
        names,
        ["code-reviewer", "docs-writer", "Explore", "general-purpose"]
    );
    typed(cx, "rev");
    keys(cx, "tab");
    assert_eq!(editor_text(&view, cx), "@agent-code-reviewer ");
}

#[test]
fn a_failed_search_shows_the_error_row() {
    let mut app = app();
    let fx = fixture();
    fx.fail_file_search(Some((
        403,
        "Search failed: permission denied \u{2014} can't read this folder (EACCES)",
    )));
    let (view, cx) = open(&mut app, &fx);
    typed(cx, "@src");
    assert!(drawn(cx, "composer-at-search-error"));
    let Some(Menu::At(m)) = menu(&view, cx) else {
        panic!("the @ picker")
    };
    assert_eq!(m.count, "0 files");
    assert!(m.error.unwrap().contains("EACCES"));
    // The search answers again: the next query lists.
    fx.fail_file_search(None);
    typed(cx, "/");
    assert!(!drawn(cx, "composer-at-search-error"));
}

#[test]
fn a_shortcode_offers_emoji_and_a_pick_inserts_it() {
    let mut app = app();
    let fx = fixture();
    let (view, cx) = open(&mut app, &fx);
    typed(cx, "nice :smi");
    assert!(drawn(cx, "composer-emoji-picker"));
    assert_eq!(rows(&view, cx).0[0], "smile");
    keys(cx, "enter");
    assert_eq!(editor_text(&view, cx), "nice \u{1f604} ");
    assert_eq!(sent(&fx), 0);
    // The closing `:` of a known name completes it as typed.
    typed(cx, ":fire:");
    assert_eq!(editor_text(&view, cx), "nice \u{1f604} \u{1f525}");
}

#[test]
fn the_setting_turns_emoji_completion_off() {
    let mut app = app();
    let fx = fixture();
    fx.set_emoji_completion(Some(false));
    let (view, cx) = open(&mut app, &fx);
    assert!(!cx.update(|_, cx| view.read(cx).model().emoji_completion_enabled()));
    typed(cx, ":smi");
    assert!(!drawn(cx, "composer-emoji-picker"));
    typed(cx, "le:");
    assert_eq!(editor_text(&view, cx), ":smile:");
}

#[test]
fn the_sessions_init_reaches_an_open_picker() {
    let mut app = app();
    let fx = fixture();
    // A ready session whose init (its command names, its folder) lands
    // after the bind.
    let ready = EventLine {
        at: 1.0,
        data: json!({"type": "ready", "sessionId": S1}).to_string(),
    };
    let init = EventLine {
        at: 2.0,
        data: json!({"type": "sdk", "message": {
            "type": "system", "subtype": "init", "uuid": "i1",
            "slash_commands": ["triage-inbox"], "cwd": "/work/elsewhere",
        }})
        .to_string(),
    };
    fx.transcripts().insert_streaming(S1, &[ready], vec![init]);
    let (view, cx) = open(&mut app, &fx);
    typed(cx, "/triage");
    assert_eq!(editor_text(&view, cx), "/triage");
    assert!(!rows(&view, cx).0.iter().any(|n| n == "triage-inbox"));
    assert!(fx.transcripts().advance(S1));
    settle(cx);
    assert_eq!(rows(&view, cx).0[0], "triage-inbox");
    // The emoji setting is read again for the new folder.
    assert!(
        fx.requests()
            .iter()
            .any(|(m, u, _)| m == "GET" && u == "/api/settings?scope=user&cwd=%2Fwork%2Felsewhere")
    );
}
