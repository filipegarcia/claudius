//! `lib/server/updater/restart.ts`: what a successful apply does to the
//! running process.
//!
//! * Daemon mode (a PID file, see [`root::runtime_mode`]): spawn a detached
//!   `bash -c <script>` (under `setsid` when the shell finds one, else
//!   `nohup`) that waits for this pid to go away and then runs
//!   `bin/claudiusd up` (or `restart` after 30 s), and send ourselves
//!   SIGTERM 1.5 s later, so the HTTP answer goes out first.
//! * Anything else: nothing runs; the answer asks for a manual restart.
//!
//! The spawn and the signal go through a [`RestartBoundary`]. The default
//! is [`ProcessBoundary`], which really does both; [`RecordingBoundary`]
//! writes what would have run to a file instead (the server's dev mode and
//! the tests use it, see [`set_boundary`]).

use std::io::Write;
use std::sync::{Arc, RwLock};

use serde_json::{Map, Value, json};

use crate::updater::{root, spawn_env};
use crate::{log, node_fs, node_path};

/// What [`trigger_restart`] did (`RestartResult`).
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum RestartResult {
    /// `{ kind: "scheduled", mode: "daemon", pid }`.
    Scheduled { pid: u32 },
    /// `{ kind: "manual", mode: "dev", reason }`.
    Manual,
}

/// The manual restart's `reason`.
pub const MANUAL_REASON: &str =
    "running in dev mode \u{2014} Ctrl-C and re-run `claudius` to pick up the update";

/// `SELF_EXIT_DELAY_MS`.
pub const SELF_EXIT_DELAY_MS: u64 = 1500;

impl RestartResult {
    /// The result as the apply answers it.
    pub fn to_json(&self) -> Value {
        let mut m = Map::new();
        match self {
            RestartResult::Scheduled { pid } => {
                m.insert("kind".into(), "scheduled".into());
                m.insert("mode".into(), "daemon".into());
                m.insert("pid".into(), Value::from(*pid));
            }
            RestartResult::Manual => {
                m.insert("kind".into(), "manual".into());
                m.insert("mode".into(), "dev".into());
                m.insert("reason".into(), MANUAL_REASON.into());
            }
        }
        Value::Object(m)
    }
}

/// The detached restarter: `spawn(program, args, {detached: true, stdio:
/// "ignore", env: {...process.env, PATH: path}})`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RestartPlan {
    /// `setsid` or `nohup`.
    pub program: String,
    /// `["bash", "-c", <script>]`.
    pub args: Vec<String>,
    /// `extendedPath(process.env.PATH)`.
    pub path: String,
}

impl RestartPlan {
    /// The plan as [`RecordingBoundary`] writes it.
    pub fn to_json(&self) -> Value {
        json!({
            "spawn": {
                "program": self.program,
                "args": self.args,
                "detached": true,
                "stdio": "ignore",
                "PATH": self.path,
            }
        })
    }
}

/// Where the restart leaves this process.
pub trait RestartBoundary: Send + Sync {
    /// Start the detached restarter and forget it (`child.unref()`).
    fn spawn_detached(&self, plan: &RestartPlan) -> std::io::Result<()>;
    /// `setTimeout(() => process.kill(process.pid, "SIGTERM"), delay_ms)`.
    fn schedule_self_exit(&self, delay_ms: u64);
}

/// The real thing.
pub struct ProcessBoundary;

impl RestartBoundary for ProcessBoundary {
    fn spawn_detached(&self, plan: &RestartPlan) -> std::io::Result<()> {
        let mut cmd = std::process::Command::new(&plan.program);
        cmd.args(&plan.args)
            .env("PATH", &plan.path)
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null());
        #[cfg(unix)]
        {
            use std::os::unix::process::CommandExt;
            // `detached: true`: the child leads a new session. The hook
            // makes this a fork (see `prepare_fork`).
            claudius_agent::prepare_fork();
            // SAFETY: `setsid` is async-signal-safe.
            unsafe {
                cmd.pre_exec(|| {
                    libc::setsid();
                    Ok(())
                });
            }
        }
        let mut child = cmd.spawn()?;
        // Reap it if it ever exits while we're still here.
        std::thread::spawn(move || {
            let _ = child.wait();
        });
        Ok(())
    }

    fn schedule_self_exit(&self, delay_ms: u64) {
        std::thread::spawn(move || {
            std::thread::sleep(std::time::Duration::from_millis(delay_ms));
            #[cfg(unix)]
            // SAFETY: signalling our own pid.
            let sent = unsafe { libc::kill(libc::getpid(), libc::SIGTERM) } == 0;
            #[cfg(not(unix))]
            let sent = false;
            if !sent {
                std::process::exit(0);
            }
        });
    }
}

/// A boundary that runs nothing and appends one JSON line per call to
/// `path`: the [`RestartPlan::to_json`] of a spawn, and `{"selfExit":
/// {"delayMs", "signal": "SIGTERM"}}`.
pub struct RecordingBoundary {
    pub path: std::path::PathBuf,
}

impl RecordingBoundary {
    fn record(&self, v: &Value) -> std::io::Result<()> {
        let mut f = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&self.path)?;
        f.write_all(format!("{v}\n").as_bytes())
    }
}

impl RestartBoundary for RecordingBoundary {
    fn spawn_detached(&self, plan: &RestartPlan) -> std::io::Result<()> {
        self.record(&plan.to_json())
    }

    fn schedule_self_exit(&self, delay_ms: u64) {
        let _ = self.record(&json!({"selfExit": {"delayMs": delay_ms, "signal": "SIGTERM"}}));
    }
}

static BOUNDARY: RwLock<Option<Arc<dyn RestartBoundary>>> = RwLock::new(None);

/// Replace the process's boundary (`None`: back to [`ProcessBoundary`]).
pub fn set_boundary(boundary: Option<Arc<dyn RestartBoundary>>) {
    *BOUNDARY.write().expect("restart boundary") = boundary;
}

fn boundary() -> Arc<dyn RestartBoundary> {
    BOUNDARY
        .read()
        .expect("restart boundary")
        .clone()
        .unwrap_or_else(|| Arc::new(ProcessBoundary))
}

/// `triggerRestart()`. `Err` is what it throws: no `bin/claudiusd`, or the
/// log folder that can't be made (Node's `mkdir` message).
pub async fn trigger_restart() -> Result<RestartResult, String> {
    if root::runtime_mode() != "daemon" {
        return Ok(RestartResult::Manual);
    }
    let pid = std::process::id();
    spawn_restarter(pid).await?;
    boundary().schedule_self_exit(SELF_EXIT_DELAY_MS);
    Ok(RestartResult::Scheduled { pid })
}

/// `shellQuote(s)`: single quotes, each `'` as `'\''`.
pub fn shell_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', "'\\''"))
}

/// The restarter's script, as `spawnRestarter` writes it.
pub fn restarter_script(parent_pid: u32, log: &str, claudiusd: &str) -> String {
    let (log, claudiusd) = (shell_quote(log), shell_quote(claudiusd));
    format!(
        "#!/usr/bin/env bash
# claudius updater \u{2014} detached restarter (parent pid {parent_pid})
set -u
LOG={log}
{{
  echo \"\"
  echo \"[updater] $(date) waiting for parent pid {parent_pid} to exit\"
  for i in $(seq 1 60); do
    kill -0 {parent_pid} 2>/dev/null || break
    sleep 0.5
  done
  if kill -0 {parent_pid} 2>/dev/null; then
    echo \"[updater] $(date) parent still alive after 30s \u{2014} forcing claudiusd restart\"
    {claudiusd} restart >>\"$LOG\" 2>&1
  else
    echo \"[updater] $(date) parent gone \u{2014} running claudiusd up\"
    {claudiusd} up >>\"$LOG\" 2>&1
  fi
}} >>\"$LOG\" 2>&1
"
    )
}

/// `spawnRestarter(parentPid)`.
async fn spawn_restarter(parent_pid: u32) -> Result<(), String> {
    let claudiusd = root::claudiusd_path();
    // `existsSync`: through links, any kind of file.
    if std::fs::metadata(&claudiusd).is_err() {
        return Err(format!("claudiusd not found at {claudiusd}"));
    }
    let log = root::daemon_log_file();
    node_fs::mkdir_recursive(&node_path::dirname(&log), 0o777).map_err(|e| e.message)?;
    let plan = RestartPlan {
        program: if has_cmd("setsid").await {
            "setsid"
        } else {
            "nohup"
        }
        .to_owned(),
        args: vec![
            "bash".to_owned(),
            "-c".to_owned(),
            restarter_script(parent_pid, &log, &claudiusd),
        ],
        path: spawn_env::process_extended_path(),
    };
    // TS has no `error` listener: a failed spawn takes the process down,
    // which the self-exit below does here.
    if let Err(e) = boundary().spawn_detached(&plan) {
        tracing::warn!(target: log::API, "[updater] restarter failed to start: {e}");
    }
    Ok(())
}

/// `hasCmd(cmd)`: `command -v <cmd>` in `/bin/sh` (`shell: true`), with
/// this process's env, exits 0.
async fn has_cmd(cmd: &str) -> bool {
    tokio::process::Command::new("/bin/sh")
        .args(["-c", &format!("command -v {cmd}")])
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
        .await
        .is_ok_and(|s| s.success())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn shell_quote_escapes_single_quotes() {
        assert_eq!(shell_quote("a b"), "'a b'");
        assert_eq!(shell_quote("it's"), "'it'\\''s'");
        assert_eq!(shell_quote(""), "''");
    }

    #[test]
    fn the_process_boundary_starts_a_session_leader_with_the_plan_path() {
        let dir = tempfile::tempdir().unwrap();
        let out = dir.path().join("out");
        let plan = RestartPlan {
            program: "/bin/sh".to_owned(),
            args: vec![
                "-c".to_owned(),
                format!(
                    "printf '%s %s %s' \"$$\" \"$(ps -o pgid= -p $$ | tr -d ' ')\" \"$PATH\" > {0}.tmp; mv {0}.tmp {0}",
                    out.display()
                ),
            ],
            path: "/usr/bin:/bin:/plan/path".to_owned(),
        };
        ProcessBoundary.spawn_detached(&plan).unwrap();
        let start = std::time::Instant::now();
        while !out.exists() {
            assert!(
                start.elapsed() < std::time::Duration::from_secs(20),
                "no output"
            );
            std::thread::sleep(std::time::Duration::from_millis(20));
        }
        let text = std::fs::read_to_string(&out).unwrap();
        let parts: Vec<&str> = text.splitn(3, ' ').collect();
        assert_eq!(parts[0], parts[1], "its own process group (setsid): {text}");
        assert_eq!(parts[2], "/usr/bin:/bin:/plan/path");
        let missing = RestartPlan {
            program: "/nonexistent/setsid".to_owned(),
            ..plan
        };
        assert!(ProcessBoundary.spawn_detached(&missing).is_err());
    }

    #[test]
    fn results_answer_in_ts_key_order() {
        assert_eq!(
            serde_json::to_string(&RestartResult::Scheduled { pid: 7 }.to_json()).unwrap(),
            r#"{"kind":"scheduled","mode":"daemon","pid":7}"#
        );
        assert_eq!(
            RestartResult::Manual.to_json()["reason"],
            Value::from(MANUAL_REASON)
        );
    }
}
