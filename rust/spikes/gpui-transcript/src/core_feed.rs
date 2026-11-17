//! The in-process path the native UI will use (U02): a `claudius_core`
//! `Session` resumed from a transcript (its own disk replay,
//! `transcript::session_messages`), subscribed in-process, with live turns
//! driven by the scripted fake CLI. Everything runs on a tokio thread; event
//! batches cross to the GPUI thread over a channel.
//!
//! Isolation: `$HOME` and the Claude config dir are pinned to a temp dir
//! before anything touches them, and the transcript is reached through a
//! symlink there, so nothing is written to the real `~/.claude`.

use std::path::{Path, PathBuf};
use std::time::Instant;

use claudius_core::session::{RuntimeOptions, SendOptions, Session, SessionOptions};
use futures::channel::mpsc as fmpsc;
use serde_json::Value;

pub enum Cmd {
    Send(String),
    Quit,
}

pub struct Feed {
    pub events: fmpsc::UnboundedReceiver<Vec<(Value, Instant)>>,
    pub cmd: tokio::sync::mpsc::UnboundedSender<Cmd>,
}

pub struct Sandbox {
    pub root: PathBuf,
    pub cwd: PathBuf,
}

/// Pin home + config dir under `root` (first call wins, process-wide).
pub fn isolate(root: &Path) -> Sandbox {
    let home = root.join("home");
    let config = root.join("config");
    let cwd = root.join("ws");
    for d in [&home, &config, &cwd] {
        std::fs::create_dir_all(d).expect("sandbox dir");
    }
    claudius_core::paths::set_home_override(home.clone());
    claudius_core::paths::set_config_dir_override(config.clone());
    // For anything that reads the env directly (and the fake CLI's children).
    // SAFETY: called on the main thread before any other thread starts.
    unsafe {
        std::env::set_var("HOME", &home);
        std::env::set_var("CLAUDE_CONFIG_DIR", &config);
    }
    let cwd = std::fs::canonicalize(&cwd).unwrap_or(cwd);
    Sandbox {
        root: root.to_path_buf(),
        cwd,
    }
}

/// Link `transcript` into the sandbox's projects dir as `<id>.jsonl`, where
/// `Session::start` looks for a resumed session (read-only: a symlink).
fn link_transcript(sb: &Sandbox, transcript: &Path, id: &str) {
    let dir = claudius_core::paths::sdk_projects_dir().join(
        claudius_core::paths::sdk_project_dir_name(&sb.cwd.display().to_string()),
    );
    std::fs::create_dir_all(&dir).expect("projects dir");
    let link = dir.join(format!("{id}.jsonl"));
    let _ = std::fs::remove_file(&link);
    std::os::unix::fs::symlink(transcript, &link).expect("symlink transcript");
}

/// `raw`: instead of resuming (which replays only the main chain after the
/// last compaction), broadcast the first N user/assistant entries of the
/// transcript in file order into a fresh session, for a 10k-event run made
/// of real content.
pub fn start(
    sb: &Sandbox,
    transcript: &Path,
    id: &str,
    fake_bin: &Path,
    script: &Path,
    raw: Option<usize>,
) -> Feed {
    if raw.is_none() {
        link_transcript(sb, transcript, id);
    }
    let transcript = transcript.to_path_buf();
    let (ev_tx, ev_rx) = fmpsc::unbounded::<Vec<(Value, Instant)>>();
    let (cmd_tx, mut cmd_rx) = tokio::sync::mpsc::unbounded_channel::<Cmd>();
    let cwd = sb.cwd.display().to_string();
    let id = id.to_string();
    let fake_bin = fake_bin.to_path_buf();
    let mut env = std::collections::HashMap::new();
    env.insert(
        "PATH".to_string(),
        std::env::var("PATH").unwrap_or_default(),
    );
    env.insert(
        "HOME".to_string(),
        sb.root.join("home").display().to_string(),
    );
    env.insert(
        "CLAUDE_CONFIG_DIR".to_string(),
        sb.root.join("config").display().to_string(),
    );
    env.insert(
        "FAKE_CLAUDE_SCRIPT".to_string(),
        script.display().to_string(),
    );
    std::thread::Builder::new()
        .name("claudius-core".into())
        .spawn(move || {
            let rt = tokio::runtime::Builder::new_multi_thread()
                .worker_threads(2)
                .enable_all()
                .build()
                .expect("tokio");
            rt.block_on(async move {
                let (resume, fresh_id) = if raw.is_some() {
                    (None, Some("0b0b0b0b-0000-4000-8000-000000000b0b".to_string()))
                } else {
                    (Some(id), None)
                };
                let session = Session::new(SessionOptions {
                    id: fresh_id,
                    resume,
                    cwd: Some(cwd),
                    model: Some("fake-model".into()),
                    runtime: RuntimeOptions {
                        claude_bin: Some(fake_bin),
                        env_override: Some(env),
                    },
                    ..Default::default()
                })
                .expect("session");
                // Subscribe before start: the disk replay fans out live, so the
                // UI gets every replayed event (the buffer keeps only 1000).
                let mut sub = session.subscribe(None, None);
                // `replay_done` goes out at subscribe time (the buffer is still
                // empty), so mark the end of `start()` (disk replay + CLI
                // spawn) with an event of our own, in stream order.
                let s2 = session.clone();
                tokio::spawn(async move {
                    if let Some(limit) = raw {
                        let text = std::fs::read_to_string(&transcript).unwrap_or_default();
                        let mut n = 0;
                        for line in text.lines() {
                            if n >= limit {
                                break;
                            }
                            let Ok(e) = serde_json::from_str::<Value>(line) else { continue };
                            let ty = e["type"].as_str().unwrap_or("");
                            if !(ty == "user" || ty == "assistant") || e["isSidechain"] == true {
                                continue;
                            }
                            s2.broadcast(serde_json::json!({"type": "sdk", "message": e}));
                            n += 1;
                        }
                    }
                    s2.start().await;
                    s2.broadcast(serde_json::json!({"type": "spike_replayed"}));
                });
                loop {
                    tokio::select! {
                        ev = sub.recv() => {
                            let Some(ev) = ev else { break };
                            let now = Instant::now();
                            let mut batch = vec![(ev, now)];
                            while let Ok(more) = sub.rx.try_recv() {
                                batch.push((more, now));
                            }
                            if ev_tx.unbounded_send(batch).is_err() {
                                break;
                            }
                        }
                        cmd = cmd_rx.recv() => match cmd {
                            Some(Cmd::Send(text)) => session.send_input(&text, &[], SendOptions::default()),
                            Some(Cmd::Quit) | None => break,
                        },
                    }
                }
                session.end().await;
            });
        })
        .expect("core thread");
    Feed {
        events: ev_rx,
        cmd: cmd_tx,
    }
}
