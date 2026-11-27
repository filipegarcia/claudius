//! The chat route shows the bound session's transcript (claudius-chat's
//! `TranscriptView`) over a `TranscriptSource`: the bundled fixture's
//! sessions, a tab switch, a fresh tab, and the demo reply streaming in.
//! macOS (the CoreText text system).

#![cfg(target_os = "macos")]

use std::sync::Arc;

use claudius_app::data::ShellData;
use claudius_app::fixture::FixtureShellData;
use claudius_app::shell::{Appearance, Shell};
use claudius_chat::TranscriptSource;
use claudius_chat::fixture::{FixtureTranscripts, ids};
use claudius_gpui_theme::ThemeName;
use gpui::{Entity, TestAppContext, TestDispatcher, VisualTestContext, px, size};
use gpui_apple::AppleTextSystem;

fn open(
    app: &mut TestAppContext,
    src: Arc<FixtureTranscripts>,
) -> (Entity<Shell>, &mut VisualTestContext) {
    app.update(|cx| claudius_app::init(ThemeName::Dark, cx));
    let data: Arc<dyn ShellData> = Arc::new(FixtureShellData::builtin());
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

fn shown(shell: &Entity<Shell>, cx: &mut VisualTestContext) -> Option<String> {
    cx.read(|cx| {
        let shell = shell.read(cx);
        let tab = shell.chat_tab()?;
        shell
            .chat_view(&tab)
            .map(|v| v.read(cx).session_id().to_owned())
    })
}

#[test]
fn the_chat_route_shows_the_bound_sessions_transcript() {
    let mut app = app();
    let (shell, cx) = open(&mut app, FixtureTranscripts::builtin());
    assert_eq!(shown(&shell, cx).as_deref(), Some(ids::DEMO));
    for sel in [
        "chat-session",
        "transcript",
        "user-bubble",
        "assistant-message",
    ] {
        assert!(drawn(cx, sel), "{sel}");
    }
    assert!(!drawn(cx, "splash"));
    // Another tab shows its own session.
    shell.update(cx, |s, cx| {
        s.update_state(cx, |st| st.select_tab(ids::HOOKS))
    });
    settle(cx);
    assert_eq!(shown(&shell, cx).as_deref(), Some(ids::HOOKS));
    assert!(drawn(cx, "transcript"));
    // A fresh tab has no transcript yet: the splash.
    shell.update(cx, |s, cx| s.update_state(cx, |st| st.new_tab()));
    settle(cx);
    assert!(drawn(cx, "splash"));
    assert!(drawn(cx, "chat-session"));
}

#[test]
fn the_demo_reply_streams_into_the_open_tab() {
    let mut app = app();
    let src = FixtureTranscripts::builtin();
    let (shell, cx) = open(&mut app, src.clone());
    assert!(!drawn(cx, "streaming-label"));
    for _ in 0..12 {
        src.advance(ids::DEMO);
    }
    settle(cx);
    assert!(drawn(cx, "streaming-label"));
    let following = cx.read(|cx| {
        let view = shell
            .read(cx)
            .chat_view(ids::DEMO)
            .expect("the demo's view");
        view.read(cx).following()
    });
    assert!(following);
}

#[test]
fn the_transcript_follows_the_theme() {
    let mut app = app();
    let (shell, cx) = open(&mut app, FixtureTranscripts::builtin());
    let theme = |shell: &Entity<Shell>, cx: &mut VisualTestContext| {
        cx.read(|cx| {
            let view = shell
                .read(cx)
                .chat_view(ids::DEMO)
                .expect("the demo's view");
            view.read(cx).theme()
        })
    };
    assert_eq!(theme(&shell, cx), ThemeName::Dark);
    cx.update(|window, cx| {
        shell.update(cx, |s, cx| {
            s.set_appearance(Appearance::Fixed(ThemeName::Light), window, cx)
        })
    });
    settle(cx);
    assert_eq!(theme(&shell, cx), ThemeName::Light);
}
