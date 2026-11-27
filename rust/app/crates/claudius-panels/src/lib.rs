//! The chat's right rail and goal banner (U09b):
//! `components/panels/BackgroundTasksPanel.tsx` with the widgets it mounts
//! (`SessionCard`, `PlanUsageCard`, `ContextBar`, `TokenMeter`,
//! `PermissionPending`, `TodoList` + `AddTodosForm`, `ScheduledLoops`,
//! `BackgroundBashes`, `RecentEdits`, `CollapsibleSection`, `format.ts`)
//! and `components/chat/GoalBanner.tsx`, over claudius-client's
//! `ChatState`.
//!
//! - The pure model: [`format`], [`tasks`] (the lists and the Stop-all
//!   set), [`rows`], [`card`], [`usage`], [`todos`], [`goal`], and
//!   [`rail`] (the whole rail as data), each rule citing its TS line.
//! - [`target`]: [`target::RailTarget`] (U09a's `StatusTarget` plus the
//!   two promises the rail awaits) and [`target::FixtureRail`].
//! - [`view`]: [`view::RailPanel`], the rail on screen, and
//!   [`goal_view`]: [`goal_view::GoalBannerView`], the session header's
//!   goal row; [`paint`] holds what they draw with.
pub mod card;
pub mod format;
pub mod goal;
pub mod goal_view;
pub mod look;
pub mod paint;
pub mod rail;
pub mod rows;
pub mod target;
pub mod tasks;
pub mod todos;
pub mod usage;
pub mod view;

pub use goal_view::GoalBannerView;
pub use target::{FixtureRail, RailTarget};
pub use view::{RailEvent, RailPanel};
