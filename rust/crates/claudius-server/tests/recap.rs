//! `POST /api/sessions/:id/recap` (S12) against the real binary and fake
//! CLI: only live sessions (404); the answer is always 202 `{ok: true}` and
//! the recap, or why there is none, arrives over SSE; the body's `origin`
//! is `"manual"` only when it says so; `sessionRecapEnabled: false` in the
//! user settings turns recaps off.
#![cfg(unix)]

mod common;

use std::net::TcpStream;
use std::time::Duration;

use common::{Server, World, http, read_until};
use serde_json::{Value, json};

/// The recap events in what the stream has sent so far.
fn recap_events(seen: &str) -> Vec<Value> {
    seen.lines()
        .filter_map(|l| l.strip_prefix("data: "))
        .filter_map(|d| serde_json::from_str::<Value>(d).ok())
        .filter(|e| {
            e["type"]
                .as_str()
                .is_some_and(|t| t.starts_with("session_recap"))
        })
        .collect()
}

fn post_recap(server: &Server, id: &str, body: &str) -> (u16, Value) {
    let (st, text) = http(
        server.port,
        "POST",
        &format!("/api/sessions/{id}/recap"),
        body,
    );
    (st, serde_json::from_str(&text).unwrap_or(Value::Null))
}

/// A session with one finished turn, and its open stream.
fn session_with_history(server: &Server, world: &World) -> (String, TcpStream) {
    let id = server.create_session(world);
    let mut sse = server.open_stream(&id);
    let (st, _) = http(
        server.port,
        "POST",
        &format!("/api/sessions/{id}/input"),
        r#"{"text":"hello"}"#,
    );
    assert_eq!(st, 200);
    // The turn ends with an idle `turn_status` after the echo (the stream's
    // first one comes with the snapshot).
    let seen = read_until(&mut sse, "echo:hello", Duration::from_secs(10));
    let after = &seen[seen.find("echo:hello").unwrap()..];
    if !after.contains(r#""status":"idle""#) {
        read_until(&mut sse, r#""status":"idle""#, Duration::from_secs(10));
    }
    (id, sse)
}

/// The next recap event on `sse`.
fn next_recap(sse: &mut TcpStream) -> Value {
    let seen = read_until(sse, r#""type":"session_recap"#, Duration::from_secs(15));
    recap_events(&seen).pop().unwrap()
}

#[test]
fn recaps_ride_the_stream() {
    let world = World::new();
    let script = json!({"turns": [
        {"match": "stepped away", "steps": [{"$text": "Recap from the server."}]},
    ]});
    let server = Server::spawn(&world, &[("FAKE_CLAUDE_SCRIPT", &script.to_string())]);
    let accepted = (202, json!({"ok": true}));

    // Only sessions live in this process; nothing resumes.
    assert_eq!(
        post_recap(&server, "00000000-0000-0000-0000-000000000000", "{}"),
        (404, json!({"error": "session not found"}))
    );

    // A fresh session has nothing to recap.
    let id = server.create_session(&world);
    let mut sse = server.open_stream(&id);
    assert_eq!(post_recap(&server, &id, ""), accepted);
    assert_eq!(
        next_recap(&mut sse),
        json!({"type": "session_recap_error", "reason": "no_history"})
    );

    // `origin` is "manual" only when the body says exactly that.
    for (body, origin) in [
        (r#"{"origin":"manual"}"#, "manual"),
        (r#"{"origin":"away"}"#, "away"),
        (r#"{"origin":"MANUAL"}"#, "away"),
        (r#"{"origin":5}"#, "away"),
        ("null", "away"),
        ("[\"manual\"]", "away"),
        ("not json", "away"),
    ] {
        let (id, mut sse) = session_with_history(&server, &world);
        assert_eq!(post_recap(&server, &id, body), accepted, "{body}");
        let ev = next_recap(&mut sse);
        assert_eq!(ev["type"], "session_recap", "{body}: {ev}");
        assert_eq!(ev["text"], "Recap from the server.", "{body}");
        assert_eq!(ev["origin"], origin, "{body}");
        if body == "null" {
            // Within the window, another tab's request is refused.
            assert_eq!(post_recap(&server, &id, body), accepted);
            assert_eq!(
                next_recap(&mut sse),
                json!({"type": "session_recap_error", "reason": "rate_limited"})
            );
        }
    }

    // `sessionRecapEnabled: false` in the user settings
    // (`homedir()/.claude/settings.json`).
    let settings = world.home.join(".claude/settings.json");
    std::fs::create_dir_all(settings.parent().unwrap()).unwrap();
    std::fs::write(&settings, r#"{"sessionRecapEnabled": false}"#).unwrap();
    let (id, mut sse) = session_with_history(&server, &world);
    assert_eq!(post_recap(&server, &id, "{}"), accepted);
    assert_eq!(
        next_recap(&mut sse),
        json!({"type": "session_recap_error", "reason": "disabled"})
    );
    // Any other value keeps it on.
    std::fs::write(&settings, r#"{"sessionRecapEnabled": "false"}"#).unwrap();
    assert_eq!(post_recap(&server, &id, "{}"), accepted);
    assert_eq!(next_recap(&mut sse)["type"], "session_recap");
}
