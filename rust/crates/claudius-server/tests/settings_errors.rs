//! A `null` user settings.json on the real binary and fake CLI: `start()`
//! throws reading `spinnerTipsEnabled`, so `POST /api/sessions` answers
//! the create route's 500 with the `TypeError`; on a live session,
//! `setPermissionMode("auto")` reads the gate through `isAutoModeDisabled`,
//! which reports `false` for a `null` file instead of throwing on its
//! property read (SDK 0.3.312), so the mode is set; and the advisor route
//! spreads the file to `{}` and writes it (`settings_errors_golden.rs`
//! replays the TS).
#![cfg(unix)]

mod common;

use std::time::Duration;

use common::{Server, World, http};
use serde_json::{Value, json};

fn create(server: &Server, world: &World) -> (u16, String) {
    let body = json!({"cwd": world.project.display().to_string()}).to_string();
    http(server.port, "POST", "/api/sessions", &body)
}

#[test]
fn a_null_user_settings_file() {
    let world = World::new();
    let dir = world.home.join(".claude");
    std::fs::create_dir_all(&dir).unwrap();
    let file = dir.join("settings.json");
    std::fs::write(&file, "null").unwrap();
    let server = Server::spawn(&world, &[]);

    let (st, body) = create(&server, &world);
    assert_eq!(st, 500, "{body}");
    assert_eq!(
        serde_json::from_str::<Value>(&body).unwrap(),
        json!({"error": "Cannot read properties of null (reading 'spinnerTipsEnabled')", "name": "TypeError"})
    );

    // A session started before the file went `null`.
    std::fs::write(&file, "{}").unwrap();
    let id = server.create_session(&world);
    std::fs::write(&file, "null").unwrap();
    let mode = |m: &str| {
        http(
            server.port,
            "POST",
            &format!("/api/sessions/{id}/mode"),
            &json!({"mode": m}).to_string(),
        )
    };
    let get_mode = || http(server.port, "GET", &format!("/api/sessions/{id}/mode"), "");
    // SDK 0.3.312 — `isAutoModeDisabled(null)` is `false`, so this no
    // longer throws the `disableAutoMode` TypeError (recorded in
    // `settings_errors_golden.json`).
    assert_eq!(
        mode("auto"),
        (200, r#"{"ok":true,"mode":"auto"}"#.to_owned())
    );
    assert_eq!(get_mode(), (200, r#"{"mode":"auto"}"#.to_owned()));
    assert_eq!(
        mode("plan"),
        (200, r#"{"ok":true,"mode":"plan"}"#.to_owned())
    );
    assert_eq!(get_mode(), (200, r#"{"mode":"plan"}"#.to_owned()));

    let (st, body) = http(
        server.port,
        "POST",
        &format!("/api/sessions/{id}/advisor"),
        r#"{"model":"claude-opus-4-8"}"#,
    );
    assert_eq!(
        (st, body.as_str()),
        (200, r#"{"ok":true,"model":"claude-opus-4-8"}"#)
    );
    assert_eq!(
        std::fs::read_to_string(&file).unwrap(),
        "{\n  \"advisorModel\": \"claude-opus-4-8\"\n}\n"
    );
    server.stop(Duration::from_secs(15));
}

/// `start()` on a fable model drops `advisorModel` from the user file the
/// way `delete` does: every other key keeps its place.
#[test]
fn a_fable_start_drops_the_advisor_in_place() {
    let world = World::new();
    let dir = world.home.join(".claude");
    std::fs::create_dir_all(&dir).unwrap();
    let file = dir.join("settings.json");
    std::fs::write(
        &file,
        r#"{"a":1,"advisorModel":"claude-opus-4-8","z":[2],"n":1}"#,
    )
    .unwrap();
    let server = Server::spawn(&world, &[]);
    let body = json!({"cwd": world.project.display().to_string(), "model": "claude-fable-5"});
    let (st, body) = http(server.port, "POST", "/api/sessions", &body.to_string());
    assert_eq!(st, 200, "{body}");
    let want = "{\n  \"a\": 1,\n  \"z\": [\n    2\n  ],\n  \"n\": 1\n}\n";
    common::wait_until("the advisor cleared", Duration::from_secs(10), || {
        std::fs::read_to_string(&file).unwrap() == want
    });
    server.stop(Duration::from_secs(15));
}
