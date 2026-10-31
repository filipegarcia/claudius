//! `POST /api/sessions/:id/background-task` (Ctrl+B) against the real binary
//! and fake CLI: the body's string `toolUseId` (anything else, or no JSON at
//! all, means every foreground task) becomes the `background_tasks` control
//! request; the reply's `backgrounded` (`?? true`) comes back; a refused
//! request, or one the dead CLI can't answer, is a 503 with the message;
//! only live sessions (404).
#![cfg(unix)]

mod common;

use std::time::Duration;

use common::{Server, World, http, read_until, wait_until};
use serde_json::{Value, json};

fn post(server: &Server, id: &str, body: &str) -> (u16, Value) {
    let (st, text) = http(
        server.port,
        "POST",
        &format!("/api/sessions/{id}/background-task"),
        body,
    );
    (st, serde_json::from_str(&text).unwrap())
}

/// The `background_tasks` requests the CLI received, oldest first.
fn requests(log: &std::path::Path) -> Vec<Value> {
    std::fs::read_to_string(log)
        .unwrap_or_default()
        .lines()
        .filter_map(|l| serde_json::from_str::<Value>(l).ok())
        .map(|m| m["request"].clone())
        .filter(|r| r["subtype"] == "background_tasks")
        .collect()
}

#[test]
fn backgrounds_one_task_or_all_of_them() {
    let world = World::new();
    let log = world.root.path().join("control.log");
    let server = Server::spawn(
        &world,
        &[("FAKE_CLAUDE_CONTROL_LOG", &log.display().to_string())],
    );
    let id = server.create_session(&world);
    let ok = (200, json!({"ok": true, "backgrounded": true}));

    // A string id targets that task, an empty one included.
    assert_eq!(post(&server, &id, r#"{"toolUseId":"toolu_1"}"#), ok);
    assert_eq!(post(&server, &id, r#"{"toolUseId":""}"#), ok);
    // Anything else backgrounds everything: a non-string id, other JSON
    // values, a body that isn't JSON (`req.json().catch(() => ({}))`).
    for body in [
        r#"{"toolUseId":5}"#,
        "{}",
        "null",
        "[1]",
        "7",
        "not json",
        "",
    ] {
        assert_eq!(post(&server, &id, body), ok, "{body:?}");
    }
    let mut want = vec![
        json!({"subtype": "background_tasks", "tool_use_id": "toolu_1"}),
        json!({"subtype": "background_tasks", "tool_use_id": ""}),
    ];
    want.extend(std::iter::repeat_n(
        json!({"subtype": "background_tasks"}),
        7,
    ));
    wait_until("all requests logged", Duration::from_secs(5), || {
        requests(&log).len() == want.len()
    });
    assert_eq!(requests(&log), want);

    // Only sessions live in this process; nothing resumes.
    assert_eq!(
        post(&server, "00000000-0000-0000-0000-000000000000", "{}"),
        (404, json!({"error": "session not found"}))
    );
    server.stop(Duration::from_secs(15));
}

#[test]
fn reports_what_the_cli_answers() {
    // `response.backgrounded ?? true`.
    for (reply, want) in [
        (json!({"backgrounded": false}), json!(false)),
        (json!({"backgrounded": null}), json!(true)),
        (json!({}), json!(true)),
    ] {
        let world = World::new();
        let script = json!({"control": {"background_tasks": {"$response": reply}}});
        let server = Server::spawn(&world, &[("FAKE_CLAUDE_SCRIPT", &script.to_string())]);
        let id = server.create_session(&world);
        assert_eq!(
            post(&server, &id, r#"{"toolUseId":"toolu_9"}"#),
            (200, json!({"ok": true, "backgrounded": want})),
            "{reply}"
        );
        server.stop(Duration::from_secs(15));
    }

    // A refused request → 503 with the CLI's message.
    let world = World::new();
    let script =
        json!({"control": {"background_tasks": {"$error": "no foreground task to background"}}});
    let server = Server::spawn(&world, &[("FAKE_CLAUDE_SCRIPT", &script.to_string())]);
    let id = server.create_session(&world);
    assert_eq!(
        post(&server, &id, "{}"),
        (503, json!({"error": "no foreground task to background"}))
    );
    server.stop(Duration::from_secs(15));
}

/// The query outlives its CLI (TS never drops `this.query` either), so after
/// the process dies it's the request that fails: a 503 with the SDK's
/// "Query closed…" (cleanup_golden pins the other timings), not "no active
/// query".
#[test]
fn a_dead_cli_is_a_503() {
    let world = World::new();
    let server = Server::spawn(&world, &[]);
    let id = server.create_session(&world);
    let mut sse = server.open_stream(&id);
    let (st, _) = http(
        server.port,
        "POST",
        &format!("/api/sessions/{id}/input"),
        r#"{"text":"exit:3"}"#,
    );
    assert_eq!(st, 200);
    // The session reports the exit once the reader ended, i.e. after the
    // SDK's cleanup.
    read_until(
        &mut sse,
        "Claude Code process exited with code 3. stderr: boom",
        Duration::from_secs(10),
    );
    assert_eq!(
        post(&server, &id, "{}"),
        (
            503,
            json!({"error": "Query closed before response received"})
        )
    );
    server.stop(Duration::from_secs(15));
}
