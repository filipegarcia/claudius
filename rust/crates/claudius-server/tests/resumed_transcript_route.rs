//! R04 (CC 2.1.301) over the wire: the stream route's trailing `ready`
//! carries the resumed transcript's path, so the compaction row can say
//! where the earlier messages are saved. It lands AFTER the replay, and a
//! fresh session's `ready` has no such field (the client treats an absent
//! one as "no news").
#![cfg(unix)]

mod common;

use std::time::Duration;

use claudius_core::paths::{encode_project_dir, sdk_project_dir_name};
use common::{Server, World, read_until};
use serde_json::{Value, json};

/// Every `ready` frame on the stream, as parsed `data:` payloads.
fn readys(text: &str) -> Vec<Value> {
    text.lines()
        .filter_map(|l| l.strip_prefix("data: "))
        .filter_map(|l| serde_json::from_str::<Value>(l).ok())
        .filter(|e| e["type"] == "ready")
        .collect()
}

#[test]
fn a_resumed_stream_names_its_transcript_on_ready() {
    let world = World::new();
    let project = world.project.display().to_string();
    let id = "9f1c2d3e-4a5b-4c6d-8e9f-0a1b2c3d4e5f";
    let line = json!({"type":"user","uuid":"u1","parentUuid":null,"sessionId":id,"cwd":project,
        "timestamp":"2026-03-04T05:06:07.000Z","message":{"role":"user","content":"earlier question"}});
    let body = format!("{line}\n");
    // The CLI's own copy, which the resume replay reads.
    let sdk_dir = world
        .config
        .join("projects")
        .join(sdk_project_dir_name(&project));
    std::fs::create_dir_all(&sdk_dir).unwrap();
    std::fs::write(sdk_dir.join(format!("{id}.jsonl")), &body).unwrap();
    // The copy `findResumedTranscriptPath` looks for: the HOME's `.claude`,
    // not `$CLAUDE_CONFIG_DIR` (as in TS).
    let home_dir = world
        .home
        .join(".claude")
        .join("projects")
        .join(encode_project_dir(&project));
    std::fs::create_dir_all(&home_dir).unwrap();
    std::fs::write(home_dir.join(format!("{id}.jsonl")), &body).unwrap();

    let server = Server::spawn(&world, &[]);
    // A fresh session's `ready` frames carry no path.
    let fresh = server.create_session(&world);
    let mut fsse = server.open_stream(&fresh);
    let text = read_until(&mut fsse, r#""subtype":"init""#, Duration::from_secs(10));
    let fresh_readys = readys(&text);
    assert!(!fresh_readys.is_empty(), "{text}");
    for ev in &fresh_readys {
        assert!(ev.get("transcriptPath").is_none(), "{ev}");
    }
    drop(fsse);

    // The resumed one names it, home shortened to `~`.
    let want = format!(
        "~/.claude/projects/{}/{id}.jsonl",
        encode_project_dir(&project)
    );
    let mut sse = server.open_stream(id);
    let text = read_until(&mut sse, r#""subtype":"init""#, Duration::from_secs(20));
    let got = readys(&text);
    assert!(!got.is_empty(), "{text}");
    for ev in &got {
        assert_eq!(ev["transcriptPath"], json!(want), "{ev}");
    }
    // Reconnecting gets it again: the route's trailing `ready` is built per
    // request, after the replay.
    drop(sse);
    let mut again = server.open_stream(id);
    let text = read_until(
        &mut again,
        r#""type":"replay_done""#,
        Duration::from_secs(20),
    );
    let got = readys(&text);
    assert!(!got.is_empty(), "{text}");
    assert_eq!(got[0]["transcriptPath"], json!(want), "{text}");
}
