//! A throwaway world for the live tests and the screenshots: a temporary
//! HOME and Claude config dir (never `~/.claude`), project folders, their
//! workspaces, and the engine in-process over the fake CLI
//! (`claudius-fake-claude`, never the real `claude`). `#[path]`-included.
#![allow(dead_code)] // each includer uses a different part

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::{Duration, Instant};

use claudius_app::data::Workspace;
use claudius_app::engine::{Backend, EngineOptions};
use claudius_app::live::TransportShellData;
use claudius_core::{paths, workspaces};
use claudius_transport::Request;
use serde_json::json;

pub struct World {
    pub root: tempfile::TempDir,
    pub backend: Arc<Backend>,
    pub data: Arc<TransportShellData>,
    pub workspaces: Vec<Workspace>,
}

/// Pins this process's HOME and config dir to a new temp dir, makes a
/// project folder and workspace per name, and starts the engine with
/// `claude_bin`. Once per process (the overrides are process-wide).
pub fn world(claude_bin: PathBuf, names: &[&str]) -> World {
    let root = tempfile::Builder::new()
        .prefix("claudius-app-world-")
        .tempdir()
        .unwrap();
    let home = root.path().join("home");
    let config = root.path().join("config");
    for d in [&home, &config] {
        std::fs::create_dir_all(d).unwrap();
    }
    assert!(paths::set_home_override(home), "one world per process");
    assert!(paths::set_config_dir_override(config));
    let mut made = Vec::new();
    for name in names {
        let dir = root
            .path()
            .join("projects")
            .join(name.to_lowercase().replace(' ', "-"));
        std::fs::create_dir_all(&dir).unwrap();
        let ws = workspaces::create(workspaces::NewWorkspace {
            name: (*name).into(),
            root_path: dir.canonicalize().unwrap().display().to_string(),
            icon: None,
            defaults: Some(
                json!({"permissionMode": "default"})
                    .as_object()
                    .unwrap()
                    .clone(),
            ),
        })
        .unwrap();
        let v = serde_json::to_value(&ws).unwrap();
        made.push(serde_json::from_value(v).unwrap());
    }
    let mut env = HashMap::new();
    env.insert("PATH".to_owned(), std::env::var("PATH").unwrap_or_default());
    // Every CLI appends the host's control requests here.
    env.insert(
        "FAKE_CLAUDE_CONTROL_LOG".to_owned(),
        root.path().join("control-log.jsonl").display().to_string(),
    );
    let backend = Arc::new(
        Backend::in_process(EngineOptions {
            claude_bin: Some(claude_bin),
            env_override: Some(env),
            scheduler: false,
        })
        .unwrap(),
    );
    let data = Arc::new(TransportShellData::new(backend.clone()));
    World {
        root,
        backend,
        data,
        workspaces: made,
    }
}

/// A fake-CLI turn that runs for `ms` before its result.
pub fn slow_turn(ms: u64) -> String {
    format!(r#"script:{{"steps":[{{"$text":"working"}},{{"$delay_ms":{ms}}}],"result":"done"}}"#)
}

impl World {
    /// `POST /api/sessions/<id>/input` (as the composer sends a prompt).
    pub fn input(&self, ws: &str, sid: &str, text: &str) {
        let t = self.data.page(ws);
        let url = format!("/api/sessions/{sid}/input");
        let body = json!({ "text": text }).to_string();
        let res = self
            .backend
            .handle()
            .block_on(async move { t.fetch(Request::post(url).json(body)).await })
            .unwrap();
        assert_eq!(res.status, 200, "{}", res.text());
    }

    /// The control requests the CLIs got so far, one JSON line each.
    pub fn control_log(&self) -> String {
        std::fs::read_to_string(self.root.path().join("control-log.jsonl")).unwrap_or_default()
    }

    /// Ends every session (their CLIs exit).
    pub fn shutdown(&self) {
        self.backend.shutdown(Duration::from_secs(10));
    }
}

pub fn wait_for<T>(what: &str, limit: Duration, mut f: impl FnMut() -> Option<T>) -> T {
    let t0 = Instant::now();
    loop {
        if let Some(v) = f() {
            return v;
        }
        assert!(t0.elapsed() < limit, "timed out waiting for {what}");
        std::thread::sleep(Duration::from_millis(20));
    }
}
