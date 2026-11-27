//! SIGINT and SIGTERM shut the in-process engine down (U04g), as the
//! server's `main` does: [`Backend::on_shutdown_signal`] resolves with the
//! signal's name (the app quits on it), and the quit's
//! [`Backend::shutdown`] ends every session and its CLI. A test binary of
//! its own: it signals this process.

#[path = "../../../../crates/claudius-agent/tests/support/test_bins.rs"]
mod test_bins;
#[path = "support/world.rs"]
mod world;

use std::time::Duration;

use claudius_app::data::ShellData;
use claudius_app::engine::Backend;
use futures::executor::block_on;
use world::{slow_turn, world};

fn signal_self(sig: &str) {
    let st = std::process::Command::new("kill")
        .args([format!("-{sig}"), std::process::id().to_string()])
        .status()
        .unwrap();
    assert!(st.success(), "kill -{sig}");
}

fn sessions(b: &Backend) -> usize {
    b.engine().unwrap().state().mgr.list().len()
}

#[test]
fn a_signal_quits_and_the_quit_ends_every_session() {
    let w = world(test_bins::fake_claude(), &["Alpha"]);
    let ws = w.workspaces[0].id.clone();
    let sid = block_on(w.data.create_session(&ws)).unwrap();
    w.input(&ws, &sid, &slow_turn(60_000));
    world::wait_for("the session", Duration::from_secs(30), || {
        (sessions(&w.backend) == 1).then_some(())
    });

    // Each signal resolves the wait with its name; the process lives on
    // (the handlers caught it), and so does the session until the quit.
    for (sig, name) in [("INT", "SIGINT"), ("TERM", "SIGTERM")] {
        let rx = w.backend.on_shutdown_signal().unwrap();
        signal_self(sig);
        assert_eq!(block_on(rx).unwrap(), name);
    }
    assert_eq!(sessions(&w.backend), 1);

    // The app's quit (`on_app_quit`): every session ends, its CLI with it.
    w.backend.shutdown(Duration::from_secs(10));
    assert_eq!(sessions(&w.backend), 0);
}
