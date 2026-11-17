//! `claudius` — the Rust backend's HTTP front door.
//!
//! Serves the ported API (`/api/sessions/**`, `/api/rust/health`) and
//! reverse-proxies everything else — pages, assets, HMR websocket, and the
//! not-yet-ported API routes — to the Next.js server, so the existing React
//! UI runs unchanged on top of the Rust session engine.
//!
//! ```text
//! claudius --port 3100 --next http://127.0.0.1:3000
//! ```
//!
//! It also runs Claudius's scheduled jobs (`claudius_core::scheduler`),
//! which is the default since G07d. `--no-scheduler`, or
//! `CLAUDIUS_SCHEDULER=0|false|no|off`, turns that off; `--scheduler` forces
//! it on. Two schedulers on one `jobs.json` would run every job twice, so
//! the Next behind this front door must be started with
//! `CLAUDIUS_RUST_SCHEDULER=1`, which makes `lib/server/scheduler.ts` skip
//! its own boot and arm no timers.

use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::Arc;

use claudius_core::scheduler::{self, RunnerOptions};
use claudius_core::session::RuntimeOptions;
use claudius_core::session_manager::session_manager;
use claudius_server::{AppState, app, proxy};

struct Args {
    host: String,
    port: u16,
    next: Option<String>,
    claude_bin: Option<PathBuf>,
    scheduler: bool,
    boot_tasks: bool,
}

/// `CLAUDIUS_BOOT_TASKS`: `1` / `true` / `yes` / `on` (trimmed, any case)
/// runs `instrumentation.ts`'s boot tasks here; anything else, or unset,
/// leaves them to Next.
fn boot_tasks_by_env(raw: Option<&str>) -> bool {
    raw.map(|v| claudius_agent::js::trim(v).to_ascii_lowercase())
        .is_some_and(|v| matches!(v.as_str(), "1" | "true" | "yes" | "on"))
}

fn parse_args() -> anyhow::Result<Args> {
    let mut a = Args {
        host: std::env::var("CLAUDIUS_RS_HOST").unwrap_or_else(|_| "127.0.0.1".into()),
        port: std::env::var("CLAUDIUS_RS_PORT")
            .ok()
            .and_then(|p| p.parse().ok())
            .unwrap_or(3100),
        next: Some(
            std::env::var("CLAUDIUS_NEXT_URL").unwrap_or_else(|_| "http://127.0.0.1:3000".into()),
        ),
        claude_bin: std::env::var_os(claudius_agent::binary::ENV_OVERRIDE).map(PathBuf::from),
        scheduler: scheduler::enabled_by_env(std::env::var("CLAUDIUS_SCHEDULER").ok().as_deref()),
        boot_tasks: boot_tasks_by_env(std::env::var("CLAUDIUS_BOOT_TASKS").ok().as_deref()),
    };
    let mut it = std::env::args().skip(1);
    while let Some(arg) = it.next() {
        let mut val = |name: &str| {
            it.next()
                .ok_or_else(|| anyhow::anyhow!("{name} needs a value"))
        };
        match arg.as_str() {
            "--host" => a.host = val("--host")?,
            "--port" | "-p" => a.port = val("--port")?.parse()?,
            "--next" => a.next = Some(val("--next")?),
            "--no-next" => a.next = None,
            "--claude-bin" => a.claude_bin = Some(PathBuf::from(val("--claude-bin")?)),
            "--scheduler" => a.scheduler = true,
            "--no-scheduler" => a.scheduler = false,
            "--boot-tasks" => a.boot_tasks = true,
            "--no-boot-tasks" => a.boot_tasks = false,
            "-h" | "--help" => {
                println!(
                    "claudius [--host 127.0.0.1] [--port 3100] [--next http://127.0.0.1:3000 | --no-next] [--claude-bin PATH] [--no-scheduler] [--boot-tasks]"
                );
                std::process::exit(0);
            }
            other => anyhow::bail!("unknown argument: {other}"),
        }
    }
    Ok(a)
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    claudius_server::logging::init();
    let args = parse_args()?;
    // Pin Claudius's own state (~/.claude/.claudius, per-project DBs) to a
    // different home while the spawned CLI keeps the real $HOME — e.g. an
    // isolated test world that still uses the user's Claude login. The CLI's
    // session JSONL then still lands in the real config dir, so read it there.
    if let Some(state_home) = std::env::var_os("CLAUDIUS_STATE_HOME").filter(|v| !v.is_empty()) {
        let real_config = claudius_core::paths::claude_config_dir();
        claudius_core::paths::set_home_override(PathBuf::from(state_home));
        claudius_core::paths::set_config_dir_override(real_config);
    }
    let mgr = session_manager().clone();
    if args.claude_bin.is_some() {
        *mgr.runtime.lock().unwrap() = RuntimeOptions {
            claude_bin: args.claude_bin.clone(),
            env_override: None,
        };
    }
    // TS boots it from `instrumentation.ts`; here unless told not to (see
    // the module doc). Booted before the listener, so a health check
    // implies it.
    scheduler::set_enabled(args.scheduler);
    if args.scheduler {
        let sched = scheduler::scheduler();
        sched.set_runner(RunnerOptions {
            claude_bin: args.claude_bin.clone(),
            env: None,
        });
        // Finished runs and a missing folder reach the notification inbox.
        sched.set_on_run_finished(Some(Arc::new(scheduler::record_on_bus)));
        match sched.boot() {
            Ok(()) => tracing::info!("scheduler on: jobs in {}", sched.store().root().display()),
            Err(e) => tracing::error!(
                target: claudius_core::log::SCHEDULER,
                "[scheduler] boot failed: {e}"
            ),
        }
    }
    // `instrumentation.ts`'s boot tasks after the scheduler (G12): the
    // customization upgrade check (auto-revert stale publishes), the
    // workspace reconcile, then `updaterScheduler.boot()`. Next runs them
    // itself while it serves beside this binary; two upgrade checks would
    // race on the same publishes and two updaters on one tree would stash it
    // twice, so they're off unless asked for (`--boot-tasks` /
    // `CLAUDIUS_BOOT_TASKS=1`) until Rust serves alone (N section). Awaited
    // before the listener, as Next awaits `register()`, so a health check
    // implies they ran.
    if args.boot_tasks {
        match claudius_core::customizations_startup::run_customizations_startup().await {
            Ok(()) => {
                // Its own gates: `CLAUDIUS_UPDATER_DISABLED=1` and a preview
                // running inside a customization mirror. The first tick is
                // 5 s out, on a tokio task.
                let updater = claudius_core::updater::scheduler::updater_scheduler();
                updater.set_apply_options(claudius_core::updater::apply::ApplyOptions {
                    claude_bin: mgr.runtime.lock().unwrap().claude_bin.clone(),
                    ..Default::default()
                });
                updater.boot();
            }
            // `register()` rejects at the first failed `await`, so the TS
            // skips the reconcile and the updater boot with it.
            Err(e) => tracing::warn!(
                target: claudius_core::log::API,
                "[customizations] boot tasks failed: {e:#}"
            ),
        }
    }
    let proxy = args
        .next
        .as_deref()
        .map(proxy::Proxy::new)
        .transpose()?
        .map(Arc::new);
    let addr: SocketAddr = format!("{}:{}", args.host, args.port).parse()?;
    let listener = tokio::net::TcpListener::bind(addr).await?;
    claudius_core::preview_server::reserve_port(listener.local_addr()?.port());
    tracing::info!(
        "claudius (rust) listening on http://{addr}{}",
        proxy
            .as_ref()
            .map(|p| format!(" — proxying unported routes to {}", p.base()))
            .unwrap_or_default()
    );
    let dev_routes = claudius_server::dev::dev_routes_from_env();
    if dev_routes {
        tracing::info!("dev-only test routes (dev-*) enabled");
    }
    let state = AppState::new(mgr.clone(), proxy, dev_routes);
    let (stop_http, http_stopped) = tokio::sync::oneshot::channel::<()>();
    let server = axum::serve(listener, app(state)).with_graceful_shutdown(async {
        let _ = http_stopped.await;
    });
    let mut server = tokio::spawn(server.into_future());
    tokio::select! {
        res = &mut server => return res?.map_err(Into::into),
        sig = shutdown_signal() => tracing::info!("{sig}: shutting down"),
    }
    // As a TS host's exit SIGTERMs its CLIs at once: from here on a closed
    // CLI gets SIGTERM without the 2 s close grace, SIGKILL 2 s later.
    claudius_agent::begin_exit();
    if args.scheduler {
        scheduler::scheduler().shutdown().await;
    }
    // Customization previews (`next dev` children) don't outlive the server.
    claudius_core::preview_server::shutdown().await;
    // End every session first, concurrently: each waits for its CLI to exit
    // (SIGTERM at once → SIGKILL after the exit's kill grace), so no child
    // is orphaned.
    let ids: Vec<String> = mgr.list().into_iter().map(|s| s.id.clone()).collect();
    futures::future::join_all(ids.iter().map(|id| mgr.remove(id))).await;
    // Then stop HTTP. Open SSE streams never finish on their own, so don't let
    // graceful shutdown wait on them forever.
    let _ = stop_http.send(());
    if tokio::time::timeout(std::time::Duration::from_secs(3), &mut server)
        .await
        .is_err()
    {
        tracing::info!("open connections after 3s; exiting anyway");
    }
    Ok(())
}

/// SIGINT (Ctrl-C) or, on unix, SIGTERM — what the Electron shell and process
/// managers send.
async fn shutdown_signal() -> &'static str {
    #[cfg(unix)]
    {
        let mut term = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
            .expect("install SIGTERM handler");
        tokio::select! {
            _ = tokio::signal::ctrl_c() => "SIGINT",
            _ = term.recv() => "SIGTERM",
        }
    }
    #[cfg(not(unix))]
    {
        let _ = tokio::signal::ctrl_c().await;
        "Ctrl-C"
    }
}

#[cfg(test)]
mod tests {
    use super::boot_tasks_by_env;

    #[test]
    fn boot_tasks_env_is_opt_in() {
        for on in ["1", "true", "TRUE", " yes ", "On"] {
            assert!(boot_tasks_by_env(Some(on)), "{on:?}");
        }
        for off in [
            None,
            Some(""),
            Some("0"),
            Some("false"),
            Some("no"),
            Some("off"),
            Some("2"),
        ] {
            assert!(!boot_tasks_by_env(off), "{off:?}");
        }
    }
}
