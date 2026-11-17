//! `lib/server/updater/scheduler.ts`: the background updater, one per
//! process ([`updater_scheduler`]).
//!
//! [`UpdaterScheduler::boot`] does nothing inside a customization preview
//! mirror or with `CLAUDIUS_UPDATER_DISABLED=1` (exactly `"1"`; the packaged
//! desktop app sets it, because there Electron owns updates). Otherwise it
//! drops a `recovery` that an earlier process left (this one booted, so the
//! build it serves works) and ticks after 5 s, then every `intervalHours`
//! (at least an hour). A tick checks (sharing a check in flight, see
//! [`detect::check_for_updates`]) and, in `cc-merge` / `ff-only` mode,
//! starts an apply when an update is waiting or the tree is stuck mid-update
//! (markers or unmerged entries the check can't see). An automatic tick that
//! starts an apply doesn't re-arm: the apply restarts the process, or its
//! failure is in the state for the next boot. A check that throws re-arms at
//! 24 h. `disabled` mode still re-arms, so a later settings change is seen.
//!
//! Timers go through [`Timers`]; [`TokioTimers`] is the real one, with
//! Node's `setTimeout` clamp ([`node_delay_ms`]). An apply starts through
//! a [`Launcher`] ([`apply::apply_update`] unless a test swaps it). The
//! scheduler isn't booted by `main.rs` yet (G12 wires it).

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, LazyLock, Mutex};
use std::time::Duration;

use futures::future::BoxFuture;

use crate::updater::apply::{self, ApplyOptions, SharedApply};
use crate::updater::detect::{self, CheckResult};
use crate::updater::settings::{self, StatePatch};
use crate::updater::{git, root};
use crate::{customize_runtime, log};

/// `BOOT_DELAY_MS`.
pub const BOOT_DELAY_MS: f64 = 5_000.0;
/// `HOUR_MS`.
pub const HOUR_MS: f64 = 3_600_000.0;
/// Node's `TIMEOUT_MAX` (2^31 - 1 ms, about 24.8 days).
pub const TIMEOUT_MAX: f64 = 2_147_483_647.0;

/// The delay Node's `setTimeout(fn, after)` really waits: anything outside
/// `1..=TIMEOUT_MAX` (NaN, or more than ~24.8 days) is 1 ms. So an
/// `intervalHours` above ~596.5 re-ticks at once, as in the TS.
pub fn node_delay_ms(after: f64) -> f64 {
    if (1.0..=TIMEOUT_MAX).contains(&after) {
        after
    } else {
        1.0
    }
}

/// What woke a tick.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Source {
    Boot,
    Daily,
    Manual,
}

/// `setTimeout` / `clearTimeout`.
pub trait Timers: Send + Sync {
    /// Run `fire` after `delay_ms` (the TS's requested delay; the real
    /// timer applies [`node_delay_ms`]). The answer is the timer's id.
    fn set(&self, delay_ms: f64, fire: BoxFuture<'static, ()>) -> u64;
    /// Cancel a timer that hasn't fired (one that has is a no-op).
    fn clear(&self, id: u64);
}

/// Timers on tokio.
#[derive(Default)]
pub struct TokioTimers {
    next: AtomicU64,
    pending: Arc<Mutex<HashMap<u64, tokio::task::AbortHandle>>>,
}

impl Timers for TokioTimers {
    fn set(&self, delay_ms: f64, fire: BoxFuture<'static, ()>) -> u64 {
        let id = self.next.fetch_add(1, Ordering::Relaxed);
        let wait = Duration::from_secs_f64(node_delay_ms(delay_ms) / 1000.0);
        let pending = self.pending.clone();
        // Held across the spawn, so the task can't forget itself first.
        let mut map = self.pending.lock().expect("timers");
        let task = tokio::spawn(async move {
            tokio::time::sleep(wait).await;
            // Fired: a later `clear` of this id does nothing.
            pending.lock().expect("timers").remove(&id);
            fire.await;
        });
        map.insert(id, task.abort_handle());
        id
    }

    fn clear(&self, id: u64) {
        if let Some(task) = self.pending.lock().expect("timers").remove(&id) {
            task.abort();
        }
    }
}

/// How a tick starts an apply (`applyUpdate()`).
pub type Launcher = Arc<dyn Fn(ApplyOptions) -> SharedApply + Send + Sync>;

/// `UpdaterScheduler`.
pub struct UpdaterScheduler {
    booted: AtomicBool,
    daily_timer: Mutex<Option<u64>>,
    timers: Arc<dyn Timers>,
    launch: Launcher,
    apply_options: Mutex<ApplyOptions>,
}

impl UpdaterScheduler {
    /// A scheduler whose ticks run [`apply::apply_update`].
    pub fn new(timers: Arc<dyn Timers>) -> Arc<UpdaterScheduler> {
        UpdaterScheduler::with_launcher(timers, Arc::new(apply::apply_update))
    }

    /// A scheduler whose ticks start applies through `launch`.
    pub fn with_launcher(timers: Arc<dyn Timers>, launch: Launcher) -> Arc<UpdaterScheduler> {
        Arc::new(UpdaterScheduler {
            booted: AtomicBool::new(false),
            daily_timer: Mutex::new(None),
            timers,
            launch,
            apply_options: Mutex::new(ApplyOptions::default()),
        })
    }

    /// The options an automatic apply runs with (its `claude`). It never
    /// sets `allowCcMerge`.
    pub fn set_apply_options(&self, opts: ApplyOptions) {
        *self.apply_options.lock().expect("apply options") = ApplyOptions {
            allow_cc_merge: false,
            ..opts
        };
    }

    /// `boot()`, once per scheduler: see the module doc.
    pub fn boot(self: &Arc<Self>) {
        let disabled = std::env::var("CLAUDIUS_UPDATER_DISABLED").ok();
        self.boot_with(
            customize_runtime::is_running_inside_customization_mirror(),
            disabled.as_deref(),
        );
    }

    /// [`Self::boot`] with its two inputs: whether this process serves a
    /// customization mirror, and `$CLAUDIUS_UPDATER_DISABLED`.
    pub fn boot_with(self: &Arc<Self>, inside_mirror: bool, disabled_env: Option<&str>) {
        if self.booted.swap(true, Ordering::SeqCst) {
            return;
        }
        if inside_mirror || disabled_env == Some("1") {
            return;
        }
        clear_stale_recovery();
        let me = self.clone();
        self.timers.set(
            BOOT_DELAY_MS,
            Box::pin(async move { me.tick(Source::Boot).await }),
        );
    }

    /// `runNow()`: a manual tick, done when its check is (an apply it
    /// starts runs on).
    pub async fn run_now(self: &Arc<Self>) {
        self.tick(Source::Manual).await;
    }

    /// `tick(source)`.
    pub async fn tick(self: &Arc<Self>, source: Source) {
        let settings = settings::get_updater_settings();
        if settings.mode == "disabled" {
            self.schedule_next(settings.interval_hours);
            return;
        }
        let result = match detect::check_for_updates().await {
            Ok(result) => result,
            Err(e) => {
                tracing::warn!(target: log::API, "[updater] tick failed: {e}");
                self.schedule_next(24.0);
                return;
            }
        };
        let auto_apply = settings.mode == "cc-merge" || settings.mode == "ff-only";
        let available = matches!(result, CheckResult::UpdateAvailable { .. });
        // Stuck mid-update: HEAD is at upstream, so the check says
        // up to date while the tree can't be built.
        let stuck = auto_apply && !available && git::has_conflicts(&root::install_root()).await;
        if auto_apply && (available || stuck) {
            self.launch_apply();
            if source != Source::Manual {
                return;
            }
        }
        self.schedule_next(settings.interval_hours);
    }

    /// `void applyUpdate().catch(…)`.
    fn launch_apply(&self) {
        let opts = self.apply_options.lock().expect("apply options").clone();
        let run = (self.launch)(opts);
        tokio::spawn(async move {
            if let Err(e) = run.await {
                tracing::warn!(target: log::API, "[updater] apply failed: {e}");
            }
        });
    }

    /// `scheduleNext(intervalHours)`: the daily timer, re-armed.
    fn schedule_next(self: &Arc<Self>, interval_hours: f64) {
        let mut daily = self.daily_timer.lock().expect("daily timer");
        if let Some(id) = daily.take() {
            self.timers.clear(id);
        }
        let delay = HOUR_MS.max(interval_hours * HOUR_MS);
        let me = self.clone();
        *daily = Some(
            self.timers
                .set(delay, Box::pin(async move { me.tick(Source::Daily).await })),
        );
    }
}

/// `clearStaleRecovery()`: a `recovery` (and `lastError`) left by an
/// earlier process goes; nothing else is touched. Best effort.
fn clear_stale_recovery() {
    if settings::read_updater_file().state.recovery.is_none() {
        return;
    }
    let _ = settings::patch_updater_state(&StatePatch {
        recovery: Some(None),
        last_error: Some(None),
        ..Default::default()
    });
}

static SCHEDULER: LazyLock<Arc<UpdaterScheduler>> =
    LazyLock::new(|| UpdaterScheduler::new(Arc::new(TokioTimers::default())));

/// The process's scheduler (`updaterScheduler`).
pub fn updater_scheduler() -> &'static Arc<UpdaterScheduler> {
    &SCHEDULER
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn node_clamps_out_of_range_delays_to_one_ms() {
        assert_eq!(node_delay_ms(5_000.0), 5_000.0);
        assert_eq!(node_delay_ms(1.0), 1.0);
        assert_eq!(node_delay_ms(TIMEOUT_MAX), TIMEOUT_MAX);
        assert_eq!(node_delay_ms(TIMEOUT_MAX + 1.0), 1.0);
        assert_eq!(node_delay_ms(600.0 * HOUR_MS), 1.0);
        assert_eq!(node_delay_ms(f64::INFINITY), 1.0);
        assert_eq!(node_delay_ms(f64::NAN), 1.0);
        assert_eq!(node_delay_ms(0.5), 1.0);
        assert_eq!(node_delay_ms(0.0), 1.0);
    }

    #[tokio::test]
    async fn tokio_timers_fire_once_and_clear_before_firing() {
        let timers = TokioTimers::default();
        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
        let t1 = tx.clone();
        let a = timers.set(1.0, Box::pin(async move { t1.send("a").unwrap() }));
        let t2 = tx.clone();
        let b = timers.set(30.0, Box::pin(async move { t2.send("b").unwrap() }));
        assert_ne!(a, b);
        timers.clear(b);
        assert_eq!(rx.recv().await, Some("a"));
        // `a` fired: clearing it now is a no-op.
        timers.clear(a);
        drop(tx);
        assert_eq!(rx.recv().await, None);
    }

    #[tokio::test]
    async fn an_out_of_range_delay_fires_after_one_ms_like_node() {
        let timers = TokioTimers::default();
        let (tx, rx) = tokio::sync::oneshot::channel();
        timers.set(
            600.0 * HOUR_MS,
            Box::pin(async move { tx.send(()).unwrap() }),
        );
        tokio::time::timeout(Duration::from_secs(10), rx)
            .await
            .expect("a 600 h delay waits 1 ms")
            .unwrap();
    }
}
