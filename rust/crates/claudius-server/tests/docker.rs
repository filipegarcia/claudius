//! `GET /api/docker/containers` against the real binary, replaying
//! `tests/fixtures/docker_golden.json` (recorded by
//! `rust/scripts/docker-golden.mjs` from the real TS route handler).
//!
//! The server runs with `PATH` at a temp bin dir holding only the recorded
//! fake `docker` (never the real one) and `FAKE_DOCKER_DIR` at a data dir.
//! Each case puts the same `docker` there (the fake, nothing, a 0644 copy, a
//! directory, a missing interpreter, no shebang), writes each verb's
//! snippet and output files, and must get the same status, content type
//! and body bytes (`sampledAt` must lie within the request and then stands
//! in for the recorded one), with each verb run with the same argv (or not
//! run), within the recorded time bounds. A case with `as` is a listed
//! difference: the port must answer what TS answered for `as` instead.
//! The two timeout groups run on their own servers, next to the rest.
#![cfg(unix)]

mod common;

use std::io::{Read, Write};
use std::net::TcpStream;
use std::os::unix::fs::PermissionsExt;
use std::path::PathBuf;
use std::sync::OnceLock;
use std::time::Instant;

use claudius_core::now_ms;
use claudius_core::reminders::sha256_hex;
use common::{Server, World};
use serde_json::{Value, json};

fn fixture() -> &'static Value {
    static FX: OnceLock<Value> = OnceLock::new();
    FX.get_or_init(|| {
        let path =
            PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/docker_golden.json");
        serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap()
    })
}

/// `(status, content type, body)` of a plain GET.
fn get(port: u16, path: &str) -> (u16, Option<String>, String) {
    let mut s = TcpStream::connect(("127.0.0.1", port)).unwrap();
    write!(
        s,
        "GET {path} HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n"
    )
    .unwrap();
    let mut out = vec![];
    s.read_to_end(&mut out).unwrap();
    let out = String::from_utf8(out).unwrap();
    let (head, body) = out.split_once("\r\n\r\n").unwrap();
    let status = head.split(' ').nth(1).unwrap().parse().unwrap();
    let content_type = head.split("\r\n").find_map(|l| {
        let (k, v) = l.split_once(':')?;
        k.eq_ignore_ascii_case("content-type")
            .then(|| v.trim().to_owned())
    });
    (status, content_type, body.to_owned())
}

struct Rig {
    // Keeps the temp dirs alive.
    world: World,
    bin: PathBuf,
    data: PathBuf,
    server: Server,
}

impl Rig {
    fn new() -> Rig {
        let world = World::new();
        let bin = world.root.path().join("bin");
        let data = world.root.path().join("data");
        std::fs::create_dir_all(&bin).unwrap();
        std::fs::create_dir_all(&data).unwrap();
        let env = [
            ("PATH", bin.to_str().unwrap().to_owned()),
            ("FAKE_DOCKER_DIR", data.to_str().unwrap().to_owned()),
        ];
        let env: Vec<(&str, &str)> = env.iter().map(|(k, v)| (*k, v.as_str())).collect();
        let mut rig = Rig {
            server: Server::spawn(&world, &env),
            world,
            bin,
            data,
        };
        // `free_port` can give two servers that start at once the same port,
        // and then the one that lost the bind exits while its health check
        // passes on the other: make sure this server runs this rig's fake.
        let probe = json!({"bin": "fake", "ps": {"sh": "exit 0"}, "stats": {"sh": "exit 0"}});
        for _ in 0..5 {
            rig.run(&probe);
            if !rig.argv("ps").is_null() {
                return rig;
            }
            rig.server = Server::spawn(&rig.world, &env);
        }
        panic!("no server of this rig's own answered");
    }

    /// The bin dir's `docker`, as the recorder made it.
    fn install(&self, kind: &str) {
        let p = self.bin.join("docker");
        if p.is_dir() {
            std::fs::remove_dir(&p).unwrap();
        } else if p.exists() {
            std::fs::remove_file(&p).unwrap();
        }
        let fx = fixture();
        let (text, mode) = match kind {
            "missing" => return,
            "dir" => return std::fs::create_dir(&p).unwrap(),
            "fake" => (&fx["fake"], 0o755),
            "noexec" => (&fx["fake"], 0o644),
            "badinterp" | "noshebang" => (&fx["bins"][kind], 0o755),
            other => panic!("bin {other}"),
        };
        std::fs::write(&p, text.as_str().unwrap()).unwrap();
        std::fs::set_permissions(&p, std::fs::Permissions::from_mode(mode)).unwrap();
    }

    fn write_verbs(&self, setup: &Value) {
        std::fs::remove_dir_all(&self.data).unwrap();
        std::fs::create_dir(&self.data).unwrap();
        for verb in ["ps", "stats"] {
            let v = &setup[verb];
            if v.is_null() {
                continue;
            }
            std::fs::write(
                self.data.join(format!("{verb}.sh")),
                v["sh"].as_str().unwrap(),
            )
            .unwrap();
            for k in ["out", "err"] {
                let bytes = match (&v[k], &v[format!("{k}Bytes")]) {
                    (Value::String(s), _) => s.as_bytes().to_vec(),
                    (_, Value::Array(b)) => b.iter().map(|n| n.as_u64().unwrap() as u8).collect(),
                    _ => continue,
                };
                std::fs::write(self.data.join(format!("{verb}.{k}")), bytes).unwrap();
            }
        }
    }

    fn argv(&self, verb: &str) -> Value {
        match std::fs::read(self.data.join(format!("{verb}.argv"))) {
            Ok(b) => {
                let text = String::from_utf8(b).unwrap();
                let mut args: Vec<&str> = text.split('\0').collect();
                assert_eq!(args.pop(), Some(""), "{text:?}");
                json!(args)
            }
            Err(_) => Value::Null,
        }
    }

    /// Run one case's setup; what this server answered, in the fixture's
    /// shape, how long it took, and how long after the request `sampledAt`
    /// was taken.
    fn run(&self, setup: &Value) -> (Value, u128, Option<i64>) {
        self.install(setup["bin"].as_str().unwrap());
        self.write_verbs(setup);
        let t0 = now_ms();
        let started = Instant::now();
        let (status, content_type, body) = get(self.server.port, "/api/docker/containers");
        let took = started.elapsed().as_millis();
        let t1 = now_ms();
        let (body, sampled) = recorded_clock(&body, t0, t1);
        let mut got = json!({"status": status, "type": content_type});
        if body.len() > 64 * 1024 {
            got["bodySha256"] = json!(sha256_hex(body.as_bytes()));
            got["bodyBytes"] = json!(body.len());
        } else {
            got["body"] = json!(body);
        }
        got["argv"] = json!({"ps": self.argv("ps"), "stats": self.argv("stats")});
        (got, took, sampled.map(|n| n - t0))
    }
}

/// An `ok` body's `sampledAt` (its last field) must be a clock reading
/// within the request; it is swapped for the recorder's pinned one.
fn recorded_clock(body: &str, t0: i64, t1: i64) -> (String, Option<i64>) {
    const KEY: &str = ",\"sampledAt\":";
    let Some(at) = body.rfind(KEY) else {
        return (body.to_owned(), None);
    };
    let n: i64 = body[at + KEY.len()..body.len() - 1].parse().unwrap();
    assert!((t0..=t1).contains(&n), "sampledAt {n} outside {t0}..={t1}");
    let pinned = fixture()["sampledAt"].as_i64().unwrap();
    (format!("{}{KEY}{pinned}}}", &body[..at]), Some(n))
}

/// Replay every case of `group` in order.
fn replay(rig: &Rig, group: &str) {
    let cases: Vec<&Value> = fixture()["cases"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|c| c["group"] == group)
        .collect();
    assert!(!cases.is_empty(), "no {group} cases");
    let mut failures = vec![];
    for c in &cases {
        let name = c["name"].as_str().unwrap();
        let (got, took, sampled_after) = rig.run(c);
        // A listed difference answers what TS answered for `as`.
        let want = if c["as"].is_null() {
            &c["got"]
        } else {
            assert_ne!(c["got"], c["gotAs"], "{name}: not a difference");
            &c["gotAs"]
        };
        if got != *want {
            failures.push(format!("{name}\n  want {want}\n  got  {got}"));
        }
        if let (Some(min), Some(max)) = (c["minMs"].as_u64(), c["maxMs"].as_u64())
            && !(u128::from(min)..=u128::from(max)).contains(&took)
        {
            failures.push(format!("{name}: took {took} ms, not {min}..={max}"));
        }
        // `sampledAt` is read before the runs start, not after them.
        if c["minMs"].as_u64().is_some_and(|min| min >= 2_000)
            && let Some(after) = sampled_after
            && after >= 1_000
        {
            failures.push(format!("{name}: sampledAt {after} ms into the request"));
        }
    }
    assert!(
        failures.is_empty(),
        "{} of {} {group} cases differ:\n{}",
        failures.len(),
        cases.len(),
        failures.join("\n")
    );
}

/// The groups that don't wait on a timeout, in order on one server.
#[test]
fn replays_the_ts_golden() {
    let rig = Rig::new();
    for group in [
        "fleet", "lines", "ids", "parse", "throws", "spawn", "daemon", "exit", "buffer",
    ] {
        replay(&rig, group);
    }
}

#[test]
fn ps_timeouts() {
    replay(&Rig::new(), "timing-ps");
}

#[test]
fn stats_timeouts() {
    replay(&Rig::new(), "timing-stats");
}

/// Every group in the fixture is replayed above, and the differences are
/// the listed ones.
#[test]
fn fixture_groups_and_differences() {
    let fx = fixture();
    let mut groups: Vec<&str> = fx["cases"]
        .as_array()
        .unwrap()
        .iter()
        .map(|c| c["group"].as_str().unwrap())
        .collect();
    groups.dedup();
    assert_eq!(
        groups,
        [
            "fleet",
            "lines",
            "ids",
            "parse",
            "throws",
            "spawn",
            "daemon",
            "exit",
            "timing-ps",
            "timing-stats",
            "buffer"
        ]
    );
    let diffs: Vec<&str> = fx["cases"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|c| !c["as"].is_null())
        .map(|c| c["name"].as_str().unwrap())
        .collect();
    assert_eq!(
        diffs,
        ["a line nested 1001 levels in an unused field", "no shebang"]
    );
    // The fake is the only `docker` the replay ever runs.
    assert!(fx["fake"].as_str().unwrap().starts_with("#!/bin/sh\n"));
}
