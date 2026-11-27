//! The native Git page (U12a): `app/[workspaceId]/git/page.tsx` and the
//! components it mounts (`ChangesList`, `DiffViewer`, `CommitBox`,
//! `BranchSwitcher`, `useGitStatus`, `git-poll`) with the shared
//! `commit-prefix` and `pr-badge` helpers.
//!
//! The rules are pure ([`page::GitPage`] and the modules it drives, each
//! citing its TS line); [`data::GitData`] is the page's fetches (live over a
//! `claudius_transport::Transport`, or [`fixture::FixtureGitData`]); `view`
//! is the GPUI screen.
//!
//! U12b's seams: `FileEditor` (the diff pane's edit mode), `GitConsole` (the
//! console drawer: [`console::Console`] is its state), `ChangeContextMenu`
//! (a row's right click: [`page::GitPage::stage_single`] /
//! [`page::GitPage::rollback_with_confirm`] are its actions) and
//! `GitFileView` / `Window` (the diff in its own window): the view emits a
//! [`view::GitEvent`] for each, and draws nothing for them yet.

pub mod branches;
pub mod changes;
pub mod commit_box;
pub mod commit_prefix;
pub mod console;
pub mod data;
pub mod diff;
pub mod fixture;
pub mod page;
pub mod poll;
pub mod pr_badge;
pub mod types;
pub mod view;
