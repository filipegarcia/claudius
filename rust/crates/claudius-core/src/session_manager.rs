//! Process-wide registry of live sessions — port of
//! `lib/server/session-manager.ts` + `lib/server/session-resume.ts`.

use std::collections::HashMap;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

use serde_json::Value;
use tokio::sync::watch;
use tokio::task::JoinHandle;

use crate::session::{RuntimeOptions, SendOptions, Session, SessionError, SessionOptions};
use crate::{log, paths, sessions_store, workspaces};

const DEFAULT_IDLE_REAP_MS: u64 = 60 * 60 * 1000;

/// `CLAUDIUS_SESSION_IDLE_REAP_MS` (min 5 s, default 1 h).
pub fn reap_ms() -> u64 {
    reap_ms_from(
        std::env::var("CLAUDIUS_SESSION_IDLE_REAP_MS")
            .ok()
            .as_deref(),
    )
}

/// `reapMs()` on the variable's value, as `setTimeout` takes it: `Number(raw)`
/// (so `0x1388` and a BOM-led `6000` count, a NEL-led one doesn't), at least
/// 5 s, else 1 h; past `2^31 - 1` ms node fires after 1 ms.
pub fn reap_ms_from(raw: Option<&str>) -> u64 {
    let Some(raw) = raw.filter(|r| !r.is_empty()) else {
        return DEFAULT_IDLE_REAP_MS;
    };
    let n = claudius_agent::js::to_number(raw);
    if !n.is_finite() || n < 5_000.0 {
        return DEFAULT_IDLE_REAP_MS;
    }
    if n > f64::from(i32::MAX) { 1 } else { n as u64 }
}

/// A start in flight; it fails with what `start()` threw (`name`, `message`).
type Starting = watch::Receiver<Option<Result<Arc<Session>, (&'static str, String)>>>;

/// A dead-CLI rebuild in flight, so concurrent callers share one
/// ([`SessionManager::restart_if_dead`]).
type Restarting = watch::Receiver<Option<Result<(Arc<Session>, bool), DeadReason>>>;

#[derive(Default)]
struct Inner {
    /// In the order they were registered (a JS `Map`).
    sessions: indexmap::IndexMap<String, Arc<Session>>,
    starting: HashMap<String, Starting>,
    reap_timers: HashMap<String, JoinHandle<()>>,
    watchers: HashMap<String, JoinHandle<()>>,
    /// `thinkingRecoveryAttempts`: consecutive thinking-replay rebuilds per
    /// id, kept across the rebuilds and cleared by a successful turn.
    thinking_recovery_attempts: HashMap<String, u32>,
    /// `deadRestartAttempts`: consecutive dead-CLI restarts per id and when
    /// the last one was tried, cleared by a successful turn and refilled
    /// after [`DEAD_RESTART_COOLDOWN_MS`].
    dead_restart_attempts: HashMap<String, (u32, i64)>,
    restarting: HashMap<String, Restarting>,
}

#[derive(Default)]
pub struct SessionManager {
    inner: Mutex<Inner>,
    /// Defaults merged into every new session (claude binary, env).
    pub runtime: Mutex<RuntimeOptions>,
    /// The idle reap window in ms, in place of [`reap_ms`] (tests; no 5 s
    /// floor).
    pub reap_ms_override: Mutex<Option<u64>>,
    /// `Date.now()` as the dead-restart budget reads it (tests pin it; the
    /// wall clock otherwise).
    #[allow(clippy::type_complexity)]
    pub dead_restart_clock: Mutex<Option<Arc<dyn Fn() -> i64 + Send + Sync>>>,
}

pub fn session_manager() -> &'static Arc<SessionManager> {
    static M: OnceLock<Arc<SessionManager>> = OnceLock::new();
    M.get_or_init(|| Arc::new(SessionManager::default()))
}

/// `recoverInPlace`'s cap on consecutive rebuilds.
pub const MAX_THINKING_RECOVERY_ATTEMPTS: u32 = 3;

/// `MAX_DEAD_RESTARTS`: consecutive dead-CLI restarts allowed without a
/// successful turn.
pub const MAX_DEAD_RESTARTS: u32 = 3;

/// `DEAD_RESTART_COOLDOWN_MS`: the dead-restart budget refills after this
/// long without an attempt, so a session whose boot failure the user has
/// since fixed can be restarted again without closing every tab first.
pub const DEAD_RESTART_COOLDOWN_MS: i64 = 5 * 60_000;

/// Why [`SessionManager::restart_if_dead`] couldn't hand back a live
/// session (`RestartIfDeadResult`'s `reason`).
#[derive(Clone, Debug, PartialEq, Eq, thiserror::Error)]
pub enum DeadReason {
    /// The id isn't live.
    #[error("gone")]
    Gone,
    /// The budget is used up (no successful turn since).
    #[error("max_attempts")]
    MaxAttempts,
    /// A passive caller's restart wasn't taken: the budget is already in use,
    /// or the CLI never came up ([`Session::came_up_live`]).
    #[error("skipped")]
    Skipped,
    /// The rebuild's `create` threw; the dead session stays bound.
    #[error("failed: {0}")]
    Failed(String),
}

/// What [`SessionManager::restart_if_dead`] hands back: the live session, and
/// whether it had to be rebuilt (TS `{ok: true, session, restarted}`).
#[derive(Clone)]
pub struct Restarted {
    pub session: Arc<Session>,
    pub restarted: bool,
}

/// `deadSessionResponse(res)`: the `{error}` body and status a route answers
/// when `restart_if_dead` couldn't hand back a live session, so the input,
/// queue (and TS's loop-cancel) routes all report a dead CLI the same way
/// instead of answering `ok` for a message that went nowhere.
pub fn dead_session_response(reason: &DeadReason) -> (String, u16) {
    match reason {
        DeadReason::Gone => ("session not found".to_owned(), 404),
        DeadReason::MaxAttempts => (
            "This session's process keeps exiting, so it wasn't restarted again. Check the error in the chat, or start a new session.".to_owned(),
            503,
        ),
        // `res.error ?? "unknown error"`: a skipped restart carries none.
        DeadReason::Failed(e) => (format!("Couldn't restart the session: {e}"), 503),
        DeadReason::Skipped => ("Couldn't restart the session: unknown error".to_owned(), 503),
    }
}

/// Why `recover_in_place` / `restart_in_place` didn't rebuild.
#[derive(Debug, thiserror::Error)]
pub enum RecoverError {
    /// The id isn't live (`reason: "gone"`).
    #[error("gone")]
    Gone,
    /// The cap was reached without a successful turn (`"max_attempts"`).
    #[error("max_attempts")]
    MaxAttempts,
    /// The rebuild's `create` failed (a TS throw).
    #[error(transparent)]
    Create(#[from] CreateError),
}

#[derive(Debug, thiserror::Error)]
pub enum CreateError {
    #[error(transparent)]
    Invalid(#[from] SessionError),
    #[error("{0}")]
    Start(String),
    /// `start()` threw: the JS error's `name` and `message`.
    #[error("{message}")]
    Threw { name: &'static str, message: String },
}

impl CreateError {
    /// The thrown error's `name`, as the create route reports it.
    pub fn name(&self) -> &'static str {
        match self {
            CreateError::Threw { name, .. } => name,
            _ => "Error",
        }
    }
}

impl SessionManager {
    /// `create(opts)` — dedupes a resume against live and in-flight starts.
    pub async fn create(
        self: &Arc<Self>,
        mut opts: SessionOptions,
    ) -> Result<Arc<Session>, CreateError> {
        if let Some(resume) = opts.resume.clone() {
            let in_flight = {
                let inner = self.inner.lock().unwrap();
                if let Some(s) = inner.sessions.get(&resume) {
                    let s = s.clone();
                    drop(inner);
                    self.cancel_reap(&resume);
                    return Ok(s);
                }
                inner.starting.get(&resume).cloned()
            };
            if let Some(mut rx) = in_flight {
                let res = rx
                    .wait_for(Option::is_some)
                    .await
                    .map_err(|e| CreateError::Start(e.to_string()))?;
                return res
                    .clone()
                    .unwrap()
                    .map_err(|(name, message)| CreateError::Threw { name, message });
            }
        }
        if opts.runtime.claude_bin.is_none() && opts.runtime.env_override.is_none() {
            opts.runtime = self.runtime.lock().unwrap().clone();
        }
        let session = Session::new(opts)?;
        session.attach_manager(Arc::downgrade(self));
        let id = session.id.clone();
        let (tx, rx) = watch::channel(None);
        self.inner.lock().unwrap().starting.insert(id.clone(), rx);

        session.start().await;
        // `start()` threw: end what it set up and fail the create, and every
        // create waiting on it.
        if let Some((name, message)) = session.take_start_error() {
            self.inner.lock().unwrap().starting.remove(&id);
            let _ = tx.send(Some(Err((name, message.clone()))));
            session.end().await;
            return Err(CreateError::Threw { name, message });
        }
        self.inner.lock().unwrap().starting.remove(&id);
        self.register(session.clone());
        let _ = tx.send(Some(Ok(session.clone())));
        Ok(session)
    }

    /// `register(session)`: publish a started session and wire its idle
    /// reaping. Shared by `create` and the failed-rebuild path of
    /// [`Self::restart_if_dead`], which puts the dead session back.
    fn register(self: &Arc<Self>, session: Arc<Session>) {
        let id = session.id.clone();
        self.inner
            .lock()
            .unwrap()
            .sessions
            .insert(id.clone(), session.clone());
        // onSubscriberCountChange → (re)arm or cancel the idle reaper.
        let mut counts = session.subscriber_count_watch();
        let me = Arc::downgrade(self);
        let wid = id.clone();
        let watcher = tokio::spawn(async move {
            while counts.changed().await.is_ok() {
                let n = *counts.borrow();
                let Some(m) = me.upgrade() else { break };
                if n > 0 {
                    m.cancel_reap(&wid);
                } else {
                    m.schedule_reap(&wid);
                }
            }
        });
        if let Some(old) = self
            .inner
            .lock()
            .unwrap()
            .watchers
            .insert(id.clone(), watcher)
        {
            old.abort();
        }
        self.schedule_reap(&id);
    }

    pub fn get(&self, id: &str) -> Option<Arc<Session>> {
        self.inner.lock().unwrap().sessions.get(id).cloned()
    }

    /// `[...this.sessions.values()]`: registration order (a failed rebuild
    /// puts its dead session back last).
    pub fn list(&self) -> Vec<Arc<Session>> {
        self.inner
            .lock()
            .unwrap()
            .sessions
            .values()
            .cloned()
            .collect()
    }

    pub fn sessions_by_cwd(&self, cwd: &str) -> Vec<Arc<Session>> {
        self.list().into_iter().filter(|s| s.cwd == cwd).collect()
    }

    pub async fn remove(&self, id: &str) {
        let Some(session) = self.get(id) else { return };
        self.cancel_reap(id);
        if let Some(w) = self.inner.lock().unwrap().watchers.remove(id) {
            w.abort();
        }
        session.end().await;
        self.inner.lock().unwrap().sessions.shift_remove(id);
    }

    /// `recoverInPlace(id, { resumeAt, replayPrompt })`: rebuild a session
    /// wedged by the thinking-block replay 400 under the same id (so open
    /// tabs keep their URL and reconnect), resumed at `resume_at` so the
    /// poisoned turn is dropped, then re-send `replay_prompt`. Capped at
    /// [`MAX_THINKING_RECOVERY_ATTEMPTS`] in a row, so a turn that re-poisons
    /// on replay surfaces instead of looping.
    pub async fn recover_in_place(
        self: &Arc<Self>,
        id: &str,
        resume_at: &str,
        replay_prompt: &str,
    ) -> Result<(), RecoverError> {
        let Some(carry) = self.get(id).map(|s| s.rebuild_options()) else {
            return Err(RecoverError::Gone);
        };
        {
            let mut inner = self.inner.lock().unwrap();
            let attempts = inner
                .thinking_recovery_attempts
                .entry(id.to_owned())
                .or_default();
            if *attempts >= MAX_THINKING_RECOVERY_ATTEMPTS {
                return Err(RecoverError::MaxAttempts);
            }
            *attempts += 1;
        }
        self.remove(id).await;
        let session = self
            .create(SessionOptions {
                resume: Some(id.to_owned()),
                resume_session_at: Some(resume_at.to_owned()),
                ..carry
            })
            .await?;
        session.send_input(replay_prompt, &[], SendOptions::default());
        Ok(())
    }

    /// `restartInPlace(id)`: the account switch's rebuild under the same id,
    /// resumed from the whole transcript with nothing re-sent and no cap.
    pub async fn restart_in_place(self: &Arc<Self>, id: &str) -> Result<(), RecoverError> {
        let Some(carry) = self.get(id).map(|s| s.rebuild_options()) else {
            return Err(RecoverError::Gone);
        };
        self.remove(id).await;
        self.create(SessionOptions {
            resume: Some(id.to_owned()),
            ..carry
        })
        .await?;
        Ok(())
    }

    /// `noteThinkingRecoverySuccess(id)`: a successful turn clears the
    /// consecutive-recovery count.
    pub fn note_thinking_recovery_success(&self, id: &str) {
        let mut inner = self.inner.lock().unwrap();
        inner.thinking_recovery_attempts.remove(id);
        // A turn completed, so the CLI is healthy again: the dead-restart
        // budget goes too (CC 2.1.311).
        inner.dead_restart_attempts.remove(id);
    }

    /// `Date.now()` as the dead-restart budget reads it.
    fn dead_now(&self) -> i64 {
        match self.dead_restart_clock.lock().unwrap().as_ref() {
            Some(f) => f(),
            None => crate::now_ms(),
        }
    }

    /// `restartIfDead(id, {passive})` (CC 2.1.311): when a session's CLI ends
    /// on its own ([`Session::is_dead`]) the session stays bound with `done`
    /// set and `send_input` silently drops every message. This rebuilds it
    /// under the SAME id, resumed from its own transcript, then closes the old
    /// instance's streams so open tabs reconnect to the new one (the new
    /// `start()` drains whatever is left in the persisted queue).
    ///
    /// A live session comes back unchanged, an unknown id is
    /// [`DeadReason::Gone`], and concurrent callers share one rebuild. Capped
    /// at [`MAX_DEAD_RESTARTS`] in a row without a successful turn, so a CLI
    /// that dies on boot surfaces instead of respawning on every send; the
    /// budget refills after [`DEAD_RESTART_COOLDOWN_MS`] without an attempt.
    /// A failed rebuild leaves the dead session bound (and its streams open),
    /// so read-only routes keep working and the write routes report it.
    ///
    /// `passive` callers (a stream connect, a poller — not a user action) get
    /// only the first attempt, and only for a session that came up live:
    /// otherwise [`DeadReason::Skipped`], and they keep the dead instance
    /// read-only.
    ///
    /// Write routes call this unconditionally rather than gating on
    /// `get(id)`: the id is briefly unbound while a rebuild runs, and only
    /// this joins the one in flight.
    pub async fn restart_if_dead(
        self: &Arc<Self>,
        id: &str,
        passive: bool,
    ) -> Result<Restarted, DeadReason> {
        let in_flight = self.inner.lock().unwrap().restarting.get(id).cloned();
        if let Some(mut rx) = in_flight {
            return match rx.wait_for(Option::is_some).await {
                // The rebuild's task panicked before it could report.
                Err(e) => Err(DeadReason::Failed(e.to_string())),
                Ok(res) => res
                    .clone()
                    .unwrap()
                    .map(|(session, restarted)| Restarted { session, restarted }),
            };
        }
        let Some(existing) = self.get(id) else {
            return Err(DeadReason::Gone);
        };
        if !existing.is_dead() {
            return Ok(Restarted {
                session: existing,
                restarted: false,
            });
        }
        let now = self.dead_now();
        let (tx, rx) = watch::channel(None);
        {
            let mut inner = self.inner.lock().unwrap();
            let attempts = match inner.dead_restart_attempts.get(id) {
                Some((count, at)) if now - at < DEAD_RESTART_COOLDOWN_MS => *count,
                _ => 0,
            };
            if passive && (attempts > 0 || !existing.came_up_live()) {
                return Err(DeadReason::Skipped);
            }
            if attempts >= MAX_DEAD_RESTARTS {
                return Err(DeadReason::MaxAttempts);
            }
            inner
                .dead_restart_attempts
                .insert(id.to_owned(), (attempts + 1, now));
            inner.restarting.insert(id.to_owned(), rx);
        }
        // The rebuild runs as its own task, as TS's promise runs to the end
        // whoever awaits it: a send whose request is dropped mid-rebuild (a
        // closed tab) must not leave the id unbound and `restarting` stuck
        // for every later caller.
        let me = self.clone();
        let owned = id.to_owned();
        let rebuild = tokio::spawn(async move {
            let id = owned.as_str();
            let carry = existing.rebuild_options();
            me.remove(id).await;
            let res = match me
                .create(SessionOptions {
                    resume: Some(id.to_owned()),
                    ..carry
                })
                .await
            {
                // The old instance is finished: let its tabs reconnect and
                // bind to the new session.
                Ok(session) => {
                    existing.close_streams();
                    Ok((session, true))
                }
                Err(e) => {
                    // The rebuild failed (a CLI that dies on boot, an
                    // unreadable settings.json). Keep the dead instance
                    // bound: `remove` dropped it, but read-only routes and its
                    // still-attached streams need something to talk to, and
                    // the write routes report the failure. Its streams stay
                    // open, because closing them would only reconnect into
                    // another doomed restart.
                    let message = e.to_string();
                    if me.get(id).is_none() {
                        me.register(existing);
                    }
                    Err(DeadReason::Failed(message))
                }
            };
            let _ = tx.send(Some(res.clone()));
            me.inner.lock().unwrap().restarting.remove(id);
            res
        });
        match rebuild.await {
            Ok(res) => res.map(|(session, restarted)| Restarted { session, restarted }),
            // A panic in the rebuild: don't leave later callers joining it.
            Err(e) => {
                self.inner.lock().unwrap().restarting.remove(id);
                Err(DeadReason::Failed(e.to_string()))
            }
        }
    }

    fn schedule_reap(self: &Arc<Self>, id: &str) {
        self.cancel_reap(id);
        let me = Arc::downgrade(self);
        let rid = id.to_owned();
        let window = self
            .reap_ms_override
            .lock()
            .unwrap()
            .unwrap_or_else(reap_ms);
        let t = tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(window)).await;
            let Some(m) = me.upgrade() else { return };
            m.inner.lock().unwrap().reap_timers.remove(&rid);
            let Some(s) = m.get(&rid) else { return };
            if s.subscriber_count() > 0 {
                return;
            }
            if s.has_pending_user_prompts() {
                m.schedule_reap(&rid);
                return;
            }
            // Likewise an armed `/loop` wake-up or session cron: its timer
            // lives in the CLI, so reaping would silently stop the loop
            // (CC 2.1.292). Re-checked every window.
            if s.has_armed_loops(crate::now_ms()) {
                m.schedule_reap(&rid);
                return;
            }
            m.remove(&rid).await;
        });
        self.inner
            .lock()
            .unwrap()
            .reap_timers
            .insert(id.to_owned(), t);
    }

    fn cancel_reap(&self, id: &str) {
        if let Some(t) = self.inner.lock().unwrap().reap_timers.remove(id) {
            t.abort();
        }
    }

    /// `getOrResumeSession(id)`.
    pub async fn get_or_resume(self: &Arc<Self>, id: &str) -> Option<Arc<Session>> {
        if let Some(s) = self.get(id) {
            tracing::debug!(target: log::SESS_LOAD, id, "[sess-load] getOrResumeSession in-memory hit");
            // CC 2.1.311 — a session whose CLI died between turns is restarted
            // while a tab is attached (a stream connect, a poller). Passive:
            // only the first attempt, and only once the CLI had come up, so a
            // poll can't use up the budget meant for the user's next send or
            // respawn a CLI that dies on boot. When it can't restart, the dead
            // instance still comes back, so read-only routes keep working and
            // the write routes report the failure.
            if s.is_dead() {
                return match self.restart_if_dead(id, true).await {
                    Ok(r) => Some(r.session),
                    Err(_) => Some(s),
                };
            }
            return Some(s);
        }
        let info = sessions_store::info(id, None);
        let file_info_found = info.is_some();
        let Some(cwd) = info.and_then(|i| i.cwd).filter(|c| !c.is_empty()) else {
            tracing::debug!(
                target: log::SESS_LOAD,
                id,
                fileInfoFound = file_info_found,
                "[sess-load] getOrResumeSession: no fileInfo/cwd — returning null"
            );
            return None;
        };
        tracing::debug!(target: log::SESS_LOAD, id, cwd = %cwd, "[sess-load] getOrResumeSession: resuming from disk");
        let all = workspaces::list().unwrap_or_default();
        let origin = all.iter().find(|w| w.root_path == cwd);
        let default_mode = origin
            .and_then(|w| w.default_str("permissionMode"))
            .map(str::to_owned);
        let model = origin
            .and_then(|w| w.default_str("model"))
            .map(str::to_owned);
        let permission_mode = self.resume_permission_mode(id, &cwd, default_mode);
        let session = match self
            .create(SessionOptions {
                resume: Some(id.to_owned()),
                cwd: Some(cwd),
                model,
                permission_mode: permission_mode.clone(),
                ..Default::default()
            })
            .await
        {
            Ok(s) => s,
            Err(e) => {
                tracing::debug!(target: log::SESS_LOAD, id, err = %e, "[sess-load] getOrResumeSession FAILED");
                return None;
            }
        };
        if let Some(pm) = permission_mode
            && session.permission_mode() != pm
            && let Err(e) = session.try_set_permission_mode(&pm, false).await
        {
            tracing::debug!(target: log::SESS_LOAD, id, err = %e, "[sess-load] getOrResumeSession FAILED");
            return None;
        }
        Some(session)
    }

    /// `resumePermissionMode` — only `plan` survives a resume; otherwise the
    /// workspace default applies.
    pub fn resume_permission_mode(
        &self,
        id: &str,
        cwd: &str,
        fallback: Option<String>,
    ) -> Option<String> {
        let was = match self.get(id) {
            Some(s) => Some(s.permission_mode()),
            None => last_recorded_permission_mode(id, cwd),
        };
        if was.as_deref() == Some("plan") {
            Some("plan".into())
        } else {
            fallback
        }
    }
}

/// `lastRecordedPermissionMode` — last top-level `permissionMode` stamped in
/// `projectRoot(cwd)/<id>.jsonl`.
pub fn last_recorded_permission_mode(id: &str, cwd: &str) -> Option<String> {
    if !crate::is_safe_id(id) {
        return None;
    }
    let dir = paths::project_root(cwd);
    let file = paths::within(&dir, &format!("{id}.jsonl"))?;
    let f = std::fs::File::open(&file).ok()?;
    let mut last = None;
    // `jsonlLines(createReadStream(file, "utf8"))`: lossy UTF-8, `\n` only;
    // `JSON.parse` takes a lone surrogate escape.
    for line in crate::jsonl_lines::JsonlLines::new(f) {
        let Ok(line) = line else { return None };
        if !line.contains("\"permissionMode\"") {
            continue;
        }
        let Ok(entry) = claudius_agent::js::json_parse(&line) else {
            continue;
        };
        if entry.get("isSidechain") == Some(&Value::Bool(true)) {
            continue;
        }
        let t = entry.get("type").and_then(Value::as_str);
        if t != Some("user") && t != Some("permission-mode") {
            continue;
        }
        if let Some(pm) = entry.get("permissionMode").and_then(Value::as_str) {
            last = Some(pm.to_owned());
        }
    }
    last
}
