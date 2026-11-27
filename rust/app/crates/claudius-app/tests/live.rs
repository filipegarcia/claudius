//! [`TransportShellData`] over the engine in this process, against a
//! temporary HOME and the fake CLI (`claudius-fake-claude`), never the real
//! `claude` or `~/.claude`: the workspace list and `select`, the strip's
//! read / write round trip (scoped per workspace by its cookie), a session
//! created through the shell, its live status across a turn, the chat
//! ([`LiveChat`]) binding and going live, and the change notifications.
//!
//! One test: the HOME override and the session manager are per process.

#[path = "../../../../crates/claudius-agent/tests/support/test_bins.rs"]
mod test_bins;

use std::collections::HashMap;
use std::sync::Arc;
use std::time::{Duration, Instant};

use claudius_app::chat::LiveChat;
use claudius_app::data::{LiveStatus, OpenTabs, OpenTabsPut, ShellChange, ShellData};
use claudius_app::engine::{Backend, EngineOptions};
use claudius_app::live::TransportShellData;
use claudius_core::{paths, workspaces};
use claudius_transport::Request;
use futures::channel::mpsc::UnboundedReceiver;
use futures::executor::block_on;
use serde_json::json;

const A: &str = "8c1f0b2e-5d4a-4f7e-9a61-2b3c4d5e6f70";
const B: &str = "3e9a7c41-0b2d-4e8f-8c6a-1d2e3f405162";

/// A turn that runs for `ms` before its result.
fn slow_turn(ms: u64) -> String {
    format!(r#"script:{{"steps":[{{"$text":"working"}},{{"$delay_ms":{ms}}}],"result":"done"}}"#)
}

fn wait_for<T>(what: &str, limit: Duration, mut f: impl FnMut() -> Option<T>) -> T {
    let t0 = Instant::now();
    loop {
        if let Some(v) = f() {
            return v;
        }
        assert!(t0.elapsed() < limit, "timed out waiting for {what}");
        std::thread::sleep(Duration::from_millis(20));
    }
}

/// The changes received so far, without waiting.
fn drain(rx: &mut UnboundedReceiver<ShellChange>) -> Vec<ShellChange> {
    let mut out = Vec::new();
    while let Ok(c) = rx.try_recv() {
        out.push(c);
    }
    out
}

fn input(data: &TransportShellData, ws: &str, sid: &str, text: &str) {
    let t = data.page(ws);
    let url = format!("/api/sessions/{sid}/input");
    let body = json!({ "text": text }).to_string();
    let res = data
        .backend()
        .handle()
        .block_on(async move { t.fetch(Request::post(url).json(body)).await })
        .unwrap();
    assert_eq!(res.status, 200, "{}", res.text());
}

fn status_of(data: &TransportShellData, ws: &str, sid: &str) -> Option<LiveStatus> {
    block_on(data.sessions(ws))
        .unwrap()
        .into_iter()
        .find(|s| s.id == sid)
        .and_then(|s| s.status)
}

#[test]
fn the_shell_reads_and_writes_the_engine() {
    let root = tempfile::tempdir().unwrap();
    let home = root.path().join("home");
    let config = root.path().join("config");
    let p1 = root.path().join("proj-one");
    let p2 = root.path().join("proj-two");
    for d in [&home, &config, &p1, &p2] {
        std::fs::create_dir_all(d).unwrap();
    }
    paths::set_home_override(home.clone());
    paths::set_config_dir_override(config);
    let mk = |name: &str, p: &std::path::Path| {
        workspaces::create(workspaces::NewWorkspace {
            name: name.into(),
            root_path: p.canonicalize().unwrap().display().to_string(),
            icon: None,
            defaults: Some(
                json!({"permissionMode": "default"})
                    .as_object()
                    .unwrap()
                    .clone(),
            ),
        })
        .unwrap()
    };
    let w1 = mk("One", &p1);
    let w2 = mk("Two", &p2);

    let mut env = HashMap::new();
    env.insert("PATH".to_owned(), std::env::var("PATH").unwrap_or_default());
    let backend = Arc::new(
        Backend::in_process(EngineOptions {
            claude_bin: Some(test_bins::fake_claude()),
            env_override: Some(env),
            scheduler: false,
        })
        .unwrap(),
    );
    let data = TransportShellData::new(backend.clone());
    assert!(data.has_live_chat());
    let mut changes = data.subscribe();

    // ── the workspace list, and select
    let list = block_on(data.workspaces()).unwrap();
    let ids: Vec<&str> = list.workspaces.iter().map(|w| w.id.as_str()).collect();
    assert_eq!(ids, [w1.id.as_str(), w2.id.as_str()]);
    assert_eq!(list.workspaces[1].name, "Two");
    block_on(data.select_workspace(&w2.id)).unwrap();
    assert_eq!(
        block_on(data.workspaces()).unwrap().active_id.as_deref(),
        Some(w2.id.as_str()),
        "the front door's cookie"
    );
    assert_eq!(drain(&mut changes), [ShellChange::Workspaces]);
    let err = block_on(data.select_workspace("wks_000000000000")).unwrap_err();
    assert_eq!(err.to_string(), "not found");
    assert_eq!(drain(&mut changes), []);
    block_on(data.select_workspace(&w1.id)).unwrap();
    drain(&mut changes);

    // ── the strip: each workspace's own, through its cookie
    assert_eq!(
        block_on(data.open_tabs(&w1.id)).unwrap(),
        OpenTabs::default()
    );
    block_on(data.put_open_tabs(
        &w1.id,
        OpenTabsPut {
            tabs: Some(vec![A.into(), B.into()]),
            active_id: Some(Some(B.into())),
            pinned: Some(vec![A.into()]),
            label_max_width: None,
        },
    ))
    .unwrap();
    block_on(data.put_open_tabs(
        &w2.id,
        OpenTabsPut {
            label_max_width: Some(240.),
            ..Default::default()
        },
    ))
    .unwrap();
    let t1 = block_on(data.open_tabs(&w1.id)).unwrap();
    assert_eq!(
        (
            t1.tabs.as_slice(),
            t1.active_id.as_deref(),
            t1.pinned.as_slice()
        ),
        (
            [A.to_owned(), B.to_owned()].as_slice(),
            Some(B),
            [A.to_owned()].as_slice()
        )
    );
    assert_eq!(t1.label_max_width, 180.);
    let t2 = block_on(data.open_tabs(&w2.id)).unwrap();
    assert_eq!((t2.tabs.len(), t2.label_max_width), (0, 240.));
    assert_eq!(
        drain(&mut changes),
        [
            ShellChange::OpenTabs {
                workspace_id: w1.id.clone()
            },
            ShellChange::OpenTabs {
                workspace_id: w2.id.clone()
            }
        ]
    );
    // `null` clears the active tab.
    block_on(data.put_open_tabs(
        &w1.id,
        OpenTabsPut {
            active_id: Some(None),
            ..Default::default()
        },
    ))
    .unwrap();
    assert_eq!(block_on(data.open_tabs(&w1.id)).unwrap().active_id, None);
    drain(&mut changes);

    // ── a session made through the shell, in its workspace's cwd
    let sid = block_on(data.create_session(&w1.id)).unwrap();
    assert_eq!(
        drain(&mut changes),
        [ShellChange::Sessions {
            workspace_id: w1.id.clone()
        }]
    );
    let rows = block_on(data.sessions(&w1.id)).unwrap();
    let row = rows
        .iter()
        .find(|s| s.id == sid)
        .expect("listed in its workspace");
    assert_eq!(row.cwd, w1.root_path);
    assert!(
        block_on(data.sessions(&w2.id))
            .unwrap()
            .iter()
            .all(|s| s.id != sid),
        "not in the other workspace"
    );
    wait_for("the CLI idle", Duration::from_secs(30), || {
        (status_of(&data, &w1.id, &sid) == Some(LiveStatus::Idle)).then_some(())
    });

    // ── its status moves as the fake CLI runs a turn
    input(&data, &w1.id, &sid, &slow_turn(1500));
    wait_for("running", Duration::from_secs(30), || {
        (status_of(&data, &w1.id, &sid) == Some(LiveStatus::Running)).then_some(())
    });
    wait_for("idle again", Duration::from_secs(30), || {
        (status_of(&data, &w1.id, &sid) == Some(LiveStatus::Idle)).then_some(())
    });

    // ── the chat binds the session and goes live
    let href = format!("http://localhost/{}?session={sid}", w1.id);
    let page = data
        .open_chat(&w1.id, &href, &format!("/{}", w1.id))
        .expect("a live chat");
    let chat: LiveChat = page.chat;
    assert_eq!(chat.workspace_id(), w1.id);
    wait_for("the chat bound and ready", Duration::from_secs(30), || {
        let s = chat.state();
        (s.session_id.as_deref() == Some(sid.as_str()) && s.ready && !s.catching_up).then_some(())
    });
    assert_eq!(chat.state().stream_status, "live");
    // Its boot refreshed the session list: the shell is told.
    wait_for("a sessions change", Duration::from_secs(10), || {
        drain(&mut changes)
            .contains(&ShellChange::Sessions {
                workspace_id: w1.id.clone(),
            })
            .then_some(())
    });
    let before = chat.state().messages.len();
    input(&data, &w1.id, &sid, &slow_turn(1200));
    wait_for("the chat sees the turn", Duration::from_secs(30), || {
        chat.state().pending.then_some(())
    });
    wait_for("the turn's end", Duration::from_secs(30), || {
        let s = chat.state();
        (!s.pending && s.messages.len() > before).then_some(())
    });
    // A list that moved again (a rename, re-read as the page comes back
    // into view) is the cue again. (The turn's `result` refreshes it too,
    // but its rows may read as they did before the turn.)
    let t = data.page(&w1.id);
    let body = json!({ "sessionId": sid, "title": "Renamed" }).to_string();
    let res = data
        .backend()
        .handle()
        .block_on(async move {
            t.fetch(Request::post("/api/sessions/rename").json(body))
                .await
        })
        .unwrap();
    assert!(res.ok(), "{}", res.text());
    drain(&mut changes);
    chat.act(|s, env| s.visibility_changed(false, env));
    wait_for(
        "the renamed row in the chat's list",
        Duration::from_secs(10),
        || {
            chat.state()
                .sessions
                .iter()
                .any(|r| r["id"] == sid.as_str() && r["title"] == "Renamed")
                .then_some(())
        },
    );
    wait_for(
        "a sessions change after the rename",
        Duration::from_secs(10),
        || {
            drain(&mut changes)
                .contains(&ShellChange::Sessions {
                    workspace_id: w1.id.clone(),
                })
                .then_some(())
        },
    );
    // "+": the chat makes a fresh session in its workspace and binds it.
    let seq = chat.act(|s, env| s.create_new_session(env));
    let fresh = wait_for("a fresh session", Duration::from_secs(30), || {
        let snap = chat.snapshot();
        let id = snap.state.session_id.clone()?;
        (snap.applied >= seq && id != sid).then_some(id)
    });
    let rows = block_on(data.sessions(&w1.id)).unwrap();
    assert!(rows.iter().any(|s| s.id == fresh), "in its workspace");
    // Switching back.
    let to = sid.clone();
    chat.act(move |s, env| s.switch_session(&to, env));
    wait_for("switched back", Duration::from_secs(30), || {
        (chat.session_id().as_deref() == Some(sid.as_str())).then_some(())
    });

    // ── the icon and the customizations routes
    assert_eq!(block_on(data.workspace_icon(&w1.id)).unwrap(), None);
    let png = [0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a];
    workspaces::write_icon(&w1.id, "png", &png).unwrap();
    workspaces::update(
        &w1.id,
        json!({"icon": {"kind": "image", "ext": "png"}})
            .as_object()
            .unwrap()
            .clone(),
    )
    .unwrap();
    let icon = block_on(data.workspace_icon(&w1.id))
        .unwrap()
        .expect("an icon");
    assert_eq!(
        (icon.bytes.as_slice(), icon.content_type.as_str()),
        (&png[..], "image/png")
    );
    assert_eq!(block_on(data.customizations()).unwrap(), Some(vec![]));

    // ── unmount: dropping the chat closes its stream
    drop(chat);
    backend.shutdown(Duration::from_secs(10));
    assert!(backend.engine().unwrap().state().mgr.list().is_empty());
}
