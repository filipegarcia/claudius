//! `GitPage`'s handlers (app/[workspaceId]/git/page.tsx) without GPUI: each
//! test drives the model with the answers a request would get and checks
//! the requests, questions, errors and console lines the TS produces.

use claudius_git::branches::BranchAction;
use claudius_git::changes::{DiffMode, DiffSelection};
use claudius_git::commit_box::ComboStep;
use claudius_git::console::ConsoleStatus;
use claudius_git::data::{DeleteTarget, MergeFailure, RemoteOp, StageOp};
use claudius_git::page::{
    Busy, GitPage, Out, PULL_REFUSED, Reply, Req, SELECT_FIRST, Scope, Then, ahead_behind,
    branch_label, conflict_prompt, new_chat_url, pull_conflict_prompt, pull_resolve_title,
    pull_title, push_title, remote_delete_command,
};
use claudius_git::types::{
    BranchInfo, CommitOk, CommitPrefixConfig, DiffPayload, GitFileChange, GitStatusPayload, PrBadge,
};

fn scope() -> Scope {
    Scope {
        id: "wks_1".into(),
        name: "demo".into(),
        root_path: "/tmp/demo".into(),
        commit_prefix: Some(CommitPrefixConfig {
            enabled: true,
            branch_pattern: "feat/{ticket}-{slug}".into(),
            template: "feat #{ticket} - ".into(),
        }),
    }
}

fn status(branch: &str, files: Vec<GitFileChange>) -> GitStatusPayload {
    GitStatusPayload {
        is_repo: true,
        repo_root: Some("/tmp/demo".into()),
        branch: Some(branch.into()),
        head: Some("abc1234".into()),
        ahead: Some(2.),
        behind: Some(0.),
        files,
    }
}

fn files() -> Vec<GitFileChange> {
    vec![
        GitFileChange::new("a.ts", "M", " "),
        GitFileChange::new("b.ts", " ", "M"),
        GitFileChange::untracked("c.txt"),
    ]
}

/// The sends among `outs`.
fn sends(outs: &[Out]) -> Vec<(u64, Req)> {
    outs.iter()
        .filter_map(|o| match o {
            Out::Send(t, r) => Some((*t, r.clone())),
            _ => None,
        })
        .collect()
}

fn reqs(outs: &[Out]) -> Vec<Req> {
    sends(outs).into_iter().map(|(_, r)| r).collect()
}

/// The ticket of the one `req`-matching send.
fn ticket(outs: &[Out], f: impl Fn(&Req) -> bool) -> u64 {
    let found: Vec<u64> = sends(outs)
        .into_iter()
        .filter(|(_, r)| f(r))
        .map(|(t, _)| t)
        .collect();
    assert_eq!(found.len(), 1, "one matching send in {outs:?}");
    found[0]
}

/// A page mounted with `files` on `feat/4715-search`, the draft empty.
fn loaded(files: Vec<GitFileChange>) -> GitPage {
    let (mut p, outs) = GitPage::new(scope());
    assert_eq!(reqs(&outs), [Req::Status, Req::GetDraft]);
    let st = ticket(&outs, |r| *r == Req::Status);
    let dr = ticket(&outs, |r| *r == Req::GetDraft);
    p.reply(dr, Reply::Text(Ok(String::new())));
    let after = p.reply(st, Reply::Status(Ok(status("feat/4715-search", files)), 5.));
    assert!(reqs(&after).contains(&Req::PrStatus));
    p
}

fn last_console(p: &GitPage) -> (String, ConsoleStatus, String) {
    let e = p.console.last().expect("a console entry");
    (e.command.clone(), e.status, e.output.clone())
}

// ---- the header's texts (page.tsx:1015, :1582, :1700) ----------------------

#[test]
fn the_branch_label_is_the_branch_else_the_detached_sha() {
    let mut d = status("main", Vec::new());
    assert_eq!(branch_label(Some(&d)).as_deref(), Some("main"));
    d.branch = None;
    assert_eq!(
        branch_label(Some(&d)).as_deref(),
        Some("abc1234 (detached)")
    );
    d.head = None;
    assert_eq!(branch_label(Some(&d)), None);
    d.is_repo = false;
    d.branch = Some("x".into());
    assert_eq!(branch_label(Some(&d)), None, "not a repo");
}

#[test]
fn ahead_behind_hides_when_both_are_zero() {
    let mut d = status("main", Vec::new());
    assert_eq!(ahead_behind(Some(&d)).as_deref(), Some("↑2 ↓0"));
    d.ahead = Some(0.);
    assert_eq!(ahead_behind(Some(&d)), None);
    d.behind = Some(3.);
    assert_eq!(ahead_behind(Some(&d)).as_deref(), Some("↑0 ↓3"));
}

#[test]
fn the_sync_button_titles_count_the_commits() {
    assert_eq!(pull_title(0.), "git pull --ff-only");
    assert_eq!(pull_title(1.), "git pull --ff-only · 1 commit behind");
    assert_eq!(
        pull_resolve_title(2.),
        "git pull (merge) · 2 commits behind. On conflicts, opens Claude Code to resolve."
    );
    assert_eq!(push_title(0.), "git push (auto-set-upstream when needed)");
    assert_eq!(push_title(3.), "git push · 3 commits ahead");
}

#[test]
fn the_remote_delete_command_splits_the_remote() {
    assert_eq!(
        remote_delete_command("origin/feat/x"),
        "git push origin --delete feat/x"
    );
    assert_eq!(remote_delete_command("x"), "git push origin --delete x");
    assert_eq!(remote_delete_command("/x"), "git push origin --delete /x");
}

#[test]
fn the_conflict_prompts_use_merge_or_rebase_verbs() {
    let c = vec!["a.ts".to_owned()];
    let m = conflict_prompt(false, "feat", &c);
    assert!(m.starts_with("I just ran `git merge feat` in this workspace and there are merge conflicts in the following file(s):\n\n- a.ts\n\nPlease resolve them."));
    assert!(m.ends_with("  - Stop once every conflicted file has been staged."));
    let r = conflict_prompt(true, "x onto main", &c);
    assert!(r.starts_with("I just ran a rebase (x onto main) in this workspace"));
    assert!(r.contains("run `git rebase --continue`"));
    let p = pull_conflict_prompt(&c);
    assert!(p.starts_with("I just ran `git pull` in this workspace"));
    assert!(p.contains("Do NOT run `git merge --abort` or otherwise revert the pull."));
    assert_eq!(new_chat_url("a b"), "/?new=1&prompt=a%20b");
}

// ---- the status and its derived state (page.tsx:367) ----------------------

#[test]
fn the_first_status_arms_the_poll_loads_the_badge_and_renders_the_prefix() {
    let (mut p, outs) = GitPage::new(scope());
    let st = ticket(&outs, |r| *r == Req::Status);
    let after = p.reply(
        st,
        Reply::Status(Ok(status("feat/4715-search", files())), 2000.),
    );
    assert!(
        after
            .iter()
            .any(|o| matches!(o, Out::Arm { ms, .. } if *ms == 6000.)),
        "3x the 2 s run: {after:?}"
    );
    assert_eq!(p.commit_prefix().as_deref(), Some("feat #4715 - "));
    assert_eq!(
        p.commit_box.message(),
        "feat #4715 - ",
        "an empty box takes the prefix"
    );
    let pr = ticket(&after, |r| *r == Req::PrStatus);
    let badge = PrBadge {
        host: "github".into(),
        number: 7.,
        url: String::new(),
        title: None,
        state: "open".into(),
        checks: "none".into(),
    };
    p.reply(pr, Reply::Pr(Some(badge.clone())));
    assert_eq!(p.pr_badge, Some(badge));
}

#[test]
fn a_status_error_shows_in_the_banner_and_still_arms_the_poll() {
    let (mut p, outs) = GitPage::new(scope());
    let st = ticket(&outs, |r| *r == Req::Status);
    let after = p.reply(
        st,
        Reply::Status(Err("not a git repository\nmore".into()), 1.),
    );
    assert_eq!(p.banner(), Some("not a git repository"));
    assert!(
        after
            .iter()
            .any(|o| matches!(o, Out::Arm { ms, .. } if *ms == 4000.))
    );
    assert!(!p.sync_enabled(), "not a repo yet");
}

#[test]
fn the_status_error_wins_the_banner_over_the_op_error() {
    let mut p = loaded(files());
    p.op_error = Some("op".into());
    assert_eq!(p.banner(), Some("op"));
    p.status_error = Some("status".into());
    assert_eq!(p.banner(), Some("status"));
}

#[test]
fn a_new_status_drops_stale_checks_and_a_gone_selection() {
    let mut p = loaded(files());
    p.toggle_check("a.ts", true);
    p.toggle_check("b.ts", true);
    p.select_change(Some(DiffSelection::new("a.ts", DiffMode::Staged)));
    let outs = p.refresh();
    assert!(p.status_loading);
    let st = ticket(&outs, |r| *r == Req::Status);
    p.reply(
        st,
        Reply::Status(Ok(status("feat/4715-search", files()[1..].to_vec())), 1.),
    );
    assert_eq!(p.checked.paths(), ["b.ts"]);
    assert_eq!(p.selected, None);
    assert_eq!(p.diff.key, None);
    assert!(!p.status_loading);
}

#[test]
fn a_branch_change_reloads_the_badge_and_drops_the_old_one() {
    let mut p = loaded(files());
    p.pr_badge = Some(PrBadge {
        host: "github".into(),
        number: 1.,
        url: String::new(),
        title: None,
        state: "open".into(),
        checks: "none".into(),
    });
    let outs = p.refresh();
    let st = ticket(&outs, |r| *r == Req::Status);
    let after = p.reply(st, Reply::Status(Ok(status("main", files())), 1.));
    assert_eq!(p.pr_badge, None);
    let pr = ticket(&after, |r| *r == Req::PrStatus);
    let outs = p.refresh();
    let st = ticket(&outs, |r| *r == Req::Status);
    let again = p.reply(st, Reply::Status(Ok(status("main", files())), 1.));
    assert!(
        !reqs(&again).contains(&Req::PrStatus),
        "same branch: no reload"
    );
    p.reply(pr, Reply::Pr(None));
    assert_eq!(p.pr_badge, None);
}

#[test]
fn a_superseded_status_is_dropped_and_an_unmounted_page_hears_nothing() {
    let (mut p, outs) = GitPage::new(scope());
    let first = ticket(&outs, |r| *r == Req::Status);
    let forced = p.refresh();
    let second = ticket(&forced, |r| *r == Req::Status);
    assert!(
        p.reply(first, Reply::Status(Ok(status("x", files())), 1.))
            .is_empty()
    );
    assert!(p.data.is_none());
    p.dispose();
    assert!(
        p.reply(second, Reply::Status(Ok(status("x", files())), 1.))
            .is_empty()
    );
    assert!(p.data.is_none());
}

#[test]
fn the_timer_polls_only_while_visible() {
    let (mut p, outs) = GitPage::new(scope());
    let st = ticket(&outs, |r| *r == Req::Status);
    let after = p.reply(st, Reply::Status(Ok(status("main", files())), 1.));
    let timer = after
        .iter()
        .find_map(|o| match o {
            Out::Arm { timer, .. } => Some(*timer),
            _ => None,
        })
        .unwrap();
    assert!(p.timer_fired(timer, false).is_empty());
    assert_eq!(reqs(&p.became_visible()), [Req::Status]);
}

// ---- selection and the diff (GitFileView) ---------------------------------

#[test]
fn selecting_fetches_the_diff_once_and_drops_an_old_answer() {
    let mut p = loaded(files());
    let outs = p.select_change(Some(DiffSelection::new("a.ts", DiffMode::Staged)));
    let first = ticket(&outs, |r| {
        *r == Req::Diff {
            path: "a.ts".into(),
            mode: DiffMode::Staged,
        }
    });
    assert!(p.diff.loading);
    assert!(
        p.select_change(Some(DiffSelection::new("a.ts", DiffMode::Staged)))
            .is_empty(),
        "the same key: no refetch"
    );
    let outs = p.select_change(Some(DiffSelection::new("b.ts", DiffMode::Worktree)));
    let second = ticket(&outs, |r| matches!(r, Req::Diff { .. }));
    p.reply(first, Reply::Diff(Ok(DiffPayload::default())));
    assert!(p.diff.loading, "the old answer is dropped");
    p.reply(second, Reply::Diff(Err("bad path".into())));
    assert_eq!(p.diff.error.as_deref(), Some("bad path"));
    assert!(!p.diff.loading);
}

#[test]
fn the_mode_toggle_shows_for_a_partial_or_added_then_deleted_file() {
    let mut p = loaded(vec![
        GitFileChange::new("mm.ts", "M", "M"),
        GitFileChange::new("ad.ts", "A", "D"),
        GitFileChange::new("m.ts", "M", " "),
    ]);
    p.select_change(Some(DiffSelection::new("mm.ts", DiffMode::Staged)));
    assert!(p.needs_mode_toggle());
    let outs = p.set_diff_mode(DiffMode::Worktree);
    assert_eq!(
        reqs(&outs),
        [Req::Diff {
            path: "mm.ts".into(),
            mode: DiffMode::Worktree
        }]
    );
    p.select_change(Some(DiffSelection::new("ad.ts", DiffMode::Staged)));
    assert!(p.needs_mode_toggle());
    p.select_change(Some(DiffSelection::new("m.ts", DiffMode::Staged)));
    assert!(!p.needs_mode_toggle());
}

#[test]
fn select_all_takes_every_file_and_the_header_box_is_tri_state() {
    let mut p = loaded(files());
    assert_eq!(p.all_checked(), Some(false));
    p.toggle_check("a.ts", true);
    assert_eq!(p.all_checked(), None);
    p.toggle_all(true);
    assert_eq!(p.all_checked(), Some(true));
    assert_eq!(p.checked.paths(), ["a.ts", "b.ts", "c.txt"]);
    p.toggle_all(false);
    assert!(p.checked.is_empty());
    p.toggle_dir(&["b.ts".to_owned(), "a.ts".to_owned()], true);
    assert_eq!(p.checked.paths(), ["b.ts", "a.ts"], "insertion order");
}

#[test]
fn the_arrows_step_through_the_rows() {
    let mut p = loaded(files());
    let outs = p.step(true);
    assert_eq!(
        p.selected,
        Some(DiffSelection::new("a.ts", DiffMode::Staged))
    );
    assert_eq!(reqs(&outs).len(), 1);
    p.step(true);
    assert_eq!(
        p.selected,
        Some(DiffSelection::new("b.ts", DiffMode::Worktree))
    );
    p.step(false);
    p.step(false);
    assert_eq!(
        p.selected,
        Some(DiffSelection::new("a.ts", DiffMode::Staged))
    );
}

// ---- stage / unstage / discard (page.tsx:582, :651, :696, :772) -----------

#[test]
fn stage_with_nothing_checked_says_select_first() {
    let mut p = loaded(files());
    assert!(p.run_stage(StageOp::Stage).is_empty());
    assert_eq!(p.op_error.as_deref(), Some(SELECT_FIRST));
}

#[test]
fn stage_sends_the_checked_paths_and_refreshes_after() {
    let mut p = loaded(files());
    p.toggle_check("b.ts", true);
    let outs = p.run_stage(StageOp::Stage);
    assert_eq!(p.busy, Some(Busy::Stage));
    assert!(!p.stage_enabled() && !p.sync_enabled());
    let t = ticket(&outs, |r| {
        *r == Req::Stage {
            paths: vec!["b.ts".into()],
            op: StageOp::Stage,
        }
    });
    let after = p.reply(t, Reply::Done(Ok(())));
    assert_eq!(p.busy, None);
    assert_eq!(reqs(&after), [Req::Status]);
}

#[test]
fn unstage_failing_shows_the_error() {
    let mut p = loaded(files());
    p.toggle_check("a.ts", true);
    let outs = p.run_stage(StageOp::Unstage);
    assert_eq!(p.busy, Some(Busy::Unstage));
    let t = ticket(&outs, |r| {
        matches!(
            r,
            Req::Stage {
                op: StageOp::Unstage,
                ..
            }
        )
    });
    assert!(
        p.reply(t, Reply::Done(Err("index.lock exists".into())))
            .is_empty()
    );
    assert_eq!(p.op_error.as_deref(), Some("index.lock exists"));
    assert_eq!(p.busy, None);
}

#[test]
fn discard_asks_first_and_logs_the_files() {
    let mut p = loaded(files());
    p.toggle_check("a.ts", true);
    p.toggle_check("b.ts", true);
    assert!(p.run_stage(StageOp::Discard).is_empty());
    let q = p.question.clone().unwrap();
    assert_eq!(
        q.message,
        "Discard local changes in 2 files? This cannot be undone."
    );
    assert_eq!(q.then, Then::Discard(vec!["a.ts".into(), "b.ts".into()]));
    assert!(p.answer(false).is_empty());
    assert!(p.question.is_none() && p.busy.is_none());
    p.run_stage(StageOp::Discard);
    let outs = p.answer(true);
    assert_eq!(p.busy, Some(Busy::Discard));
    let t = ticket(&outs, |r| {
        matches!(
            r,
            Req::Stage {
                op: StageOp::Discard,
                ..
            }
        )
    });
    p.reply(t, Reply::Done(Ok(())));
    assert_eq!(
        last_console(&p),
        (
            "git discard".into(),
            ConsoleStatus::Ok,
            "Discarded changes in 2 files:\n  a.ts\n  b.ts".into()
        )
    );
}

#[test]
fn the_row_revert_runs_at_once_and_the_row_delete_asks() {
    let mut p = loaded(files());
    let outs = p.revert_single("b.ts");
    assert_eq!(p.deleting_path.as_deref(), Some("b.ts"));
    assert!(p.remove_single("a.ts").is_empty(), "one row at a time");
    assert!(p.question.is_none());
    let t = ticket(&outs, |r| {
        *r == Req::Stage {
            paths: vec!["b.ts".into()],
            op: StageOp::Discard,
        }
    });
    p.reply(t, Reply::Done(Ok(())));
    assert_eq!(p.deleting_path, None);
    assert_eq!(last_console(&p).2, "Reverted: b.ts");

    p.remove_single("c.txt");
    assert_eq!(
        p.question.as_ref().unwrap().message,
        "Delete c.txt from disk? This cannot be undone."
    );
    let outs = p.answer(true);
    let t = ticket(&outs, |r| {
        matches!(
            r,
            Req::Stage {
                op: StageOp::Remove,
                ..
            }
        )
    });
    p.reply(t, Reply::Done(Ok(())));
    assert_eq!(last_console(&p).2, "Deleted untracked file: c.txt");

    p.remove_single("a.ts");
    assert_eq!(
        p.question.as_ref().unwrap().message,
        "Delete a.ts? Runs `git rm` — stages the deletion, ready to commit."
    );
    let outs = p.answer(true);
    let t = ticket(&outs, |r| {
        matches!(
            r,
            Req::Stage {
                op: StageOp::Remove,
                ..
            }
        )
    });
    p.reply(t, Reply::Done(Err("git rm exited 1: nope".into())));
    assert_eq!(p.op_error.as_deref(), Some("git rm exited 1: nope"));
}

#[test]
fn delete_on_the_selected_row_asks_and_rollback_skips_untracked() {
    let mut p = loaded(files());
    assert!(p.delete_key().is_empty());
    assert!(p.question.is_none(), "nothing selected");
    p.select_change(Some(DiffSelection::new("b.ts", DiffMode::Worktree)));
    p.delete_key();
    assert!(
        matches!(&p.question.as_ref().unwrap().then, Then::Remove { path, untracked: false } if path == "b.ts")
    );
    p.answer(false);
    p.rollback_with_confirm("c.txt");
    assert!(p.question.is_none(), "untracked has no HEAD version");
    p.rollback_with_confirm("b.ts");
    assert_eq!(
        p.question.as_ref().unwrap().message,
        "Rollback b.ts? Local changes are discarded and the HEAD version restored."
    );
    let outs = p.answer(true);
    assert_eq!(
        reqs(&outs),
        [Req::Stage {
            paths: vec!["b.ts".into()],
            op: StageOp::Discard
        }]
    );
}

#[test]
fn a_single_stage_waits_for_a_busy_page() {
    let mut p = loaded(files());
    let outs = p.stage_single(StageOp::Stage, "b.ts");
    assert!(p.stage_single(StageOp::Unstage, "a.ts").is_empty());
    let t = ticket(&outs, |_| true);
    p.reply(t, Reply::Done(Err("e".into())));
    assert_eq!(last_console(&p).0, "git stage b.ts");
}

// ---- fetch / pull / push (page.tsx:457, :547) -----------------------------

#[test]
fn push_and_pull_ask_and_fetch_runs() {
    let mut p = loaded(files());
    p.run_remote(RemoteOp::Push);
    assert_eq!(
        p.question.as_ref().unwrap().message,
        "Push feat/4715-search (2 commits ahead) to remote?"
    );
    p.answer(false);
    p.run_remote(RemoteOp::Pull);
    assert_eq!(
        p.question.as_ref().unwrap().message,
        "Pull --ff-only into feat/4715-search? This aborts on non-fast-forward."
    );
    let outs = p.answer(true);
    assert_eq!(p.busy, Some(Busy::Pull));
    let t = ticket(&outs, |r| *r == Req::Remote { op: RemoteOp::Pull });
    p.reply(t, Reply::Output(Ok(Some("Already up to date.".into()))));
    assert_eq!(
        last_console(&p),
        (
            "git pull".into(),
            ConsoleStatus::Ok,
            "Already up to date.".into()
        )
    );
    let outs = p.run_remote(RemoteOp::Fetch);
    assert_eq!(p.busy, Some(Busy::Fetch));
    let t = ticket(&outs, |r| {
        *r == Req::Remote {
            op: RemoteOp::Fetch,
        }
    });
    p.reply(
        t,
        Reply::Output(Err("git fetch exited 128: no remote".into())),
    );
    assert_eq!(
        p.op_error.as_deref(),
        Some("git fetch exited 128: no remote")
    );
    assert_eq!(last_console(&p).2, "no remote");
    assert!(p.console.open);
}

#[test]
fn pull_with_claude_refuses_a_dirty_tree() {
    let mut p = loaded(files());
    assert!(p.run_pull_with_claude().is_empty());
    assert_eq!(p.op_error.as_deref(), Some(PULL_REFUSED));
    assert!(p.question.is_none());
}

#[test]
fn pull_with_claude_offers_a_chat_on_conflicts() {
    let mut p = loaded(Vec::new());
    p.run_pull_with_claude();
    assert_eq!(
        p.question.as_ref().unwrap().message,
        "Pull and merge upstream into feat/4715-search? If conflicts arise, Claude Code will open in a new chat to resolve them."
    );
    let outs = p.answer(true);
    let t = ticket(&outs, |r| *r == Req::PullMerge);
    let after = p.reply(
        t,
        Reply::Merge(Err(MergeFailure {
            conflicts: Some(vec!["a.ts".into()]),
            message: "conflicts".into(),
            output: Some("CONFLICT (content)".into()),
        })),
    );
    assert_eq!(reqs(&after), [Req::Status]);
    assert_eq!(
        last_console(&p).2,
        "Conflicts in 1 file(s):\n  a.ts\n\nCONFLICT (content)"
    );
    let q = p.question.clone().unwrap();
    assert_eq!(q.message, "Open Claude Code to resolve 1 conflict?");
    let Then::OpenChat(url) = q.then else {
        panic!("a chat")
    };
    assert_eq!(url, new_chat_url(&pull_conflict_prompt(&["a.ts".into()])));
    assert_eq!(p.answer(true), [Out::Navigate(url)]);
}

#[test]
fn a_plain_pull_merge_failure_is_the_op_error() {
    let mut p = loaded(Vec::new());
    p.run_pull_with_claude();
    let outs = p.answer(true);
    let t = ticket(&outs, |_| true);
    p.reply(
        t,
        Reply::Merge(Err(MergeFailure {
            conflicts: None,
            message: "no upstream".into(),
            output: Some("hint".into()),
        })),
    );
    assert_eq!(p.op_error.as_deref(), Some("no upstream"));
    assert_eq!(last_console(&p).2, "no upstream\n\nhint");
}

// ---- the commit box (page.tsx:904, CommitBox.tsx) -------------------------

#[test]
fn a_commit_sends_the_checked_paths_clears_the_draft_and_logs_the_sha() {
    let mut p = loaded(files());
    p.toggle_check("b.ts", true);
    p.commit_box.set_message("feat #4715 - search");
    let outs = p.submit();
    assert_eq!(p.busy, Some(Busy::Commit));
    assert!(p.submit().is_empty(), "busy");
    let t = ticket(&outs, |r| {
        *r == Req::Commit {
            message: "feat #4715 - search".into(),
            stage_paths: vec!["b.ts".into()],
        }
    });
    let after = p.reply(
        t,
        Reply::Commit(Ok(CommitOk {
            sha: Some("0123456789".into()),
            subject: Some("search".into()),
        })),
    );
    assert_eq!(reqs(&after), [Req::Status, Req::ClearDraft]);
    assert!(p.checked.is_empty());
    assert_eq!(p.commit_box.message(), "");
    assert_eq!(last_console(&p).2, "[0123456] search");
    let clear = ticket(&after, |r| *r == Req::ClearDraft);
    p.reply(clear, Reply::Done(Ok(())));
    assert_eq!(
        p.commit_box.message(),
        "",
        "the draft was already empty: no reset (CommitBox.tsx:92)"
    );
}

#[test]
fn clearing_a_saved_draft_resets_the_box_to_the_prefix() {
    let (mut p, outs) = GitPage::new(scope());
    let st = ticket(&outs, |r| *r == Req::Status);
    let dr = ticket(&outs, |r| *r == Req::GetDraft);
    p.reply(
        st,
        Reply::Status(Ok(status("feat/4715-search", files())), 1.),
    );
    p.reply(dr, Reply::Text(Ok("feat #4715 - wip".into())));
    assert_eq!(p.commit_box.message(), "feat #4715 - wip");
    p.toggle_check("a.ts", true);
    let outs = p.submit();
    let t = ticket(&outs, |_| true);
    let after = p.reply(t, Reply::Commit(Ok(CommitOk::default())));
    assert_eq!(p.commit_box.message(), "");
    let clear = ticket(&after, |r| *r == Req::ClearDraft);
    p.reply(clear, Reply::Done(Ok(())));
    assert_eq!(
        p.commit_box.message(),
        "feat #4715 - ",
        "the draft went: the prefix"
    );
}

#[test]
fn a_failed_commit_keeps_the_message_and_shows_the_short_error() {
    let mut p = loaded(files());
    p.toggle_check("b.ts", true);
    p.commit_box.set_message("m");
    let outs = p.submit();
    let t = ticket(&outs, |_| true);
    p.reply(
        t,
        Reply::Commit(Err("git commit exited 1: hook failed\nline two".into())),
    );
    assert_eq!(p.commit_box.error.as_deref(), Some("hook failed"));
    assert_eq!(p.commit_box.message(), "m");
    assert_eq!(p.checked.paths(), ["b.ts"]);
    assert_eq!(last_console(&p).1, ConsoleStatus::Error);
}

#[test]
fn generate_prefixes_the_message_and_saves_it_as_the_draft() {
    let mut p = loaded(files());
    assert!(p.generate().is_empty(), "nothing checked");
    p.toggle_check("b.ts", true);
    let outs = p.generate();
    let t = ticket(&outs, |r| {
        *r == Req::CommitMessage {
            paths: vec!["b.ts".into()],
        }
    });
    let after = p.reply(t, Reply::Text(Ok("add search".into())));
    let save = ticket(&after, |r| {
        *r == Req::SaveDraft {
            message: "feat #4715 - add search".into(),
        }
    });
    assert!(p.commit_box.generating);
    p.reply(save, Reply::Done(Ok(())));
    assert!(!p.commit_box.generating);
    assert_eq!(p.draft_message, "feat #4715 - add search");
    assert_eq!(p.commit_box.message(), "feat #4715 - add search");
}

#[test]
fn the_combo_generates_commits_clears_and_pushes() {
    let mut p = loaded(files());
    p.toggle_check("b.ts", true);
    p.commit_box.set_message("");
    let outs = p.combo();
    assert_eq!(p.commit_box.combo_step, Some(ComboStep::Generate));
    let t = ticket(&outs, |r| matches!(r, Req::CommitMessage { .. }));
    let outs = p.reply(t, Reply::Text(Ok("x".into())));
    let t = ticket(&outs, |r| matches!(r, Req::SaveDraft { .. }));
    let outs = p.reply(t, Reply::Done(Ok(())));
    assert_eq!(p.commit_box.combo_step, Some(ComboStep::Commit));
    let t = ticket(&outs, |r| {
        *r == Req::Commit {
            message: "feat #4715 - x".into(),
            stage_paths: vec!["b.ts".into()],
        }
    });
    let outs = p.reply(t, Reply::Commit(Ok(CommitOk::default())));
    let t = ticket(&outs, |r| *r == Req::ClearDraft);
    let outs = p.reply(t, Reply::Done(Ok(())));
    assert_eq!(p.commit_box.combo_step, Some(ComboStep::Push));
    assert_eq!(p.busy, Some(Busy::Push));
    let t = ticket(&outs, |r| *r == Req::Remote { op: RemoteOp::Push });
    p.reply(t, Reply::Output(Err("git push exited 1: rejected".into())));
    assert_eq!(
        p.commit_box.error.as_deref(),
        Some("Committed locally; push failed: rejected")
    );
    assert_eq!(p.commit_box.combo_step, None);
    assert_eq!(p.busy, None);
}

#[test]
fn stopping_the_combo_ends_it_after_the_current_step() {
    let mut p = loaded(files());
    p.toggle_check("b.ts", true);
    p.commit_box.set_message("");
    let outs = p.combo();
    assert!(p.combo().is_empty(), "the second click is Stop");
    assert!(p.commit_box.cancelling);
    assert!(p.combo().is_empty(), "cancelling: ignored");
    let t = ticket(&outs, |_| true);
    assert!(p.reply(t, Reply::Text(Ok("x".into()))).is_empty());
    assert_eq!(p.commit_box.combo_step, None);
    assert!(!p.commit_box.cancelling);
}

#[test]
fn the_saved_draft_fills_the_box_on_mount() {
    let (mut p, outs) = GitPage::new(scope());
    let dr = ticket(&outs, |r| *r == Req::GetDraft);
    p.reply(dr, Reply::Text(Ok("wip message".into())));
    assert_eq!(p.commit_box.message(), "wip message");
    let (mut q, outs) = GitPage::new(scope());
    let dr = ticket(&outs, |r| *r == Req::GetDraft);
    q.reply(dr, Reply::Text(Err("HTTP 500".into())));
    assert_eq!(q.commit_box.message(), "", "an error is ignored");
}

// ---- the branch popover (page.tsx:1037-1567) ------------------------------

fn branches() -> Vec<BranchInfo> {
    let b = |name: &str, kind: &str, current| BranchInfo {
        name: name.into(),
        kind: kind.into(),
        sha: "abc".into(),
        upstream: None,
        committer_date: String::new(),
        current,
    };
    vec![
        b("feat/4715-search", "local", true),
        b("main", "local", false),
        b("origin/main", "remote", false),
    ]
}

fn open_popover(p: &mut GitPage) {
    let outs = p.toggle_branches();
    let t = ticket(&outs, |r| *r == Req::Branches);
    p.reply(t, Reply::Branches(Ok(branches())));
    assert_eq!(p.branches.branches.len(), 3);
}

#[test]
fn the_chip_opens_only_on_a_branch_and_while_idle() {
    let (mut p, _) = GitPage::new(scope());
    assert!(p.toggle_branches().is_empty(), "no branch yet");
    let mut p = loaded(files());
    p.busy = Some(Busy::Fetch);
    assert!(p.toggle_branches().is_empty());
    p.busy = None;
    open_popover(&mut p);
    assert!(p.toggle_branches().is_empty());
    assert!(!p.branches.open);
}

#[test]
fn checkout_switches_clears_the_checks_and_closes_the_popover() {
    let mut p = loaded(files());
    p.toggle_check("a.ts", true);
    open_popover(&mut p);
    let outs = p.branch_action(BranchAction::Checkout("main".into()));
    assert_eq!(p.busy, Some(Busy::Checkout));
    let t = ticket(&outs, |r| {
        *r == Req::Checkout {
            name: "main".into(),
            create: false,
            start_point: None,
        }
    });
    let after = p.reply(t, Reply::Done(Ok(())));
    assert_eq!(reqs(&after), [Req::Status]);
    assert!(p.checked.is_empty());
    assert!(!p.branches.open);
    assert_eq!(
        last_console(&p),
        (
            "git checkout main".into(),
            ConsoleStatus::Ok,
            "Switched to branch 'main'".into()
        )
    );
}

#[test]
fn a_failed_checkout_shows_the_short_error_in_the_popover() {
    let mut p = loaded(files());
    open_popover(&mut p);
    let outs = p.branch_action(BranchAction::Checkout("main".into()));
    let t = ticket(&outs, |_| true);
    p.reply(
        t,
        Reply::Done(Err(
            "git checkout exited 1: error: local changes\nAborting".into()
        )),
    );
    assert_eq!(
        p.branches.action_error.as_deref(),
        Some("error: local changes")
    );
    assert!(p.branches.open);
    assert_eq!(p.busy, None);
}

#[test]
fn a_busy_page_refuses_a_branch_op_with_busy_text() {
    let mut p = loaded(files());
    open_popover(&mut p);
    p.busy = Some(Busy::Stage);
    assert!(
        p.branch_action(BranchAction::Merge("main".into()))
            .is_empty()
    );
    assert_eq!(p.branches.action_error.as_deref(), Some("busy: stage"));
}

#[test]
fn a_new_branch_asks_its_name_and_logs_the_start_point() {
    let mut p = loaded(files());
    open_popover(&mut p);
    assert!(
        p.branch_action(BranchAction::NewBranch {
            start_point: Some("main".into())
        })
        .is_empty()
    );
    assert!(p.branches.prompt.is_some());
    let outs = p.answer_branch_prompt(Some("topic"));
    let t = ticket(&outs, |r| {
        *r == Req::Checkout {
            name: "topic".into(),
            create: true,
            start_point: Some("main".into()),
        }
    });
    p.reply(t, Reply::Done(Ok(())));
    assert_eq!(
        last_console(&p),
        (
            "git checkout -b topic".into(),
            ConsoleStatus::Ok,
            "Created and switched to 'topic' from 'main'".into()
        )
    );
    assert!(p.answer_branch_prompt(None).is_empty(), "no prompt open");
}

#[test]
fn compare_keeps_the_popover_open_and_opens_the_console() {
    let mut p = loaded(files());
    open_popover(&mut p);
    let outs = p.branch_action(BranchAction::Compare {
        base: "feat/4715-search".into(),
        head: "main".into(),
    });
    assert_eq!(p.busy, None, "read-only: no busy");
    let t = ticket(&outs, |r| {
        *r == Req::Compare {
            base: "feat/4715-search".into(),
            head: "main".into(),
        }
    });
    let after = p.reply(t, Reply::Output(Ok(Some("abc subject".into()))));
    assert!(reqs(&after).is_empty(), "no refresh");
    assert!(p.console.open);
    assert!(p.branches.open);
    assert_eq!(last_console(&p).0, "git log feat/4715-search..main");
}

#[test]
fn rename_logs_the_fallback_when_git_says_nothing() {
    let mut p = loaded(files());
    open_popover(&mut p);
    p.branch_action(BranchAction::Rename("main".into()));
    let outs = p.answer_branch_prompt(Some("trunk"));
    assert_eq!(p.busy, Some(Busy::Rename));
    let t = ticket(&outs, |r| {
        *r == Req::Rename {
            old_name: "main".into(),
            new_name: "trunk".into(),
        }
    });
    p.reply(t, Reply::Output(Ok(None)));
    assert_eq!(
        last_console(&p),
        (
            "git branch -m main trunk".into(),
            ConsoleStatus::Ok,
            "Renamed 'main' → 'trunk'".into()
        )
    );
}

#[test]
fn deleting_an_unmerged_branch_asks_to_force() {
    let mut p = loaded(files());
    open_popover(&mut p);
    p.branch_action(BranchAction::DeleteLocal("main".into()));
    assert_eq!(
        p.question.as_ref().unwrap().message,
        "Delete local branch 'main'?"
    );
    let outs = p.answer(true);
    let t = ticket(&outs, |r| {
        *r == Req::Delete {
            name: "main".into(),
            target: DeleteTarget::Local { force: false },
        }
    });
    let err = "git branch exited 1: error: the branch 'main' is not fully merged";
    p.reply(t, Reply::Output(Err(err.into())));
    let q = p.question.clone().unwrap();
    assert_eq!(
        q.message,
        "'main' is not fully merged. Force-delete anyway? Unmerged commits will be lost."
    );
    let outs = p.answer(true);
    let t = ticket(&outs, |r| {
        *r == Req::Delete {
            name: "main".into(),
            target: DeleteTarget::Local { force: true },
        }
    });
    let after = p.reply(t, Reply::Output(Ok(Some("Deleted branch main".into()))));
    assert!(reqs(&after).contains(&Req::Branches), "the list reloads");
    assert_eq!(last_console(&p).0, "git branch -D main");
}

/// A non-ok local delete hands the popover the FULL text (page.tsx:1401):
/// git's refusal can sit below the first line.
#[test]
fn the_local_delete_refusal_is_read_in_full() {
    let mut p = loaded(files());
    open_popover(&mut p);
    p.branch_action(BranchAction::DeleteLocal("main".into()));
    let outs = p.answer(true);
    let t = ticket(&outs, |_| true);
    let err = "warning: deleting branch 'main' that has been merged to\nerror: The branch 'main' has not yet been merged";
    p.reply(t, Reply::Output(Err(err.into())));
    assert!(matches!(
        &p.question.as_ref().expect("asks to force").then,
        Then::ForceDelete { error, .. } if error == err
    ));
    p.answer(false);
    assert_eq!(p.branches.action_error.as_deref(), Some(err));
}

#[test]
fn declining_the_force_shows_the_refusal() {
    let mut p = loaded(files());
    open_popover(&mut p);
    p.branch_action(BranchAction::DeleteLocal("main".into()));
    let outs = p.answer(true);
    let t = ticket(&outs, |_| true);
    p.reply(t, Reply::Output(Err("not fully merged".into())));
    p.answer(false);
    assert_eq!(p.branches.action_error.as_deref(), Some("not fully merged"));
    assert!(p.branches.busy_name.is_none());
}

#[test]
fn a_remote_delete_runs_git_push_delete() {
    let mut p = loaded(files());
    open_popover(&mut p);
    p.branch_action(BranchAction::DeleteRemote("origin/main".into()));
    let outs = p.answer(true);
    let t = ticket(&outs, |r| {
        *r == Req::Delete {
            name: "origin/main".into(),
            target: DeleteTarget::Remote,
        }
    });
    p.reply(t, Reply::Output(Ok(None)));
    assert_eq!(
        last_console(&p),
        (
            "git push origin --delete main".into(),
            ConsoleStatus::Ok,
            "Deleted remote 'origin/main'".into()
        )
    );
    assert!(!p.branches.open);
}

#[test]
fn a_merge_conflict_offers_a_chat_and_the_popover_hears_the_count() {
    let mut p = loaded(files());
    p.toggle_check("a.ts", true);
    open_popover(&mut p);
    let outs = p.branch_action(BranchAction::Merge("main".into()));
    assert_eq!(p.busy, Some(Busy::Merge));
    let t = ticket(&outs, |r| {
        *r == Req::Merge {
            name: "main".into(),
        }
    });
    let after = p.reply(
        t,
        Reply::Merge(Err(MergeFailure {
            conflicts: Some(vec!["a.ts".into(), "b.ts".into()]),
            message: "conflicts".into(),
            output: None,
        })),
    );
    assert!(reqs(&after).contains(&Req::Status));
    assert!(p.checked.is_empty());
    assert_eq!(
        p.question.as_ref().unwrap().message,
        "Open Claude Code to resolve 2 merge conflicts?"
    );
    assert_eq!(
        p.branches.action_error.as_deref(),
        Some("2 conflicts during merge")
    );
    assert_eq!(last_console(&p).0, "git merge --no-rebase --no-edit main");
}

#[test]
fn checkout_and_rebase_names_both_branches() {
    let mut p = loaded(files());
    open_popover(&mut p);
    let outs = p.branch_action(BranchAction::CheckoutAndRebase {
        branch: "main".into(),
        onto: "feat/4715-search".into(),
    });
    assert_eq!(p.busy, Some(Busy::Rebase));
    let t = ticket(&outs, |r| {
        *r == Req::Rebase {
            onto: "feat/4715-search".into(),
            checkout_branch: Some("main".into()),
        }
    });
    p.reply(
        t,
        Reply::Merge(Err(MergeFailure {
            conflicts: Some(vec!["x".into()]),
            message: String::new(),
            output: None,
        })),
    );
    let Then::OpenChat(url) = p.question.clone().unwrap().then else {
        panic!("a chat")
    };
    assert_eq!(
        url,
        new_chat_url(&conflict_prompt(
            true,
            "main onto feat/4715-search",
            &["x".into()]
        ))
    );
    assert_eq!(
        last_console(&p).0,
        "git switch main && git rebase feat/4715-search"
    );
}

#[test]
fn update_and_push_from_the_menu_run_without_asking() {
    let mut p = loaded(files());
    open_popover(&mut p);
    let outs = p.branch_action(BranchAction::Update);
    assert_eq!(p.busy, Some(Busy::Pull));
    assert!(p.question.is_none());
    let t = ticket(&outs, |r| *r == Req::Remote { op: RemoteOp::Pull });
    p.reply(t, Reply::Output(Ok(None)));
    assert_eq!(last_console(&p).0, "git pull --ff-only");
    assert!(!p.branches.open);
    open_popover(&mut p);
    let outs = p.branch_action(BranchAction::Push);
    let t = ticket(&outs, |r| *r == Req::Remote { op: RemoteOp::Push });
    p.reply(t, Reply::Output(Err("git push exited 1: denied\nx".into())));
    assert_eq!(p.branches.action_error.as_deref(), Some("denied"));
}

#[test]
fn show_diff_logs_git_diff() {
    let mut p = loaded(files());
    open_popover(&mut p);
    let outs = p.branch_action(BranchAction::ShowDiff("main".into()));
    let t = ticket(&outs, |r| {
        *r == Req::DiffWithWorktree {
            head: "main".into(),
        }
    });
    p.reply(t, Reply::Output(Err("git diff exited 128: bad".into())));
    assert_eq!(p.branches.action_error.as_deref(), Some("bad"));
    assert_eq!(last_console(&p).0, "git diff main");
}

/// A successful rebase clears the checks and the selection
/// (page.tsx:1294); a merge only refreshes (page.tsx:1233).
#[test]
fn a_rebase_clears_the_checks_and_a_merge_keeps_them() {
    let mut p = loaded(files());
    p.toggle_check("a.ts", true);
    p.select_change(Some(DiffSelection::new("a.ts", DiffMode::Staged)));
    open_popover(&mut p);
    let outs = p.branch_action(BranchAction::Merge("main".into()));
    let t = ticket(&outs, |r| matches!(r, Req::Merge { .. }));
    let after = p.reply(t, Reply::Merge(Ok(Some("Fast-forward".into()))));
    assert!(reqs(&after).contains(&Req::Status));
    assert_eq!(p.checked.paths(), ["a.ts"], "a merge keeps the checks");
    assert!(p.selected.is_some());
    assert_eq!(last_console(&p).2, "Fast-forward");
    open_popover(&mut p);
    let outs = p.branch_action(BranchAction::RebaseCurrentOnto("main".into()));
    let t = ticket(&outs, |r| {
        *r == Req::Rebase {
            onto: "main".into(),
            checkout_branch: None,
        }
    });
    p.reply(t, Reply::Merge(Ok(None)));
    assert!(p.checked.is_empty(), "a rebase clears them");
    assert_eq!(p.selected, None);
    assert_eq!(last_console(&p).0, "git rebase main");
    assert!(!p.branches.open);
}

/// `runRevertSingle` waits for a row already in flight (page.tsx:655).
#[test]
fn a_row_revert_waits_for_the_row_in_flight() {
    let mut p = loaded(files());
    p.revert_single("a.ts");
    assert!(p.revert_single("b.ts").is_empty());
    assert_eq!(p.deleting_path.as_deref(), Some("a.ts"));
    p.busy = Some(Busy::Fetch);
    p.deleting_path = None;
    assert!(p.revert_single("b.ts").is_empty(), "busy");
}
