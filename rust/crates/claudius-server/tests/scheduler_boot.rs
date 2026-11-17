//! The scheduler's boot from `main.rs` (G07a, G07d). TS boots it whenever
//! Next starts, and so does the Rust binary now that it owns the jobs: it is
//! on unless `--no-scheduler` or `CLAUDIUS_SCHEDULER=0|false|no|off` turns it
//! off (the Next behind it gets `CLAUDIUS_RUST_SCHEDULER=1` instead, so only
//! one scheduler runs). Booting arms each enabled job, which writes its
//! `nextRunAt`: that's what these look for.

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
fn the_scheduler_runs_by_default() {
    let world = World::new();
    let file = seed(&world);
    let want = next_fire_after_in(CRON, None, now_ms(), None, Zone::Local).unwrap();
    // It boots before the listener: once healthy, it has.
    let server = Server::spawn(&world, &[]);
    assert_eq!(next_run_at(&file), Some(want));
    // Its timers don't hold up a shutdown.
    let (status, _, took) = server.stop(Duration::from_secs(10));
    assert!(status.success());
    assert!(took < Duration::from_secs(5), "{took:?}");
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
fn claudius_scheduler_0_turns_it_off() {
    let world = World::new();
    let file = seed(&world);
    let before = std::fs::read(&file).unwrap();
    let server = Server::spawn(&world, &[("CLAUDIUS_SCHEDULER", "0")]);
    assert_eq!(next_run_at(&file), None);
    assert_eq!(std::fs::read(&file).unwrap(), before);
    drop(server);
}

#[test]
fn only_a_no_turns_it_off() {
    // Trimmed and lower-cased, as `enabled_by_env` reads it; anything else
    // leaves it on.
    for (raw, off) in [
        (" OFF ", true),
        ("False", true),
        ("no", true),
        ("2", false),
        ("", false),
        ("maybe", false),
    ] {
        let world = World::new();
        let file = seed(&world);
        let server = Server::spawn(&world, &[("CLAUDIUS_SCHEDULER", raw)]);
        assert_eq!(next_run_at(&file).is_none(), off, "{raw:?}");
        drop(server);
    }
}

#[test]
fn the_no_scheduler_flag_turns_it_off() {
    let world = World::new();
    let file = seed(&world);
    let before = std::fs::read(&file).unwrap();
    let port = free_port();
    let child = Command::new(env!("CARGO_BIN_EXE_claudius"))
        .args(["--port", &port.to_string(), "--no-next", "--no-scheduler"])
        .arg("--claude-bin")
        .arg(fake_bin())
        .current_dir(&world.project)
        // Even with the env asking for it, the flag has the last word.
        .env("CLAUDIUS_SCHEDULER", "1")
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
    assert_eq!(next_run_at(&file), None);
    assert_eq!(std::fs::read(&file).unwrap(), before);
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
        // The flag wins over an env that would turn it off.
        .env("CLAUDIUS_SCHEDULER", "0")
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
    let pid = server.child.id();
    // SIGTERM ends the run, and its record says so, before the exit.
    let (status, _, took) = server.stop(Duration::from_secs(10));
    assert!(status.success());
    assert!(took < Duration::from_secs(5), "{took:?}");
    let runs = std::fs::read_to_string(dir.join("jobs/s/runs.jsonl")).unwrap();
    let lines: Vec<&str> = runs.lines().collect();
    assert_eq!(lines.len(), 1, "{runs}");
    let run: Value = serde_json::from_str(lines[0]).unwrap();
    assert_eq!(run["status"], "error", "{run}");
    // The CLI is held mid-turn, so the shutdown's close SIGTERMs it at once
    // (R13), and the SDK's forwarded abort ends the stream with its wording.
    assert_eq!(run["note"], "Claude Code process aborted by user", "{run}");
    // Stamped with the server's own pid (CC 2.1.302's recovery reads it).
    assert_eq!(run["pid"], json!(pid), "{run}");
    let stored: Value =
        serde_json::from_str(&std::fs::read_to_string(dir.join("jobs.json")).unwrap()).unwrap();
    assert_eq!(stored["jobs"][0]["lastStatus"], "error");
}

/// `main` hands the scheduler's events to the notification bus
/// (`scheduler::record_on_bus`, TS's `notificationBus.recordSchedulerEvent`):
/// a missing folder notifies once per new reason, a run that starts clears
/// the reason (and notifies when it finishes), and the next skip notifies
/// again.
#[test]
fn a_missing_folder_reaches_the_inbox_once() {
    let world = World::new();
    let gone = world.root.path().join("gone");
    let cwd = gone.display().to_string();
    let ws = "wks_r01gone0001";
    let ws_file = world.home.join(".claude/.claudius/workspaces.json");
    std::fs::create_dir_all(ws_file.parent().unwrap()).unwrap();
    let store = json!({"version": 1, "workspaces": [
        {"id": ws, "name": "gone", "rootPath": cwd, "createdAt": 1, "updatedAt": 1},
    ]});
    std::fs::write(&ws_file, store.to_string()).unwrap();
    let dir = world.home.join(".claude/claudius/schedule");
    std::fs::create_dir_all(&dir).unwrap();
    let jobs = json!({"jobs": [{
        "id": "m", "name": "m", "cron": CRON, "prompt": "hello", "cwd": cwd,
        "enabled": false, "createdAt": 1, "updatedAt": 1,
    }]});
    std::fs::write(dir.join("jobs.json"), js::stringify_pretty(&jobs) + "\n").unwrap();
    let server = Server::spawn(&world, &[]);
    let run_now = || {
        let (st, body) = http(server.port, "POST", "/api/schedule/m/run-now", "");
        assert_eq!(st, 202, "{body}");
        serde_json::from_str::<Value>(&body).unwrap()["runId"]
            .as_str()
            .unwrap()
            .to_owned()
    };
    let inbox = || {
        let (st, body) = http(
            server.port,
            "GET",
            &format!("/api/notifications?workspace={ws}"),
            "",
        );
        assert_eq!(st, 200, "{body}");
        let v: Value = serde_json::from_str(&body).unwrap();
        v["items"].as_array().unwrap().clone()
    };
    let job = || {
        let (st, body) = http(server.port, "GET", "/api/schedule/m", "");
        assert_eq!(st, 200, "{body}");
        serde_json::from_str::<Value>(&body).unwrap()
    };
    // Newest first.
    let said = |items: &[Value]| -> Vec<(String, String, String, String)> {
        items
            .iter()
            .map(|n| {
                assert_eq!(n["kind"], "scheduled_run_finished", "{n}");
                assert_eq!(n["jobId"], "m", "{n}");
                let text = |k: &str| n[k].as_str().unwrap_or_default().to_owned();
                (
                    text("runId"),
                    text("title"),
                    text("body"),
                    n["payload"].to_string(),
                )
            })
            .collect()
    };
    let skipped = |run: &str| {
        (
            run.to_owned(),
            "Scheduled run skipped".to_owned(),
            "The job's folder no longer exists".to_owned(),
            r#"{"status":"skipped"}"#.to_owned(),
        )
    };

    let first = run_now();
    assert_eq!(said(&inbox()), [skipped(&first)]);
    assert_eq!(job()["lastSkipReason"], "workspace_folder_missing");
    // The same reason again: stamped on the job, not told.
    let again = run_now();
    assert_ne!(again, first);
    assert_eq!(said(&inbox()), [skipped(&first)]);

    // A run that starts clears the reason; its end is told.
    std::fs::create_dir_all(&gone).unwrap();
    let ran = run_now();
    let after_run = job();
    assert_eq!(after_run["lastStatus"], "success", "{after_run}");
    assert!(after_run.get("lastSkipReason").is_none(), "{after_run}");
    assert!(after_run.get("lastSkipAt").is_none(), "{after_run}");
    let items = inbox();
    assert_eq!(items.len(), 2, "{items:?}");
    assert_eq!(items[0]["runId"], json!(ran));
    assert_eq!(items[0]["title"], "Scheduled run finished");
    // So the next missing folder is a new reason again.
    std::fs::remove_dir_all(&gone).unwrap();
    let last = run_now();
    let items = inbox();
    assert_eq!(items.len(), 3, "{items:?}");
    assert_eq!(said(&items[..1]), [skipped(&last)]);
    drop(server);
}
