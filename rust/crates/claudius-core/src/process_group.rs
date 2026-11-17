//! `lib/server/process-group.ts`: stop a process group, then force-kill
//! whatever is still alive after a grace period (CC 2.1.300, "force-kill
//! background commands still running 1.5 seconds after being asked to
//! stop").
//!
//! `pid` must lead its own process group (the child was spawned with Node's
//! `detached: true`, i.e. `setsid()` here), because both signals go to
//! `-pid`: that reaches the shell AND every descendant left in the group,
//! including `&` jobs (a non-interactive bash has job control off, so they
//! stay in the group).
//!
//! SIGTERM first, so well-behaved children can flush a last message;
//! SIGKILL after the grace, so a job that traps or ignores TERM
//! (`( trap '' TERM; sleep 999 ) &`) can't outlive the session. A SIGTERM
//! that finds no group at all (ESRCH) schedules no SIGKILL, as in TS: the
//! pgid could in theory be recycled before the timer fires.
//!
//! Scope, as in TS: session close ([`crate::bash_mode`]) and per-command
//! timeouts ([`crate::bash_mode`], [`crate::shell`]). The escalation runs on
//! a detached task, which the runtime drops when it shuts down — the same
//! reach as TS's `unref()`'d timer, which process exit drops.

use std::time::Duration;

/// `KILL_GRACE_MS`.
pub const KILL_GRACE: Duration = Duration::from_millis(1500);

/// `killProcessGroup(pid)`: SIGTERM the group `pid` leads, then SIGKILL the
/// survivors [`KILL_GRACE`] later.
pub fn kill_process_group(pid: u32) {
    kill_process_group_after(pid, KILL_GRACE);
}

/// `killProcessGroup(pid, graceMs)`.
pub fn kill_process_group_after(pid: u32, grace: Duration) {
    #[cfg(unix)]
    {
        // ESRCH: no member of the group is alive. Don't schedule a SIGKILL.
        if !signal_group(pid, libc::SIGTERM) {
            return;
        }
        // TS: `setTimeout(…, graceMs).unref()`.
        match tokio::runtime::Handle::try_current() {
            Ok(handle) => {
                handle.spawn(async move {
                    tokio::time::sleep(grace).await;
                    signal_group(pid, libc::SIGKILL);
                });
            }
            // Off a runtime (a `Drop` on a plain thread): a detached thread
            // keeps the process alive no longer than the timer would.
            Err(_) => {
                let _ = std::thread::Builder::new()
                    .name("kill-group".into())
                    .spawn(move || {
                        std::thread::sleep(grace);
                        signal_group(pid, libc::SIGKILL);
                    });
            }
        }
    }
    #[cfg(not(unix))]
    let _ = (pid, grace);
}

/// `process.kill(-pid, sig)`; false when it failed (the group is gone).
#[cfg(unix)]
fn signal_group(pid: u32, sig: libc::c_int) -> bool {
    // SAFETY: plain `kill(2)` on the process group our child leads; a group
    // that is already gone is just ESRCH.
    unsafe { libc::kill(-(pid as libc::pid_t), sig) == 0 }
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;

    /// A group nobody is in is just ESRCH, and no SIGKILL is scheduled.
    #[tokio::test]
    async fn a_group_that_is_gone_is_ignored() {
        // pid 1 leads no group we may signal; an unused high pid is ESRCH.
        kill_process_group(0x3FFF_FFFF);
        kill_process_group_after(0x3FFF_FFFE, Duration::from_millis(1));
        tokio::time::sleep(Duration::from_millis(20)).await;
    }

    /// The grace is TS's 1.5 s.
    #[test]
    fn the_grace_matches_the_ts_constant() {
        assert_eq!(KILL_GRACE, Duration::from_millis(1500));
    }

    /// A group that ignores SIGTERM dies at the SIGKILL, which is the whole
    /// point of the escalation (CC 2.1.300).
    #[tokio::test(flavor = "multi_thread")]
    async fn a_group_that_ignores_sigterm_is_force_killed() {
        let mut cmd = std::process::Command::new("/bin/sh");
        cmd.args(["-c", "trap '' TERM; while :; do sleep 1; done"]);
        // SAFETY: setsid is async-signal-safe and touches no Rust state.
        unsafe {
            std::os::unix::process::CommandExt::pre_exec(&mut cmd, || {
                libc::setsid();
                Ok(())
            });
        }
        let mut child = cmd.spawn().expect("sh");
        let pid = child.id();
        // Give the shell time to install the trap, then show that it ignores
        // a plain SIGTERM (its `sleep` children inherit the ignore).
        tokio::time::sleep(Duration::from_millis(400)).await;
        assert!(signal_group(pid, libc::SIGTERM));
        tokio::time::sleep(Duration::from_millis(200)).await;
        assert!(child.try_wait().expect("wait").is_none(), "TERM killed it");
        kill_process_group_after(pid, Duration::from_millis(100));
        let deadline = std::time::Instant::now() + Duration::from_secs(5);
        loop {
            if let Some(status) = child.try_wait().expect("wait") {
                #[cfg(unix)]
                assert_eq!(
                    std::os::unix::process::ExitStatusExt::signal(&status),
                    Some(libc::SIGKILL),
                    "{status:?}"
                );
                break;
            }
            assert!(std::time::Instant::now() < deadline, "survived the SIGKILL");
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
    }
}
