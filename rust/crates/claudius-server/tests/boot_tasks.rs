//! `instrumentation.ts`'s boot tasks from `main.rs` (G12a, G12b):
//! `runCustomizationsUpgradeCheck()`, `reconcileCustomizationWorkspaces()`,
//! then `updaterScheduler.boot()`.
//! Next runs them whenever it starts, so while it serves beside this binary
//! they stay off here (two runs would race on the same publishes, and two
//! updaters on one tree would stash it twice); `--boot-tasks`
//! or `CLAUDIUS_BOOT_TASKS=1` turns them on for a Rust-only server. They're
//! awaited before the listener, so a health check implies they ran.
//!
//! The updater's boot clears a stale `recovery` (and `lastError`) from
//! `updater.json` before arming its first tick 5 s out; that's what the
//! updater test looks for, with `mode: "disabled"` so no tick touches git.
//!
//! The reconcile half is what the others look for: it deletes every workspace
//! tagged `kind: "customization"` and strips the legacy `workspaceId` from
//! customization records. What each step does is pinned against the TS by
//! `claudius-core/tests/customizations_startup_golden.rs`; this only checks
//! the wiring and the switch.

mod common;

use std::path::PathBuf;

use common::{Server, World};
use serde_json::{Value, json};

/// A `workspaces.json` with one ordinary workspace and one left over from a
/// customization, in the server's state home.
fn seed(world: &World) -> PathBuf {
    let dir = world.home.join(".claude/.claudius");
    std::fs::create_dir_all(&dir).unwrap();
    let file = dir.join("workspaces.json");
    let ws = |id: &str, kind: Option<&str>| {
        let mut w = json!({
            "id": id, "name": id, "rootPath": world.project.to_string_lossy(),
            "icon": {"kind": "letter", "letter": "W", "color": "#d97757"},
            "createdAt": 1, "updatedAt": 1, "defaults": {"additionalDirectories": []},
        });
        if let Some(k) = kind {
            w["kind"] = json!(k);
        }
        w
    };
    let doc = json!({"version": 1, "workspaces": [
        ws("wks_keep", None),
        ws("wks_custom", Some("customization")),
    ]});
    std::fs::write(&file, serde_json::to_string_pretty(&doc).unwrap()).unwrap();
    file
}

fn ids(file: &PathBuf) -> Vec<String> {
    let doc: Value = serde_json::from_str(&std::fs::read_to_string(file).unwrap()).unwrap();
    doc["workspaces"]
        .as_array()
        .unwrap()
        .iter()
        .map(|w| w["id"].as_str().unwrap().to_owned())
        .collect()
}

#[test]
fn boot_tasks_run_only_when_asked_for() {
    // Off by default: Next's own `register()` runs them.
    let world = World::new();
    let file = seed(&world);
    let server = Server::spawn(&world, &[]);
    assert_eq!(ids(&file), ["wks_keep", "wks_custom"]);
    drop(server);

    // Anything but a truthy spelling leaves them off.
    let world = World::new();
    let file = seed(&world);
    let server = Server::spawn(&world, &[("CLAUDIUS_BOOT_TASKS", "0")]);
    assert_eq!(ids(&file), ["wks_keep", "wks_custom"]);
    drop(server);

    // On: the reconcile has deleted the customization workspace by the time
    // the server answers its health check, and kept the other one.
    for on in ["1", " On "] {
        let world = World::new();
        let file = seed(&world);
        let server = Server::spawn(
            &world,
            &[
                ("CLAUDIUS_BOOT_TASKS", on),
                ("CLAUDIUS_UPDATER_DISABLED", "1"),
            ],
        );
        assert_eq!(ids(&file), ["wks_keep"], "CLAUDIUS_BOOT_TASKS={on:?}");
        drop(server);
    }
}

#[test]
fn a_boot_task_failure_does_not_stop_the_server() {
    // An unreadable customizations index fails the upgrade check (the one
    // error `run_customizations_startup` propagates). The TS `register()`
    // rejects and Next serves anyway; here the warning is logged and the
    // listener still comes up. The reconcile is skipped with it, as the TS
    // `await` chain skips it.
    let world = World::new();
    let file = seed(&world);
    let custom = world.home.join(".claude/.claudius/customizations");
    std::fs::create_dir_all(&custom).unwrap();
    std::fs::create_dir_all(custom.join("index.json")).unwrap();
    let server = Server::spawn(&world, &[("CLAUDIUS_BOOT_TASKS", "1")]);
    assert_eq!(
        common::http(server.port, "GET", "/api/rust/health", "").0,
        200
    );
    assert_eq!(ids(&file), ["wks_keep", "wks_custom"]);
    drop(server);
}

/// An `updater.json` whose last apply left a `recovery`, in the server's
/// state home. `mode: "disabled"` keeps the first tick off git.
fn seed_updater(world: &World) -> PathBuf {
    let dir = world.home.join(".claude/.claudius");
    std::fs::create_dir_all(&dir).unwrap();
    let file = dir.join("updater.json");
    let doc = json!({
        "mode": "disabled",
        "state": {
            "status": "idle",
            "lastError": "bun install failed",
            "recovery": {"phase": "install", "fromSha": "aaaaaaa", "toSha": "bbbbbbb"},
        },
    });
    std::fs::write(&file, serde_json::to_string_pretty(&doc).unwrap()).unwrap();
    file
}

fn updater_state(file: &PathBuf) -> Value {
    let doc: Value = serde_json::from_str(&std::fs::read_to_string(file).unwrap()).unwrap();
    doc["state"].clone()
}

#[test]
fn the_updater_boots_with_the_boot_tasks() {
    // Booted: the stale recovery and its error are cleared by the time the
    // server answers its health check.
    let world = World::new();
    let file = seed_updater(&world);
    let server = Server::spawn(
        &world,
        &[
            ("CLAUDIUS_BOOT_TASKS", "1"),
            ("CLAUDIUS_UPDATER_DISABLED", "0"),
        ],
    );
    let state = updater_state(&file);
    assert!(state["recovery"].is_null(), "{state}");
    assert!(state["lastError"].is_null(), "{state}");
    drop(server);

    // `CLAUDIUS_UPDATER_DISABLED=1` (what the packaged app sets) keeps the
    // updater from booting at all, boot tasks or not.
    let world = World::new();
    let file = seed_updater(&world);
    let server = Server::spawn(
        &world,
        &[
            ("CLAUDIUS_BOOT_TASKS", "1"),
            ("CLAUDIUS_UPDATER_DISABLED", "1"),
        ],
    );
    assert_eq!(updater_state(&file)["recovery"]["phase"], "install");
    drop(server);

    // Without the boot tasks, Next's `register()` owns it: untouched.
    let world = World::new();
    let file = seed_updater(&world);
    let server = Server::spawn(&world, &[("CLAUDIUS_UPDATER_DISABLED", "0")]);
    assert_eq!(updater_state(&file)["recovery"]["phase"], "install");
    assert_eq!(updater_state(&file)["lastError"], "bun install failed");
    drop(server);

    // A failed customization check skips the updater boot too, as the TS
    // `register()` stops at its first rejected `await`.
    let world = World::new();
    let file = seed_updater(&world);
    let custom = world.home.join(".claude/.claudius/customizations");
    std::fs::create_dir_all(custom.join("index.json")).unwrap();
    let server = Server::spawn(
        &world,
        &[
            ("CLAUDIUS_BOOT_TASKS", "1"),
            ("CLAUDIUS_UPDATER_DISABLED", "0"),
        ],
    );
    assert_eq!(updater_state(&file)["recovery"]["phase"], "install");
    drop(server);
}
