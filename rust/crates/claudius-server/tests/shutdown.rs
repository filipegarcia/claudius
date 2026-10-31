//! The real `claudius` binary shuts down cleanly on SIGTERM (what Electron and
//! process managers send), even with an SSE stream held open: sessions end,
//! their CLI children exit, and the server exits 0 instead of hanging on the
//! never-ending stream or dying with orphans.
#![cfg(unix)]

mod common;

use std::time::Duration;

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
