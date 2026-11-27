//! The Git page in a headless window (`TestAppContext`, CoreText) over the
//! fixture: picking a change shows its diff, stage / unstage / discard send
//! their requests, the commit gate, the draft, the branch switcher's
//! checkout, the errors as the TS shows them, the poll and the keys.
//! macOS (the CoreText text system).

#![cfg(target_os = "macos")]

use std::sync::{Arc, Mutex};
use std::time::Duration;

use claudius_git::changes::DiffMode;
use claudius_git::console::ConsoleStatus;
use claudius_git::data::{DeleteTarget, GitData, GitFuture, MergeFuture, RemoteOp, StageOp};
use claudius_git::fixture::{Call, FixtureGitData};
use claudius_git::page::{GitPage, Scope};
use claudius_git::types::CommitPrefixConfig;
use claudius_git::types::{BranchInfo, CommitOk, DiffPayload, GitStatusPayload, PrBadge};
use claudius_git::view::{GitEvent, GitScreen};
use claudius_gpui_theme::ThemeName;
use futures::FutureExt as _;
use futures::channel::oneshot;
use futures::future::BoxFuture;
use gpui::{
    AppContext as _, Entity, Modifiers, TestAppContext, TestDispatcher, VisualTestContext,
    WindowOptions, px, size,
};
use gpui_apple::AppleTextSystem;

const WS: &str = "wks_3f2a9c81d0e4";
const PAGE: &str = "app/[workspaceId]/git/page.tsx";
const LIST: &str = "components/git/ChangesList.tsx";
const VIEWER: &str = "components/git/DiffViewer.tsx";
const POLL: &str = "lib/client/git-poll.ts";

struct Ui {
    screen: Entity<GitScreen>,
    data: FixtureGitData,
    events: Arc<Mutex<Vec<GitEvent>>>,
    cx: VisualTestContext,
}

fn app() -> TestAppContext {
    let cx = TestAppContext::build_with_text_system(
        TestDispatcher::new(0),
        None,
        Arc::new(AppleTextSystem::new()),
    );
    cx.update(|cx| {
        gpui_kit::init(cx);
        claudius_gpui_theme::init(ThemeName::Dark, cx);
        claudius_git::view::bind(cx);
    });
    cx
}

fn scope(prefix: Option<CommitPrefixConfig>) -> Scope {
    Scope {
        id: WS.into(),
        name: "claudius".into(),
        root_path: "/Users/demo/src/claudius".into(),
        commit_prefix: prefix,
    }
}

fn open(app: &mut TestAppContext) -> Ui {
    open_with(app, FixtureGitData::demo(), None)
}

fn open_with(
    app: &mut TestAppContext,
    data: FixtureGitData,
    prefix: Option<CommitPrefixConfig>,
) -> Ui {
    let git: Arc<dyn GitData> = Arc::new(data.clone());
    open_over(app, data, git, prefix)
}

/// The page over `git` (`data` is the fixture behind it, for its calls).
fn open_over(
    app: &mut TestAppContext,
    data: FixtureGitData,
    git: Arc<dyn GitData>,
    prefix: Option<CommitPrefixConfig>,
) -> Ui {
    let (handle, screen) = app
        .update(|cx| {
            gpui_kit::open_window(WindowOptions::default(), cx, |_window, cx| {
                cx.new(|cx| GitScreen::new(git, cx))
            })
        })
        .unwrap();
    let mut cx = VisualTestContext::from_window(handle, app);
    cx.simulate_resize(size(px(1440.), px(900.)));
    let events = Arc::new(Mutex::new(Vec::new()));
    let sink = events.clone();
    cx.update(|_, cx| {
        cx.subscribe(&screen, move |_, ev: &GitEvent, _| {
            sink.lock().unwrap().push(ev.clone());
        })
        .detach();
        screen.update(cx, |s, cx| s.sync(Some(scope(prefix)), ThemeName::Dark, cx));
    });
    let mut ui = Ui {
        screen,
        data,
        events,
        cx,
    };
    ui.settle();
    ui
}

impl Ui {
    fn settle(&mut self) {
        for _ in 0..3 {
            self.cx.run_until_parked();
            self.cx.update(|window, cx| {
                window.refresh();
                window.draw(cx).clear(cx);
            });
        }
        self.cx.run_until_parked();
    }

    fn drawn(&mut self, selector: &str) -> bool {
        let s: &'static str = Box::leak(selector.to_owned().into_boxed_str());
        self.cx.debug_bounds(s).is_some()
    }

    fn click(&mut self, selector: &str) {
        let s: &'static str = Box::leak(selector.to_owned().into_boxed_str());
        let b = self
            .cx
            .debug_bounds(s)
            .unwrap_or_else(|| panic!("{selector} isn't on screen"));
        self.cx.simulate_click(b.center(), Modifiers::none());
        self.settle();
    }

    fn keys(&mut self, keystrokes: &str) {
        self.cx.simulate_keystrokes(keystrokes);
        self.settle();
    }

    fn type_text(&mut self, text: &str) {
        self.cx.simulate_input(text);
        self.settle();
    }

    fn page<T>(&mut self, f: impl FnOnce(&GitPage) -> T) -> T {
        let screen = self.screen.clone();
        self.cx
            .read(|cx| f(screen.read(cx).page().expect("a mounted page")))
    }

    fn remount(&mut self) {
        let screen = self.screen.clone();
        self.cx.update(|_, cx| {
            screen.update(cx, |s, cx| {
                s.sync(None, ThemeName::Dark, cx);
                s.sync(Some(scope(None)), ThemeName::Dark, cx);
            })
        });
        self.settle();
    }

    fn check(&mut self, mode: &str, path: &str) {
        self.click(&format!("change-check-{mode}-{path}"));
    }

    fn last_console(&mut self) -> (String, ConsoleStatus, String) {
        self.page(|p| {
            let e = p.console.entries.last().expect("a console entry");
            (e.command.clone(), e.status, e.output.clone())
        })
    }
}

#[test]
fn the_page_loads_the_status_the_draft_and_the_badge() {
    let mut app = app();
    let mut ui = open(&mut app);
    assert!(ui.drawn("git-screen"));
    assert!(ui.drawn("changes-list"));
    let calls = ui.data.calls();
    assert_eq!(calls[0], Call::Status);
    assert!(calls.contains(&Call::GetDraft));
    assert!(calls.contains(&Call::PrStatus));
    // The groups and their rows (a partial file in Staged only: its
    // unstaged side is the diff's toggle).
    for sel in [
        "changes-group-staged",
        "changes-group-unstaged",
        "changes-group-untracked",
        &format!("change-row-staged-{PAGE}"),
        &format!("change-row-worktree-{LIST}"),
        &format!("change-row-untracked-{POLL}"),
        "pr-badge",
        "ahead-behind",
        "pull-badge",
        "push-badge",
        "diff-none",
    ] {
        assert!(ui.drawn(sel), "{sel}");
    }
    assert_eq!(
        ui.page(|p| p.pr_badge.as_ref().map(|b| b.number)),
        Some(4716.)
    );
}

#[test]
fn selecting_a_change_shows_its_diff() {
    let mut app = app();
    let mut ui = open(&mut app);
    ui.data.clear_calls();
    ui.click(&format!("change-row-staged-{PAGE}"));
    assert_eq!(
        ui.data.actions(),
        vec![Call::Diff {
            path: PAGE.into(),
            mode: DiffMode::Staged
        }]
    );
    assert!(ui.drawn("diff-pane"));
    assert!(ui.drawn("diff-rows"));
    assert!(ui.drawn("diff-row-0"));
    // A partial file gets the Staged / Unstaged toggle.
    assert!(ui.drawn("diff-mode-toggle"));
    let rows = ui.page(|p| {
        let d = p.diff.payload.clone().unwrap();
        claudius_git::diff::parse_unified_diff(&d.diff).len()
    });
    assert!(ui.drawn(&format!("diff-row-{}", rows - 1)));
    ui.data.clear_calls();
    ui.click("diff-mode-worktree");
    assert_eq!(
        ui.data.actions(),
        vec![Call::Diff {
            path: PAGE.into(),
            mode: DiffMode::Worktree
        }]
    );
    // A plain change shows its mode as a label.
    ui.click(&format!("change-row-worktree-{LIST}"));
    assert!(ui.drawn("diff-mode-label"));
    assert!(!ui.drawn("diff-mode-toggle"));
}

#[test]
fn a_diff_error_shows_in_the_pane() {
    let mut app = app();
    let mut ui = open(&mut app);
    ui.data.fail("diff", "fatal: bad revision 'HEAD'");
    ui.click(&format!("change-row-worktree-{LIST}"));
    assert!(ui.drawn("diff-error"));
    assert_eq!(
        ui.page(|p| p.diff.error.clone()),
        Some("fatal: bad revision 'HEAD'".into())
    );
}

#[test]
fn the_arrows_walk_the_changes() {
    let mut app = app();
    let mut ui = open(&mut app);
    ui.click(&format!("change-row-staged-{PAGE}"));
    assert!(!ui.drawn(&format!("change-row-worktree-{PAGE}")));
    // Past the staged group's last row: the first changed one.
    ui.keys("down");
    let sel = ui.page(|p| p.selected.clone().unwrap());
    assert_eq!((sel.path.as_str(), sel.mode), (LIST, DiffMode::Worktree));
    ui.keys("up");
    let sel = ui.page(|p| p.selected.clone().unwrap());
    assert_eq!((sel.path.as_str(), sel.mode), (PAGE, DiffMode::Staged));
}

#[test]
fn stage_unstage_and_discard_send_their_requests() {
    let mut app = app();
    let mut ui = open(&mut app);
    // Nothing checked: the buttons do nothing.
    ui.data.clear_calls();
    ui.click("git-stage");
    assert!(ui.data.actions().is_empty());

    ui.check("worktree", LIST);
    ui.data.clear_calls();
    ui.click("git-stage");
    assert_eq!(
        ui.data.calls()[0],
        Call::Stage {
            paths: vec![LIST.into()],
            op: StageOp::Stage
        }
    );
    // The refresh moved it to the staged group; it stays checked.
    assert!(ui.data.calls().contains(&Call::Status));
    assert!(ui.drawn(&format!("change-row-staged-{LIST}")));
    assert!(!ui.drawn(&format!("change-row-worktree-{LIST}")));
    assert!(ui.page(|p| p.checked.contains(LIST)));

    ui.data.clear_calls();
    ui.click("git-unstage");
    assert_eq!(
        ui.data.calls()[0],
        Call::Stage {
            paths: vec![LIST.into()],
            op: StageOp::Unstage
        }
    );
    assert!(ui.drawn(&format!("change-row-worktree-{LIST}")));

    // Discard asks first; Cancel sends nothing.
    ui.data.clear_calls();
    ui.click("git-rollback");
    assert!(ui.drawn("git-question"));
    assert_eq!(
        ui.page(|p| p.question.clone().unwrap().message),
        "Discard local changes in 1 file? This cannot be undone."
    );
    ui.click("git-question-cancel");
    assert!(!ui.drawn("git-question"));
    assert!(ui.data.actions().is_empty());
    ui.click("git-rollback");
    ui.click("git-question-ok");
    assert_eq!(
        ui.data.calls()[0],
        Call::Stage {
            paths: vec![LIST.into()],
            op: StageOp::Discard
        }
    );
    assert!(!ui.drawn(&format!("change-row-worktree-{LIST}")));
    assert_eq!(
        ui.last_console(),
        (
            "git discard".into(),
            ConsoleStatus::Ok,
            format!("Discarded changes in 1 file:\n  {LIST}")
        )
    );
}

#[test]
fn the_row_buttons_revert_and_delete() {
    let mut app = app();
    let mut ui = open(&mut app);
    // Revert: no question.
    ui.data.clear_calls();
    ui.click(&format!("changes-revert-worktree-{VIEWER}"));
    assert_eq!(
        ui.data.calls()[0],
        Call::Stage {
            paths: vec![VIEWER.into()],
            op: StageOp::Discard
        }
    );
    assert_eq!(
        ui.last_console(),
        (
            "git discard".into(),
            ConsoleStatus::Ok,
            format!("Reverted: {VIEWER}")
        )
    );
    // Delete asks, then removes.
    ui.data.clear_calls();
    ui.click(&format!("changes-delete-untracked-{POLL}"));
    assert_eq!(
        ui.page(|p| p.question.clone().unwrap().message),
        format!("Delete {POLL} from disk? This cannot be undone.")
    );
    ui.click("git-question-ok");
    assert_eq!(
        ui.data.calls()[0],
        Call::Stage {
            paths: vec![POLL.into()],
            op: StageOp::Remove
        }
    );
    assert!(!ui.drawn(&format!("change-row-untracked-{POLL}")));
    assert_eq!(
        ui.last_console(),
        (
            "git remove".into(),
            ConsoleStatus::Ok,
            format!("Deleted untracked file: {POLL}")
        )
    );
}

#[test]
fn the_commit_gate() {
    let mut app = app();
    let mut ui = open(&mut app);
    ui.data.clear_calls();
    // No file, no message: Commit is inert.
    ui.click("commit-button");
    assert!(ui.data.actions().is_empty());
    ui.check("worktree", LIST);
    ui.click("commit-button");
    assert!(ui.data.actions().is_empty(), "a blank message can't commit");
    assert!(ui.page(|p| !p.commit_box.can_commit(false, p.checked.len())));
    // A message: ⌘⏎ commits the checked file with it.
    ui.click("commit-message");
    ui.type_text("fix: the list's keys");
    assert_eq!(
        ui.page(|p| p.commit_box.message().to_owned()),
        "fix: the list's keys"
    );
    ui.data.clear_calls();
    ui.keys("cmd-enter");
    assert_eq!(
        ui.data.calls()[0],
        Call::Commit {
            message: "fix: the list's keys".into(),
            stage_paths: vec![LIST.into()]
        }
    );
    assert!(ui.data.calls().contains(&Call::ClearDraft));
    let (command, status, output) = ui.last_console();
    assert_eq!(
        (command.as_str(), status),
        ("git commit", ConsoleStatus::Ok)
    );
    assert_eq!(output, "[abc1231] fix: the list's keys");
    // The box and the checks empty; the file is gone from the list.
    assert!(ui.page(|p| p.checked.is_empty() && p.commit_box.message().is_empty()));
    assert!(!ui.drawn(&format!("change-row-worktree-{LIST}")));
    assert_eq!(ui.page(|p| p.ahead()), 3.);
}

#[test]
fn a_failed_commit_shows_its_first_line_in_the_box() {
    let mut app = app();
    let mut ui = open(&mut app);
    ui.data.fail(
        "commit",
        "git commit exited 1: husky - pre-commit hook failed\nlint: 3 errors",
    );
    ui.check("staged", "lib/server/git.ts");
    ui.click("commit-message");
    ui.type_text("wip");
    ui.click("commit-button");
    assert!(ui.drawn("commit-error"));
    assert_eq!(
        ui.page(|p| p.commit_box.error.clone()),
        Some("husky - pre-commit hook failed".into())
    );
    // The console has the whole text, the prefix stripped.
    assert_eq!(
        ui.last_console(),
        (
            "git commit".into(),
            ConsoleStatus::Error,
            "husky - pre-commit hook failed\nlint: 3 errors".into()
        )
    );
    assert!(ui.page(|p| p.console.open));
    // The message stays for another try.
    assert_eq!(ui.page(|p| p.commit_box.message().to_owned()), "wip");
}

#[test]
fn the_draft_persists() {
    let mut app = app();
    let data = FixtureGitData::demo();
    data.set_draft(Some("feat: half-written"));
    let prefix = CommitPrefixConfig {
        enabled: true,
        branch_pattern: "feat/{ticket}-{slug}".into(),
        template: "feat #{ticket} - ".into(),
    };
    let mut ui = open_with(&mut app, data, Some(prefix));
    // The saved draft wins over the prefix.
    assert_eq!(
        ui.page(|p| p.commit_box.message().to_owned()),
        "feat: half-written"
    );
    // Generate: the message (prefixed) goes in and is saved.
    ui.check("staged", "lib/server/git.ts");
    ui.data.clear_calls();
    ui.click("commit-generate");
    let generated =
        "feat #4715 - feat: add the sessions search filter\n\nFilter the list by title and branch.";
    assert_eq!(
        ui.data.actions(),
        vec![
            Call::CommitMessage {
                paths: vec!["lib/server/git.ts".into()]
            },
            Call::SaveDraft {
                message: generated.into()
            }
        ]
    );
    assert_eq!(ui.page(|p| p.commit_box.message().to_owned()), generated);
    assert_eq!(ui.data.repo().draft.as_deref(), Some(generated));
    // The next mount reads it back.
    ui.remount();
    assert!(ui.data.calls().contains(&Call::GetDraft));
    assert_eq!(ui.page(|p| p.commit_box.message().to_owned()), generated);
}

#[test]
fn with_no_draft_the_box_starts_with_the_prefix() {
    let mut app = app();
    let prefix = CommitPrefixConfig {
        enabled: true,
        branch_pattern: "feat/{ticket}-{slug}".into(),
        template: "feat #{ticket} - ".into(),
    };
    let mut ui = open_with(&mut app, FixtureGitData::demo(), Some(prefix));
    assert_eq!(
        ui.page(|p| p.commit_box.message().to_owned()),
        "feat #4715 - "
    );
}

/// The chip closes its own popover (the TS outside-click `ref` wraps the
/// chip too, BranchSwitcher.tsx:447); a press elsewhere closes it as well.
#[test]
fn the_chip_closes_its_popover_and_so_does_a_press_outside() {
    let mut app = app();
    let mut ui = open(&mut app);
    ui.click("branch-switcher-button");
    assert!(ui.drawn("branch-switcher-popover"));
    ui.click("branch-switcher-button");
    assert!(
        !ui.drawn("branch-switcher-popover"),
        "the chip toggles it shut"
    );
    ui.click("branch-switcher-button");
    assert!(ui.drawn("branch-switcher-popover"), "and open again");
    ui.click("changes-list");
    assert!(!ui.drawn("branch-switcher-popover"), "a press outside");
    ui.click("branch-switcher-button");
    assert!(
        ui.drawn("branch-switcher-popover"),
        "the next chip click opens"
    );
}

#[test]
fn checkout_from_the_switcher() {
    let mut app = app();
    let mut ui = open(&mut app);
    ui.data.clear_calls();
    ui.click("branch-switcher-button");
    assert_eq!(ui.data.actions(), vec![Call::Branches]);
    assert!(ui.drawn("branch-switcher-popover"));
    assert!(ui.drawn("branch-row-local-feat/4715-add-search-filter"));
    assert!(ui.drawn("branch-row-local-main"));
    assert!(ui.drawn("branch-row-remote-origin/main"));
    ui.data.clear_calls();
    ui.click("branch-row-local-main");
    assert_eq!(
        ui.data.calls()[0],
        Call::Checkout {
            name: "main".into(),
            create: false,
            start_point: None
        }
    );
    assert!(!ui.drawn("branch-switcher-popover"));
    assert_eq!(ui.page(|p| p.branch_label()), Some("main".into()));
    assert_eq!(
        ui.last_console(),
        (
            "git checkout main".into(),
            ConsoleStatus::Ok,
            "Switched to branch 'main'".into()
        )
    );
}

#[test]
fn the_switcher_filters_and_creates_a_branch() {
    let mut app = app();
    let mut ui = open(&mut app);
    ui.click("branch-switcher-button");
    ui.type_text("fix");
    assert!(ui.drawn("branch-row-local-fix/4702-diff-scroll"));
    assert!(!ui.drawn("branch-row-local-main"));
    ui.click("branch-switcher-new");
    assert!(ui.drawn("git-prompt"));
    ui.type_text("feat/4720-new");
    ui.data.clear_calls();
    ui.click("git-prompt-ok");
    assert_eq!(
        ui.data.calls()[0],
        Call::Checkout {
            name: "feat/4720-new".into(),
            create: true,
            start_point: None
        }
    );
    assert_eq!(
        ui.last_console(),
        (
            "git checkout -b feat/4720-new".into(),
            ConsoleStatus::Ok,
            "Created and switched to 'feat/4720-new'".into()
        )
    );
}

#[test]
fn a_failed_checkout_shows_in_the_popover() {
    let mut app = app();
    let mut ui = open(&mut app);
    ui.data.fail(
        "checkout",
        "git checkout exited 1: error: Your local changes would be overwritten by checkout:\n\tlib/server/git.ts",
    );
    ui.click("branch-switcher-button");
    ui.click("branch-row-local-main");
    assert!(ui.drawn("branch-switcher-popover"));
    assert!(ui.drawn("branch-switcher-action-error"));
    assert_eq!(
        ui.page(|p| p.branches.action_error.clone()),
        Some("error: Your local changes would be overwritten by checkout:".into())
    );
}

#[test]
fn an_error_shows_as_in_ts() {
    let mut app = app();
    let mut ui = open(&mut app);
    ui.data.fail(
        "remote",
        "git fetch exited 128: fatal: 'origin' does not appear to be a git repository\nfatal: Could not read from remote repository.",
    );
    ui.click("git-fetch");
    assert_eq!(
        ui.data.actions().last(),
        Some(&Call::Remote {
            op: RemoteOp::Fetch
        })
    );
    // The banner: the raw message's first line.
    assert!(ui.drawn("git-banner"));
    assert_eq!(
        ui.page(|p| p.banner().map(str::to_owned)),
        Some("git fetch exited 128: fatal: 'origin' does not appear to be a git repository".into())
    );
    // The console: the prefix stripped, opened on the error.
    assert_eq!(
        ui.last_console(),
        (
            "git fetch".into(),
            ConsoleStatus::Error,
            "fatal: 'origin' does not appear to be a git repository\nfatal: Could not read from remote repository.".into()
        )
    );
    assert!(ui.page(|p| p.console.open));
    // "View in console →" is U12b's console.
    ui.click("git-banner-console");
    assert!(ui.events.lock().unwrap().contains(&GitEvent::ShowConsole));
    // The status error wins the banner.
    ui.data.fail("status", "HTTP 500");
    ui.click("git-refresh");
    assert_eq!(
        ui.page(|p| p.banner().map(str::to_owned)),
        Some("HTTP 500".into())
    );
    // The last good status stays on screen.
    assert!(ui.drawn("changes-list"));
}

#[test]
fn push_and_pull_ask_first() {
    let mut app = app();
    let mut ui = open(&mut app);
    ui.click("git-push");
    assert_eq!(
        ui.page(|p| p.question.clone().unwrap().message),
        "Push feat/4715-add-search-filter (2 commits ahead) to remote?"
    );
    ui.data.clear_calls();
    ui.click("git-question-ok");
    assert_eq!(ui.data.calls()[0], Call::Remote { op: RemoteOp::Push });
    assert!(!ui.drawn("push-badge"));
    ui.click("git-pull");
    assert_eq!(
        ui.page(|p| p.question.clone().unwrap().message),
        "Pull --ff-only into feat/4715-add-search-filter? This aborts on non-fast-forward."
    );
    ui.click("git-question-ok");
    assert!(!ui.drawn("pull-badge"));
    // Pull + resolve refuses on a dirty tree.
    ui.click("pull-with-claude-button");
    assert_eq!(
        ui.page(|p| p.op_error.clone()),
        Some(claudius_git::page::PULL_REFUSED.into())
    );
}

#[test]
fn the_chat_link_and_a_conflict_navigate() {
    let mut app = app();
    let mut ui = open(&mut app);
    ui.click("git-chat-link");
    assert_eq!(
        ui.events.lock().unwrap().last(),
        Some(&GitEvent::Navigate("/".into()))
    );
    // A merge conflict offers a new chat with the resolve prompt.
    ui.data.conflict_with(&["lib/server/git.ts"]);
    ui.click("branch-switcher-button");
    ui.click("branch-actions-local-main");
    assert!(ui.drawn("branch-menu-local-main"));
    let merge = ui.page(|p| {
        let b = p.branches.branch_for_key("local:main").unwrap().clone();
        claudius_git::branches::actions_for(&b, p.branch_label().as_deref())
            .iter()
            .position(|i| i.label == "Merge 'main' into 'feat/4715-add-search-filter'")
            .unwrap()
    });
    ui.click(&format!("branch-menu-item-{merge}"));
    assert_eq!(
        ui.page(|p| p.question.clone().unwrap().message),
        "Open Claude Code to resolve 1 merge conflict?"
    );
    ui.click("git-question-ok");
    let url = match ui.events.lock().unwrap().last() {
        Some(GitEvent::Navigate(u)) => u.clone(),
        other => panic!("{other:?}"),
    };
    assert!(url.starts_with("/?new=1&prompt=I%20just%20ran%20%60git%20merge%20main%60"));
    assert_eq!(
        ui.page(|p| p.branches.action_error.clone()),
        Some("1 conflict during merge".into())
    );
}

#[test]
fn the_status_polls_and_stops_when_unmounted() {
    let mut app = app();
    let mut ui = open(&mut app);
    ui.data.clear_calls();
    ui.cx.executor().advance_clock(Duration::from_millis(3_900));
    ui.settle();
    assert!(!ui.data.calls().contains(&Call::Status));
    ui.cx.executor().advance_clock(Duration::from_millis(200));
    ui.settle();
    assert_eq!(ui.data.calls(), vec![Call::Status]);
    // Unmounted (the route left): no more polls.
    let screen = ui.screen.clone();
    ui.cx
        .update(|_, cx| screen.update(cx, |s, cx| s.sync(None, ThemeName::Dark, cx)));
    ui.settle();
    ui.data.clear_calls();
    ui.cx
        .executor()
        .advance_clock(Duration::from_millis(20_000));
    ui.settle();
    assert!(ui.data.calls().is_empty());
    assert!(ui.drawn("git-empty"));
}

#[test]
fn group_by_directory_draws_the_folders() {
    let mut app = app();
    let mut ui = open(&mut app);
    ui.click("changes-view-options");
    ui.click("changes-group-by-directory");
    assert!(ui.page(|p| p.group_by_directory));
    assert!(ui.drawn("changes-dir-worktree-components/git"));
    // The folder's checkbox checks every file under it.
    ui.click("changes-dir-check-worktree-components/git");
    assert!(ui.page(|p| p.checked.contains(LIST) && p.checked.contains(VIEWER)));
    // Collapsing it hides its rows.
    ui.click("changes-dir-worktree-components/git");
    assert!(!ui.drawn(&format!("change-row-worktree-{LIST}")));
}

/// The fixture, its `status` answers held until the test sends them.
struct Gated {
    inner: FixtureGitData,
    held: Mutex<Vec<oneshot::Sender<Result<GitStatusPayload, String>>>>,
}

impl GitData for Gated {
    fn status(&self, _ws: &str) -> GitFuture<GitStatusPayload> {
        let (tx, rx) = oneshot::channel();
        self.held.lock().unwrap().push(tx);
        async move { rx.await.unwrap_or_else(|_| Err("dropped".into())) }.boxed()
    }
    fn diff(&self, ws: &str, path: &str, mode: DiffMode) -> GitFuture<DiffPayload> {
        self.inner.diff(ws, path, mode)
    }
    fn stage(&self, ws: &str, paths: &[String], op: StageOp) -> GitFuture<()> {
        self.inner.stage(ws, paths, op)
    }
    fn commit(&self, ws: &str, message: &str, stage_paths: &[String]) -> GitFuture<CommitOk> {
        self.inner.commit(ws, message, stage_paths)
    }
    fn commit_message(&self, ws: &str, paths: &[String]) -> GitFuture<String> {
        self.inner.commit_message(ws, paths)
    }
    fn commit_draft(&self, ws: &str) -> GitFuture<String> {
        self.inner.commit_draft(ws)
    }
    fn save_commit_draft(&self, ws: &str, message: &str) -> GitFuture<()> {
        self.inner.save_commit_draft(ws, message)
    }
    fn clear_commit_draft(&self, ws: &str) -> GitFuture<()> {
        self.inner.clear_commit_draft(ws)
    }
    fn branches(&self, ws: &str) -> GitFuture<Vec<BranchInfo>> {
        self.inner.branches(ws)
    }
    fn checkout(
        &self,
        ws: &str,
        name: &str,
        create: bool,
        start_point: Option<&str>,
    ) -> GitFuture<()> {
        self.inner.checkout(ws, name, create, start_point)
    }
    fn rename_branch(&self, ws: &str, old_name: &str, new_name: &str) -> GitFuture<Option<String>> {
        self.inner.rename_branch(ws, old_name, new_name)
    }
    fn delete_branch(
        &self,
        ws: &str,
        name: &str,
        target: DeleteTarget,
    ) -> GitFuture<Option<String>> {
        self.inner.delete_branch(ws, name, target)
    }
    fn compare_branches(&self, ws: &str, base: &str, head: &str) -> GitFuture<Option<String>> {
        self.inner.compare_branches(ws, base, head)
    }
    fn diff_with_worktree(&self, ws: &str, head: &str) -> GitFuture<Option<String>> {
        self.inner.diff_with_worktree(ws, head)
    }
    fn merge(&self, ws: &str, name: &str) -> MergeFuture {
        self.inner.merge(ws, name)
    }
    fn rebase(&self, ws: &str, onto: &str, checkout_branch: Option<&str>) -> MergeFuture {
        self.inner.rebase(ws, onto, checkout_branch)
    }
    fn pull_merge(&self, ws: &str) -> MergeFuture {
        self.inner.pull_merge(ws)
    }
    fn remote(&self, ws: &str, op: RemoteOp) -> GitFuture<Option<String>> {
        self.inner.remote(ws, op)
    }
    fn pr_status(&self, ws: &str) -> BoxFuture<'static, Option<PrBadge>> {
        self.inner.pr_status(ws)
    }
}

/// A request the unmounted page made answers after the remount: the new
/// page (whose tickets start again at 1) never hears it (useGitStatus's
/// `cancelled`).
#[test]
fn an_answer_for_an_unmounted_page_is_dropped() {
    let mut app = app();
    let fixture = FixtureGitData::demo();
    let fresh = futures::executor::block_on(fixture.status(WS)).expect("the demo status");
    let gated = Arc::new(Gated {
        inner: fixture.clone(),
        held: Mutex::default(),
    });
    let mut ui = open_over(&mut app, fixture, gated.clone(), None);
    assert_eq!(
        gated.held.lock().unwrap().len(),
        1,
        "the first status waits"
    );
    ui.remount();
    let mut held = std::mem::take(&mut *gated.held.lock().unwrap());
    assert_eq!(held.len(), 2, "the remount asked again");
    let new = held.pop().unwrap();
    let old = held.pop().unwrap();
    let mut stale = fresh.clone();
    stale.branch = Some("stale".into());
    old.send(Ok(stale)).unwrap();
    ui.settle();
    assert!(
        ui.page(|p| p.data.is_none()),
        "the old page's answer is dropped"
    );
    new.send(Ok(fresh)).unwrap();
    ui.settle();
    assert_eq!(
        ui.page(|p| p.branch_label()),
        Some("feat/4715-add-search-filter".into())
    );
}
