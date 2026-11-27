//! The transcript cards' host (U06a), over the fixture: a path link opens
//! the Files route in the route's workspace, "Open" opens the saved
//! editor's URL, `claudius.showPreviews` hides the file previews, and an
//! answered AskUserQuestion's pill resurrects its question (or toasts
//! when its input has none), as `MessageList` / `ChatSurface` wire them.
//! macOS (the CoreText text system).

#![cfg(target_os = "macos")]

use std::sync::Arc;

use claudius_app::data::ShellData;
use claudius_app::fixture::FixtureShellData;
use claudius_app::route::{Route, WorkspacePage};
use claudius_app::shell::{Appearance, Shell};
use claudius_app::store::LocalStore;
use claudius_chat::TranscriptSource;
use claudius_chat::fixture::{DEMO_START_MS, EventLine, FixtureTranscripts, ids};
use claudius_chat::script::Script;
use claudius_gpui_theme::ThemeName;
use claudius_prompts::{FixturePromptSource, PromptSource};
use gpui::{Entity, Modifiers, TestAppContext, TestDispatcher, VisualTestContext, px, size};
use gpui_apple::AppleTextSystem;
use serde_json::json;

/// The demo session's workspace (`fixtures/shell.json`).
const WS: &str = "wks_3f2a9c81d0e4";
const ROOT: &str = "/Users/demo/src/claudius";

fn app() -> TestAppContext {
    TestAppContext::build_with_text_system(
        TestDispatcher::new(0),
        None,
        Arc::new(AppleTextSystem::new()),
    )
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

/// The demo session holding one tool call (and its result).
fn one_call(name: &str, input: serde_json::Value, result: Option<&str>) -> Vec<EventLine> {
    let mut s = Script::new(ids::DEMO, DEMO_START_MS);
    s.ready().replay_done();
    s.user("Go.");
    s.tool("msg_1", "toolu_1", name, input);
    if let Some(content) = result {
        s.tool_result("toolu_1", content, false);
    }
    s.lines()
}

/// The shell over the fixture, the demo session holding `lines`, the
/// store holding `saved`, the demo's prompt cards from a fixture source.
fn open<'a>(
    app: &'a mut TestAppContext,
    lines: &[EventLine],
    saved: &[(&str, &str)],
) -> (Entity<Shell>, &'a mut VisualTestContext) {
    app.update(|cx| claudius_app::init(ThemeName::Dark, cx));
    let data: Arc<dyn ShellData> = Arc::new(FixtureShellData::builtin());
    let src = FixtureTranscripts::new();
    src.insert(ids::DEMO, lines);
    let transcripts: Arc<dyn TranscriptSource> = Arc::new(src);
    let mut store = LocalStore::in_memory();
    for (k, v) in saved {
        store.set(k, v);
    }
    let prompts = FixturePromptSource::new();
    prompts.session(ids::DEMO);
    let prompts: Arc<dyn PromptSource> = prompts;
    let (shell, cx) = app.add_window_view(|window, cx| {
        let mut shell = Shell::with_parts(
            data,
            transcripts,
            Appearance::Fixed(ThemeName::Dark),
            store,
            window,
            cx,
        );
        shell.set_prompt_source(prompts, cx);
        shell
    });
    cx.simulate_resize(size(px(1440.), px(900.)));
    settle(cx);
    (shell, cx)
}

fn route(shell: &Entity<Shell>, cx: &mut VisualTestContext) -> Route {
    cx.read(|cx| shell.read(cx).state().route().clone())
}

fn read_call() -> Vec<EventLine> {
    one_call(
        "Read",
        json!({"file_path": format!("{ROOT}/src/main.rs"), "offset": 12}),
        Some("fn main() {}"),
    )
}

#[test]
fn a_cards_path_opens_the_files_route_in_the_routes_workspace() {
    let mut app = app();
    let (shell, cx) = open(&mut app, &read_call(), &[]);
    // The link is the route's workspace (`FileLinkProvider`).
    let link = cx.read(|cx| {
        let s = shell.read(cx);
        let tab = s.chat_tab().unwrap();
        s.chat_view(&tab)
            .unwrap()
            .read(cx)
            .options()
            .file_link
            .clone()
    });
    let link = link.expect("the file link is set");
    assert_eq!((link.workspace_id.as_str(), link.cwd.as_str()), (WS, ROOT));

    click(cx, "tool-call-path");
    match route(&shell, cx) {
        Route::Workspace {
            id,
            page: WorkspacePage::Files { root, path },
        } => {
            assert_eq!(id, WS);
            assert_eq!(root, None);
            assert_eq!(path.as_deref(), Some("src/main.rs"));
        }
        other => panic!("{other:?}"),
    }
}

#[test]
fn open_goes_to_the_saved_editors_url() {
    let mut app = app();
    let (_shell, cx) = open(&mut app, &read_call(), &[("claudius.editor", "zed")]);
    click(cx, "tool-toggle:Read");
    click(cx, "tool-call-open");
    assert_eq!(
        cx.opened_url().as_deref(),
        Some(format!("zed://file/{ROOT}/src/main.rs:12").as_str())
    );
}

#[test]
fn an_unknown_saved_editor_is_vscode() {
    let mut app = app();
    let (_shell, cx) = open(&mut app, &read_call(), &[("claudius.editor", "emacs")]);
    click(cx, "tool-toggle:Read");
    click(cx, "tool-call-open");
    assert_eq!(
        cx.opened_url().as_deref(),
        Some(format!("vscode://file/{ROOT}/src/main.rs:12").as_str())
    );
}

fn html_write() -> Vec<EventLine> {
    one_call(
        "Write",
        json!({"file_path": format!("{ROOT}/docs/index.html"), "content": "<p>hi</p>"}),
        Some("File created successfully"),
    )
}

#[test]
fn a_written_page_shows_its_preview() {
    let mut app = app();
    let (_shell, cx) = open(&mut app, &html_write(), &[]);
    assert!(drawn(cx, "file-preview-toggle"));
}

#[test]
fn show_previews_false_hides_the_preview() {
    let mut app = app();
    let (_shell, cx) = open(
        &mut app,
        &html_write(),
        &[("claudius.showPreviews", "false")],
    );
    assert!(drawn(cx, "tool-call:Write"));
    assert!(!drawn(cx, "file-preview-toggle"));
}

#[test]
fn an_answered_questions_pill_resurrects_it() {
    let mut app = app();
    let lines = one_call(
        "AskUserQuestion",
        json!({"questions": [{
            "question": "Which database?",
            "header": "DB",
            "options": [
                {"label": "SQLite", "description": "One file"},
                {"label": "Postgres", "description": "A server"}
            ],
            "multiSelect": false
        }]}),
        Some("User has answered your questions: \"Which database?\"=\"SQLite\"."),
    );
    let (_shell, cx) = open(&mut app, &lines, &[]);
    assert!(!drawn(cx, "ask-user-question"));
    click(cx, "tool-call-answer-pill");
    assert!(drawn(cx, "ask-user-question"));
}

#[test]
fn a_question_without_questions_toasts() {
    let mut app = app();
    let lines = one_call("AskUserQuestion", json!({"oops": true}), Some("answered"));
    let (_shell, cx) = open(&mut app, &lines, &[]);
    click(cx, "tool-call-answer-pill");
    assert!(drawn(cx, "chat-toast"));
    assert!(!drawn(cx, "ask-user-question"));
}
