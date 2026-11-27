//! One test per decision [`rows`] ports, named after it.

use std::sync::Arc;

use claudius_client::state::{ChatState, Prompt};
use claudius_client::{
    AttachedImage, CompactStats, DisplayBlock as B, DisplayMessage, PeerInfo, RateLimitInfo, Role,
    SystemEntry, SystemEntryKind as K, ToolResult,
};
use serde_json::{Value, json};

use super::*;

fn state() -> ChatState {
    let mut s = ChatState::new("tab-1");
    s.replaying = false;
    s
}

fn user(uuid: &str, text: &str, at: f64) -> DisplayMessage {
    let mut m = DisplayMessage::new(uuid, Role::User, vec![B::text(text)]);
    m.created_at = Some(at);
    m
}

fn assistant(uuid: &str, blocks: Vec<B>, at: f64) -> DisplayMessage {
    let mut m = DisplayMessage::new(uuid, Role::Assistant, blocks);
    m.created_at = Some(at);
    m
}

fn tool(id: &str, name: &str, input: Value, result: Option<ToolResult>) -> B {
    B::ToolUse {
        id: id.into(),
        name: name.into(),
        input,
        result,
        started_at: None,
    }
}

fn thinking(text: &str) -> B {
    B::Thinking {
        text: text.into(),
        redacted: None,
    }
}

fn entry(uuid: &str, after: &str, kind: SystemEntryKind, label: &str) -> SystemEntry {
    SystemEntry::new(uuid, after, kind, label)
}

fn keys(t: &Transcript) -> Vec<String> {
    t.rows.iter().map(Row::key).collect()
}

fn opts() -> ViewOptions {
    ViewOptions::default()
}

fn with(level: Verbose) -> ViewOptions {
    ViewOptions {
        verbose: level,
        ..ViewOptions::default()
    }
}

fn toggled(keys: &[Toggle]) -> ViewOptions {
    ViewOptions {
        toggled: keys.iter().map(Toggle::key).collect(),
        ..ViewOptions::default()
    }
}

fn the_user(t: &Transcript, uuid: &str) -> UserRow {
    t.rows
        .iter()
        .find_map(|r| match r {
            Row::User(u) if u.uuid == uuid => Some((**u).clone()),
            _ => None,
        })
        .expect("the user row")
}

fn the_assistant(t: &Transcript, uuid: &str) -> AssistantRow {
    t.rows
        .iter()
        .find_map(|r| match r {
            Row::Assistant(a) if a.uuid == uuid => Some((**a).clone()),
            _ => None,
        })
        .expect("the assistant row")
}

fn pills(t: &Transcript) -> Vec<Pill> {
    t.rows
        .iter()
        .filter_map(|r| match r {
            Row::System(s) => Some(s.pill.clone()),
            _ => None,
        })
        .collect()
}

fn one_pill(e: SystemEntry) -> Option<Pill> {
    let mut s = state();
    s.messages.push(user("u", "hi", 1.0));
    s.system_entries.push(e);
    pills(&rows(&s, &opts())).into_iter().next()
}

// ---- MessageList: what the list holds and in what order ------------------

#[test]
fn messages_show_in_chronological_order_and_a_missing_time_takes_the_one_before() {
    let mut s = state();
    s.messages.push(user("late", "b", 20.0));
    s.messages.push(DisplayMessage::new(
        "untimed",
        Role::User,
        vec![B::text("c")],
    ));
    s.messages.push(user("early", "a", 10.0));
    assert_eq!(keys(&rows(&s, &opts())), ["m:early", "m:late", "m:untimed"]);
}

#[test]
fn an_empty_transcript_shows_the_splash_with_the_unanchored_pills() {
    let mut s = state();
    s.system_entries
        .push(entry("p0", "", K::Init, "Session started"));
    s.system_entries
        .push(entry("p1", "gone", K::Info, "anchored"));
    let t = rows(&s, &opts());
    assert_eq!(t.placeholder, Placeholder::Splash);
    assert_eq!(keys(&t), ["s:p0"]);
}

#[test]
fn an_empty_transcript_catching_up_says_so_or_that_the_stream_is_down() {
    let mut s = state();
    let o = ViewOptions {
        catching_up: true,
        ..opts()
    };
    assert_eq!(
        rows(&s, &o).placeholder,
        Placeholder::CatchingUp {
            disconnected: false
        }
    );
    s.stream_status = "reconnecting";
    assert_eq!(
        rows(&s, &o).placeholder,
        Placeholder::CatchingUp { disconnected: true }
    );
}

#[test]
fn older_history_shows_the_list_and_the_top_sentinel_even_with_no_message() {
    let mut s = state();
    s.has_more_above = Some(json!(true));
    let t = rows(&s, &opts());
    assert_eq!(t.placeholder, Placeholder::List);
    assert_eq!(t.rows, [Row::Older { loading: false }]);
    s.loading_older = true;
    assert_eq!(rows(&s, &opts()).rows, [Row::Older { loading: true }]);
}

#[test]
fn more_than_20_messages_with_nothing_older_starts_with_beginning_of_conversation() {
    let mut s = state();
    for i in 0..20 {
        s.messages.push(user(&format!("u{i}"), "x", i as f64));
    }
    assert!(!rows(&s, &opts()).rows.contains(&Row::Beginning));
    s.messages.push(user("u20", "x", 20.0));
    assert_eq!(rows(&s, &opts()).rows[0], Row::Beginning);
    s.has_more_above = Some(json!(1));
    assert_eq!(rows(&s, &opts()).rows[0], Row::Older { loading: false });
}

#[test]
fn pills_follow_their_message_and_unanchored_ones_lead() {
    let mut s = state();
    s.messages.push(user("u1", "q", 1.0));
    s.messages.push(assistant("a1", vec![B::text("r")], 2.0));
    s.system_entries.push(entry("after-a", "a1", K::Info, "x"));
    s.system_entries.push(entry("top", "", K::Init, "init"));
    s.system_entries.push(entry("after-u", "u1", K::Info, "y"));
    s.system_entries
        .push(entry("orphan", "nowhere", K::Info, "z"));
    assert_eq!(
        keys(&rows(&s, &opts())),
        ["s:top", "m:u1", "s:after-u", "m:a1", "s:after-a"]
    );
}

#[test]
fn pills_of_a_message_the_level_hides_go_with_it() {
    let mut s = state();
    s.messages.push(user("u1", "q", 1.0));
    s.messages.push(assistant("a1", vec![thinking("hm")], 2.0));
    s.system_entries.push(entry("p", "a1", K::Info, "x"));
    assert_eq!(keys(&rows(&s, &opts())), ["m:u1"]);
    assert_eq!(
        keys(&rows(&s, &with(Verbose::Verbose))),
        ["m:u1", "m:a1", "s:p"]
    );
}

#[test]
fn the_status_ticker_and_reminders_hide_at_compact() {
    let mut s = state();
    s.messages.push(user("u1", "q", 1.0));
    s.system_entries
        .push(entry("st", "u1", K::Status, "Status: requesting"));
    s.system_entries
        .push(entry("rm", "u1", K::SystemReminder, "reminder"));
    s.system_entries
        .push(entry("hk", "u1", K::HookStarted, "hook"));
    assert_eq!(keys(&rows(&s, &opts())), ["m:u1", "s:st", "s:rm", "s:hk"]);
    assert_eq!(keys(&rows(&s, &with(Verbose::Compact))), ["m:u1", "s:hk"]);
}

#[test]
fn the_working_row_closes_a_running_turn_unless_a_question_waits() {
    let mut s = state();
    s.messages.push(user("u1", "q", 1.0));
    s.system_entries.push(entry("p", "u1", K::Info, "x"));
    assert!(!keys(&rows(&s, &opts())).contains(&"working".to_owned()));
    s.pending = true;
    assert_eq!(keys(&rows(&s, &opts())), ["m:u1", "s:p", "working"]);
    s.stream_status = "reconnecting";
    assert_eq!(
        rows(&s, &opts()).rows.last(),
        Some(&Row::Working { disconnected: true })
    );
    s.pending_asks
        .push(Prompt(json!({"requestId": "r1", "toolUseId": "t1"})));
    assert_eq!(keys(&rows(&s, &opts())), ["m:u1", "s:p"]);
}

#[test]
fn the_working_row_stands_alone_when_the_level_hides_every_message() {
    let mut s = state();
    s.messages.push(assistant("a1", vec![thinking("hm")], 1.0));
    s.pending = true;
    assert_eq!(keys(&rows(&s, &opts())), ["working"]);
}

#[test]
fn the_latest_real_prompt_is_pinned_by_time_not_position() {
    let mut s = state();
    s.messages.push(user("newest", "latest", 30.0));
    s.messages.push(user("older", "first", 10.0));
    s.messages.push(user(
        "note",
        "<task-notification>x</task-notification>",
        40.0,
    ));
    let t = rows(&s, &opts());
    assert_eq!(t.last_user_uuid, "newest");
    assert!(the_user(&t, "newest").pinned);
    assert!(!the_user(&t, "older").pinned);
}

#[test]
fn prompts_sent_at_the_same_time_pin_the_later_one() {
    // `m.createdAt >= bestAt`: a tie goes to the later message.
    let mut s = state();
    s.messages.push(user("first", "one", 10.0));
    s.messages.push(user("second", "two", 10.0));
    let t = rows(&s, &opts());
    assert_eq!(t.last_user_uuid, "second");
    assert!(the_user(&t, "second").pinned);
    assert!(!the_user(&t, "first").pinned);
    // With no times at all, the last real prompt.
    let mut s = state();
    for (uuid, text) in [("a", "one"), ("b", "two")] {
        let mut m = user(uuid, text, 0.0);
        m.created_at = None;
        s.messages.push(m);
    }
    assert_eq!(rows(&s, &opts()).last_user_uuid, "b");
}

// ---- verbose levels --------------------------------------------------------

#[test]
fn normal_hides_thinking_and_compact_hides_tools_too() {
    let mut s = state();
    s.messages.push(assistant(
        "a",
        vec![
            thinking("hm"),
            B::text("t"),
            tool("1", "Bash", json!({}), None),
        ],
        1.0,
    ));
    let kinds = |o: &ViewOptions| -> Vec<&'static str> {
        the_assistant(&rows(&s, o), "a")
            .blocks
            .iter()
            .map(|b| match b {
                AssistantBlock::Text { .. } => "text",
                AssistantBlock::Thinking { .. } => "thinking",
                AssistantBlock::Tool(_) => "tool",
            })
            .collect()
    };
    assert_eq!(kinds(&opts()), ["text", "tool"]);
    assert_eq!(kinds(&with(Verbose::Compact)), ["text"]);
    assert_eq!(kinds(&with(Verbose::Verbose)), ["thinking", "text", "tool"]);
}

#[test]
fn ultra_compact_keeps_the_prompt_and_the_final_answer() {
    let mut s = state();
    s.messages.push(user("u", "q", 1.0));
    s.messages
        .push(assistant("a1", vec![B::text("first")], 2.0));
    s.messages
        .push(assistant("a2", vec![B::text("final")], 3.0));
    assert_eq!(
        keys(&rows(&s, &with(Verbose::UltraCompact))),
        ["m:u", "m:a2"]
    );
}

#[test]
fn ultra_verbose_opens_every_card_and_a_click_closes_one() {
    let mut s = state();
    s.messages.push(assistant(
        "a",
        vec![thinking("hm"), tool("1", "Bash", json!({}), None)],
        1.0,
    ));
    let open = |o: &ViewOptions| -> Vec<bool> {
        the_assistant(&rows(&s, o), "a")
            .blocks
            .iter()
            .map(|b| match b {
                AssistantBlock::Thinking { open, .. } => *open,
                AssistantBlock::Tool(t) => t.open,
                AssistantBlock::Text { .. } => false,
            })
            .collect()
    };
    assert_eq!(open(&with(Verbose::Verbose)), [false, false]);
    assert_eq!(open(&with(Verbose::UltraVerbose)), [true, true]);
    let mut o = toggled(&[Toggle::Thinking("a".into(), 0)]);
    o.verbose = Verbose::UltraVerbose;
    assert_eq!(open(&o), [false, true]);
    o.verbose = Verbose::Verbose;
    assert_eq!(open(&o), [true, false]);
}

// ---- UserMessage -----------------------------------------------------------

#[test]
fn a_prompt_renders_as_markdown_with_its_line_breaks_and_dollars_kept() {
    let mut s = state();
    s.messages
        .push(user("u", "line one\nline two costs $5", 1.0));
    let u = the_user(&rows(&s, &opts()), "u");
    assert_eq!(
        u.body,
        [UserSegment::Markdown {
            text: Arc::from("line one\\\nline two costs \\$5"),
            fold: Fold::Whole
        }]
    );
}

#[test]
fn a_prompt_with_an_attached_image_token_renders_as_plain_text() {
    let mut s = state();
    let mut m = user("u", "look [Image #1] here", 1.0);
    m.images = Some(vec![AttachedImage {
        id: "i".into(),
        ordinal: 1.0,
        data: String::new(),
        media_type: "image/png".into(),
    }]);
    s.messages.push(m);
    s.messages.push(user("typed", "literal [Image #9]", 2.0));
    let t = rows(&s, &opts());
    assert!(matches!(
        the_user(&t, "u").body[0],
        UserSegment::Plain { .. }
    ));
    assert!(matches!(
        the_user(&t, "typed").body[0],
        UserSegment::Markdown { .. }
    ));
}

#[test]
fn an_empty_prompt_is_an_empty_plain_body() {
    let mut s = state();
    s.messages.push(user("u", "", 1.0));
    let u = the_user(&rows(&s, &opts()), "u");
    assert_eq!(
        u.body,
        [UserSegment::Plain {
            text: Arc::from("")
        }]
    );
}

#[test]
fn bash_io_splits_into_terminal_blocks_that_start_open() {
    let mut s = state();
    s.messages.push(user(
        "u",
        "<bash-input>ls</bash-input><bash-stdout>a</bash-stdout><bash-stderr></bash-stderr>then this",
        1.0,
    ));
    let u = the_user(&rows(&s, &opts()), "u");
    assert_eq!(u.body.len(), 2);
    assert_eq!(
        u.body[0],
        UserSegment::Bash {
            command: "ls".into(),
            stdout: "a".into(),
            stderr: String::new(),
            open: true
        }
    );
    assert!(!u.pure_bash);
    let closed = rows(&s, &toggled(&[Toggle::Bash("u".into(), 0)]));
    assert!(matches!(
        the_user(&closed, "u").body[0],
        UserSegment::Bash { open: false, .. }
    ));
}

#[test]
fn a_pure_bash_echo_gets_no_badges() {
    let mut s = state();
    s.messages.push(user(
        "u",
        "<bash-input>ls</bash-input><bash-stdout></bash-stdout><bash-stderr></bash-stderr>",
        1.0,
    ));
    s.goal_uuids.insert("u".into());
    let u = the_user(&rows(&s, &opts()), "u");
    assert!(u.pure_bash);
    assert!(!u.goal_badge);
}

#[test]
fn the_goal_badge_wins_over_the_suggested_one() {
    let mut s = state();
    s.messages.push(user("g", "goal", 1.0));
    s.messages.push(user("sg", "chip", 2.0));
    s.goal_uuids.insert("g".into());
    s.suggested_uuids.insert("g".into());
    s.suggested_uuids.insert("sg".into());
    let t = rows(&s, &opts());
    let g = the_user(&t, "g");
    assert!(g.goal_badge && !g.suggested_badge);
    let sg = the_user(&t, "sg");
    assert!(!sg.goal_badge && sg.suggested_badge);
}

#[test]
fn a_peer_message_collapses_to_its_preview_until_clicked() {
    let mut s = state();
    let mut m = user("p", "\nhello from the other side\nsecond", 1.0);
    m.peer = Some(PeerInfo {
        from: "uds:/tmp/x".into(),
        name: Some("@ana".into()),
        pid: None,
        msg_id: None,
    });
    s.messages.push(m);
    let t = rows(&s, &opts());
    let p = the_user(&t, "p");
    assert_eq!(
        p.peer,
        Some(("Message from @ana: hello from the other side".into(), false))
    );
    assert!(p.body.is_empty() && !p.footer);
    let open = the_user(&rows(&s, &toggled(&[Toggle::Peer("p".into())])), "p");
    assert_eq!(open.peer.as_ref().map(|p| p.1), Some(true));
    assert_eq!(open.body.len(), 1);
    assert!(open.footer);
}

#[test]
fn a_peer_without_a_name_is_labelled_by_its_address() {
    let mut s = state();
    let mut m = user("p", "hi", 1.0);
    m.peer = Some(PeerInfo {
        from: "uds:/tmp/x".into(),
        name: None,
        pid: None,
        msg_id: None,
    });
    s.messages.push(m);
    let p = the_user(&rows(&s, &opts()), "p");
    assert_eq!(p.peer.unwrap().0, "Message from uds:/tmp/x: hi");
}

#[test]
fn a_prompt_not_yet_received_is_pending() {
    let mut s = state();
    let mut m = user("u", "x", 1.0);
    m.pending = Some(true);
    s.messages.push(m);
    assert!(the_user(&rows(&s, &opts()), "u").pending);
}

// ---- AssistantMessage ------------------------------------------------------

#[test]
fn a_streaming_reply_pulses_only_while_the_stream_is_up() {
    let mut s = state();
    let mut m = assistant("a", vec![B::text("partial")], 1.0);
    m.streaming = Some(true);
    s.messages.push(m);
    assert!(the_assistant(&rows(&s, &opts()), "a").streaming_live);
    s.stream_status = "reconnecting";
    assert!(!the_assistant(&rows(&s, &opts()), "a").streaming_live);
}

#[test]
fn an_error_frame_is_labelled_with_its_tag_and_an_interrupt_is_flagged() {
    let mut s = state();
    let mut m = assistant("a", vec![B::text("x")], 1.0);
    m.error_tag = Some("server_error".into());
    m.aborted = Some(true);
    s.messages.push(m);
    let a = the_assistant(&rows(&s, &opts()), "a");
    assert_eq!(a.error_label.as_deref(), Some("Error · server error"));
    assert!(a.aborted);
}

#[test]
fn thinking_says_encrypted_no_trace_or_streams() {
    let mut s = state();
    let mut streaming = assistant("live", vec![thinking("")], 1.0);
    streaming.streaming = Some(true);
    s.messages.push(streaming);
    s.messages.push(assistant(
        "done",
        vec![
            thinking("  "),
            B::Thinking {
                text: String::new(),
                redacted: Some(true),
            },
            thinking("real"),
        ],
        2.0,
    ));
    let t = rows(&s, &with(Verbose::Verbose));
    let got = |uuid: &str| -> Vec<(&'static str, ThinkingBody)> {
        the_assistant(&t, uuid)
            .blocks
            .into_iter()
            .filter_map(|b| match b {
                AssistantBlock::Thinking { label, body, .. } => Some((label, body)),
                _ => None,
            })
            .collect()
    };
    assert_eq!(
        got("live"),
        [("Thinking", ThinkingBody::Note("Streaming the reasoning…"))]
    );
    let done = got("done");
    assert_eq!(
        done[0],
        (
            "Thinking (no trace)",
            ThinkingBody::Note("No readable trace for this turn.")
        )
    );
    assert_eq!(done[1].0, "Thinking (encrypted)");
    assert_eq!(done[2], ("Thinking", ThinkingBody::Text(Arc::from("real"))));
}

#[test]
fn a_tool_call_is_one_row_with_its_status() {
    let mut s = state();
    let r = |is_error: Option<bool>, not_run: Option<bool>| ToolResult {
        content: "out".into(),
        is_error,
        not_run,
        ..Default::default()
    };
    s.messages.push(assistant(
        "a",
        vec![
            tool("1", "Bash", json!({"command": "ls -la"}), None),
            tool(
                "2",
                "Read",
                json!({"file_path": "/x.rs"}),
                Some(r(None, None)),
            ),
            tool("3", "Edit", json!({}), Some(r(Some(true), None))),
            tool("4", "Write", json!({}), Some(r(Some(true), Some(true)))),
            tool("5", "Agent", json!({"description": "look"}), None),
            tool("6", "Workflow", json!({}), None),
            tool("7", "ProposeGoal", json!({}), None),
        ],
        1.0,
    ));
    let tools: Vec<ToolRow> = the_assistant(&rows(&s, &opts()), "a")
        .blocks
        .into_iter()
        .filter_map(|b| match b {
            AssistantBlock::Tool(t) => Some(t),
            _ => None,
        })
        .collect();
    let status: Vec<ToolStatus> = tools.iter().map(|t| t.status).collect();
    assert_eq!(
        status[..4],
        [
            ToolStatus::Running,
            ToolStatus::Done,
            ToolStatus::Error,
            ToolStatus::NotRun
        ]
    );
    assert_eq!(tools[0].summary, "ls -la");
    assert_eq!(tools[1].summary, "/x.rs");
    let cards: Vec<ToolCard> = tools.iter().map(|t| t.card).collect();
    assert_eq!(
        cards[4..],
        [ToolCard::Task, ToolCard::Workflow, ToolCard::ProposeGoal]
    );
}

#[test]
fn the_live_question_hides_its_tool_row() {
    let mut s = state();
    s.messages.push(assistant(
        "a",
        vec![
            tool("ask-1", "AskUserQuestion", json!({}), None),
            tool("ask-0", "AskUserQuestion", json!({}), None),
        ],
        1.0,
    ));
    s.pending_asks
        .push(Prompt(json!({"requestId": "r", "toolUseId": "ask-1"})));
    let ids: Vec<String> = the_assistant(&rows(&s, &opts()), "a")
        .blocks
        .into_iter()
        .filter_map(|b| match b {
            AssistantBlock::Tool(t) => Some(t.id),
            _ => None,
        })
        .collect();
    assert_eq!(ids, ["ask-0"]);
}

#[test]
fn the_panels_under_a_reply_are_flagged() {
    let mut s = state();
    let mut m = assistant("a", vec![B::text("limit")], 1.0);
    m.rate_limit_hit = Some(Default::default());
    m.opus_high_demand = Some(true);
    s.messages.push(m);
    let a = the_assistant(&rows(&s, &opts()), "a");
    assert!(a.rate_limit_hit && a.opus_high_demand);
}

// ---- folding (native) ------------------------------------------------------

#[test]
fn long_text_folds_behind_show_more_until_expanded() {
    let mut s = state();
    let long = format!("intro\n```rust\n{}```\n", "let x = 1;\n".repeat(600));
    s.messages
        .push(assistant("a", vec![B::text(long.clone())], 1.0));
    let t = rows(&s, &opts());
    let AssistantBlock::Text { fold, text, .. } = &the_assistant(&t, "a").blocks[0] else {
        panic!("a text block")
    };
    assert_eq!(&**text, long.as_str());
    let Fold::Folded {
        shown,
        hidden_bytes,
    } = fold
    else {
        panic!("folded: {fold:?}")
    };
    assert!(shown.len() <= FOLD_BYTES + 4, "{}", shown.len());
    assert!(shown.ends_with("\n```"), "the open fence closes");
    assert_eq!(*hidden_bytes, long.len() - (shown.len() - 4));
    let open = rows(&s, &toggled(&[Toggle::Fold("a".into(), 0)]));
    assert!(matches!(
        the_assistant(&open, "a").blocks[0],
        AssistantBlock::Text {
            fold: Fold::Expanded,
            ..
        }
    ));
}

#[test]
fn a_streaming_reply_never_folds() {
    let mut s = state();
    let mut m = assistant("a", vec![B::text("x".repeat(FOLD_BYTES * 2))], 1.0);
    m.streaming = Some(true);
    s.messages.push(m);
    assert!(matches!(
        the_assistant(&rows(&s, &opts()), "a").blocks[0],
        AssistantBlock::Text {
            fold: Fold::Whole,
            ..
        }
    ));
}

#[test]
fn a_long_pasted_prompt_folds_too() {
    let mut s = state();
    s.messages.push(user("u", &"word ".repeat(2000), 1.0));
    assert!(matches!(
        the_user(&rows(&s, &opts()), "u").body[0],
        UserSegment::Markdown {
            fold: Fold::Folded { .. },
            ..
        }
    ));
}

#[test]
fn the_builder_keeps_unchanged_text_shared_between_builds() {
    let mut s = state();
    s.messages.push(assistant("a", vec![B::text("same")], 1.0));
    s.messages.push(assistant("b", vec![B::text("grows")], 2.0));
    let mut builder = RowBuilder::default();
    let text = |t: &Transcript, uuid: &str| match &the_assistant(t, uuid).blocks[0] {
        AssistantBlock::Text { text, .. } => text.clone(),
        _ => panic!(),
    };
    let first = builder.build(&s, &opts());
    s.messages[1].blocks[0] = B::text("grows more");
    let second = builder.build(&s, &opts());
    assert!(Arc::ptr_eq(&text(&first, "a"), &text(&second, "a")));
    assert_eq!(&*text(&second, "b"), "grows more");
}

fn arc_of(t: &Transcript, uuid: &str) -> Row {
    t.rows
        .iter()
        .find(|r| r.key() == format!("m:{uuid}"))
        .cloned()
        .expect("the row")
}

fn shared(a: &Row, b: &Row) -> bool {
    match (a, b) {
        (Row::User(x), Row::User(y)) => Arc::ptr_eq(x, y),
        (Row::Assistant(x), Row::Assistant(y)) => Arc::ptr_eq(x, y),
        _ => false,
    }
}

#[test]
fn an_unchanged_message_keeps_its_row_and_a_changed_one_is_rebuilt() {
    let mut s = state();
    s.messages.push(user("u", "hi", 1.0));
    s.messages.push(assistant("a", vec![B::text("same")], 2.0));
    s.messages.push(assistant("b", vec![B::text("grows")], 3.0));
    let mut builder = RowBuilder::default();
    let first = builder.build(&s, &opts());
    s.messages[2].blocks[0] = B::text("grows more");
    let second = builder.build(&s, &opts());
    assert!(shared(&arc_of(&first, "u"), &arc_of(&second, "u")));
    assert!(shared(&arc_of(&first, "a"), &arc_of(&second, "a")));
    assert!(!shared(&arc_of(&first, "b"), &arc_of(&second, "b")));
    assert_eq!(second, rows(&s, &opts()), "the same rows as a fresh build");
    // A message that moved (a new one in front) is found by its uuid.
    s.messages.insert(0, user("first", "earlier", 0.5));
    let third = builder.build(&s, &opts());
    assert!(shared(&arc_of(&second, "a"), &arc_of(&third, "a")));
    assert_eq!(third, rows(&s, &opts()));
}

#[test]
fn changed_options_or_session_inputs_rebuild_every_row() {
    let mut s = state();
    s.messages.push(user("u", "hi", 1.0));
    s.messages.push(assistant("a", vec![B::text("x")], 2.0));
    let mut builder = RowBuilder::default();
    let first = builder.build(&s, &opts());
    let second = builder.build(&s, &toggled(&[Toggle::Peer("zz".into())]));
    assert!(!shared(&arc_of(&first, "a"), &arc_of(&second, "a")));
    s.goal_uuids.insert("u".into());
    let opts2 = toggled(&[Toggle::Peer("zz".into())]);
    let third = builder.build(&s, &opts2);
    assert!(!shared(&arc_of(&second, "u"), &arc_of(&third, "u")));
    assert_eq!(third, rows(&s, &opts2));
    // A level that hides a message and shows it again rebuilds it.
    s.messages.push(assistant("t", vec![thinking("hmm")], 3.0));
    let normal = builder.build(&s, &opts2);
    assert!(!keys(&normal).contains(&"m:t".to_owned()));
    let mut v = opts2.clone();
    v.verbose = Verbose::Verbose;
    assert_eq!(builder.build(&s, &v), rows(&s, &v));
    assert_eq!(builder.build(&s, &opts2), rows(&s, &opts2));
}

#[test]
fn message_equality_walks_objects_in_order() {
    let a = json!({"file_path": "a.rs", "n": [1, {"x": 2}]});
    assert!(value_eq(&a, &a.clone()));
    assert!(!value_eq(
        &a,
        &json!({"file_path": "a.rs", "n": [1, {"x": 3}]})
    ));
    assert!(!value_eq(&a, &json!({"file_path": "a.rs"})));
    assert!(!value_eq(&json!([1, 2]), &json!([1, 2, 3])));
    // Reordered keys read as a change (a rebuild, never a stale row).
    assert!(!value_eq(
        &json!({"a": 1, "b": 2}),
        &json!({"b": 2, "a": 1})
    ));
    let t = |input: Value, result: Option<ToolResult>| tool("t1", "Read", input, result);
    let m = assistant("m", vec![t(a.clone(), None)], 1.0);
    let mut n = m.clone();
    assert!(message_eq(&m, &n));
    n.blocks[0] = t(a.clone(), Some(ToolResult::default()));
    assert!(!message_eq(&m, &n));
    let mut n = m.clone();
    n.aborted = Some(true);
    assert!(!message_eq(&m, &n));
    let mut n = m.clone();
    n.blocks.push(B::text("more"));
    assert!(!message_eq(&m, &n));
    let mut n = m.clone();
    n.blocks[0] = B::text("other");
    assert!(!message_eq(&m, &n));
}

// ---- SystemPill ------------------------------------------------------------

#[test]
fn a_plain_pill_shows_its_icon_count_over_one_and_detail() {
    let mut e = entry("p", "u", K::HookStarted, "Hook: PreToolUse");
    e.count = Some(1.0);
    e.detail = Some(String::new());
    assert_eq!(
        one_pill(e.clone()),
        Some(Pill::Plain {
            icon: "Webhook",
            icon_tone: Tone::Sky,
            row_tone: Tone::Muted,
            label: "Hook: PreToolUse".into(),
            count: None,
            detail: None,
        })
    );
    e.count = Some(3.0);
    e.detail = Some("ok".into());
    let Some(Pill::Plain { count, detail, .. }) = one_pill(e) else {
        panic!()
    };
    assert_eq!((count, detail.as_deref()), (Some(3.0), Some("ok")));
}

#[test]
fn notifications_take_their_priority_tone_and_info_lines_their_level() {
    let tone = |kind, priority: Option<&str>, level: Option<&str>| {
        let mut e = entry("p", "u", kind, "x");
        e.priority = priority.map(str::to_owned);
        e.info_level = level.map(str::to_owned);
        match one_pill(e) {
            Some(Pill::Plain {
                icon_tone,
                row_tone,
                ..
            }) => (icon_tone, row_tone),
            other => panic!("{other:?}"),
        }
    };
    assert_eq!(tone(K::Notification, Some("immediate"), None).0, Tone::Red);
    assert_eq!(tone(K::Notification, Some("high"), None).0, Tone::Amber);
    assert_eq!(tone(K::Notification, None, None).0, Tone::Muted);
    assert_eq!(tone(K::Info, None, Some("suggestion")).0, Tone::Sky);
    assert_eq!(
        tone(K::Info, None, Some("warning")),
        (Tone::Amber, Tone::Amber)
    );
}

#[test]
fn a_compaction_is_a_divider_with_its_stats_summary_and_where_earlier_turns_are() {
    let mut s = state();
    s.transcript_path = Some("/t/old.jsonl".into());
    s.messages.push(user("u", "hi", 1.0));
    let mut top = entry("c0", "", K::CompactBoundary, "Conversation compacted");
    top.compact_stats = Some(CompactStats {
        pre_tokens: Some(150000.0),
        post_tokens: Some(9000.0),
        duration_ms: Some(4200.0),
        trigger: None,
    });
    top.compact_summary = Some("the summary".into());
    let mut later = entry("c1", "u", K::CompactBoundary, "Conversation compacted");
    later.compact_summary = Some(String::new());
    s.system_entries.push(top);
    s.system_entries.push(later);
    let got = pills(&rows(&s, &toggled(&[Toggle::Pill("c0".into())])));
    assert_eq!(
        got[0],
        Pill::Compaction {
            label: "Conversation compacted".into(),
            stats: Some("150,000→9,000 tokens · 4s".into()),
            detail: None,
            summary: Some(Arc::from("the summary")),
            expanded: true,
            earlier_saved_in: Some("/t/old.jsonl".into()),
        }
    );
    let Pill::Compaction {
        summary,
        earlier_saved_in,
        ..
    } = &got[1]
    else {
        panic!()
    };
    assert_eq!((summary, earlier_saved_in), (&None, &None));
}

#[test]
fn a_conversation_reset_is_a_divider_with_its_time() {
    let mut e = entry("r", "u", K::ConversationReset, "Conversation reset");
    e.ts = Some("2026-11-26T10:00:00.000Z".into());
    assert_eq!(
        one_pill(e),
        Some(Pill::Reset {
            label: "Conversation reset".into(),
            detail: None,
            at_ms: Some(1_795_687_200_000.0),
        })
    );
}

#[test]
fn a_rate_limit_pill_shows_from_the_threshold_with_its_headline() {
    let pill = |status: &str, utilization: Option<f64>| {
        let mut e = entry("r", "u", K::RateLimit, "Rate limit");
        e.rate_limit = Some(RateLimitInfo {
            status: Some(status.into()),
            rate_limit_type: Some("five_hour".into()),
            utilization,
            resets_at: Some(5.0),
            ..Default::default()
        });
        one_pill(e)
    };
    assert_eq!(pill("allowed_warning", Some(0.49)), None);
    // `utilization * 100 >= thresholdPct`: the threshold itself shows.
    assert_eq!(
        pill("allowed_warning", Some(0.5)),
        Some(Pill::RateLimit {
            headline: "You've used 50% of your 5-hour limit".into(),
            tone: RateTone::Warning,
            resets_at: Some(5.0),
        })
    );
    assert_eq!(
        pill("allowed_warning", Some(0.874)),
        Some(Pill::RateLimit {
            headline: "You've used 87% of your 5-hour limit".into(),
            tone: RateTone::Warning,
            resets_at: Some(5.0),
        })
    );
    assert_eq!(
        pill("rejected", None),
        Some(Pill::RateLimit {
            headline: "You've hit your 5-hour limit".into(),
            tone: RateTone::Rejected,
            resets_at: Some(5.0),
        })
    );
    assert_eq!(pill("allowed", None), None);
    let mut plain = entry("r", "u", K::RateLimit, "Rate limit");
    plain.detail = Some("no info".into());
    assert!(matches!(one_pill(plain), Some(Pill::Plain { .. })));
}

#[test]
fn a_rejection_past_both_windows_waits_for_the_later_reset() {
    let mut e = entry("r", "u", K::RateLimit, "Rate limit");
    e.rate_limit = Some(RateLimitInfo {
        status: Some("rejected".into()),
        overage_status: Some("rejected".into()),
        resets_at: Some(10.0),
        overage_resets_at: Some(20.0),
        ..Default::default()
    });
    let Some(Pill::RateLimit {
        resets_at,
        headline,
        ..
    }) = one_pill(e)
    else {
        panic!()
    };
    assert_eq!(resets_at, Some(20.0));
    assert_eq!(headline, "You've hit your limit");
}

#[test]
fn a_system_reminder_collapses_under_its_title() {
    let mut e = entry("s", "u", K::SystemReminder, "System reminder");
    e.reminder_body = Some("The current to-do list is empty".into());
    assert_eq!(
        one_pill(e),
        Some(Pill::Reminder {
            title: "Todos snapshot",
            body: Arc::from("The current to-do list is empty"),
            expanded: false,
        })
    );
}

#[test]
fn a_failed_hook_is_red_with_its_stderr_and_a_passing_one_plain() {
    let mut e = entry("h", "u", K::HookResponse, "Hook failed: Stop");
    e.hook_failed = Some(true);
    e.hook_stderr = Some("exit 2\nboom".into());
    assert_eq!(
        one_pill(e.clone()),
        Some(Pill::HookFailure {
            label: "Hook failed: Stop".into(),
            detail: None,
            stderr: Some(Arc::from("exit 2\nboom")),
            expanded: false,
        })
    );
    e.hook_failed = None;
    assert!(matches!(
        one_pill(e),
        Some(Pill::Plain {
            icon: "CheckCircle2",
            ..
        })
    ));
}

#[test]
fn a_model_refusal_is_a_box_with_its_reason() {
    let mut e = entry("m", "u", K::ModelRefusal, "Claude declined");
    e.detail = Some("policy".into());
    assert_eq!(
        one_pill(e),
        Some(Pill::Refusal {
            label: "Claude declined".into(),
            detail: Some("policy".into()),
        })
    );
}

#[test]
fn every_kind_has_its_icon_and_tone() {
    use SystemEntryKind::*;
    let expect = [
        (Init, "Cpu", Tone::Emerald),
        (HookStarted, "Webhook", Tone::Sky),
        (HookResponse, "CheckCircle2", Tone::Sky),
        (Status, "Clock", Tone::Amber),
        (CompactBoundary, "GitMerge", Tone::Violet),
        (RateLimit, "AlertTriangle", Tone::Amber),
        (ApiRetry, "AlertTriangle", Tone::Amber),
        (PermissionDenied, "ShieldAlert", Tone::Red),
        (ModelFallback, "Cpu", Tone::Amber),
        (SystemReminder, "Bell", Tone::Muted),
        (ConversationReset, "Eraser", Tone::Violet),
        (Notification, "Bell", Tone::Muted),
        (ModelRefusal, "ShieldAlert", Tone::Red),
        (Info, "Info", Tone::Muted),
    ];
    for (kind, icon, tone) in expect {
        assert_eq!(kind_meta(kind), (icon, tone), "{kind:?}");
    }
}
