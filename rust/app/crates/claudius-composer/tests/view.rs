//! The composer in a headless GPUI window (`TestAppContext`, CoreText for
//! real glyph widths) over the fixture target: typing and Enter send,
//! Shift+Enter breaks the line, Cmd+↑ recalls, a send while a reply plays
//! queues, the queue strip's buttons, `!` mode, the draft across a tab
//! switch, Stop. macOS (the CoreText text system).

#![cfg(target_os = "macos")]

use std::sync::Arc;

use claudius_chat::fixture::FixtureTranscripts;
use claudius_client::types::{DisplayBlock, Role};
use claudius_composer::fixture::FixtureComposer;
use claudius_composer::{ComposerTarget, ComposerView};
use claudius_gpui_theme::ThemeName;
use gpui::{
    Entity, Focusable as _, Modifiers, TestAppContext, TestDispatcher, VisualTestContext, px, size,
};
use gpui_apple::AppleTextSystem;
use serde_json::json;

const S1: &str = "composer-s1";
const S2: &str = "composer-s2";

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

fn open<'a>(
    app: &'a mut TestAppContext,
    fx: &Arc<FixtureComposer>,
    session: &str,
) -> (Entity<ComposerView>, &'a mut VisualTestContext) {
    let target: Arc<dyn ComposerTarget> = fx.clone();
    let (view, cx) =
        app.add_window_view(|window, cx| ComposerView::new(target, ThemeName::Dark, window, cx));
    cx.simulate_resize(size(px(900.), px(600.)));
    bind(&view, cx, session);
    (view, cx)
}

fn bind(view: &Entity<ComposerView>, cx: &mut VisualTestContext, session: &str) {
    let id = session.to_owned();
    view.update_in(cx, |v, window, cx| v.set_session(Some(&id), window, cx));
    settle(cx);
}

/// Runs the tasks (fetches, calls, the change feed), then draws.
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
        .unwrap_or_else(|| panic!("{selector} is drawn"));
    cx.simulate_click(b.center(), Modifiers::default());
    settle(cx);
}

fn keys(cx: &mut VisualTestContext, k: &str) {
    cx.simulate_keystrokes(k);
    settle(cx);
}

fn typed(cx: &mut VisualTestContext, text: &str) {
    cx.simulate_input(text);
    settle(cx);
}

fn editor_text(view: &Entity<ComposerView>, cx: &mut VisualTestContext) -> String {
    cx.update(|_, cx| view.read(cx).editor().read(cx).value().to_string())
}

fn model_text(view: &Entity<ComposerView>, cx: &mut VisualTestContext) -> String {
    cx.update(|_, cx| view.read(cx).model().value().to_owned())
}

/// The session's user prompts, as the transcript shows them.
fn prompts(fx: &FixtureComposer, id: &str) -> Vec<String> {
    let mut out = Vec::new();
    fx.read(id, &mut |s| {
        out = s
            .messages
            .iter()
            .filter(|m| m.role == Role::User)
            .map(|m| {
                m.blocks
                    .iter()
                    .map(|b| match b {
                        DisplayBlock::Text { text, .. } => text.as_str(),
                        _ => "",
                    })
                    .collect()
            })
            .collect();
    });
    out
}

fn queued(fx: &FixtureComposer, id: &str) -> Vec<String> {
    let mut out = Vec::new();
    fx.read(id, &mut |s| {
        out = s
            .queue
            .iter()
            .map(|q| q["text"].as_str().unwrap_or("").to_owned())
            .collect();
    });
    out
}

fn pending(fx: &FixtureComposer, id: &str) -> bool {
    let mut p = false;
    fx.read(id, &mut |s| p = s.pending);
    p
}

fn send(cx: &mut VisualTestContext, text: &str) {
    typed(cx, text);
    keys(cx, "enter");
}

#[test]
fn typing_and_enter_sends_through_the_target() {
    let mut app = app();
    let fx = fixture();
    let (view, cx) = open(&mut app, &fx, S1);
    assert!(drawn(cx, "composer"));
    assert!(drawn(cx, "composer-send"));
    typed(cx, "hello there");
    assert_eq!(editor_text(&view, cx), "hello there");
    assert_eq!(model_text(&view, cx), "hello there");
    keys(cx, "enter");
    assert_eq!(prompts(&fx, S1), vec!["hello there".to_owned()]);
    assert_eq!(editor_text(&view, cx), "");
    // The reply plays; the box takes the next prompt.
    fx.finish(S1);
    settle(cx);
    assert!(!pending(&fx, S1));
    assert!(drawn(cx, "composer-send"));
}

#[test]
fn shift_enter_inserts_a_newline_without_sending() {
    let mut app = app();
    let fx = fixture();
    let (view, cx) = open(&mut app, &fx, S1);
    typed(cx, "line one");
    keys(cx, "shift-enter");
    typed(cx, "line two");
    assert_eq!(editor_text(&view, cx), "line one\nline two");
    assert_eq!(model_text(&view, cx), "line one\nline two");
    assert!(prompts(&fx, S1).is_empty());
    keys(cx, "enter");
    assert_eq!(prompts(&fx, S1), vec!["line one\nline two".to_owned()]);
}

#[test]
fn cmd_up_recalls_the_last_prompt() {
    let mut app = app();
    let fx = fixture();
    let (view, cx) = open(&mut app, &fx, S1);
    send(cx, "first prompt");
    fx.finish(S1);
    settle(cx);
    send(cx, "second prompt");
    fx.finish(S1);
    settle(cx);
    keys(cx, "cmd-up");
    assert_eq!(editor_text(&view, cx), "second prompt");
    keys(cx, "cmd-up");
    assert_eq!(editor_text(&view, cx), "first prompt");
    keys(cx, "cmd-down");
    keys(cx, "cmd-down");
    assert_eq!(editor_text(&view, cx), "");
}

#[test]
fn a_send_while_a_turn_runs_queues_above_the_box() {
    let mut app = app();
    let fx = fixture();
    let (view, cx) = open(&mut app, &fx, S1);
    send(cx, "one");
    assert!(pending(&fx, S1));
    assert!(drawn(cx, "composer-interrupt"));
    assert!(!drawn(cx, "composer-send"));
    assert!(!drawn(cx, "queue-indicator"));
    send(cx, "two");
    assert_eq!(queued(&fx, S1), vec!["two".to_owned()]);
    assert!(drawn(cx, "queue-indicator"));
    assert!(drawn(cx, "queue-item-0"));
    assert_eq!(cx.update(|_, cx| view.read(cx).session().queue.len()), 1);
    // The turn's end starts the queued prompt.
    while fx.advance(S1) && !queued(&fx, S1).is_empty() {}
    settle(cx);
    assert!(queued(&fx, S1).is_empty());
    assert_eq!(prompts(&fx, S1), vec!["one".to_owned(), "two".to_owned()]);
}

#[test]
fn the_queue_strip_moves_sends_edits_and_removes() {
    let mut app = app();
    let fx = fixture();
    let (view, cx) = open(&mut app, &fx, S1);
    send(cx, "running");
    send(cx, "alpha");
    send(cx, "beta");
    send(cx, "gamma");
    assert_eq!(queued(&fx, S1), ["alpha", "beta", "gamma"]);
    assert!(drawn(cx, "queue-send-all-now"));
    click(cx, "queue-down-0");
    assert_eq!(queued(&fx, S1), ["beta", "alpha", "gamma"]);
    click(cx, "queue-up-2");
    assert_eq!(queued(&fx, S1), ["beta", "gamma", "alpha"]);
    click(cx, "queue-remove-1");
    assert_eq!(queued(&fx, S1), ["beta", "alpha"]);
    click(cx, "queue-edit-1");
    assert_eq!(queued(&fx, S1), ["beta"]);
    assert_eq!(editor_text(&view, cx), "alpha");
    // The lift is in the history.
    assert_eq!(
        cx.update(|_, cx| view.read(cx).model().history(view.read(cx).session())),
        vec!["running".to_owned(), "alpha".to_owned()]
    );
    click(cx, "queue-send-now-0");
    assert_eq!(queued(&fx, S1), ["beta"]);
    fx.finish(S1);
    settle(cx);
    assert_eq!(prompts(&fx, S1), ["running", "beta"]);
}

#[test]
fn enter_on_an_empty_box_sends_the_first_queued_prompt_now() {
    let mut app = app();
    let fx = fixture();
    let (_view, cx) = open(&mut app, &fx, S1);
    send(cx, "running");
    send(cx, "next");
    send(cx, "later");
    keys(cx, "enter");
    assert_eq!(queued(&fx, S1), ["next", "later"]);
    keys(cx, "ctrl-enter");
    assert!(queued(&fx, S1).is_empty());
    assert_eq!(prompts(&fx, S1), ["running", "next", "later"]);
}

#[test]
fn bang_mode_runs_a_shell_command() {
    let mut app = app();
    let fx = fixture();
    let (view, cx) = open(&mut app, &fx, S1);
    assert!(!drawn(cx, "composer-bash-chip"));
    typed(cx, "!ls -la");
    assert!(drawn(cx, "composer-bash-chip"));
    assert!(cx.update(|_, cx| view.read(cx).model().is_bash_mode()));
    keys(cx, "enter");
    let post = fx
        .requests()
        .into_iter()
        .find(|(m, u, _)| m == "POST" && u.ends_with("/bash"))
        .expect("the bash POST");
    assert_eq!(post.1, format!("/api/sessions/{S1}/bash"));
    assert_eq!(post.2.as_deref(), Some(r#"{"command":"ls -la"}"#));
    // The draft row went with it.
    assert!(
        fx.requests()
            .iter()
            .any(|(m, u, _)| m == "DELETE" && u.ends_with("/prompt-draft"))
    );
    assert_eq!(editor_text(&view, cx), "");
    assert!(!drawn(cx, "composer-bash-chip"));
    assert!(!cx.update(|_, cx| view.read(cx).model().bash_running()));
    assert!(prompts(&fx, S1)[0].contains("<bash-input>ls -la</bash-input>"));
}

#[test]
fn bang_sudo_asks_for_the_password_once() {
    let mut app = app();
    let fx = fixture();
    let (view, cx) = open(&mut app, &fx, S1);
    send(cx, "!sudo whoami");
    assert!(drawn(cx, "composer-sudo-modal"));
    assert!(fx.requests().iter().all(|(m, _, _)| m != "POST"));
    // The password field.
    let sudo = cx.update(|_, cx| view.read(cx).sudo_input().clone());
    cx.update(|window, cx| {
        let focus = sudo.read(cx).focus_handle(cx);
        window.focus(&focus, cx);
    });
    typed(cx, "hunter2");
    keys(cx, "enter");
    let post = fx
        .requests()
        .into_iter()
        .find(|(m, _, _)| m == "POST")
        .expect("the bash POST");
    assert_eq!(
        post.2.as_deref(),
        Some(r#"{"command":"sudo whoami","sudoPassword":"hunter2"}"#)
    );
    assert!(!drawn(cx, "composer-sudo-modal"));
    assert_eq!(cx.update(|_, cx| sudo.read(cx).value().to_string()), "");
}

#[test]
fn the_draft_survives_a_tab_switch() {
    let mut app = app();
    let fx = fixture();
    let (view, cx) = open(&mut app, &fx, S1);
    typed(cx, "half a thought");
    bind(&view, cx, S2);
    // Flushed to its own session on the switch, not saved under the new one.
    assert_eq!(
        fx.draft(S1),
        Some(json!({"text": "half a thought", "images": []}))
    );
    assert_eq!(fx.draft(S2), None);
    assert_eq!(editor_text(&view, cx), "");
    typed(cx, "other");
    bind(&view, cx, S1);
    assert_eq!(editor_text(&view, cx), "half a thought");
    bind(&view, cx, S2);
    assert_eq!(editor_text(&view, cx), "other");
}

#[test]
fn the_debounced_save_lands_after_half_a_second() {
    let mut app = app();
    let fx = fixture();
    let (_view, cx) = open(&mut app, &fx, S1);
    typed(cx, "saved later");
    assert_eq!(fx.draft(S1), None);
    cx.executor()
        .advance_clock(std::time::Duration::from_millis(600));
    settle(cx);
    assert_eq!(
        fx.draft(S1),
        Some(json!({"text": "saved later", "images": []}))
    );
    // A send clears the row.
    keys(cx, "enter");
    assert_eq!(fx.draft(S1), None);
}

#[test]
fn stop_interrupts_the_running_turn() {
    let mut app = app();
    let fx = fixture();
    let (_view, cx) = open(&mut app, &fx, S1);
    send(cx, "long job");
    assert!(pending(&fx, S1));
    click(cx, "composer-interrupt");
    assert!(!pending(&fx, S1));
    assert!(!fx.busy(S1));
    assert!(drawn(cx, "composer-send"));
}

#[test]
fn ctrl_c_interrupts_too() {
    let mut app = app();
    let fx = fixture();
    let (view, cx) = open(&mut app, &fx, S1);
    send(cx, "long job");
    typed(cx, "keep me");
    keys(cx, "ctrl-c");
    assert!(!pending(&fx, S1));
    assert_eq!(editor_text(&view, cx), "keep me");
}

#[test]
fn a_suggestion_chip_sends_itself() {
    let mut app = app();
    let fx = fixture();
    let (view, cx) = open(&mut app, &fx, S1);
    send(cx, "hi");
    assert!(!drawn(cx, "composer-suggestions"));
    fx.finish(S1);
    settle(cx);
    assert!(drawn(cx, "composer-suggestions"));
    typed(cx, "untouched");
    click(cx, "composer-suggestion-0");
    assert_eq!(prompts(&fx, S1), ["hi", "What does Ctrl+Enter do?"]);
    assert_eq!(editor_text(&view, cx), "untouched");
}

#[test]
fn the_prompt_color_loads_with_the_session() {
    let mut app = app();
    let fx = fixture();
    fx.set_color(S2, "green");
    let (view, cx) = open(&mut app, &fx, S1);
    assert_eq!(
        cx.update(|_, cx| view.read(cx).model().prompt_color()),
        None
    );
    bind(&view, cx, S2);
    assert_eq!(
        cx.update(|_, cx| view.read(cx).model().prompt_color()),
        Some(claudius_theme::prompt::PromptColor::Green)
    );
    // `/color`'s optimistic set wins over the saved one.
    view.update_in(cx, |v, _, cx| {
        v.set_prompt_color(Some(claudius_theme::prompt::PromptColor::Blue), cx)
    });
    assert_eq!(
        cx.update(|_, cx| view.read(cx).model().prompt_color()),
        Some(claudius_theme::prompt::PromptColor::Blue)
    );
}

#[test]
fn the_footer_counts_utf16_characters() {
    let mut app = app();
    let fx = fixture();
    let (_view, cx) = open(&mut app, &fx, S1);
    assert!(drawn(cx, "composer-chars"));
    typed(cx, "a workflow");
    assert!(drawn(cx, "composer-keyword-hint-active"));
    click(cx, "composer-keyword-hint-active");
    assert!(drawn(cx, "composer-keyword-hint-ignored"));
}

#[test]
fn the_composer_follows_a_turn_the_transcripts_play() {
    use claudius_chat::script;
    let mut app = app();
    let transcripts = Arc::new(FixtureTranscripts::new());
    let (history, stream) = script::demo(S1, 1_000.0, 60.0);
    transcripts.insert_streaming(S1, &history, stream);
    let fx = FixtureComposer::new(transcripts.clone(), None);
    let mut log = history.clone();
    log.extend(script::demo(S1, 1_000.0, 60.0).1);
    fx.seed(S1, log);
    let (_view, cx) = open(&mut app, &fx, S1);
    // The demo's second turn is running when its history ends.
    assert!(drawn(cx, "composer-interrupt"));
    while transcripts.advance(S1) {}
    settle(cx);
    assert!(drawn(cx, "composer-send"));
    // Stop on a turn the transcripts play ends it too.
    transcripts.insert_streaming(S1, &history, script::demo(S1, 1_000.0, 60.0).1);
    settle(cx);
    assert!(drawn(cx, "composer-interrupt"));
    click(cx, "composer-interrupt");
    assert!(!pending(&fx, S1));
    assert!(drawn(cx, "composer-send"));
}

#[test]
fn star_space_at_a_line_start_types_a_bullet() {
    let mut app = app();
    let fx = fixture();
    let (view, cx) = open(&mut app, &fx, S1);
    typed(cx, "* ");
    assert_eq!(editor_text(&view, cx), "\u{2022} ");
    typed(cx, "item");
    assert_eq!(editor_text(&view, cx), "\u{2022} item");
    keys(cx, "enter");
    assert_eq!(editor_text(&view, cx), "\u{2022} item\n\u{2022} ");
}

#[test]
fn a_send_with_no_session_comes_back_to_the_box() {
    let mut app = app();
    let fx = fixture();
    let target: Arc<dyn ComposerTarget> = fx.clone();
    let (view, cx) =
        app.add_window_view(|window, cx| ComposerView::new(target, ThemeName::Dark, window, cx));
    view.update_in(cx, |v, window, cx| {
        v.inject("nowhere to go", window, cx);
        v.submit(window, cx);
    });
    settle(cx);
    assert_eq!(editor_text(&view, cx), "nowhere to go");
    assert_eq!(
        cx.update(|_, cx| view
            .read(cx)
            .model()
            .send_failed_notice()
            .map(str::to_owned)),
        Some("Message not sent \u{2014} it's back in the box.".to_owned())
    );
}

#[test]
fn closing_the_window_flushes_the_draft() {
    let mut app = app();
    let fx = fixture();
    let (view, cx) = open(&mut app, &fx, S1);
    typed(cx, "unsaved");
    assert_eq!(fx.draft(S1), None);
    drop(view);
    cx.update(|window, _| window.remove_window());
    cx.run_until_parked();
    assert_eq!(fx.draft(S1), Some(json!({"text": "unsaved", "images": []})));
}
