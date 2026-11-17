//! The real `claudius` binary shuts down cleanly on SIGTERM (what Electron and
//! process managers send), even with an SSE stream held open: sessions end,
//! their CLI children exit, and the server exits 0 instead of hanging on the
//! never-ending stream or dying with orphans.
#![cfg(unix)]

mod common;

use std::time::{Duration, SystemTime, UNIX_EPOCH};

use common::{Server, World, process_alive, read_pid, wait_until};

#[test]
fn sigterm_ends_sessions_reaps_clis_and_exits_with_stream_open() {
    let world = World::new();
    let pid_file = world.root.path().join("cli.pid");
    let pid_path = pid_file.display().to_string();
    let server = Server::spawn(
        &world,
        &[
            ("FAKE_CLAUDE_PID", &pid_path),
            ("RUST_LOG", "claudius=info"),
        ],
    );
    let id = server.create_session(&world);
    wait_until("fake CLI pid", Duration::from_secs(10), || {
        read_pid(&pid_file).is_some()
    });
    let cli_pid = read_pid(&pid_file).unwrap();
    assert!(process_alive(cli_pid));

    // Hold an SSE stream open: it never ends on its own.
    let _sse = server.open_stream(&id);

    let (status, log, took) = server.stop(Duration::from_secs(15));
    assert!(status.success(), "server exit: {status:?}\n{log}");
    assert!(log.contains("SIGTERM: shutting down"), "{log}");
    assert!(!process_alive(cli_pid), "CLI {cli_pid} orphaned");
    assert!(
        took < Duration::from_secs(10),
        "shutdown took {took:?} (hung on the open stream?)"
    );
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_millis() as i64
}

/// A CLI that ignores both its stdin's EOF and SIGTERM (R13). Outside a
/// shutdown, closing it would wait 2 s before SIGTERM and 5 s more before
/// SIGKILL, like the SDK. Exiting, the server skips the grace, as a TS host's
/// exit SIGTERMs its CLIs at once: SIGTERM right away, SIGKILL 2 s later, and
/// the shutdown waits for that before it exits.
#[test]
fn sigterm_skips_the_close_grace_and_waits_for_a_cli_that_ignores_it() {
    let world = World::new();
    let pid_file = world.root.path().join("cli.pid");
    let times = world.root.path().join("times.log");
    let script = r#"{"on_eof": [{"$delay_ms": 60000}], "on_sigterm": "ignore"}"#;
    let server = Server::spawn(
        &world,
        &[
            ("FAKE_CLAUDE_PID", &pid_file.display().to_string()),
            ("FAKE_CLAUDE_TIMES", &times.display().to_string()),
            ("FAKE_CLAUDE_SCRIPT", script),
        ],
    );
    server.create_session(&world);
    wait_until("fake CLI pid", Duration::from_secs(10), || {
        read_pid(&pid_file).is_some()
    });
    let cli_pid = read_pid(&pid_file).unwrap();

    let t0 = now_ms();
    let (status, log, took) = server.stop(Duration::from_secs(15));
    assert!(status.success(), "server exit: {status:?}\n{log}");
    assert!(!process_alive(cli_pid), "CLI {cli_pid} orphaned");
    let seen = std::fs::read_to_string(&times).unwrap_or_default();
    let at = |event: &str| {
        seen.lines()
            .map(|l| serde_json::from_str::<serde_json::Value>(l).unwrap())
            .find(|e| e["event"] == event)
            .and_then(|e| e["ms"].as_i64())
            .unwrap_or_else(|| panic!("no {event} in {seen:?}"))
    };
    // SIGTERM well before the 2 s grace would end, and the shutdown waited
    // for the SIGKILL 2 s after it.
    assert!(at("eof") - t0 < 1500, "EOF {} ms in", at("eof") - t0);
    assert!(
        at("SIGTERM") - t0 < 1500,
        "SIGTERM {} ms in",
        at("SIGTERM") - t0
    );
    assert!(
        took >= Duration::from_millis(1800),
        "shutdown took {took:?}: didn't wait for the CLI"
    );
    // Not the 5 s SIGKILL of a close outside a shutdown (`Session::end()`
    // would give up at 5 s).
    assert!(took < Duration::from_millis(4500), "shutdown took {took:?}");
}
