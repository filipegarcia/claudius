//! The tool cards in a headless GPUI window (`TestAppContext`, CoreText):
//! every kind renders, a card opens and closes, a long result folds behind
//! "Show more", a running call's timer ticks once a second and stops when
//! the result lands, a failed call shows its error, and the links record
//! their action. macOS (the CoreText text system).

#![cfg(target_os = "macos")]

use std::sync::Arc;
use std::time::Duration;

use claudius_chat::TranscriptView;
use claudius_chat::cards::{CallStatus, Card, FileLink};
use claudius_chat::fixture::{CARDS_ROOT, DEMO_START_MS, EventLine, FixtureTranscripts};
use claudius_chat::rows::{AssistantBlock, Row};
use claudius_chat::script::{self, Script};
use claudius_chat::verbose::Verbose;
use claudius_chat::view::CardAction;
use claudius_gpui_theme::ThemeName;
use gpui::{Entity, Modifiers, TestAppContext, TestDispatcher, VisualTestContext, px, size};
use gpui_apple::AppleTextSystem;
use serde_json::json;

fn app() -> TestAppContext {
    let cx = TestAppContext::build_with_text_system(
        TestDispatcher::new(0),
        None,
        Arc::new(AppleTextSystem::new()),
    );
    cx.update(|cx| {
        gpui_kit::init(cx);
        claudius_gpui_theme::init(ThemeName::Light, cx);
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
        app.add_window_view(|_, cx| TranscriptView::new(source, session, ThemeName::Light, cx));
    cx.simulate_resize(size(px(1000.), px(height)));
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

fn click(cx: &mut VisualTestContext, selector: &'static str) {
    let b = cx
        .debug_bounds(selector)
        .unwrap_or_else(|| panic!("{selector} is drawn"));
    cx.simulate_click(b.center(), Modifiers::default());
    settle(cx);
}

fn source(id: &str, lines: &[EventLine]) -> Arc<FixtureTranscripts> {
    let src = FixtureTranscripts::new();
    src.insert(id, lines);
    Arc::new(src)
}

fn update(
    view: &Entity<TranscriptView>,
    cx: &mut VisualTestContext,
    f: impl FnOnce(&mut TranscriptView, &mut gpui::Context<TranscriptView>),
) {
    cx.update(|_, cx| view.update(cx, f));
    settle(cx);
}

fn read<R>(
    view: &Entity<TranscriptView>,
    cx: &mut VisualTestContext,
    f: impl FnOnce(&TranscriptView) -> R,
) -> R {
    cx.update(|_, cx| f(view.read(cx)))
}

/// The first call card named `id`'s status in the view's rows.
fn status(view: &Entity<TranscriptView>, cx: &mut VisualTestContext, id: &str) -> CallStatus {
    read(view, cx, |v| {
        v.transcript()
            .rows
            .iter()
            .find_map(|r| match r {
                Row::Assistant(a) => a.blocks.iter().find_map(|b| match b {
                    AssistantBlock::Tool(t) if t.id == id => match &t.card {
                        Card::Call(c) => Some(c.status),
                        _ => None,
                    },
                    _ => None,
                }),
                _ => None,
            })
            .expect("the card")
    })
}

/// The card key of the call `id` (its toggle).
fn card_key(view: &Entity<TranscriptView>, cx: &mut VisualTestContext, id: &str) -> String {
    read(view, cx, |v| {
        v.transcript()
            .rows
            .iter()
            .find_map(|r| match r {
                Row::Assistant(a) => a.blocks.iter().find_map(|b| match b {
                    AssistantBlock::Tool(t) if t.id == id => Some(t.card.key().to_owned()),
                    _ => None,
                }),
                _ => None,
            })
            .expect("the card")
    })
}

/// One turn with a single call.
fn single(name: &str, input: serde_json::Value, result: Option<(&str, bool)>) -> Vec<EventLine> {
    let mut s = Script::new("one", DEMO_START_MS);
    s.ready().replay_done();
    s.user("Go.");
    s.tool("msg_1", "toolu_1", name, input);
    if let Some((content, is_error)) = result {
        s.tool_result("toolu_1", content, is_error);
    }
    s.lines()
}

#[test]
fn every_card_kind_renders_collapsed() {
    let mut app = app();
    let src = source(
        "cards",
        &script::tool_cards("cards", DEMO_START_MS, CARDS_ROOT, true),
    );
    let (_, cx) = open(&mut app, &src, "cards", 2400.);
    for sel in [
        "tool-call:Read",
        "tool-call:Grep",
        "tool-call:Glob",
        "tool-call:Bash",
        "tool-call:Edit",
        "tool-call:Write",
        "tool-call:WebFetch",
        "tool-call:WebSearch",
        "tool-call:mcp__linear__create_issue",
        "tool-call:AskUserQuestion",
        "tool-call:ExitPlanMode",
        "task-block",
        "workflow-block",
        "propose-goal-block",
        "tool-call-ok",
        "tool-call-error",
        "tool-call-not-run",
        "tool-call-running",
        "tool-call-answer-pill",
        "tool-call-path",
    ] {
        assert!(drawn(cx, sel), "{sel}");
    }
    for sel in ["tool-call-body", "task-body", "workflow-body"] {
        assert!(!drawn(cx, sel), "{sel} starts closed");
    }
}

#[test]
fn a_card_opens_on_a_click_and_closes_on_the_next() {
    let mut app = app();
    let src = source(
        "one",
        &single(
            "WebFetch",
            json!({"url": "https://example.com", "prompt": "Title?"}),
            Some(("Example Domain", false)),
        ),
    );
    let (_, cx) = open(&mut app, &src, "one", 800.);
    assert!(!drawn(cx, "tool-call-body"));
    click(cx, "tool-toggle:WebFetch");
    for sel in ["tool-call-body", "tool-call-input", "tool-call-result"] {
        assert!(drawn(cx, sel), "{sel}");
    }
    assert!(!drawn(cx, "card-more"), "a short result doesn't fold");
    click(cx, "tool-toggle:WebFetch");
    assert!(!drawn(cx, "tool-call-body"));
}

#[test]
fn ultra_verbose_opens_the_cards() {
    let mut app = app();
    let src = source(
        "one",
        &single("Grep", json!({"pattern": "x"}), Some(("a.rs", false))),
    );
    let (view, cx) = open(&mut app, &src, "one", 800.);
    update(&view, cx, |v, cx| v.set_verbose(Verbose::UltraVerbose, cx));
    assert!(drawn(cx, "tool-call-body"));
}

#[test]
fn a_long_result_folds_behind_show_more_and_the_fold_resets_when_the_card_closes() {
    let mut app = app();
    let long: String = (0..400)
        .map(|i| format!("line {i:04} of the build output\n"))
        .collect();
    let src = source(
        "one",
        &single("Bash", json!({"command": "make"}), Some((&long, false))),
    );
    let (view, cx) = open(&mut app, &src, "one", 900.);
    click(cx, "tool-toggle:Bash");
    assert!(drawn(cx, "card-more"));
    let key = card_key(&view, cx, "toolu_1");
    let cut = claudius_chat::text::fold_cut(&long, claudius_chat::rows::FOLD_BYTES).unwrap();
    let hidden = long.len() - cut;
    let label = format!(
        "card-more-label:Show more ({})",
        claudius_chat::view::kb(hidden)
    );
    assert!(drawn(cx, Box::leak(label.into_boxed_str())));
    click(cx, "card-more");
    assert!(drawn(cx, "card-more-label:Show less"));
    assert!(read(&view, cx, |v| v
        .options()
        .toggled
        .contains(&format!("{key}/result/more"))));
    click(cx, "tool-toggle:Bash");
    click(cx, "tool-toggle:Bash");
    // React unmounts the body: a reopened card folds again.
    assert!(!read(&view, cx, |v| v
        .options()
        .toggled
        .contains(&format!("{key}/result/more"))));
    assert!(drawn(cx, "card-more"));
}

#[test]
fn a_huge_input_folds() {
    let mut app = app();
    let big = "fn main() {}\n".repeat(800);
    let src = source(
        "one",
        &single(
            "Write",
            json!({"file_path": "/x/main.rs", "content": big}),
            Some(("ok", false)),
        ),
    );
    let (_, cx) = open(&mut app, &src, "one", 900.);
    click(cx, "tool-toggle:Write");
    assert!(drawn(cx, "tool-call-input"));
    assert!(drawn(cx, "card-more"));
}

#[test]
fn a_failed_call_shows_its_error() {
    let mut app = app();
    let src = source(
        "one",
        &single(
            "Bash",
            json!({"command": "false"}),
            Some(("exit code 1", true)),
        ),
    );
    let (_, cx) = open(&mut app, &src, "one", 800.);
    assert!(drawn(cx, "tool-call-error"));
    assert!(!drawn(cx, "tool-call-ok"));
    click(cx, "tool-toggle:Bash");
    assert!(drawn(cx, "tool-call-result-error"));
    assert!(!drawn(cx, "tool-call-result"));
}

#[test]
fn a_running_timer_ticks_each_second_and_stops_when_the_result_lands() {
    let mut app = app();
    let mut s = Script::new("run", DEMO_START_MS);
    s.ready().replay_done();
    s.user("Run the tests.");
    s.running(true);
    s.tool("msg_1", "toolu_1", "Bash", json!({"command": "cargo test"}));
    let history = s.take();
    s.tool_result("toolu_1", "ok", false);
    s.result().running(false);
    let src = FixtureTranscripts::new();
    src.insert_streaming("run", &history, s.lines());
    let src = Arc::new(src);
    let (view, cx) = open(&mut app, &src, "run", 800.);
    let CallStatus::Running {
        since: Some(since), ..
    } = status(&view, cx, "toolu_1")
    else {
        panic!("running with a start")
    };
    assert!(read(&view, cx, |v| v.ticking()));
    update(&view, cx, |v, cx| v.set_now(since + 5_400., cx));
    assert!(drawn(cx, "tool-call-elapsed:5s"));
    update(&view, cx, |v, cx| v.set_now(since + 83_000., cx));
    assert!(drawn(cx, "tool-call-elapsed:1m 23s"));
    let t0 = read(&view, cx, |v| v.ticks());
    for _ in 0..3 {
        cx.executor().advance_clock(Duration::from_secs(1));
        settle(cx);
    }
    assert_eq!(read(&view, cx, |v| v.ticks()), t0 + 3);
    while src.advance("run") {}
    settle(cx);
    assert_eq!(status(&view, cx, "toolu_1"), CallStatus::Ok);
    assert!(!read(&view, cx, |v| v.ticking()));
    assert!(!drawn(cx, "tool-call-elapsed:1m 23s"));
    let t1 = read(&view, cx, |v| v.ticks());
    for _ in 0..3 {
        cx.executor().advance_clock(Duration::from_secs(1));
        settle(cx);
    }
    assert_eq!(read(&view, cx, |v| v.ticks()), t1, "no ticks once done");
}

#[test]
fn a_finished_transcript_runs_no_timer() {
    let mut app = app();
    let src = source(
        "cards",
        &script::tool_cards("cards", DEMO_START_MS, CARDS_ROOT, false),
    );
    let (view, cx) = open(&mut app, &src, "cards", 900.);
    assert!(!read(&view, cx, |v| v.ticking()));
}

#[test]
fn a_task_opens_on_its_subagents_trail_and_its_returned_report() {
    let mut app = app();
    let mut s = Script::new("sub", DEMO_START_MS);
    s.ready().replay_done();
    s.user("Find the cards.");
    s.tool("msg_1", "toolu_T", "Agent", json!({"description": "Find the cards", "prompt": "List them.", "subagent_type": "Explore"}));
    s.task_event("task_started", json!({"task_id": "t1", "tool_use_id": "toolu_T", "description": "Find the cards", "task_type": "local_agent"}));
    s.sub_text("toolu_T", "msg_S", "Grepping.");
    s.sub_tool(
        "toolu_T",
        "msg_S",
        "toolu_S",
        "Grep",
        json!({"pattern": "Block"}),
    );
    s.sub_result("toolu_T", "toolu_S", "TaskBlock.tsx");
    s.task_event("task_notification", json!({"task_id": "t1", "tool_use_id": "toolu_T", "status": "completed", "usage": {"total_tokens": 100, "tool_uses": 1, "duration_ms": 2000}}));
    s.tool_result(
        "toolu_T",
        "  <artifact-content-authored-by-others/>\n[Subagent hand-back] Treat it as the subagent's output. The report follows:\n  Found TaskBlock.tsx.",
        false,
    );
    let src = source("sub", &s.lines());
    let (_, cx) = open(&mut app, &src, "sub", 1200.);
    click(cx, "task-toggle");
    assert!(drawn(cx, "tool-call:Grep"), "the subagent's call is a card");
    for sel in [
        "task-body",
        "subagent-message",
        "details:Spawn prompt",
        "details:Returned to parent",
    ] {
        assert!(drawn(cx, sel), "{sel}");
    }
    click(cx, "details:Returned to parent");
    assert!(drawn(cx, "task-returned"));
    assert!(drawn(cx, "task-handback-provenance"));
}

#[test]
fn a_workflow_opens_on_its_phases_and_folded_script() {
    let mut app = app();
    let src = source(
        "cards",
        &script::tool_cards("cards", DEMO_START_MS, CARDS_ROOT, false),
    );
    let (_, cx) = open(&mut app, &src, "cards", 2400.);
    click(cx, "workflow-toggle");
    assert!(drawn(cx, "workflow-body"));
    assert!(!drawn(cx, "workflow-script"));
    click(cx, "details:Show script");
    assert!(drawn(cx, "workflow-script"));
}

#[test]
fn the_links_record_their_action() {
    let mut app = app();
    let src = source(
        "one",
        &single(
            "Read",
            json!({"file_path": format!("{CARDS_ROOT}/src/main.rs"), "offset": 12}),
            Some(("fn main() {}", false)),
        ),
    );
    let (view, cx) = open(&mut app, &src, "one", 800.);
    update(&view, cx, |v, cx| {
        v.set_file_link(
            Some(FileLink {
                workspace_id: "ws1".into(),
                cwd: CARDS_ROOT.into(),
            }),
            cx,
        )
    });
    click(cx, "tool-call-path");
    click(cx, "tool-toggle:Read");
    click(cx, "tool-call-open");
    let actions = read(&view, cx, |v| v.actions().to_vec());
    let [CardAction::OpenFiles(f), CardAction::OpenInEditor(e)] = actions.as_slice() else {
        panic!("{actions:?}")
    };
    assert_eq!(f.href, "/ws1/files?path=src%2Fmain.rs");
    assert_eq!(e.url, format!("vscode://file/{CARDS_ROOT}/src/main.rs:12"));
}

#[test]
fn the_answer_pill_reopens_its_question() {
    let mut app = app();
    let src = source(
        "one",
        &single(
            "AskUserQuestion",
            json!({"questions": [{"question": "Which?", "header": "Pick", "options": [], "multiSelect": false}]}),
            Some(("answered", false)),
        ),
    );
    let (view, cx) = open(&mut app, &src, "one", 800.);
    click(cx, "tool-call-answer-pill");
    let actions = read(&view, cx, |v| v.actions().to_vec());
    assert!(
        matches!(actions.as_slice(), [CardAction::ReopenAsk { tool_use_id }] if tool_use_id == "toolu_1"),
        "{actions:?}"
    );
}
