//! The notification routes (`/api/notifications`, `counts`, `[id]/read`,
//! `read-all`, `read-by-kind`, `read-by-session`, `dev-emit`) and their SSE
//! (`stream`) against the real binary, replaying the `steps` of
//! `claudius-core/tests/fixtures/notifications_routes_golden.json`
//! (recorded by `rust/scripts/notifications-routes-golden.mjs` from the real
//! TS routes on the real bus and DB layer): the same workspaces.json texts
//! (with the same mtimes), the same hand-written SQL, the same requests, and
//! a `monitor` stream open from the first step to the last next to the
//! short-lived ones. Every request must answer the same status, content type
//! and body text ("threw" is Next's empty 500), every stream receive the
//! same chunks (HTTP chunks, one per TS `enqueue`) during the same step, and
//! every watched cwd's notifications rows dump the same stored types and
//! values.
//!
//! The recorder pinned the clock (`base + n * 1_000_003` for the n-th
//! request) and the row ids (`00000000-0000-4000-a000-<n>`); this server
//! runs on the real ones. A row the recorder stamped with a request's clock
//! must carry a time within that request here, and a recorded id must be a
//! fresh UUID; from then on the actual value stands in for the recorded one
//! in bodies, chunks, paths (`$ID<n>`) and dumps. Requests are spaced so no
//! two share a millisecond.
//!
//! TS's dev-emit races its `getAllWorkspaceStates` against the bus's
//! coalesced flush (`setTimeout(…, 0)`); the recorder ran the flush last.
//! Here it is due 1 ms after the event, so on a loaded machine it can run
//! first: that step's `state` chunk then carries the version one below the
//! recorded one, which is accepted (and counted).
//!
//! The `ping` step (a heartbeat the recorder fired by hand) and the
//! stream's unsubscribe on close are checked in-process below, as is the
//! 15 s period (a real heartbeat that lands during a slow replay is
//! skipped); `prod` requests go to a second binary with the dev routes off.
#![cfg(unix)]

mod common;

use std::collections::{BTreeMap, HashMap, VecDeque};
use std::io::{Read, Write};
use std::net::TcpStream;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant, UNIX_EPOCH};

use axum::body::Bytes;
use claudius_agent::js;
use claudius_core::notification_bus::{BusOptions, NotificationBus, Timers};
use claudius_core::session_manager::SessionManager;
use claudius_core::{js_num, now_ms, paths};
use claudius_server::AppState;
use claudius_server::notifications::{HEARTBEAT, event_stream};
use common::{Server, World};
use futures::StreamExt;
use rusqlite::types::ValueRef;
use serde_json::{Value, json};

fn fixture() -> Value {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../claudius-core/tests/fixtures/notifications_routes_golden.json");
    serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap()
}

/// `(status, content type, body)`.
fn request(
    port: u16,
    method: &str,
    path: &str,
    body: Option<&str>,
    cookie: Option<&str>,
) -> (u16, Option<String>, String) {
    let mut s = TcpStream::connect(("127.0.0.1", port)).unwrap();
    let mut head = format!("{method} {path} HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n");
    if let Some(c) = cookie {
        head.push_str(&format!("Cookie: {c}\r\n"));
    }
    if method == "POST" {
        head.push_str("Content-Type: application/json\r\n");
    }
    let body = body.unwrap_or("");
    head.push_str(&format!("Content-Length: {}\r\n\r\n", body.len()));
    s.write_all(head.as_bytes()).unwrap();
    s.write_all(body.as_bytes()).unwrap();
    let mut out = Vec::new();
    s.read_to_end(&mut out).unwrap();
    let out = String::from_utf8(out).unwrap();
    let (head, body) = out.split_once("\r\n\r\n").unwrap();
    let status = head.split(' ').nth(1).unwrap().parse().unwrap();
    let content_type = header(head, "content-type");
    (status, content_type, body.to_owned())
}

fn header(head: &str, name: &str) -> Option<String> {
    head.split("\r\n").find_map(|l| {
        let (k, v) = l.split_once(':')?;
        k.eq_ignore_ascii_case(name).then(|| v.trim().to_owned())
    })
}

/// An open `/api/notifications/stream`, decoded chunk by chunk.
struct Sse {
    sock: TcpStream,
    buf: Vec<u8>,
    chunks: VecDeque<String>,
}

impl Sse {
    /// Connect; the status and the four headers the recorder kept.
    fn open(port: u16) -> (Sse, Value) {
        let mut sock = TcpStream::connect(("127.0.0.1", port)).unwrap();
        write!(
            sock,
            "GET /api/notifications/stream HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n"
        )
        .unwrap();
        sock.set_read_timeout(Some(Duration::from_millis(50)))
            .unwrap();
        let mut sse = Sse {
            sock,
            buf: Vec::new(),
            chunks: VecDeque::new(),
        };
        let start = Instant::now();
        let end = loop {
            if let Some(at) = sse.buf.windows(4).position(|w| w == b"\r\n\r\n") {
                break at;
            }
            assert!(start.elapsed() < Duration::from_secs(10), "no stream head");
            sse.read_some();
        };
        let head = String::from_utf8(sse.buf[..end].to_vec()).unwrap();
        sse.buf.drain(..end + 4);
        assert_eq!(
            header(&head, "transfer-encoding").as_deref(),
            Some("chunked")
        );
        let mut headers = serde_json::Map::new();
        for k in [
            "content-type",
            "cache-control",
            "connection",
            "x-accel-buffering",
        ] {
            headers.insert(k.into(), json!(header(&head, k)));
        }
        let status: u16 = head.split(' ').nth(1).unwrap().parse().unwrap();
        (sse, json!({"status": status, "headers": headers}))
    }

    /// One read (at most 50 ms), then every whole chunk in the buffer.
    fn fill(&mut self) {
        self.read_some();
        self.decode();
    }

    /// One read, at most 50 ms.
    fn read_some(&mut self) {
        let mut b = [0u8; 16384];
        match self.sock.read(&mut b) {
            Ok(0) => panic!("the stream closed"),
            Ok(n) => self.buf.extend_from_slice(&b[..n]),
            Err(e)
                if matches!(
                    e.kind(),
                    std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut
                ) => {}
            Err(e) => panic!("{e}"),
        }
    }

    /// Every whole chunk in the buffer.
    fn decode(&mut self) {
        loop {
            let Some(eol) = self.buf.windows(2).position(|w| w == b"\r\n") else {
                return;
            };
            let size = std::str::from_utf8(&self.buf[..eol]).unwrap();
            let size = usize::from_str_radix(size.split(';').next().unwrap(), 16).unwrap();
            assert!(size > 0, "the stream ended");
            if self.buf.len() < eol + 2 + size + 2 {
                return;
            }
            let data = self.buf[eol + 2..eol + 2 + size].to_vec();
            assert_eq!(&self.buf[eol + 2 + size..eol + 4 + size], b"\r\n");
            self.buf.drain(..eol + 4 + size);
            // A heartbeat (the run took 15 s): the recorder never armed
            // them; the in-process test below covers them.
            if data != b": ping\n\n" {
                self.chunks.push_back(String::from_utf8(data).unwrap());
            }
        }
    }

    /// The next `n` chunks, once they have come; reads on for `quiet` after.
    fn take(&mut self, n: usize, quiet: Duration) -> Vec<String> {
        let start = Instant::now();
        while self.chunks.len() < n {
            assert!(
                start.elapsed() < Duration::from_secs(10),
                "{} of {n} chunks: {:?}",
                self.chunks.len(),
                self.chunks
            );
            self.fill();
        }
        let quiet_start = Instant::now();
        while quiet_start.elapsed() < quiet {
            self.fill();
        }
        self.chunks.drain(..n.min(self.chunks.len())).collect()
    }
}

const COLS: [&str; 11] = [
    "id",
    "session_id",
    "run_id",
    "job_id",
    "kind",
    "title",
    "body",
    "payload",
    "request_id",
    "created_at",
    "read_at",
];

/// A notifications table as the recorder dumps it: per row, `[typeof,
/// value]` per column, integers as their decimal text, blobs as hex.
fn dump(path: &Path) -> Option<Vec<Value>> {
    if !path.exists() {
        return None;
    }
    let c = rusqlite::Connection::open_with_flags(path, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)
        .unwrap();
    let cols: Vec<String> = COLS
        .iter()
        .map(|c| format!("typeof({c}), CASE typeof({c}) WHEN 'integer' THEN CAST({c} AS TEXT) WHEN 'blob' THEN hex({c}) ELSE {c} END"))
        .collect();
    let sql = format!(
        "SELECT {} FROM notifications ORDER BY rowid",
        cols.join(", ")
    );
    let mut st = c.prepare(&sql).unwrap();
    let rows = st
        .query_map([], |r| {
            let mut row = Vec::new();
            for i in 0..COLS.len() {
                let ty: String = r.get(2 * i)?;
                let v = match r.get_ref(2 * i + 1)? {
                    ValueRef::Null => Value::Null,
                    ValueRef::Integer(n) => json!(n),
                    ValueRef::Real(f) => js_num(f),
                    ValueRef::Text(t) => json!(String::from_utf8_lossy(t)),
                    ValueRef::Blob(_) => unreachable!("hexed"),
                };
                row.push(json!([ty, v]));
            }
            Ok(Value::Array(row))
        })
        .unwrap()
        .collect::<rusqlite::Result<Vec<_>>>()
        .unwrap();
    Some(rows)
}

/// The recorder's `rowsDiff`: `None` when nothing changed.
fn rows_diff(prev: &Option<Vec<Value>>, now: &Option<Vec<Value>>) -> Option<Value> {
    let Some(now) = now else {
        return prev.as_ref().map(|_| Value::Null);
    };
    let Some(prev) = prev else {
        let changed: Vec<Value> = now.iter().enumerate().map(|(i, r)| json!([i, r])).collect();
        return Some(json!({"len": now.len(), "changed": changed}));
    };
    let changed: Vec<Value> = now
        .iter()
        .enumerate()
        .filter(|(i, r)| prev.get(*i) != Some(*r))
        .map(|(i, r)| json!([i, r]))
        .collect();
    if changed.is_empty() && now.len() == prev.len() {
        return None;
    }
    Some(json!({"len": now.len(), "changed": changed}))
}

/// Recorded text → this server's: ids and clock readings.
#[derive(Default)]
struct Subst {
    pairs: BTreeMap<String, String>,
}

impl Subst {
    fn apply(&self, s: &str) -> String {
        let mut s = s.to_owned();
        for (x, y) in &self.pairs {
            if s.contains(x.as_str()) {
                s = s.replace(x.as_str(), y);
            }
        }
        s
    }

    fn apply_value(&self, v: &Value) -> Value {
        serde_json::from_str(&self.apply(&v.to_string())).unwrap()
    }

    /// Learn from a step's row changes: a recorded id is a fresh UUID here,
    /// a recorded `clock` a time within `t0..=t1`.
    fn learn(
        &mut self,
        want: &Value,
        got: &Value,
        clock: Option<&str>,
        t0: i64,
        t1: i64,
    ) -> Result<(), String> {
        let (Some(want), Some(got)) = (want["changed"].as_array(), got["changed"].as_array())
        else {
            return Ok(());
        };
        for (w, g) in want.iter().zip(got) {
            if w[0] != g[0] {
                continue;
            }
            for (wc, gc) in w[1]
                .as_array()
                .unwrap()
                .iter()
                .zip(g[1].as_array().unwrap())
            {
                let (Some(wv), Some(gv)) = (wc[1].as_str(), gc[1].as_str()) else {
                    continue;
                };
                if self.pairs.contains_key(wv) {
                    continue;
                }
                if wv.starts_with("00000000-0000-4000-a000-") {
                    let ok = uuid::Uuid::parse_str(gv).is_ok_and(|u| u.get_version_num() == 4);
                    if !ok {
                        return Err(format!("{wv} is {gv}, not a v4 uuid"));
                    }
                    self.pairs.insert(wv.to_owned(), gv.to_owned());
                } else if Some(wv) == clock && wc[0] == "integer" {
                    let t: i64 = gv.parse().map_err(|_| format!("{wv} is {gv}"))?;
                    if !(t0..=t1).contains(&t) {
                        return Err(format!("{wv} is {gv}, not in {t0}..={t1}"));
                    }
                    self.pairs.insert(wv.to_owned(), gv.to_owned());
                }
            }
        }
        Ok(())
    }
}

/// A `data: {"type":"state",…}` chunk one version below `want`, else equal.
fn one_version_below(want: &str, got: &str) -> bool {
    let parse = |c: &str| -> Option<Value> {
        serde_json::from_str(c.strip_prefix("data: ")?.strip_suffix("\n\n")?).ok()
    };
    let (Some(mut w), Some(g)) = (parse(want), parse(got)) else {
        return false;
    };
    if w["type"] != "state" {
        return false;
    }
    let Some(v) = w["version"].as_u64() else {
        return false;
    };
    w["version"] = json!(v - 1);
    js::stringify(&w) == js::stringify(&g)
}

#[test]
fn replays_the_ts_golden() {
    let fx = fixture();
    let world = World::new();
    let server = Server::spawn(&world, &[]);
    let mut prod: Option<(World, Server)> = None;
    let ws_file = world.home.join(".claude/.claudius/workspaces.json");
    let db_path = |cwd: &str| {
        world
            .home
            .join(".claude/projects")
            .join(paths::encode_project_dir(cwd))
            .join(".claudius.db")
    };
    let watch: Vec<String> = fx["watch"]
        .as_array()
        .unwrap()
        .iter()
        .map(|c| c.as_str().unwrap().to_owned())
        .collect();
    let mut last: HashMap<String, Option<Vec<Value>>> =
        watch.iter().map(|c| (c.clone(), None)).collect();
    let mut streams: BTreeMap<String, Sse> = BTreeMap::new();
    let mut subst = Subst::default();
    let mut failures = vec![];
    let (mut requests, mut chunks, mut raced) = (0, 0, 0);
    let mut prev_request = Instant::now();
    let steps = fx["steps"].as_array().unwrap();
    for (i, s) in steps.iter().enumerate() {
        let op = s["op"].as_str().unwrap();
        let (mut t0, mut t1) = (0, 0);
        let mut dev_emit = false;
        let mut pending: Option<(String, String, Value)> = None;
        match op {
            "ws" => match s["text"].as_str() {
                None => {
                    let _ = std::fs::remove_file(&ws_file);
                }
                Some(text) => {
                    std::fs::create_dir_all(ws_file.parent().unwrap()).unwrap();
                    std::fs::write(&ws_file, text).unwrap();
                    let mtime = UNIX_EPOCH + Duration::from_secs(s["mtime"].as_u64().unwrap());
                    std::fs::File::options()
                        .write(true)
                        .open(&ws_file)
                        .unwrap()
                        .set_modified(mtime)
                        .unwrap();
                }
            },
            "sql" => {
                let path = db_path(s["cwd"].as_str().unwrap());
                if s["fresh"] == true {
                    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
                }
                let c = rusqlite::Connection::open(&path).unwrap();
                if s["fresh"] == true {
                    c.pragma_update(None, "journal_mode", "WAL").unwrap();
                }
                c.execute_batch(s["sql"].as_str().unwrap()).unwrap();
            }
            "open" => {
                let (sse, got) = Sse::open(server.port);
                let mut want = s["got"].clone();
                want.as_object_mut().unwrap().remove("heartbeatMs");
                if got != want {
                    failures.push(format!("#{i} open\n  want {want}\n  got  {got}"));
                }
                assert_eq!(s["got"]["heartbeatMs"], fx["heartbeat"]["ms"]);
                streams.insert(s["stream"].as_str().unwrap().to_owned(), sse);
            }
            "close" => {
                let label = s["stream"].as_str().unwrap();
                let mut sse = streams.remove(label).unwrap();
                // Nothing more came (a late extra chunk stays queued).
                sse.take(0, Duration::from_millis(100));
                if !sse.chunks.is_empty() {
                    failures.push(format!("#{i} close {label}: unexpected {:?}", sse.chunks));
                }
                // Ended and unsubscribed: the in-process test below.
                assert_eq!(s["got"], json!({"done": true, "heartbeatCleared": true}));
                let _ = sse.sock.shutdown(std::net::Shutdown::Both);
            }
            // The heartbeat: the in-process test below.
            "ping" => {}
            "req" => {
                requests += 1;
                let method = s["method"].as_str().unwrap();
                let path = s["path"].as_str().unwrap();
                let path = if let Some(at) = path.find("$ID") {
                    let n: u64 = path[at + 3..].split('/').next().unwrap().parse().unwrap();
                    let recorded = format!("00000000-0000-4000-a000-{n:012}");
                    let actual = subst.pairs.get(&recorded).unwrap_or_else(|| {
                        panic!("#{i}: {recorded} was never written");
                    });
                    path.replace(&format!("$ID{n}"), actual)
                } else {
                    path.to_owned()
                };
                let port = if s["prod"] == true {
                    let (_, srv) = prod.get_or_insert_with(|| {
                        let w = World::new();
                        let srv = Server::spawn(&w, &[("CLAUDIUS_DEV", "0")]);
                        (w, srv)
                    });
                    srv.port
                } else {
                    dev_emit = path.ends_with("/dev-emit");
                    server.port
                };
                while prev_request.elapsed() < Duration::from_millis(3) {
                    std::thread::sleep(Duration::from_millis(1));
                }
                t0 = now_ms();
                let (status, content_type, body) = request(
                    port,
                    method,
                    &path,
                    s["body"].as_str(),
                    s["cookie"].as_str(),
                );
                t1 = now_ms();
                prev_request = Instant::now();
                let want = &s["got"];
                let got = if status == 500 && body.is_empty() && content_type.is_none() {
                    json!({"threw": want["threw"]})
                } else {
                    json!({"status": status, "type": content_type, "body": body})
                };
                // Compared once this step's rows are learned.
                pending = Some((method.to_owned(), path, got));
            }
            op => panic!("#{i}: op {op}"),
        }
        // The chunks each open stream got during the step.
        let envs = &s["envs"];
        let mut got_envs: BTreeMap<String, Vec<String>> = BTreeMap::new();
        for (label, sse) in streams.iter_mut() {
            let want_n = if op == "ping" {
                0
            } else {
                envs[label].as_array().map_or(0, Vec::len)
            };
            let got = sse.take(want_n, Duration::ZERO);
            chunks += got.len();
            got_envs.insert(label.clone(), got);
        }
        // The rows, and what they teach about ids and times.
        let mut got_rows = serde_json::Map::new();
        for cwd in &watch {
            let now = dump(&db_path(cwd));
            if let Some(d) = rows_diff(&last[cwd], &now) {
                got_rows.insert(cwd.clone(), d);
            }
            last.insert(cwd.clone(), now);
        }
        let clock = s["clock"].as_u64().map(|c| c.to_string());
        for (cwd, got) in &got_rows {
            if let Err(e) = subst.learn(&s["rows"][cwd], got, clock.as_deref(), t0, t1) {
                failures.push(format!("#{i} rows {cwd}: {e}"));
            }
        }
        if let Some((method, path, got)) = pending {
            let want = subst.apply_value(&s["got"]);
            if got != want {
                failures.push(format!(
                    "#{i} {method} {path} {}\n  want {want}\n  got  {got}",
                    s["body"]
                ));
            }
        }
        for (label, got) in &got_envs {
            let want: Vec<String> = if op == "ping" {
                vec![]
            } else {
                envs[label]
                    .as_array()
                    .map(|a| a.iter().map(|c| subst.apply(c.as_str().unwrap())).collect())
                    .unwrap_or_default()
            };
            if *got == want {
                continue;
            }
            let racy = dev_emit
                && got.len() == want.len()
                && got
                    .iter()
                    .zip(&want)
                    .all(|(g, w)| g == w || one_version_below(w, g));
            if racy {
                raced += 1;
            } else {
                failures.push(format!(
                    "#{i} {op} stream {label}\n  want {want:?}\n  got  {got:?}"
                ));
            }
        }
        let want_rows = match &s["rows"] {
            Value::Null => json!({}),
            rows => subst.apply_value(rows),
        };
        if Value::Object(got_rows.clone()) != want_rows {
            failures.push(format!(
                "#{i} {op} rows\n  want {want_rows}\n  got  {}",
                Value::Object(got_rows)
            ));
        }
    }
    assert!(
        failures.is_empty(),
        "{} of {} steps differ:\n{}",
        failures.len(),
        steps.len(),
        failures.join("\n")
    );
    assert!(streams.is_empty());
    assert!(
        requests >= 230 && chunks >= 80,
        "{requests} requests, {chunks} chunks"
    );
    // Every pinned id and request time that reached a row was met.
    assert!(subst.pairs.len() >= 40, "{}", subst.pairs.len());
    eprintln!("{requests} requests, {chunks} chunks, {raced} dev-emit flushes ran first");

    // The other methods: 405 like the TS route modules.
    for (method, path) in [
        ("POST", "/api/notifications"),
        ("DELETE", "/api/notifications"),
        ("POST", "/api/notifications/counts"),
        ("GET", "/api/notifications/x/read"),
        ("PUT", "/api/notifications/x/read"),
        ("GET", "/api/notifications/read-all"),
        ("GET", "/api/notifications/read-by-kind"),
        ("GET", "/api/notifications/read-by-session"),
        ("GET", "/api/notifications/dev-emit"),
        ("POST", "/api/notifications/stream"),
    ] {
        let (st, _, _) = request(server.port, method, path, None, None);
        assert_eq!(st, 405, "{method} {path}");
    }
}

/// The heartbeat: `: ping\n\n` (the fixture's `heartbeat.chunk`) every
/// [`HEARTBEAT`] (`heartbeat.ms`), the first one a period after the stream
/// starts, never sooner (the period is shortened here); it keeps going when
/// the bus drops the subscription (TS never closes the stream).
#[tokio::test]
async fn heartbeat_follows_the_ts_interval() {
    let fx = fixture();
    assert_eq!(
        HEARTBEAT,
        Duration::from_millis(fx["heartbeat"]["ms"].as_u64().unwrap())
    );
    let ping = fx["heartbeat"]["chunk"].as_str().unwrap().to_owned();
    let period = Duration::from_millis(300);
    let bus = NotificationBus::new(BusOptions {
        timers: Timers::Manual,
        ..BusOptions::default()
    });
    let start = Instant::now();
    let mut body = Box::pin(event_stream(
        vec![
            Bytes::from_static(b": connected\n\n"),
            Bytes::from_static(b"x"),
        ],
        bus.subscribe(),
        period,
    ));
    assert_eq!(body.next().await.unwrap().unwrap(), ": connected\n\n");
    assert_eq!(body.next().await.unwrap().unwrap(), "x");
    assert!(start.elapsed() < period, "the seed waited");
    for n in 1..=3u32 {
        if n == 3 {
            // The bus lets go of its subscribers: only the pings are left.
            bus.reset_for_tests();
        }
        let chunk = tokio::time::timeout(Duration::from_secs(30), body.next())
            .await
            .unwrap()
            .unwrap()
            .unwrap();
        assert_eq!(chunk, ping.as_bytes());
        assert!(start.elapsed() >= period * n, "ping {n} early");
    }
    // A reader that falls behind gets one ping, not the missed ones
    // (`setInterval` doesn't catch up either).
    tokio::time::sleep(period * 3).await;
    let late = Instant::now();
    assert_eq!(body.next().await.unwrap().unwrap(), ping.as_bytes());
    assert_eq!(body.next().await.unwrap().unwrap(), ping.as_bytes());
    assert!(late.elapsed() >= period / 2, "missed pings caught up");
    assert_eq!(bus.subscriber_count(), 0);
    let body = Box::pin(event_stream(vec![], bus.subscribe(), period));
    assert_eq!(bus.subscriber_count(), 1);
    drop(body);
    assert_eq!(bus.subscriber_count(), 0, "dropping the body unsubscribes");
}

/// A client that goes away: the server drops the stream, and with it the
/// stream's bus subscription (TS: the abort listener's `unsubscribe()`).
#[tokio::test]
async fn a_closed_stream_unsubscribes() {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let root = tempfile::tempdir().unwrap();
    let (home, config) = (root.path().join("home"), root.path().join("config"));
    std::fs::create_dir_all(&home).unwrap();
    std::fs::create_dir_all(&config).unwrap();
    assert!(paths::set_home_override(home));
    assert!(paths::set_config_dir_override(config));
    let router = claudius_server::notifications::router().with_state(AppState::new(
        Arc::new(SessionManager::default()),
        None,
        true,
    ));
    let l = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = l.local_addr().unwrap();
    tokio::spawn(async move { axum::serve(l, router).await.unwrap() });
    let bus = NotificationBus::global();
    let before = bus.subscriber_count();
    let mut socks = Vec::new();
    for n in 1..=2 {
        let mut sock = tokio::net::TcpStream::connect(addr).await.unwrap();
        sock.write_all(b"GET /api/notifications/stream HTTP/1.1\r\nHost: x\r\n\r\n")
            .await
            .unwrap();
        let mut seen = Vec::new();
        let mut b = [0u8; 1024];
        while !String::from_utf8_lossy(&seen).contains(": connected\n\n") {
            let k = tokio::time::timeout(Duration::from_secs(10), sock.read(&mut b))
                .await
                .unwrap()
                .unwrap();
            assert!(k > 0);
            seen.extend_from_slice(&b[..k]);
        }
        assert_eq!(bus.subscriber_count(), before + n);
        socks.push(sock);
    }
    drop(socks.pop());
    let start = Instant::now();
    while bus.subscriber_count() != before + 1 {
        assert!(
            start.elapsed() < Duration::from_secs(10),
            "still {} subscribers",
            bus.subscriber_count()
        );
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    drop(socks);
    while bus.subscriber_count() != before {
        assert!(start.elapsed() < Duration::from_secs(10));
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
}

/// What the golden can't hold, pinned (the module docs of
/// `claudius_server::notifications` list them as differences): a workspace
/// the store holds under a number id is found but can't be addressed by the
/// bus (TS would list and mark its rows), and dev-emit / read-by-session
/// hand the bus lone surrogates as U+FFFD (TS binds WTF-8 bytes) and a
/// non-string session id as its `String()`.
#[test]
fn rust_side_edges() {
    let world = World::new();
    let root = "/claudius-rust-edges/x";
    let ws_file = world.home.join(".claude/.claudius/workspaces.json");
    std::fs::create_dir_all(ws_file.parent().unwrap()).unwrap();
    let entry = |id: Value, name: &str, root: &str| {
        json!({"id": id, "name": name, "rootPath": root, "createdAt": 1, "updatedAt": 1,
               "defaults": {"notifications": {"enabledKinds": ["session_error"]}}})
    };
    let store = json!({"version": 1, "activeId": 5, "workspaces": [
        entry(json!(5), "N", "/claudius-rust-edges/n"),
        entry(json!("wks_xxxxxxxxxxxx"), "X", root),
    ]});
    std::fs::write(&ws_file, store.to_string()).unwrap();
    let server = Server::spawn(&world, &[]);
    let post = |path: &str, body: Value| {
        let (st, ty, out) = request(
            server.port,
            "POST",
            &format!("/api/notifications{path}"),
            Some(&body.to_string()),
            None,
        );
        assert_eq!(ty.as_deref(), Some("application/json"), "{path} {body}");
        (st, out)
    };
    let unchanged = (200, r#"{"ok":true,"changed":0}"#.to_owned());
    for (path, body) in [
        ("/read-all", json!({})),
        ("/read-all", json!({"workspaceId": 5})),
        ("/x/read", json!({"workspaceId": 5})),
        (
            "/read-by-kind",
            json!({"kind": "session_idle", "workspaceId": 5}),
        ),
        (
            "/read-by-session",
            json!({"sessionId": "s", "workspaceId": 5}),
        ),
    ] {
        assert_eq!(post(path, body.clone()), unchanged, "{path} {body}");
    }
    assert_eq!(
        request(server.port, "GET", "/api/notifications", None, None),
        (
            200,
            Some("application/json".into()),
            r#"{"items":[]}"#.into()
        )
    );
    assert_eq!(
        post("/read-all", json!({"workspaceId": "5"})),
        (404, r#"{"error":"unknown workspace"}"#.into())
    );

    // `\ud800` / `\udc00` escapes: lone surrogates.
    let emit = |sid: &str, msg: &str| {
        let body = format!(
            r#"{{"cwd":"{root}","sessionId":{sid},"event":{{"type":"error","message":"{msg}"}},"hasSubscribers":false}}"#
        );
        let (st, _, out) = request(
            server.port,
            "POST",
            "/api/notifications/dev-emit",
            Some(&body),
            None,
        );
        assert_eq!(st, 200, "{body}: {out}");
    };
    emit(r#""s-\ud800""#, r"lone \udc00 one");
    emit("7", "seven");
    let rows = dump(
        &world
            .home
            .join(".claude/projects")
            .join(paths::encode_project_dir(root))
            .join(".claudius.db"),
    )
    .unwrap();
    let cols = |r: &Value| (r[1][1].clone(), r[6][1].clone());
    assert_eq!(
        rows.iter().map(cols).collect::<Vec<_>>(),
        [
            (json!("s-\u{fffd}"), json!("lone \u{fffd} one")),
            (json!("7"), json!("seven")),
        ]
    );
    // The same lone surrogate finds the row.
    let (st, _, out) = request(
        server.port,
        "POST",
        "/api/notifications/read-by-session",
        Some(r#"{"sessionId":"s-\ud800","workspaceId":"wks_xxxxxxxxxxxx"}"#),
        None,
    );
    assert_eq!((st, out.as_str()), (200, r#"{"ok":true,"changed":1}"#));
    let (st, _, out) = request(
        server.port,
        "POST",
        "/api/notifications/read-by-session",
        Some(r#"{"sessionId":" 7 ","workspaceId":"wks_xxxxxxxxxxxx"}"#),
        None,
    );
    assert_eq!((st, out.as_str()), (200, r#"{"ok":true,"changed":1}"#));

    // A `null` entry: TS's trusted-cwd check throws on it, here the states
    // do (after counting the others); both are the empty 500.
    let store =
        json!({"version": 1, "workspaces": [entry(json!("wks_xxxxxxxxxxxx"), "X", root), null]});
    std::fs::write(&ws_file, store.to_string()).unwrap();
    let (st, ty, out) = request(
        server.port,
        "POST",
        "/api/notifications/dev-emit",
        Some(r#"{"cwd":5,"sessionId":"s","event":{"type":"ready"}}"#),
        None,
    );
    assert_eq!((st, ty, out.as_str()), (500, None, ""));
}
