//! `GET/POST /api/fs/dirs` and `GET /api/fs/list` against what
//! `rust/scripts/fs-list-golden.mjs` recorded from the real TS route
//! handlers (`claudius-core/tests/fixtures/fs_list_golden.json`). Each
//! scenario's tree is rebuilt in a fresh temp root (`@@ROOT@@`), its steps
//! run in order, and every answer must match the recorded status, content
//! type and body text ("threw" is Next's empty 500); the tree afterwards
//! must match the recorded snapshot.
//! * `replays_on_the_binary`: the real `claudius` per scenario, with that
//!   scenario's `CLAUDIUS_FS_ROOT`, HOME and cwd, for this platform's
//!   recording (darwin on macOS, linux on Linux).
//! * `replays_in_process`: both recordings through `dirs_get_in` /
//!   `dirs_post_in` with the platform given, and every fs/list step the
//!   recorder kept the `listFs` call of through `list_fs_in` — its 200s and
//!   the CC 2.1.301 `Search failed: …` refusals of a cwd the walk can't
//!   read (its trusted-cwd refusals need the binary's cwd).
//!
//! Scenarios that need a case-folding disk, enforced permissions or BSD
//! immutable flags run only where the disk agrees with the recorder's
//! (`common_fs::can_replay`).
#![cfg(unix)]

mod common;
#[path = "../../claudius-core/tests/common_fs/mod.rs"]
mod common_fs;

use std::process::{Command, Stdio};
use std::time::Duration;

use axum::response::Response;
use claudius_agent::js;
use claudius_core::fs_list::{FsEntry, list_fs_in};
use claudius_core::node_path::resolve;
use claudius_core::tcc_protected::platform;
use claudius_server::fs_routes::{dirs_get_in, dirs_post_in, search_failed};
use common::{Payload, Server, free_port};
use common_fs::{Tree, can_replay, check, fixture, got, probe_disk};
use serde_json::{Value, json};

/// Steps whose Rust answer is a listed difference: (scenario, label, the
/// body Rust gives). A lone-surrogate escape in the name reads as U+FFFD
/// (`json_parse`); TS keeps the lone surrogate, creates the same `\u{fffd}`
/// directory (node writes paths as UTF-8) and prints it as `\ud800`.
const KNOWN: &[(&str, &str, &str)] = &[(
    "create",
    "lone surrogate",
    "{\"path\":\"@@ROOT@@/w/\u{fffd}\"}",
)];

/// The recorded `got`, or the listed difference for this step.
fn expected(scenario: &Value, step: &Value, used: &mut Vec<(String, String)>) -> Value {
    let name = scenario["name"].as_str().unwrap();
    let label = step["label"].as_str().unwrap();
    match KNOWN.iter().find(|(s, l, _)| *s == name && *l == label) {
        Some((_, _, body)) => {
            used.push((name.to_owned(), label.to_owned()));
            let mut want = got(scenario, step).clone();
            want["body"] = json!(body);
            want
        }
        None => got(scenario, step).clone(),
    }
}

/// The request body of a POST step, as bytes.
fn body_bytes(tree: &Tree, step: &Value) -> Vec<u8> {
    match step.get("bodyHex") {
        Some(h) => {
            let h = h.as_str().unwrap();
            (0..h.len())
                .step_by(2)
                .map(|i| u8::from_str_radix(&h[i..i + 2], 16).unwrap())
                .collect()
        }
        None => tree.sub(step["body"].as_str().unwrap()).into_bytes(),
    }
}

/// One raw HTTP/1.1 request (a JSON `Content-Type` and a `Content-Length`,
/// an empty body for `None`) → (status, content type, body).
fn request(
    port: u16,
    method: &str,
    target: &str,
    body: Option<&[u8]>,
) -> (u16, Option<String>, Vec<u8>) {
    let r = common::send(port, method, target, Payload::Json(body.unwrap_or(b"")));
    assert!(r.status != 0, "{method} {target}: {}", r.head);
    (r.status, r.content_type(), r.body)
}

/// `claudius --no-next` for one scenario: HOME and the CLI config in the
/// tree, its `CLAUDIUS_FS_ROOT` (or none), its cwd.
fn spawn(tree: &Tree, scenario: &Value) -> Server {
    let port = free_port();
    let mut cmd = Command::new(common::server_bin());
    cmd.args(["--port", &port.to_string(), "--no-next"])
        .current_dir(tree.path(scenario["cwd"].as_str().unwrap()))
        .env_remove("RUST_LOG")
        .env_remove("CLAUDIUS_DEBUG_SESSIONS")
        .env_remove("NODE_ENV")
        .env_remove("CLAUDIUS_DEV")
        .env_remove("CLAUDIUS_STATE_HOME")
        .env("HOME", tree.path("home"))
        .env("CLAUDE_CONFIG_DIR", tree.path("config"))
        .stdout(Stdio::null())
        .stderr(Stdio::piped());
    match scenario["env"].as_str() {
        Some(v) => cmd.env("CLAUDIUS_FS_ROOT", tree.sub(v)),
        None => cmd.env_remove("CLAUDIUS_FS_ROOT"),
    };
    let mut child = cmd.spawn().unwrap();
    common::wait_healthy(&mut child, port, Duration::from_secs(20));
    Server { child, port }
}

fn check_snapshot(scenario: &Value, platform: &str, tree: &Tree, failures: &mut Vec<String>) {
    let Some(want) = scenario["snap"].get(platform) else {
        return;
    };
    let mut want: Vec<String> = want
        .as_array()
        .unwrap()
        .iter()
        .map(|s| s.as_str().unwrap().to_owned())
        .collect();
    want.sort();
    let got = tree.snapshot();
    if got != want {
        let missing: Vec<_> = want.iter().filter(|w| !got.contains(w)).collect();
        let extra: Vec<_> = got.iter().filter(|g| !want.contains(g)).collect();
        failures.push(format!(
            "{} [{platform}] tree: missing {missing:?}, extra {extra:?}",
            scenario["name"]
        ));
    }
}

#[test]
fn replays_on_the_binary() {
    let fx = fixture();
    let disk = probe_disk();
    let platform = platform();
    if !matches!(platform, "darwin" | "linux") {
        return;
    }
    let mut failures = vec![];
    let mut used = vec![];
    let mut steps_run = 0;
    for s in fx["scenarios"].as_array().unwrap() {
        if !can_replay(&fx, s, disk) {
            continue;
        }
        let tree = Tree::new();
        tree.apply(&s["ops"]);
        let server = spawn(&tree, s);
        for step in s["steps"][platform].as_array().unwrap() {
            let want = expected(s, step, &mut used);
            let target = format!(
                "/api/fs/{}{}",
                step["route"].as_str().unwrap(),
                step["query"]
                    .as_str()
                    .map(|q| format!("?{}", tree.sub(q)))
                    .unwrap_or_default()
            );
            let method = step["method"].as_str().unwrap();
            let body = (method == "POST").then(|| body_bytes(&tree, step));
            let (status, ct, out) = request(server.port, method, &target, body.as_deref());
            steps_run += 1;
            let text = tree.unsub(&String::from_utf8_lossy(&out));
            if let Err(e) = check(&want, status, ct.as_deref(), &text) {
                failures.push(format!("{} [{platform}] {}: {e}", s["name"], step["label"]));
            }
        }
        drop(server);
        check_snapshot(s, platform, &tree, &mut failures);
    }
    assert!(
        failures.is_empty(),
        "{} differ:\n{}",
        failures.len(),
        failures.join("\n")
    );
    // Every listed difference still differs (a stale entry fails).
    for (s, l, _) in KNOWN {
        if fx["scenarios"]
            .as_array()
            .unwrap()
            .iter()
            .any(|x| x["name"] == *s && can_replay(&fx, x, disk))
        {
            assert!(
                used.iter().any(|(us, ul)| us == s && ul == l),
                "unused KNOWN entry {s} / {l}"
            );
        }
    }
    assert!(steps_run >= 200, "{steps_run} steps");
}

fn parts(r: Response) -> (u16, Option<String>, String) {
    let status = r.status().as_u16();
    let ct = r
        .headers()
        .get(axum::http::header::CONTENT_TYPE)
        .map(|v| v.to_str().unwrap().to_owned());
    let bytes =
        futures::executor::block_on(axum::body::to_bytes(r.into_body(), usize::MAX)).unwrap();
    (status, ct, String::from_utf8_lossy(&bytes).into_owned())
}

#[test]
fn replays_in_process() {
    let fx = fixture();
    let disk = probe_disk();
    let mut failures = vec![];
    let mut used = vec![];
    let mut steps_run = 0;
    for s in fx["scenarios"].as_array().unwrap() {
        if !can_replay(&fx, s, disk) {
            continue;
        }
        for platform in ["darwin", "linux"] {
            let tree = Tree::new();
            tree.apply(&s["ops"]);
            let root = tree.sub(s["fsRoot"].as_str().unwrap());
            let home = tree.path("home").to_str().unwrap().to_owned();
            for step in s["steps"][platform].as_array().unwrap() {
                let want = expected(s, step, &mut used);
                let query = step["query"].as_str().map(|q| tree.sub(q));
                let (status, ct, body) = match (
                    step["route"].as_str().unwrap(),
                    step["method"].as_str().unwrap(),
                ) {
                    ("dirs", "GET") => parts(dirs_get_in(&root, platform, query.as_deref())),
                    ("dirs", "POST") => parts(dirs_post_in(&root, &body_bytes(&tree, step))),
                    ("list", "GET") if !step["args"].is_null() => {
                        let a = &step["args"];
                        let cwd = tree.sub(a["cwd"].as_str().unwrap());
                        let limit = js::to_number(a["limit"].as_str().unwrap());
                        match list_fs_in(&home, platform, &cwd, a["q"].as_str().unwrap(), limit) {
                            Ok(listed) => {
                                let entries: Vec<Value> =
                                    listed.iter().map(FsEntry::to_json).collect();
                                let body =
                                    js::stringify(&json!({ "cwd": cwd, "entries": entries }));
                                (200, Some("application/json".to_owned()), body)
                            }
                            // CC 2.1.301: the walk's own root couldn't be
                            // read, so the search failed (403 / 500).
                            Err(e) => parts(search_failed(&e, &resolve(&[&cwd]))),
                        }
                    }
                    _ => continue,
                };
                steps_run += 1;
                if let Err(e) = check(&want, status, ct.as_deref(), &tree.unsub(&body)) {
                    failures.push(format!("{} [{platform}] {}: {e}", s["name"], step["label"]));
                }
            }
            check_snapshot(s, platform, &tree, &mut failures);
        }
    }
    assert!(
        failures.is_empty(),
        "{} differ:\n{}",
        failures.len(),
        failures.join("\n")
    );
    assert!(steps_run >= 450, "{steps_run} steps");
}

#[test]
fn other_methods_are_405() {
    let world = common::World::new();
    let server = Server::spawn(&world, &[]);
    for (path, methods) in [
        ("/api/fs/dirs", &["PUT", "PATCH", "DELETE"][..]),
        ("/api/fs/list", &["POST", "PUT", "PATCH", "DELETE"][..]),
    ] {
        for m in methods {
            let (st, _, _) = request(server.port, m, path, Some(b"{}"));
            assert_eq!(st, 405, "{m} {path}");
        }
    }
}
