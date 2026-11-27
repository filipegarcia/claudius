//! One test per rule the cards port from `ToolCall.tsx`, `TaskBlock.tsx`,
//! `WorkflowBlock.tsx`, `ProposeGoalBlock.tsx`, `JsonBlock.tsx` and
//! `FilePreview.tsx`, named after it. Most run on the fixture turn
//! ([`crate::script::tool_cards`]) in the event shapes a real session sends.

use std::sync::Arc;

use claudius_client::state::{ChatState, Prompt};
use claudius_client::{DisplayBlock as B, DisplayMessage, Role, ToolResult};
use claudius_core::js_string;
use serde_json::{Value, json};

use super::*;
use crate::fixture::{CARDS_ROOT, DEMO_START_MS, replay};
use crate::rows::{
    AssistantBlock, Row, RowBuilder, Toggle, ToolRow, Transcript, ViewOptions, rows,
};
use crate::verbose::Verbose;

fn cards_state(running: bool) -> ChatState {
    replay(
        "t",
        &crate::script::tool_cards("s", DEMO_START_MS, CARDS_ROOT, running),
    )
}

fn tool_rows(t: &Transcript) -> Vec<ToolRow> {
    let mut out = Vec::new();
    for r in &t.rows {
        if let Row::Assistant(a) = r {
            for b in &a.blocks {
                if let AssistantBlock::Tool(t) = b {
                    out.push((**t).clone());
                }
            }
        }
    }
    out
}

fn find(t: &Transcript, id: &str) -> Card {
    tool_rows(t)
        .into_iter()
        .find(|r| r.id == id)
        .unwrap_or_else(|| panic!("no card for {id}"))
        .card
}

fn call(t: &Transcript, id: &str) -> CallCard {
    match find(t, id) {
        Card::Call(c) => c,
        other => panic!("{id} is a {:?}", other.kind()),
    }
}

fn task(t: &Transcript, id: &str) -> TaskCard {
    match find(t, id) {
        Card::Task(c) => c,
        other => panic!("{id} is a {:?}", other.kind()),
    }
}

fn workflow(t: &Transcript, id: &str) -> WorkflowCard {
    match find(t, id) {
        Card::Workflow(c) => c,
        other => panic!("{id} is a {:?}", other.kind()),
    }
}

fn goal(t: &Transcript, id: &str) -> GoalCard {
    match find(t, id) {
        Card::Goal(c) => c,
        other => panic!("{id} is a {:?}", other.kind()),
    }
}

/// The card key of `id` in the fixture turn.
fn key(id: &str) -> String {
    find(&rows(&cards_state(true), &ViewOptions::default()), id)
        .key()
        .to_owned()
}

fn opened(keys: &[&str]) -> ViewOptions {
    ViewOptions {
        toggled: keys.iter().map(|k| (*k).to_owned()).collect(),
        ..ViewOptions::default()
    }
}

fn linked(mut o: ViewOptions) -> ViewOptions {
    o.file_link = Some(FileLink {
        workspace_id: "ws1".into(),
        cwd: CARDS_ROOT.into(),
    });
    o
}

/// One assistant message holding `block`, after a prompt.
fn one(block: B) -> ChatState {
    let mut s = ChatState::new("t");
    s.replaying = false;
    let mut u = DisplayMessage::new("u1", Role::User, vec![B::text("go")]);
    u.created_at = Some(1.0);
    let mut a = DisplayMessage::new("a1", Role::Assistant, vec![block]);
    a.created_at = Some(2.0);
    s.messages = vec![u, a];
    s
}

fn tool_use(id: &str, name: &str, input: Value, result: Option<ToolResult>) -> B {
    B::ToolUse {
        id: id.into(),
        name: name.into(),
        input,
        result,
        started_at: None,
    }
}

fn result(content: &str, is_error: bool) -> ToolResult {
    ToolResult {
        content: content.into(),
        is_error: Some(is_error),
        staged: None,
        detached: None,
        not_run: None,
    }
}

fn task_info(v: Value) -> claudius_client::task_status::TaskInfo {
    serde_json::from_value(v).expect("a TaskInfo")
}

fn only_call(s: &ChatState, o: &ViewOptions) -> CallCard {
    call(&rows(s, o), "x")
}

// ------------------------------------------------------------- dispatch

#[test]
fn task_and_agent_are_task_blocks_workflow_and_propose_goal_their_own_and_the_rest_tool_calls() {
    assert_eq!(CardKind::of("Task"), CardKind::Task);
    assert_eq!(CardKind::of("Agent"), CardKind::Task);
    assert_eq!(CardKind::of("Workflow"), CardKind::Workflow);
    assert_eq!(CardKind::of("ProposeGoal"), CardKind::ProposeGoal);
    for name in [
        "Bash",
        "Read",
        "mcp__linear__create_issue",
        "task",
        "WorkflowX",
    ] {
        assert_eq!(CardKind::of(name), CardKind::Tool, "{name}");
    }
}

#[test]
fn every_tool_in_the_fixture_turn_gets_its_card() {
    let t = rows(&cards_state(true), &ViewOptions::default());
    let kinds: Vec<_> = tool_rows(&t)
        .iter()
        .map(|r| (r.name.clone(), r.card.kind()))
        .collect();
    assert_eq!(kinds.len(), 19);
    assert!(kinds.contains(&("Agent".into(), CardKind::Task)));
    assert!(kinds.contains(&("Task".into(), CardKind::Task)));
    assert!(kinds.contains(&("Workflow".into(), CardKind::Workflow)));
    assert!(kinds.contains(&("ProposeGoal".into(), CardKind::ProposeGoal)));
    assert!(kinds.contains(&("mcp__linear__create_issue".into(), CardKind::Tool)));
}

// ------------------------------------------------------------- ToolCall

#[test]
fn a_tool_call_starts_collapsed_and_a_click_opens_it() {
    let s = cards_state(false);
    let c = call(&rows(&s, &ViewOptions::default()), "toolu_C04");
    assert!(!c.open && c.body.is_none());
    let c = call(&rows(&s, &opened(&[&key("toolu_C04")])), "toolu_C04");
    assert!(c.open && c.body.is_some());
}

#[test]
fn ultra_verbose_opens_every_tool_call_and_a_click_closes_one() {
    let s = cards_state(false);
    let o = ViewOptions {
        verbose: Verbose::UltraVerbose,
        ..ViewOptions::default()
    };
    assert!(call(&rows(&s, &o), "toolu_C04").open);
    let mut o2 = o.clone();
    o2.toggled.insert(key("toolu_C04"));
    assert!(!call(&rows(&s, &o2), "toolu_C04").open);
}

#[test]
fn a_call_without_a_result_is_running_since_its_start() {
    let c = call(
        &rows(&cards_state(true), &ViewOptions::default()),
        "toolu_C18",
    );
    let CallStatus::Running {
        since,
        disconnected,
    } = c.status
    else {
        panic!("{:?}", c.status)
    };
    assert!(since.is_some_and(|t| t > DEMO_START_MS));
    assert!(!disconnected);
    assert_eq!(c.timer(), since);
}

#[test]
fn a_running_call_while_the_stream_reconnects_is_disconnected_and_keeps_its_timer() {
    let mut s = cards_state(true);
    s.stream_status = "reconnecting";
    let c = call(&rows(&s, &ViewOptions::default()), "toolu_C18");
    assert!(matches!(
        c.status,
        CallStatus::Running {
            disconnected: true,
            ..
        }
    ));
    // `useElapsedSeconds(startedAt, status === "running")`: only the dot dims.
    assert!(c.timer().is_some());
}

#[test]
fn a_call_with_a_start_of_zero_runs_without_a_timer() {
    let s = one(B::ToolUse {
        id: "x".into(),
        name: "Bash".into(),
        input: json!({}),
        result: None,
        started_at: Some(0.0),
    });
    let c = only_call(&s, &ViewOptions::default());
    assert!(matches!(c.status, CallStatus::Running { since: None, .. }));
    assert_eq!(c.timer(), None);
}

#[test]
fn a_result_is_ok_and_an_error_result_is_an_error() {
    let t = rows(&cards_state(false), &ViewOptions::default());
    assert_eq!(call(&t, "toolu_C04").status, CallStatus::Ok);
    assert_eq!(call(&t, "toolu_C15").status, CallStatus::Error);
    // A call the user stopped is an error result ("[Request interrupted…]").
    assert_eq!(call(&t, "toolu_C17").status, CallStatus::Error);
}

#[test]
fn a_call_auto_mode_could_not_check_is_not_run_and_muted() {
    let s = cards_state(false);
    let c = call(&rows(&s, &opened(&[&key("toolu_C16")])), "toolu_C16");
    assert_eq!(c.status, CallStatus::NotRun { rejected: false });
    assert!(c.dim());
    let r = c.body.unwrap().result.unwrap();
    assert_eq!((r.label, r.tone), ("not run", ResultTone::Muted));
    assert_eq!(CallStatus::not_run_text(false).0, "Not run");
}

#[test]
fn an_error_result_shows_under_an_error_label() {
    let s = cards_state(false);
    let c = call(&rows(&s, &opened(&[&key("toolu_C15")])), "toolu_C15");
    let r = c.body.unwrap().result.unwrap();
    assert_eq!((r.label, r.tone), ("error", ResultTone::Error));
    assert!(r.text.text.starts_with("error: unused variable"));
}

#[test]
fn a_tool_in_a_stopped_agent_is_interrupted_not_running() {
    let s = cards_state(false);
    let k = key("toolu_C19");
    let t = task(&rows(&s, &opened(&[&k])), "toolu_C19");
    let inner: Vec<_> = t
        .body
        .unwrap()
        .inner
        .into_iter()
        .flat_map(|m| match m {
            SubMessage::Assistant { blocks, .. } => blocks,
            SubMessage::User { .. } => Vec::new(),
        })
        .collect();
    let Some(SubBlock::Tool(c)) = inner.first() else {
        panic!("{inner:?}")
    };
    assert_eq!(
        c.status,
        CallStatus::Interrupted(SettledToolReason::Stopped)
    );
    assert_eq!(c.timer(), None);
}

#[test]
fn an_mcp_task_settles_its_call_by_the_task_status() {
    let mut s = one(tool_use("x", "mcp__srv__job", json!({}), None));
    let mut put = |status: &str, task_type: &str| {
        s.tasks.insert(
            "k".into(),
            task_info(json!({"taskId": "k", "toolUseId": "x", "description": "", "status": status, "taskType": task_type})),
        );
        only_call(&s, &ViewOptions::default()).status
    };
    assert_eq!(put("completed", "mcp_task"), CallStatus::Ok);
    assert_eq!(put("failed", "mcp_task"), CallStatus::Error);
    assert_eq!(put("killed", "mcp_task"), CallStatus::Error);
    assert!(matches!(
        put("running", "mcp_task"),
        CallStatus::Running { .. }
    ));
    // Only an `mcp_task` joins.
    assert!(matches!(
        put("completed", "local_agent"),
        CallStatus::Running { .. }
    ));
}

#[test]
fn an_mcp_task_lists_its_resource_links_with_a_count_badge() {
    let mut s = one(tool_use(
        "x",
        "mcp__srv__job",
        json!({}),
        Some(result("ok", false)),
    ));
    s.tasks.insert(
        "k".into(),
        task_info(json!({"taskId": "k", "toolUseId": "x", "description": "", "status": "completed", "taskType": "mcp_task",
            "resourceLinks": [{"uri": "file:///r.csv", "name": "r.csv", "title": "Report"}, {"uri": "s3://b/k", "name": "k", "description": "The bucket"}]})),
    );
    let key = only_call(&s, &ViewOptions::default()).key;
    let c = only_call(&s, &opened(&[&key]));
    assert_eq!(c.resource_count, Some(2));
    let links = c.body.unwrap().links;
    assert_eq!(
        links
            .iter()
            .map(|l| (l.label.as_str(), l.title.as_str()))
            .collect::<Vec<_>>(),
        [("Report", "file:///r.csv"), ("k", "The bucket")]
    );
}

#[test]
fn a_file_tool_shows_its_path_split_at_the_last_slash() {
    let t = rows(&cards_state(false), &ViewOptions::default());
    let p = call(&t, "toolu_C01").path.unwrap();
    assert_eq!(p.tail, "ToolCall.tsx");
    assert_eq!(p.head, format!("{CARDS_ROOT}/components/chat/"));
    assert_eq!(p.files, None, "no files link without the workspace");
    assert_eq!(call(&t, "toolu_C04").path, None, "Bash has no path");
}

#[test]
fn a_path_under_the_workspace_links_into_the_files_page() {
    let t = rows(&cards_state(false), &linked(ViewOptions::default()));
    let f = call(&t, "toolu_C05").path.unwrap().files.unwrap();
    assert_eq!(f.rel_path, "rust/app/crates/claudius-chat/src/cards.rs");
    assert_eq!(
        f.href,
        "/ws1/files?path=rust%2Fapp%2Fcrates%2Fclaudius-chat%2Fsrc%2Fcards.rs"
    );
}

#[test]
fn an_open_file_tool_offers_its_editor_at_the_line() {
    let s = cards_state(false);
    let mut o = opened(&[&key("toolu_C01")]);
    o.editor = "zed".into();
    let c = call(&rows(&s, &o), "toolu_C01");
    let CallMain::Input {
        editor: Some(e), ..
    } = c.body.unwrap().main
    else {
        panic!("no editor link")
    };
    assert_eq!(e.line, Some(125.0));
    assert_eq!(
        e.url,
        format!("zed://file/{CARDS_ROOT}/components/chat/ToolCall.tsx:125")
    );
    assert_eq!(e.title(), "Open in editor (zed)");
}

#[test]
fn an_open_call_shows_its_input_as_pretty_json() {
    let s = cards_state(false);
    let c = call(&rows(&s, &opened(&[&key("toolu_C07")])), "toolu_C07");
    let CallMain::Input { json, editor } = c.body.unwrap().main else {
        panic!()
    };
    assert_eq!(editor, None);
    assert!(
        json.text
            .starts_with("{\n  \"url\": \"https://lucide.dev/icons/wrench\",\n  \"prompt\"")
    );
}

#[test]
fn a_long_result_folds_past_the_fold_size_until_show_more() {
    let s = cards_state(false);
    let k = key("toolu_C04");
    let r = call(&rows(&s, &opened(&[&k])), "toolu_C04")
        .body
        .unwrap()
        .result
        .unwrap();
    let PreFold::Folded { hidden_bytes } = r.text.fold else {
        panic!("{:?}", r.text.fold)
    };
    assert!(r.text.text.len() <= crate::rows::FOLD_BYTES);
    assert!(hidden_bytes > 0);
    assert_eq!(r.text.key, format!("{k}/result/more"));
    let more = format!("{k}/result/more");
    let r = call(&rows(&s, &opened(&[&k, &more])), "toolu_C04")
        .body
        .unwrap()
        .result
        .unwrap();
    assert_eq!(r.text.fold, PreFold::Expanded);
    assert_eq!(
        r.text.text.len(),
        hidden_bytes + crate::text::fold_cut(&r.text.text, crate::rows::FOLD_BYTES).unwrap()
    );
}

#[test]
fn a_huge_input_folds_too() {
    let big = "x".repeat(10_000);
    let s = one(tool_use(
        "x",
        "Write",
        json!({"file_path": "/a.txt", "content": big}),
        Some(result("ok", false)),
    ));
    let k = only_call(&s, &ViewOptions::default()).key;
    let CallMain::Input { json, .. } = only_call(&s, &opened(&[&k])).body.unwrap().main else {
        panic!()
    };
    assert!(matches!(json.fold, PreFold::Folded { .. }));
    assert_eq!(json.key, format!("{k}/input/more"));
}

#[test]
fn exit_plan_mode_shows_its_plan_as_markdown_with_a_suffix() {
    let s = cards_state(false);
    let c = call(&rows(&s, &opened(&[&key("toolu_C14")])), "toolu_C14");
    assert!(c.plan_suffix);
    let CallMain::Plan(md) = c.body.unwrap().main else {
        panic!()
    };
    assert!(md.text.starts_with("## Plan"));
}

#[test]
fn an_empty_plan_is_no_plan() {
    let s = one(tool_use(
        "x",
        "ExitPlanMode",
        json!({"plan": ""}),
        Some(result("ok", false)),
    ));
    let k = only_call(&s, &ViewOptions::default()).key;
    let c = only_call(&s, &opened(&[&k]));
    assert!(!c.plan_suffix);
    assert!(matches!(c.body.unwrap().main, CallMain::Input { .. }));
}

#[test]
fn a_feedback_draft_is_titled_and_shows_its_text_not_its_json() {
    let s = one(tool_use(
        "x",
        "SendFeedback",
        json!({"title": "Bug", "details": "- a"}),
        None,
    ));
    let k = only_call(&s, &ViewOptions::default()).key;
    let c = only_call(&s, &opened(&[&k]));
    assert_eq!(
        (c.title.as_str(), c.icon),
        ("Feedback draft", "MessageSquareHeart")
    );
    let CallMain::Feedback(md) = c.body.unwrap().main else {
        panic!()
    };
    assert_eq!(&*md.text, "**Bug**\n\n- a");
    // Without text, the JSON as any tool.
    let s = one(tool_use("x", "SendFeedback", json!({}), None));
    assert!(matches!(
        only_call(&s, &opened(&[&k])).body.unwrap().main,
        CallMain::Input { .. }
    ));
}

#[test]
fn a_schedule_call_names_its_action() {
    let label = |name: &str, action: Value| {
        only_call(
            &one(tool_use("x", name, json!({"action": action}), None)),
            &ViewOptions::default(),
        )
        .schedule_action
    };
    assert_eq!(label("Schedule", json!("run")).as_deref(), Some("Run now"));
    assert_eq!(
        label("RemoteTrigger", json!("list_runs")).as_deref(),
        Some("List runs")
    );
    assert_eq!(
        label("Schedule", json!("archive")).as_deref(),
        Some("archive")
    );
    assert_eq!(label("Schedule", json!("")), None);
    assert_eq!(label("Schedule", json!(3)), None);
    assert_eq!(label("Bash", json!("run")), None);
}

#[test]
fn an_answered_ask_offers_reopen_and_a_live_one_answer() {
    let t = rows(&cards_state(false), &ViewOptions::default());
    let a = call(&t, "toolu_C13").answer.unwrap();
    assert!(!a.live);
    assert_eq!(a.label(), "Reopen");
    assert_eq!(AnswerPill { live: true }.label(), "Answer");
}

#[test]
fn staged_and_detached_results_get_badges_unless_they_failed() {
    let mut r = result("ok", false);
    r.staged = Some(true);
    r.detached = Some(true);
    let c = only_call(
        &one(tool_use("x", "Bash", json!({}), Some(r.clone()))),
        &ViewOptions::default(),
    );
    assert!(c.staged && c.detached);
    r.is_error = Some(true);
    let c = only_call(
        &one(tool_use("x", "Bash", json!({}), Some(r))),
        &ViewOptions::default(),
    );
    assert!(!c.staged && !c.detached);
}

// ------------------------------------------------------------ FilePreview

fn image_state(r: ToolResult) -> ChatState {
    one(tool_use(
        "x",
        "Write",
        json!({"file_path": format!("{CARDS_ROOT}/site/shot.png")}),
        Some(r),
    ))
}

#[test]
fn a_written_image_under_the_workspace_previews_open() {
    let c = only_call(
        &image_state(result("ok", false)),
        &linked(ViewOptions::default()),
    );
    let p = c.preview.unwrap();
    assert_eq!(
        (p.kind, p.open, p.file_name.as_str()),
        (PreviewType::Image, true, "shot.png")
    );
    assert_eq!(p.rel_path, "site/shot.png");
    assert_eq!(p.label(), "preview");
    let p = only_call(
        &image_state(result("ok", false)),
        &linked(opened(&[&p.key])),
    )
    .preview
    .unwrap();
    assert!(!p.open, "a click folds it");
}

#[test]
fn an_html_file_previews_closed() {
    let s = one(tool_use(
        "x",
        "Write",
        json!({"file_path": format!("{CARDS_ROOT}/a.html")}),
        Some(result("ok", false)),
    ));
    let p = only_call(&s, &linked(ViewOptions::default()))
        .preview
        .unwrap();
    assert_eq!((p.kind, p.open), (PreviewType::Html, false));
}

#[test]
fn no_preview_without_a_result_on_an_error_when_staged_or_switched_off() {
    let o = linked(ViewOptions::default());
    let none = |s: &ChatState, o: &ViewOptions| only_call(s, o).preview.is_none();
    assert!(none(
        &one(tool_use(
            "x",
            "Write",
            json!({"file_path": format!("{CARDS_ROOT}/a.png")}),
            None
        )),
        &o
    ));
    assert!(none(&image_state(result("no", true)), &o));
    let mut staged = result("ok", false);
    staged.staged = Some(true);
    assert!(none(&image_state(staged), &o));
    let mut off = o.clone();
    off.show_previews = false;
    assert!(none(&image_state(result("ok", false)), &off));
    assert!(
        none(&image_state(result("ok", false)), &ViewOptions::default()),
        "no workspace"
    );
}

// --------------------------------------------------------------- JsonBlock

#[test]
fn json_past_twelve_lines_starts_collapsed_and_a_click_shows_it() {
    let opts = ViewOptions::default();
    let small = json_view(&opts, "j".into(), &json!({"a": 1}));
    assert!(!small.collapsed && small.tokens.is_some());
    assert_eq!(small.lines, 3);
    let big = json!({"a": 1, "b": 2, "c": 3, "d": 4, "e": 5, "f": 6, "g": 7, "h": 8, "i": 9, "j": 10, "k": 11});
    let v = json_view(&opts, "j".into(), &big);
    assert_eq!(v.lines, 13);
    assert!(v.collapsed && v.tokens.is_none());
    let v = json_view(&opened(&["j"]), "j".into(), &big);
    assert!(!v.collapsed && v.tokens.is_some());
}

#[test]
fn shown_json_folds_past_the_fold_size() {
    let big = json!({"blob": "y".repeat(9000)});
    let v = json_view(&ViewOptions::default(), "j".into(), &big);
    let PreFold::Folded { hidden_bytes } = v.more else {
        panic!("{:?}", v.more)
    };
    let shown: usize = v
        .tokens
        .as_ref()
        .unwrap()
        .iter()
        .map(|(t, _)| t.len())
        .sum();
    assert_eq!(
        shown + hidden_bytes,
        js_string::stringify_pretty(&big).len()
    );
    let v = json_view(&opened(&["j/more"]), "j".into(), &big);
    assert_eq!(v.more, PreFold::Expanded);
}

// --------------------------------------------------------------- TaskBlock

#[test]
fn a_task_shows_its_agent_intent_live_activity_and_stats() {
    let t = task(
        &rows(&cards_state(false), &ViewOptions::default()),
        "toolu_C10",
    );
    assert_eq!(t.agent, "Explore");
    assert_eq!(t.title.as_deref(), Some("Find the card components"));
    assert_eq!(t.activity.as_deref(), Some("Reading AssistantMessage.tsx"));
    assert_eq!(
        t.stats.as_deref(),
        Some("Haiku 4.5 · 18,234 tok · 3 tools · 41s")
    );
    assert_eq!(
        (t.chip.tone, t.chip.mark, t.chip.label.as_str()),
        (ChipTone::Emerald, ChipMark::Check, "Completed")
    );
}

#[test]
fn a_task_without_an_agent_type_is_a_task_and_without_a_task_takes_its_result() {
    let s = one(tool_use(
        "x",
        "Task",
        json!({"agent": 7}),
        Some(result("boom", true)),
    ));
    let t = task(&rows(&s, &ViewOptions::default()), "x");
    assert_eq!(t.agent, "7", "JSX prints a number");
    assert_eq!(t.status, "failed");
    let s = one(tool_use("x", "Task", json!({}), None));
    let t = task(&rows(&s, &ViewOptions::default()), "x");
    assert_eq!((t.agent.as_str(), t.status.as_str()), ("Task", "running"));
    assert_eq!(t.chip.mark, ChipMark::Pulse { dim: false });
    assert_eq!(t.title, None);
}

#[test]
fn a_task_effort_shows_unless_the_agent_is_a_fork() {
    let stats = |agent: &str| {
        let s = one(tool_use(
            "x",
            "Task",
            json!({"subagent_type": agent, "effort": "high"}),
            None,
        ));
        task(&rows(&s, &ViewOptions::default()), "x").stats
    };
    assert_eq!(stats("Explore").as_deref(), Some("high effort"));
    assert_eq!(stats("fork"), None);
}

#[test]
fn a_running_task_while_disconnected_is_dimmed_without_its_pulse_or_retry() {
    let mut s = cards_state(true);
    s.stream_status = "reconnecting";
    let mut s2 = one(tool_use("x", "Task", json!({}), None));
    s2.stream_status = "reconnecting";
    let t = task(&rows(&s2, &ViewOptions::default()), "x");
    assert!(t.disconnected && t.chip.dim);
    assert_eq!(t.chip.mark, ChipMark::None);
    let k = t.key.clone();
    let body = task(&rows(&s2, &opened(&[&k])), "x").body.unwrap();
    assert_eq!(body.empty_note, Some("Disconnected — reconnecting…"));
    // A finished task is not disconnected.
    assert!(!task(&rows(&s, &ViewOptions::default()), "toolu_C10").disconnected);
}

#[test]
fn a_running_task_mid_retry_shows_the_attempt() {
    let mut s = one(tool_use("x", "Task", json!({}), None));
    s.tool_progress.insert(
        "inner".into(),
        serde_json::from_value(json!({"toolUseId": "inner", "toolName": "Bash", "parentToolUseId": "x",
            "subagentRetry": {"agentId": "a", "attempt": 2, "maxRetries": 5, "errorStatus": 529, "errorCategory": "overloaded"}}))
        .unwrap(),
    );
    let t = task(&rows(&s, &ViewOptions::default()), "x");
    assert_eq!(t.retrying.unwrap().0, "retrying 2/5");
}

#[test]
fn an_open_task_shows_its_subagents_trail_and_folded_prompt_and_return() {
    let s = cards_state(false);
    let k = key("toolu_C10");
    let b = task(&rows(&s, &opened(&[&k])), "toolu_C10").body.unwrap();
    assert_eq!(b.empty_note, None);
    // msg_S1's text and Grep are one message (one id), then msg_S2.
    assert_eq!(b.inner.len(), 2, "{:?}", b.inner);
    let p = b.prompt.unwrap();
    assert_eq!((p.summary, p.body.is_none()), ("Spawn prompt", true));
    let r = b.returned.unwrap();
    assert_eq!((r.summary, r.body.is_none()), ("Returned to parent", true));
    let (pk, rk) = (format!("{k}/prompt"), format!("{k}/returned"));
    let b = task(&rows(&s, &opened(&[&k, &pk, &rk])), "toolu_C10")
        .body
        .unwrap();
    assert!(
        b.prompt
            .unwrap()
            .body
            .unwrap()
            .text
            .starts_with("List every component")
    );
    let r = b.returned.unwrap().body.unwrap();
    assert!(
        r.text
            .text
            .starts_with("Four components render a tool_use block:")
    );
    assert!(!r.text.text.contains("agentId"));
    assert_eq!(r.provenance.len(), 1);
}

#[test]
fn a_task_with_no_trail_says_so_by_its_status() {
    let note = |r: Option<ToolResult>| {
        let s = one(tool_use("x", "Task", json!({}), r));
        let k = task(&rows(&s, &ViewOptions::default()), "x").key;
        task(&rows(&s, &opened(&[&k])), "x")
            .body
            .unwrap()
            .empty_note
    };
    assert_eq!(note(None), Some("Subagent working…"));
    assert_eq!(
        note(Some(result("done", false))),
        Some("No subagent messages captured.")
    );
}

#[test]
fn a_stopped_task_is_an_amber_chip_without_a_mark() {
    let t = task(
        &rows(&cards_state(false), &ViewOptions::default()),
        "toolu_C19",
    );
    assert_eq!(
        (t.chip.tone, t.chip.mark, t.chip.label.as_str()),
        (ChipTone::Amber, ChipMark::None, "Stopped")
    );
}

// ------------------------------------------------------------ WorkflowBlock

#[test]
fn a_workflow_is_named_and_counted_by_its_script_meta() {
    let w = workflow(
        &rows(&cards_state(false), &ViewOptions::default()),
        "toolu_C11",
    );
    assert_eq!(w.name, "port-tool-cards");
    assert_eq!(w.phases_label.as_deref(), Some("3 phases"));
    assert_eq!(w.size, None, "a finished workflow shows no size");
    assert_eq!(w.stats.as_deref(), Some("61,002 tok · 38 tools · 3m 32s"));
    assert!(!w.open, "a workflow first seen finished starts closed");
}

#[test]
fn a_workflow_first_seen_running_starts_open_and_stays_open() {
    let s = one(tool_use(
        "x",
        "Workflow",
        json!({"script": "export const meta = { name: 'w', phases: [{ title: 'One' }] };"}),
        None,
    ));
    let w = workflow(&rows(&s, &ViewOptions::default()), "x");
    assert!(w.open && w.live_default);
    assert_eq!(w.size.as_deref(), Some("size: medium"));
    assert_eq!(w.phases_label.as_deref(), Some("1 phase"));
    let s = one(tool_use(
        "x",
        "Workflow",
        json!({"script": "x"}),
        Some(result("{}", false)),
    ));
    let mut o = ViewOptions::default();
    o.opened_live.insert(w.key.clone());
    assert!(workflow(&rows(&s, &o), "x").open);
    assert!(!workflow(&rows(&s, &ViewOptions::default()), "x").open);
}

#[test]
fn a_workflow_still_streaming_its_script_is_preparing() {
    let s = one(tool_use(
        "x",
        "Workflow",
        json!({"__partial": "export const meta = {"}),
        None,
    ));
    let w = workflow(&rows(&s, &ViewOptions::default()), "x");
    assert_eq!(
        (w.status.as_str(), w.chip.label.as_str()),
        ("pending", "Preparing")
    );
    assert!(w.body.unwrap().preparing);
}

#[test]
fn an_open_workflow_shows_its_result_run_and_folded_details() {
    let s = cards_state(false);
    let k = key("toolu_C11");
    let b = workflow(&rows(&s, &opened(&[&k])), "toolu_C11")
        .body
        .unwrap();
    assert_eq!(
        b.result.as_deref(),
        Some("Ported ToolCall, TaskBlock, WorkflowBlock and ProposeGoalBlock; 160 tests pass.")
    );
    assert_eq!(b.run_id.as_deref(), Some("run_7f3a92"));
    assert_eq!(b.phases.len(), 3);
    assert_eq!(
        b.phases[0],
        (
            1,
            "Read".into(),
            Some("the React cards and their helpers".into())
        )
    );
    assert_eq!(
        b.description.as_deref(),
        Some("Port the four tool cards and the helpers they call.")
    );
    for (d, summary) in [(&b.args, "Args"), (&b.raw, "Raw output")] {
        let d = d.as_ref().unwrap();
        assert_eq!((d.summary, d.body.is_none()), (summary, true));
    }
    assert_eq!(b.script.as_ref().unwrap().summary, "Show script");
    let (a, sc) = (format!("{k}/args"), format!("{k}/script"));
    let b = workflow(&rows(&s, &opened(&[&k, &a, &sc])), "toolu_C11")
        .body
        .unwrap();
    assert!(b.args.unwrap().body.unwrap().tokens.is_some());
    assert!(
        b.script
            .unwrap()
            .body
            .unwrap()
            .text
            .starts_with("export const meta")
    );
}

#[test]
fn a_failed_workflow_shows_its_error_and_no_result() {
    let s = one(tool_use(
        "x",
        "Workflow",
        json!({"script": "x"}),
        Some(result("{\"summary\":\"s\",\"error\":\"boom\"}", false)),
    ));
    let mut o = ViewOptions::default();
    o.toggled.insert(workflow(&rows(&s, &o), "x").key);
    let b = workflow(&rows(&s, &o), "x").body.unwrap();
    assert_eq!((b.error.as_deref(), b.result), (Some("boom"), None));
    let s = one(tool_use(
        "x",
        "Workflow",
        json!({"script": "x"}),
        Some(result("plain failure", true)),
    ));
    let w = workflow(&rows(&s, &o), "x");
    assert_eq!((w.status.as_str(), w.chip.tone), ("failed", ChipTone::Red));
    assert_eq!(w.body.unwrap().error.as_deref(), Some("plain failure"));
}

// --------------------------------------------------------- ProposeGoalBlock

#[test]
fn a_goal_proposal_is_proposing_then_awaiting_approval_or_set() {
    let state = |input: Value, r: Option<ToolResult>| {
        goal(
            &rows(
                &one(tool_use("x", "ProposeGoal", input, r)),
                &ViewOptions::default(),
            ),
            "x",
        )
        .state
    };
    assert_eq!(state(json!({"condition": "c"}), None), GoalState::Proposing);
    assert_eq!(
        state(json!({"condition": "c"}), Some(result("{}", false))),
        GoalState::AwaitingApproval
    );
    assert_eq!(
        state(json!({"ask_user": false}), Some(result("{}", false))),
        GoalState::GoalSet
    );
    assert_eq!(
        state(json!({}), Some(result("{\"askUser\":false}", false))),
        GoalState::GoalSet
    );
    assert_eq!(state(json!({}), Some(result("no", true))), GoalState::Error);
    assert_eq!(GoalState::AwaitingApproval.label(), "awaiting approval");
}

#[test]
fn a_goal_takes_the_condition_from_its_result_before_its_input() {
    let s = one(tool_use(
        "x",
        "ProposeGoal",
        json!({"condition": "in"}),
        Some(result("{\"condition\":\"out\"}", false)),
    ));
    assert_eq!(
        goal(&rows(&s, &ViewOptions::default()), "x")
            .condition
            .as_deref(),
        Some("out")
    );
    let g = goal(
        &rows(&cards_state(false), &ViewOptions::default()),
        "toolu_C12",
    );
    assert!(!g.open);
    let g = goal(&rows(&cards_state(false), &opened(&[&g.key])), "toolu_C12");
    assert_eq!(
        g.body.unwrap().note,
        "Sent for your approval — set it from the goal prompt above the composer."
    );
}

// ------------------------------------------------------------- rows wiring

#[test]
fn a_parts_toggle_belongs_to_its_card() {
    assert!(Toggle::is_part_of("tool:a:1/result/more", "tool:a:1"));
    assert!(Toggle::is_part_of("preview:tool:a:1/inner:m:0", "tool:a:1"));
    assert!(!Toggle::is_part_of("tool:a:10/result/more", "tool:a:1"));
    assert!(!Toggle::is_part_of("tool:a:1", "tool:a:1"));
    assert!(!Toggle::is_part_of("preview:tool:a:1", "tool:a:1"));
}

#[test]
fn a_live_ask_hides_its_card_until_answered() {
    let mut s = one(tool_use(
        "x",
        "AskUserQuestion",
        json!({"questions": []}),
        None,
    ));
    assert_eq!(tool_rows(&rows(&s, &ViewOptions::default())).len(), 1);
    s.pending_asks.push(Prompt(
        json!({"requestId": "r", "toolUseId": "x", "questions": []}),
    ));
    assert!(tool_rows(&rows(&s, &ViewOptions::default())).is_empty());
}

fn assistant_arc(t: &Transcript, uuid: &str) -> Arc<crate::rows::AssistantRow> {
    t.rows
        .iter()
        .find_map(|r| match r {
            Row::Assistant(a) if a.uuid == uuid => Some(a.clone()),
            _ => None,
        })
        .unwrap()
}

#[test]
fn a_card_whose_inputs_did_not_change_keeps_its_row_and_a_task_update_rebuilds_it() {
    let mut s = cards_state(true);
    let mut b = RowBuilder::default();
    let o = ViewOptions::default();
    let first = b.build(&s, &o);
    let again = b.build(&s, &o);
    for uuid in ["msg_C1", "msg_C3", "msg_C4"] {
        assert!(
            Arc::ptr_eq(&assistant_arc(&first, uuid), &assistant_arc(&again, uuid)),
            "{uuid}"
        );
    }
    // The workflow's task moves on: its row rebuilds, the others don't.
    for t in s.tasks.values_mut() {
        if t.tool_use_id.as_deref() == Some("toolu_C11") {
            t.total_tokens = Some(70_000.0);
        }
    }
    let next = b.build(&s, &o);
    assert!(!Arc::ptr_eq(
        &assistant_arc(&again, "msg_C3"),
        &assistant_arc(&next, "msg_C3")
    ));
    assert!(Arc::ptr_eq(
        &assistant_arc(&again, "msg_C1"),
        &assistant_arc(&next, "msg_C1")
    ));
    assert_eq!(
        workflow(&next, "toolu_C11").stats.as_deref(),
        Some("70,000 tok · 38 tools · 3m 32s")
    );
}

#[test]
fn a_subagent_message_rebuilds_its_task_row() {
    let mut s = cards_state(true);
    let mut b = RowBuilder::default();
    let o = ViewOptions::default();
    let first = b.build(&s, &o);
    s.subagent_messages
        .get_mut("toolu_C10")
        .unwrap()
        .push(DisplayMessage::new(
            "late",
            Role::Assistant,
            vec![B::text("late")],
        ));
    let next = b.build(&s, &o);
    assert!(!Arc::ptr_eq(
        &assistant_arc(&first, "msg_C3"),
        &assistant_arc(&next, "msg_C3")
    ));
    assert!(Arc::ptr_eq(
        &assistant_arc(&first, "msg_C4"),
        &assistant_arc(&next, "msg_C4")
    ));
}
