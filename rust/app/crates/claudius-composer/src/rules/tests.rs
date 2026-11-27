//! One test per ported rule, named after it. The golden replay
//! (`tests/composer_rules_golden.rs`) checks the same functions against
//! the real TS on a wider table.

use super::*;

fn img(id: &str, ordinal: f64) -> AttachedImage {
    AttachedImage {
        id: id.into(),
        ordinal,
        data: "AAAA".into(),
        media_type: "image/png".into(),
    }
}

fn sent(text: &str, at: Option<f64>) -> SentPrompt {
    SentPrompt {
        text: text.into(),
        at,
    }
}

fn lifted(text: &str, at: f64) -> LiftedPrompt {
    LiftedPrompt {
        text: text.into(),
        at,
    }
}

fn strs(v: &[&str]) -> Vec<String> {
    v.iter().map(|s| (*s).to_owned()).collect()
}

#[test]
fn utf16_len_counts_code_units() {
    assert_eq!(utf16_len("abc"), 3);
    assert_eq!(utf16_len("\u{e9}"), 1);
    assert_eq!(utf16_len("\u{1f600}"), 2);
}

#[test]
fn is_js_space_matches_js_backslash_s() {
    for c in [
        ' ', '\t', '\n', '\r', '\u{a0}', '\u{2028}', '\u{3000}', '\u{feff}',
    ] {
        assert!(is_js_space(c), "{c:?}");
    }
    for c in ['a', '\u{85}', '\u{200b}', '_'] {
        assert!(!is_js_space(c), "{c:?}");
    }
}

#[test]
fn normalize_history_text_drops_image_tokens_and_collapses_spaces() {
    assert_eq!(
        normalize_history_text("  look [Image #1]  here [Image #12] "),
        "look here"
    );
    assert_eq!(
        normalize_history_text("[Image #] [Image #x] keep"),
        "[Image #] [Image #x] keep"
    );
    assert_eq!(normalize_history_text("a\t\tb"), "a\t\tb");
    assert_eq!(normalize_history_text("[Image #3]"), "");
}

#[test]
fn build_prompt_history_slots_lifts_before_the_next_dated_send() {
    let h = build_prompt_history(
        &[
            sent("one", Some(10.0)),
            sent("two", None),
            sent("three", Some(30.0)),
        ],
        &[lifted("late", 99.0), lifted("mid", 20.0)],
    );
    assert_eq!(h, strs(&["one", "two", "mid", "three", "late"]));
}

#[test]
fn build_prompt_history_drops_empties_and_consecutive_duplicates() {
    let h = build_prompt_history(
        &[
            sent("a", None),
            sent(" a ", None),
            sent("[Image #1]", None),
            sent("b", None),
            sent("a", None),
        ],
        &[],
    );
    assert_eq!(h, strs(&["a", "b", "a"]));
}

#[test]
fn build_prompt_history_sort_is_stable_for_equal_and_nan_times() {
    let h = build_prompt_history(&[], &[lifted("x", 5.0), lifted("y", 5.0), lifted("z", 1.0)]);
    assert_eq!(h, strs(&["z", "x", "y"]));
}

#[test]
fn history_entry_index_skips_the_newest_when_the_draft_holds_it() {
    let h = strs(&["a", "b"]);
    assert_eq!(history_entry_index(&h, ""), Some(1));
    assert_eq!(history_entry_index(&h, " b "), Some(0));
    assert_eq!(history_entry_index(&strs(&["b"]), "b"), Some(0));
    assert_eq!(history_entry_index(&[], "b"), None);
}

#[test]
fn command_needs_sudo_is_sudo_at_a_word_boundary() {
    assert!(command_needs_sudo("sudo ls"));
    assert!(command_needs_sudo("  sudo"));
    assert!(command_needs_sudo("sudo-rs x"));
    assert!(!command_needs_sudo("sudoku"));
    assert!(!command_needs_sudo("echo sudo"));
    assert!(!command_needs_sudo("SUDO ls"));
}

#[test]
fn should_stash_cleared_draft_needs_text_or_images() {
    assert!(should_stash_cleared_draft("x", 0));
    assert!(should_stash_cleared_draft("", 1));
    assert!(!should_stash_cleared_draft("", 0));
}

#[test]
fn can_restore_cleared_draft_needs_an_idle_empty_box_and_a_stash() {
    let open = RestoreGate {
        has_stash: true,
        ..Default::default()
    };
    assert!(can_restore_cleared_draft(&open));
    for blocked in [
        RestoreGate { value: "x", ..open },
        RestoreGate {
            image_count: 1,
            ..open
        },
        RestoreGate {
            picker_open: true,
            ..open
        },
        RestoreGate {
            at_active: true,
            ..open
        },
        RestoreGate {
            emoji_active: true,
            ..open
        },
        RestoreGate {
            browsing_history: true,
            ..open
        },
        RestoreGate {
            has_stash: false,
            ..open
        },
    ] {
        assert!(!can_restore_cleared_draft(&blocked), "{blocked:?}");
    }
}

#[test]
fn ordinal_floor_after_restore_is_the_highest_ordinal() {
    assert_eq!(
        ordinal_floor_after_restore(2.0, &[img("a", 5.0), img("b", 1.0)]),
        5.0
    );
    assert_eq!(ordinal_floor_after_restore(7.0, &[img("a", 5.0)]), 7.0);
    assert!(ordinal_floor_after_restore(7.0, &[img("a", f64::NAN)]).is_nan());
}

#[test]
fn build_draft_flush_request_puts_the_pending_draft() {
    let p = PendingDraft {
        session_id: "s1".into(),
        text: "hi".into(),
        images: vec![img("i", 1.0)],
    };
    let r = build_draft_flush_request(Some(&p), true).unwrap();
    assert_eq!(r.url, "/api/sessions/s1/prompt-draft");
    assert_eq!(r.method, "PUT");
    assert_eq!(
        r.body,
        r#"{"text":"hi","images":[{"id":"i","ordinal":1,"data":"AAAA","mediaType":"image/png"}]}"#
    );
    assert!(r.keepalive);
    assert!(
        !build_draft_flush_request(Some(&p), false)
            .unwrap()
            .keepalive
    );
    assert_eq!(build_draft_flush_request(None, true), None);
    let no_id = PendingDraft {
        session_id: String::new(),
        ..p
    };
    assert_eq!(build_draft_flush_request(Some(&no_id), true), None);
}

#[test]
fn build_draft_flush_request_drops_keepalive_past_the_body_limit() {
    let big = PendingDraft {
        session_id: "s".into(),
        text: "x".repeat(KEEPALIVE_BODY_LIMIT),
        images: vec![],
    };
    assert!(
        !build_draft_flush_request(Some(&big), true)
            .unwrap()
            .keepalive
    );
    let fits = PendingDraft {
        text: "x".repeat(KEEPALIVE_BODY_LIMIT - r#"{"text":"","images":[]}"#.len()),
        ..big
    };
    assert!(
        build_draft_flush_request(Some(&fits), true)
            .unwrap()
            .keepalive
    );
}

#[test]
fn send_delivery_reads_the_settled_value() {
    assert_eq!(send_delivery(&json!(null)), Ok(()));
    assert_eq!(send_delivery(&json!(true)), Ok(()));
    assert_eq!(send_delivery(&json!(false)), undelivered());
    assert_eq!(send_delivery(&json!({"ok": true})), Ok(()));
    assert_eq!(send_delivery(&json!({"ok": 0})), Ok(()));
    assert_eq!(send_delivery(&json!({"queued": true})), Ok(()));
    assert_eq!(
        send_delivery(&json!({"ok": false, "error": "network"})),
        Err("network".into())
    );
    assert_eq!(
        send_delivery(&json!({"ok": false, "error": ""})),
        undelivered()
    );
    assert_eq!(
        send_delivery(&json!({"ok": false, "error": 3})),
        undelivered()
    );
    assert_eq!(undelivered(), Err("unknown".into()));
}

#[test]
fn send_failed_notice_words_each_case() {
    assert_eq!(
        send_failed_notice("network", NoticePlacement::Restore),
        "Couldn't reach Claudius \u{2014} your message is back in the box."
    );
    assert!(send_failed_notice("network", NoticePlacement::Stash).contains("Press \u{2191}"));
    assert_eq!(
        send_failed_notice("http", NoticePlacement::Restore),
        "Message not sent \u{2014} it's back in the box."
    );
    assert!(send_failed_notice("unknown", NoticePlacement::Stash).contains("press \u{2191}"));
}

#[test]
fn place_failed_send_saves_to_the_origin_restores_or_stashes() {
    use FailedSendPlacement::*;
    assert_eq!(place_failed_send(Some("a"), Some("b"), "", 0), SaveToOrigin);
    assert_eq!(place_failed_send(Some("a"), None, "", 0), SaveToOrigin);
    assert_eq!(place_failed_send(Some(""), Some("b"), "", 0), Restore);
    assert_eq!(place_failed_send(None, Some("b"), "x", 0), Stash);
    assert_eq!(place_failed_send(Some("a"), Some("a"), "", 1), Stash);
    assert_eq!(place_failed_send(Some("a"), Some("a"), "", 0), Restore);
}

#[test]
fn num_text_prints_like_a_template_literal() {
    assert_eq!(num_text(3.0), "3");
    assert_eq!(num_text(0.5), "0.5");
    assert_eq!(num_text(f64::NAN), "NaN");
    assert_eq!(num_text(f64::INFINITY), "Infinity");
    assert_eq!(num_text(f64::NEG_INFINITY), "-Infinity");
}

#[test]
fn merge_into_draft_appends_and_renumbers_past_the_draft() {
    let (t, i) = merge_into_draft("", &[], "sent [Image #1]", &[img("x", 1.0)]);
    assert_eq!(t, "sent [Image #1]");
    assert_eq!(i, vec![img("x", 1.0)]);

    let (t, i) = merge_into_draft(
        "draft [Image #4]",
        &[img("d", 2.0)],
        "see [Image #1] and [Image #9]",
        &[img("x", 1.0)],
    );
    assert_eq!(t, "draft [Image #4]\nsee [Image #5] and [Image #9]");
    assert_eq!(i, vec![img("d", 2.0), img("x", 5.0)]);

    // A draft with only images: no leading newline.
    let (t, _) = merge_into_draft("", &[img("d", 1.0)], "[Image #1]", &[img("x", 1.0)]);
    assert_eq!(t, "[Image #2]");
}

#[test]
fn merge_into_draft_keeps_text_when_the_offset_is_zero() {
    let (t, i) = merge_into_draft("draft", &[], "[Image #1]", &[img("x", 1.0)]);
    assert_eq!(t, "draft\n[Image #1]");
    assert_eq!(i[0].ordinal, 1.0);
}

#[test]
fn compute_list_continuation_continues_checkbox_numbered_and_bullets() {
    use ListContinuation::*;
    assert_eq!(
        compute_list_continuation("- [x] done"),
        Some(Next("- [ ] ".into()))
    );
    assert_eq!(
        compute_list_continuation("  9. nine"),
        Some(Next("  10. ".into()))
    );
    assert_eq!(
        compute_list_continuation("\u{2022} a"),
        Some(Next("\u{2022} ".into()))
    );
    assert_eq!(compute_list_continuation("* a"), Some(Next("* ".into())));
    assert_eq!(
        compute_list_continuation("\t- a"),
        Some(Next("\t- ".into()))
    );
    assert_eq!(compute_list_continuation("- [ ]  "), Some(Empty));
    assert_eq!(compute_list_continuation("3.   "), Some(Empty));
    assert_eq!(compute_list_continuation("-"), None);
    assert_eq!(compute_list_continuation("-a"), None);
    assert_eq!(compute_list_continuation("plain"), None);
    assert_eq!(compute_list_continuation("1.x"), None);
}

#[test]
fn compute_list_continuation_numbers_past_safe_integers_like_js() {
    assert_eq!(
        compute_list_continuation("99999999999999999999. x"),
        Some(ListContinuation::Next("100000000000000000000. ".into()))
    );
}

#[test]
fn is_list_line_needs_whitespace_after_the_marker() {
    assert!(is_list_line("- a"));
    assert!(is_list_line("  12. a"));
    assert!(is_list_line("\u{2022} "));
    assert!(is_list_line("- [ ] x"));
    assert!(!is_list_line("-"));
    assert!(!is_list_line("12."));
    assert!(!is_list_line("x - a"));
}

#[test]
fn bullets_to_markdown_rewrites_line_leading_bullets() {
    assert_eq!(
        bullets_to_markdown("\u{2022} a\n  \u{2022} b"),
        "* a\n  * b"
    );
    assert_eq!(bullets_to_markdown("x \u{2022} a"), "x \u{2022} a");
    assert_eq!(bullets_to_markdown("\u{2022}a"), "\u{2022}a");
    assert_eq!(bullets_to_markdown("x\n\n \u{2022} b"), "x\n\n * b");
}

#[test]
fn is_invisible_covers_the_ts_class() {
    for c in [
        '\u{200b}',
        '\u{2060}',
        '\u{feff}',
        '\u{202a}',
        '\u{202e}',
        '\u{2066}',
        '\u{2069}',
        '\u{e0001}',
        '\u{e0020}',
        '\u{e007f}',
    ] {
        assert!(is_invisible(c), "{c:?}");
    }
    for c in ['\u{200c}', '\u{200d}', '\u{2065}', '\u{e0002}', 'a'] {
        assert!(!is_invisible(c), "{c:?}");
    }
}

#[test]
fn strip_invisible_unicode_counts_removed_and_bidi() {
    let s = strip_invisible_unicode("a\u{200b}b\u{202e}c\u{e0041}");
    assert_eq!(s.cleaned, "abc");
    assert_eq!(s.removed_count, 3);
    assert_eq!(s.bidi_count, 1);
}

#[test]
fn invisible_strip_needs_review_holds_bidi_empty_and_commands() {
    assert!(invisible_strip_needs_review("x", 1, false));
    assert!(invisible_strip_needs_review("  ", 0, false));
    assert!(!invisible_strip_needs_review("  ", 0, true));
    assert!(invisible_strip_needs_review(" /cmd", 0, false));
    assert!(invisible_strip_needs_review("!ls", 0, false));
    assert!(!invisible_strip_needs_review("hello", 0, false));
}

#[test]
fn hidden_chars_notice_words_the_count() {
    assert_eq!(
        hidden_chars_notice(1, false, false),
        "Removed 1 hidden character"
    );
    assert_eq!(
        hidden_chars_notice(2, true, true),
        "Removed 2 hidden characters from your prompt \u{2014} review and press Send again."
    );
}

#[test]
fn is_letter_key_trusts_latin_layouts_then_the_physical_key() {
    assert!(is_letter_key("c", "KeyC", false, 'c'));
    assert!(is_letter_key("C", "KeyC", false, 'c'));
    // Dvorak: the C key types "j".
    assert!(!is_letter_key("j", "KeyC", false, 'c'));
    // Russian: Cyrillic "с" on the C key.
    assert!(is_letter_key("\u{441}", "KeyC", false, 'c'));
    assert!(!is_letter_key("\u{441}", "KeyC", true, 'c'));
    assert!(!is_letter_key("Process", "KeyC", false, 'c'));
    // The Kelvin sign lowercases to a Latin k.
    assert!(is_letter_key("\u{212a}", "KeyX", false, 'k'));
}

#[test]
fn keyword_hint_matches_whole_words_with_an_optional_s() {
    let wf = &KEYWORD_HINTS[0];
    assert!(wf.matches("run a Workflow now"));
    assert!(wf.matches("workflows."));
    assert!(!wf.matches("workflowy"));
    assert!(!wf.matches("subworkflow"));
    assert!(wf.matches("my_x workflow"));
    assert!(!wf.matches("my_workflow"));
}

#[test]
fn detected_hint_picks_the_first_and_honors_dismissals() {
    assert_eq!(
        detected_hint("a goal and a workflow", &[]).map(|h| h.0.id),
        Some("workflow")
    );
    assert_eq!(
        detected_hint("my goal", &[]).map(|h| h.1),
        Some(HintState::Active)
    );
    assert_eq!(detected_hint("my goal", &["goal"]), None);
    assert_eq!(
        detected_hint("workflow", &["workflow"]).map(|h| h.1),
        Some(HintState::Ignored)
    );
    assert_eq!(detected_hint("!workflow", &[]), None);
    assert_eq!(detected_hint("nothing", &[]), None);
}

#[test]
fn queue_hint_words_the_pending_state() {
    assert_eq!(queue_hint(false, 3), "");
    assert_eq!(queue_hint(true, 2), "2 queued \u{b7} edit above");
    assert_eq!(queue_hint(true, 1), "1 queued \u{b7} edit above");
    assert_eq!(
        queue_hint(true, 0),
        "Send queues until current response finishes"
    );
}

#[test]
fn placeholder_follows_ready_and_pending() {
    assert_eq!(placeholder(false, true), "Starting session\u{2026}");
    assert!(placeholder(true, true).starts_with("Queue a follow-up"));
    assert!(placeholder(true, false).starts_with("Message Claudius"));
}

#[test]
fn sdk_queued_turns_label_pluralizes() {
    assert_eq!(
        sdk_queued_turns_label(1.0),
        "1 more turn sent \u{b7} runs automatically"
    );
    assert_eq!(
        sdk_queued_turns_label(2.0),
        "2 more turns sent \u{b7} runs automatically"
    );
}
