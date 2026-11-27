//! The chat route mounts the bound session's prompt cards (U08a) as
//! ChatSurface does: the plan-mode banner above the transcript, the live
//! ask below it, the modal cards over the pane, and the window's Escape
//! reaching them. macOS (the CoreText text system).

#![cfg(target_os = "macos")]

use std::sync::Arc;
use std::time::Duration;

use claudius_app::data::ShellData;
use claudius_app::fixture::FixtureShellData;
use claudius_app::shell::{Appearance, Shell};
use claudius_chat::TranscriptSource;
use claudius_chat::fixture::{FixtureTranscripts, ids};
use claudius_gpui_theme::ThemeName;
use claudius_prompts::target::samples;
use claudius_prompts::{FixturePromptSource, FixturePrompts, PromptSource};
use gpui::{Entity, TestAppContext, TestDispatcher, VisualTestContext, px, size};
use gpui_apple::AppleTextSystem;

fn open<'a>(
    app: &'a mut TestAppContext,
    kinds: &str,
) -> (
    Entity<Shell>,
    Arc<FixturePrompts>,
    &'a mut VisualTestContext,
) {
    app.update(|cx| claudius_app::init(ThemeName::Dark, cx));
    let data: Arc<dyn ShellData> = Arc::new(FixtureShellData::builtin());
    let transcripts: Arc<dyn TranscriptSource> = FixtureTranscripts::builtin();
    let source = FixturePromptSource::new();
    let demo = source.session(ids::DEMO);
    assert!(samples::seed(&demo, kinds).is_empty());
    let prompts: Arc<dyn PromptSource> = source;
    let (shell, cx) = app.add_window_view(|window, cx| {
        let mut shell = Shell::with_transcripts(
            data,
            transcripts,
            Appearance::Fixed(ThemeName::Dark),
            window,
            cx,
        );
        shell.set_prompt_source(prompts, cx);
        shell
    });
    cx.simulate_resize(size(px(1440.), px(900.)));
    settle(cx);
    (shell, demo, cx)
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

fn app() -> TestAppContext {
    TestAppContext::build_with_text_system(
        TestDispatcher::new(0),
        None,
        Arc::new(AppleTextSystem::new()),
    )
}

#[test]
fn the_chat_route_shows_the_permission_card_and_escape_denies_it() {
    let mut app = app();
    let (shell, demo, cx) = open(&mut app, "permission");
    assert!(drawn(cx, "transcript"));
    assert!(drawn(cx, "permission-modal"));
    // The card sits over the chat pane, not the rails.
    let pane = cx.debug_bounds("chat-session").expect("drawn");
    let backdrop = cx.debug_bounds("permission-backdrop").expect("drawn");
    assert_eq!(backdrop, pane);
    assert!(
        cx.read(|cx| shell.read(cx).chat_prompts(ids::DEMO))
            .is_some()
    );
    cx.executor().advance_clock(Duration::from_millis(500));
    cx.simulate_keystrokes("escape");
    settle(cx);
    let posts = demo.posts();
    assert_eq!(posts.len(), 1);
    assert!(posts[0].0.ends_with("/permission"), "{posts:?}");
    assert!(
        posts[0].1.contains(r#""decision":{"kind":"deny"}"#),
        "{posts:?}"
    );
    assert!(!drawn(cx, "permission-modal"));
}

#[test]
fn the_banner_sits_above_the_transcript_and_the_live_ask_below_it() {
    let mut app = app();
    let (_, _, cx) = open(&mut app, "plan-mode,ask");
    let banner = cx.debug_bounds("plan-mode-banner").expect("drawn");
    let transcript = cx.debug_bounds("transcript").expect("drawn");
    let ask = cx.debug_bounds("ask-user-question-inline").expect("drawn");
    assert!(
        banner.bottom() <= transcript.top() + px(1.),
        "{banner:?} {transcript:?}"
    );
    assert!(
        ask.top() >= transcript.bottom() - px(1.),
        "{ask:?} {transcript:?}"
    );
}

#[test]
fn another_tab_has_no_cards() {
    let mut app = app();
    let (shell, _, cx) = open(&mut app, "permission");
    assert!(drawn(cx, "permission-modal"));
    shell.update(cx, |s, cx| {
        s.update_state(cx, |st| st.select_tab(ids::HOOKS))
    });
    settle(cx);
    assert!(!drawn(cx, "permission-modal"));
    shell.update(cx, |s, cx| {
        s.update_state(cx, |st| st.select_tab(ids::DEMO))
    });
    settle(cx);
    assert!(drawn(cx, "permission-modal"));
}
