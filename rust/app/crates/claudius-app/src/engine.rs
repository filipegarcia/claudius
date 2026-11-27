//! Where the shell's data comes from (U04b): the engine in this process
//! (the default), or a `claudius` server elsewhere.
//!
//! [`Engine::start`] does what `claudius-server`'s `main` does before it
//! listens, minus the listener and the Next proxy: the process-wide session
//! manager with the CLI to spawn, the scheduler when asked for, and the
//! server's [`AppState`]. Every request then goes through the server's own
//! router in-process ([`InProcessTransport`]), so the routes answer as they
//! do over HTTP. The per-project databases migrate when a route first opens
//! them, as in the server. What stays off:
//!
//! - **The updater.** `main` boots it only with `--boot-tasks` (with the
//!   customization upgrade check and the workspace reconcile), which the
//!   app never runs: an updater can stash the work tree it runs from.
//! - **The scheduler**, unless `CLAUDIUS_APP_SCHEDULER` is truthy (`1`,
//!   `true`, `yes`, `on`). The server runs it by default; two schedulers on
//!   one `jobs.json` (the desktop app's and this one) would run every job
//!   twice, so the app opts in.
//! - Dev routes, the Next proxy (`/api/**` the server doesn't port answers
//!   404 here), the listener and `preview_server::reserve_port`.
//!
//! [`Backend::Remote`] talks to a running server over HTTP instead
//! (`CLAUDIUS_APP_REMOTE=http://host:port`). That server checks no token,
//! Origin or Host (TODO U02e), which the app prints when it starts.
//!
//! Everything engine-side runs on a multi-thread tokio runtime the backend
//! owns; the GPUI side awaits its results (a tokio `JoinHandle` is
//! executor-agnostic).

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use claudius_core::scheduler::{self, RunnerOptions};
use claudius_core::session::RuntimeOptions;
use claudius_core::session_manager::session_manager;
use claudius_server::AppState;
use claudius_transport::{CookieJar, InProcessTransport, RemoteTransport, Transport};

/// What the in-process engine runs with.
#[derive(Clone, Debug, Default)]
pub struct EngineOptions {
    /// The `claude` to spawn (`CLAUDIUS_CLAUDE_BIN`, as the server reads
    /// it); `None`: the SDK's lookup.
    pub claude_bin: Option<PathBuf>,
    /// The CLI's whole environment, in place of this process's (tests).
    pub env_override: Option<HashMap<String, String>>,
    /// Run scheduled jobs here.
    pub scheduler: bool,
}

impl EngineOptions {
    /// From the environment: `CLAUDIUS_CLAUDE_BIN` and
    /// `CLAUDIUS_APP_SCHEDULER` (see the module docs).
    pub fn from_env() -> Self {
        EngineOptions {
            claude_bin: std::env::var_os(claudius_agent::binary::ENV_OVERRIDE)
                .filter(|v| !v.is_empty())
                .map(PathBuf::from),
            env_override: None,
            scheduler: scheduler_opt_in(std::env::var("CLAUDIUS_APP_SCHEDULER").ok().as_deref()),
        }
    }
}

/// `CLAUDIUS_APP_SCHEDULER`: on only when `1` / `true` / `yes` / `on`
/// (trimmed, any case).
pub fn scheduler_opt_in(raw: Option<&str>) -> bool {
    raw.map(|v| claudius_agent::js::trim(v).to_ascii_lowercase())
        .is_some_and(|v| matches!(v.as_str(), "1" | "true" | "yes" | "on"))
}

/// The server's state in this process. One per process: the session
/// manager and the scheduler are process-wide, as in the server.
pub struct Engine {
    state: AppState,
    scheduler: bool,
}

impl Engine {
    /// Sets up the engine on `rt` (see the module docs).
    pub fn start(opts: EngineOptions, rt: &tokio::runtime::Handle) -> Self {
        let _guard = rt.enter();
        let mgr = session_manager().clone();
        if opts.claude_bin.is_some() || opts.env_override.is_some() {
            *mgr.runtime.lock().expect("runtime lock") = RuntimeOptions {
                claude_bin: opts.claude_bin.clone(),
                env_override: opts.env_override.clone(),
            };
        }
        scheduler::set_enabled(opts.scheduler);
        if opts.scheduler {
            let sched = scheduler::scheduler();
            sched.set_runner(RunnerOptions {
                claude_bin: opts.claude_bin.clone(),
                env: opts.env_override.clone(),
            });
            sched.set_on_run_finished(Some(Arc::new(scheduler::record_on_bus)));
            if let Err(e) = sched.boot() {
                eprintln!("claudius-app: [scheduler] boot failed: {e}");
            }
        }
        Engine {
            state: AppState::new(mgr, None, false),
            scheduler: opts.scheduler,
        }
    }

    pub fn state(&self) -> &AppState {
        &self.state
    }

    /// What `main` does on SIGTERM: CLIs get SIGTERM at once, the scheduler
    /// and the previews stop, and every session ends (each waits for its
    /// CLI to exit).
    pub async fn shutdown(&self) {
        claudius_agent::begin_exit();
        if self.scheduler {
            scheduler::scheduler().shutdown().await;
        }
        claudius_core::preview_server::shutdown().await;
        let mgr = &self.state.mgr;
        let ids: Vec<String> = mgr.list().into_iter().map(|s| s.id.clone()).collect();
        futures::future::join_all(ids.iter().map(|id| mgr.remove(id))).await;
    }
}

/// The shell's backend: the runtime, and where requests go.
pub struct Backend {
    rt: Arc<tokio::runtime::Runtime>,
    kind: Kind,
}

enum Kind {
    InProcess(Arc<Engine>),
    Remote(String),
}

impl Backend {
    /// The engine in this process, on a new runtime.
    pub fn in_process(opts: EngineOptions) -> anyhow::Result<Backend> {
        let rt = Arc::new(runtime()?);
        let engine = Arc::new(Engine::start(opts, rt.handle()));
        Ok(Backend {
            rt,
            kind: Kind::InProcess(engine),
        })
    }

    /// A server at `origin` (`http://host:port`), on a new runtime.
    pub fn remote(origin: &str) -> anyhow::Result<Backend> {
        // Checked now, so a bad origin fails at start, not at each request.
        RemoteTransport::new(origin).map_err(|e| anyhow::anyhow!("{e}"))?;
        Ok(Backend {
            rt: Arc::new(runtime()?),
            kind: Kind::Remote(origin.to_owned()),
        })
    }

    /// The runtime everything engine-side runs on.
    pub fn handle(&self) -> tokio::runtime::Handle {
        self.rt.handle().clone()
    }

    /// The in-process engine, if this is one.
    pub fn engine(&self) -> Option<&Arc<Engine>> {
        match &self.kind {
            Kind::InProcess(e) => Some(e),
            Kind::Remote(_) => None,
        }
    }

    /// A transport with its own cookies: one "page" (the shell's front
    /// door, or one workspace's chat).
    pub fn transport(&self, jar: Arc<CookieJar>) -> Arc<dyn Transport> {
        match &self.kind {
            Kind::InProcess(e) => {
                Arc::new(InProcessTransport::new(e.state().clone()).with_cookie_jar(jar))
            }
            Kind::Remote(origin) => Arc::new(
                RemoteTransport::new(origin)
                    .expect("checked in Backend::remote")
                    .with_cookie_jar(jar),
            ),
        }
    }

    /// Ends the engine's sessions (in-process), waiting up to `limit`.
    pub fn shutdown(&self, limit: Duration) {
        if let Some(engine) = self.engine().cloned() {
            let done = self.rt.spawn(async move { engine.shutdown().await });
            let _ = self
                .rt
                .block_on(async { tokio::time::timeout(limit, done).await });
        }
    }
}

fn runtime() -> anyhow::Result<tokio::runtime::Runtime> {
    Ok(tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .thread_name("claudius-engine")
        .build()?)
}

#[cfg(test)]
mod tests {
    use super::scheduler_opt_in;

    #[test]
    fn the_scheduler_is_opt_in() {
        for on in ["1", "true", "TRUE", " yes ", "On"] {
            assert!(scheduler_opt_in(Some(on)), "{on:?}");
        }
        for off in [
            None,
            Some(""),
            Some("0"),
            Some("off"),
            Some("2"),
            Some("no"),
        ] {
            assert!(!scheduler_opt_in(off), "{off:?}");
        }
    }
}
