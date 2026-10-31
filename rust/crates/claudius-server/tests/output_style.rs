//! `GET /api/sessions/:id/output-style` against the real binary and fake
//! CLI: the CLI's own style list when its `initialize` reports one, the
//! static fallback when `initialize` fails.
#![cfg(unix)]

mod common;

use std::time::Duration;

use common::{Server, World, http};
use serde_json::{Value, json};

fn get(server: &Server, id: &str) -> (u16, Value) {
    let (st, body) = http(
        server.port,
        "GET",
        &format!("/api/sessions/{id}/output-style"),
        "",
    );
    (st, serde_json::from_str(&body).unwrap())
}

#[test]
fn lists_the_clis_styles_and_falls_back_without_them() {
    let world = World::new();
    let script = json!({"initialize": {
        "output_style": "concise",
        "available_output_styles": ["default", "concise", "my-plugin-style"],
    }});
    let server = Server::spawn(&world, &[("FAKE_CLAUDE_SCRIPT", &script.to_string())]);
    let id = server.create_session(&world);
    assert_eq!(
        get(&server, &id),
        (
            200,
            json!({"current": "concise", "available": ["default", "concise", "my-plugin-style"], "source": "session"})
        )
    );
    server.stop(Duration::from_secs(15));

    let world = World::new();
    let script = json!({"control": {"initialize": {"$error": "initialize refused"}}});
    let server = Server::spawn(&world, &[("FAKE_CLAUDE_SCRIPT", &script.to_string())]);
    let id = server.create_session(&world);
    assert_eq!(
        get(&server, &id),
        (
            200,
            json!({"current": "default", "available": ["default", "explanatory", "concise", "developer"], "source": "fallback"})
        )
    );
    assert_eq!(
        get(&server, "00000000-0000-0000-0000-000000000000"),
        (404, json!({"error": "session not found"}))
    );
    server.stop(Duration::from_secs(15));
}
