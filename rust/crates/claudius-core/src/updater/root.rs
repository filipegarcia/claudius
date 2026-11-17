//! `lib/server/updater/root.ts`: where the running Claudius lives on disk,
//! and how it was started.

use claudius_agent::js;

use crate::{node_fs, node_path};

/// `installRoot()`: `$CLAUDIUS_INSTALL_ROOT` trimmed when it has anything
/// in it, else the server's cwd.
pub fn install_root() -> String {
    if let Some(v) = std::env::var_os("CLAUDIUS_INSTALL_ROOT") {
        let v = v.to_string_lossy().into_owned();
        let trimmed = js::trim(&v);
        if !trimmed.is_empty() {
            return trimmed.to_owned();
        }
    }
    process_cwd()
}

/// `process.cwd()`.
pub fn process_cwd() -> String {
    std::env::current_dir()
        .map(|p| p.to_string_lossy().into_owned())
        .unwrap_or_default()
}

/// `daemonPidFile()`.
pub fn daemon_pid_file() -> String {
    node_path::join(&[&install_root(), ".claudius", "claudius.pid"])
}

/// `daemonLogFile()`.
pub fn daemon_log_file() -> String {
    node_path::join(&[&install_root(), ".claudius", "logs", "claudius.log"])
}

/// `claudiusdPath()`.
pub fn claudiusd_path() -> String {
    node_path::join(&[&install_root(), "bin", "claudiusd"])
}

/// `runtimeMode()`: `"dev"` with no PID file (a dangling link counts as
/// none), `"daemon"` when it holds a finite `Number(…)` above zero
/// (whatever the pid), else `"unknown"` — a file that can't be read or
/// doesn't read as a positive number.
pub fn runtime_mode() -> &'static str {
    let pid_path = daemon_pid_file();
    // `existsSync`: follows symlinks.
    if std::fs::metadata(&pid_path).is_err() {
        return "dev";
    }
    match node_fs::read_to_string(&pid_path) {
        Ok(raw) => {
            let pid = js::to_number(js::trim(&raw));
            if !pid.is_finite() || pid <= 0.0 {
                "unknown"
            } else {
                "daemon"
            }
        }
        Err(_) => "unknown",
    }
}
