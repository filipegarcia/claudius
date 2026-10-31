//! `GET /api/sessions/:id/usage-behaviors` and the full `/context` fetch's
//! `weeklyUsedSkills` (S16) against the real binary and fake CLI: one
//! `get_usage` scan serves both overlays, a session only on disk resumes, bodies print as `JSON.stringify`
//! prints them (the fake CLI's `1.0` comes back as `1`), and the summary
//! `/context` poll never scans.
#![cfg(unix)]

mod common;

use common::{Server, World, http};
use serde_json::{Value, json};

#[test]
fn usage_extras_ride_one_scan() {
    let world = World::new();
    let control_log = world.home.join("control.log");
    let script = json!({"control": {
        "get_usage": {"$response": {"behaviors": {
            "day": {"request_count": 4, "session_count": 1.0,
                    "behaviors": [{"key": "cache_miss", "pct": 12.5, "count": 2.0}]},
            "week": {"request_count": 9, "behaviors": [{"key": "cron", "pct": 1e21}],
                     "skills": [{"name": "pdf", "pct": 3}, {"name": "unused", "pct": 0}]},
        }}},
        "get_context_usage": {"$response": {"totalTokens": 5, "2": "x", "weeklyUsedSkills": 0}},
    }});
    let server = Server::spawn(
        &world,
        &[
            ("FAKE_CLAUDE_SCRIPT", &script.to_string()),
            (
                "FAKE_CLAUDE_CONTROL_LOG",
                &control_log.display().to_string(),
            ),
        ],
    );

    assert_eq!(
        http(
            server.port,
            "GET",
            "/api/sessions/00000000-0000-0000-0000-000000000000/usage-behaviors",
            ""
        ),
        (404, r#"{"error":"session not found"}"#.to_owned())
    );

    let id = server.create_session(&world);
    let get = |path: &str| {
        http(
            server.port,
            "GET",
            &format!("/api/sessions/{id}/{path}"),
            "",
        )
    };
    assert_eq!(
        get("context?detail=summary"),
        (
            200,
            r#"{"2":"x","totalTokens":5,"weeklyUsedSkills":0}"#.to_owned()
        )
    );
    assert_eq!(
        get("usage-behaviors"),
        (
            200,
            concat!(
                r#"{"behaviors":{"day":{"requestCount":4,"sessionCount":1,"behaviors":"#,
                r#"[{"key":"cache_miss","pct":12.5,"count":2}]},"#,
                r#""week":{"requestCount":9,"sessionCount":0,"behaviors":"#,
                r#"[{"key":"cron","pct":1e+21,"count":0}]}}}"#,
            )
            .to_owned()
        )
    );
    assert_eq!(
        get("context"),
        (
            200,
            r#"{"2":"x","totalTokens":5,"weeklyUsedSkills":["pdf"]}"#.to_owned()
        )
    );

    let scans: Vec<Value> = std::fs::read_to_string(&control_log)
        .unwrap()
        .lines()
        .filter_map(|l| serde_json::from_str::<Value>(l).ok())
        .map(|m| m["request"].clone())
        .filter(|r| r["subtype"] == "get_usage")
        .collect();
    assert_eq!(scans, vec![json!({"subtype": "get_usage"})]);

    // A session that's only on disk is resumed, like `getOrResumeSession`.
    let reaped = "7c2e3a1c-2a52-4c3e-9b0e-2f7f1a1c0b21";
    let project = world.project.canonicalize().unwrap().display().to_string();
    let tdir = world
        .config
        .join("projects")
        .join(claudius_core::paths::sdk_project_dir_name(&project));
    std::fs::create_dir_all(&tdir).unwrap();
    let line = json!({"type": "user", "uuid": "r-u", "parentUuid": null, "sessionId": reaped,
                      "cwd": project, "timestamp": "2026-01-02T03:04:05.000Z",
                      "message": {"role": "user", "content": "hi"}});
    std::fs::write(tdir.join(format!("{reaped}.jsonl")), format!("{line}\n")).unwrap();
    let (st, body) = http(
        server.port,
        "GET",
        &format!("/api/sessions/{reaped}/usage-behaviors"),
        "",
    );
    assert_eq!(st, 200, "{body}");
    let body: Value = serde_json::from_str(&body).unwrap();
    assert_eq!(body["behaviors"]["day"]["requestCount"], 4);
}
