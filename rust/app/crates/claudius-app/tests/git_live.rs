//! The Git page (U12a) in the shell, over the engine in this process (a
//! temporary HOME and config dir, the fake CLI) and a temporary git repo
//! registered as the workspace: the page lists a modified and an untracked
//! file, staging one moves it to Staged, a commit empties Staged (and
//! lands in the repo), the branch switcher lists the repo's branches, and
//! the Chat link leaves the page through the shell's router.
//! Every `git` here runs with `-C <the temp repo>` and no global config.
//! macOS (the CoreText text system). One test: one world per process.

#![cfg(target_os = "macos")]

#[path = "../../../../crates/claudius-agent/tests/support/test_bins.rs"]
mod test_bins;
#[path = "support/world.rs"]
mod world;

use std::path::Path;
use std::process::Command;
use std::sync::Arc;
use std::time::{Duration, Instant};

use claudius_app::data::ShellData;
use claudius_app::route::{Route, WorkspacePage};
use claudius_app::shell::{Appearance, Shell};
use claudius_app::store::LocalStore;
use claudius_git::changes::DiffMode;
use claudius_git::data::{GitData, TransportGitData};
use claudius_git::page::GitPage;
use claudius_gpui_theme::ThemeName;
use claudius_transport::CookieJar;
use gpui::{Entity, Modifiers, TestAppContext, TestDispatcher, VisualTestContext, px, size};
use gpui_apple::AppleTextSystem;
use world::world;

const LIMIT: Duration = Duration::from_secs(30);

/// `git -C <repo> <args>`, hermetic: no global or system config.
fn git(repo: &Path, args: &[&str]) -> String {
    let out = Command::new("git")
        .arg("-C")
        .arg(repo)
        .args(args)
        .env("GIT_CONFIG_GLOBAL", "/dev/null")
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .output()
        .expect("git runs");
    assert!(
        out.status.success(),
        "git {args:?}: {}",
        String::from_utf8_lossy(&out.stderr)
    );
    String::from_utf8_lossy(&out.stdout).into_owned()
}

/// A repo on `main` with one commit and a second branch, then a modified
/// tracked file and an untracked one. The repo's own config pins the
/// identity, no signing and no hooks (the engine's git reads it).
fn make_repo(repo: &Path, hooks: &Path) {
    std::fs::create_dir_all(hooks).unwrap();
    git(repo, &["init", "-q", "-b", "main"]);
    for (k, v) in [
        ("user.name", "Claudius Test"),
        ("user.email", "test@example.invalid"),
        ("commit.gpgsign", "false"),
        ("core.hooksPath", &hooks.display().to_string()),
    ] {
        git(repo, &["config", k, v]);
    }
    std::fs::write(repo.join("tracked.txt"), "one\n").unwrap();
    git(repo, &["add", "tracked.txt"]);
    git(repo, &["commit", "-q", "-m", "first"]);
    git(repo, &["branch", "feat/live-check"]);
    std::fs::write(repo.join("tracked.txt"), "one\ntwo\n").unwrap();
    std::fs::write(repo.join("new.txt"), "fresh\n").unwrap();
}

/// Runs the GPUI tasks and draws.
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

fn sel(s: &str) -> &'static str {
    Box::leak(s.to_owned().into_boxed_str())
}

fn drawn(cx: &mut VisualTestContext, selector: &str) -> bool {
    cx.debug_bounds(sel(selector)).is_some()
}

fn click(cx: &mut VisualTestContext, selector: &str) {
    let b = cx
        .debug_bounds(sel(selector))
        .unwrap_or_else(|| panic!("{selector} isn't on screen"));
    cx.simulate_click(b.center(), Modifiers::none());
    settle(cx);
}

/// Settles until `f` answers over the shell's Git page (the engine works on
/// its own threads).
fn wait<T>(
    cx: &mut VisualTestContext,
    shell: &Entity<Shell>,
    what: &str,
    mut f: impl FnMut(&mut VisualTestContext, Option<&GitPage>) -> Option<T>,
) -> T {
    let t0 = Instant::now();
    loop {
        settle(cx);
        let screen = cx.read(|cx| shell.read(cx).git_screen().cloned());
        let page = screen.and_then(|s| cx.read(|cx| s.read(cx).page().cloned()));
        if let Some(v) = f(cx, page.as_ref()) {
            return v;
        }
        assert!(t0.elapsed() < LIMIT, "timed out waiting for {what}");
        std::thread::sleep(Duration::from_millis(20));
    }
}

fn paths(page: &GitPage, mode: DiffMode) -> Vec<String> {
    let g = page.groups();
    let files = match mode {
        DiffMode::Staged => &g.staged,
        DiffMode::Worktree => &g.unstaged,
        DiffMode::Untracked => &g.untracked,
    };
    files.iter().map(|f| f.path.clone()).collect()
}

#[test]
fn the_git_page_runs_over_the_in_process_engine() {
    let w = world(test_bins::fake_claude(), &["Repo"]);
    let ws = w.workspaces[0].clone();
    let repo = Path::new(&ws.root_path).to_path_buf();
    make_repo(&repo, &w.root.path().join("no-hooks"));

    let mut app = TestAppContext::build_with_text_system(
        TestDispatcher::new(0),
        None,
        Arc::new(AppleTextSystem::new()),
    );
    app.update(|cx| claudius_app::init(ThemeName::Light, cx));
    let data: Arc<dyn ShellData> = w.data.clone();
    let store_path = w.root.path().join("local-storage.json");
    let store = LocalStore::open(&store_path);
    let (shell, cx) = app.add_window_view(|window, cx| {
        Shell::with_store(data, Appearance::Fixed(ThemeName::Light), store, window, cx)
    });
    cx.simulate_resize(size(px(1440.), px(900.)));
    // As main.rs does: the live Git data over the engine's transport.
    let git_data: Arc<dyn GitData> = Arc::new(TransportGitData::new(
        w.backend.transport(Arc::new(CookieJar::new())),
        w.backend.handle(),
    ));
    shell.update(cx, |s, cx| s.set_git_data(git_data, cx));
    let t0 = Instant::now();
    loop {
        settle(cx);
        if cx.read(|cx| shell.read(cx).state().active_workspace().is_some()) {
            break;
        }
        assert!(t0.elapsed() < LIMIT, "timed out waiting for the workspace");
        std::thread::sleep(Duration::from_millis(20));
    }
    shell.update(cx, |s, cx| {
        s.navigate(Route::page(&ws.id, WorkspacePage::Git), cx)
    });

    // ── the status: a modified and an untracked file, on main
    wait(cx, &shell, "the status", |_, p| {
        let p = p?;
        (p.is_repo() && !p.groups().unstaged.is_empty()).then_some(())
    });
    wait(cx, &shell, "the rows", |cx, p| {
        let p = p?;
        assert_eq!(p.branch_label().as_deref(), Some("main"));
        assert_eq!(paths(p, DiffMode::Worktree), ["tracked.txt"]);
        assert_eq!(paths(p, DiffMode::Untracked), ["new.txt"]);
        assert!(paths(p, DiffMode::Staged).is_empty());
        (drawn(cx, "change-row-worktree-tracked.txt") && drawn(cx, "change-row-untracked-new.txt"))
            .then_some(())
    });
    assert!(drawn(cx, "git-screen"));

    // ── the modified file's diff
    click(cx, "change-row-worktree-tracked.txt");
    wait(cx, &shell, "the diff", |cx, p| {
        let d = p?.diff.payload.as_ref()?;
        assert!(d.diff.contains("+two"), "{}", d.diff);
        drawn(cx, "diff-rows").then_some(())
    });

    // ── staging it moves it to Staged
    click(cx, "change-check-worktree-tracked.txt");
    click(cx, "git-stage");
    wait(cx, &shell, "the staged file", |cx, p| {
        let p = p?;
        (p.busy.is_none()
            && paths(p, DiffMode::Staged) == ["tracked.txt"]
            && paths(p, DiffMode::Worktree).is_empty()
            && drawn(cx, "change-row-staged-tracked.txt"))
        .then_some(())
    });
    assert!(!drawn(cx, "change-row-worktree-tracked.txt"));
    assert_eq!(
        git(&repo, &["diff", "--cached", "--name-only"]),
        "tracked.txt\n"
    );

    // ── a commit empties Staged, the untracked file stays
    wait(cx, &shell, "the check kept", |_, p| {
        p?.checked.contains("tracked.txt").then_some(())
    });
    click(cx, "commit-message");
    cx.simulate_input("test: the live commit");
    settle(cx);
    click(cx, "commit-button");
    wait(cx, &shell, "the commit", |cx, p| {
        let p = p?;
        (p.busy.is_none()
            && p.commit_box.error.is_none()
            && paths(p, DiffMode::Staged).is_empty()
            && !drawn(cx, "change-row-staged-tracked.txt"))
        .then_some(())
    });
    wait(cx, &shell, "the untracked file after", |_, p| {
        (paths(p?, DiffMode::Untracked) == ["new.txt"]).then_some(())
    });
    assert_eq!(
        git(&repo, &["log", "-1", "--format=%s"]),
        "test: the live commit\n"
    );
    assert_eq!(git(&repo, &["diff", "--cached", "--name-only"]), "");

    // ── the branch switcher lists the repo's branches
    click(cx, "branch-switcher-button");
    wait(cx, &shell, "the branch list", |cx, p| {
        let p = p?;
        let names: Vec<&str> = p
            .branches
            .branches
            .iter()
            .map(|b| b.name.as_str())
            .collect();
        (!p.branches.loading
            && names.contains(&"main")
            && names.contains(&"feat/live-check")
            && drawn(cx, "branch-row-local-feat/live-check")
            && drawn(cx, "branch-row-local-main"))
        .then_some(())
    });
    assert!(drawn(cx, "branch-switcher-popover"));
    click(cx, "branch-switcher-button");
    assert!(!drawn(cx, "branch-switcher-popover"));

    // ── the Chat link leaves through the shell's router; the page unmounts
    click(cx, "git-chat-link");
    wait(cx, &shell, "the chat route", |cx, p| {
        let route = cx.read(|cx| shell.read(cx).state().route().clone());
        let on_git = matches!(
            route,
            Route::Workspace {
                page: WorkspacePage::Git,
                ..
            }
        );
        (!on_git && p.is_none()).then_some(())
    });
    assert!(!drawn(cx, "git-screen"));

    w.shutdown();
}
