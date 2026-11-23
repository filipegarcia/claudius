//! `prepare_fork` (TODO I35). On macOS a `Command` with a `pre_exec` hook
//! forks, and a fork while another thread makes libnotify's globals kills
//! the child before it runs (`_notify_fork_child`: "os_once_t is corrupt").
//! That can only happen during the first init in a process, so each race
//! runs in a fresh copy of this test binary.
#![cfg(target_os = "macos")]

use std::os::unix::process::{CommandExt, ExitStatusExt};
use std::process::{Command, Stdio};
use std::time::Duration;

/// Set in a child copy: `warm:<delay µs>` races after `prepare_fork`; any
/// other mode races without it (a manual check that the race still
/// reproduces here: about half the children die).
const CHILD: &str = "CLAUDIUS_FORK_RACE_CHILD";
const TEST: &str = "forks_after_prepare_fork_survive_libnotify_init";

unsafe extern "C" {
    fn notify_register_check(name: *const libc::c_char, out_token: *mut libc::c_int) -> u32;
}

/// The race, in this process: a thread makes libnotify's globals after
/// `delay_us` while six threads fork `/usr/bin/true` through a hook. The
/// number of those children that died by a signal.
fn race(warm: bool, delay_us: u64) -> usize {
    if warm {
        claudius_agent::prepare_fork();
    }
    let notify = std::thread::spawn(move || {
        std::thread::sleep(Duration::from_micros(delay_us));
        let mut token = 0;
        // SAFETY: a static C string and an out-param that outlives the call.
        unsafe { notify_register_check(c"com.claudius.fork-safety-test".as_ptr(), &mut token) };
    });
    let forkers: Vec<_> = (0..6)
        .map(|_| {
            std::thread::spawn(|| {
                (0..4)
                    .filter(|_| {
                        let mut cmd = Command::new("/usr/bin/true");
                        cmd.stdin(Stdio::null())
                            .stdout(Stdio::null())
                            .stderr(Stdio::null());
                        // SAFETY: the hook does nothing.
                        unsafe { cmd.pre_exec(|| Ok(())) };
                        cmd.status().is_ok_and(|s| s.signal().is_some())
                    })
                    .count()
            })
        })
        .collect();
    notify.join().unwrap();
    forkers.into_iter().map(|h| h.join().unwrap()).sum()
}

#[test]
fn forks_after_prepare_fork_survive_libnotify_init() {
    if let Ok(mode) = std::env::var(CHILD) {
        let (mode, delay) = mode.split_once(':').expect("mode:delay");
        println!(
            "killed={}",
            race(mode == "warm", delay.parse().expect("delay"))
        );
        return;
    }
    let me = std::env::current_exe().unwrap();
    let mut killed = 0;
    for i in 0..100u64 {
        // Delays of 0–290 µs move the init across the forks.
        let out = Command::new(&me)
            .args([TEST, "--exact", "--nocapture", "--test-threads=1"])
            .env(CHILD, format!("warm:{}", (i % 30) * 10))
            .output()
            .unwrap();
        assert!(out.status.success(), "{out:?}");
        // libtest prints it on its `test … ...` line.
        let stdout = String::from_utf8_lossy(&out.stdout);
        let n: usize = stdout
            .split_once("killed=")
            .and_then(|(_, rest)| rest.split(|c: char| !c.is_ascii_digit()).next())
            .and_then(|d| d.parse().ok())
            .unwrap_or_else(|| panic!("no count from the child: {stdout}"));
        killed += n;
    }
    assert_eq!(killed, 0, "children died at fork despite prepare_fork");
}
