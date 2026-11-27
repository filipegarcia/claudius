//! The loop helpers the hook calls: `lib/shared/stop-self-paced-loop.ts`
//! (`isScheduleWakeupStop`, `markWakeupsStopped`) and
//! `lib/shared/session-loops.ts` (`readCronNextFireAt`), with the client's
//! `ScheduledLoop` shape (`lib/client/types.ts`).
//!
//! The two readers are the server's ports (`claudius_core::session_loops`),
//! which the server's loop reducer already pins against the TS.
//! `scheduledLoopCancelPrompt` and `isStaleWakeup` are the rail chip's and
//! the `/schedule` page's (also in `claudius_core::session_loops`).

use serde::{Deserialize, Serialize};

use crate::types::{JsRecord, num};

pub use claudius_core::session_loops::{
    is_schedule_wakeup_stop, read_cron_next_fire_at, read_ended_loop_wakeup,
};

/// `ScheduledLoop["kind"]`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ScheduledLoopKind {
    Cron,
    Wakeup,
}

/// `ScheduledLoop`: a `CronCreate` / `ScheduleWakeup` the agent armed.
/// `cron`, `humanSchedule` and `delaySeconds` are always there (`null`
/// when they don't apply).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScheduledLoop {
    pub kind: ScheduledLoopKind,
    pub id: String,
    pub tool_use_id: String,
    #[serde(default)]
    pub cron: Option<String>,
    #[serde(default)]
    pub human_schedule: Option<String>,
    #[serde(default, with = "num::opt")]
    pub delay_seconds: Option<f64>,
    pub prompt: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    pub recurring: bool,
    pub durable: bool,
    #[serde(with = "num")]
    pub started_at: f64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub noop: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none", with = "num::opt")]
    pub noop_streak: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none", with = "num::opt")]
    pub next_fire_at: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cancelled: Option<bool>,
}

/// `markWakeupsStopped(prev, stopAt)`: every live (not cancelled) wake-up
/// armed at or before `stop_at` (any, without one) is `cancelled: true`;
/// crons are left alone and every entry keeps its place.
pub fn mark_wakeups_stopped(loops: &mut JsRecord<ScheduledLoop>, stop_at: Option<f64>) -> bool {
    let mut changed = false;
    for l in loops.values_mut() {
        if l.kind != ScheduledLoopKind::Wakeup || l.cancelled == Some(true) {
            continue;
        }
        if stop_at.is_some_and(|at| l.started_at > at) {
            continue;
        }
        l.cancelled = Some(true);
        changed = true;
    }
    changed
}
