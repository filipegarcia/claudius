//! The chat route's composer (U07): under the transcript, bound to the
//! shown tab, through tab switches and off the chat route.
//! macOS (the CoreText text system).

#![cfg(target_os = "macos")]

use std::sync::Arc;

use claudius_app::data::ShellData;
use claudius_app::fixture::FixtureShellData;
use claudius_app::route::{Route, WorkspacePage};
use claudius_app::shell::{Appearance, Shell};
use claudius_chat::TranscriptSource;
use claudius_chat::fixture::{FixtureTranscripts, ids};
use claudius_composer::fixture::FixtureComposer;
use claudius_gpui_theme::ThemeName;
use gpui::{Entity, TestAppContext, TestDispatcher, VisualTestContext, px, size};
use gpui_apple::AppleTextSystem;

const W1: &str = "wks_3f2a9c81d0e4";

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

fn app() -> TestAppContext {
    TestAppContext::build_with_text_system(
        TestDispatcher::new(0),
        None,
        Arc::new(AppleTextSystem::new()),
    )
}

fn bound(shell: &Entity<Shell>, cx: &mut VisualTestContext) -> Option<String> {
    cx.read(|cx| {
        let composer = shell.read(cx).composer()?;
        composer.read(cx).model().session_id().map(str::to_owned)
    })
}

#[test]
fn the_composer_sits_under_the_transcript_bound_to_the_tab() {
    let mut app = app();
    let (shell, cx) = open(&mut app);
    assert_eq!(bound(&shell, cx).as_deref(), Some(ids::DEMO));
    let transcript = cx.debug_bounds("transcript").expect("the transcript");
    let composer = cx.debug_bounds("composer").expect("the composer");
    assert!(composer.top() >= transcript.bottom());
    assert!(cx.debug_bounds("composer-frame").is_some());
}

#[test]
fn the_composer_follows_the_tabs_and_the_route() {
    let mut app = app();
    let (shell, cx) = open(&mut app);
    shell.update(cx, |s, cx| s.update_state(cx, |st| st.new_tab()));
    settle(cx);
    let fresh = cx
        .read(|cx| shell.read(cx).chat_tab())
        .expect("the new tab");
    assert_ne!(fresh, ids::DEMO);
    assert_eq!(bound(&shell, cx), Some(fresh));
    shell.update(cx, |s, cx| {
        s.navigate(Route::page(W1, WorkspacePage::Git), cx)
    });
    settle(cx);
    assert_eq!(bound(&shell, cx), None);
    assert!(cx.debug_bounds("composer").is_none());
}
