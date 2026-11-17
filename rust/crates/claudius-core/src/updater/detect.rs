//! `lib/server/updater/detect.ts`: the background check behind
//! `POST /api/updater/check` (and, from D27b, the scheduler).
//!
//! Single flight: two callers racing (the boot tick, the daily timer, a UI
//! click) share one run, so they can't fetch twice and clobber each other's
//! state writes.

use std::sync::Mutex;

use claudius_agent::js;
use futures::future::{BoxFuture, FutureExt, Shared};
use serde_json::{Map, Value};

use crate::now_ms;
use crate::updater::git::{self, AheadBehind, RECENT_COMMITS_LIMIT};
use crate::updater::root;
use crate::updater::settings::{self, StatePatch, UpdaterSettings};

/// `CheckResult`.
#[derive(Clone, Debug, PartialEq)]
pub enum CheckResult {
    UpToDate { sha: String, branch: String },
    UpdateAvailable { pending: Value },
    Skipped { reason: String },
    Error { message: String },
}

impl CheckResult {
    /// The answer `POST /api/updater/check` sends.
    pub fn to_json(&self) -> Value {
        let mut m = Map::new();
        match self {
            CheckResult::UpToDate { sha, branch } => {
                m.insert("kind".into(), "up-to-date".into());
                m.insert("sha".into(), Value::String(sha.clone()));
                m.insert("branch".into(), Value::String(branch.clone()));
            }
            CheckResult::UpdateAvailable { pending } => {
                m.insert("kind".into(), "update-available".into());
                m.insert("pending".into(), pending.clone());
            }
            CheckResult::Skipped { reason } => {
                m.insert("kind".into(), "skipped".into());
                m.insert("reason".into(), Value::String(reason.clone()));
            }
            CheckResult::Error { message } => {
                m.insert("kind".into(), "error".into());
                m.insert("message".into(), Value::String(message.clone()));
            }
        }
        Value::Object(m)
    }
}

/// `UpdaterPending` as the check writes it.
fn pending_value(
    remote_sha: &str,
    ab: AheadBehind,
    dirty: bool,
    branch: &str,
    upstream_branch: &str,
    recent: &[String],
) -> Value {
    let mut m = Map::new();
    m.insert("remoteSha".into(), Value::String(remote_sha.to_owned()));
    m.insert("ahead".into(), crate::js_num(ab.ahead));
    m.insert("behind".into(), crate::js_num(ab.behind));
    m.insert("dirty".into(), Value::Bool(dirty));
    m.insert("branch".into(), Value::String(branch.to_owned()));
    m.insert(
        "upstreamBranch".into(),
        Value::String(upstream_branch.to_owned()),
    );
    if !recent.is_empty() {
        m.insert(
            "recentCommits".into(),
            Value::Array(recent.iter().map(|s| Value::String(s.clone())).collect()),
        );
    }
    Value::Object(m)
}

type SharedCheck = Shared<BoxFuture<'static, Result<CheckResult, String>>>;

/// The run in flight, if any (`inflight` in the TS).
static INFLIGHT: Mutex<Option<SharedCheck>> = Mutex::new(None);

/// `checkForUpdates()`: the run in flight, or a new one. `Err` is a throw
/// that escapes it (the route answers Next's empty 500).
pub fn check_for_updates() -> SharedCheck {
    let mut slot = INFLIGHT.lock().expect("inflight lock");
    if let Some(shared) = slot.as_ref() {
        return shared.clone();
    }
    let (tx, rx) = tokio::sync::oneshot::channel();
    // Own task, so a client that hangs up doesn't stop the check (the TS
    // promise runs on regardless of who awaits it).
    tokio::spawn(async move {
        let result = run_check().await;
        INFLIGHT.lock().expect("inflight lock").take();
        let _ = tx.send(result);
    });
    let fut: BoxFuture<'static, Result<CheckResult, String>> = Box::pin(async move {
        rx.await
            .unwrap_or_else(|_| Err("the check task went away".to_owned()))
    });
    let shared = fut.shared();
    *slot = Some(shared.clone());
    shared
}

/// Only for tests: forget the run in flight.
pub fn reset_inflight() {
    INFLIGHT.lock().expect("inflight lock").take();
}

async fn run_check() -> Result<CheckResult, String> {
    let root = root::install_root();
    if !git::is_git_checkout(&root).await {
        return Ok(CheckResult::Skipped {
            reason: "install is not a git checkout".to_owned(),
        });
    }
    let settings = settings::get_updater_settings();
    if settings.mode == "disabled" {
        return Ok(CheckResult::Skipped {
            reason: "updater disabled in settings".to_owned(),
        });
    }
    // Outside the `try`: a write that fails here escapes the handler.
    settings::set_updater_status(settings::checking(now_ms())).map_err(|e| e.message)?;
    match check_body(&root, &settings).await {
        Ok(result) => Ok(result),
        Err(message) => {
            settings::patch_updater_state(&StatePatch {
                last_check_at: Some(Some(now_ms() as f64)),
                last_error: Some(Some(message.clone())),
                status: Some(settings::idle()),
                ..Default::default()
            })
            .map_err(|e| e.message)?;
            Ok(CheckResult::Error { message })
        }
    }
}

/// The `try` block: `Err` is what it throws, which the caller's `catch`
/// records as `lastError` and answers as `{kind: "error"}`.
async fn check_body(root: &str, settings: &UpdaterSettings) -> Result<CheckResult, String> {
    let local_branch = match git::current_branch(root).await.map_err(|e| e.message)? {
        Some(b) => b,
        None => {
            let reason = "HEAD is detached — manual checkout needed".to_owned();
            settings::patch_updater_state(&StatePatch {
                last_check_at: Some(Some(now_ms() as f64)),
                last_error: Some(Some(reason.clone())),
                status: Some(settings::idle()),
                ..Default::default()
            })
            .map_err(|e| e.message)?;
            return Ok(CheckResult::Skipped { reason });
        }
    };

    if let Err(e) = git::fetch(root, &settings.remote, &settings.branch).await {
        // `err.stderr || err.message`.
        let msg = if e.stderr.is_empty() {
            e.message
        } else {
            e.stderr
        };
        settings::patch_updater_state(&StatePatch {
            last_check_at: Some(Some(now_ms() as f64)),
            last_error: Some(Some(format!("fetch failed: {}", js::trim(&msg)))),
            status: Some(settings::idle()),
            ..Default::default()
        })
        .map_err(|e| e.message)?;
        return Ok(CheckResult::Error { message: msg });
    }

    let upstream_ref = format!("{}/{}", settings.remote, settings.branch);
    let local_sha = git::head_sha(root).await.map_err(|e| e.message)?;
    let remote_sha = git::rev_parse(root, &upstream_ref)
        .await
        .map_err(|e| e.message)?;
    let dirty = git::is_dirty(root).await.map_err(|e| e.message)?;
    // The conflict-clear signal: unmerged index entries OR marker residue
    // in tracked content. `true` on any error, so a genuine conflict is
    // never cleared by accident.
    let has_conflict = git::has_conflicts(root).await;

    if local_sha == remote_sha {
        // `recovery` is deliberately NOT cleared here: after an install or
        // build failure HEAD is already at upstream, so up-to-date is the
        // normal state while the build is still broken.
        settings::patch_updater_state(&StatePatch {
            last_check_at: Some(Some(now_ms() as f64)),
            last_error: Some(None),
            pending: Some(None),
            conflicts: (!has_conflict).then_some(None),
            status: Some(settings::idle()),
        })
        .map_err(|e| e.message)?;
        return Ok(CheckResult::UpToDate {
            sha: local_sha,
            branch: local_branch,
        });
    }

    let ab = git::ahead_behind(root, "HEAD", &upstream_ref)
        .await
        .map_err(|e| e.message)?;
    let commits = git::recent_commits(root, "HEAD", &upstream_ref, RECENT_COMMITS_LIMIT).await;
    let pending = pending_value(
        &remote_sha,
        ab,
        dirty,
        &local_branch,
        &upstream_ref,
        &commits,
    );

    settings::patch_updater_state(&StatePatch {
        last_check_at: Some(Some(now_ms() as f64)),
        last_error: Some(None),
        pending: Some(Some(pending.clone())),
        conflicts: (!has_conflict).then_some(None),
        status: Some(settings::idle()),
    })
    .map_err(|e| e.message)?;

    if ab.behind == 0.0 {
        // Ahead-only, or diverged with nothing incoming: nothing to pull.
        return Ok(CheckResult::UpToDate {
            sha: local_sha,
            branch: local_branch,
        });
    }
    Ok(CheckResult::UpdateAvailable { pending })
}
