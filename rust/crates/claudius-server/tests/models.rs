//! `GET /api/models` and `GET /api/models/probe` against the real binary,
//! replaying `claudius-core/tests/fixtures/models_golden.json` (recorded by
//! `rust/scripts/models-golden.mjs` from the real TS route handlers, with
//! the real SDK against the fake CLI).
//!
//! The server's `--claude-bin` is the recorded `wrapper`: the fake CLI with
//! its script picked by `--model=` (`<wrap>/scripts/<model>.json`) and that
//! model's argv, env and stdin logged under `<wrap>/wire/`.
//! * `fallback`: no session; one user settings.json per request, laid out as
//!   recorded (text, raw bytes, a directory, unreadable, a symlink, ...).
//! * `sessions`: per scenario a fresh server, its sessions created in the
//!   recorded order with `POST /api/sessions {cwd, model}` (so each CLI gets
//!   its session's script), then the requests: `GET /api/models`, then
//!   `GET /api/sessions/:id/model` of each session (the same curation).
//! * `probe`: the body, and per candidate the CLI's argv, the env the host
//!   added or removed (against the env the server was started with) and its
//!   stdin, normalized like the recorder; and no CLI outlives the answer.
//!
//! Every request must answer the recorded status, content type and body
//! (`threw` is Next's empty 500), except the listed [`DIFFERENCES`].
#![cfg(unix)]

mod common;

use std::collections::BTreeMap;
use std::io::{Read, Write};
use std::net::TcpStream;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

use claudius_agent::js;
use common::{World, fake_bin, free_port, http, wait_until};
use serde_json::{Map, Value, json};

fn fixture() -> Value {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../claudius-core/tests/fixtures/models_golden.json");
    serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap()
}

/// Fallback requests where Rust answers otherwise, and what it answers
/// instead (from the recorded body).
const DIFFERENCES: &[(&str, &str)] = &[
    (
        "a lone surrogate escape in an id",
        "`JSON.parse` keeps the lone surrogate, which `JSON.stringify` writes back \
         as `\\ud800`; `js::json_parse` reads it as U+FFFD",
    ),
    (
        "nesting past 128 elsewhere",
        "V8 parses any depth; serde_json stops at 128 levels, so the file doesn't \
         load and no curation applies",
    ),
];

/// `(case, candidate)` probe results where Rust answers otherwise.
const PROBE_DIFFERENCES: &[(&str, &str, &str)] = &[(
    "error results",
    "claude-opus-5",
    "an error `result` without an `errors` array makes the SDK's reader throw \
     (`e.errors.map`); the Rust reader yields the result, so the probe reports \
     its `subtype` (PORT_PLAN, SDK host: the reader's lenient shapes)",
)];

/// Keys the SDK host adds to the CLI env that the Rust host doesn't.
const ENV_DIFFERENCES: &[(&str, &str)] = &[(
    "NoDefaultCurrentDirectoryInExePath",
    "sdk.mjs sets it on its own `process.env` when it loads (only Windows reads it), \
     so every CLI spawned with an inherited env gets it",
)];

/// The world plus the wrapper directory and the env the server runs with.
struct Env {
    world: World,
    wrap: PathBuf,
    vars: BTreeMap<String, String>,
}

impl Env {
    fn new(fx: &Value) -> Env {
        let world = World::new();
        let wrap = world.root.path().join("wrap");
        std::fs::create_dir_all(wrap.join("scripts")).unwrap();
        std::fs::create_dir_all(wrap.join("wire")).unwrap();
        let wrapper = wrap.join("claude");
        std::fs::write(&wrapper, fx["wrapper"].as_str().unwrap()).unwrap();
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&wrapper, std::fs::Permissions::from_mode(0o755)).unwrap();
        let mut vars = BTreeMap::new();
        let mut set = |k: &str, v: &Path| vars.insert(k.to_owned(), v.display().to_string());
        set("HOME", &world.home);
        set("CLAUDIUS_STATE_HOME", &world.home);
        set("CLAUDE_CONFIG_DIR", &world.config);
        set("MODELS_WRAP_DIR", &wrap);
        set("MODELS_WRAP_FAKE", &fake_bin());
        vars.insert("PATH".into(), "/usr/bin:/bin:/usr/sbin:/sbin".into());
        Env { world, wrap, vars }
    }

    fn wrapper(&self) -> PathBuf {
        self.wrap.join("claude")
    }

    fn tmp(&self) -> String {
        self.world.root.path().display().to_string()
    }

    /// `scripts/<model>.json` per entry (a string is written as is), plus
    /// `default.json`; a fresh `wire/`.
    fn write_scripts(&self, scripts: &Map<String, Value>) {
        for d in ["scripts", "wire"] {
            let _ = std::fs::remove_dir_all(self.wrap.join(d));
            std::fs::create_dir_all(self.wrap.join(d)).unwrap();
        }
        std::fs::write(self.wrap.join("scripts/default.json"), "{}").unwrap();
        for (model, script) in scripts {
            let text = match script {
                Value::String(s) => s.clone(),
                v => js::stringify(v),
            };
            std::fs::write(self.wrap.join(format!("scripts/{model}.json")), text).unwrap();
        }
    }

    /// Lay out `~/.claude/settings.json` as the recorder did. `false` when
    /// the layout can't hold here (an unreadable file that root can read).
    fn apply_settings(&self, spec: &Value) -> bool {
        use std::os::unix::fs::PermissionsExt;
        let dir = self.world.home.join(".claude");
        let path = dir.join("settings.json");
        if spec["kind"] == "nodir" {
            let _ = std::fs::remove_dir_all(&dir);
            return true;
        }
        std::fs::create_dir_all(&dir).unwrap();
        for f in ["settings.json", "real.json"] {
            let p = dir.join(f);
            if p.is_dir() && !p.is_symlink() {
                std::fs::remove_dir_all(&p).unwrap();
            } else {
                let _ = std::fs::remove_file(&p);
            }
        }
        let text = || spec["text"].as_str().unwrap();
        match spec["kind"].as_str().unwrap() {
            "missing" => {}
            "text" => std::fs::write(&path, text()).unwrap(),
            "bytes" => {
                let bytes: Vec<u8> = spec["bytes"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|b| b.as_u64().unwrap() as u8)
                    .collect();
                std::fs::write(&path, bytes).unwrap();
            }
            "dir" => std::fs::create_dir(&path).unwrap(),
            "unreadable" => {
                std::fs::write(&path, text()).unwrap();
                std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o000)).unwrap();
                if std::fs::File::open(&path).is_ok() {
                    return false;
                }
            }
            "symlink" => {
                std::fs::write(dir.join("real.json"), text()).unwrap();
                std::os::unix::fs::symlink("real.json", &path).unwrap();
            }
            "dangling" => std::os::unix::fs::symlink("real.json", &path).unwrap(),
            other => panic!("unknown settings kind {other}"),
        }
        true
    }

    fn spawn(&self, claude_bin: &Path) -> Claudius {
        let port = free_port();
        let log = self.world.root.path().join(format!("server-{port}.log"));
        let mut cmd = Command::new(common::server_bin());
        cmd.args(["--port", &port.to_string(), "--no-next", "--claude-bin"])
            .arg(claude_bin)
            .current_dir(&self.world.project)
            .env_clear()
            .envs(&self.vars)
            .stdout(std::fs::File::create(&log).unwrap())
            .stderr(Stdio::null());
        let child = cmd.spawn().unwrap();
        let server = Claudius { child, port, log };
        wait_until("health", Duration::from_secs(20), || {
            TcpStream::connect(("127.0.0.1", port)).is_ok()
                && http(port, "GET", "/api/rust/health", "").0 == 200
        });
        server
    }
}

/// A `claudius` process; SIGTERM (it ends its sessions), then SIGKILL after
/// 5 s, when dropped.
struct Claudius {
    child: Child,
    port: u16,
    log: PathBuf,
}

impl Drop for Claudius {
    fn drop(&mut self) {
        let _ = Command::new("kill")
            .args(["-TERM", &self.child.id().to_string()])
            .stderr(Stdio::null())
            .status();
        let t0 = Instant::now();
        while t0.elapsed() < Duration::from_secs(5) {
            if !matches!(self.child.try_wait(), Ok(None)) {
                return;
            }
            std::thread::sleep(Duration::from_millis(10));
        }
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

/// `pid`'s child processes that haven't exited (zombies aside).
fn live_children(pid: u32) -> Vec<String> {
    let out = Command::new("ps")
        .args(["-A", "-o", "pid=,ppid=,stat="])
        .output()
        .unwrap();
    String::from_utf8_lossy(&out.stdout)
        .lines()
        .filter_map(|l| {
            let mut f = l.split_whitespace();
            let (child, parent, stat) = (f.next()?, f.next()?, f.next()?);
            (parent == pid.to_string() && !stat.starts_with('Z')).then(|| child.to_owned())
        })
        .collect()
}

/// `{status, type, body}` as the recorder writes it, or `{threw}` for an
/// empty 500 without a content type.
fn get(port: u16, path: &str) -> Value {
    let mut s = TcpStream::connect(("127.0.0.1", port)).unwrap();
    write!(
        s,
        "GET {path} HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n"
    )
    .unwrap();
    let mut out = Vec::new();
    s.read_to_end(&mut out).unwrap();
    let out = String::from_utf8(out).unwrap();
    let (head, body) = out.split_once("\r\n\r\n").unwrap();
    let status: u16 = head.split(' ').nth(1).unwrap().parse().unwrap();
    let content_type = head.split("\r\n").find_map(|l| {
        let (k, v) = l.split_once(':')?;
        k.eq_ignore_ascii_case("content-type")
            .then(|| v.trim().to_owned())
    });
    if status == 500 && content_type.is_none() && body.is_empty() {
        return json!({"threw": true});
    }
    json!({"status": status, "type": content_type, "body": body})
}

/// The recorded `got` with `threw`'s message dropped (only Next's log has it).
fn want_of(got: &Value) -> Value {
    if got.get("threw").is_some() {
        json!({"threw": true})
    } else {
        got.clone()
    }
}

/// The plain fallback answer (no settings file): what Rust serves for a
/// settings file that loads in V8 but not here.
fn rust_fallback_body(fx: &Value) -> Value {
    fx["fallback"]
        .as_array()
        .unwrap()
        .iter()
        .find(|c| c["name"] == "no settings.json")
        .unwrap()["got"]
        .clone()
}

#[test]
fn fallback_replays_the_ts_golden() {
    let fx = fixture();
    let env = Env::new(&fx);
    let server = env.spawn(&env.wrapper());
    let mut failures = vec![];
    let mut checked = 0;
    for c in fx["fallback"].as_array().unwrap() {
        let name = c["name"].as_str().unwrap();
        if !env.apply_settings(&c["settings"]) {
            eprintln!("skipped {name}: the file is readable here (root)");
            continue;
        }
        let got = get(server.port, "/api/models");
        let mut want = want_of(&c["got"]);
        match name {
            "a lone surrogate escape in an id" => {
                let body = want["body"]
                    .as_str()
                    .unwrap()
                    .replace("\\ud800", "\u{fffd}");
                want["body"] = json!(body);
            }
            "nesting past 128 elsewhere" => want = rust_fallback_body(&fx),
            _ => {}
        }
        if got != want {
            failures.push(format!("{name}\n  want {want}\n  got  {got}"));
        }
        checked += 1;
    }
    assert!(failures.is_empty(), "{}", failures.join("\n"));
    assert!(checked >= 80, "{checked} requests");
    // Each listed difference is a case that's still recorded.
    for (name, _) in DIFFERENCES {
        assert!(
            fx["fallback"]
                .as_array()
                .unwrap()
                .iter()
                .any(|c| c["name"] == *name)
        );
    }
    // A thrown curation is logged like Next logs it.
    let log = std::fs::read_to_string(&server.log).unwrap();
    assert!(
        log.contains(
            "[api/models] GET failed: TypeError: picker?.entries?.filter is not a function"
        ),
        "{log}"
    );
}

#[test]
fn sessions_replay_the_ts_golden() {
    let fx = fixture();
    let env = Env::new(&fx);
    let project = env.world.project.display().to_string();
    let mut failures = vec![];
    let mut checked = 0;
    for sc in fx["sessions"].as_array().unwrap() {
        let name = sc["name"].as_str().unwrap();
        let sessions = sc["sessions"].as_array().unwrap();
        let scripts: Map<String, Value> = sessions
            .iter()
            .map(|s| (s["model"].as_str().unwrap().to_owned(), s["script"].clone()))
            .collect();
        env.write_scripts(&scripts);
        env.apply_settings(&json!({"kind": "missing"}));
        let server = env.spawn(&env.wrapper());
        let mut ids = vec![];
        for s in sessions {
            let (st, body) = http(
                server.port,
                "POST",
                "/api/sessions",
                &json!({"cwd": project, "model": s["model"]}).to_string(),
            );
            assert_eq!(st, 200, "{name}: {body}");
            let id = serde_json::from_str::<Value>(&body).unwrap()["id"].clone();
            ids.push(id.as_str().unwrap().to_owned());
            // `list()` orders by creation time (ms): keep them apart.
            std::thread::sleep(Duration::from_millis(5));
        }
        if name.starts_with("a CLI that exited") {
            std::thread::sleep(Duration::from_millis(500));
        }
        for g in sc["gets"].as_array().unwrap() {
            assert!(env.apply_settings(&g["settings"]));
            let got = get(server.port, "/api/models");
            let want = want_of(&g["got"]);
            if got != want {
                failures.push(format!(
                    "{name} / {}\n  want {want}\n  got  {got}",
                    g["settings"]
                ));
            }
            // The session-scoped list, which shares the curation.
            for (per, id) in g["perSession"].as_array().unwrap().iter().zip(&ids) {
                let got = get(server.port, &format!("/api/sessions/{id}/model"));
                let want = want_of(&per["got"]);
                if got != want {
                    failures.push(format!(
                        "{name} / {} / GET /api/sessions/:id/model of {}\n  want {want}\n  got  {got}",
                        g["settings"], per["model"]
                    ));
                }
                checked += 1;
            }
        }
        drop(server);
    }
    assert!(failures.is_empty(), "{}", failures.join("\n"));
    assert!(checked >= 40, "{checked} session-scoped requests");
}

/// A wire log as the recorder normalized it.
fn wire_of(env: &Env, model: &str, shell_added: &[&str]) -> Value {
    let base = env.wrap.join("wire").join(model);
    let read = |ext: &str| std::fs::read_to_string(format!("{}.{ext}", base.display())).ok();
    let argv = read("argv.json").map(|t| serde_json::from_str::<Value>(&t).unwrap());
    let env_delta = read("env.json").map(|t| {
        let cli: BTreeMap<String, String> = serde_json::from_str(&t).unwrap();
        let mut added = Map::new();
        for (k, v) in &cli {
            if k.starts_with("FAKE_CLAUDE_")
                || k.starts_with("MODELS_GOLDEN_")
                || k.starts_with("__CF")
                || shell_added.contains(&k.as_str())
            {
                continue;
            }
            if env.vars.get(k) != Some(v) {
                added.insert(k.clone(), json!(v));
            }
        }
        let removed: Vec<&String> = env.vars.keys().filter(|k| !cli.contains_key(*k)).collect();
        json!({"added": added, "removed": removed})
    });
    let stdin = read("stdin.log").map(|t| {
        let mut ids: Vec<String> = vec![];
        let lines: Vec<Value> = t
            .lines()
            .filter(|l| !l.is_empty())
            .map(|l| {
                let mut m: Value = serde_json::from_str(l).unwrap();
                if let Some(id) = m
                    .get("request_id")
                    .and_then(Value::as_str)
                    .map(str::to_owned)
                {
                    let n = ids.iter().position(|x| *x == id).unwrap_or_else(|| {
                        ids.push(id);
                        ids.len() - 1
                    });
                    m["request_id"] = json!(format!("$ID{n}"));
                } else if m["type"] == "control_response" && m["response"]["request_id"].is_string()
                {
                    m["response"]["request_id"] = json!("$CLI_ID");
                }
                m
            })
            .collect();
        Value::Array(lines)
    });
    let v = json!({"argv": argv, "env": env_delta, "stdin": stdin});
    serde_json::from_str(&js::stringify(&v).replace(&env.tmp(), "$TMP")).unwrap()
}

#[test]
fn probe_replays_the_ts_golden() {
    let fx = fixture();
    let env = Env::new(&fx);
    let shell_added: Vec<&str> = fx["shellAdded"]
        .as_array()
        .unwrap()
        .iter()
        .map(|v| v.as_str().unwrap())
        .collect();
    let server = env.spawn(&env.wrapper());
    let mut failures = vec![];
    for p in fx["probe"].as_array().unwrap() {
        let name = p["name"].as_str().unwrap();
        env.write_scripts(p["scripts"].as_object().unwrap());
        let started = Instant::now();
        let got = match p["bin"].as_str() {
            Some(bin) => {
                let missing = env.spawn(Path::new(bin));
                get(missing.port, "/api/models/probe")
            }
            None => get(server.port, "/api/models/probe"),
        };
        let took = started.elapsed();
        // A probe that timed out took its full 20 s; the others didn't wait.
        // The probes run at once: two timeouts take 20 s, not 40.
        if p["slow"] == true {
            assert!(took >= Duration::from_secs(20), "{name}: {took:?}");
            assert!(took < Duration::from_secs(32), "{name}: {took:?}");
        } else {
            assert!(took < Duration::from_secs(15), "{name}: {took:?}");
        }
        // Each probe stops its CLI on the way out (TS aborts it in `finally`),
        // so none is left once the answer is in, even one asleep mid-turn.
        if p["bin"].is_null() {
            let pid = server.child.id();
            wait_until(
                &format!("{name}: the probe CLIs to end"),
                Duration::from_secs(3),
                || live_children(pid).is_empty(),
            );
        }
        let mut want = want_of(&p["got"]);
        if let Some(body) = want["body"].as_str() {
            let mut body: Value = serde_json::from_str(body).unwrap();
            for (case, model, _) in PROBE_DIFFERENCES {
                if *case != name {
                    continue;
                }
                let row = body["results"]
                    .as_array_mut()
                    .unwrap()
                    .iter_mut()
                    .find(|r| r["value"] == *model)
                    .unwrap();
                assert_eq!(
                    row["error"],
                    "Cannot read properties of undefined (reading 'map')"
                );
                row["error"] = json!("error_during_execution");
            }
            want["body"] = json!(js::stringify(&body));
        }
        if got != want {
            failures.push(format!("{name}\n  want {want}\n  got  {got}"));
        }
        // Let every closed CLI finish its logs, then check the wire.
        std::thread::sleep(Duration::from_millis(300));
        if let Some(wires) = p["wire"].as_object() {
            for (model, want) in wires {
                let mut want = want.clone();
                for (k, _) in ENV_DIFFERENCES {
                    if let Some(added) = want
                        .pointer_mut("/env/added")
                        .and_then(Value::as_object_mut)
                    {
                        assert!(added.shift_remove(*k).is_some(), "{name} {model}: no {k}");
                    }
                }
                let got = wire_of(&env, model, &shell_added);
                if js::stringify(&got) != js::stringify(&want) {
                    failures.push(format!(
                        "{name} / {model} wire\n  want {}\n  got  {}",
                        js::stringify(&want),
                        js::stringify(&got)
                    ));
                }
            }
        }
    }
    assert!(failures.is_empty(), "{}", failures.join("\n"));
}

/// A probe leaves like the TS `return` out of `for await`: it waits for its
/// CLI to exit, at most 2 s after the close. This one ignores its stdin's
/// EOF, so it answers once the CLI dies at the SIGTERM (R13).
#[test]
fn probe_waits_for_its_cli_like_return() {
    let tmp = tempfile::tempdir().unwrap();
    let wrapper = tmp.path().join("claude");
    let script = r#"{"on_eof": [{"$delay_ms": 60000}], "on_sigterm": "die"}"#;
    std::fs::write(
        &wrapper,
        format!(
            "#!/bin/sh\nFAKE_CLAUDE_SCRIPT='{script}' exec '{}' \"$@\"\n",
            fake_bin().display()
        ),
    )
    .unwrap();
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&wrapper, std::fs::Permissions::from_mode(0o755)).unwrap();
    }
    let rt = tokio::runtime::Runtime::new().unwrap();
    let started = Instant::now();
    let got = rt.block_on(claudius_core::models::probe_one(
        &claudius_core::models::PROBE_CANDIDATES[0],
        Some(wrapper),
        Duration::from_secs(20),
    ));
    let took = started.elapsed();
    assert_eq!(got["ok"], true, "{got}");
    assert!(
        took >= Duration::from_millis(1800) && took < Duration::from_millis(3500),
        "probe took {took:?}"
    );
}
