//! S31 on the real binary: `POST /api/sessions/:id/dev-broadcast` →
//! `Session::broadcast` → the process's notification bus → the inbox
//! (`GET /api/notifications`) and the toast stream
//! (`/api/notifications/stream`): the path `tests/e2e/notifications.spec.ts`
//! › "Session.broadcast still calls the bus" drives. What the bus writes at
//! each session emit site is `claudius-core`'s `session_notifications_golden`.
#![cfg(unix)]

mod common;

use std::io::Write;
use std::net::TcpStream;
use std::time::Duration;

use common::{Server, World, http, read_until, wait_until};
use serde_json::{Value, json};

const WS: &str = "wks_s31probe00";
const TAG: &str = "broadcast-probe-s31";

fn notifications_stream(port: u16) -> TcpStream {
    let mut sse = TcpStream::connect(("127.0.0.1", port)).unwrap();
    write!(
        sse,
        "GET /api/notifications/stream HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n"
    )
    .unwrap();
    read_until(&mut sse, "HTTP/1.1 200", Duration::from_secs(10));
    sse
}

fn inbox(port: u16) -> Vec<Value> {
    let path = format!("/api/notifications?workspace={WS}&limit=10");
    let (st, body) = http(port, "GET", &path, "");
    assert_eq!(st, 200, "{body}");
    let v: Value = serde_json::from_str(&body).unwrap();
    v["items"].as_array().unwrap().clone()
}

/// The row with its random id and time replaced, as text (key order counts).
fn normalized(row: &Value) -> String {
    let mut row = row.clone();
    let m = row.as_object_mut().unwrap();
    assert!(m["id"].is_string(), "{row:?}");
    assert!(m["createdAt"].is_number(), "{row:?}");
    m.insert("id".into(), json!("$N"));
    m.insert("createdAt".into(), json!("$T"));
    row.to_string()
}

#[test]
fn a_session_broadcast_reaches_the_inbox_and_the_toast_stream() {
    let world = World::new();
    let root = world.project.display().to_string();
    let ws_file = world.home.join(".claude/.claudius/workspaces.json");
    std::fs::create_dir_all(ws_file.parent().unwrap()).unwrap();
    let store = json!({"version": 1, "workspaces": [{
        "id": WS, "name": "Probe", "rootPath": root, "createdAt": 1, "updatedAt": 1,
        "defaults": {"notifications": {"enabledKinds": ["session_error"]}},
    }]});
    std::fs::write(&ws_file, store.to_string()).unwrap();
    let server = Server::spawn(&world, &[]);
    let id = server.create_session(&world);

    // A tab on the session (the e2e's bound page), so the row toasts too.
    let _tab = server.open_stream(&id);
    let mut toasts = notifications_stream(server.port);
    let (st, body) = http(
        server.port,
        "POST",
        &format!("/api/sessions/{id}/dev-broadcast"),
        &json!({"event": {"type": "error", "message": TAG}}).to_string(),
    );
    assert_eq!(st, 200, "{body}");
    let probe: Value = serde_json::from_str(&body).unwrap();
    assert_eq!(probe["sessionCwd"], root.as_str());

    let want = json!({
        "id": "$N", "workspaceId": WS, "sessionId": id, "runId": null, "jobId": null,
        "kind": "session_error", "title": "Session error", "body": TAG, "payload": null,
        "createdAt": "$T", "readAt": null,
    })
    .to_string();
    let seen = read_until(&mut toasts, TAG, Duration::from_secs(15));
    let line = seen
        .lines()
        .find(|l| l.starts_with("data: ") && l.contains(TAG))
        .unwrap_or_else(|| panic!("no data line in:\n{seen}"));
    let toast: Value = serde_json::from_str(&line["data: ".len()..]).unwrap();
    assert_eq!(toast["type"], "notification", "{line}");
    assert_eq!(
        toast.as_object().unwrap().keys().collect::<Vec<_>>(),
        ["type", "notification"]
    );
    assert_eq!(normalized(&toast["notification"]), want);

    wait_until("the inbox row", Duration::from_secs(15), || {
        inbox(server.port).iter().any(|r| r["body"] == TAG)
    });
    let items = inbox(server.port);
    let row = items.iter().find(|r| r["body"] == TAG).unwrap();
    assert_eq!(normalized(row), want);
    assert_eq!(row["id"], toast["notification"]["id"]);
}
