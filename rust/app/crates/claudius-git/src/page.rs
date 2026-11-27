//! [`GitPage`]: `app/[workspaceId]/git/page.tsx` without GPUI. It holds the
//! page's state (the status and its poll, the checked set, the diff
//! selection and its diff, the busy op, the errors, the draft, the PR
//! badge, the console, the commit box and the branch popover) and runs its
//! handlers as the TS does, step by step: each step returns the [`Out`]s
//! the view carries out (a request, a timer, a question, a navigation), and
//! each answer comes back through [`GitPage::reply`].

use std::collections::{BTreeSet, HashMap, HashSet};

use crate::branches::{AfterOp, BranchAction, BranchOp, BranchSwitcher};
use crate::changes::{self, DiffMode, DiffSelection, GroupKey, Grouped};
use crate::commit_box::{ComboStep, CommitBox};
use crate::commit_prefix::render_commit_prefix;
use crate::console::{Console, ConsoleStatus, summarize_git_error};
use crate::data::{DeleteTarget, MergeFailure, RemoteOp, StageOp, encode_uri_component};
use crate::poll::{GIT_POLL_INTERVAL_MS, StatusPoll};
use crate::types::{
    BranchInfo, CommitOk, CommitPrefixConfig, DiffPayload, GitStatusPayload, PrBadge, js_number,
    js_slice_to, plural,
};

/// The workspace the page is for (`useWorkspaces`' active one).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Scope {
    pub id: String,
    pub name: String,
    pub root_path: String,
    pub commit_prefix: Option<CommitPrefixConfig>,
}

/// `busy`: the op in flight (its TS string is in `busy: <op>` errors).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Busy {
    Fetch,
    Pull,
    Push,
    Stage,
    Unstage,
    Discard,
    Commit,
    Checkout,
    Merge,
    Rebase,
    Rename,
    DeleteBranch,
}

impl Busy {
    pub fn as_str(self) -> &'static str {
        match self {
            Busy::Fetch => "fetch",
            Busy::Pull => "pull",
            Busy::Push => "push",
            Busy::Stage => "stage",
            Busy::Unstage => "unstage",
            Busy::Discard => "discard",
            Busy::Commit => "commit",
            Busy::Checkout => "checkout",
            Busy::Merge => "merge",
            Busy::Rebase => "rebase",
            Busy::Rename => "rename",
            Busy::DeleteBranch => "delete-branch",
        }
    }

    fn of_stage(op: StageOp) -> Busy {
        match op {
            StageOp::Stage => Busy::Stage,
            StageOp::Unstage => Busy::Unstage,
            _ => Busy::Discard,
        }
    }

    fn of_remote(op: RemoteOp) -> Busy {
        match op {
            RemoteOp::Fetch => Busy::Fetch,
            RemoteOp::Pull => Busy::Pull,
            RemoteOp::Push => Busy::Push,
        }
    }
}

/// One request, as [`crate::data::GitData`]'s methods take it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Req {
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

/// A request's answer.
#[derive(Clone, Debug, PartialEq)]
pub enum Reply {
    /// The status, and how long it took (the poll's spacing).
    Status(Result<GitStatusPayload, String>, f64),
    Diff(Result<DiffPayload, String>),
    Done(Result<(), String>),
    Commit(Result<CommitOk, String>),
    Text(Result<String, String>),
    Output(Result<Option<String>, String>),
    Branches(Result<Vec<BranchInfo>, String>),
    Merge(Result<Option<String>, MergeFailure>),
    Pr(Option<PrBadge>),
}

/// A TS `confirm(…)`: the question, and what a yes does.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Question {
    pub message: String,
    pub then: Then,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Then {
    Discard(Vec<String>),
    Remote(RemoteOp),
    PullWithClaude,
    Remove { path: String, untracked: bool },
    Rollback(String),
    OpenChat(String),
    DeleteLocal(String),
    ForceDelete { name: String, error: String },
    DeleteRemote(String),
}

/// What the view does for the page.
#[derive(Clone, Debug, PartialEq)]
pub enum Out {
    /// Send `req`; hand its answer to [`GitPage::reply`] with `ticket`.
    Send(u64, Req),
    /// Fire [`GitPage::timer_fired`] with this id after `ms`.
    Arm { timer: u64, ms: f64 },
    /// `router.push(url)`.
    Navigate(String),
}

/// Why a request is in flight.
#[derive(Clone, Debug, PartialEq, Eq)]
enum Purpose {
    Status(u64),
    Pr(String),
    Draft,
    SaveDraft { message: String, then: AfterSave },
    ClearDraft { then: AfterClear },
    Diff(u64),
    StageBulk { op: StageOp, paths: Vec<String> },
    Revert(String),
    Remove { path: String, untracked: bool },
    StageSingle { op: StageOp, path: String },
    Remote(RemoteOp),
    PushFor(OpFor),
    UpdateFor,
    PullMerge,
    Generate { combo: bool },
    Commit { combo: bool },
    Branches(u64),
    Branch { op: BranchOp, command: String },
}

/// Who asked for a silent push: the combo button or the branch menu.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum OpFor {
    Combo,
    Branch,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum AfterSave {
    Generate,
    Combo,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum AfterClear {
    Submit,
    Combo,
}

/// The diff pane's fetch (`GitFileView`).
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct DiffState {
    pub key: Option<DiffSelection>,
    pub payload: Option<DiffPayload>,
    pub loading: bool,
    pub error: Option<String>,
    generation: u64,
}

/// The checked set, in insertion order (`Array.from(new Set(...))`).
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Checked(Vec<String>);

impl Checked {
    pub fn contains(&self, p: &str) -> bool {
        self.0.iter().any(|x| x == p)
    }
    pub fn insert(&mut self, p: &str) {
        if !self.contains(p) {
            self.0.push(p.to_owned());
        }
    }
    pub fn remove(&mut self, p: &str) {
        self.0.retain(|x| x != p);
    }
    pub fn len(&self) -> usize {
        self.0.len()
    }
    pub fn is_empty(&self) -> bool {
        self.0.is_empty()
    }
    pub fn paths(&self) -> Vec<String> {
        self.0.clone()
    }
    pub fn clear(&mut self) {
        self.0.clear();
    }
}

/// `runPullWithClaude`'s refusal on a dirty tree (page.tsx:460).
pub const PULL_REFUSED: &str =
    "Pull refused: you have local changes. Commit, stash, or rollback first.";
/// `runStage` with nothing checked (page.tsx:586).
pub const SELECT_FIRST: &str = "Select at least one file first.";

#[derive(Clone, Debug)]
pub struct GitPage {
    scope: Scope,
    poll: StatusPoll,
    pub data: Option<GitStatusPayload>,
    pub status_error: Option<String>,
    pub status_loading: bool,
    pub checked: Checked,
    pub selected: Option<DiffSelection>,
    pub busy: Option<Busy>,
    pub op_error: Option<String>,
    pub collapsed_groups: HashSet<GroupKey>,
    pub group_by_directory: bool,
    pub collapsed_dirs: BTreeSet<String>,
    pub deleting_path: Option<String>,
    pub draft_message: String,
    pub pr_badge: Option<PrBadge>,
    pr_key: String,
    pub console: Console,
    pub diff: DiffState,
    pub commit_box: CommitBox,
    pub branches: BranchSwitcher,
    pub question: Option<Question>,
    next_ticket: u64,
    pending: HashMap<u64, Purpose>,
}

/// `branchLabel` (page.tsx:1015): the branch, `<sha> (detached)`, or none.
pub fn branch_label(data: Option<&GitStatusPayload>) -> Option<String> {
    let d = data.filter(|d| d.is_repo)?;
    if let Some(b) = d.branch.as_deref().filter(|b| !b.is_empty()) {
        return Some(b.to_owned());
    }
    d.head
        .as_deref()
        .filter(|h| !h.is_empty())
        .map(|h| format!("{h} (detached)"))
}

/// `aheadBehind` (page.tsx:1582): `↑a ↓b`, none when both are 0.
pub fn ahead_behind(data: Option<&GitStatusPayload>) -> Option<String> {
    let d = data.filter(|d| d.is_repo)?;
    let a = d.ahead.unwrap_or(0.);
    let b = d.behind.unwrap_or(0.);
    if a == 0. && b == 0. {
        return None;
    }
    Some(format!("↑{} ↓{}", js_number(a), js_number(b)))
}

fn commits(n: f64) -> String {
    format!("{} commit{}", js_number(n), if n == 1. { "" } else { "s" })
}

/// The Pull button's title.
pub fn pull_title(behind: f64) -> String {
    if behind > 0. {
        format!("git pull --ff-only · {} behind", commits(behind))
    } else {
        "git pull --ff-only".into()
    }
}

/// The Pull + resolve button's title.
pub fn pull_resolve_title(behind: f64) -> String {
    if behind > 0. {
        format!(
            "git pull (merge) · {} behind. On conflicts, opens Claude Code to resolve.",
            commits(behind)
        )
    } else {
        "git pull (merge). On conflicts, opens Claude Code to resolve.".into()
    }
}

/// The Push button's title.
pub fn push_title(ahead: f64) -> String {
    if ahead > 0. {
        format!("git push · {} ahead", commits(ahead))
    } else {
        "git push (auto-set-upstream when needed)".into()
    }
}

/// `Conflicts in N file(s):\n  a\n  b` (+ `\n\n<output>`).
fn conflicts_output(conflicts: &[String], output: Option<&str>) -> String {
    let list: Vec<String> = conflicts.iter().map(|p| format!("  {p}")).collect();
    let mut s = format!(
        "Conflicts in {} file(s):\n{}",
        conflicts.len(),
        list.join("\n")
    );
    if let Some(o) = output.filter(|o| !o.is_empty()) {
        s.push_str("\n\n");
        s.push_str(o);
    }
    s
}

/// `message`, then `\n\n<output>` when there is one.
fn with_output(message: &str, output: Option<&str>) -> String {
    match output.filter(|o| !o.is_empty()) {
        Some(o) => format!("{message}\n\n{o}"),
        None => message.to_owned(),
    }
}

const RESOLVE_STEPS: [&str; 6] = [
    "Please resolve them. For each file:",
    "  1. Read the file and find the conflict markers (<<<<<<<, =======, >>>>>>>).",
    "  2. Decide which side to keep — or how to combine — based on the intent of each change.",
    "  3. Remove the conflict markers and write the resolved content back.",
    "  4. Run `git add <file>` to mark it as resolved.",
    "",
];

/// `runPullWithClaude`'s prompt (page.tsx:506).
pub fn pull_conflict_prompt(conflicts: &[String]) -> String {
    let files: Vec<String> = conflicts.iter().map(|p| format!("- {p}")).collect();
    let mut lines = vec![
        "I just ran `git pull` in this workspace and there are merge conflicts in the following file(s):".to_owned(),
        String::new(),
        files.join("\n"),
        String::new(),
    ];
    lines.extend(RESOLVE_STEPS.iter().map(|s| (*s).to_owned()));
    lines.extend(
        [
            "Important constraints:",
            "  - Do NOT run `git merge --abort` or otherwise revert the pull.",
            "  - Do NOT run `git commit`. I will review the staged resolution and commit it myself in the Git UI.",
            "  - Stop once every conflicted file has been staged.",
        ]
        .map(str::to_owned),
    );
    lines.join("\n")
}

/// `buildConflictPrompt` (page.tsx:1133): merge verbs or rebase verbs.
pub fn conflict_prompt(rebase: bool, label: &str, conflicts: &[String]) -> String {
    let files: Vec<String> = conflicts.iter().map(|p| format!("- {p}")).collect();
    let intro = if rebase {
        format!(
            "I just ran a rebase ({label}) in this workspace and there are conflicts in the following file(s):"
        )
    } else {
        format!(
            "I just ran `git merge {label}` in this workspace and there are merge conflicts in the following file(s):"
        )
    };
    let finalise = if rebase {
        [
            "Important constraints:",
            "  - Do NOT run `git rebase --abort` or otherwise revert the rebase.",
            "  - After staging the fixes for the current step, run `git rebase --continue`.",
            "  - Subsequent commits in the rebase may surface more conflicts — repeat the process for each.",
            "  - Stop once `git status` reports the rebase is finished (no in-progress rebase).",
        ]
        .join("\n")
    } else {
        [
            "Important constraints:",
            "  - Do NOT run `git merge --abort` or otherwise revert the merge.",
            "  - Do NOT run `git commit`. I will review the staged resolution and commit it myself in the Git UI.",
            "  - Stop once every conflicted file has been staged.",
        ]
        .join("\n")
    };
    let mut lines = vec![intro, String::new(), files.join("\n"), String::new()];
    lines.extend(RESOLVE_STEPS.iter().map(|s| (*s).to_owned()));
    lines.push(finalise);
    lines.join("\n")
}

/// `/?new=1&prompt=<encodeURIComponent(prompt)>`.
pub fn new_chat_url(prompt: &str) -> String {
    format!("/?new=1&prompt={}", encode_uri_component(prompt))
}

/// `git push <remote> --delete <branch>` for `origin/x` (page.tsx:1432).
pub fn remote_delete_command(name: &str) -> String {
    match name.find('/') {
        Some(i) if i > 0 => format!("git push {} --delete {}", &name[..i], &name[i + 1..]),
        _ => format!("git push origin --delete {name}"),
    }
}

impl GitPage {
    /// The page mounted for `scope`: the first status poll and the draft
    /// load (`useGitStatus`'s and the draft effect's first runs).
    pub fn new(scope: Scope) -> (GitPage, Vec<Out>) {
        let mut page = GitPage {
            commit_box: CommitBox::new(&scope.id, "", None),
            scope,
            poll: StatusPoll::new(GIT_POLL_INTERVAL_MS),
            data: None,
            status_error: None,
            status_loading: false,
            checked: Checked::default(),
            selected: None,
            busy: None,
            op_error: None,
            collapsed_groups: HashSet::new(),
            group_by_directory: false,
            collapsed_dirs: BTreeSet::new(),
            deleting_path: None,
            draft_message: String::new(),
            pr_badge: None,
            pr_key: String::new(),
            console: Console::default(),
            diff: DiffState::default(),
            branches: BranchSwitcher::default(),
            question: None,
            next_ticket: 0,
            pending: HashMap::new(),
        };
        let mut out = Vec::new();
        if let Some(id) = page.poll.run(false) {
            out.push(page.send(Purpose::Status(id), Req::Status));
        }
        out.push(page.send(Purpose::Draft, Req::GetDraft));
        (page, out)
    }

    pub fn scope(&self) -> &Scope {
        &self.scope
    }

    /// The same workspace with a new name, root or prefix config (the
    /// `active` record re-read): the prefix follows (page.tsx:1578).
    pub fn set_scope(&mut self, scope: Scope) {
        debug_assert_eq!(scope.id, self.scope.id);
        self.scope = scope;
        self.sync_commit_box();
    }

    /// Unmount: nothing in flight counts any more.
    pub fn dispose(&mut self) {
        self.poll.dispose();
        self.pending.clear();
    }

    fn send(&mut self, purpose: Purpose, req: Req) -> Out {
        self.next_ticket += 1;
        self.pending.insert(self.next_ticket, purpose);
        Out::Send(self.next_ticket, req)
    }

    // ---- derived ----------------------------------------------------------

    pub fn is_repo(&self) -> bool {
        self.data.as_ref().is_some_and(|d| d.is_repo)
    }

    pub fn branch_label(&self) -> Option<String> {
        branch_label(self.data.as_ref())
    }

    pub fn detached(&self) -> bool {
        self.data.as_ref().is_some_and(|d| {
            d.branch.as_deref().unwrap_or_default().is_empty()
                && d.head.as_deref().is_some_and(|h| !h.is_empty())
        })
    }

    pub fn ahead(&self) -> f64 {
        self.data
            .as_ref()
            .filter(|d| d.is_repo)
            .and_then(|d| d.ahead)
            .unwrap_or(0.)
    }

    pub fn behind(&self) -> f64 {
        self.data
            .as_ref()
            .filter(|d| d.is_repo)
            .and_then(|d| d.behind)
            .unwrap_or(0.)
    }

    /// `commitPrefix` (page.tsx:1578).
    pub fn commit_prefix(&self) -> Option<String> {
        let d = self.data.as_ref().filter(|d| d.is_repo)?;
        render_commit_prefix(d.branch.as_deref(), self.scope.commit_prefix.as_ref())
    }

    pub fn groups(&self) -> Grouped {
        changes::group_files(self.data.as_ref().map_or(&[][..], |d| &d.files))
    }

    /// The header checkbox: `Some(true)` all visible checked, `None` some.
    pub fn all_checked(&self) -> Option<bool> {
        let g = self.groups();
        let n = g.visible_len();
        let k = g
            .visible()
            .filter(|f| self.checked.contains(&f.path))
            .count();
        if n > 0 && k == n {
            Some(true)
        } else if k > 0 {
            None
        } else {
            Some(false)
        }
    }

    pub fn selected_file(&self) -> Option<&crate::types::GitFileChange> {
        let sel = self.selected.as_ref()?;
        self.data
            .as_ref()?
            .files
            .iter()
            .find(|f| f.path == sel.path)
    }

    /// The diff header's Staged / Unstaged toggle (GitFileView.tsx:113).
    pub fn needs_mode_toggle(&self) -> bool {
        let Some(sel) = &self.selected else {
            return false;
        };
        sel.mode != DiffMode::Untracked
            && self.selected_file().is_some_and(|f| {
                changes::is_partial_stage(f) || (f.index == "A" && f.worktree == "D")
            })
    }

    /// The error banner's line: the status error first.
    pub fn banner(&self) -> Option<&str> {
        self.status_error
            .as_deref()
            .or(self.op_error.as_deref())
            .map(crate::console::first_line)
    }

    /// The header's sync and stage buttons (`!wsId || busy != null || …`).
    pub fn sync_enabled(&self) -> bool {
        self.busy.is_none() && self.is_repo()
    }

    pub fn stage_enabled(&self) -> bool {
        self.busy.is_none() && !self.checked.is_empty()
    }

    // ---- the status -------------------------------------------------------

    /// `refresh()`: the spinner, and a poll that supersedes a running one.
    pub fn refresh(&mut self) -> Vec<Out> {
        self.status_loading = true;
        match self.poll.run(true) {
            Some(id) => vec![self.send(Purpose::Status(id), Req::Status)],
            None => Vec::new(),
        }
    }

    pub fn timer_fired(&mut self, timer: u64, visible: bool) -> Vec<Out> {
        match self.poll.tick(timer, visible) {
            Some(id) => vec![self.send(Purpose::Status(id), Req::Status)],
            None => Vec::new(),
        }
    }

    /// The window came back to the front (`visibilitychange`).
    pub fn became_visible(&mut self) -> Vec<Out> {
        match self.poll.visible() {
            Some(id) => vec![self.send(Purpose::Status(id), Req::Status)],
            None => Vec::new(),
        }
    }

    fn status_answered(
        &mut self,
        id: u64,
        result: Result<GitStatusPayload, String>,
        took: f64,
    ) -> Vec<Out> {
        if !self.poll.is_current(id) {
            return Vec::new();
        }
        let mut out = Vec::new();
        match result {
            Ok(payload) => {
                self.data = Some(payload);
                self.status_error = None;
                self.data_changed(&mut out);
            }
            Err(e) => self.status_error = Some(e),
        }
        self.status_loading = false;
        if let Some((timer, ms)) = self.poll.settled(id, took) {
            out.push(Out::Arm { timer, ms });
        }
        out
    }

    /// `lastData !== data` (page.tsx:367): stale checks and a gone
    /// selection drop; the PR key and the prefix follow the branch.
    fn data_changed(&mut self, out: &mut Vec<Out>) {
        let present: HashSet<String> = self
            .data
            .as_ref()
            .map(|d| d.files.iter().map(|f| f.path.clone()).collect())
            .unwrap_or_default();
        self.checked.0.retain(|p| present.contains(p));
        if self
            .selected
            .as_ref()
            .is_some_and(|s| !present.contains(&s.path))
        {
            self.select(None, out);
        }
        let key = match &self.data {
            Some(d) if d.is_repo => format!(
                "{}|{}",
                self.scope.id,
                d.branch.as_deref().unwrap_or_default()
            ),
            _ => String::new(),
        };
        if key != self.pr_key {
            self.pr_key = key.clone();
            self.pr_badge = None;
            if !key.is_empty() {
                out.push(self.send(Purpose::Pr(key), Req::PrStatus));
            }
        }
        self.sync_commit_box();
    }

    fn sync_commit_box(&mut self) {
        let prefix = self.commit_prefix();
        let draft = self.draft_message.clone();
        let id = self.scope.id.clone();
        self.commit_box.sync(&id, &draft, prefix.as_deref());
    }

    // ---- selection and checks ---------------------------------------------

    /// `setSelected`: a new key resets and refetches the diff.
    pub fn select_change(&mut self, sel: Option<DiffSelection>) -> Vec<Out> {
        let mut out = Vec::new();
        self.select(sel, &mut out);
        out
    }

    fn select(&mut self, sel: Option<DiffSelection>, out: &mut Vec<Out>) {
        self.selected = sel.clone();
        let Some(sel) = sel else {
            self.diff = DiffState {
                generation: self.diff.generation + 1,
                ..DiffState::default()
            };
            return;
        };
        if self.diff.key.as_ref() == Some(&sel) {
            return;
        }
        let generation = self.diff.generation + 1;
        self.diff = DiffState {
            key: Some(sel.clone()),
            payload: None,
            loading: true,
            error: None,
            generation,
        };
        out.push(self.send(
            Purpose::Diff(generation),
            Req::Diff {
                path: sel.path,
                mode: sel.mode,
            },
        ));
    }

    /// ↑ / ↓ in the list.
    pub fn step(&mut self, down: bool) -> Vec<Out> {
        let order = changes::nav_order(
            &self.groups(),
            self.group_by_directory,
            &self.collapsed_groups,
            &self.collapsed_dirs,
        );
        match changes::step_selection(&order, self.selected.as_ref(), down) {
            Some(next) => self.select_change(Some(next)),
            None => Vec::new(),
        }
    }

    /// The diff header's Staged / Unstaged toggle.
    pub fn set_diff_mode(&mut self, mode: DiffMode) -> Vec<Out> {
        match self.selected.clone() {
            Some(s) => self.select_change(Some(DiffSelection { mode, ..s })),
            None => Vec::new(),
        }
    }

    pub fn toggle_check(&mut self, path: &str, next: bool) {
        if next {
            self.checked.insert(path);
        } else {
            self.checked.remove(path);
        }
    }

    /// `onToggleAll` (page.tsx:395): every path of `data.files` (the hidden
    /// `AD` entries too, as the TS does), or none.
    pub fn toggle_all(&mut self, next: bool) {
        let Some(d) = &self.data else { return };
        if next {
            self.checked = Checked::default();
            for f in &d.files {
                self.checked.insert(&f.path);
            }
        } else {
            self.checked.clear();
        }
    }

    /// A folder's checkbox: every file under it to `next`.
    pub fn toggle_dir(&mut self, file_paths: &[String], next: bool) {
        for p in file_paths {
            self.toggle_check(p, next);
        }
    }

    pub fn toggle_group(&mut self, g: GroupKey) {
        if !self.collapsed_groups.remove(&g) {
            self.collapsed_groups.insert(g);
        }
    }

    pub fn toggle_dir_collapsed(&mut self, key: &str) {
        if !self.collapsed_dirs.remove(key) {
            self.collapsed_dirs.insert(key.to_owned());
        }
    }

    // ---- questions --------------------------------------------------------

    fn ask(&mut self, message: String, then: Then) -> Vec<Out> {
        self.question = Some(Question { message, then });
        Vec::new()
    }

    /// The question's answer.
    pub fn answer(&mut self, yes: bool) -> Vec<Out> {
        let Some(q) = self.question.take() else {
            return Vec::new();
        };
        if !yes {
            if let Then::ForceDelete { error, .. } = &q.then {
                self.branches.force_declined(error);
            }
            return Vec::new();
        }
        match q.then {
            Then::Discard(paths) => self.stage_now(StageOp::Discard, paths),
            Then::Remote(op) => self.remote_now(op),
            Then::PullWithClaude => self.pull_merge_now(),
            Then::Remove { path, untracked } => self.remove_now(path, untracked),
            Then::Rollback(path) => self.revert_single(&path),
            Then::OpenChat(url) => vec![Out::Navigate(url)],
            Then::DeleteLocal(name) => {
                let op = self.branches.begin_delete_local(&name, false);
                self.branch_op(op)
            }
            Then::ForceDelete { name, .. } => {
                let op = self.branches.begin_delete_local(&name, true);
                self.branch_op(op)
            }
            Then::DeleteRemote(name) => {
                let op = self.branches.begin_delete_remote(&name);
                self.branch_op(op)
            }
        }
    }

    // ---- stage / unstage / discard ----------------------------------------

    /// The header's Stage / Unstage / Rollback (`runStage`, page.tsx:582).
    pub fn run_stage(&mut self, op: StageOp) -> Vec<Out> {
        let paths = self.checked.paths();
        if paths.is_empty() {
            self.op_error = Some(SELECT_FIRST.into());
            return Vec::new();
        }
        if op == StageOp::Discard {
            let n = paths.len();
            return self.ask(
                format!(
                    "Discard local changes in {n} file{}? This cannot be undone.",
                    plural(n)
                ),
                Then::Discard(paths),
            );
        }
        self.stage_now(op, paths)
    }

    fn stage_now(&mut self, op: StageOp, paths: Vec<String>) -> Vec<Out> {
        self.busy = Some(Busy::of_stage(op));
        self.op_error = None;
        vec![self.send(
            Purpose::StageBulk {
                op,
                paths: paths.clone(),
            },
            Req::Stage { paths, op },
        )]
    }

    /// The row's revert (`runRevertSingle`, page.tsx:651): no question.
    pub fn revert_single(&mut self, path: &str) -> Vec<Out> {
        if self.busy.is_some() || self.deleting_path.is_some() {
            return Vec::new();
        }
        self.deleting_path = Some(path.into());
        self.op_error = None;
        vec![self.send(
            Purpose::Revert(path.into()),
            Req::Stage {
                paths: vec![path.into()],
                op: StageOp::Discard,
            },
        )]
    }

    /// The row's delete (`runRemoveSingle`, page.tsx:696): asks first.
    pub fn remove_single(&mut self, path: &str) -> Vec<Out> {
        if self.busy.is_some() || self.deleting_path.is_some() {
            return Vec::new();
        }
        let untracked = self
            .data
            .as_ref()
            .and_then(|d| d.files.iter().find(|f| f.path == path))
            .is_some_and(|f| f.untracked);
        let message = if untracked {
            format!("Delete {path} from disk? This cannot be undone.")
        } else {
            format!("Delete {path}? Runs `git rm` — stages the deletion, ready to commit.")
        };
        self.ask(
            message,
            Then::Remove {
                path: path.into(),
                untracked,
            },
        )
    }

    fn remove_now(&mut self, path: String, untracked: bool) -> Vec<Out> {
        self.deleting_path = Some(path.clone());
        self.op_error = None;
        vec![self.send(
            Purpose::Remove {
                path: path.clone(),
                untracked,
            },
            Req::Stage {
                paths: vec![path],
                op: StageOp::Remove,
            },
        )]
    }

    /// The Delete / Backspace key on the selected row.
    pub fn delete_key(&mut self) -> Vec<Out> {
        match self.selected.clone() {
            Some(s) => self.remove_single(&s.path),
            None => Vec::new(),
        }
    }

    /// Per-file stage / unstage (`runStageSingle`, the context menu's;
    /// U12b's menu calls it).
    pub fn stage_single(&mut self, op: StageOp, path: &str) -> Vec<Out> {
        if self.busy.is_some() {
            return Vec::new();
        }
        self.busy = Some(Busy::of_stage(op));
        self.op_error = None;
        vec![self.send(
            Purpose::StageSingle {
                op,
                path: path.into(),
            },
            Req::Stage {
                paths: vec![path.into()],
                op,
            },
        )]
    }

    /// "Rollback…" (`rollbackWithConfirm`): tracked files only.
    pub fn rollback_with_confirm(&mut self, path: &str) -> Vec<Out> {
        let tracked = self
            .data
            .as_ref()
            .and_then(|d| d.files.iter().find(|f| f.path == path))
            .is_some_and(|f| !f.untracked);
        if !tracked {
            return Vec::new();
        }
        self.ask(
            format!("Rollback {path}? Local changes are discarded and the HEAD version restored."),
            Then::Rollback(path.into()),
        )
    }

    // ---- remote -----------------------------------------------------------

    /// Fetch / Pull / Push (`runRemote`, page.tsx:547): Push and Pull ask.
    pub fn run_remote(&mut self, op: RemoteOp) -> Vec<Out> {
        let target = self
            .branch_label()
            .unwrap_or_else(|| "current branch".into());
        match op {
            RemoteOp::Push => {
                let ahead = self.data.as_ref().and_then(|d| d.ahead).unwrap_or(0.);
                let detail = if ahead > 0. {
                    format!(" ({} ahead)", commits(ahead))
                } else {
                    String::new()
                };
                self.ask(
                    format!("Push {target}{detail} to remote?"),
                    Then::Remote(op),
                )
            }
            RemoteOp::Pull => self.ask(
                format!("Pull --ff-only into {target}? This aborts on non-fast-forward."),
                Then::Remote(op),
            ),
            RemoteOp::Fetch => self.remote_now(op),
        }
    }

    fn remote_now(&mut self, op: RemoteOp) -> Vec<Out> {
        self.busy = Some(Busy::of_remote(op));
        self.op_error = None;
        vec![self.send(Purpose::Remote(op), Req::Remote { op })]
    }

    /// "Pull + resolve" (`runPullWithClaude`, page.tsx:457).
    pub fn run_pull_with_claude(&mut self) -> Vec<Out> {
        if self.data.as_ref().is_some_and(|d| !d.files.is_empty()) {
            self.op_error = Some(PULL_REFUSED.into());
            return Vec::new();
        }
        let target = self
            .branch_label()
            .unwrap_or_else(|| "current branch".into());
        self.ask(
            format!("Pull and merge upstream into {target}? If conflicts arise, Claude Code will open in a new chat to resolve them."),
            Then::PullWithClaude,
        )
    }

    fn pull_merge_now(&mut self) -> Vec<Out> {
        self.busy = Some(Busy::Pull);
        self.op_error = None;
        vec![self.send(Purpose::PullMerge, Req::PullMerge)]
    }

    // ---- the commit box ---------------------------------------------------

    fn commit_busy(&self) -> bool {
        self.busy == Some(Busy::Commit)
    }

    /// Commit (⌘⏎).
    pub fn submit(&mut self) -> Vec<Out> {
        let busy = self.commit_busy();
        match self.commit_box.begin_submit(busy, self.checked.len()) {
            Some(message) => self.commit(message, false),
            None => Vec::new(),
        }
    }

    /// `onCommit` (page.tsx:904).
    fn commit(&mut self, message: String, combo: bool) -> Vec<Out> {
        let paths = self.checked.paths();
        self.busy = Some(Busy::Commit);
        vec![self.send(
            Purpose::Commit { combo },
            Req::Commit {
                message,
                stage_paths: paths,
            },
        )]
    }

    /// Generate.
    pub fn generate(&mut self) -> Vec<Out> {
        let busy = self.commit_busy();
        if !self.commit_box.begin_generate(busy, self.checked.len()) {
            return Vec::new();
        }
        self.generate_request(false)
    }

    fn generate_request(&mut self, combo: bool) -> Vec<Out> {
        let paths = self.checked.paths();
        vec![self.send(Purpose::Generate { combo }, Req::CommitMessage { paths })]
    }

    /// Commit & Push (⌘⇧⏎), or Stop while it runs.
    pub fn combo(&mut self) -> Vec<Out> {
        if self.commit_box.cancelling {
            return Vec::new();
        }
        if self.commit_box.combo_step.is_some() {
            self.commit_box.cancel_combo();
            return Vec::new();
        }
        let busy = self.commit_busy();
        match self.commit_box.begin_combo(busy, self.checked.len()) {
            Some(ComboStep::Generate) => self.generate_request(true),
            Some(_) => {
                let m = self.commit_box.message().to_owned();
                self.commit(m, true)
            }
            None => Vec::new(),
        }
    }

    /// `runPushSilent` (page.tsx:415): no question, the error back to the
    /// caller.
    fn push_silent(&mut self, who: OpFor) -> Vec<Out> {
        self.busy = Some(Busy::Push);
        vec![self.send(Purpose::PushFor(who), Req::Remote { op: RemoteOp::Push })]
    }

    // ---- branches ---------------------------------------------------------

    /// The chip: opens (loading the list) or closes the popover.
    pub fn toggle_branches(&mut self) -> Vec<Out> {
        if !self.branches.open && (self.busy.is_some() || self.branch_label().is_none()) {
            return Vec::new();
        }
        match self.branches.toggle() {
            Some(g) => vec![self.send(Purpose::Branches(g), Req::Branches)],
            None => Vec::new(),
        }
    }

    /// The popover's refresh button.
    pub fn reload_branches(&mut self) -> Vec<Out> {
        match self.branches.reload() {
            Some(g) => vec![self.send(Purpose::Branches(g), Req::Branches)],
            None => Vec::new(),
        }
    }

    /// A row pick or a submenu item.
    pub fn branch_action(&mut self, action: BranchAction) -> Vec<Out> {
        match &action {
            BranchAction::DeleteLocal(n) => {
                return self.ask(
                    crate::branches::delete_local_question(n),
                    Then::DeleteLocal(n.clone()),
                );
            }
            BranchAction::DeleteRemote(n) => {
                return self.ask(
                    crate::branches::delete_remote_question(n),
                    Then::DeleteRemote(n.clone()),
                );
            }
            _ => {}
        }
        match self.branches.start(&action) {
            Some(op) => self.branch_op(op),
            None => Vec::new(),
        }
    }

    /// The new-branch / rename prompt's answer (`None`: cancelled).
    pub fn answer_branch_prompt(&mut self, value: Option<&str>) -> Vec<Out> {
        match self.branches.answer_prompt(value) {
            Some(op) => self.branch_op(op),
            None => Vec::new(),
        }
    }

    /// The page's branch handlers (page.tsx:1037–1567): the busy guard,
    /// then the request.
    fn branch_op(&mut self, op: BranchOp) -> Vec<Out> {
        let guarded = !matches!(
            op,
            BranchOp::Compare { .. } | BranchOp::ShowDiff(_) | BranchOp::Update | BranchOp::Push
        );
        if guarded && let Some(b) = self.busy {
            let after = self.branches.op_done(Err(format!("busy: {}", b.as_str())));
            return self.after_branch_op(after);
        }
        let (busy, command, req) = match &op {
            BranchOp::Checkout(name) => (
                Some(Busy::Checkout),
                format!("git checkout {name}"),
                Req::Checkout {
                    name: name.clone(),
                    create: false,
                    start_point: None,
                },
            ),
            BranchOp::Create { name, start_point } => (
                Some(Busy::Checkout),
                format!("git checkout -b {name}"),
                Req::Checkout {
                    name: name.clone(),
                    create: true,
                    start_point: start_point.clone(),
                },
            ),
            BranchOp::Merge(name) => (
                Some(Busy::Merge),
                format!("git merge --no-rebase --no-edit {name}"),
                Req::Merge { name: name.clone() },
            ),
            BranchOp::RebaseCurrentOnto(onto) => (
                Some(Busy::Rebase),
                format!("git rebase {onto}"),
                Req::Rebase {
                    onto: onto.clone(),
                    checkout_branch: None,
                },
            ),
            BranchOp::CheckoutAndRebase { branch, onto } => (
                Some(Busy::Rebase),
                format!("git switch {branch} && git rebase {onto}"),
                Req::Rebase {
                    onto: onto.clone(),
                    checkout_branch: Some(branch.clone()),
                },
            ),
            BranchOp::Rename { old_name, new_name } => (
                Some(Busy::Rename),
                format!("git branch -m {old_name} {new_name}"),
                Req::Rename {
                    old_name: old_name.clone(),
                    new_name: new_name.clone(),
                },
            ),
            BranchOp::DeleteLocal { name, force } => (
                Some(Busy::DeleteBranch),
                format!("git branch {} {name}", if *force { "-D" } else { "-d" }),
                Req::Delete {
                    name: name.clone(),
                    target: DeleteTarget::Local { force: *force },
                },
            ),
            BranchOp::DeleteRemote(name) => (
                Some(Busy::DeleteBranch),
                remote_delete_command(name),
                Req::Delete {
                    name: name.clone(),
                    target: DeleteTarget::Remote,
                },
            ),
            BranchOp::Compare { base, head } => (
                None,
                format!("git log {base}..{head}"),
                Req::Compare {
                    base: base.clone(),
                    head: head.clone(),
                },
            ),
            BranchOp::ShowDiff(name) => (
                None,
                format!("git diff {name}"),
                Req::DiffWithWorktree { head: name.clone() },
            ),
            BranchOp::Update => {
                self.busy = Some(Busy::Pull);
                self.op_error = None;
                return vec![self.send(Purpose::UpdateFor, Req::Remote { op: RemoteOp::Pull })];
            }
            BranchOp::Push => return self.push_silent(OpFor::Branch),
        };
        if busy.is_some() {
            self.busy = busy;
            self.op_error = None;
        }
        vec![self.send(Purpose::Branch { op, command }, req)]
    }

    fn after_branch_op(&mut self, after: AfterOp) -> Vec<Out> {
        match after {
            AfterOp::Nothing => Vec::new(),
            AfterOp::Reload => self.reload_branches(),
            AfterOp::AskForce { name, error } => self.ask(
                crate::branches::force_delete_question(&name),
                Then::ForceDelete { name, error },
            ),
        }
    }

    /// A branch op's `OpResult` back to the popover.
    fn branch_result(&mut self, r: Result<(), String>) -> Vec<Out> {
        let after = self.branches.op_done(r);
        self.after_branch_op(after)
    }

    /// `handleConflictBody` (page.tsx:1178).
    fn conflicts(
        &mut self,
        rebase: bool,
        command: &str,
        target: &str,
        f: &MergeFailure,
    ) -> (Vec<Out>, String) {
        let conflicts = f.conflicts.clone().unwrap_or_default();
        self.console.push(
            command,
            ConsoleStatus::Error,
            &conflicts_output(&conflicts, f.output.as_deref()),
        );
        self.checked.clear();
        let mut out = Vec::new();
        self.select(None, &mut out);
        out.extend(self.refresh());
        let kind = if rebase { "rebase" } else { "merge" };
        let n = conflicts.len();
        if n > 0 {
            let prompt = conflict_prompt(rebase, target, &conflicts);
            out.extend(self.ask(
                format!(
                    "Open Claude Code to resolve {n} {kind} conflict{}?",
                    plural(n)
                ),
                Then::OpenChat(new_chat_url(&prompt)),
            ));
        }
        (out, format!("{n} conflict{} during {kind}", plural(n)))
    }

    // ---- answers ----------------------------------------------------------

    /// Request `ticket` answered.
    pub fn reply(&mut self, ticket: u64, reply: Reply) -> Vec<Out> {
        let Some(purpose) = self.pending.remove(&ticket) else {
            return Vec::new();
        };
        match (purpose, reply) {
            (Purpose::Status(id), Reply::Status(r, took)) => self.status_answered(id, r, took),
            (Purpose::Pr(key), Reply::Pr(badge)) => {
                if key == self.pr_key {
                    self.pr_badge = badge;
                }
                Vec::new()
            }
            (Purpose::Draft, Reply::Text(r)) => {
                if let Ok(m) = r {
                    self.draft_message = m;
                    self.sync_commit_box();
                }
                Vec::new()
            }
            (Purpose::Diff(generation), Reply::Diff(r)) => {
                if generation == self.diff.generation {
                    match r {
                        Ok(p) => self.diff.payload = Some(p),
                        Err(e) => self.diff.error = Some(e),
                    }
                    self.diff.loading = false;
                }
                Vec::new()
            }
            (Purpose::StageBulk { op, paths }, Reply::Done(r)) => {
                self.busy = None;
                match r {
                    Err(e) => {
                        self.console
                            .push(format!("git {}", op.as_str()), ConsoleStatus::Error, &e);
                        self.op_error = Some(e);
                        Vec::new()
                    }
                    Ok(()) => {
                        if op == StageOp::Discard {
                            let n = paths.len();
                            let list: Vec<String> =
                                paths.iter().map(|p| format!("  {p}")).collect();
                            self.console.push(
                                "git discard",
                                ConsoleStatus::Ok,
                                &format!(
                                    "Discarded changes in {n} file{}:\n{}",
                                    plural(n),
                                    list.join("\n")
                                ),
                            );
                        }
                        self.refresh()
                    }
                }
            }
            (Purpose::Revert(path), Reply::Done(r)) => {
                self.deleting_path = None;
                match r {
                    Err(e) => {
                        self.console
                            .push(format!("git discard {path}"), ConsoleStatus::Error, &e);
                        self.op_error = Some(e);
                        Vec::new()
                    }
                    Ok(()) => {
                        self.console.push(
                            "git discard",
                            ConsoleStatus::Ok,
                            &format!("Reverted: {path}"),
                        );
                        self.refresh()
                    }
                }
            }
            (Purpose::Remove { path, untracked }, Reply::Done(r)) => {
                self.deleting_path = None;
                match r {
                    Err(e) => {
                        self.console
                            .push(format!("git remove {path}"), ConsoleStatus::Error, &e);
                        self.op_error = Some(e);
                        Vec::new()
                    }
                    Ok(()) => {
                        let msg = if untracked {
                            format!("Deleted untracked file: {path}")
                        } else {
                            format!("git rm: {path}")
                        };
                        self.console.push("git remove", ConsoleStatus::Ok, &msg);
                        self.refresh()
                    }
                }
            }
            (Purpose::StageSingle { op, path }, Reply::Done(r)) => {
                self.busy = None;
                match r {
                    Err(e) => {
                        self.console.push(
                            format!("git {} {path}", op.as_str()),
                            ConsoleStatus::Error,
                            &e,
                        );
                        self.op_error = Some(e);
                        Vec::new()
                    }
                    Ok(()) => self.refresh(),
                }
            }
            (Purpose::Remote(op), Reply::Output(r)) => {
                self.busy = None;
                let command = format!("git {}", op.as_str());
                match r {
                    Err(e) => {
                        self.console.push(command, ConsoleStatus::Error, &e);
                        self.op_error = Some(e);
                        Vec::new()
                    }
                    Ok(o) => {
                        self.console.push(
                            command,
                            ConsoleStatus::Ok,
                            o.as_deref().unwrap_or_default(),
                        );
                        self.refresh()
                    }
                }
            }
            (Purpose::PushFor(who), Reply::Output(r)) => {
                self.busy = None;
                let (mut out, result) = match r {
                    Err(e) => {
                        self.console.push("git push", ConsoleStatus::Error, &e);
                        (Vec::new(), Err(summarize_git_error(&e)))
                    }
                    Ok(o) => {
                        self.console.push(
                            "git push",
                            ConsoleStatus::Ok,
                            o.as_deref().unwrap_or_default(),
                        );
                        (self.refresh(), Ok(()))
                    }
                };
                match who {
                    OpFor::Combo => {
                        if let Err(e) = result {
                            self.commit_box.error =
                                Some(format!("Committed locally; push failed: {e}"));
                        }
                        self.commit_box.end_combo();
                    }
                    OpFor::Branch => out.extend(self.branch_result(result)),
                }
                out
            }
            (Purpose::UpdateFor, Reply::Output(r)) => {
                self.busy = None;
                let command = "git pull --ff-only";
                let (mut out, result) = match r {
                    Err(e) => {
                        self.console.push(command, ConsoleStatus::Error, &e);
                        (Vec::new(), Err(summarize_git_error(&e)))
                    }
                    Ok(o) => {
                        self.console.push(
                            command,
                            ConsoleStatus::Ok,
                            o.as_deref().unwrap_or_default(),
                        );
                        (self.refresh(), Ok(()))
                    }
                };
                out.extend(self.branch_result(result));
                out
            }
            (Purpose::PullMerge, Reply::Merge(r)) => {
                self.busy = None;
                let command = "git pull (merge)";
                match r {
                    Ok(o) => {
                        self.console.push(
                            command,
                            ConsoleStatus::Ok,
                            o.as_deref().unwrap_or_default(),
                        );
                        self.refresh()
                    }
                    Err(f) if f.conflicts.as_ref().is_some_and(|c| !c.is_empty()) => {
                        let conflicts = f.conflicts.clone().unwrap_or_default();
                        self.console.push(
                            command,
                            ConsoleStatus::Error,
                            &conflicts_output(&conflicts, f.output.as_deref()),
                        );
                        let mut out = self.refresh();
                        let n = conflicts.len();
                        let prompt = pull_conflict_prompt(&conflicts);
                        out.extend(self.ask(
                            format!("Open Claude Code to resolve {n} conflict{}?", plural(n)),
                            Then::OpenChat(new_chat_url(&prompt)),
                        ));
                        out
                    }
                    Err(f) => {
                        self.console.push(
                            command,
                            ConsoleStatus::Error,
                            &with_output(&f.message, f.output.as_deref()),
                        );
                        self.op_error = Some(f.message);
                        Vec::new()
                    }
                }
            }
            (Purpose::Generate { combo }, Reply::Text(r)) => {
                let prefix = self.commit_prefix();
                if combo {
                    if self.commit_box.cancelled() {
                        self.commit_box.end_combo();
                        return Vec::new();
                    }
                    match r {
                        Err(e) => {
                            self.commit_box.error = Some(e);
                            self.commit_box.end_combo();
                            Vec::new()
                        }
                        Ok(m) => {
                            let next = CommitBox::with_prefix(&m, prefix.as_deref());
                            self.commit_box.combo_generated(next.clone());
                            vec![self.send(
                                Purpose::SaveDraft {
                                    message: next.clone(),
                                    then: AfterSave::Combo,
                                },
                                Req::SaveDraft { message: next },
                            )]
                        }
                    }
                } else {
                    match self.commit_box.generated(r, prefix.as_deref()) {
                        Some(next) => vec![self.send(
                            Purpose::SaveDraft {
                                message: next.clone(),
                                then: AfterSave::Generate,
                            },
                            Req::SaveDraft { message: next },
                        )],
                        None => Vec::new(),
                    }
                }
            }
            (Purpose::SaveDraft { message, then }, Reply::Done(r)) => {
                if r.is_ok() {
                    self.draft_message = message;
                    self.sync_commit_box();
                }
                match then {
                    AfterSave::Generate => {
                        self.commit_box.generate_done();
                        Vec::new()
                    }
                    AfterSave::Combo => {
                        if self.commit_box.cancelled() {
                            self.commit_box.end_combo();
                            return Vec::new();
                        }
                        self.commit_box.combo_step = Some(ComboStep::Commit);
                        let m = self.commit_box.message().to_owned();
                        self.commit(m, true)
                    }
                }
            }
            (Purpose::Commit { combo }, Reply::Commit(r)) => {
                self.busy = None;
                let result = match r {
                    Err(e) => {
                        self.console.push("git commit", ConsoleStatus::Error, &e);
                        Err(summarize_git_error(&e))
                    }
                    Ok(c) => {
                        let sha = js_slice_to(c.sha.as_deref().unwrap_or_default(), 7);
                        let subject = c.subject.as_deref().unwrap_or_default();
                        let line = if sha.is_empty() {
                            subject.to_owned()
                        } else {
                            format!("[{sha}] {subject}")
                        };
                        self.console.push("git commit", ConsoleStatus::Ok, &line);
                        Ok(())
                    }
                };
                let mut out = Vec::new();
                if result.is_ok() {
                    self.checked.clear();
                    self.select(None, &mut out);
                    out.extend(self.refresh());
                }
                match (combo, result) {
                    (false, r) => {
                        let ok = r.is_ok();
                        self.commit_box.submitted(r);
                        if ok {
                            out.push(self.send(
                                Purpose::ClearDraft {
                                    then: AfterClear::Submit,
                                },
                                Req::ClearDraft,
                            ));
                        }
                    }
                    (true, Err(e)) => {
                        self.commit_box.error = Some(e);
                        self.commit_box.end_combo();
                    }
                    (true, Ok(())) => {
                        self.commit_box.combo_committed();
                        out.push(self.send(
                            Purpose::ClearDraft {
                                then: AfterClear::Combo,
                            },
                            Req::ClearDraft,
                        ));
                    }
                }
                out
            }
            (Purpose::ClearDraft { then }, Reply::Done(r)) => {
                if r.is_ok() {
                    self.draft_message.clear();
                    self.sync_commit_box();
                }
                match then {
                    AfterClear::Submit => Vec::new(),
                    AfterClear::Combo => {
                        if self.commit_box.cancelled() {
                            self.commit_box.end_combo();
                            return Vec::new();
                        }
                        self.commit_box.combo_step = Some(ComboStep::Push);
                        self.push_silent(OpFor::Combo)
                    }
                }
            }
            (Purpose::Branches(g), Reply::Branches(r)) => {
                self.branches.loaded(g, r);
                Vec::new()
            }
            (Purpose::Branch { op, command }, Reply::Done(r)) => {
                // checkout / create: no `j.output` read.
                self.busy = None;
                match r {
                    Err(e) => {
                        self.console.push(command, ConsoleStatus::Error, &e);
                        self.branch_result(Err(summarize_git_error(&e)))
                    }
                    Ok(()) => {
                        let line = match &op {
                            BranchOp::Create {
                                name,
                                start_point: Some(sp),
                            } => format!("Created and switched to '{name}' from '{sp}'"),
                            BranchOp::Create { name, .. } => {
                                format!("Created and switched to '{name}'")
                            }
                            BranchOp::Checkout(name) => format!("Switched to branch '{name}'"),
                            _ => String::new(),
                        };
                        self.console.push(command, ConsoleStatus::Ok, &line);
                        self.checked.clear();
                        let mut out = Vec::new();
                        self.select(None, &mut out);
                        out.extend(self.refresh());
                        out.extend(self.branch_result(Ok(())));
                        out
                    }
                }
            }
            (Purpose::Branch { op, command }, Reply::Output(r)) => {
                self.branch_output(op, command, r)
            }
            (Purpose::Branch { op, command }, Reply::Merge(r)) => {
                self.busy = None;
                let rebase = !matches!(op, BranchOp::Merge(_));
                match r {
                    Ok(o) => {
                        self.console.push(
                            &command,
                            ConsoleStatus::Ok,
                            o.as_deref().unwrap_or_default(),
                        );
                        let mut out = Vec::new();
                        if rebase {
                            self.checked.clear();
                            self.select(None, &mut out);
                        }
                        out.extend(self.refresh());
                        out.extend(self.branch_result(Ok(())));
                        out
                    }
                    Err(f) if f.conflicts.is_some() => {
                        let target = match &op {
                            BranchOp::Merge(n) => n.clone(),
                            BranchOp::CheckoutAndRebase { branch, onto } => {
                                format!("{branch} onto {onto}")
                            }
                            BranchOp::RebaseCurrentOnto(onto) => format!("current onto {onto}"),
                            _ => String::new(),
                        };
                        let (mut out, error) = self.conflicts(rebase, &command, &target, &f);
                        // The popover hears the error after the question.
                        out.extend(self.branch_result(Err(error)));
                        out
                    }
                    Err(f) => {
                        self.console.push(
                            &command,
                            ConsoleStatus::Error,
                            &with_output(&f.message, f.output.as_deref()),
                        );
                        self.branch_result(Err(summarize_git_error(&f.message)))
                    }
                }
            }
            _ => Vec::new(),
        }
    }

    /// rename / delete / compare / diff: the `output` answers.
    fn branch_output(
        &mut self,
        op: BranchOp,
        command: String,
        r: Result<Option<String>, String>,
    ) -> Vec<Out> {
        let read_only = matches!(op, BranchOp::Compare { .. } | BranchOp::ShowDiff(_));
        if !read_only {
            self.busy = None;
        }
        match r {
            Err(e) => {
                self.console.push(&command, ConsoleStatus::Error, &e);
                // The local delete hands back the full text (the popover
                // looks for "not fully merged" in it).
                let shown = if matches!(op, BranchOp::DeleteLocal { .. }) {
                    e
                } else {
                    summarize_git_error(&e)
                };
                self.branch_result(Err(shown))
            }
            Ok(o) => {
                let fallback = match &op {
                    BranchOp::Rename { old_name, new_name } => {
                        format!("Renamed '{old_name}' → '{new_name}'")
                    }
                    BranchOp::DeleteLocal { name, .. } => format!("Deleted '{name}'"),
                    BranchOp::DeleteRemote(name) => format!("Deleted remote '{name}'"),
                    _ => String::new(),
                };
                self.console
                    .push(&command, ConsoleStatus::Ok, &o.unwrap_or(fallback));
                let mut out = Vec::new();
                if read_only {
                    self.console.open = true;
                } else {
                    out.extend(self.refresh());
                }
                out.extend(self.branch_result(Ok(())));
                out
            }
        }
    }
}
