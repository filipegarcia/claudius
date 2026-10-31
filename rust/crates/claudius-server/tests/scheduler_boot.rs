//! The scheduler's boot from `main.rs` (G07a). TS boots it whenever Next
//! starts; the Rust binary only with `--scheduler` or `CLAUDIUS_SCHEDULER=1`,
//! so no test or dev run fires a job unless it asks. Booting arms each
//! enabled job, which writes its `nextRunAt`: that's what these look for.

mod common;

use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::time::Duration;

use claudius_agent::js;
use claudius_core::cron::{Zone, next_fire_after_in};
use common::{Server, World, fake_bin, free_port, http, wait_until};
use serde_json::{Value, json};

const CRON: &str = "0 0 1 1 *";

/// A `jobs.json` with one enabled job, in the server's state home.
fn seed(world: &World) -> PathBuf {
    let dir = world.home.join(".claude/claudius/schedule");
    std::fs::create_dir_all(&dir).unwrap();
    let file = dir.join("jobs.json");
    let jobs = json!({"jobs": [{
        "id": "j",
        "name": "new year",
        "cron": CRON,
        "prompt": "hello",
        "cwd": world.project,
        "enabled": true,
        "createdAt": 1,
        "updatedAt": 1,
    }]});
    std::fs::write(&file, js::stringify_pretty(&jobs) + "\n").unwrap();
    file
}

fn next_run_at(file: &PathBuf) -> Option<i64> {
    let jobs: Value = serde_json::from_str(&std::fs::read_to_string(file).unwrap()).unwrap();
    jobs["jobs"][0]["nextRunAt"].as_i64()
}

fn now_ms() -> f64 {
    claudius_core::now_ms() as f64
}

#[test]
fn the_scheduler_stays_off_by_default() {
    let world = World::new();
    let file = seed(&world);
    let before = std::fs::read(&file).unwrap();
    // It boots before the listener: once healthy, it would have.
    let server = Server::spawn(&world, &[]);
    assert_eq!(std::fs::read(&file).unwrap(), before);
    let (status, _, _) = server.stop(Duration::from_secs(10));
    assert!(status.success());
    assert_eq!(std::fs::read(&file).unwrap(), before);
}

#[test]
fn claudius_scheduler_1_boots_it() {
    let world = World::new();
    let file = seed(&world);
    let want = next_fire_after_in(CRON, None, now_ms(), None, Zone::Local).unwrap();
    let server = Server::spawn(&world, &[("CLAUDIUS_SCHEDULER", "1")]);
    assert_eq!(next_run_at(&file), Some(want));
    // Its timers don't hold up a shutdown.
    let (status, _, took) = server.stop(Duration::from_secs(10));
    assert!(status.success());
    assert!(took < Duration::from_secs(5), "{took:?}");
}

#[test]
fn other_values_leave_it_off() {
    let world = World::new();
    let file = seed(&world);
    let server = Server::spawn(&world, &[("CLAUDIUS_SCHEDULER", "0")]);
    assert_eq!(next_run_at(&file), None);
    drop(server);
}

#[test]
fn the_flag_boots_it() {
    let world = World::new();
    let file = seed(&world);
    let want = next_fire_after_in(CRON, None, now_ms(), None, Zone::Local).unwrap();
    let port = free_port();
    let child = Command::new(env!("CARGO_BIN_EXE_claudius"))
        .args(["--port", &port.to_string(), "--no-next", "--scheduler"])
        .arg("--claude-bin")
        .arg(fake_bin())
        .current_dir(&world.project)
        .env_remove("CLAUDIUS_SCHEDULER")
        .env_remove("RUST_LOG")
        .env("CLAUDIUS_STATE_HOME", &world.home)
        .env("CLAUDE_CONFIG_DIR", &world.config)
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .unwrap();
    let server = Server { child, port };
    wait_until("health", Duration::from_secs(20), || {
        std::net::TcpStream::connect(("127.0.0.1", port)).is_ok()
            && http(port, "GET", "/api/rust/health", "").0 == 200
    });
    assert_eq!(next_run_at(&file), Some(want));
    drop(server);
}

#[test]
fn its_runs_use_the_given_cli_and_a_stop_ends_them() {
    // A job due every second, whose turn holds until a file that never
    // comes. `CLAUDIUS_CLAUDE_BIN` points elsewhere (`/usr/bin/false`), so a
    // run that missed `--claude-bin` would fail without reaching the gate.
    let world = World::new();
    let dir = world.home.join(".claude/claudius/schedule");
    std::fs::create_dir_all(&dir).unwrap();
    let jobs = json!({"jobs": [{
        "id": "s",
        "cron": "* * * * * *",
        "prompt": "hold",
        "cwd": world.project,
        "enabled": true,
    }]});
    std::fs::write(dir.join("jobs.json"), js::stringify_pretty(&jobs) + "\n").unwrap();
    let script = json!({"turns": [{
        "match": "hold",
        "steps": [{"$mark": "gate"}, {"$wait_file": "release"}],
    }]});
    let events = world.project.join("events.jsonl");
    let server = Server::spawn(
        &world,
        &[
            ("CLAUDIUS_SCHEDULER", "1"),
            ("CLAUDIUS_CLAUDE_BIN", "/usr/bin/false"),
            ("FAKE_CLAUDE_SCRIPT", &js::stringify(&script)),
            ("FAKE_CLAUDE_EVENTS", &events.display().to_string()),
        ],
    );
    wait_until("the run's turn", Duration::from_secs(20), || {
        std::fs::read_to_string(&events).is_ok_and(|t| t.contains("\"gate\""))
    });
    // SIGTERM ends the run, and its record says so, before the exit.
    let (status, _, took) = server.stop(Duration::from_secs(10));
    assert!(status.success());
    assert!(took < Duration::from_secs(5), "{took:?}");
    let runs = std::fs::read_to_string(dir.join("jobs/s/runs.jsonl")).unwrap();
    let lines: Vec<&str> = runs.lines().collect();
    assert_eq!(lines.len(), 1, "{runs}");
    let run: Value = serde_json::from_str(lines[0]).unwrap();
    assert_eq!(run["status"], "error", "{run}");
    assert_eq!(run["note"], "Operation aborted", "{run}");
    let stored: Value =
        serde_json::from_str(&std::fs::read_to_string(dir.join("jobs.json")).unwrap()).unwrap();
    assert_eq!(stored["jobs"][0]["lastStatus"], "error");
}
