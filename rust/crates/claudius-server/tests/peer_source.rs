//! `GET /api/sessions/peer-source` against the real binary, replaying the
//! `route` steps of `claudius-core/tests/fixtures/peer_source_golden.json`
//! (recorded by `rust/scripts/peer-source-golden.mjs` from the real TS
//! handler and `resolvePeerSource`): the same disk ops under the server's
//! home (`CLAUDIUS_STATE_HOME`, which stands for `homedir()`; the accounts
//! root is its `.claude/.claudius`), in order, on one server, so the
//! resolver's cache sees the same history. Every request must answer the
//! same status, content type and body, byte for byte; a recorded throw is
//! Next's empty 500, and the server must log its `TypeError`.
//!
//! `@LIVE@` is this test process's pid. The recorder stubbed
//! `sessionManager.get` to know one session id; here that session is
//! started on the fake CLI (`resume`), so `hostedHere` comes from the live
//! session manager. Steps that rely on a mode-000 file or folder being
//! refused are skipped where the disk doesn't refuse it (root).
#![cfg(unix)]

mod common;
#[path = "../../claudius-core/tests/common_peer/mod.rs"]
mod common_peer;

use std::io::{Read, Write};
use std::net::TcpStream;
use std::time::Duration;

use common::{Server, World, http};
use common_peer::{apply, fixture, open_up, perms_enforced, sub};
use serde_json::{Value, json};

/// GET `target` → (status, content type, body).
fn get(port: u16, target: &str) -> (u16, Option<String>, String) {
    let mut s = TcpStream::connect(("127.0.0.1", port)).unwrap();
    write!(
        s,
        "GET {target} HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n"
    )
    .unwrap();
    let mut raw = Vec::new();
    s.read_to_end(&mut raw).unwrap();
    let raw = String::from_utf8(raw).unwrap();
    let (head, body) = raw.split_once("\r\n\r\n").unwrap();
    let status = head.split(' ').nth(1).unwrap().parse().unwrap();
    let ty = head.lines().find_map(|l| {
        let (k, v) = l.split_once(':')?;
        k.eq_ignore_ascii_case("content-type")
            .then(|| v.trim().to_owned())
    });
    (status, ty, body.to_owned())
}

const PATH: &str = "/api/sessions/peer-source";

#[test]
fn replays_the_ts_golden() {
    let fx = fixture();
    let world = World::new();
    let perms = perms_enforced();
    let accounts = world.home.join(".claude/.claudius");
    let server = Server::spawn(
        &world,
        &[("CLAUDIUS_ACCOUNTS_DIR", accounts.to_str().unwrap())],
    );
    let hosted = fx["route"]["hosted"].as_str().unwrap();
    let (st, out) = http(
        server.port,
        "POST",
        "/api/sessions",
        &json!({"resume": hosted, "cwd": world.project.display().to_string()}).to_string(),
    );
    assert_eq!(
        (
            st,
            serde_json::from_str::<Value>(&out).unwrap()["id"].as_str()
        ),
        (200, Some(hosted)),
        "{out}"
    );

    let mut threw = Vec::new();
    let (mut requests, mut skipped, mut fills) = (0, 0, 0);
    for (i, s) in fx["route"]["steps"].as_array().unwrap().iter().enumerate() {
        match s["op"].as_str().unwrap() {
            "get" => {
                if s["needsPerms"] == true && !perms {
                    skipped += 1;
                    continue;
                }
                requests += 1;
                let target = match s["query"].as_str() {
                    Some(q) => format!("{PATH}?{}", sub(q)),
                    None => PATH.to_owned(),
                };
                let got = get(server.port, &target);
                let want = match s["got"]["threw"].as_str() {
                    Some(t) => {
                        threw.push(t.to_owned());
                        (500, None, String::new())
                    }
                    None => (
                        s["got"]["status"].as_u64().unwrap() as u16,
                        s["got"]["type"].as_str().map(str::to_owned),
                        s["got"]["body"].as_str().unwrap().to_owned(),
                    ),
                };
                assert_eq!(got, want, "step #{i}: GET {target}");
            }
            "fill" => {
                // Distinct misses: only how many land in the cache matters,
                // so they go out at once.
                let n = s["n"].as_u64().unwrap() as usize;
                let port = server.port;
                std::thread::scope(|scope| {
                    for t in 0..8 {
                        scope.spawn(move || {
                            for k in (t..n).step_by(8) {
                                let target = format!("{PATH}?from=uds%3A%2Ftmp%2Ffill%2F{k}.sock");
                                let got = get(port, &target);
                                assert_eq!(
                                    (got.0, got.2.as_str()),
                                    (200, "{\"source\":null}"),
                                    "fill {k}"
                                );
                            }
                        });
                    }
                });
                fills += n;
            }
            _ => apply(&world.home, s),
        }
    }
    assert_eq!((requests + skipped, fills), (174, 498));

    let (_, log, _) = server.stop(Duration::from_secs(20));
    for t in &threw {
        assert!(
            log.contains(&format!("[api/sessions/peer-source] {t}")),
            "the server logs {t:?}:\n{log}"
        );
    }
    assert_eq!(threw.len(), 7);
    open_up(world.root.path());
}

/// Only GET (and its HEAD) is served here; nothing reaches Next.
#[test]
fn only_get_is_mounted() {
    let world = World::new();
    let server = Server::spawn(&world, &[]);
    let (st, body) = http(server.port, "POST", PATH, "{}");
    assert_eq!((st, body.as_str()), (405, ""));
    let (st, _) = http(server.port, "HEAD", &format!("{PATH}?pid=0"), "");
    assert_eq!(st, 200);
}
