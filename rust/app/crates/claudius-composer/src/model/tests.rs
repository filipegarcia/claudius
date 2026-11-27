//! The composer's rules, one test each, named after the TS behavior.

use super::*;
use crate::rules::SentPrompt;

fn view(pending: bool) -> SessionView {
    SessionView {
        session_id: Some("s1".into()),
        ready: true,
        pending,
        ..SessionView::default()
    }
}

fn ok(body: &str) -> FetchOutcome {
    FetchOutcome::Response {
        status: 200,
        body: body.into(),
    }
}

fn reqs(outs: &[Out]) -> Vec<&FetchRequest> {
    outs.iter()
        .filter_map(|o| match o {
            Out::Fetch(r) => Some(r),
            _ => None,
        })
        .collect()
}

fn calls(outs: &[Out]) -> Vec<&SessionCall> {
    outs.iter()
        .filter_map(|o| match o {
            Out::Call { call, .. } => Some(call),
            _ => None,
        })
        .collect()
}

fn token(outs: &[Out]) -> u64 {
    outs.iter()
        .find_map(|o| match o {
            Out::Call { token: Some(t), .. } => Some(*t),
            _ => None,
        })
        .expect("a tokened call")
}

fn timer(outs: &[Out]) -> TimerId {
    outs.iter()
        .find_map(|o| match o {
            Out::SetTimer { id, .. } => Some(*id),
            _ => None,
        })
        .expect("a timer")
}

/// Bound to `id` with its draft seeded to `text` and no color.
fn seeded_to(id: &str, text: &str) -> Composer {
    let mut c = Composer::new();
    seed(&mut c, id, text);
    c
}

fn seed(c: &mut Composer, id: &str, text: &str) -> Vec<Out> {
    let outs = c.bind(Some(id));
    let r = reqs(&outs);
    let seed_id = r
        .iter()
        .find(|r| r.url.ends_with("/prompt-draft") && r.method == "GET")
        .map(|r| r.id);
    let color_id = r
        .iter()
        .find(|r| r.url.ends_with("/prompt-color"))
        .map(|r| r.id);
    let mut all = outs.clone();
    if let Some(s) = seed_id {
        all.extend(c.fetch_settled(s, &ok(&json!({"text": text, "images": []}).to_string())));
    }
    if let Some(col) = color_id {
        all.extend(c.fetch_settled(col, &ok(r#"{"color":null}"#)));
    }
    all
}

fn seeded() -> Composer {
    seeded_to("s1", "")
}

fn typed(c: &mut Composer, text: &str) -> Vec<Out> {
    c.edited(text, text.len(), false)
}

fn press(c: &mut Composer, k: Key, v: &SessionView) -> KeyOutcome {
    let n = c.value().len();
    c.key(&k, Selection { start: n, end: n }, v, 10_000.0, false)
}

fn enter() -> Key {
    Key::named("Enter")
}

fn with(key: &str, f: impl FnOnce(&mut Key)) -> Key {
    let mut k = Key::named(key);
    f(&mut k);
    k
}

fn sent_text(outs: &[Out]) -> Option<String> {
    calls(outs).into_iter().find_map(|c| match c {
        SessionCall::Send { text, .. } => Some(text.clone()),
        _ => None,
    })
}

// ------------------------------------------------------------ drafts

#[test]
fn bind_seeds_the_draft_then_loads_the_color() {
    let mut c = Composer::new();
    let outs = c.bind(Some("s1"));
    let r = reqs(&outs);
    // ... and the slash picker's command list (`useSdkCommands`).
    assert_eq!(r.len(), 3);
    assert_eq!(
        (r[2].method, r[2].url.as_str()),
        ("GET", "/api/sessions/s1/commands")
    );
    assert_eq!(
        (r[0].method, r[0].url.as_str()),
        ("GET", "/api/sessions/s1/prompt-draft")
    );
    assert_eq!(
        (r[1].method, r[1].url.as_str()),
        ("GET", "/api/sessions/s1/prompt-color")
    );
    let rev = c.text_rev();
    c.fetch_settled(r[0].id, &ok(r#"{"text":"saved","images":[]}"#));
    assert_eq!(c.value(), "saved");
    assert!(c.text_rev() > rev);
    c.fetch_settled(r[1].id, &ok(r#"{"color":"red"}"#));
    assert_eq!(c.prompt_color(), Some(PromptColor::Red));
}

#[test]
fn bind_to_the_same_session_is_a_no_op() {
    let mut c = seeded();
    assert!(c.bind(Some("s1")).is_empty());
}

#[test]
fn seed_does_not_clobber_typing_that_beat_it() {
    let mut c = Composer::new();
    let outs = c.bind(Some("s1"));
    typed(&mut c, "mine");
    c.fetch_settled(reqs(&outs)[0].id, &ok(r#"{"text":"old"}"#));
    assert_eq!(c.value(), "mine");
    // ... and the session counts as seeded: the next edit saves.
    let outs = typed(&mut c, "mine!");
    assert!(
        outs.iter()
            .any(|o| matches!(o, Out::SetTimer { ms, .. } if *ms == DRAFT_SAVE_MS))
    );
}

#[test]
fn seed_failure_still_opens_saving() {
    let mut c = Composer::new();
    let outs = c.bind(Some("s1"));
    c.fetch_settled(reqs(&outs)[0].id, &FetchOutcome::Failed("down".into()));
    assert_eq!(c.value(), "");
    assert!(c.has_pending_draft() || !typed(&mut c, "x").is_empty());
    assert!(c.has_pending_draft());
}

#[test]
fn late_seed_for_a_session_switched_away_is_dropped() {
    let mut c = Composer::new();
    let a = c.bind(Some("a"));
    c.bind(Some("b"));
    let outs = c.fetch_settled(reqs(&a)[0].id, &ok(r#"{"text":"from a"}"#));
    assert!(outs.is_empty());
    assert_eq!(c.value(), "");
}

#[test]
fn debounced_save_puts_the_draft_after_500ms() {
    let mut c = seeded();
    let outs = typed(&mut c, "hello");
    let t = timer(&outs);
    assert!(c.has_pending_draft());
    let outs = c.timer_fired(t);
    let r = reqs(&outs);
    assert_eq!(
        (r[0].method, r[0].url.as_str()),
        ("PUT", "/api/sessions/s1/prompt-draft")
    );
    assert_eq!(
        r[0].body.as_deref(),
        Some(r#"{"text":"hello","images":[]}"#)
    );
    assert_eq!(r[0].headers, vec![("Content-Type", "application/json")]);
    assert!(!c.has_pending_draft());
}

#[test]
fn each_edit_restarts_the_save_debounce() {
    let mut c = seeded();
    let first = timer(&typed(&mut c, "a"));
    let outs = typed(&mut c, "ab");
    assert!(outs.contains(&Out::ClearTimer { id: first }));
    assert!(c.timer_fired(first).is_empty());
}

#[test]
fn seed_guard_keeps_an_untouched_empty_draft_from_echoing() {
    let mut c = Composer::new();
    let outs = seed(&mut c, "s1", "");
    assert!(!outs.iter().any(|o| matches!(o, Out::SetTimer { .. })));
}

#[test]
fn switching_sessions_flushes_the_pending_draft_to_its_own_session() {
    let mut c = seeded_to("a", "");
    typed(&mut c, "unsaved");
    let outs = c.bind(Some("b"));
    let r = reqs(&outs);
    assert_eq!(
        (r[0].method, r[0].url.as_str()),
        ("PUT", "/api/sessions/a/prompt-draft")
    );
    assert_eq!(
        r[0].body.as_deref(),
        Some(r#"{"text":"unsaved","images":[]}"#)
    );
    assert_eq!(r[1].url, "/api/sessions/b/prompt-draft");
    // The old text is not saved under the new session.
    assert!(!outs.iter().any(|o| matches!(o, Out::SetTimer { .. })));
}

#[test]
fn unmount_flushes_with_keepalive_when_unloading() {
    let mut c = seeded();
    typed(&mut c, "bye");
    let outs = c.unmount(true);
    assert_eq!(reqs(&outs)[0].method, "PUT");
    assert!(!c.has_pending_draft());
}

#[test]
fn injection_before_the_first_seed_counts_as_typed() {
    let mut c = Composer::new();
    c.inject("prefill", vec![], false);
    let outs = c.bind(Some("s1"));
    c.fetch_settled(reqs(&outs)[0].id, &ok(r#"{"text":""}"#));
    assert_eq!(c.value(), "prefill");
}

// ------------------------------------------------------------- keys

#[test]
fn enter_sends_the_trimmed_prompt_and_clears_the_box() {
    let mut c = seeded();
    typed(&mut c, "  hi there \n");
    let o = press(&mut c, enter(), &view(false));
    assert!(o.handled);
    assert_eq!(sent_text(&o.out).as_deref(), Some("hi there"));
    let Some(SessionCall::Send { opts, .. }) = calls(&o.out).first().copied() else {
        panic!("a send")
    };
    assert!(opts.reports_failure_inline && !opts.from_suggestion);
    assert_eq!(c.value(), "");
    // The draft row goes with it.
    assert!(reqs(&o.out).iter().any(|r| r.method == "DELETE"));
    assert!(!c.has_pending_draft());
}

#[test]
fn shift_enter_falls_through_to_a_newline() {
    let mut c = seeded();
    typed(&mut c, "line");
    let o = press(&mut c, with("Enter", |k| k.shift = true), &view(false));
    assert!(!o.handled);
    assert!(o.out.is_empty());
    assert_eq!(c.value(), "line");
}

#[test]
fn enter_while_a_turn_runs_still_sends_and_the_session_queues_it() {
    let mut c = seeded();
    typed(&mut c, "follow-up");
    let o = press(&mut c, enter(), &view(true));
    assert_eq!(sent_text(&o.out).as_deref(), Some("follow-up"));
}

#[test]
fn enter_on_an_empty_box_sends_the_first_queued_message_now() {
    let mut c = seeded();
    let mut v = view(true);
    v.queue = vec![
        QueuedRow {
            id: "q1".into(),
            text: "first".into(),
        },
        QueuedRow {
            id: "q2".into(),
            text: "second".into(),
        },
    ];
    let o = press(&mut c, enter(), &v);
    assert!(o.handled);
    assert_eq!(
        calls(&o.out),
        vec![&SessionCall::SendQueuedNow { qid: "q1".into() }]
    );
}

#[test]
fn enter_on_an_empty_box_with_no_queue_sends_nothing() {
    let mut c = seeded();
    let o = press(&mut c, enter(), &view(false));
    assert!(o.handled);
    assert!(calls(&o.out).is_empty());
}

#[test]
fn enter_continues_a_list_item() {
    let mut c = seeded();
    typed(&mut c, "- one");
    let o = press(&mut c, enter(), &view(false));
    assert!(o.handled);
    assert!(calls(&o.out).is_empty());
    assert_eq!(c.value(), "- one\n- ");
    assert_eq!(c.caret(), c.value().len());
    // Enter on the empty item clears its marker.
    press(&mut c, enter(), &view(false));
    assert_eq!(c.value(), "- one\n");
}

#[test]
fn shift_enter_also_continues_a_list() {
    let mut c = seeded();
    typed(&mut c, "1. a");
    let o = press(&mut c, with("Enter", |k| k.shift = true), &view(false));
    assert!(o.handled);
    assert_eq!(c.value(), "1. a\n2. ");
}

#[test]
fn ctrl_enter_sends_every_queued_message_now() {
    let mut c = seeded();
    typed(&mut c, "draft");
    let o = press(&mut c, with("Enter", |k| k.ctrl = true), &view(true));
    assert!(o.handled);
    assert_eq!(calls(&o.out), vec![&SessionCall::SendAllQueuedNow]);
    assert_eq!(c.value(), "draft");
}

#[test]
fn ctrl_c_interrupts_a_running_turn() {
    let mut c = seeded();
    typed(&mut c, "keep");
    let k = with("c", |k| {
        k.ctrl = true;
        k.code = "KeyC".into();
    });
    let o = press(&mut c, k, &view(true));
    assert!(o.handled);
    assert_eq!(calls(&o.out), vec![&SessionCall::Interrupt]);
    assert_eq!(c.value(), "keep");
}

#[test]
fn ctrl_c_when_idle_clears_and_up_restores() {
    let mut c = seeded();
    typed(&mut c, "oops");
    let k = with("c", |k| k.ctrl = true);
    let o = press(&mut c, k, &view(false));
    assert!(o.handled);
    assert_eq!(c.value(), "");
    assert!(reqs(&o.out).iter().any(|r| r.method == "DELETE"));
    let o = press(&mut c, Key::named("ArrowUp"), &view(false));
    assert!(o.handled);
    assert_eq!(c.value(), "oops");
}

#[test]
fn ctrl_c_with_a_selection_is_left_to_copy() {
    let mut c = seeded();
    typed(&mut c, "copy me");
    let o = c.key(
        &with("c", |k| k.ctrl = true),
        Selection { start: 0, end: 4 },
        &view(false),
        0.0,
        false,
    );
    assert!(!o.handled);
    assert_eq!(c.value(), "copy me");
}

#[test]
fn double_escape_clears_within_500ms() {
    let mut c = seeded();
    typed(&mut c, "draft");
    let v = view(false);
    let esc = Key::named("Escape");
    let sel = Selection { start: 5, end: 5 };
    assert!(!c.key(&esc, sel, &v, 1_000.0, false).handled);
    assert!(!c.key(&esc, sel, &v, 1_600.0, false).handled);
    assert_eq!(c.value(), "draft");
    assert!(c.key(&esc, sel, &v, 1_800.0, false).handled);
    assert_eq!(c.value(), "");
}

#[test]
fn keys_during_ime_composition_are_left_to_the_ime() {
    let mut c = seeded();
    typed(&mut c, "x");
    let o = c.key(
        &enter(),
        Selection { start: 1, end: 1 },
        &view(false),
        0.0,
        true,
    );
    assert_eq!(o, KeyOutcome::default());
}

#[test]
fn tab_outside_a_list_moves_focus() {
    let mut c = seeded();
    typed(&mut c, "plain");
    let o = press(&mut c, Key::named("Tab"), &view(false));
    assert_eq!((o.handled, o.move_focus), (true, Some(true)));
    let o = press(&mut c, with("Tab", |k| k.shift = true), &view(false));
    assert_eq!(o.move_focus, Some(false));
}

#[test]
fn tab_indents_and_shift_tab_outdents_a_list_item() {
    let mut c = seeded();
    typed(&mut c, "- a");
    press(&mut c, Key::named("Tab"), &view(false));
    assert_eq!(c.value(), "  - a");
    assert_eq!(c.caret(), 5);
    press(&mut c, with("Tab", |k| k.shift = true), &view(false));
    assert_eq!(c.value(), "- a");
    assert_eq!(c.caret(), 3);
}

// --------------------------------------------------------- history

fn history_view(prompts: &[&str]) -> SessionView {
    SessionView {
        sent: prompts
            .iter()
            .map(|t| SentPrompt {
                text: (*t).into(),
                at: None,
            })
            .collect(),
        ..view(false)
    }
}

#[test]
fn cmd_up_recalls_history_and_cmd_down_returns_to_the_draft() {
    let mut c = seeded();
    let v = history_view(&["first", "second"]);
    typed(&mut c, "wip");
    let up = with("ArrowUp", |k| k.meta = true);
    let down = with("ArrowDown", |k| k.meta = true);
    assert!(press(&mut c, up.clone(), &v).handled);
    assert_eq!(c.value(), "second");
    press(&mut c, up.clone(), &v);
    assert_eq!(c.value(), "first");
    // At the oldest: still taken, nothing moves.
    assert!(press(&mut c, up, &v).handled);
    assert_eq!(c.value(), "first");
    press(&mut c, down.clone(), &v);
    assert_eq!(c.value(), "second");
    press(&mut c, down.clone(), &v);
    assert_eq!(c.value(), "wip");
    assert!(!press(&mut c, down, &v).handled);
}

#[test]
fn ctrl_up_recalls_history_too() {
    let mut c = seeded();
    let v = history_view(&["only"]);
    assert!(press(&mut c, with("ArrowUp", |k| k.ctrl = true), &v).handled);
    assert_eq!(c.value(), "only");
}

#[test]
fn history_recall_skips_the_entry_the_draft_already_holds() {
    let mut c = seeded();
    let v = history_view(&["a", "b"]);
    typed(&mut c, "b");
    press(&mut c, with("ArrowUp", |k| k.meta = true), &v);
    assert_eq!(c.value(), "a");
}

#[test]
fn history_with_nothing_sent_lets_the_key_through() {
    let mut c = seeded();
    assert!(!press(&mut c, with("ArrowUp", |k| k.meta = true), &view(false)).handled);
}

#[test]
fn typing_ends_a_history_walk() {
    let mut c = seeded();
    let v = history_view(&["a", "b"]);
    press(&mut c, with("ArrowUp", |k| k.meta = true), &v);
    typed(&mut c, "b!");
    // A fresh walk starts from the newest again.
    press(&mut c, with("ArrowUp", |k| k.meta = true), &v);
    assert_eq!(c.value(), "b");
}

#[test]
fn plain_up_with_no_stash_is_the_editor_s() {
    let mut c = seeded();
    assert!(!press(&mut c, Key::named("ArrowUp"), &view(false)).handled);
}

#[test]
fn a_switch_drops_the_cleared_draft_stash() {
    let mut c = seeded_to("a", "");
    typed(&mut c, "x");
    press(&mut c, with("c", |k| k.ctrl = true), &view(false));
    seed(&mut c, "b", "");
    assert!(!press(&mut c, Key::named("ArrowUp"), &view(false)).handled);
}

// ------------------------------------------------------------- send

#[test]
fn send_converts_bullets_to_markdown_on_the_wire() {
    let mut c = seeded();
    typed(&mut c, "\u{2022} a\n\u{2022} b");
    let o = press(&mut c, enter(), &view(false));
    // The last line is a list item: Enter continues it instead.
    assert!(calls(&o.out).is_empty());
    let outs = c.submit(&view(false));
    // Trimmed first: the last marker lost its space, so it stays a glyph.
    assert_eq!(sent_text(&outs).as_deref(), Some("* a\n* b\n\u{2022}"));
}

#[test]
fn star_space_at_a_line_start_becomes_a_bullet() {
    let mut c = seeded();
    typed(&mut c, "*");
    let rev = c.text_rev();
    c.edited("* ", 2, false);
    assert_eq!(c.value(), "\u{2022} ");
    assert_eq!(c.caret(), "\u{2022} ".len());
    assert!(c.text_rev() > rev);
    // Not mid-line.
    typed(&mut c, "x *");
    c.edited("x * ", 4, false);
    assert_eq!(c.value(), "x * ");
}

#[test]
fn send_disabled_blocks_submit() {
    let mut c = seeded();
    typed(&mut c, "x");
    let v = SessionView {
        send_disabled: true,
        ..view(false)
    };
    assert!(c.submit(&v).is_empty());
    assert!(c.send_button_disabled(&v));
    assert_eq!(c.value(), "x");
}

#[test]
fn send_button_disabled_on_a_blank_box_or_before_ready() {
    let mut c = seeded();
    assert!(c.send_button_disabled(&view(false)));
    typed(&mut c, "  ");
    assert!(c.send_button_disabled(&view(false)));
    typed(&mut c, "x");
    assert!(!c.send_button_disabled(&view(false)));
    let starting = SessionView {
        ready: false,
        ..view(false)
    };
    assert!(c.send_button_disabled(&starting));
    assert!(c.input_disabled(&starting));
}

#[test]
fn invisible_characters_are_stripped_and_noted() {
    let mut c = seeded();
    typed(&mut c, "hi\u{200b}");
    let outs = c.submit(&view(false));
    assert_eq!(sent_text(&outs).as_deref(), Some("hi"));
    assert_eq!(
        c.invisible_notice(),
        Some("Removed 1 hidden character from your prompt")
    );
    let notice = outs
        .iter()
        .find_map(|o| match o {
            Out::SetTimer { id, ms } if *ms == NOTICE_MS => Some(*id),
            _ => None,
        })
        .unwrap();
    c.timer_fired(notice);
    assert_eq!(c.invisible_notice(), None);
}

#[test]
fn bidi_controls_hold_the_send_for_review() {
    let mut c = seeded();
    typed(&mut c, "a\u{202e}b");
    let outs = c.submit(&view(false));
    assert!(calls(&outs).is_empty());
    assert_eq!(c.value(), "ab");
    assert!(outs.contains(&Out::Notice(
        "Removed 1 hidden character from your prompt \u{2014} review and press Send again.".into()
    )));
}

#[test]
fn undelivered_send_returns_to_an_empty_box() {
    let mut c = seeded();
    typed(&mut c, "lost");
    let outs = c.submit(&view(false));
    c.call_resolved(
        token(&outs),
        Some(json!({"ok": false, "error": "network"})),
        0.0,
    );
    assert_eq!(c.value(), "lost");
    assert_eq!(
        c.send_failed_notice(),
        Some("Couldn't reach Claudius \u{2014} your message is back in the box.")
    );
    // Typing clears the notice.
    typed(&mut c, "lost!");
    assert_eq!(c.send_failed_notice(), None);
}

#[test]
fn undelivered_send_is_stashed_when_the_box_was_reused() {
    let mut c = seeded();
    typed(&mut c, "lost");
    let outs = c.submit(&view(false));
    typed(&mut c, "new text");
    c.call_resolved(token(&outs), None, 0.0);
    assert_eq!(c.value(), "new text");
    assert_eq!(
        c.send_failed_notice(),
        Some("Message not sent \u{2014} press \u{2191} in an empty box to get it back.")
    );
    c.edited("", 0, false);
    assert!(press(&mut c, Key::named("ArrowUp"), &view(false)).handled);
    assert_eq!(c.value(), "lost");
}

#[test]
fn undelivered_send_from_another_session_merges_into_its_draft() {
    let mut c = seeded_to("a", "");
    typed(&mut c, "for a");
    let outs = c.submit(&view(false));
    seed(&mut c, "b", "");
    let outs = c.call_resolved(token(&outs), Some(json!(false)), 0.0);
    let r = reqs(&outs);
    assert_eq!(
        (r[0].method, r[0].url.as_str()),
        ("GET", "/api/sessions/a/prompt-draft")
    );
    let outs = c.fetch_settled(r[0].id, &ok(r#"{"text":"draft a","images":[]}"#));
    let put = reqs(&outs)[0];
    assert_eq!(
        (put.method, put.url.as_str()),
        ("PUT", "/api/sessions/a/prompt-draft")
    );
    assert_eq!(
        put.body.as_deref(),
        Some(r#"{"text":"draft a\nfor a","images":[]}"#)
    );
    assert_eq!(c.value(), "");
}

#[test]
fn delivered_send_leaves_the_box_alone() {
    let mut c = seeded();
    typed(&mut c, "ok");
    let outs = c.submit(&view(false));
    c.call_resolved(token(&outs), Some(json!({"ok": true})), 0.0);
    assert_eq!(c.value(), "");
    assert_eq!(c.send_failed_notice(), None);
}

// -------------------------------------------------------------- bash

#[test]
fn bang_prefix_is_bash_mode() {
    let mut c = seeded();
    typed(&mut c, "!ls");
    assert!(c.is_bash_mode());
    assert_eq!(c.hint(), None);
}

#[test]
fn bash_submit_posts_the_command_and_disables_the_box() {
    let mut c = seeded_to("s/1", "");
    typed(&mut c, "! ls -la ");
    let outs = c.submit(&view(false));
    assert!(calls(&outs).is_empty());
    let post = reqs(&outs)
        .into_iter()
        .find(|r| r.method == "POST")
        .unwrap();
    assert_eq!(post.url, "/api/sessions/s%2F1/bash");
    assert_eq!(post.body.as_deref(), Some(r#"{"command":"ls -la"}"#));
    // The draft row goes with the command.
    assert!(
        reqs(&outs)
            .iter()
            .any(|r| r.method == "DELETE" && r.url == "/api/sessions/s/1/prompt-draft")
    );
    assert!(c.bash_running());
    assert!(c.input_disabled(&view(false)));
    assert_eq!(c.value(), "");
    let id = post.id;
    c.fetch_settled(id, &ok(r#"{"exitCode":0}"#));
    assert!(!c.bash_running());
}

#[test]
fn bash_sudo_asks_for_the_password_first() {
    let mut c = seeded();
    typed(&mut c, "!sudo whoami");
    let outs = c.submit(&view(false));
    assert!(reqs(&outs).iter().all(|r| r.method != "POST"));
    assert_eq!(c.sudo_prompt(), Some("sudo whoami"));
    assert_eq!(c.value(), "!sudo whoami");
    assert!(c.sudo_submit("").is_empty());
    let outs = c.sudo_submit("hunter2");
    let post = reqs(&outs)
        .into_iter()
        .find(|r| r.method == "POST")
        .unwrap();
    assert_eq!(
        post.body.as_deref(),
        Some(r#"{"command":"sudo whoami","sudoPassword":"hunter2"}"#)
    );
    assert_eq!(c.sudo_prompt(), None);
}

#[test]
fn bash_sudo_cancel_keeps_the_command() {
    let mut c = seeded();
    typed(&mut c, "!sudo ls");
    c.submit(&view(false));
    c.sudo_cancel();
    assert_eq!(c.sudo_prompt(), None);
    assert_eq!(c.value(), "!sudo ls");
}

#[test]
fn bash_with_an_empty_command_does_nothing() {
    let mut c = seeded();
    typed(&mut c, "!   ");
    assert!(reqs(&c.submit(&view(false))).is_empty());
    assert!(!c.bash_running());
}

// ------------------------------------------------------ queue strip

#[test]
fn queue_strip_actions_call_the_session() {
    let mut c = seeded();
    assert_eq!(
        calls(&c.queue_move("q", -1.0)),
        vec![&SessionCall::ReorderQueued {
            qid: "q".into(),
            dir: -1.0
        }]
    );
    assert_eq!(
        calls(&c.queue_send_now("q")),
        vec![&SessionCall::SendQueuedNow { qid: "q".into() }]
    );
    assert_eq!(
        calls(&c.queue_send_all()),
        vec![&SessionCall::SendAllQueuedNow]
    );
    assert_eq!(
        calls(&c.queue_remove("q")),
        vec![&SessionCall::CancelQueued { qid: "q".into() }]
    );
    assert_eq!(calls(&c.interrupt()), vec![&SessionCall::Interrupt]);
}

#[test]
fn queue_edit_lifts_the_message_into_the_box_and_history() {
    let mut c = seeded();
    typed(&mut c, "wip");
    let outs = c.queue_edit("q1");
    assert_eq!(
        calls(&outs),
        vec![&SessionCall::EditQueued { qid: "q1".into() }]
    );
    c.call_resolved(token(&outs), Some(json!({"text": "lifted"})), 5.0);
    assert_eq!(c.value(), "lifted");
    assert_eq!(c.history(&view(false)), vec!["lifted".to_owned()]);
    // The replaced draft is one ↑ away once the box is empty.
    c.edited("", 0, false);
    assert!(press(&mut c, Key::named("ArrowUp"), &view(false)).handled);
    assert_eq!(c.value(), "wip");
}

#[test]
fn queue_edit_of_a_message_already_gone_changes_nothing() {
    let mut c = seeded();
    typed(&mut c, "wip");
    let outs = c.queue_edit("q1");
    c.call_resolved(token(&outs), Some(Value::Null), 5.0);
    assert_eq!(c.value(), "wip");
}

#[test]
fn suggestion_pick_sends_from_suggestion_and_leaves_the_box() {
    let mut c = seeded();
    typed(&mut c, "mine");
    let outs = c.pick_suggestion("Run the tests");
    let Some(SessionCall::Send { text, opts, .. }) = calls(&outs).first().copied() else {
        panic!("a send")
    };
    assert_eq!(text, "Run the tests");
    assert!(opts.from_suggestion);
    assert_eq!(c.value(), "mine");
}

// -------------------------------------------------------- the rest

#[test]
fn keyword_hint_can_be_ignored_and_undone() {
    let mut c = seeded();
    typed(&mut c, "run a workflow");
    assert_eq!(c.hint().map(|h| h.1), Some(rules::HintState::Active));
    c.dismiss_hint();
    assert_eq!(c.hint().map(|h| h.1), Some(rules::HintState::Ignored));
    c.restore_hint();
    assert_eq!(c.hint().map(|h| h.1), Some(rules::HintState::Active));
    c.dismiss_hint();
    c.submit(&view(false));
    typed(&mut c, "another workflow");
    assert_eq!(c.hint().map(|h| h.1), Some(rules::HintState::Active));
}

#[test]
fn prompt_color_is_per_session() {
    let mut c = seeded_to("a", "");
    c.set_prompt_color(Some(PromptColor::Blue));
    assert_eq!(c.prompt_color(), Some(PromptColor::Blue));
    seed(&mut c, "b", "");
    assert_eq!(c.prompt_color(), None);
}

#[test]
fn deleting_an_image_token_drops_its_image() {
    let mut c = seeded();
    let img = AttachedImage {
        id: "i".into(),
        ordinal: 1.0,
        data: "AAAA".into(),
        media_type: "image/png".into(),
    };
    c.inject("see [Image #1] here", vec![img], false);
    assert_eq!(c.images().len(), 1);
    c.edited("see [Image #1 here", 13, false);
    assert!(c.images().is_empty());
    assert_eq!(c.value(), "see ");
}

#[test]
fn session_view_reads_the_chat_state() {
    let mut s = ChatState::new("tab");
    s.session_id = Some("x".into());
    s.ready = true;
    s.pending = true;
    s.queue = vec![json!({"id": "q", "text": "later", "flags": {}})];
    s.sdk_queued_turns = json!(2);
    s.prompt_suggestions = vec!["next?".into()];
    let v = SessionView::of(&s);
    assert_eq!(v.session_id.as_deref(), Some("x"));
    assert!(v.ready && v.pending && !v.send_disabled);
    assert_eq!(
        v.queue,
        vec![QueuedRow {
            id: "q".into(),
            text: "later".into()
        }]
    );
    assert_eq!(v.sdk_queued_turns, 2.0);
    assert_eq!(v.suggestions, vec!["next?".to_owned()]);
}
