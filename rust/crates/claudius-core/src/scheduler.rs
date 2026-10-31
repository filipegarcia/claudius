//! `lib/server/scheduler.ts`: runs the jobs of [`crate::scheduler_store`]
//! on their cron, one process-wide [`Scheduler`] ([`scheduler()`]).
//!
//! - [`Scheduler::boot`] arms every enabled job, once per process.
//! - [`Scheduler::arm`] computes the next slot with
//!   [`cron::next_fire_after_in`], anchored on `lastRunAt` (CC 2.1.299: no
//!   repeat or early fire in the hour daylight saving ends repeats), patches
//!   it in as `nextRunAt` and sets one timer per job, at most 24 h out. A
//!   timer that wakes more than 250 ms before its slot (the cap) re-arms.
//! - A timer that fires reads the job as stored now and runs it if it is
//!   still enabled. The run re-arms from the store when it ends.
//! - Missed slots are not caught up: a job has a timer for its next slot
//!   only, and a run re-arms from the slot after the one it started in.
//! - One run per job at a time: a fire while the job's run is in flight
//!   records a `skipped` run (`previous_run_in_progress`) and re-arms.
//! - A run is a single-turn query (`permissionMode: "auto"`,
//!   `permissionPrompts: "none"`, the job's cwd and model). Each SDK message
//!   goes to the run's transcript as `{type: "sdk", message}` and to the
//!   run's live subscribers; the finished run (status, note, cost, tokens)
//!   is written over the `running` record, and reported through
//!   [`SchedulerConfig::on_run_finished`] (the notification bus in TS). Its
//!   live buffer stays replayable for 5 s after it ends.
//!
//! Time comes from a [`Clock`] (`Date.now()`) and timers are tokio's, so a
//! test drives both on the paused clock ([`TokioClock`]); run ids come from
//! [`SchedulerConfig::run_id`] (`randomUUID()`).
//!
//! TS boots this in `instrumentation.ts` whenever Next starts, and every
//! schedule route calls `boot()` too. Here it stays off unless the process
//! is started with `--scheduler` or `CLAUDIUS_SCHEDULER=1` ([`enabled`]):
//! while Next serves the schedule routes it boots its own scheduler on the
//! same `jobs.json`, and two would run every job twice. No test or dev run
//! fires a job unless it opts in.
//!
//! Differences:
//! - a job's `cwd` that isn't a string is no cwd (Node throws on spawn), and
//!   a `prompt` that isn't a string is sent as its `String()` (the SDK
//!   would take it for a message stream);
//! - a result's `total_cost_usd` / token counts that aren't numbers count
//!   as 0 (JS `+=` would concatenate or coerce them);
//! - an `arm` that fails outside a caller (boot, the 24 h re-arm) is logged
//!   (TS leaves an unhandled rejection), and a failed boot doesn't stop the
//!   server (TS's `register()` rejects, skipping the rest of it);
//! - [`Scheduler::shutdown`] (SIGTERM) stops the timers and ends the
//!   in-flight runs; TS has no shutdown.

use std::collections::{HashMap, HashSet};
use std::panic::AssertUnwindSafe;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, OnceLock, Weak};
use std::time::Duration;

use claudius_agent::query::QueryHandle;
use claudius_agent::{AgentError, Options, Query, js};
use serde_json::{Map, Value, json};
use tokio::task::AbortHandle;

use crate::cron::{self, Zone};
use crate::js_num;
use crate::log::SCHEDULER as LOG;
use crate::scheduler_store::{JobPatch, JsValue, SchedulerStore, StoreError, prop};

/// `MAX_TIMEOUT_MS`: a timer is set at most a day out, then re-armed.
pub const MAX_TIMEOUT_MS: f64 = 24.0 * 60.0 * 60.0 * 1000.0;
/// How early a timer may wake and still fire (`fireAt > Date.now() + 250`).
pub const EARLY_WAKE_MS: f64 = 250.0;
/// How long a finished run's live buffer stays replayable.
pub const LIVE_LINGER_MS: u64 = 5000;
/// Node's timer limit: a delay past it (or below 1 ms) is 1 ms.
const NODE_TIMEOUT_MAX: f64 = 2_147_483_647.0;

/// `Date.now()`.
pub trait Clock: Send + Sync {
    fn now_ms(&self) -> f64;
}

/// The wall clock.
pub struct SystemClock;

impl Clock for SystemClock {
    fn now_ms(&self) -> f64 {
        crate::now_ms() as f64
    }
}

/// `base_ms` plus the tokio time elapsed since it was made, in whole ms:
/// on a paused runtime, the clock tests move with `tokio::time::advance`.
pub struct TokioClock {
    base_ms: f64,
    start: tokio::time::Instant,
}

impl TokioClock {
    pub fn new(base_ms: f64) -> TokioClock {
        TokioClock {
            base_ms,
            start: tokio::time::Instant::now(),
        }
    }
}

impl Clock for TokioClock {
    fn now_ms(&self) -> f64 {
        self.base_ms + self.start.elapsed().as_millis() as f64
    }
}

/// How runs launch the CLI: the binary (`None`: the SDK's lookup) and its
/// environment (`None`: inherited).
#[derive(Clone, Debug, Default)]
pub struct RunnerOptions {
    pub claude_bin: Option<PathBuf>,
    pub env: Option<HashMap<String, String>>,
}

/// `notificationBus.recordSchedulerEvent(job.cwd, runId, job.id, event)`:
/// a run ended (not a skipped one). `event` is `{type: "run_finished",
/// status, costUsd?, note?}`.
#[derive(Clone, Debug)]
pub struct RunFinished {
    pub cwd: JsValue,
    pub run_id: String,
    pub job_id: JsValue,
    pub event: Value,
}

pub type RunIdFn = Arc<dyn Fn(&JsValue) -> String + Send + Sync>;
pub type RunFinishedFn = Arc<dyn Fn(RunFinished) + Send + Sync>;
/// A live-run subscriber. It's called with the scheduler's state locked:
/// it must not call back into the scheduler (send the event on instead).
pub type RunSubscriber = Arc<dyn Fn(&Value) + Send + Sync>;

pub struct SchedulerConfig {
    /// The store's root (`~/.claude/claudius/schedule`).
    pub root: PathBuf,
    pub clock: Arc<dyn Clock>,
    /// The zone cron fields resolve in (the process's own).
    pub zone: Zone,
    /// A run's id from its job's id (a random UUID).
    pub run_id: RunIdFn,
    pub runner: RunnerOptions,
    pub on_run_finished: Option<RunFinishedFn>,
}

impl Default for SchedulerConfig {
    fn default() -> SchedulerConfig {
        SchedulerConfig {
            root: SchedulerStore::default_root(),
            clock: Arc::new(SystemClock),
            zone: Zone::Local,
            run_id: Arc::new(|_| uuid::Uuid::new_v4().to_string()),
            runner: RunnerOptions::default(),
            on_run_finished: None,
        }
    }
}

struct Timer {
    seq: u64,
    due_ms: f64,
    fired: bool,
    task: AbortHandle,
}

#[derive(Default)]
struct LiveRun {
    events: Vec<Value>,
    subscribers: Vec<(u64, RunSubscriber)>,
    done: bool,
    linger_until: Option<f64>,
    linger: Option<AbortHandle>,
}

#[derive(Default)]
struct State {
    /// By [`key_of`] the job id, like the TS `Map` keyed by the id itself.
    timers: HashMap<String, Timer>,
    /// The jobs with a run in flight (the per-job mutex).
    in_flight: HashSet<String>,
    /// Live run buffers, by run id.
    live_runs: HashMap<String, LiveRun>,
    /// The in-flight runs' queries, by run id (for [`Scheduler::shutdown`]).
    queries: HashMap<String, QueryHandle>,
    stopped: bool,
}

/// The `fire`s in progress, and a wakeup for when there are none.
#[derive(Default)]
struct Fires {
    count: AtomicUsize,
    idle: tokio::sync::Notify,
}

/// Counts a `fire` in progress while alive.
struct Firing(Arc<Fires>);

impl Firing {
    fn new(fires: &Arc<Fires>) -> Firing {
        fires.count.fetch_add(1, Ordering::SeqCst);
        Firing(fires.clone())
    }
}

impl Drop for Firing {
    fn drop(&mut self) {
        if self.0.count.fetch_sub(1, Ordering::SeqCst) == 1 {
            self.0.idle.notify_waiters();
        }
    }
}

/// What a test reads off the scheduler between steps.
#[doc(hidden)]
#[derive(Debug)]
pub struct DebugState {
    /// `(key, due, fired)` per timer.
    pub timers: Vec<(String, f64, bool)>,
    pub in_flight: Vec<String>,
    pub live: Vec<LiveSnapshot>,
    /// `fire`s in progress.
    pub fires: usize,
}

#[doc(hidden)]
#[derive(Debug)]
pub struct LiveSnapshot {
    pub run_id: String,
    pub events: usize,
    pub done: bool,
    pub subscribers: usize,
    pub linger_until: Option<f64>,
}

pub struct Scheduler {
    store: SchedulerStore,
    clock: Arc<dyn Clock>,
    zone: Zone,
    run_id: RunIdFn,
    runner: Mutex<RunnerOptions>,
    on_run_finished: Mutex<Option<RunFinishedFn>>,
    state: Mutex<State>,
    booted: AtomicBool,
    fires: Arc<Fires>,
    seq: AtomicU64,
}

/// The process-wide scheduler (`globalThis.__claudiusScheduler`), on
/// [`SchedulerStore::default_root`]: make it after the home overrides.
pub fn scheduler() -> &'static Arc<Scheduler> {
    static S: OnceLock<Arc<Scheduler>> = OnceLock::new();
    S.get_or_init(|| Scheduler::new(SchedulerConfig::default()))
}

static ENABLED: AtomicBool = AtomicBool::new(false);

/// Whether this process runs scheduled jobs: set by `main` from
/// `--scheduler` / [`enabled_by_env`]. A route that boots the scheduler
/// (the TS ones all call `boot()`) must check it first.
pub fn enabled() -> bool {
    ENABLED.load(Ordering::SeqCst)
}

pub fn set_enabled(on: bool) {
    ENABLED.store(on, Ordering::SeqCst);
}

/// `CLAUDIUS_SCHEDULER`: `1`, `true`, `yes` or `on` (any case) turn the
/// scheduler on; anything else, or unset, leaves it off.
pub fn enabled_by_env(raw: Option<&str>) -> bool {
    raw.map(|v| js::trim(v).to_ascii_lowercase())
        .is_some_and(|v| matches!(v.as_str(), "1" | "true" | "yes" | "on"))
}

/// A job id as a timer / in-flight key: `undefined`, or its JSON.
fn key_of(id: &JsValue) -> String {
    match id {
        None => "undefined".to_owned(),
        Some(v) => js::stringify(v),
    }
}

/// `!!job.enabled` (`job` not `null`).
fn enabled_job(job: &Value) -> bool {
    job.as_object()
        .and_then(|o| o.get("enabled"))
        .is_some_and(js::truthy)
}

/// The expression cron-parser parses for a job's `cron`: a string as is, a
/// falsy value as `""` (its every-minute default); `None` for anything
/// else, which it throws on.
fn cron_text(v: Option<&Value>) -> Option<String> {
    match v {
        Some(Value::String(s)) => Some(s.clone()),
        None => Some(String::new()),
        Some(v) if !js::truthy(v) => Some(String::new()),
        Some(_) => None,
    }
}

/// Node's `setTimeout` delay: below 1 ms or past 2^31 - 1, it's 1 ms.
fn node_delay(ms: f64) -> f64 {
    if (1.0..=NODE_TIMEOUT_MAX).contains(&ms) {
        ms
    } else {
        1.0
    }
}

/// A result's `total_cost_usd ?? 0` (non-numbers as 0).
fn number(v: Option<&Value>) -> f64 {
    v.and_then(Value::as_f64).unwrap_or(0.0)
}

fn truthy_number(n: f64) -> bool {
    n != 0.0 && !n.is_nan()
}

/// What a run gathers from its query.
struct Outcome {
    transcript: Vec<Value>,
    cost_usd: f64,
    input_tokens: f64,
    output_tokens: f64,
    status: &'static str,
    note: Option<Value>,
}

impl Outcome {
    /// A `result` message: sum its cost and tokens; a truthy subtype other
    /// than `success` makes the run an error, noted with the subtype.
    fn count(&mut self, msg: &Value) {
        if msg.get("type").and_then(Value::as_str) != Some("result") {
            return;
        }
        self.cost_usd += number(msg.get("total_cost_usd"));
        let usage = msg.get("usage");
        self.input_tokens += number(usage.and_then(|u| u.get("input_tokens")));
        self.output_tokens += number(usage.and_then(|u| u.get("output_tokens")));
        if let Some(subtype) = msg.get("subtype")
            && js::truthy(subtype)
            && subtype.as_str() != Some("success")
        {
            self.status = "error";
            self.note = Some(subtype.clone());
        }
    }
}

/// [`Scheduler::subscribe_run`]'s unsubscribe: call it, or drop it.
pub struct RunUnsubscribe {
    target: Option<(Weak<Scheduler>, String, u64)>,
}

impl RunUnsubscribe {
    pub fn unsubscribe(mut self) {
        self.release();
    }

    fn release(&mut self) {
        if let Some((sched, run_id, sub)) = self.target.take()
            && let Some(sched) = sched.upgrade()
            && let Some(buf) = sched.state().live_runs.get_mut(&run_id)
        {
            buf.subscribers.retain(|(id, _)| *id != sub);
        }
    }
}

impl Drop for RunUnsubscribe {
    fn drop(&mut self) {
        self.release();
    }
}

impl Scheduler {
    pub fn new(config: SchedulerConfig) -> Arc<Scheduler> {
        Arc::new(Scheduler {
            store: SchedulerStore::new(config.root, config.clock.clone()),
            clock: config.clock,
            zone: config.zone,
            run_id: config.run_id,
            runner: Mutex::new(config.runner),
            on_run_finished: Mutex::new(config.on_run_finished),
            state: Mutex::new(State::default()),
            booted: AtomicBool::new(false),
            fires: Arc::default(),
            seq: AtomicU64::new(0),
        })
    }

    /// The job store (`listJobs`, `getJob`, `saveJob`, `listRuns` are
    /// re-exported on the TS scheduler). Routes write through this one so
    /// they share its lock.
    pub fn store(&self) -> &SchedulerStore {
        &self.store
    }

    pub fn set_runner(&self, runner: RunnerOptions) {
        *lock(&self.runner) = runner;
    }

    pub fn set_on_run_finished(&self, f: Option<RunFinishedFn>) {
        *lock(&self.on_run_finished) = f;
    }

    fn state(&self) -> MutexGuard<'_, State> {
        lock(&self.state)
    }

    /// `boot()`: once per scheduler, arm every enabled job. A `null` entry
    /// throws there, after the jobs before it were armed.
    pub fn boot(self: &Arc<Self>) -> Result<(), StoreError> {
        if self.booted.swap(true, Ordering::SeqCst) {
            return Ok(());
        }
        for job in self.store.list_jobs()? {
            if job.is_null() {
                return Err(StoreError::reading_null("enabled"));
            }
            if enabled_job(&job)
                && let Err(e) = self.arm(&job)
            {
                tracing::error!(target: LOG, "[scheduler] arm failed {} {e}", key_of(&prop(&job, "id")));
            }
        }
        Ok(())
    }

    /// `arm(job)`: replace the job's timer with one for its next slot,
    /// recorded as `nextRunAt`; none when it's disabled, has no next slot,
    /// or was deleted or disabled in the store.
    pub fn arm(self: &Arc<Self>, job: &Value) -> Result<(), StoreError> {
        if job.is_null() {
            return Err(StoreError::reading_null("id"));
        }
        let id = prop(job, "id");
        let key = key_of(&id);
        self.disarm_key(&key);
        if !enabled_job(job) {
            return Ok(());
        }
        let Some(fire_at) = self.next_fire_after(job) else {
            return Ok(());
        };
        let patch: JobPatch = vec![("nextRunAt".to_owned(), Some(json!(fire_at)))];
        // Only the field arming owns: the stored job may have changed.
        let Some(stored) = self.store.patch_job(&id, &patch)?.filter(enabled_job) else {
            return Ok(());
        };
        let fire_at = fire_at as f64;
        let now = self.clock.now_ms();
        let delay = node_delay((fire_at - now).clamp(0.0, MAX_TIMEOUT_MS));
        let seq = self.seq.fetch_add(1, Ordering::SeqCst);
        let mut st = self.state();
        if st.stopped {
            return Ok(());
        }
        let this = self.clone();
        let timer_key = key.clone();
        // From now, not from when the task first runs.
        let deadline = tokio::time::Instant::now() + Duration::from_millis(delay as u64);
        let task = tokio::spawn(async move {
            tokio::time::sleep_until(deadline).await;
            this.on_timer(&timer_key, seq, id, stored, fire_at);
        });
        let timer = Timer {
            seq,
            due_ms: now + delay,
            fired: false,
            task: task.abort_handle(),
        };
        tracing::debug!(target: LOG, "[scheduler] armed {key} at {now} due {} fire {fire_at}", now + delay);
        // A timer set meanwhile is replaced, not left running beside it.
        if let Some(old) = st.timers.insert(key, timer) {
            old.task.abort();
        }
        Ok(())
    }

    /// `nextFireAfter(job.cron, job.lastRunAt)`.
    fn next_fire_after(&self, job: &Value) -> Option<i64> {
        let cron = cron_text(prop(job, "cron").as_ref())?;
        let anchor = match prop(job, "lastRunAt") {
            Some(Value::Number(n)) => n.as_f64(),
            _ => None,
        };
        cron::next_fire_after_in(&cron, anchor, self.clock.now_ms(), None, self.zone)
    }

    /// The timer's callback: re-arm when it woke early (the 24 h cap),
    /// else fire the job as stored now if it's still enabled.
    fn on_timer(self: &Arc<Self>, key: &str, seq: u64, id: JsValue, stored: Value, fire_at: f64) {
        match self.state().timers.get_mut(key) {
            Some(t) if t.seq == seq => t.fired = true,
            _ => return,
        }
        if fire_at > self.clock.now_ms() + EARLY_WAKE_MS {
            if let Err(e) = self.arm(&stored) {
                tracing::error!(target: LOG, "[scheduler] arm failed {key} {e}");
            }
            return;
        }
        match self.store.get_job(&id) {
            Ok(Some(job)) if enabled_job(&job) => {
                let firing = Firing::new(&self.fires);
                let this = self.clone();
                let key = key.to_owned();
                tokio::spawn(async move {
                    let _firing = firing;
                    if let Err(e) = this.fire(job, true).await {
                        tracing::error!(target: LOG, "[scheduler] fire failed {key} {e}");
                    }
                });
            }
            Ok(_) => {}
            Err(e) => tracing::error!(target: LOG, "[scheduler] fire failed {key} {e}"),
        }
    }

    /// `rearmFromStore`: re-arm the job as stored, if it still is and is
    /// enabled.
    fn rearm_from_store(self: &Arc<Self>, id: &JsValue) -> Result<(), StoreError> {
        match self.store.get_job(id)? {
            Some(job) if enabled_job(&job) => self.arm(&job),
            _ => Ok(()),
        }
    }

    /// `disarm(jobId)`.
    pub fn disarm(&self, id: &JsValue) {
        self.disarm_key(&key_of(id));
    }

    fn disarm_key(&self, key: &str) {
        if let Some(t) = self.state().timers.remove(key) {
            t.task.abort();
            tracing::debug!(target: LOG, "[scheduler] disarmed {key} at {}", self.clock.now_ms());
        }
    }

    /// `scheduler.deleteJob(jobId)`: only the timer (the store's
    /// `delete_job` removes the job).
    pub fn delete_job(&self, id: &JsValue) {
        self.disarm(id);
    }

    /// `runNow(jobId)`: run the job now, enabled or not, without re-arming;
    /// the run's id once it ends, `None` when there's no such job.
    pub async fn run_now(self: &Arc<Self>, id: &JsValue) -> Result<Option<String>, StoreError> {
        let Some(job) = self.store.get_job(id)?.filter(js::truthy) else {
            return Ok(None);
        };
        let _firing = Firing::new(&self.fires);
        self.fire(job, false).await.map(Some)
    }

    /// `fire(job, reArm)`: one run of the job.
    async fn fire(self: &Arc<Self>, job: Value, re_arm: bool) -> Result<String, StoreError> {
        let id = prop(&job, "id");
        let key = key_of(&id);
        let run_id = (self.run_id)(&id);
        let mut record = Map::new();
        record.insert("id".into(), json!(run_id));
        if let Some(job_id) = &id {
            record.insert("jobId".into(), job_id.clone());
        }

        if !self.state().in_flight.insert(key.clone()) {
            record.insert("startedAt".into(), js_num(self.clock.now_ms()));
            record.insert("endedAt".into(), js_num(self.clock.now_ms()));
            record.insert("status".into(), json!("skipped"));
            record.insert("note".into(), json!("previous_run_in_progress"));
            self.store.append_run(&Value::Object(record))?;
            if re_arm {
                self.rearm_from_store(&id)?;
            }
            return Ok(run_id);
        }

        let started_at = self.clock.now_ms();
        record.insert("startedAt".into(), js_num(started_at));
        record.insert("status".into(), json!("running"));
        record.insert("transcript".into(), json!([]));
        self.store.append_run(&Value::Object(record.clone()))?;
        let running: JobPatch = vec![
            ("lastRunAt".to_owned(), Some(js_num(started_at))),
            ("lastStatus".to_owned(), Some(json!("running"))),
        ];
        self.store.patch_job(&id, &running)?;

        // Open the live buffer before any output, so a subscriber that
        // connects right away sees the whole run.
        self.state()
            .live_runs
            .insert(run_id.clone(), LiveRun::default());
        self.broadcast_run(&run_id, json!({"type": "ready", "sessionId": run_id}));

        let mut out = Outcome {
            transcript: Vec::new(),
            cost_usd: 0.0,
            input_tokens: 0.0,
            output_tokens: 0.0,
            status: "success",
            note: None,
        };
        if let Err(e) = self.run_query(&job, &run_id, &mut out).await {
            let message = e.to_string();
            out.status = "error";
            out.note = Some(json!(message));
            let ev = json!({"type": "error", "message": message});
            out.transcript.push(ev.clone());
            self.broadcast_run(&run_id, ev);
        }
        self.end_live_run(&key, &run_id);

        let ended_at = self.clock.now_ms();
        record.insert("endedAt".into(), js_num(ended_at));
        record.insert("status".into(), json!(out.status));
        if let Some(note) = &out.note {
            record.insert("note".into(), note.clone());
        }
        for (k, n) in [
            ("costUsd", out.cost_usd),
            ("inputTokens", out.input_tokens),
            ("outputTokens", out.output_tokens),
        ] {
            if truthy_number(n) {
                record.insert(k.into(), js_num(n));
            }
        }
        record.insert("transcript".into(), Value::Array(out.transcript));
        self.store.update_run(&Value::Object(record))?;
        // A patch, not the job read at the start: an edit or a delete made
        // during the run sticks.
        let finished: JobPatch = vec![
            ("lastRunAt".to_owned(), Some(js_num(started_at))),
            ("lastStatus".to_owned(), Some(json!(out.status))),
        ];
        self.store.patch_job(&id, &finished)?;

        let notify = lock(&self.on_run_finished).clone();
        if let Some(notify) = notify {
            let mut event = Map::new();
            event.insert("type".into(), json!("run_finished"));
            event.insert("status".into(), json!(out.status));
            if truthy_number(out.cost_usd) {
                event.insert("costUsd".into(), js_num(out.cost_usd));
            }
            if let Some(note) = out.note.filter(js::truthy) {
                event.insert("note".into(), note);
            }
            notify(RunFinished {
                cwd: prop(&job, "cwd"),
                run_id: run_id.clone(),
                job_id: id.clone(),
                event: Value::Object(event),
            });
        }

        if re_arm {
            self.rearm_from_store(&id)?;
        }
        Ok(run_id)
    }

    /// The run's single-turn query, its messages into `out`.
    async fn run_query(
        &self,
        job: &Value,
        run_id: &str,
        out: &mut Outcome,
    ) -> Result<(), AgentError> {
        let runner = lock(&self.runner).clone();
        let options = Options {
            cwd: match prop(job, "cwd") {
                Some(Value::String(cwd)) => Some(PathBuf::from(cwd)),
                _ => None,
            },
            model: prop(job, "model")
                .filter(js::truthy)
                .map(|m| js::to_string(Some(&m))),
            // No `can_use_tool`: an unattended run can't ask. `auto` plus
            // `permissionPrompts: "none"` denies what isn't pre-approved
            // right away instead of leaving the turn on a prompt.
            permission_mode: Some("auto".into()),
            permission_prompts: Some("none".into()),
            path_to_claude_code_executable: runner.claude_bin,
            env: runner.env,
            ..Default::default()
        };
        let prompt = match prop(job, "prompt") {
            Some(Value::String(p)) => p,
            other => js::to_string(other.as_ref()),
        };
        let mut q = Query::spawn_prompt(&prompt, options).await?;
        let handle = q.handle();
        self.state()
            .queries
            .insert(run_id.to_owned(), handle.clone());
        let res = loop {
            match q.next().await {
                None => break Ok(()),
                Some(Err(e)) => break Err(e),
                Some(Ok(msg)) => {
                    out.count(&msg);
                    let ev = json!({"type": "sdk", "message": msg});
                    out.transcript.push(ev.clone());
                    self.broadcast_run(run_id, ev);
                }
            }
        };
        self.state().queries.remove(run_id);
        handle.close().await;
        res
    }

    /// The run's `finally`: the job is free again, and the live buffer is
    /// done and goes away after [`LIVE_LINGER_MS`].
    fn end_live_run(self: &Arc<Self>, key: &str, run_id: &str) {
        let mut st = self.state();
        st.in_flight.remove(key);
        let this = self.clone();
        let id = run_id.to_owned();
        let deadline = tokio::time::Instant::now() + Duration::from_millis(LIVE_LINGER_MS);
        let task = tokio::spawn(async move {
            tokio::time::sleep_until(deadline).await;
            this.state().live_runs.remove(&id);
        });
        let until = self.clock.now_ms() + LIVE_LINGER_MS as f64;
        match st.live_runs.get_mut(run_id) {
            Some(buf) => {
                buf.done = true;
                buf.linger_until = Some(until);
                buf.linger = Some(task.abort_handle());
            }
            None => task.abort(),
        }
    }

    fn broadcast_run(&self, run_id: &str, ev: Value) {
        let mut st = self.state();
        let Some(buf) = st.live_runs.get_mut(run_id) else {
            return;
        };
        for (_, sub) in &buf.subscribers {
            // A subscriber's failure is its own.
            let _ = std::panic::catch_unwind(AssertUnwindSafe(|| sub(&ev)));
        }
        buf.events.push(ev);
    }

    /// `subscribeRun(runId, fn)`: replay the run's events to `f`, then
    /// forward new ones while it runs. A run that isn't live (finished
    /// over 5 s ago, or unknown) gets one `{type: "error", message:
    /// "run_not_live"}`.
    pub fn subscribe_run(self: &Arc<Self>, run_id: &str, f: RunSubscriber) -> RunUnsubscribe {
        let none = RunUnsubscribe { target: None };
        let mut st = self.state();
        let Some(buf) = st.live_runs.get_mut(run_id) else {
            drop(st);
            f(&json!({"type": "error", "message": "run_not_live"}));
            return none;
        };
        for ev in &buf.events {
            f(ev);
        }
        if buf.done {
            return none;
        }
        let sub = self.seq.fetch_add(1, Ordering::SeqCst);
        buf.subscribers.push((sub, f));
        RunUnsubscribe {
            target: Some((Arc::downgrade(self), run_id.to_owned(), sub)),
        }
    }

    /// `isRunLive(runId)`: the run is still going.
    pub fn is_run_live(&self, run_id: &str) -> bool {
        self.state().live_runs.get(run_id).is_some_and(|b| !b.done)
    }

    /// `isRunAttached(runId)`: still going, and someone is watching (CC
    /// 2.1.221's attached / unattended background job).
    pub fn is_run_attached(&self, run_id: &str) -> bool {
        self.state()
            .live_runs
            .get(run_id)
            .is_some_and(|b| !b.done && !b.subscribers.is_empty())
    }

    /// Stop: no more timers, and the in-flight runs' CLIs are ended (each
    /// run is recorded as an error); waits up to 5 s for them to finish.
    pub async fn shutdown(&self) {
        let queries: Vec<QueryHandle> = {
            let mut st = self.state();
            st.stopped = true;
            for (_, t) in st.timers.drain() {
                t.task.abort();
            }
            for buf in st.live_runs.values_mut() {
                if let Some(t) = buf.linger.take() {
                    t.abort();
                }
            }
            st.queries.values().cloned().collect()
        };
        for q in queries {
            q.close().await;
        }
        let idle = async {
            loop {
                let woken = self.fires.idle.notified();
                tokio::pin!(woken);
                woken.as_mut().enable();
                if self.fires.count.load(Ordering::SeqCst) == 0 {
                    return;
                }
                woken.await;
            }
        };
        let _ = tokio::time::timeout(Duration::from_secs(5), idle).await;
    }

    #[doc(hidden)]
    pub fn debug_state(&self) -> DebugState {
        let st = self.state();
        DebugState {
            timers: st
                .timers
                .iter()
                .map(|(k, t)| (k.clone(), t.due_ms, t.fired))
                .collect(),
            in_flight: st.in_flight.iter().cloned().collect(),
            live: st
                .live_runs
                .iter()
                .map(|(id, b)| LiveSnapshot {
                    run_id: id.clone(),
                    events: b.events.len(),
                    done: b.done,
                    subscribers: b.subscribers.len(),
                    linger_until: b.linger_until,
                })
                .collect(),
            fires: self.fires.count.load(Ordering::SeqCst),
        }
    }
}

fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn node_delay_clamps_like_set_timeout() {
        assert_eq!(node_delay(0.0), 1.0);
        assert_eq!(node_delay(0.5), 1.0);
        assert_eq!(node_delay(1.0), 1.0);
        assert_eq!(node_delay(250.0), 250.0);
        assert_eq!(node_delay(NODE_TIMEOUT_MAX), NODE_TIMEOUT_MAX);
        assert_eq!(node_delay(NODE_TIMEOUT_MAX + 1.0), 1.0);
        assert_eq!(node_delay(f64::NAN), 1.0);
    }

    #[test]
    fn cron_text_is_what_cron_parser_parses() {
        assert_eq!(cron_text(None).as_deref(), Some(""));
        for falsy in [json!(null), json!(false), json!(0), json!("")] {
            assert_eq!(cron_text(Some(&falsy)).as_deref(), Some(""), "{falsy}");
        }
        assert_eq!(
            cron_text(Some(&json!("* * * * *"))).as_deref(),
            Some("* * * * *")
        );
        for thrown in [json!(5), json!(true), json!([]), json!({})] {
            assert_eq!(cron_text(Some(&thrown)), None, "{thrown}");
        }
    }

    #[test]
    fn keys_tell_ids_apart_like_a_map() {
        assert_eq!(key_of(&None), "undefined");
        assert_eq!(key_of(&Some(json!(null))), "null");
        assert_eq!(key_of(&Some(json!(5))), "5");
        assert_eq!(key_of(&Some(json!("5"))), "\"5\"");
    }

    #[test]
    fn the_env_switch() {
        for on in ["1", "true", "TRUE", " yes ", "on"] {
            assert!(enabled_by_env(Some(on)), "{on:?}");
        }
        for off in ["", "0", "false", "no", "off", "2"] {
            assert!(!enabled_by_env(Some(off)), "{off:?}");
        }
        assert!(!enabled_by_env(None));
    }

    #[test]
    fn a_result_counts() {
        let mut out = Outcome {
            transcript: Vec::new(),
            cost_usd: 0.0,
            input_tokens: 0.0,
            output_tokens: 0.0,
            status: "success",
            note: None,
        };
        out.count(&json!({"type": "assistant", "total_cost_usd": 9, "subtype": "x"}));
        assert_eq!((out.cost_usd, out.status), (0.0, "success"));
        out.count(
            &json!({"type": "result", "subtype": "success", "total_cost_usd": 0.1,
            "usage": {"input_tokens": 1, "output_tokens": 2}}),
        );
        out.count(&json!({"type": "result", "subtype": "", "total_cost_usd": 0.2, "usage": null}));
        assert_eq!(out.cost_usd, 0.1 + 0.2);
        assert_eq!((out.input_tokens, out.output_tokens), (1.0, 2.0));
        assert_eq!((out.status, out.note.clone()), ("success", None));
        out.count(&json!({"type": "result", "subtype": "error_max_turns", "total_cost_usd": "x"}));
        assert_eq!(out.cost_usd, 0.1 + 0.2);
        assert_eq!(
            (out.status, out.note),
            ("error", Some(json!("error_max_turns")))
        );
    }

    /// A scheduler on a temp root and tokio's clock, with one enabled job
    /// `j` every 5 minutes and a CLI that can't launch.
    fn pinned() -> (tempfile::TempDir, Arc<Scheduler>, Value) {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().join("schedule");
        std::fs::create_dir_all(&root).unwrap();
        std::fs::write(
            root.join("jobs.json"),
            r#"{"jobs":[{"id":"j","cron":"*/5 * * * *","prompt":"p","enabled":true}]}"#,
        )
        .unwrap();
        let sched = Scheduler::new(SchedulerConfig {
            root,
            clock: Arc::new(TokioClock::new(1_793_106_120_000.0)),
            zone: Zone::Fixed(0),
            runner: RunnerOptions {
                claude_bin: Some(tmp.path().join("no-such-claude")),
                env: None,
            },
            ..Default::default()
        });
        let job = sched.store().get_job(&Some(json!("j"))).unwrap().unwrap();
        (tmp, sched, job)
    }

    #[tokio::test(start_paused = true)]
    async fn a_wake_from_a_replaced_timer_does_nothing() {
        // The timer woke as `arm` replaced it (its abort came too late):
        // the new timer isn't marked fired and the job doesn't fire.
        let (_tmp, sched, job) = pinned();
        sched.arm(&job).unwrap();
        let stale = sched.state().timers["\"j\""].seq;
        sched.arm(&job).unwrap();
        let due = sched.state().timers["\"j\""].due_ms;
        let now = sched.clock.now_ms();
        sched.on_timer("\"j\"", stale, Some(json!("j")), job, now);
        let st = sched.debug_state();
        assert_eq!(st.timers, vec![("\"j\"".to_owned(), due, false)]);
        assert_eq!(st.fires, 0);
    }

    #[tokio::test(start_paused = true)]
    async fn disarming_ends_the_timer_task() {
        let (_tmp, sched, job) = pinned();
        let metrics = tokio::runtime::Handle::current().metrics();
        let before = metrics.num_alive_tasks();
        sched.arm(&job).unwrap();
        assert_eq!(metrics.num_alive_tasks(), before + 1);
        sched.disarm(&Some(json!("j")));
        for _ in 0..10 {
            tokio::task::yield_now().await;
        }
        assert_eq!(metrics.num_alive_tasks(), before);
        assert!(sched.debug_state().timers.is_empty());
    }
}
