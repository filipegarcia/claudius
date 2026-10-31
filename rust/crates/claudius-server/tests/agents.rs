//! `GET /api/sessions/:id/agents` and the create-time agent against the
//! real binary and fake CLI: the agents come straight off the CLI's
//! `initialize` response (`{}` when it has no `agents` key, a 503 when
//! there's no response), and the agent picked at create time reaches the
//! CLI as `--agent` only when it's a non-empty name.
#![cfg(unix)]

mod common;

use std::time::Duration;

use common::{Server, World, http, wait_until};
use serde_json::{Value, json};

fn get(server: &Server, path: &str) -> (u16, Value) {
    let (st, body) = http(server.port, "GET", path, "");
    (st, serde_json::from_str(&body).unwrap())
}

/// Create a session with `agent` and return (id, the CLI's argv).
fn create_with_agent(server: &Server, world: &World, agent: &str) -> (String, Vec<String>) {
    let argv_file = world.root.path().join("argv.json");
    let _ = std::fs::remove_file(&argv_file);
    let body = json!({"cwd": world.project.display().to_string(), "agent": agent});
    let (st, created) = http(server.port, "POST", "/api/sessions", &body.to_string());
    assert_eq!(st, 200, "{created}");
    let id = serde_json::from_str::<Value>(&created).unwrap()["id"]
        .as_str()
        .unwrap()
        .to_owned();
    let mut argv = vec![];
    wait_until(
        "the CLI's argv",
        Duration::from_secs(15),
        || match std::fs::read_to_string(&argv_file)
            .ok()
            .and_then(|s| serde_json::from_str(&s).ok())
        {
            Some(a) => {
                argv = a;
                true
            }
            None => false,
        },
    );
    (id, argv)
}

#[test]
fn lists_the_agents_the_cli_loaded() {
    let world = World::new();
    let agents = json!([
        {"name": "general-purpose", "description": "Default agent"},
        {"name": "code-reviewer", "description": "Reviews diffs", "model": "sonnet"},
    ]);
    let script = json!({"initialize": {"agents": agents}});
    let argv_file = world.root.path().join("argv.json");
    let server = Server::spawn(
        &world,
        &[
            ("FAKE_CLAUDE_SCRIPT", &script.to_string()),
            ("FAKE_CLAUDE_ARGV", &argv_file.display().to_string()),
        ],
    );
    let (id, argv) = create_with_agent(&server, &world, "code-reviewer");
    assert!(argv.contains(&"--agent=code-reviewer".into()), "{argv:?}");
    assert_eq!(
        get(&server, &format!("/api/sessions/{id}/agents")),
        (200, json!({"agents": agents}))
    );
    assert_eq!(
        get(&server, &format!("/api/sessions/{id}/agent")),
        (200, json!({"agent": "code-reviewer"}))
    );
    // `this.agent ? { agent } : {}`: an empty name never reaches the CLI,
    // though `GET /agent` reports it as given.
    let (id, argv) = create_with_agent(&server, &world, "");
    assert!(!argv.iter().any(|a| a.starts_with("--agent")), "{argv:?}");
    assert_eq!(
        get(&server, &format!("/api/sessions/{id}/agent")),
        (200, json!({"agent": ""}))
    );
    for path in ["agents", "agent"] {
        assert_eq!(
            get(
                &server,
                &format!("/api/sessions/00000000-0000-0000-0000-000000000000/{path}")
            ),
            (404, json!({"error": "session not found"})),
            "{path}"
        );
    }
    server.stop(Duration::from_secs(15));
}

#[test]
fn agents_follow_the_initialize_response_shape() {
    // No `agents` key: `{agents: undefined}` serializes as `{}`.
    let world = World::new();
    let script = json!({"control": {"initialize": {"$response": {"commands": []}}}});
    let server = Server::spawn(&world, &[("FAKE_CLAUDE_SCRIPT", &script.to_string())]);
    let id = server.create_session(&world);
    assert_eq!(
        get(&server, &format!("/api/sessions/{id}/agents")),
        (200, json!({}))
    );
    server.stop(Duration::from_secs(15));

    // `agents: null` is kept.
    let world = World::new();
    let script = json!({"initialize": {"agents": null}});
    let server = Server::spawn(&world, &[("FAKE_CLAUDE_SCRIPT", &script.to_string())]);
    let id = server.create_session(&world);
    assert_eq!(
        get(&server, &format!("/api/sessions/{id}/agents")),
        (200, json!({"agents": null}))
    );
    server.stop(Duration::from_secs(15));

    // A `null` response: reading `.agents` off it throws → 503.
    let world = World::new();
    let script = json!({"control": {"initialize": null}});
    let server = Server::spawn(&world, &[("FAKE_CLAUDE_SCRIPT", &script.to_string())]);
    let id = server.create_session(&world);
    assert_eq!(
        get(&server, &format!("/api/sessions/{id}/agents")),
        (
            503,
            json!({"error": "Cannot read properties of null (reading 'agents')"})
        )
    );
    server.stop(Duration::from_secs(15));

    // A failed initialize → 503 with its message.
    let world = World::new();
    let script = json!({"control": {"initialize": {"$error": "initialize refused"}}});
    let server = Server::spawn(&world, &[("FAKE_CLAUDE_SCRIPT", &script.to_string())]);
    let id = server.create_session(&world);
    assert_eq!(
        get(&server, &format!("/api/sessions/{id}/agents")),
        (503, json!({"error": "initialize refused"}))
    );
    server.stop(Duration::from_secs(15));
}
