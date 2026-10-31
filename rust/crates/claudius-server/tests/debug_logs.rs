//! Debug-log parity: `CLAUDIUS_DEBUG_SESSIONS` turns on the `[sess-load]`
//! diagnostics exactly like TS's `sessLoadDebug()`, with no `RUST_LOG`
//! needed, and they stay off by default. Output is plain text when stdout
//! isn't a terminal (Electron / redirected logs).
#![cfg(unix)]

mod common;

use std::time::Duration;

use common::{Server, World};

fn run(env: &[(&str, &str)]) -> String {
    let world = World::new();
    let server = Server::spawn(&world, env);
    let id = server.create_session(&world);
    // The stream route resumes-or-gets (in-memory hit) and subscribes.
    let sse = server.open_stream(&id);
    std::thread::sleep(Duration::from_millis(200));
    drop(sse);
    let (status, log, _) = server.stop(Duration::from_secs(15));
    assert!(status.success(), "{log}");
    log
}

#[test]
fn claudius_debug_sessions_enables_sess_load_logs() {
    let log = run(&[("CLAUDIUS_DEBUG_SESSIONS", "1")]);
    for line in [
        "[sess-load] start.complete",
        "[sess-load] getOrResumeSession in-memory hit",
        "[sess-load] subscribe",
    ] {
        assert!(log.contains(line), "missing {line:?} in:\n{log}");
    }
    // Structured fields carry the TS names.
    assert!(log.contains("bufferLen="), "{log}");
    assert!(log.contains("priorSubscribers="), "{log}");
    assert!(
        !log.contains('\u{1b}'),
        "no ANSI escapes in a piped log:\n{log}"
    );
    // The default info-level output is still there.
    assert!(log.contains("SIGTERM: shutting down"), "{log}");
}

#[test]
fn sess_load_logs_are_off_by_default_and_with_plain_rust_log() {
    for env in [&[][..], &[("RUST_LOG", "claudius=info")][..]] {
        let log = run(env);
        assert!(
            !log.contains("[sess-load]"),
            "{env:?} leaked sess-load:\n{log}"
        );
        assert!(log.contains("SIGTERM: shutting down"), "{log}");
    }
    // RUST_LOG alone can enable them too, via the target.
    let log = run(&[("RUST_LOG", "claudius=info,claudius::sess_load=debug")]);
    assert!(log.contains("[sess-load] subscribe"), "{log}");
}
