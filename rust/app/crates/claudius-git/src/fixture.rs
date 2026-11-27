//! [`FixtureGitData`]: the Git routes answered from memory, for the tests
//! and the screenshots. Staging moves a file between the groups as git
//! would, a commit drops the staged side, a checkout moves `current`, and
//! every call is recorded ([`Call`]). [`FixtureGitData::fail`] makes a
//! method answer an error instead (the text the page shows).

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use futures::future::{BoxFuture, FutureExt as _};

use crate::changes::DiffMode;
use crate::data::{DeleteTarget, GitData, GitFuture, MergeFailure, MergeFuture, RemoteOp, StageOp};
use crate::types::{BranchInfo, CommitOk, DiffPayload, GitFileChange, GitStatusPayload, PrBadge};

/// One request the page made.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Call {
    Status,
    Diff {
        path: String,
        mode: DiffMode,
    },
    Stage {
        paths: Vec<String>,
        op: StageOp,
    },
    Commit {
        message: String,
        stage_paths: Vec<String>,
    },
    CommitMessage {
        paths: Vec<String>,
    },
    GetDraft,
    SaveDraft {
        message: String,
    },
    ClearDraft,
    Branches,
    Checkout {
        name: String,
        create: bool,
        start_point: Option<String>,
    },
    Rename {
        old_name: String,
        new_name: String,
    },
    Delete {
        name: String,
        target: DeleteTarget,
    },
    Compare {
        base: String,
        head: String,
    },
    DiffWithWorktree {
        head: String,
    },
    Merge {
        name: String,
    },
    Rebase {
        onto: String,
        checkout_branch: Option<String>,
    },
    PullMerge,
    Remote {
        op: RemoteOp,
    },
    PrStatus,
}

impl Call {
    /// The method's name, what [`FixtureGitData::fail`] keys on.
    pub fn method(&self) -> &'static str {
        match self {
            Call::Status => "status",
            Call::Diff { .. } => "diff",
            Call::Stage { .. } => "stage",
            Call::Commit { .. } => "commit",
            Call::CommitMessage { .. } => "commit_message",
            Call::GetDraft => "commit_draft",
            Call::SaveDraft { .. } => "save_commit_draft",
            Call::ClearDraft => "clear_commit_draft",
            Call::Branches => "branches",
            Call::Checkout { .. } => "checkout",
            Call::Rename { .. } => "rename_branch",
            Call::Delete { .. } => "delete_branch",
            Call::Compare { .. } => "compare_branches",
            Call::DiffWithWorktree { .. } => "diff_with_worktree",
            Call::Merge { .. } => "merge",
            Call::Rebase { .. } => "rebase",
            Call::PullMerge => "pull_merge",
            Call::Remote { .. } => "remote",
            Call::PrStatus => "pr_status",
        }
    }
}

/// The repository the fixture plays.
#[derive(Clone, Debug, Default)]
pub struct Repo {
    pub status: GitStatusPayload,
    pub branches: Vec<BranchInfo>,
    /// `(path, mode)` → the diff text.
    pub diffs: HashMap<(String, DiffMode), DiffPayload>,
    pub draft: Option<String>,
    pub badge: Option<PrBadge>,
    pub generated_message: String,
    pub commits: u32,
}

#[derive(Default)]
struct Inner {
    repo: Repo,
    calls: Vec<Call>,
    failures: HashMap<&'static str, String>,
    conflicts: Option<Vec<String>>,
}

#[derive(Clone, Default)]
pub struct FixtureGitData {
    inner: Arc<Mutex<Inner>>,
}

fn ready<T: Send + 'static>(v: T) -> BoxFuture<'static, T> {
    futures::future::ready(v).boxed()
}

impl FixtureGitData {
    pub fn new(repo: Repo) -> Self {
        FixtureGitData {
            inner: Arc::new(Mutex::new(Inner {
                repo,
                ..Inner::default()
            })),
        }
    }

    /// A repo with mixed changes: staged, partial, changed, a rename, a
    /// deletion and untracked files on `feat/4715-add-search-filter`,
    /// three local branches and two remote ones, an open PR with passing
    /// checks.
    pub fn demo() -> Self {
        let f = |path: &str, index: &str, worktree: &str| GitFileChange::new(path, index, worktree);
        let mut renamed = f("components/git/BranchPicker.tsx", "R", " ");
        renamed.old_path = Some("components/git/BranchSwitcher.tsx".into());
        let files = vec![
            f("lib/server/git.ts", "M", " "),
            f("lib/shared/commit-prefix.ts", "A", " "),
            renamed,
            f("app/[workspaceId]/git/page.tsx", "M", "M"),
            f("components/git/ChangesList.tsx", " ", "M"),
            f("components/git/DiffViewer.tsx", " ", "M"),
            f("docs/old-notes.md", " ", "D"),
            GitFileChange::untracked("lib/client/git-poll.ts"),
            GitFileChange::untracked("rust/app/crates/claudius-git/src/lib.rs"),
        ];
        let status = GitStatusPayload {
            is_repo: true,
            repo_root: Some("/Users/demo/src/claudius".into()),
            branch: Some("feat/4715-add-search-filter".into()),
            head: None,
            ahead: Some(2.),
            behind: Some(1.),
            files,
        };
        let b =
            |name: &str, kind: &str, sha: &str, upstream: Option<&str>, current: bool| BranchInfo {
                name: name.into(),
                kind: kind.into(),
                sha: sha.into(),
                upstream: upstream.map(str::to_owned),
                committer_date: "2026-11-26 18:04:11 +0100".into(),
                current,
            };
        let branches = vec![
            b(
                "feat/4715-add-search-filter",
                "local",
                "3e9a7c4",
                Some("origin/feat/4715-add-search-filter"),
                true,
            ),
            b("main", "local", "93cc7df", Some("origin/main"), false),
            b("fix/4702-diff-scroll", "local", "1d2e3f4", None, false),
            b("origin/main", "remote", "93cc7df", None, false),
            b(
                "origin/feat/4715-add-search-filter",
                "remote",
                "8c1f0b2",
                None,
                false,
            ),
        ];
        let mut diffs = HashMap::new();
        diffs.insert(
            (
                "app/[workspaceId]/git/page.tsx".to_owned(),
                DiffMode::Staged,
            ),
            DiffPayload {
                diff: DEMO_DIFF.into(),
                binary: false,
            },
        );
        diffs.insert(
            ("components/git/ChangesList.tsx".to_owned(), DiffMode::Worktree),
            DiffPayload {
                diff: "diff --git a/components/git/ChangesList.tsx b/components/git/ChangesList.tsx\n--- a/components/git/ChangesList.tsx\n+++ b/components/git/ChangesList.tsx\n@@ -154,3 +154,4 @@ function groupFiles(files: GitFileChange[]): Grouped {\n   const out: Grouped = { staged: [], unstaged: [], untracked: [] };\n+  // AD entries are hidden, see (1) above.\n   for (const f of files) {\n     if (f.untracked) {\n".into(),
                binary: false,
            },
        );
        FixtureGitData::new(Repo {
            status,
            branches,
            diffs,
            draft: None,
            badge: Some(PrBadge {
                host: "github".into(),
                number: 4716.,
                url: "https://github.com/claudius-network/claudius/pull/4716".into(),
                title: Some("feat: search filter for the sessions list".into()),
                state: "open".into(),
                checks: "passing".into(),
            }),
            generated_message:
                "feat: add the sessions search filter\n\nFilter the list by title and branch."
                    .into(),
            commits: 0,
        })
    }

    /// Answer `method` (a [`Call::method`] name) with `Err(message)` from
    /// now on.
    pub fn fail(&self, method: &'static str, message: &str) {
        self.inner
            .lock()
            .unwrap()
            .failures
            .insert(method, message.into());
    }

    /// Stop failing `method`.
    pub fn heal(&self, method: &'static str) {
        self.inner.lock().unwrap().failures.remove(method);
    }

    /// The next merge / rebase / pull-merge answers 409 with these files.
    pub fn conflict_with(&self, files: &[&str]) {
        self.inner.lock().unwrap().conflicts = Some(files.iter().map(|s| (*s).into()).collect());
    }

    pub fn calls(&self) -> Vec<Call> {
        self.inner.lock().unwrap().calls.clone()
    }

    /// The calls other than the status poll's and the PR badge's.
    pub fn actions(&self) -> Vec<Call> {
        self.calls()
            .into_iter()
            .filter(|c| !matches!(c, Call::Status | Call::PrStatus))
            .collect()
    }

    pub fn clear_calls(&self) {
        self.inner.lock().unwrap().calls.clear();
    }

    pub fn repo(&self) -> Repo {
        self.inner.lock().unwrap().repo.clone()
    }

    pub fn set_draft(&self, draft: Option<&str>) {
        self.inner.lock().unwrap().repo.draft = draft.map(str::to_owned);
    }

    pub fn set_status(&self, status: GitStatusPayload) {
        self.inner.lock().unwrap().repo.status = status;
    }

    /// Records `call`; the configured failure for its method, if any.
    fn record(&self, call: Call) -> Option<String> {
        let mut inner = self.inner.lock().unwrap();
        let method = call.method();
        inner.calls.push(call);
        inner.failures.get(method).cloned()
    }

    fn with_repo<T>(&self, f: impl FnOnce(&mut Repo) -> T) -> T {
        f(&mut self.inner.lock().unwrap().repo)
    }

    fn answer<T: Send + 'static>(
        &self,
        call: Call,
        f: impl FnOnce(&mut Repo) -> T,
    ) -> GitFuture<T> {
        match self.record(call) {
            Some(e) => ready(Err(e)),
            None => ready(Ok(self.with_repo(f))),
        }
    }

    fn merge_like(&self, call: Call, output: &str) -> MergeFuture {
        if let Some(e) = self.record(call) {
            return ready(Err(MergeFailure::error(e)));
        }
        let conflicts = self.inner.lock().unwrap().conflicts.take();
        if let Some(conflicts) = conflicts {
            let mut files = self.repo().status.files;
            for p in &conflicts {
                files.retain(|f| &f.path != p);
                files.push(GitFileChange::new(p, "U", "U"));
            }
            self.with_repo(|r| r.status.files = files);
            return ready(Err(MergeFailure {
                conflicts: Some(conflicts),
                message: String::new(),
                output: Some("CONFLICT (content): Merge conflict".into()),
            }));
        }
        ready(Ok(Some(output.to_owned())))
    }
}

/// `git add` / `restore --staged` / `restore` + `clean` / `rm`, on the
/// porcelain codes.
fn apply_stage(files: &mut Vec<GitFileChange>, paths: &[String], op: StageOp) {
    for p in paths {
        let Some(i) = files.iter().position(|f| &f.path == p) else {
            continue;
        };
        let f = &mut files[i];
        match op {
            StageOp::Stage => {
                if f.untracked {
                    *f = GitFileChange::new(p, "A", " ");
                } else if f.worktree != " " {
                    if f.index == " " {
                        f.index = f.worktree.clone();
                    }
                    f.worktree = " ".into();
                }
            }
            StageOp::Unstage => {
                if f.index == "A" {
                    *f = GitFileChange::untracked(p);
                } else if f.index != " " {
                    if f.worktree == " " {
                        f.worktree = f.index.clone();
                    }
                    f.index = " ".into();
                }
            }
            StageOp::Discard => {
                if f.untracked || f.index == "A" {
                    files.remove(i);
                } else {
                    f.worktree = " ".into();
                    if f.index == " " {
                        files.remove(i);
                    }
                }
            }
            StageOp::Remove => {
                if f.untracked {
                    files.remove(i);
                } else {
                    *f = GitFileChange::new(p, "D", " ");
                }
            }
        }
    }
}

impl GitData for FixtureGitData {
    fn status(&self, _ws: &str) -> GitFuture<GitStatusPayload> {
        self.answer(Call::Status, |r| r.status.clone())
    }

    fn diff(&self, _ws: &str, path: &str, mode: DiffMode) -> GitFuture<DiffPayload> {
        let key = (path.to_owned(), mode);
        self.answer(
            Call::Diff {
                path: path.into(),
                mode,
            },
            move |r| {
                r.diffs.get(&key).cloned().unwrap_or_else(|| DiffPayload {
                    diff: format!(
                        "diff --git a/{p} b/{p}\n--- a/{p}\n+++ b/{p}\n@@ -1,2 +1,2 @@\n line one\n-line two\n+line 2\n",
                        p = key.0
                    ),
                    binary: false,
                })
            },
        )
    }

    fn stage(&self, _ws: &str, paths: &[String], op: StageOp) -> GitFuture<()> {
        let paths = paths.to_vec();
        self.answer(
            Call::Stage {
                paths: paths.clone(),
                op,
            },
            move |r| apply_stage(&mut r.status.files, &paths, op),
        )
    }

    fn commit(&self, _ws: &str, message: &str, stage_paths: &[String]) -> GitFuture<CommitOk> {
        let paths = stage_paths.to_vec();
        let subject = message.lines().next().unwrap_or_default().to_owned();
        self.answer(
            Call::Commit {
                message: message.into(),
                stage_paths: paths.clone(),
            },
            move |r| {
                apply_stage(&mut r.status.files, &paths, StageOp::Stage);
                r.status.files.retain_mut(|f| {
                    if f.index == " " || f.untracked {
                        return true;
                    }
                    f.index = " ".into();
                    f.worktree != " "
                });
                r.commits += 1;
                r.status.ahead = Some(r.status.ahead.unwrap_or(0.) + 1.);
                CommitOk {
                    sha: Some(format!(
                        "{:07x}0000000000000000000000000000000",
                        0xabc1230 + r.commits
                    )),
                    subject: Some(subject),
                }
            },
        )
    }

    fn commit_message(&self, _ws: &str, paths: &[String]) -> GitFuture<String> {
        self.answer(
            Call::CommitMessage {
                paths: paths.to_vec(),
            },
            |r| r.generated_message.clone(),
        )
    }

    fn commit_draft(&self, _ws: &str) -> GitFuture<String> {
        self.answer(Call::GetDraft, |r| r.draft.clone().unwrap_or_default())
    }

    fn save_commit_draft(&self, _ws: &str, message: &str) -> GitFuture<()> {
        let m = message.to_owned();
        self.answer(Call::SaveDraft { message: m.clone() }, move |r| {
            r.draft = Some(m)
        })
    }

    fn clear_commit_draft(&self, _ws: &str) -> GitFuture<()> {
        self.answer(Call::ClearDraft, |r| r.draft = None)
    }

    fn branches(&self, _ws: &str) -> GitFuture<Vec<BranchInfo>> {
        self.answer(Call::Branches, |r| r.branches.clone())
    }

    fn checkout(
        &self,
        _ws: &str,
        name: &str,
        create: bool,
        start_point: Option<&str>,
    ) -> GitFuture<()> {
        let n = name.to_owned();
        self.answer(
            Call::Checkout {
                name: name.into(),
                create,
                start_point: start_point.map(str::to_owned),
            },
            move |r| {
                if create {
                    r.branches.push(BranchInfo {
                        name: n.clone(),
                        kind: "local".into(),
                        sha: "0000000".into(),
                        upstream: None,
                        committer_date: String::new(),
                        current: false,
                    });
                }
                let local = n.strip_prefix("origin/").unwrap_or(&n).to_owned();
                for b in &mut r.branches {
                    b.current = b.is_local() && b.name == local;
                }
                r.status.branch = Some(local);
            },
        )
    }

    fn rename_branch(
        &self,
        _ws: &str,
        old_name: &str,
        new_name: &str,
    ) -> GitFuture<Option<String>> {
        let (o, n) = (old_name.to_owned(), new_name.to_owned());
        self.answer(
            Call::Rename {
                old_name: o.clone(),
                new_name: n.clone(),
            },
            move |r| {
                for b in &mut r.branches {
                    if b.is_local() && b.name == o {
                        b.name = n.clone();
                    }
                }
                if r.status.branch.as_deref() == Some(o.as_str()) {
                    r.status.branch = Some(n.clone());
                }
                Some(String::new())
            },
        )
    }

    fn delete_branch(
        &self,
        _ws: &str,
        name: &str,
        target: DeleteTarget,
    ) -> GitFuture<Option<String>> {
        let n = name.to_owned();
        self.answer(
            Call::Delete {
                name: name.into(),
                target,
            },
            move |r| {
                r.branches.retain(|b| b.name != n);
                Some(format!("Deleted branch {n}."))
            },
        )
    }

    fn compare_branches(&self, _ws: &str, base: &str, head: &str) -> GitFuture<Option<String>> {
        let out = format!("{base}..{head}: 2 commits");
        self.answer(
            Call::Compare {
                base: base.into(),
                head: head.into(),
            },
            move |_| Some(out),
        )
    }

    fn diff_with_worktree(&self, _ws: &str, head: &str) -> GitFuture<Option<String>> {
        self.answer(Call::DiffWithWorktree { head: head.into() }, |_| {
            Some(String::new())
        })
    }

    fn merge(&self, _ws: &str, name: &str) -> MergeFuture {
        self.merge_like(Call::Merge { name: name.into() }, "Already up to date.")
    }

    fn rebase(&self, _ws: &str, onto: &str, checkout_branch: Option<&str>) -> MergeFuture {
        self.merge_like(
            Call::Rebase {
                onto: onto.into(),
                checkout_branch: checkout_branch.map(str::to_owned),
            },
            "Successfully rebased and updated.",
        )
    }

    fn pull_merge(&self, _ws: &str) -> MergeFuture {
        self.merge_like(Call::PullMerge, "Already up to date.")
    }

    fn remote(&self, _ws: &str, op: RemoteOp) -> GitFuture<Option<String>> {
        self.answer(Call::Remote { op }, move |r| {
            match op {
                RemoteOp::Push => r.status.ahead = Some(0.),
                RemoteOp::Pull => r.status.behind = Some(0.),
                RemoteOp::Fetch => {}
            }
            Some(String::new())
        })
    }

    fn pr_status(&self, _ws: &str) -> BoxFuture<'static, Option<PrBadge>> {
        if self.record(Call::PrStatus).is_some() {
            return ready(None);
        }
        ready(self.with_repo(|r| r.badge.clone()))
    }
}

const DEMO_DIFF: &str =
    "diff --git a/app/[workspaceId]/git/page.tsx b/app/[workspaceId]/git/page.tsx
index 1b2c3d4..5e6f7a8 100644
--- a/app/[workspaceId]/git/page.tsx
+++ b/app/[workspaceId]/git/page.tsx
@@ -1576,9 +1576,12 @@ export default function GitPage() {
   // Cheap pure call — no useMemo needed, React Compiler memoizes downstream.
   const commitPrefix = data?.isRepo
     ? renderCommitPrefix(data.branch ?? null, active?.commitPrefix)
     : null;

-  const aheadBehind = useMemo(() => {
-    if (!data || !data.isRepo) return null;
+  const aheadBehind = useMemo(() => {
+    if (!data?.isRepo) return null;
     const a = data.ahead ?? 0;
     const b = data.behind ?? 0;
+    // Nothing to show when the branch is level with its upstream.
     if (!a && !b) return null;
     return `↑${a} ↓${b}`;
   }, [data]);
+
+  const aheadCount = data?.isRepo ? data.ahead ?? 0 : 0;
";
