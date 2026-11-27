//! Sessions with transcripts on disk, for the sessions browser's live test
//! and screenshots: each made by the engine (`POST /api/sessions`) and a
//! real turn of the fake CLI, whose script writes the session's
//! `<config>/projects/<project>/<id>.jsonl` the way the real CLI does as it
//! runs (the fake writes none of its own), then answers. `#[path]`-included
//! next to `world.rs` (as `mod world`).
#![allow(dead_code)] // each includer uses a different part

use std::time::{Duration, SystemTime};

use claudius_app::data::{LiveStatus, ShellData, Workspace};
use claudius_core::paths;
use futures::executor::block_on;
use serde_json::{Value, json};

use crate::world::{World, wait_for};

/// One session to make: its git branch, its exchanges (the user's prompt,
/// the assistant's answer) in order, and how long ago they were written
/// (their timestamps).
pub struct Spec<'a> {
    pub branch: &'a str,
    pub turns: &'a [(&'a str, &'a str)],
    pub ago: Duration,
}

/// A made session: its id and its messages' uuids, in order (user,
/// assistant, user, …).
pub struct Seeded {
    pub id: String,
    pub uuids: Vec<String>,
}

/// The `n`-th session's `i`-th message uuid.
pub fn message_uuid(n: usize, i: usize) -> String {
    format!("{:08x}-5e55-4000-8000-{i:012x}", n + 1)
}

/// The transcript's JSONL text, its session id left as the fake CLI's
/// `$SESSION_ID` placeholder.
pub fn transcript(cwd: &str, n: usize, spec: &Spec<'_>) -> (String, Vec<String>) {
    let mut lines = Vec::new();
    let mut uuids = Vec::new();
    let mut parent = Value::Null;
    let stamp =
        (chrono::Utc::now() - spec.ago).to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
    for (user, assistant) in spec.turns {
        for (kind, text) in [("user", *user), ("assistant", *assistant)] {
            let uuid = message_uuid(n, uuids.len());
            let message = if kind == "user" {
                json!({"role": "user", "content": text})
            } else {
                json!({"id": format!("msg_{n}_{}", uuids.len()), "type": "message",
                       "role": "assistant", "model": "claude-fake",
                       "content": [{"type": "text", "text": text}],
                       "stop_reason": "end_turn", "usage": {"input_tokens": 1, "output_tokens": 1}})
            };
            lines.push(json!({
                "parentUuid": parent, "isSidechain": false, "userType": "external",
                "cwd": cwd, "sessionId": "$SESSION_ID", "version": "2.1.0",
                "gitBranch": spec.branch, "type": kind, "message": message,
                "uuid": uuid, "timestamp": stamp,
            }));
            parent = json!(uuid);
            uuids.push(uuid);
        }
    }
    let text = lines.iter().map(|l| format!("{l}\n")).collect::<String>();
    (text, uuids)
}

/// Where the CLI keeps `cwd`'s transcripts.
pub fn project_dir(cwd: &str) -> std::path::PathBuf {
    paths::sdk_projects_dir().join(paths::sdk_project_dir_name(cwd))
}

/// Makes the `n`-th session in `ws`: a new session, then one turn whose
/// script writes the transcript and answers; returns once the turn ended.
pub fn seed(w: &World, ws: &Workspace, n: usize, spec: &Spec<'_>, limit: Duration) -> Seeded {
    let id = block_on(w.data.create_session(&ws.id)).expect("POST /api/sessions");
    let idle = |id: &str| {
        let rows = block_on(w.data.sessions(&ws.id)).ok()?;
        rows.iter()
            .any(|r| r.id == id && r.status == Some(LiveStatus::Idle))
            .then_some(())
    };
    wait_for("the new session", limit, || idle(&id));
    let dir = project_dir(&ws.root_path);
    let (text, uuids) = transcript(&ws.root_path, n, spec);
    let file = dir.join(format!("{id}.jsonl"));
    let script = json!({
        "steps": [
            {"$fs": ["mkdir", dir.display().to_string()]},
            {"$fs": ["write", dir.join("$SESSION_ID.jsonl").display().to_string(), text]},
            {"$text": spec.turns.last().map_or("", |t| t.1)},
        ],
        "result": "done",
    });
    w.input(&ws.id, &id, &format!("script:{script}"));
    wait_for("the transcript", limit, || file.is_file().then_some(()));
    wait_for("the turn's end", limit, || idle(&id));
    Seeded { id, uuids }
}

/// Moves a transcript's modification time `ago` into the past (the list's
/// "updated" column and its order).
pub fn age(cwd: &str, id: &str, ago: Duration) {
    let f = std::fs::File::options()
        .write(true)
        .open(project_dir(cwd).join(format!("{id}.jsonl")))
        .expect("the transcript");
    f.set_modified(SystemTime::now() - ago).expect("set mtime");
}
