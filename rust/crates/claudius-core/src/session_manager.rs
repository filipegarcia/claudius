//! Process-wide registry of live sessions — port of
//! `lib/server/session-manager.ts` + `lib/server/session-resume.ts`.

use std::collections::HashMap;
use std::io::BufRead;
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
    std::env::var("CLAUDIUS_SESSION_IDLE_REAP_MS")
        .ok()
        .and_then(|v| v.trim().parse::<f64>().ok())
        .filter(|n| n.is_finite() && *n >= 5_000.0)
        .map(|n| n as u64)
        .unwrap_or(DEFAULT_IDLE_REAP_MS)
}

/// A start in flight; it fails with what `start()` threw (`name`, `message`).
type Starting = watch::Receiver<Option<Result<Arc<Session>, (&'static str, String)>>>;

#[derive(Default)]
struct Inner {
    sessions: HashMap<String, Arc<Session>>,
    starting: HashMap<String, Starting>,
    reap_timers: HashMap<String, JoinHandle<()>>,
    watchers: HashMap<String, JoinHandle<()>>,
    /// `thinkingRecoveryAttempts`: consecutive thinking-replay rebuilds per
    /// id, kept across the rebuilds and cleared by a successful turn.
    thinking_recovery_attempts: HashMap<String, u32>,
}

#[derive(Default)]
pub struct SessionManager {
    inner: Mutex<Inner>,
    /// Defaults merged into every new session (claude binary, env).
    pub runtime: Mutex<RuntimeOptions>,
    /// The idle reap window in ms, in place of [`reap_ms`] (tests; no 5 s
    /// floor).
    pub reap_ms_override: Mutex<Option<u64>>,
}

pub fn session_manager() -> &'static Arc<SessionManager> {
    static M: OnceLock<Arc<SessionManager>> = OnceLock::new();
    M.get_or_init(|| Arc::new(SessionManager::default()))
}

/// `recoverInPlace`'s cap on consecutive rebuilds.
pub const MAX_THINKING_RECOVERY_ATTEMPTS: u32 = 3;

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
        {
            let mut inner = self.inner.lock().unwrap();
            inner.sessions.insert(id.clone(), session.clone());
            inner.starting.remove(&id);
        }
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
        self.inner
            .lock()
            .unwrap()
            .watchers
            .insert(id.clone(), watcher);
        self.schedule_reap(&id);
        let _ = tx.send(Some(Ok(session.clone())));
        Ok(session)
    }

    pub fn get(&self, id: &str) -> Option<Arc<Session>> {
        self.inner.lock().unwrap().sessions.get(id).cloned()
    }

    pub fn list(&self) -> Vec<Arc<Session>> {
        let mut v: Vec<_> = self
            .inner
            .lock()
            .unwrap()
            .sessions
            .values()
            .cloned()
            .collect();
        v.sort_by_key(|s| s.created_at);
        v
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
        self.inner.lock().unwrap().sessions.remove(id);
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
        self.inner
            .lock()
            .unwrap()
            .thinking_recovery_attempts
            .remove(id);
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
    for line in std::io::BufReader::new(f).lines() {
        let Ok(line) = line else { return None };
        if !line.contains("\"permissionMode\"") {
            continue;
        }
        let Ok(entry) = serde_json::from_str::<Value>(&line) else {
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
