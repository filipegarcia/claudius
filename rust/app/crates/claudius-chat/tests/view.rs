//! The transcript in a headless GPUI window (`TestAppContext`, CoreText for
//! real glyph widths): it renders, long rows fold and expand, the verbose
//! level shows and hides cards, the list sticks to the bottom while a
//! reply streams and leaves a reader who scrolled up where they are.
//! macOS (the CoreText text system).

#![cfg(target_os = "macos")]

use std::sync::Arc;

use claudius_chat::TranscriptView;
use claudius_chat::fixture::{DEMO_START_MS, FixtureTranscripts};
use claudius_chat::markdown::CAPACITY;
use claudius_chat::rows::{AssistantBlock, Fold, Row};
use claudius_chat::script::{self, Script};
use claudius_chat::verbose::Verbose;
use claudius_gpui_theme::ThemeName;
use gpui::{
    Entity, Modifiers, ScrollDelta, ScrollEvent, ScrollSource, TestAppContext, TestDispatcher,
    TouchPhase, VisualTestContext, point, px, size,
};
use gpui_apple::AppleTextSystem;

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

fn open<'a>(
    app: &'a mut TestAppContext,
    src: &Arc<FixtureTranscripts>,
    session: &str,
    height: f32,
) -> (Entity<TranscriptView>, &'a mut VisualTestContext) {
    let source: Arc<dyn claudius_chat::TranscriptSource> = src.clone();
    let session = session.to_owned();
    let (view, cx) =
        app.add_window_view(|_, cx| TranscriptView::new(source, session, ThemeName::Dark, cx));
    cx.simulate_resize(size(px(900.), px(height)));
    settle(cx);
    (view, cx)
}

/// Runs the tasks (change notifications, background parses), then draws.
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

/// A wheel scroll over the transcript: positive `dy` scrolls up.
fn wheel(cx: &mut VisualTestContext, dy: f32) {
    let b = cx
        .debug_bounds("transcript")
        .expect("the transcript is drawn");
    cx.simulate_event(ScrollEvent {
        position: b.center(),
        delta: ScrollDelta::Pixels(point(px(0.), px(dy))),
        modifiers: Modifiers::default(),
        touch_phase: TouchPhase::Moved,
        source: ScrollSource::Pointer,
    });
    settle(cx);
}

fn source_with(id: &str, lines: &[claudius_chat::fixture::EventLine]) -> Arc<FixtureTranscripts> {
    let src = FixtureTranscripts::new();
    src.insert(id, lines);
    Arc::new(src)
}

fn streaming_demo() -> Arc<FixtureTranscripts> {
    let src = FixtureTranscripts::new();
    let (history, stream) = script::demo("demo", DEMO_START_MS, 60.0);
    src.insert_streaming("demo", &history, stream);
    Arc::new(src)
}

fn read<R>(
    view: &Entity<TranscriptView>,
    cx: &mut VisualTestContext,
    f: impl FnOnce(&TranscriptView) -> R,
) -> R {
    cx.update(|_, cx| f(view.read(cx)))
}

#[test]
fn the_list_renders_bubbles_markdown_and_code() {
    let mut app = app();
    let src = source_with("code", &script::code_turn("code", DEMO_START_MS));
    let (view, cx) = open(&mut app, &src, "code", 900.);
    for sel in ["transcript", "user-bubble", "assistant-message"] {
        assert!(drawn(cx, sel), "{sel}");
    }
    assert!(!drawn(cx, "splash"));
    let stats = read(&view, cx, |v| v.markdown_stats());
    // The prompt and the reply each parsed once.
    assert_eq!(stats.created, 2, "{stats:?}");
    assert_eq!(stats.live, 2);
}

#[test]
fn an_unknown_session_shows_the_splash() {
    let mut app = app();
    let src = Arc::new(FixtureTranscripts::new());
    let (_, cx) = open(&mut app, &src, "nope", 600.);
    assert!(drawn(cx, "splash"));
    assert!(!drawn(cx, "user-bubble"));
}

#[test]
fn a_long_row_folds_until_show_more_then_show_less_folds_it_again() {
    let mut app = app();
    let src = source_with("long", &script::long_turn("long", DEMO_START_MS, 12));
    let (view, cx) = open(&mut app, &src, "long", 700.);
    let folded = |view: &Entity<TranscriptView>, cx: &mut VisualTestContext| {
        read(view, cx, |v| {
            v.transcript().rows.iter().find_map(|r| match r {
                Row::Assistant(a) => a.blocks.iter().find_map(|b| match b {
                    AssistantBlock::Text { fold, .. } => Some(fold.clone()),
                    _ => None,
                }),
                _ => None,
            })
        })
        .expect("a reply")
    };
    assert!(matches!(folded(&view, cx), Fold::Folded { .. }));
    assert!(drawn(cx, "fold-more"));
    click(cx, "fold-more");
    assert_eq!(folded(&view, cx), Fold::Expanded);
    // Expanded, the bottom of the long reply is where "Show less" sits.
    view.update(cx, |v, cx| v.jump_to_latest(cx));
    settle(cx);
    assert!(drawn(cx, "fold-less"));
    click(cx, "fold-less");
    assert!(matches!(folded(&view, cx), Fold::Folded { .. }));
}

#[test]
fn the_verbose_level_shows_and_hides_cards() {
    let mut app = app();
    let src = streaming_demo();
    let (view, cx) = open(&mut app, &src, "demo", 3000.);
    // Normal: tools, no thinking.
    assert!(drawn(cx, "tool-row"));
    assert!(!drawn(cx, "thinking-card"));
    view.update(cx, |v, cx| v.set_verbose(Verbose::Verbose, cx));
    settle(cx);
    assert!(drawn(cx, "thinking-card"));
    // Compact keeps only text.
    view.update(cx, |v, cx| v.set_verbose(Verbose::Compact, cx));
    settle(cx);
    assert!(!drawn(cx, "tool-row"));
    assert!(!drawn(cx, "thinking-card"));
    assert!(drawn(cx, "assistant-message"));
}

#[test]
fn the_list_sticks_to_the_bottom_while_a_reply_streams() {
    let mut app = app();
    let src = streaming_demo();
    let (view, cx) = open(&mut app, &src, "demo", 500.);
    assert!(read(&view, cx, |v| v.following()));
    for _ in 0..40 {
        src.advance("demo");
        settle(cx);
        let (following, at_end) = read(&view, cx, |v| {
            (v.following(), v.list_state().is_scrolled_to_end())
        });
        assert!(following);
        assert_ne!(at_end, Some(false), "the list fell behind the tail");
    }
    assert!(drawn(cx, "streaming-label"));
    assert!(!drawn(cx, "jump-to-latest"));
    let stats = read(&view, cx, |v| v.markdown_stats());
    assert!(stats.appended > 10, "deltas append: {stats:?}");
}

#[test]
fn a_reader_who_scrolled_up_is_not_yanked_down() {
    let mut app = app();
    let src = streaming_demo();
    let (view, cx) = open(&mut app, &src, "demo", 500.);
    for _ in 0..10 {
        src.advance("demo");
    }
    settle(cx);
    wheel(cx, 400.);
    let top = read(&view, cx, |v| v.list_state().logical_scroll_top());
    assert!(!read(&view, cx, |v| v.following()));
    for _ in 0..30 {
        src.advance("demo");
        settle(cx);
    }
    let after = read(&view, cx, |v| v.list_state().logical_scroll_top());
    assert_eq!(
        (after.item_ix, after.offset_in_item),
        (top.item_ix, top.offset_in_item)
    );
    assert!(drawn(cx, "jump-to-latest"));
    click(cx, "jump-to-latest");
    assert!(read(&view, cx, |v| v.following()));
    assert_ne!(
        read(&view, cx, |v| v.list_state().is_scrolled_to_end()),
        Some(false)
    );
    assert!(!drawn(cx, "jump-to-latest"));
}

#[test]
fn scrolling_back_to_the_bottom_follows_again() {
    let mut app = app();
    let src = streaming_demo();
    let (view, cx) = open(&mut app, &src, "demo", 500.);
    wheel(cx, 300.);
    assert!(!read(&view, cx, |v| v.following()));
    wheel(cx, -5000.);
    assert!(read(&view, cx, |v| v.following()));
}

#[test]
fn a_new_prompt_jumps_to_the_bottom() {
    let mut app = app();
    let src = FixtureTranscripts::new();
    let mut s = Script::new("chat", DEMO_START_MS);
    s.ready().replay_done();
    for i in 0..12 {
        s.user(&format!("Question {i}"));
        s.text(&format!("msg_{i}"), "An answer long enough to take a few lines of the column, so that a dozen of them overflow the window and the list has somewhere to scroll.");
    }
    let history = s.take();
    s.user("One more question");
    let src = Arc::new(src);
    src.insert_streaming("chat", &history, s.lines());
    let (view, cx) = open(&mut app, &src, "chat", 500.);
    wheel(cx, 600.);
    assert!(!read(&view, cx, |v| v.following()));
    src.advance("chat");
    settle(cx);
    assert!(read(&view, cx, |v| v.following()));
}

#[test]
fn parsed_markdown_is_kept_only_near_the_viewport() {
    let mut app = app();
    let src = source_with("long", &script::synthetic("long", 1500, DEMO_START_MS));
    let (view, cx) = open(&mut app, &src, "long", 800.);
    for _ in 0..60 {
        wheel(cx, 1500.);
    }
    let stats = read(&view, cx, |v| v.markdown_stats());
    assert!(stats.created > CAPACITY, "{stats:?}");
    assert!(stats.evicted > 0, "{stats:?}");
    assert!(stats.live <= CAPACITY + 40, "{stats:?}");
    assert_eq!(stats.replaced, 0, "{stats:?}");
}

#[test]
fn a_reply_that_streamed_in_stays_unfolded_when_it_finishes() {
    let mut app = app();
    let src = FixtureTranscripts::new();
    let mut s = Script::new("s", DEMO_START_MS);
    s.ready().replay_done().user("Paste the log.").running(true);
    let history = s.take();
    let long = "A line of the log that goes on for a while, to make the reply long.\n".repeat(90);
    s.stream("msg_L", &script::word_chunks(&long), 16.0);
    s.result().running(false);
    let src = Arc::new(src);
    src.insert_streaming("s", &history, s.lines());
    let (view, cx) = open(&mut app, &src, "s", 600.);
    let fold = |view: &Entity<TranscriptView>, cx: &mut VisualTestContext| {
        read(view, cx, |v| {
            v.transcript().rows.iter().find_map(|r| match r {
                Row::Assistant(a) => a.blocks.iter().find_map(|b| match b {
                    AssistantBlock::Text { fold, .. } => Some(fold.clone()),
                    _ => None,
                }),
                _ => None,
            })
        })
    };
    for _ in 0..20 {
        src.advance("s");
    }
    settle(cx);
    assert_eq!(
        fold(&view, cx),
        Some(Fold::Whole),
        "no fold while streaming"
    );
    while src.advance("s") {}
    settle(cx);
    // Over the fold size, but it streamed in under the reader: expanded.
    assert_eq!(fold(&view, cx), Some(Fold::Expanded));
    // The same transcript opened afresh folds it.
    let (fresh, cx) = open(&mut app, &src, "s", 600.);
    assert!(matches!(fold(&fresh, cx), Some(Fold::Folded { .. })));
}

#[test]
fn cards_forget_their_clicks_when_the_level_expands_everything() {
    let mut app = app();
    let src = streaming_demo();
    let (view, cx) = open(&mut app, &src, "demo", 3000.);
    view.update(cx, |v, cx| v.set_verbose(Verbose::Verbose, cx));
    settle(cx);
    let thinking_open = |view: &Entity<TranscriptView>, cx: &mut VisualTestContext| {
        read(view, cx, |v| {
            v.transcript().rows.iter().find_map(|r| match r {
                Row::Assistant(a) => a.blocks.iter().find_map(|b| match b {
                    AssistantBlock::Thinking { open, .. } => Some(*open),
                    _ => None,
                }),
                _ => None,
            })
        })
        .expect("a thinking card")
    };
    assert!(!thinking_open(&view, cx));
    // Open it by hand, then ultra-verbose opens every card: still open.
    let key = read(&view, cx, |v| {
        v.transcript()
            .rows
            .iter()
            .find_map(|r| match r {
                Row::Assistant(a) => a.blocks.iter().find_map(|b| match b {
                    AssistantBlock::Thinking { index, .. } => {
                        Some(claudius_chat::rows::Toggle::Thinking(a.uuid.clone(), *index).key())
                    }
                    _ => None,
                }),
                _ => None,
            })
            .expect("a thinking card")
    });
    view.update(cx, |v, cx| v.toggle(key.clone(), cx));
    assert!(thinking_open(&view, cx));
    view.update(cx, |v, cx| v.set_verbose(Verbose::UltraVerbose, cx));
    assert!(thinking_open(&view, cx));
    assert!(!read(&view, cx, |v| v.options().toggled.contains(&key)));
    // Within one side of the flip, a click is kept.
    view.update(cx, |v, cx| v.toggle(key.clone(), cx));
    assert!(!thinking_open(&view, cx));
    view.update(cx, |v, cx| v.set_verbose(Verbose::UltraVerbose, cx));
    assert!(!thinking_open(&view, cx));
}
