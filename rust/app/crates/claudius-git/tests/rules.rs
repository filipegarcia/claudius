//! The Git page's pure rules, one test per rule, each naming the TS it
//! mirrors: the poll's chain (useGitStatus.ts / git-poll.ts), the PR badge
//! (page.tsx:1635), the console and its one-liner (page.tsx:89, :270), the
//! JS string rules, the commit box (CommitBox.tsx), the branch popover
//! (BranchSwitcher.tsx), the changes list's navigation (ChangesList.tsx),
//! the diff pane (DiffViewer.tsx) and the requests / answer readers of the
//! `GitData` trait.

use std::collections::{BTreeSet, HashSet};

use bytes::Bytes;
use claudius_git::branches::{
    AfterOp, BranchAction, BranchOp, BranchPrompt, BranchSwitcher, actions_for, chip_label,
    chip_title, closes_on_ok, delete_remote_question, force_delete_question, is_not_fully_merged,
    local_label, op_key, sections,
};
use claudius_git::changes::{
    DiffMode, DiffSelection, GroupKey, build_dir_tree, dir_checked, group_files, nav_order,
    partial_title, step_selection,
};
use claudius_git::commit_box::{ComboStep, CommitBox};
use claudius_git::console::{
    CONSOLE_MAX_ENTRIES, Console, ConsoleStatus, console_output, first_line,
    strip_git_failure_prefix,
};
use claudius_git::data::{
    DeleteTarget, RemoteOp, StageOp, encode_uri_component, error_text, js_string_of, merge_outcome,
    output_of, request,
};
use claudius_git::diff::{DiffView, diff_view, hunk_starts};
use claudius_git::poll::{StatusPoll, next_git_poll_delay_ms};
use claudius_git::pr_badge::{
    BadgeTone, pr_badge_href, pr_badge_title, pr_badge_tone, pr_checks_mark,
};
use claudius_git::types::{
    BranchInfo, CommitPrefixConfig, GitFileChange, PrBadge, js_len, js_number, js_slice_to,
    js_trim, plural, truthy,
};
use claudius_transport::{Request, Response};
use serde_json::{Value, json};

// ---- the status poll (useGitStatus.ts:46, git-poll.ts:33) -----------------

#[test]
fn the_poll_delay_is_at_least_the_base_and_three_times_the_last_run_capped_at_a_minute() {
    assert_eq!(next_git_poll_delay_ms(4000., None), 4000.);
    assert_eq!(next_git_poll_delay_ms(4000., Some(1000.)), 4000.);
    assert_eq!(next_git_poll_delay_ms(4000., Some(2000.)), 6000.);
    assert_eq!(next_git_poll_delay_ms(4000., Some(30_000.)), 60_000.);
    assert_eq!(next_git_poll_delay_ms(4000., Some(f64::NAN)), 4000.);
    assert_eq!(next_git_poll_delay_ms(4000., Some(-5.)), 4000.);
    assert_eq!(next_git_poll_delay_ms(-1., Some(100.)), 300.);
}

#[test]
fn the_poll_keeps_one_request_in_flight_and_a_forced_run_supersedes_it() {
    let mut p = StatusPoll::new(4000.);
    let first = p.run(false).expect("the first run");
    assert_eq!(p.run(false), None, "a background run never stacks");
    let forced = p.run(true).expect("refresh() supersedes");
    assert_ne!(first, forced);
    assert!(!p.is_current(first));
    assert_eq!(
        p.settled(first, 10.),
        None,
        "the superseded answer is dropped"
    );
    let (timer, ms) = p.settled(forced, 3000.).expect("arms the next tick");
    assert_eq!(ms, 9000.);
    assert_eq!(p.armed(), Some(timer));
    assert_eq!(p.in_flight(), None);
}

#[test]
fn the_poll_lapses_while_hidden_and_restarts_when_visible() {
    let mut p = StatusPoll::new(4000.);
    let id = p.run(false).unwrap();
    let (timer, _) = p.settled(id, 1.).unwrap();
    assert_eq!(p.tick(timer, false), None, "hidden: the tick lapses");
    assert_eq!(p.armed(), None);
    assert!(p.visible().is_some(), "visibilitychange restarts the chain");
}

#[test]
fn a_stale_timer_does_nothing_and_a_run_clears_the_armed_one() {
    let mut p = StatusPoll::new(4000.);
    let id = p.run(false).unwrap();
    let (timer, _) = p.settled(id, 1.).unwrap();
    let next = p.run(true).unwrap();
    assert_eq!(p.armed(), None);
    assert_eq!(p.tick(timer, true), None, "the old timer was cleared");
    assert!(p.is_current(next));
}

#[test]
fn a_disposed_poll_drops_its_answer_and_never_runs_again() {
    let mut p = StatusPoll::new(4000.);
    let id = p.run(false).unwrap();
    p.dispose();
    assert!(!p.is_current(id));
    assert_eq!(p.settled(id, 1.), None);
    assert_eq!(p.run(true), None);
    assert_eq!(p.visible(), None);
}

// ---- the PR badge (pr-badge.ts:109, page.tsx:1635) ------------------------

fn badge(host: &str, state: &str, checks: &str, title: Option<&str>) -> PrBadge {
    PrBadge {
        host: host.into(),
        number: 4716.,
        url: "https://github.com/acme/app/pull/4716".into(),
        title: title.map(str::to_owned),
        state: state.into(),
        checks: checks.into(),
    }
}

#[test]
fn the_badge_title_joins_the_label_title_state_and_checks() {
    assert_eq!(
        pr_badge_title(&badge("github", "open", "passing", Some("Add search"))),
        "PR #4716 — Add search · open · checks passing"
    );
    assert_eq!(
        pr_badge_title(&badge("gitlab", "draft", "none", None)),
        "MR !4716 · draft"
    );
    assert_eq!(
        pr_badge_title(&badge("github", "open", "none", Some(""))),
        "PR #4716 · open",
        "an empty title is falsy"
    );
}

#[test]
fn the_badge_tone_follows_the_state() {
    let tone = |s| pr_badge_tone(&badge("github", s, "none", None));
    assert_eq!(tone("merged"), BadgeTone::Merged);
    assert_eq!(tone("closed"), BadgeTone::Closed);
    assert_eq!(tone("draft"), BadgeTone::Draft);
    assert_eq!(tone("open"), BadgeTone::Open);
    assert_eq!(tone("weird"), BadgeTone::Open);
}

#[test]
fn the_checks_mark_and_the_link() {
    let mark = |c| pr_checks_mark(&badge("github", "open", c, None));
    assert_eq!(mark("passing"), Some("✓"));
    assert_eq!(mark("failing"), Some("✗"));
    assert_eq!(mark("pending"), Some("•"));
    assert_eq!(mark("none"), None);
    let mut b = badge("github", "open", "none", None);
    assert_eq!(
        pr_badge_href(&b),
        Some("https://github.com/acme/app/pull/4716")
    );
    b.url.clear();
    assert_eq!(pr_badge_href(&b), None, "`url || undefined`");
}

// ---- the console (page.tsx:270) -------------------------------------------

#[test]
fn the_console_drops_the_git_failure_prefix_and_trims_the_end() {
    assert_eq!(
        console_output("git push exited 1:  fatal: no upstream\n\n"),
        "fatal: no upstream"
    );
    assert_eq!(
        strip_git_failure_prefix("git branch -d exited 1: x"),
        "x",
        "`-d` is a `[\\w-]+` word"
    );
    assert_eq!(
        strip_git_failure_prefix("git log a..b exited 1: x"),
        "git log a..b exited 1: x",
        "`a..b` is not a word"
    );
    assert_eq!(
        strip_git_failure_prefix("git push exited 1"),
        "git push exited 1",
        "no colon"
    );
    assert_eq!(
        strip_git_failure_prefix("git rev-parse HEAD exited -1:\tx"),
        "x"
    );
    assert_eq!(
        strip_git_failure_prefix("gitx push exited 1: y"),
        "gitx push exited 1: y"
    );
}

#[test]
fn the_console_caps_its_output_at_8000_utf16_units() {
    let long = "é".repeat(8005);
    let out = console_output(&long);
    assert!(
        out.ends_with("\n… 5 more chars omitted"),
        "{}",
        &out[out.len() - 40..]
    );
    assert_eq!(js_len(out.split('\n').next().unwrap()), 8000);
}

#[test]
fn the_console_keeps_the_newest_200_and_an_error_opens_it() {
    let mut c = Console::default();
    for i in 0..CONSOLE_MAX_ENTRIES + 5 {
        c.push(format!("git {i}"), ConsoleStatus::Ok, "");
    }
    assert_eq!(c.entries.len(), CONSOLE_MAX_ENTRIES);
    assert_eq!(c.entries[0].command, "git 5");
    assert!(!c.open, "ok and info entries leave it closed");
    c.push("git push", ConsoleStatus::Info, "");
    assert!(!c.open);
    c.push("git push", ConsoleStatus::Error, "boom");
    assert!(c.open);
    assert_eq!(c.last().unwrap().output, "boom");
}

#[test]
fn the_banner_shows_the_first_line() {
    assert_eq!(first_line("one\ntwo"), "one");
    assert_eq!(first_line(""), "");
}

// ---- the JS string rules --------------------------------------------------

#[test]
fn js_trim_len_slice_and_number() {
    assert_eq!(js_trim("\u{feff}\u{a0} x \u{2028}"), "x");
    assert_eq!(js_trim("\u{85}x"), "\u{85}x", "U+0085 is not JS whitespace");
    assert_eq!(js_len("a😀"), 3);
    assert_eq!(
        js_slice_to("a😀b", 2),
        "a\u{fffd}",
        "a split pair prints U+FFFD"
    );
    assert_eq!(js_number(4000.), "4000");
    assert_eq!(js_number(1.5), "1.5");
    assert_eq!(js_number(-0.), "0");
    assert_eq!(js_number(1e21), "1e+21");
    assert_eq!(js_number(f64::NAN), "NaN");
    assert_eq!(js_number(f64::NEG_INFINITY), "-Infinity");
    assert_eq!(plural(1), "");
    assert_eq!(plural(0), "s");
}

#[test]
fn the_commit_prefix_config_reads_as_the_store_holds_it() {
    let c = CommitPrefixConfig::from_value(&json!({
        "enabled": 1, "branchPattern": "feat/{t}", "template": "#{t} "
    }))
    .unwrap();
    assert!(c.enabled, "`enabled` is JS truthy");
    assert_eq!(c.branch_pattern, "feat/{t}");
    assert!(
        !CommitPrefixConfig::from_value(
            &json!({"enabled": "", "branchPattern": "", "template": ""})
        )
        .unwrap()
        .enabled
    );
    assert_eq!(
        CommitPrefixConfig::from_value(
            &json!({"enabled": true, "branchPattern": 1, "template": ""})
        ),
        None
    );
    assert_eq!(CommitPrefixConfig::from_value(&json!("x")), None);
    assert!(
        !truthy(&json!(0)) && !truthy(&Value::Null) && truthy(&json!([])) && truthy(&json!({}))
    );
}

// ---- the commit box (CommitBox.tsx) ---------------------------------------

#[test]
fn the_box_starts_with_the_draft_else_the_prefix() {
    assert_eq!(
        CommitBox::new("w", "draft", Some("feat: ")).message(),
        "draft"
    );
    assert_eq!(CommitBox::new("w", "", Some("feat: ")).message(), "feat: ");
    assert_eq!(CommitBox::new("w", "", None).message(), "");
}

#[test]
fn a_new_draft_replaces_the_text_and_a_new_prefix_fills_an_empty_box() {
    let mut b = CommitBox::new("w", "", None);
    b.set_message("typed");
    b.sync("w", "", Some("feat: "));
    assert_eq!(b.message(), "typed", "a prefix never overwrites typing");
    b.sync("w", "loaded draft", Some("feat: "));
    assert_eq!(b.message(), "loaded draft");
    assert_eq!(b.reset_tick(), 1);
    let mut e = CommitBox::new("w", "", None);
    let r = e.revision();
    e.sync("w", "", Some("fix: "));
    assert_eq!(e.message(), "fix: ");
    assert!(e.revision() > r, "the view copies it in");
    e.sync("w", "", Some("fix: "));
    assert_eq!(e.reset_tick(), 1, "an unchanged prefix does nothing");
}

#[test]
fn the_draft_cleared_resets_to_the_prefix() {
    let mut b = CommitBox::new("w", "old", Some("feat: "));
    b.sync("w", "", Some("feat: "));
    assert_eq!(b.message(), "feat: ");
    let mut n = CommitBox::new("w", "old", None);
    n.sync("w", "", None);
    assert_eq!(n.message(), "");
    assert_eq!(n.reset_tick(), 0, "an empty reset moves no caret");
}

#[test]
fn the_commit_gate_needs_idle_a_checked_file_and_a_message() {
    let mut b = CommitBox::new("w", "", None);
    assert!(!b.can_commit(false, 1), "blank");
    b.set_message("   ");
    assert!(!b.can_commit(false, 1), "whitespace is blank");
    b.set_message("msg");
    assert!(b.can_commit(false, 1));
    assert!(!b.can_commit(false, 0), "nothing checked");
    assert!(!b.can_commit(true, 1), "a commit is running");
    b.generating = true;
    assert!(!b.can_commit(false, 1), "generating");
    assert!(!b.can_generate(false, 1));
    b.generating = false;
    b.combo_step = Some(ComboStep::Push);
    assert!(!b.can_commit(false, 1), "the combo runs");
    assert!(b.combo_enabled(false, 1), "as Stop");
    b.cancelling = true;
    assert!(!b.combo_enabled(false, 1), "cancelling");
}

#[test]
fn the_combo_starts_with_generate_on_a_blank_box() {
    let mut b = CommitBox::new("w", "", None);
    assert_eq!(b.begin_combo(false, 0), None);
    assert_eq!(b.begin_combo(false, 1), Some(ComboStep::Generate));
    let mut c = CommitBox::new("w", "msg", None);
    c.error = Some("old".into());
    assert_eq!(c.begin_combo(false, 2), Some(ComboStep::Commit));
    assert_eq!(c.error, None);
    c.cancel_combo();
    assert!(c.cancelled() && c.cancelling);
    assert_eq!(c.combo_label(), "Cancelling…");
    c.end_combo();
    assert_eq!(c.combo_step, None);
    assert!(!c.cancelling);
}

#[test]
fn a_generated_message_gets_the_prefix_unless_it_has_it() {
    assert_eq!(
        CommitBox::with_prefix("add x", Some("feat: ")),
        "feat: add x"
    );
    assert_eq!(
        CommitBox::with_prefix("feat: add x", Some("feat: ")),
        "feat: add x"
    );
    assert_eq!(CommitBox::with_prefix("add x", Some("")), "add x");
    assert_eq!(CommitBox::with_prefix("add x", None), "add x");
    let mut b = CommitBox::new("w", "", None);
    assert!(b.begin_generate(false, 1));
    assert_eq!(b.placeholder(), "Generating commit message…");
    assert_eq!(b.generate_label(), "Generating…");
    assert_eq!(b.generated(Ok("x".into()), Some("p ")), Some("p x".into()));
    assert!(b.generating, "until the draft saved");
    b.generate_done();
    assert!(!b.generating);
    assert!(b.begin_generate(false, 1));
    assert_eq!(b.generated(Err("no key".into()), None), None);
    assert_eq!(b.error.as_deref(), Some("no key"));
    assert!(!b.generating);
}

#[test]
fn a_commit_clears_the_box_and_a_failure_keeps_it() {
    let mut b = CommitBox::new("w", "msg", None);
    assert_eq!(b.begin_submit(false, 1), Some("msg".into()));
    b.submitted(Err("hook failed".into()));
    assert_eq!(b.message(), "msg");
    assert_eq!(b.error.as_deref(), Some("hook failed"));
    assert_eq!(b.begin_submit(false, 1), Some("msg".into()));
    assert_eq!(b.error, None);
    b.submitted(Ok(()));
    assert_eq!(b.message(), "");
}

#[test]
fn the_box_labels() {
    assert_eq!(CommitBox::header(1, Some("main")), "Commit 1 file to main");
    assert_eq!(CommitBox::header(0, None), "Commit 0 files");
    assert_eq!(CommitBox::commit_label(true), "Committing…");
    assert_eq!(CommitBox::commit_label(false), "Commit");
    assert_eq!(CommitBox::generate_title(0), "Check files to commit first");
    let mut b = CommitBox::new("w", "", None);
    assert_eq!(b.combo_label(), "Commit & Push");
    assert_eq!(b.combo_title(0), "Check files to commit first");
    assert_eq!(
        b.combo_title(1),
        "Generate a commit message, commit, then push (⌘/Ctrl + ⇧ + Enter)"
    );
    b.set_message("m");
    assert_eq!(b.combo_title(1), "Commit, then push (⌘/Ctrl + ⇧ + Enter)");
    b.combo_step = Some(ComboStep::Commit);
    assert_eq!(b.combo_label(), "Committing… · Stop");
    assert_eq!(
        b.combo_title(1),
        "Committing — click to stop after this step"
    );
}

// ---- the branch popover (BranchSwitcher.tsx) ------------------------------

fn branch(name: &str, kind: &str, current: bool) -> BranchInfo {
    BranchInfo {
        name: name.into(),
        kind: kind.into(),
        sha: "abc".into(),
        upstream: None,
        committer_date: String::new(),
        current,
    }
}

fn labels(b: &BranchInfo, cur: Option<&str>) -> Vec<String> {
    actions_for(b, cur).into_iter().map(|i| i.label).collect()
}

#[test]
fn actions_for_the_current_branch() {
    let b = branch("feat", "local", true);
    let items = actions_for(&b, Some("feat"));
    assert_eq!(
        labels(&b, Some("feat")),
        [
            "Checkout",
            "New Branch from 'feat'…",
            "Update",
            "Push…",
            "Rename…",
            "Delete"
        ]
    );
    assert!(items[0].disabled, "checkout of the current one");
    assert!(
        items[5].disabled && items[5].danger,
        "no deleting the current one"
    );
}

#[test]
fn actions_for_another_local_and_a_remote() {
    let b = branch("main", "local", false);
    assert_eq!(
        labels(&b, Some("feat")),
        [
            "Checkout",
            "New Branch from 'main'…",
            "Checkout and Rebase onto 'feat'",
            "Compare with 'feat'",
            "Show Diff with Working Tree",
            "Rebase 'feat' onto 'main'",
            "Merge 'main' into 'feat'",
            "Rename…",
            "Delete",
        ]
    );
    let r = branch("origin/main", "remote", false);
    let items = actions_for(&r, None);
    assert_eq!(
        items.iter().map(|i| i.label.as_str()).collect::<Vec<_>>(),
        [
            "Checkout",
            "New Branch from 'origin/main'…",
            "Delete (remote)"
        ],
        "detached: no current-branch items"
    );
    assert!(!items[2].disabled && items[2].danger);
}

#[test]
fn op_keys_and_which_ops_close_the_popover() {
    assert_eq!(op_key(&BranchAction::Checkout("x".into())), "x");
    assert_eq!(
        op_key(&BranchAction::NewBranch { start_point: None }),
        "__new__"
    );
    assert_eq!(
        op_key(&BranchAction::Compare {
            base: "a".into(),
            head: "b".into()
        }),
        "__cmp__:b"
    );
    assert_eq!(
        op_key(&BranchAction::DeleteRemote("o/x".into())),
        "__delete__:o/x"
    );
    assert!(!closes_on_ok(&BranchAction::ShowDiff("x".into())));
    assert!(!closes_on_ok(&BranchAction::Compare {
        base: "a".into(),
        head: "b".into()
    }));
    assert!(closes_on_ok(&BranchAction::Merge("x".into())));
}

#[test]
fn not_fully_merged_is_case_blind() {
    assert!(is_not_fully_merged(
        "error: The branch 'x' is NOT FULLY MERGED."
    ));
    assert!(is_not_fully_merged(
        "branch has not yet been merged to HEAD"
    ));
    assert!(!is_not_fully_merged("error: branch 'x' not found."));
}

#[test]
fn the_sections_keep_the_current_branch_and_filter_the_rest() {
    let mut up = branch("feat", "local", false);
    up.upstream = Some("origin/Topic".into());
    let all = vec![
        branch("main", "local", true),
        up,
        branch("origin/main", "remote", false),
    ];
    let s = sections(&all, "  TOPIC ");
    assert_eq!(s.current.as_ref().unwrap().name, "main", "never filtered");
    assert_eq!(
        s.locals.len(),
        1,
        "matched by upstream, trimmed, case-blind"
    );
    assert!(s.remotes.is_empty());
    let s = sections(&all, "");
    assert_eq!(s.other_locals().count(), 1);
    assert_eq!(s.remotes.len(), 1);
    assert_eq!(local_label(true), "Local");
    assert_eq!(local_label(false), "Local · others");
}

#[test]
fn the_prompts_ask_and_read_their_answers() {
    let new = BranchPrompt::New {
        start_point: Some("main".into()),
    };
    assert_eq!(new.label(), "New branch name (starting from 'main'):");
    assert_eq!(
        BranchPrompt::New { start_point: None }.label(),
        "New branch name:"
    );
    assert_eq!(new.answer("  "), None);
    assert_eq!(
        new.answer(" topic "),
        Some((
            "__new__:topic".into(),
            BranchOp::Create {
                name: "topic".into(),
                start_point: Some("main".into())
            }
        ))
    );
    let rename = BranchPrompt::Rename {
        old_name: "a".into(),
    };
    assert_eq!(rename.label(), "Rename branch 'a' to:");
    assert_eq!(rename.default_value(), "a");
    assert_eq!(rename.answer(" a "), None, "unchanged");
    assert_eq!(
        rename.answer("b").unwrap().1,
        BranchOp::Rename {
            old_name: "a".into(),
            new_name: "b".into()
        }
    );
}

#[test]
fn opening_the_popover_loads_and_an_old_load_is_dropped() {
    let mut s = BranchSwitcher::default();
    let g1 = s.toggle().expect("opening loads");
    assert!(s.open && s.loading);
    let g2 = s.reload().expect("refresh");
    s.loaded(g1, Ok(vec![branch("stale", "local", false)]));
    assert!(s.branches.is_empty(), "an older load is dropped");
    s.loaded(g2, Err("boom".into()));
    assert_eq!(s.load_error.as_deref(), Some("boom"));
    assert!(!s.loading);
    assert_eq!(s.empty_text(), None, "the error shows instead");
    s.toggle();
    assert!(!s.open);
    assert_eq!(s.reload(), None, "closed: nothing loads");
    let g3 = s.toggle().unwrap();
    s.close();
    s.loaded(g3, Ok(vec![branch("x", "local", false)]));
    assert!(s.branches.is_empty(), "closed before it answered");
}

#[test]
fn the_empty_texts() {
    let mut s = BranchSwitcher::default();
    let g = s.toggle().unwrap();
    assert_eq!(s.empty_text(), None, "loading");
    s.loaded(g, Ok(Vec::new()));
    assert_eq!(s.empty_text().as_deref(), Some("No branches found."));
    s.branches = vec![branch("main", "local", false)];
    s.filter = "zzz".into();
    assert_eq!(s.empty_text().as_deref(), Some("No matches for “zzz”."));
}

#[test]
fn escape_closes_the_prompt_then_the_menu_then_the_popover() {
    let mut s = BranchSwitcher::default();
    s.toggle();
    s.toggle_menu("local:main");
    s.prompt = Some(BranchPrompt::New { start_point: None });
    s.escape();
    assert!(s.prompt.is_none() && s.menu_for.is_some());
    s.escape();
    assert!(s.menu_for.is_none() && s.open);
    s.escape();
    assert!(!s.open);
}

#[test]
fn branch_for_key_reads_the_tag() {
    let mut s = BranchSwitcher::default();
    s.branches = vec![
        branch("main", "local", true),
        branch("main", "remote", false),
    ];
    assert!(s.branch_for_key("current:main").unwrap().current);
    assert!(s.branch_for_key("remote:main").unwrap().is_remote());
    assert!(s.branch_for_key("local:main").unwrap().is_local());
    assert!(s.branch_for_key("other:main").is_none());
    assert!(s.branch_for_key(":main").is_none());
    assert!(s.branch_for_key("main").is_none());
    s.toggle_menu("local:main");
    s.toggle_menu("local:main");
    assert!(s.menu_for.is_none(), "a second click closes it");
}

#[test]
fn a_successful_op_closes_unless_read_only() {
    let mut s = BranchSwitcher::default();
    s.toggle();
    assert_eq!(
        s.start(&BranchAction::Checkout("x".into())),
        Some(BranchOp::Checkout("x".into()))
    );
    assert_eq!(s.busy_name.as_deref(), Some("x"));
    let item = &actions_for(&branch("y", "local", false), None)[0];
    assert!(!s.item_enabled(item), "busy: every item waits");
    assert_eq!(s.op_done(Ok(())), AfterOp::Nothing);
    assert!(!s.open && s.busy_name.is_none());
    s.toggle();
    s.toggle_menu("local:y");
    s.start(&BranchAction::ShowDiff("y".into()));
    s.op_done(Ok(()));
    assert!(s.open, "read-only keeps it open");
    assert!(s.menu_for.is_none());
    s.start(&BranchAction::Merge("y".into()));
    s.op_done(Err("conflict".into()));
    assert_eq!(s.action_error.as_deref(), Some("conflict"));
    assert!(s.open);
}

#[test]
fn the_delete_flow_asks_to_force_an_unmerged_branch() {
    let mut s = BranchSwitcher::default();
    s.toggle();
    assert_eq!(
        s.start(&BranchAction::DeleteLocal("x".into())),
        None,
        "asks first"
    );
    s.begin_delete_local("x", false);
    let after = s.op_done(Err("error: branch 'x' is not fully merged".into()));
    assert_eq!(
        after,
        AfterOp::AskForce {
            name: "x".into(),
            error: "error: branch 'x' is not fully merged".into()
        }
    );
    assert_eq!(
        s.busy_name.as_deref(),
        Some("__delete__:x"),
        "until answered"
    );
    s.force_declined("error: branch 'x' is not fully merged");
    assert!(s.busy_name.is_none());
    assert!(s.action_error.is_some());
    s.begin_delete_local("x", true);
    assert_eq!(
        s.op_done(Err("not fully merged".into())),
        AfterOp::Nothing,
        "forced: no second ask"
    );
    s.begin_delete_local("x", false);
    assert_eq!(s.op_done(Ok(())), AfterOp::Reload);
    assert!(s.open, "a local delete keeps the popover");
    s.begin_delete_remote("origin/x");
    assert_eq!(s.op_done(Ok(())), AfterOp::Reload);
    assert!(!s.open, "a remote delete closes it and reloads");
}

#[test]
fn the_chip_and_the_questions() {
    assert_eq!(chip_label(None), "—");
    assert_eq!(chip_label(Some("main")), "main");
    assert_eq!(chip_title(Some("main")), "Branch: main · click to switch");
    assert_eq!(chip_title(None), "No branch");
    assert_eq!(
        force_delete_question("x"),
        "'x' is not fully merged. Force-delete anyway? Unmerged commits will be lost."
    );
    assert!(
        delete_remote_question("o/x")
            .starts_with("Delete remote branch 'o/x'? Runs `git push --delete`")
    );
}

// ---- the changes list (ChangesList.tsx) -----------------------------------

fn demo_files() -> Vec<GitFileChange> {
    vec![
        GitFileChange::new("b/two.ts", "M", " "),
        GitFileChange::new("a/one.ts", " ", "M"),
        GitFileChange::new("a/z/deep.ts", " ", "M"),
        GitFileChange::untracked("new.txt"),
    ]
}

#[test]
fn the_arrow_order_follows_the_groups_and_skips_collapsed_ones() {
    let g = group_files(&demo_files());
    let none = HashSet::new();
    let dirs = BTreeSet::new();
    let order = nav_order(&g, false, &none, &dirs);
    assert_eq!(
        order,
        [
            DiffSelection::new("b/two.ts", DiffMode::Staged),
            DiffSelection::new("a/one.ts", DiffMode::Worktree),
            DiffSelection::new("a/z/deep.ts", DiffMode::Worktree),
            DiffSelection::new("new.txt", DiffMode::Untracked),
        ]
    );
    let collapsed: HashSet<_> = [GroupKey::Unstaged].into();
    assert_eq!(nav_order(&g, false, &collapsed, &dirs).len(), 2);
}

#[test]
fn by_directory_the_arrows_walk_folders_first_and_skip_collapsed_folders() {
    let g = group_files(&demo_files());
    let none = HashSet::new();
    let order = nav_order(&g, true, &none, &BTreeSet::new());
    let worktree: Vec<_> = order
        .iter()
        .filter(|s| s.mode == DiffMode::Worktree)
        .map(|s| s.path.as_str())
        .collect();
    assert_eq!(
        worktree,
        ["a/z/deep.ts", "a/one.ts"],
        "the folder before the file"
    );
    let collapsed: BTreeSet<String> = ["worktree:a/z".to_owned()].into();
    let order = nav_order(&g, true, &none, &collapsed);
    assert!(!order.iter().any(|s| s.path == "a/z/deep.ts"));
}

#[test]
fn a_step_moves_clamps_and_jumps_in() {
    let o = vec![
        DiffSelection::new("a", DiffMode::Staged),
        DiffSelection::new("b", DiffMode::Worktree),
    ];
    assert_eq!(step_selection(&o, None, true), Some(o[0].clone()));
    assert_eq!(step_selection(&o, None, false), Some(o[1].clone()));
    assert_eq!(step_selection(&o, Some(&o[0]), true), Some(o[1].clone()));
    assert_eq!(
        step_selection(&o, Some(&o[1]), true),
        None,
        "clamped at the end"
    );
    assert_eq!(
        step_selection(&o, Some(&o[0]), false),
        None,
        "clamped at the top"
    );
    let gone = DiffSelection::new("x", DiffMode::Staged);
    assert_eq!(step_selection(&o, Some(&gone), false), Some(o[1].clone()));
    assert_eq!(step_selection(&[], None, true), None);
}

#[test]
fn a_folder_checkbox_is_tri_state() {
    let tree = build_dir_tree(&demo_files()[1..3]);
    let a = &tree.dirs[0];
    assert_eq!(dir_checked(a, |_| false), Some(false));
    assert_eq!(dir_checked(a, |_| true), Some(true));
    assert_eq!(dir_checked(a, |p| p == "a/one.ts"), None);
}

#[test]
fn the_partial_marker_names_the_unstaged_side() {
    let f = GitFileChange::new("x", "M", "D");
    assert_eq!(partial_title(&f), "Also has unstaged deletion (MD)");
}

#[test]
fn the_diff_mode_labels() {
    assert_eq!(DiffMode::Staged.label(), "Staged · HEAD → index");
    assert_eq!(DiffMode::Worktree.label(), "Unstaged · index → working");
    assert_eq!(
        DiffMode::Untracked.label(),
        "Untracked · /dev/null → working"
    );
    assert_eq!(DiffMode::parse("nope"), None);
}

// ---- the diff pane (DiffViewer.tsx:72) ------------------------------------

#[test]
fn the_diff_pane_shows_loading_error_binary_empty_or_rows() {
    assert_eq!(diff_view("", false, true, Some("e")), DiffView::Loading);
    assert_eq!(
        diff_view("", false, false, Some("e")),
        DiffView::Error("e".into())
    );
    assert_eq!(diff_view("+x", true, false, Some("")), DiffView::Binary);
    assert_eq!(diff_view("", false, false, None), DiffView::Empty);
    assert_eq!(diff_view("\n\n", false, false, None), DiffView::Empty);
    assert!(matches!(diff_view("+x", false, false, None), DiffView::Rows(r) if r.len() == 1));
}

#[test]
fn a_hunk_header_needs_both_starts() {
    assert_eq!(hunk_starts("@@ -1,2 +3 @@ fn"), Some((1., 3.)));
    assert_eq!(hunk_starts("@@ -1 +3,4 @@"), Some((1., 3.)));
    assert_eq!(hunk_starts("@@ -x +3 @@"), None);
    assert_eq!(hunk_starts("@@ -1 +3"), None);
}

// ---- the requests (the TS fetches) ----------------------------------------

fn body(r: &Request) -> String {
    String::from_utf8(r.body.clone().unwrap_or_default().to_vec()).unwrap()
}

#[test]
fn every_request_is_the_ts_fetch() {
    let ws = "wks_1";
    let get = |r: Request, url: &str| {
        assert_eq!(
            (r.method.as_str(), r.url.as_str(), r.body.is_none()),
            ("GET", url, true)
        );
    };
    get(request::status(ws), "/api/workspaces/wks_1/git/status");
    get(
        request::diff(ws, "a b/ü.ts", DiffMode::Staged),
        "/api/workspaces/wks_1/git/diff?path=a%20b%2F%C3%BC.ts&mode=staged",
    );
    get(
        request::commit_draft(ws),
        "/api/workspaces/wks_1/git/commit-draft",
    );
    get(request::branches(ws), "/api/workspaces/wks_1/git/branches");
    get(
        request::compare_branches(ws, "main", "feat/x"),
        "/api/workspaces/wks_1/git/branch-compare?mode=log&base=main&head=feat%2Fx",
    );
    get(
        request::diff_with_worktree(ws, "o/m"),
        "/api/workspaces/wks_1/git/branch-compare?mode=diff&head=o%2Fm",
    );
    get(
        request::pr_status(ws),
        "/api/workspaces/wks_1/git/pr-status",
    );
    let post = |r: Request, route: &str, json: &str| {
        assert_eq!(r.method, "POST");
        assert_eq!(r.url, format!("/api/workspaces/wks_1/git/{route}"));
        assert_eq!(body(&r), json, "{route}");
        assert!(
            r.headers
                .iter()
                .any(|(k, v)| k == "Content-Type" && v == "application/json")
        );
    };
    let p = vec!["a".to_owned(), "b".to_owned()];
    post(
        request::stage(ws, &p, StageOp::Unstage),
        "stage",
        r#"{"paths":["a","b"],"op":"unstage"}"#,
    );
    post(
        request::stage(ws, &p, StageOp::Remove),
        "stage",
        r#"{"paths":["a","b"],"op":"remove"}"#,
    );
    post(
        request::commit(ws, "m", &p),
        "commit",
        r#"{"message":"m","stagePaths":["a","b"]}"#,
    );
    post(
        request::commit_message(ws, &p),
        "commit-message",
        r#"{"paths":["a","b"]}"#,
    );
    post(
        request::save_commit_draft(ws, "d"),
        "commit-draft",
        r#"{"message":"d"}"#,
    );
    post(
        request::checkout(ws, "x", false, Some("ignored")),
        "checkout",
        r#"{"name":"x"}"#,
    );
    post(
        request::checkout(ws, "x", true, None),
        "checkout",
        r#"{"name":"x","create":true}"#,
    );
    post(
        request::checkout(ws, "x", true, Some("main")),
        "checkout",
        r#"{"name":"x","create":true,"startPoint":"main"}"#,
    );
    post(
        request::rename_branch(ws, "a", "b"),
        "branch-rename",
        r#"{"oldName":"a","newName":"b"}"#,
    );
    post(
        request::delete_branch(ws, "x", DeleteTarget::Local { force: true }),
        "branch-delete",
        r#"{"name":"x","force":true}"#,
    );
    post(
        request::delete_branch(ws, "o/x", DeleteTarget::Remote),
        "branch-delete",
        r#"{"name":"o/x","remote":true}"#,
    );
    post(request::merge(ws, "x"), "merge", r#"{"name":"x"}"#);
    post(
        request::rebase(ws, "main", None),
        "rebase",
        r#"{"onto":"main"}"#,
    );
    post(
        request::rebase(ws, "main", Some("x")),
        "rebase",
        r#"{"onto":"main","checkoutBranch":"x"}"#,
    );
    post(
        request::remote(ws, RemoteOp::Fetch),
        "remote",
        r#"{"op":"fetch"}"#,
    );
    let pm = request::pull_merge(ws);
    assert_eq!((pm.method.as_str(), pm.body.is_none()), ("POST", true));
    let del = request::clear_commit_draft(ws);
    assert_eq!(del.method, "DELETE");
    assert_eq!(del.url, "/api/workspaces/wks_1/git/commit-draft");
}

#[test]
fn encode_uri_component_keeps_its_unreserved_marks() {
    assert_eq!(encode_uri_component("a-_.!~*'()z"), "a-_.!~*'()z");
    assert_eq!(encode_uri_component("/?&=#+ "), "%2F%3F%26%3D%23%2B%20");
    assert_eq!(encode_uri_component("😀"), "%F0%9F%98%80");
}

// ---- reading the answers --------------------------------------------------

fn res(status: u16, body: &str) -> Response {
    Response {
        status,
        headers: http::HeaderMap::new(),
        body: Bytes::from(body.to_owned()),
    }
}

#[test]
fn an_error_reads_j_error_else_the_status() {
    assert_eq!(
        error_text(&res(500, r#"{"error":"not a git repo"}"#)),
        "not a git repo"
    );
    assert_eq!(error_text(&res(502, "<html>")), "HTTP 502");
    assert_eq!(
        error_text(&res(400, r#"{"error":null}"#)),
        "HTTP 400",
        "`??` skips null"
    );
    assert_eq!(
        error_text(&res(400, r#"{"error":7}"#)),
        "7",
        "String(j.error)"
    );
    assert_eq!(error_text(&res(400, "\u{feff}{\"error\":\"bom\"}")), "bom");
}

#[test]
fn the_output_and_string_of() {
    assert_eq!(
        output_of(&res(200, r#"{"output":"done"}"#)).as_deref(),
        Some("done")
    );
    assert_eq!(output_of(&res(200, "")), None);
    assert_eq!(js_string_of(&json!([1, null, "a"])), "1,,a");
    assert_eq!(js_string_of(&json!({"a": 1})), "[object Object]");
    assert_eq!(js_string_of(&json!(true)), "true");
}

#[test]
fn a_merge_answer_reads_conflicts_message_and_output() {
    assert_eq!(
        merge_outcome(&res(200, r#"{"output":"ok"}"#)),
        Ok(Some("ok".into()))
    );
    let f = merge_outcome(&res(
        409,
        r#"{"kind":"conflicts","conflicts":["a","b"],"message":"m","output":"o"}"#,
    ))
    .unwrap_err();
    assert_eq!(f.conflicts, Some(vec!["a".into(), "b".into()]));
    assert_eq!(f.message, "m");
    assert_eq!(f.output.as_deref(), Some("o"));
    let f = merge_outcome(&res(
        409,
        r#"{"kind":"conflicts","conflicts":"x","error":"e"}"#,
    ))
    .unwrap_err();
    assert_eq!(f.conflicts, Some(Vec::new()), "a non-array is empty");
    assert_eq!(f.message, "e", "message ?? error");
    let f = merge_outcome(&res(500, "")).unwrap_err();
    assert_eq!((f.conflicts, f.message.as_str()), (None, "HTTP 500"));
}

/// An old timer that fires after a newer one was armed is ignored, and the
/// newer one stays armed (useGitStatus.ts: each run clears its timer).
#[test]
fn an_old_timer_firing_late_leaves_the_new_one_armed() {
    let mut p = StatusPoll::new(4000.);
    let a = p.run(false).unwrap();
    let (old, _) = p.settled(a, 1.).unwrap();
    let b = p.run(true).unwrap();
    let (new, _) = p.settled(b, 1.).unwrap();
    assert_eq!(p.tick(old, true), None);
    assert_eq!(p.armed(), Some(new));
    assert!(p.tick(new, true).is_some());
}

/// `summarizeGitError` cuts only past 200 UTF-16 units (page.tsx:98).
#[test]
fn the_one_liner_cuts_only_past_200_units() {
    use claudius_git::console::summarize_git_error;
    let exact = "x".repeat(200);
    assert_eq!(summarize_git_error(&exact), exact);
    let over = "x".repeat(201);
    assert_eq!(summarize_git_error(&over), format!("{exact}…"));
}

/// The console cuts only past 8000 units and counts the rest.
#[test]
fn the_console_cuts_only_past_8000_units() {
    let exact = "y".repeat(8000);
    assert_eq!(console_output(&exact), exact);
    let over = "y".repeat(8001);
    assert_eq!(
        console_output(&over),
        format!("{exact}\n… 1 more chars omitted")
    );
}
