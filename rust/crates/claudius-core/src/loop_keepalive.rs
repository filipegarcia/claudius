//! `lib/server/loop-keepalive.ts`: whether a session's `/loop` wake-up or
//! session cron still needs its CLI process (CC 2.1.292 parity). The timer
//! lives in that process, so the idle reaper re-arms instead of ending a
//! session with an armed loop. Loops are never removed when they fire (a
//! wake-up is superseded, a cron flagged cancelled), so only one that will
//! still fire, or whose tick may still be running, counts.

use crate::cron::{self, Zone};
use crate::session_loops::{LoopKind, SessionLoop};

/// `LOOP_TICK_GRACE_MS`: how long after a tick's fire time the loop still
/// counts as armed (the tick's turn runs, then arms the next wake-up).
pub const LOOP_TICK_GRACE_MS: i64 = 30 * 60 * 1000;

/// `LOOP_KEEPALIVE_MAX_MS`: the longest an unwatched session cron keeps its
/// session in memory.
pub const LOOP_KEEPALIVE_MAX_MS: i64 = 7 * 24 * 60 * 60 * 1000;

/// `isLoopArmed(loop, now)`, a one-shot cron's first fire resolved in the
/// process's zone.
pub fn is_loop_armed(l: &SessionLoop, now: i64) -> bool {
    is_loop_armed_in(l, now, Zone::Local)
}

/// [`is_loop_armed`] with the cron resolved in `zone`.
pub fn is_loop_armed_in(l: &SessionLoop, now: i64, zone: Zone) -> bool {
    if l.cancelled {
        return false;
    }
    if l.kind == LoopKind::Wakeup {
        // A `stop: true` call carries no delay: nothing is pending.
        let Some(delay) = l.delay_seconds else {
            return false;
        };
        return l.started_at as f64 + delay * 1000.0 + LOOP_TICK_GRACE_MS as f64 > now as f64;
    }
    if now - l.started_at > LOOP_KEEPALIVE_MAX_MS {
        return false;
    }
    if l.recurring {
        return true;
    }
    let Some(expr) = l.cron.as_deref().filter(|c| !c.is_empty()) else {
        return false;
    };
    cron::next_fire_ms_in(expr, l.started_at as f64, zone)
        .is_some_and(|first| first + LOOP_TICK_GRACE_MS > now)
}

/// `hasArmedLoop(loops, now)`.
pub fn has_armed_loop<'a>(loops: impl IntoIterator<Item = &'a SessionLoop>, now: i64) -> bool {
    has_armed_loop_in(loops, now, Zone::Local)
}

/// [`has_armed_loop`] with crons resolved in `zone`.
pub fn has_armed_loop_in<'a>(
    loops: impl IntoIterator<Item = &'a SessionLoop>,
    now: i64,
    zone: Zone,
) -> bool {
    loops.into_iter().any(|l| is_loop_armed_in(l, now, zone))
}
