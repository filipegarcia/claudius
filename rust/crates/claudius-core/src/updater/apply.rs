//! `lib/server/updater/apply.ts`: the self-update itself, behind `POST
//! /api/updater/apply` and the scheduler's auto-apply.
//!
//! One run at a time ([`apply_update`] shares the run in flight). A run:
//!
//! 1. **Heal first.** A tree that carries conflict markers or unmerged
//!    entries (whatever `updater.json` says) is handed to a bounded Claude
//!    session when Claude is allowed (cc-merge mode, or a click), or stops
//!    with the "resolve them first" skip. Recorded conflicts on a clean tree
//!    are dropped.
//! 2. **Pull**, after a fresh check: a clean fast-forward (`ff-only`), a
//!    dirty tree with nothing ahead (`stash-ff`: stash, pull, pop), or a
//!    diverged branch (`cc-merge`: a Claude session merges, verified against
//!    git afterwards). An unfinished earlier update (markers, recorded
//!    conflicts or a recorded install / build failure) is finished at HEAD
//!    even when there is nothing to pull or the check failed.
//! 3. The **safety net**: the same heal again, so a conflicted tree never
//!    reaches `bun install`.
//! 4. **Install** (`--frozen-lockfile` on a fast-forward, `--ignore-scripts`
//!    unless `bun.lock` / `patches/` moved since the start) and **build**,
//!    then the state is cleared and the process restarted
//!    ([`super::restart`]).
//!
//! An install or build failure is recoverable: the tree stays advanced and
//! `recovery` is recorded. Any other failure records `lastError`; the
//! rollback the TS has for a `merge`-phase throw can't happen (nothing
//! throws one) but is kept. Everything goes into
//! `<root>/.claudius/logs/updater.log` (best effort).
//!
//! The recorded `conflicts` / `recovery` are taken as the JS values they
//! are: a resumed run's `fromSha` and strategy are whatever their
//! `fromSha` / `origin` held, so a number makes `fromSha.slice` throw
//! where the TS does.

use std::collections::VecDeque;
use std::path::PathBuf;
use std::sync::Mutex;

use claudius_agent::{Options, Query, js};
use futures::future::{BoxFuture, FutureExt, Shared};
use serde_json::{Map, Value};

use crate::customization_auto_fix::replace_all;
use crate::updater::detect::{self, CheckResult};
use crate::updater::git::{self, StashPop, Stream};
use crate::updater::restart::{self, RestartResult};
use crate::updater::root;
use crate::updater::settings::{self, StatePatch};
use crate::{js_date, js_num, js_string, node_fs, node_path, now_ms};

/// `ApplyPhase`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Phase {
    Detect,
    Pull,
    Merge,
    Install,
    Build,
    Init,
}

impl Phase {
    pub fn as_str(self) -> &'static str {
        match self {
            Phase::Detect => "detect",
            Phase::Pull => "pull",
            Phase::Merge => "merge",
            Phase::Install => "install",
            Phase::Build => "build",
            Phase::Init => "init",
        }
    }
}

/// `Strategy`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Strategy {
    FfOnly,
    StashFf,
    CcMerge,
    Skip(String),
}

impl Strategy {
    /// `strategy.kind`.
    pub fn kind(&self) -> &'static str {
        match self {
            Strategy::FfOnly => "ff-only",
            Strategy::StashFf => "stash-ff",
            Strategy::CcMerge => "cc-merge",
            Strategy::Skip(_) => "skip",
        }
    }
}

/// `ApplyOutcome`. `strategy`, `origin` and the shas are JS values: a
/// resumed run carries whatever the recorded state held.
#[derive(Clone, Debug, PartialEq)]
pub enum ApplyOutcome {
    Applied {
        strategy: Value,
        from_sha: Value,
        to_sha: Value,
        restart: RestartResult,
    },
    NoUpdate,
    Skipped {
        reason: String,
    },
    Conflicts {
        origin: Value,
        from_sha: Value,
        to_sha: Value,
        detail: String,
    },
    Error {
        message: String,
        phase: Phase,
    },
}

impl ApplyOutcome {
    /// The outcome as the route answers it.
    pub fn to_json(&self) -> Value {
        let mut m = Map::new();
        match self {
            ApplyOutcome::Applied {
                strategy,
                from_sha,
                to_sha,
                restart,
            } => {
                m.insert("kind".into(), "applied".into());
                m.insert("strategy".into(), strategy.clone());
                m.insert("fromSha".into(), from_sha.clone());
                m.insert("toSha".into(), to_sha.clone());
                m.insert("restart".into(), restart.to_json());
            }
            ApplyOutcome::NoUpdate => {
                m.insert("kind".into(), "no-update".into());
            }
            ApplyOutcome::Skipped { reason } => {
                m.insert("kind".into(), "skipped".into());
                m.insert("reason".into(), Value::String(reason.clone()));
            }
            ApplyOutcome::Conflicts {
                origin,
                from_sha,
                to_sha,
                detail,
            } => {
                m.insert("kind".into(), "conflicts".into());
                m.insert("origin".into(), origin.clone());
                m.insert("fromSha".into(), from_sha.clone());
                m.insert("toSha".into(), to_sha.clone());
                m.insert("detail".into(), Value::String(detail.clone()));
            }
            ApplyOutcome::Error { message, phase } => {
                m.insert("kind".into(), "error".into());
                m.insert("message".into(), Value::String(message.clone()));
                m.insert("phase".into(), phase.as_str().into());
            }
        }
        Value::Object(m)
    }
}

/// What a run is given.
#[derive(Clone, Debug, Default)]
pub struct ApplyOptions {
    /// `allowCcMerge`: the user asked (a click), so Claude may merge and
    /// resolve even outside cc-merge mode.
    pub allow_cc_merge: bool,
    /// The `claude` the Claude sessions run (`None`: the SDK's lookup).
    pub claude_bin: Option<PathBuf>,
}

/// A run's result: `Err` is a throw that escapes it (the route answers
/// Next's empty 500).
pub type ApplyResult = Result<ApplyOutcome, String>;

/// A run, shared by everyone who asked while it was in flight.
pub type SharedApply = Shared<BoxFuture<'static, ApplyResult>>;

static APPLYING: Mutex<Option<SharedApply>> = Mutex::new(None);

/// `applyUpdate(opts)`: the run in flight (whatever options it was started
/// with), or a new one on its own task (a caller that goes away doesn't
/// stop it).
pub fn apply_update(opts: ApplyOptions) -> SharedApply {
    let mut slot = APPLYING.lock().expect("apply lock");
    if let Some(shared) = slot.as_ref() {
        return shared.clone();
    }
    let (tx, rx) = tokio::sync::oneshot::channel();
    tokio::spawn(async move {
        let result = run_apply(opts).await;
        APPLYING.lock().expect("apply lock").take();
        let _ = tx.send(result);
    });
    let fut: BoxFuture<'static, ApplyResult> = Box::pin(async move {
        rx.await
            .unwrap_or_else(|_| Err("the apply task went away".to_owned()))
    });
    let shared = fut.shared();
    *slot = Some(shared.clone());
    shared
}

/// The run in flight, if any.
pub fn in_flight() -> Option<SharedApply> {
    APPLYING.lock().expect("apply lock").clone()
}

/// A throw inside the run's `try`: its message, and the `phase` a
/// `phaseError` carries.
#[derive(Clone, Debug)]
struct Thrown {
    message: String,
    phase: Option<Phase>,
}

impl Thrown {
    fn plain(message: impl Into<String>) -> Thrown {
        Thrown {
            message: message.into(),
            phase: None,
        }
    }
}

impl From<git::UpdaterGitError> for Thrown {
    fn from(e: git::UpdaterGitError) -> Thrown {
        Thrown::plain(e.message)
    }
}

impl From<node_fs::FsError> for Thrown {
    fn from(e: node_fs::FsError) -> Thrown {
        Thrown::plain(e.message)
    }
}

/// `UpdaterGitError`'s `err.stderr.trim() || err.message`.
fn git_failure_text(e: &git::UpdaterGitError) -> String {
    let trimmed = js::trim(&e.stderr);
    if trimmed.is_empty() {
        e.message.clone()
    } else {
        trimmed.to_owned()
    }
}

/// `` `${v}` ``: a `Cannot convert object to primitive value` TypeError for
/// an object that shadows `toString`.
fn template(v: &Value) -> Result<String, Thrown> {
    js_string::to_js_string(v)
        .map_err(|_| Thrown::plain("Cannot convert object to primitive value"))
}

/// `` `${name.slice(0, 7)}` `` for a JS value: a string's first 7 UTF-16
/// units, an array's first 7 items joined, a TypeError for anything else.
fn slice7(v: &Value, name: &str) -> Result<String, Thrown> {
    match v {
        Value::String(s) => Ok(head16(s, 7)),
        Value::Array(items) => template(&Value::Array(items.iter().take(7).cloned().collect())),
        _ => Err(Thrown::plain(format!("{name}.slice is not a function"))),
    }
}

/// `s.slice(0, n)` in UTF-16 units (a cut pair leaves a lone surrogate's
/// stand-in).
fn head16(s: &str, n: usize) -> String {
    let units = js_string::units(s);
    js_string::from_units(&units[..units.len().min(n)])
}

/// `String(v)` as node's spawn writes an argument (an object that shadows
/// `toString` becomes an empty one).
fn arg_string(v: &Value) -> String {
    js_string::to_js_string(v).unwrap_or_default()
}

/// `o?.key` on a recorded state member, `None` for `undefined` and `null`
/// (what `??` falls through).
fn recorded<'a>(member: &'a Option<Value>, key: &str) -> Option<&'a Value> {
    match member {
        Some(Value::Object(m)) => m.get(key).filter(|v| !v.is_null()),
        _ => None,
    }
}

/// `APPLY_LOG(root)`.
pub fn apply_log_path(root: &str) -> String {
    node_path::join(&[root, ".claudius", "logs", "updater.log"])
}

/// `appendLog(root, line)`: best effort, the text as Node writes it
/// (UTF-8, a lone surrogate as U+FFFD).
pub fn append_log(root: &str, line: &str) {
    let path = apply_log_path(root);
    if node_fs::mkdir_recursive(&node_path::dirname(&path), 0o777).is_err() {
        return;
    }
    let text = js_string::lossy(line);
    let open = {
        let mut o = std::fs::OpenOptions::new();
        o.create(true).append(true);
        #[cfg(unix)]
        std::os::unix::fs::OpenOptionsExt::mode(&mut o, 0o666);
        o.open(&path)
    };
    if let Ok(mut f) = open {
        let _ = std::io::Write::write_all(&mut f, text.as_bytes());
    }
}

/// `new Date().toISOString()`.
fn iso_now() -> String {
    js_date::to_iso_string(now_ms() as f64).unwrap_or_default()
}

/// `{ ..., status: { kind: "idle" } }` with `lastError`.
fn idle_with_error(error: String) -> StatePatch {
    StatePatch {
        last_error: Some(Some(error)),
        status: Some(settings::idle()),
        ..Default::default()
    }
}

/// The mutable locals the TS `catch` reads.
struct Run {
    root: String,
    opts: ApplyOptions,
    strategy: Strategy,
    from_sha: Value,
    applied_strategy: Value,
    install_frozen: bool,
}

async fn run_apply(opts: ApplyOptions) -> ApplyResult {
    let root = root::install_root();
    let settings = settings::get_updater_settings();
    if settings.mode == "disabled" {
        return Ok(ApplyOutcome::Skipped {
            reason: "updater disabled".to_owned(),
        });
    }
    let file = settings::read_updater_file();
    let allow = settings.mode == "cc-merge" || opts.allow_cc_merge;
    let tree_conflicted = git::has_conflicts(&root).await;
    let recorded_unfinished = file.state.conflicts.is_some() || file.state.recovery.is_some();
    let resume_origin = recorded(&file.state.conflicts, "origin")
        .cloned()
        .unwrap_or_else(|| "cc-merge".into());
    let recorded_from = recorded(&file.state.conflicts, "fromSha")
        .or_else(|| recorded(&file.state.recovery, "fromSha"))
        .cloned();
    // Outside the `try`: a HEAD that can't be read escapes.
    let from_sha = match recorded_from {
        Some(v) => v,
        None => Value::String(git::head_sha(&root).await.map_err(|e| e.message)?),
    };
    let mut run = Run {
        root,
        opts,
        strategy: Strategy::Skip("resume".to_owned()),
        from_sha,
        applied_strategy: resume_origin.clone(),
        install_frozen: false,
    };
    let attempt = try_apply(
        &mut run,
        &settings,
        &file,
        tree_conflicted,
        recorded_unfinished,
        &resume_origin,
        allow,
    )
    .await;
    match attempt {
        Ok(outcome) => Ok(outcome),
        Err(thrown) => catch_apply(&run, thrown).await,
    }
}

/// The `try` block.
async fn try_apply(
    run: &mut Run,
    settings: &settings::UpdaterSettings,
    file: &settings::UpdaterFile,
    tree_conflicted: bool,
    recorded_unfinished: bool,
    resume_origin: &Value,
    allow: bool,
) -> Result<ApplyOutcome, Thrown> {
    let root = run.root.clone();
    // 1) Heal first.
    if tree_conflicted {
        if let Healed::Conflicts(outcome) =
            heal_conflicts(&root, &run.from_sha, resume_origin, allow, &run.opts).await?
        {
            return Ok(if allow {
                *outcome
            } else {
                ApplyOutcome::Skipped {
                    reason: "previous update left conflicts \u{2014} resolve them first".to_owned(),
                }
            });
        }
    } else if file.state.conflicts.is_some() {
        settings::patch_updater_state(&StatePatch {
            conflicts: Some(None),
            ..Default::default()
        })?;
    }

    // 2) Pull.
    let check = detect::check_for_updates().await.map_err(Thrown::plain)?;
    let can_finish_locally = tree_conflicted || recorded_unfinished;
    match check {
        CheckResult::Error { message } => {
            if !can_finish_locally {
                return Ok(ApplyOutcome::Error {
                    message,
                    phase: Phase::Detect,
                });
            }
        }
        CheckResult::Skipped { reason } => {
            if !can_finish_locally {
                return Ok(ApplyOutcome::Skipped { reason });
            }
        }
        CheckResult::UpToDate { .. } => {
            if !can_finish_locally {
                return Ok(ApplyOutcome::NoUpdate);
            }
        }
        CheckResult::UpdateAvailable { pending } => {
            run.from_sha = Value::String(git::head_sha(&root).await?);
            run.strategy = pick_strategy(&settings.mode, &pending, run.opts.allow_cc_merge);
            if let Strategy::Skip(reason) = &run.strategy {
                if !can_finish_locally {
                    return Ok(ApplyOutcome::Skipped {
                        reason: reason.clone(),
                    });
                }
            } else {
                let kind = run.strategy.kind();
                run.applied_strategy = kind.into();
                run.install_frozen = run.strategy == Strategy::FfOnly;
                settings::set_updater_status(settings::applying(now_ms(), kind.into()))?;
                let remote_sha = match pending.get("remoteSha") {
                    Some(Value::String(s)) => s.as_str(),
                    _ => "",
                };
                append_log(
                    &root,
                    &format!(
                        "\n=== {} apply ({kind}) from {} \u{2192} {} ===\n",
                        iso_now(),
                        slice7(&run.from_sha, "fromSha")?,
                        head16(remote_sha, 7)
                    ),
                );
                match run.strategy {
                    Strategy::FfOnly => {
                        run_fast_forward(&root, &settings.remote, &settings.branch).await?;
                    }
                    Strategy::StashFf => {
                        if let StashFf::Conflicts(detail) =
                            run_stash_fast_forward(&root, &settings.remote, &settings.branch)
                                .await?
                        {
                            append_log(
                                &root,
                                &format!("stash-ff: pop conflicts \u{2014} {detail}\n"),
                            );
                        }
                    }
                    _ => {
                        if let Err(error) =
                            run_cc_merge(&root, &pending, &settings.remote, &run.opts).await?
                        {
                            let dirty = git::is_dirty(&root).await?;
                            let moved = Value::String(git::head_sha(&root).await?) != run.from_sha;
                            if dirty && moved {
                                append_log(
                                    &root,
                                    &format!("cc-merge: left dirty \u{2014} {error}\n"),
                                );
                                let outcome = record_conflicts(
                                    &root,
                                    &run.from_sha,
                                    &"cc-merge".into(),
                                    error,
                                )
                                .await?;
                                return Ok(outcome);
                            }
                            settings::patch_updater_state(&idle_with_error(format!(
                                "Claude merge failed: {error}"
                            )))?;
                            return Ok(ApplyOutcome::Error {
                                message: error,
                                phase: Phase::Merge,
                            });
                        }
                    }
                }
            }
        }
    }

    // 3) Flagged as applying (a resume hasn't been yet).
    settings::set_updater_status(settings::applying(now_ms(), run.applied_strategy.clone()))?;

    // 4) The safety net: no conflicted tree reaches `bun install`.
    let origin: Value = if run.applied_strategy == "cc-merge" {
        "cc-merge".into()
    } else {
        "stash-ff".into()
    };
    if let Healed::Conflicts(outcome) =
        heal_conflicts(&root, &run.from_sha, &origin, allow, &run.opts).await?
    {
        return Ok(*outcome);
    }

    // 5) Install, build, restart.
    let mut install_args = vec!["install"];
    if run.install_frozen {
        install_args.push("--frozen-lockfile");
    }
    if !native_build_affected(&root, &run.from_sha).await {
        install_args.push("--ignore-scripts");
        append_log(
            &root,
            &format!(
                "install: no native dep change since {} \u{2014} skipping rebuild scripts\n",
                slice7(&run.from_sha, "fromSha")?
            ),
        );
    }
    run_streamed(
        &root,
        "bun",
        &install_args,
        Phase::Install,
        &env_for_bun_phase(Phase::Install),
    )
    .await?;
    run_streamed(
        &root,
        "bun",
        &["run", "build"],
        Phase::Build,
        &env_for_bun_phase(Phase::Build),
    )
    .await?;

    let to_sha = git::head_sha(&root).await?;
    settings::patch_updater_state(&StatePatch {
        last_update_at: Some(Some(now_ms() as f64)),
        last_update_sha: Some(Some(to_sha.clone())),
        last_error: Some(None),
        pending: Some(None),
        conflicts: Some(None),
        recovery: Some(None),
        status: Some(settings::restarting(now_ms())),
        ..Default::default()
    })?;
    append_log(
        &root,
        &format!(
            "apply ok \u{2014} restarting (was {}, now {})\n",
            slice7(&run.from_sha, "fromSha")?,
            head16(&to_sha, 7)
        ),
    );
    let restart = restart::trigger_restart().await.map_err(Thrown::plain)?;
    Ok(ApplyOutcome::Applied {
        strategy: run.applied_strategy.clone(),
        from_sha: run.from_sha.clone(),
        to_sha: Value::String(to_sha),
        restart,
    })
}

/// The `catch` block. `Err` is a throw from inside it, which escapes.
async fn catch_apply(run: &Run, thrown: Thrown) -> ApplyResult {
    let root = &run.root;
    let phase = thrown.phase.unwrap_or(Phase::Init);
    let msg = thrown.message;
    append_log(
        root,
        &format!("apply failed in {}: {msg}\n", phase.as_str()),
    );

    // Install / build failures are recoverable: the tree stays advanced.
    if matches!(phase, Phase::Install | Phase::Build) {
        let to_sha = match git::head_sha(root).await {
            Ok(s) => Value::String(s),
            Err(_) => run.from_sha.clone(),
        };
        let mut recovery = Map::new();
        recovery.insert("phase".into(), phase.as_str().into());
        recovery.insert("fromSha".into(), run.from_sha.clone());
        recovery.insert("toSha".into(), to_sha.clone());
        recovery.insert("detail".into(), Value::String(msg.clone()));
        recovery.insert("detectedAt".into(), js_num(now_ms() as f64));
        settings::patch_updater_state(&StatePatch {
            last_error: Some(Some(format!("{}: {msg}", phase.as_str()))),
            recovery: Some(Some(Value::Object(recovery))),
            status: Some(settings::idle()),
            ..Default::default()
        })
        .map_err(|e| e.message)?;
        let at = slice7(&to_sha, "toSha").map_err(|t| t.message)?;
        append_log(
            root,
            &format!(
                "{} failed \u{2014} recoverable, tree left at {at}\n",
                phase.as_str()
            ),
        );
        return Ok(ApplyOutcome::Error {
            message: msg,
            phase,
        });
    }

    // A `merge`-phase throw rolls back to `fromSha` (never stash-ff, which
    // would discard the popped-back edits). Nothing throws one today.
    let mut rolled_back = false;
    let mut attempted_rollback = false;
    if run.strategy != Strategy::StashFf && phase == Phase::Merge {
        attempted_rollback = true;
        match rollback_to(root, &run.from_sha).await {
            Ok(()) => {
                rolled_back = true;
                match slice7(&run.from_sha, "fromSha") {
                    Ok(at) => append_log(root, &format!("rolled back to {at}\n")),
                    Err(t) => append_log(root, &format!("rollback failed: {}\n", t.message)),
                }
            }
            Err(e) => append_log(root, &format!("rollback failed: {e}\n")),
        }
    }
    let last_error = if rolled_back {
        format!(
            "{}: {msg} (rolled back to {})",
            phase.as_str(),
            slice7(&run.from_sha, "fromSha").map_err(|t| t.message)?
        )
    } else {
        format!("{}: {msg}", phase.as_str())
    };
    let mut patch = idle_with_error(last_error);
    if attempted_rollback && !rolled_back {
        // HEAD may be at upstream while `pending` still says behind.
        patch.pending = Some(None);
    }
    settings::patch_updater_state(&patch).map_err(|e| e.message)?;
    Ok(ApplyOutcome::Error {
        message: msg,
        phase,
    })
}

/// `nativeBuildAffected(root, fromSha)`: whether `bun.lock`, `bun.lockb` or
/// `patches/` moved between `fromSha` and HEAD. Every non-blank line the
/// diff prints (stderr too) counts as a change, and a diff that fails or
/// can't start counts as one.
async fn native_build_affected(root: &str, from_sha: &Value) -> bool {
    let from = arg_string(from_sha);
    let mut changed = 0usize;
    let code = git::spawn_streamed(
        "git",
        &[
            "diff",
            "--name-only",
            &from,
            "HEAD",
            "--",
            "bun.lock",
            "bun.lockb",
            "patches",
        ],
        root,
        &[],
        |line, _| {
            if !js::trim(line).is_empty() {
                changed += 1;
            }
        },
    )
    .await;
    !matches!(code, Ok(0)) || changed > 0
}

/// `rollbackTo(root, sha)`: `git reset --hard <sha>`.
async fn rollback_to(root: &str, sha: &Value) -> Result<(), String> {
    let sha = arg_string(sha);
    let code = git::spawn_streamed("git", &["reset", "--hard", &sha], root, &[], |_, _| {}).await?;
    if code != 0 {
        return Err(format!("git reset --hard {sha} exited {code}"));
    }
    Ok(())
}

/// `pickStrategy(mode, pending, allowCcMergeOverride)` over the `pending`
/// a check just wrote.
pub fn pick_strategy(mode: &str, pending: &Value, allow_cc_merge_override: bool) -> Strategy {
    let wants_cc_merge = mode == "cc-merge" || allow_cc_merge_override;
    let dirty = pending.get("dirty").is_some_and(js::truthy);
    let num = |k: &str| match pending.get(k) {
        Some(Value::Number(n)) => n.as_f64(),
        _ => None,
    };
    let (ahead, behind) = (num("ahead"), num("behind"));
    let none_ahead = ahead == Some(0.0);
    let some_behind = behind.is_some_and(|b| b > 0.0);
    if !dirty && none_ahead && some_behind {
        return Strategy::FfOnly;
    }
    let dirty_only = dirty && none_ahead && some_behind;
    if dirty_only && (mode == "cc-merge" || mode == "ff-only" || allow_cc_merge_override) {
        return Strategy::StashFf;
    }
    if wants_cc_merge {
        return Strategy::CcMerge;
    }
    if mode == "ff-only" {
        return Strategy::Skip(
            if dirty {
                "working tree has uncommitted changes \u{2014} switch to cc-merge mode or apply manually"
            } else {
                "branch has diverged from upstream \u{2014} switch to cc-merge mode or apply manually"
            }
            .to_owned(),
        );
    }
    Strategy::Skip("auto-update disabled (notify-only); click 'Update now'".to_owned())
}

/// `runFastForward`: a failed pull is a `pull`-phase throw with git's
/// trimmed stderr (else the error's message).
async fn run_fast_forward(root: &str, remote: &str, branch: &str) -> Result<(), Thrown> {
    git::pull_fast_forward(root, remote, branch)
        .await
        .map_err(|e| Thrown {
            message: git_failure_text(&e),
            phase: Some(Phase::Pull),
        })
}

enum StashFf {
    Applied,
    Conflicts(String),
}

/// `runStashFastForward`: stash, pull, pop. A failed pull pops first (any
/// pop failure swallowed) and throws in `pull`; a conflicted pop is an
/// answer, not a throw.
async fn run_stash_fast_forward(root: &str, remote: &str, branch: &str) -> Result<StashFf, Thrown> {
    let stashed = git::stash_push_include_untracked(root, git::UPDATER_STASH).await?;
    if let Err(e) = git::pull_fast_forward(root, remote, branch).await {
        if stashed {
            let _ = git::stash_pop(root).await;
        }
        return Err(Thrown {
            message: git_failure_text(&e),
            phase: Some(Phase::Pull),
        });
    }
    if !stashed {
        return Ok(StashFf::Applied);
    }
    Ok(match git::stash_pop(root).await? {
        StashPop::Ok => StashFf::Applied,
        StashPop::Conflicts { output } => StashFf::Conflicts(output),
    })
}

/// `CC_MERGE_PROMPT`, verbatim.
pub const CC_MERGE_PROMPT: &str = "You are reconciling this Claudius checkout with upstream after the local branch has DIVERGED \u{2014} there are commits both upstream and locally.

Context: the updater only spawns you for true commit-level divergence. The dirty-working-tree case is handled deterministically (stash \u{2192} ff pull \u{2192} pop) elsewhere; if the pop conflicts, the user gets an interactive resolution session, not you. So you should NOT see a \"dirty tree, no local commits\" state.

Goal: bring the local working tree to a state where:
  1. The latest upstream changes from `{{remote}}/{{branch}}` are applied.
  2. Any local edits (published customizations, manual tweaks) that DON'T conflict are preserved.
  3. For real conflicts, prefer the customization intent for visible UI/behavior changes; prefer upstream for bug fixes and dependency bumps. When in doubt, keep both behaviors and resolve sensibly.
  4. `bun install` and `bun run build` will be run AFTER you finish \u{2014} your job is to leave a clean, committable tree.

Current state (already verified before invoking you):
  - HEAD is at: {{localSha}}
  - Upstream is at: {{remoteSha}}
  - Working tree dirty: {{dirty}}
  - Local branch: {{branch}}
  - Tracking: {{upstreamRef}}

Approach:
  1. Run `git status` and `git log --oneline HEAD..{{upstreamRef}} | head -30` plus `git log --oneline {{upstreamRef}}..HEAD | head -30` to see both sides of the divergence.
  2. If the tree happens to be dirty, `git stash push -u -m claudius-updater-stash` first so the merge starts clean.
  3. `git merge --no-edit {{upstreamRef}}`. Resolve any conflict markers using the goals above, `git add` resolved files, and complete the merge commit.
  4. If you stashed, `git stash pop` and resolve any remaining conflicts.
  5. End with a clean working tree at or ahead of {{upstreamRef}}.

Hard rules:
  - DO NOT `git push` anywhere.
  - DO NOT delete `.claudius/` or `.next/`.
  - DO NOT modify `.git/config` or remotes.
  - DO NOT `git reset --hard` over uncommitted local work without good reason \u{2014} leaving the dirty tree is preferable to discarding it silently.
  - If you can't safely resolve, leave the tree as-is, run `git merge --abort` (or `git stash pop` to restore), and report failure. The user will get an interactive resolution session as the fallback.
  - Bound yourself to ~10 minutes. If you can't converge, abort and report.

Report your final status as one line: either \"MERGE_OK\" if the tree is clean and HEAD includes upstream, or \"MERGE_FAIL: <one-line reason>\" if you had to abort.";

/// `CC_RESOLVE_PROMPT`, verbatim.
pub const CC_RESOLVE_PROMPT: &str = "You are resolving leftover Git conflict markers in a Claudius checkout so an in-progress self-update can finish. HEAD is ALREADY at the upstream commit \u{2014} do NOT pull, fetch, merge, or reset. Your ONLY job is to clear the conflict markers that are currently sitting in the working tree.

Conflicted files (tracked files that still contain `<<<<<<<` / `=======` / `>>>>>>>` markers):
{{files}}

These markers came from a `git stash pop` (or merge) during an automatic update. The \"Updated upstream\" / \"ours\" side is upstream; the \"Stashed changes\" / \"theirs\" side is the user's local customizations.

Goal: produce a clean, buildable tree with ZERO conflict markers.
  1. Open each conflicted file and resolve EVERY conflict region by hand.
  2. Prefer the customization intent for visible UI/behaviour changes; prefer upstream for bug fixes and dependency bumps. When unsure, keep both behaviours sensibly.
  3. For `package.json`: keep upstream's structure and version, but preserve any extra dependencies or scripts the user added. The result MUST be valid JSON (no markers, no trailing commas). For lockfiles (`bun.lock`/`bun.lockb`), prefer the upstream version wholesale \u{2014} they are regenerated by `bun install` anyway.
  4. After resolving, run `git diff --check` \u{2014} it must report NOTHING. Run `git status` to confirm there are no unmerged paths.
  5. `git add` the files you resolved so the index has no unmerged entries.

Hard rules:
  - DO NOT `git push`, `git pull`, `git fetch`, `git merge`, or `git reset --hard`.
  - DO NOT delete `.claudius/` or `.next/`.
  - DO NOT commit \u{2014} leaving the resolved customizations as uncommitted changes is correct.
  - `bun install` and `bun run build` run automatically AFTER you finish; do not run them yourself.

Report one line: \"RESOLVE_OK\" when every marker is gone and `git diff --check` is clean, or \"RESOLVE_FAIL: <one-line reason>\" if you could not.";

/// `runCcMerge(root, pending, remote)`: `Ok(Err(reason))` is a merge that
/// didn't work (never trusting the model's word: the tree must be clean
/// and HEAD must have moved); `Err` is a git call that threw.
async fn run_cc_merge(
    root: &str,
    pending: &Value,
    remote: &str,
    opts: &ApplyOptions,
) -> Result<Result<(), String>, Thrown> {
    let local_sha = git::head_sha(root).await?;
    let field = |k: &str| match pending.get(k) {
        Some(Value::String(s)) => s.clone(),
        _ => String::new(),
    };
    let dirty = if pending.get("dirty").is_some_and(js::truthy) {
        "true"
    } else {
        "false"
    };
    let mut prompt = replace_all(CC_MERGE_PROMPT, "{{localSha}}", &local_sha);
    prompt = replace_all(&prompt, "{{remoteSha}}", &field("remoteSha"));
    prompt = replace_all(&prompt, "{{dirty}}", dirty);
    prompt = replace_all(&prompt, "{{branch}}", &field("branch"));
    prompt = replace_all(&prompt, "{{remote}}", remote);
    prompt = replace_all(&prompt, "{{upstreamRef}}", &field("upstreamBranch"));

    let last_text = match run_claude_agent(root, &prompt, opts).await {
        Ok(text) => text,
        Err(e) => return Ok(Err(e)),
    };
    if git::is_dirty(root).await? {
        return Ok(Err(
            "working tree still dirty after merge attempt".to_owned()
        ));
    }
    if git::head_sha(root).await? == local_sha {
        return Ok(Err(
            "HEAD didn't move; merge aborted or made no progress".to_owned()
        ));
    }
    if last_text.contains("MERGE_FAIL") {
        return Ok(Err(last_text.split('\n').next().unwrap_or("").to_owned()));
    }
    Ok(Ok(()))
}

/// `runCcConflictResolve(root, files)`.
async fn run_cc_conflict_resolve(
    root: &str,
    files: &[String],
    opts: &ApplyOptions,
) -> Result<(), String> {
    let list = if files.is_empty() {
        "  (see `git status`)".to_owned()
    } else {
        files
            .iter()
            .map(|f| format!("  - {f}"))
            .collect::<Vec<_>>()
            .join("\n")
    };
    let prompt = replace_all(CC_RESOLVE_PROMPT, "{{files}}", &list);
    let text = run_claude_agent(root, &prompt, opts).await?;
    if text.contains("RESOLVE_FAIL") {
        return Err(text
            .split('\n')
            .find(|l| l.contains("RESOLVE_FAIL"))
            .unwrap_or("resolve failed")
            .to_owned());
    }
    Ok(())
}

/// `runClaudeAgent(root, prompt)`: one unattended single-prompt session
/// (bypass permissions, no prompts, the six tools, 40 turns), its text and
/// tool uses gisted into the log. `Ok` is the last text (the result's when
/// it has one); `Err` a non-success result or the error that ended it.
async fn run_claude_agent(root: &str, prompt: &str, opts: &ApplyOptions) -> Result<String, String> {
    let options = Options {
        cwd: Some(PathBuf::from(root)),
        permission_mode: Some("bypassPermissions".to_owned()),
        permission_prompts: Some("none".to_owned()),
        allowed_tools: ["Bash", "Read", "Edit", "Write", "Grep", "Glob"]
            .iter()
            .map(|t| (*t).to_owned())
            .collect(),
        max_turns: Some(40.0),
        path_to_claude_code_executable: opts.claude_bin.clone(),
        ..Default::default()
    };
    let mut q = Query::spawn_prompt(prompt, options)
        .await
        .map_err(|e| e.to_string())?;
    let mut last_text = String::new();
    let out = loop {
        let msg = match q.next().await {
            None => break Ok(last_text),
            Some(Err(e)) => break Err(e.to_string()),
            Some(Ok(msg)) => msg,
        };
        if msg.get("type").is_some_and(|t| t == "assistant")
            && let Err(e) = gist_blocks(root, &msg, &mut last_text)
        {
            break Err(e);
        }
        if msg.get("type").is_some_and(|t| t == "result") {
            if msg.get("subtype").is_none_or(|s| s != "success") {
                let subtype = match msg.get("subtype") {
                    None | Some(Value::Null) => Ok("unknown".to_owned()),
                    Some(v) => template(v),
                };
                break Err(match subtype {
                    Ok(s) => format!("claude returned {s}"),
                    Err(t) => t.message,
                });
            }
            if let Some(Value::String(r)) = msg.get("result") {
                last_text = r.clone();
            }
        }
    };
    q.handle().close().await;
    out
}

/// An assistant message's blocks: a text block becomes the last text and
/// its first non-blank line (160 units) a `[claude]` log line; a tool use
/// logs its name, and a Bash command (whitespace runs collapsed, 120
/// units). `Err` is the TypeError a `null` block throws.
fn gist_blocks(root: &str, msg: &Value, last_text: &mut String) -> Result<(), String> {
    let blocks = match msg.get("message") {
        Some(Value::Object(m)) => m.get("content"),
        _ => None,
    };
    let Some(Value::Array(blocks)) = blocks else {
        return Ok(());
    };
    for b in blocks {
        let b = match b {
            Value::Null => return Err("Cannot read properties of null (reading 'type')".to_owned()),
            Value::Object(b) => b,
            _ => continue,
        };
        let kind = b.get("type");
        if kind.is_some_and(|t| t == "text")
            && let Some(Value::String(text)) = b.get("text")
        {
            *last_text = text.clone();
            if let Some(gist) = text.split('\n').map(js::trim).find(|l| !l.is_empty()) {
                append_log(root, &format!("[claude] {}\n", head16(gist, 160)));
            }
        } else if kind.is_some_and(|t| t == "tool_use")
            && let Some(Value::String(name)) = b.get("name")
        {
            let command = match b.get("input") {
                Some(Value::Object(input)) => match input.get("command") {
                    Some(Value::String(c)) => Some(c),
                    _ => None,
                },
                _ => None,
            };
            let cmd = match command {
                Some(c) if name == "Bash" => format!(": {}", head16(&collapse_whitespace(c), 120)),
                _ => String::new(),
            };
            append_log(root, &format!("[claude] \u{23f5} {name}{cmd}\n"));
        }
    }
    Ok(())
}

/// `s.replace(/\s+/g, " ")`.
fn collapse_whitespace(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut in_run = false;
    for c in s.chars() {
        if js::is_whitespace(c) {
            if !in_run {
                out.push(' ');
            }
            in_run = true;
        } else {
            out.push(c);
            in_run = false;
        }
    }
    out
}

enum Healed {
    Clean,
    Conflicts(Box<ApplyOutcome>),
}

/// `healConflicts(root, fromSha, origin, allow)`: the one guard between a
/// pull and `bun install`. A tree with neither marker residue nor unmerged
/// entries is clean. Otherwise, when Claude is allowed, one inline resolve
/// session and a re-check; anything left (or not allowed) is recorded as
/// conflicts.
async fn heal_conflicts(
    root: &str,
    from_sha: &Value,
    origin: &Value,
    allow: bool,
    opts: &ApplyOptions,
) -> Result<Healed, Thrown> {
    let mut conflicted = git::conflicted_files(root).await;
    let mut unmerged = git::has_unmerged_files(root).await.unwrap_or(false);
    if conflicted.is_empty() && !unmerged {
        return Ok(Healed::Clean);
    }
    let named = |files: &[String], none: &str| {
        if files.is_empty() {
            none.to_owned()
        } else {
            files.join(", ")
        }
    };
    if allow {
        append_log(
            root,
            &format!(
                "conflict markers in [{}] \u{2014} resolving with Claude inline\n",
                named(&conflicted, "index")
            ),
        );
        let res = run_cc_conflict_resolve(root, &conflicted, opts).await;
        conflicted = git::conflicted_files(root).await;
        unmerged = git::has_unmerged_files(root).await.unwrap_or(true);
        if res.is_ok() && conflicted.is_empty() && !unmerged {
            append_log(
                root,
                "inline conflict resolution succeeded \u{2014} tree clean\n",
            );
            return Ok(Healed::Clean);
        }
        let detail = match res {
            Ok(()) => format!(
                "conflict markers still present after resolution in {}",
                named(&conflicted, "the index")
            ),
            Err(e) => e,
        };
        return record_conflicts(root, from_sha, origin, detail)
            .await
            .map(|o| Healed::Conflicts(Box::new(o)));
    }
    let detail = if conflicted.is_empty() {
        "unmerged files in index".to_owned()
    } else {
        format!("unresolved conflict markers in {}", conflicted.join(", "))
    };
    record_conflicts(root, from_sha, origin, detail)
        .await
        .map(|o| Healed::Conflicts(Box::new(o)))
}

/// `recordConflicts(root, fromSha, origin, detail)`.
async fn record_conflicts(
    root: &str,
    from_sha: &Value,
    origin: &Value,
    detail: String,
) -> Result<ApplyOutcome, Thrown> {
    let to_sha = match git::head_sha(root).await {
        Ok(s) => Value::String(s),
        Err(_) => from_sha.clone(),
    };
    let mut conflicts = Map::new();
    conflicts.insert("fromSha".into(), from_sha.clone());
    conflicts.insert("toSha".into(), to_sha.clone());
    conflicts.insert("detectedAt".into(), js_num(now_ms() as f64));
    conflicts.insert("origin".into(), origin.clone());
    conflicts.insert("detail".into(), Value::String(detail.clone()));
    settings::patch_updater_state(&StatePatch {
        last_error: Some(Some(format!("merge: {detail}"))),
        conflicts: Some(Some(Value::Object(conflicts))),
        status: Some(settings::idle()),
        ..Default::default()
    })?;
    append_log(
        root,
        &format!(
            "conflicts recorded ({}) \u{2014} {detail}\n",
            template(origin)?
        ),
    );
    Ok(ApplyOutcome::Conflicts {
        origin: origin.clone(),
        from_sha: from_sha.clone(),
        to_sha,
        detail,
    })
}

/// `ERR_TAIL_LINES`.
const ERR_TAIL_LINES: usize = 15;
/// `ERR_TAIL_MAX_LINE`, in UTF-16 units.
const ERR_TAIL_MAX_LINE: usize = 400;

/// `SCRUBBED_NEXT_BUILD_ENV`.
pub const SCRUBBED_NEXT_BUILD_ENV: [&str; 4] = [
    "__NEXT_PRIVATE_STANDALONE_CONFIG",
    "__NEXT_PRIVATE_ORIGIN",
    "TURBOPACK",
    "NEXT_DEPLOYMENT_ID",
];

/// `envForBunPhase(phase)`: `NODE_ENV` (`development` to install, so dev
/// dependencies come along; `production` to build), and the four Next
/// variables a standalone parent leaks deleted (`None`).
pub fn env_for_bun_phase(phase: Phase) -> Vec<(&'static str, Option<&'static str>)> {
    let node_env = if phase == Phase::Install {
        "development"
    } else {
        "production"
    };
    std::iter::once(("NODE_ENV", Some(node_env)))
        .chain(SCRUBBED_NEXT_BUILD_ENV.iter().map(|k| (*k, None)))
        .collect()
}

/// `runStreamed(root, cmd, args, phase, env)`: every line into the log as
/// `[<phase>/<out|err>] <line>`; a spawn failure (with the bun-not-on-PATH
/// hint for an ENOENT) or a non-zero exit (`<cmd> <args> exited with code
/// N`, then the last 15 non-blank stderr lines, each cut at 400 units) is
/// a throw in `phase`.
async fn run_streamed(
    root: &str,
    cmd: &str,
    args: &[&str],
    phase: Phase,
    env: &[(&str, Option<&str>)],
) -> Result<(), Thrown> {
    let mut err_tail: VecDeque<String> = VecDeque::new();
    let code = git::spawn_streamed(cmd, args, root, env, |line, stream| {
        append_log(
            root,
            &format!("[{}/{}] {line}\n", phase.as_str(), stream.as_str()),
        );
        if stream == Stream::Err && !js::trim(line).is_empty() {
            let kept = if js_string::len16(line) > ERR_TAIL_MAX_LINE {
                format!("{}\u{2026}", head16(line, ERR_TAIL_MAX_LINE))
            } else {
                line.to_owned()
            };
            err_tail.push_back(kept);
            if err_tail.len() > ERR_TAIL_LINES {
                err_tail.pop_front();
            }
        }
    })
    .await;
    let code = match code {
        Ok(code) => code,
        Err(raw) => {
            let hint = if raw.contains("ENOENT") && cmd == "bun" {
                " \u{2014} bun was not found on PATH. Install bun (https://bun.com) or symlink it into /usr/local/bin so the daemon process can find it."
            } else {
                ""
            };
            return Err(Thrown {
                message: format!("{raw}{hint}"),
                phase: Some(phase),
            });
        }
    };
    if code != 0 {
        let head = format!("{cmd} {} exited with code {code}", args.join(" "));
        let detail = if err_tail.is_empty() {
            String::new()
        } else {
            format!("\n{}", Vec::from(err_tail).join("\n"))
        };
        return Err(Thrown {
            message: format!("{head}{detail}"),
            phase: Some(phase),
        });
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn slice7_follows_js() {
        assert_eq!(slice7(&json!("0123456789"), "fromSha").unwrap(), "0123456");
        assert_eq!(slice7(&json!("abc"), "fromSha").unwrap(), "abc");
        assert_eq!(
            slice7(&json!(["a", null, 1, "b", "c", "d", "e", "f"]), "fromSha").unwrap(),
            "a,,1,b,c,d,e"
        );
        assert_eq!(
            slice7(&json!(5), "fromSha").unwrap_err().message,
            "fromSha.slice is not a function"
        );
        assert_eq!(
            slice7(&json!({"slice": 1}), "toSha").unwrap_err().message,
            "toSha.slice is not a function"
        );
        assert_eq!(
            slice7(&json!([{"toString": 1}]), "fromSha")
                .unwrap_err()
                .message,
            "Cannot convert object to primitive value"
        );
        // A cut surrogate pair keeps the lone high half.
        let s = format!("abcdef{}", '\u{1F600}');
        assert_eq!(js_string::units(&slice7(&json!(s), "x").unwrap()), {
            let mut u: Vec<u16> = "abcdef".encode_utf16().collect();
            u.push(0xD83D);
            u
        });
    }

    #[test]
    fn whitespace_runs_collapse_like_js() {
        assert_eq!(collapse_whitespace("a \t\n b\u{2028}\u{feff}c"), "a b c");
        assert_eq!(collapse_whitespace("  x  "), " x ");
        assert_eq!(collapse_whitespace("a\u{85}b"), "a\u{85}b");
    }

    #[test]
    fn bun_env_scrubs_next_leaks() {
        assert_eq!(
            env_for_bun_phase(Phase::Install)[0],
            ("NODE_ENV", Some("development"))
        );
        assert_eq!(
            env_for_bun_phase(Phase::Build)[0],
            ("NODE_ENV", Some("production"))
        );
        assert_eq!(env_for_bun_phase(Phase::Build).len(), 5);
        assert!(
            env_for_bun_phase(Phase::Build)[1..]
                .iter()
                .all(|(_, v)| v.is_none())
        );
    }
}
