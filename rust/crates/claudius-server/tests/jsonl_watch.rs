//! S01 over the wire: with a session's SSE stream open, lines another client
//! appends to its JSONL (`claude --resume <id>` in a terminal) arrive on the
//! stream without a reconnect.
#![cfg(unix)]

mod common;

use std::io::Write;
use std::time::Duration;

use claudius_core::paths::sdk_project_dir_name;
use common::{Server, World, read_until, read_until_nudging};
use serde_json::json;

#[test]
fn external_jsonl_appends_reach_an_open_stream() {
    let world = World::new();
    let project = world.project.display().to_string();
    // The CLI's project dir for this cwd, as it exists once any session has
    // been written there.
    let dir = world
        .config
        .join("projects")
        .join(sdk_project_dir_name(&project));
    std::fs::create_dir_all(&dir).unwrap();
    let server = Server::spawn(&world, &[]);
    let id = server.create_session(&world);
    let mut sse = server.open_stream(&id);
    // The live CLI is up (its init is on the stream) before the outside write.
    // The deadlines here only bound a hang; under a loaded machine the CLI's
    // spawn and FSEvents both run seconds late (TODO I32).
    read_until(&mut sse, r#""subtype":"init""#, Duration::from_secs(30));

    let line = json!({"type":"user","uuid":"ext-1","parentUuid":null,"sessionId":id,"cwd":project,
        "timestamp":"2026-03-04T05:06:07.000Z","message":{"role":"user","content":"typed in a terminal"}});
    let file = dir.join(format!("{id}.jsonl"));
    let append = |text: &str| {
        let mut fh = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&file)
            .unwrap();
        writeln!(fh, "{text}").unwrap();
    };
    append(&line.to_string());

    // The watcher starts off the session's start path, and an FSEvents
    // stream can take seconds to come up: until it does, touch the file
    // again (a blank line, which the transcript read skips). Each resync
    // reads the whole file, so the line arrives with the first one.
    let got = read_until_nudging(
        &mut sse,
        r#""uuid":"ext-1""#,
        Duration::from_secs(60),
        || append(""),
    );
    let event = got
        .split("\n\n")
        .find(|e| e.contains(r#""uuid":"ext-1""#))
        .unwrap();
    // Each event is one HTTP chunk: skip the chunk-size line.
    let data = &event[event.find("data: ").unwrap() + "data: ".len()..];
    let ev: serde_json::Value = serde_json::from_str(data.lines().next().unwrap()).unwrap();
    assert_eq!(ev["type"], "sdk");
    assert_eq!(ev["message"]["message"]["content"], "typed in a terminal");
    assert_eq!(ev["at"], json!(1772600767000i64));
    drop(sse);
    server.stop(Duration::from_secs(15));
}
