//! `/api/limits` and `/api/cost/refresh-prices` against the real binary,
//! replaying the `limits` and `prices` steps of
//! `claudius-core/tests/fixtures/limits_pricing_golden.json` (recorded by
//! `rust/scripts/limits-pricing-golden.mjs` from the real TS routes): the
//! same `workspaces.json` (fake roots under `/claudius-golden/`), the same
//! files under `<home>/.claude/.claudius` and at the price cache, the same
//! scripted LiteLLM upstream (behind `CLAUDIUS_DEV_FETCH_BASE`). Every
//! request must answer the same status, content type and body text
//! ("threw" is Next's empty 500), change the same files the same way, and
//! make the same upstream requests.
//!
//! The recorder ran on a pinned clock (2001-02-03T12:00:00.000Z); this
//! server runs on the real one in UTC. So the recorded day in override keys
//! stands for today's, and a successful refresh's `fetchedAt` has to be a
//! time within the request.
#![cfg(unix)]

mod common;

use std::collections::{BTreeMap, VecDeque};
use std::io::{Read, Write};
use std::net::{Shutdown, TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, UNIX_EPOCH};

use claudius_core::asset_store::sha256_hex;
use claudius_core::{js_date, now_ms, paths};
use common::{Server, World};
use serde_json::{Value, json};

fn fixture() -> Value {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../claudius-core/tests/fixtures/limits_pricing_golden.json");
    serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap()
}

/// `(status, content type, body)`.
fn request(port: u16, method: &str, path: &str, body: &[u8]) -> (u16, Option<String>, String) {
    let mut s = TcpStream::connect(("127.0.0.1", port)).unwrap();
    let head = format!(
        "{method} {path} HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
        body.len()
    );
    s.write_all(head.as_bytes()).unwrap();
    s.write_all(body).unwrap();
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

fn hex(s: &str) -> Vec<u8> {
    (0..s.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&s[i..i + 2], 16).unwrap())
        .collect()
}

fn to_hex(b: &[u8]) -> String {
    b.iter().map(|x| format!("{x:02x}")).collect()
}

fn rm(p: &Path) {
    match std::fs::symlink_metadata(p) {
        Ok(m) if m.is_dir() => std::fs::remove_dir_all(p).unwrap(),
        Ok(_) => std::fs::remove_file(p).unwrap(),
        Err(_) => {}
    }
}

/// Set `p`'s mtime to the recorded `stat.mtimeNs`.
fn set_mtime(p: &Path, ns: &Value) {
    let ns: i128 = ns.as_str().unwrap().parse().unwrap();
    let d = Duration::from_nanos(ns.unsigned_abs() as u64);
    let t = if ns >= 0 {
        UNIX_EPOCH + d
    } else {
        UNIX_EPOCH - d
    };
    std::fs::File::open(p).unwrap().set_modified(t).unwrap();
}

/// Today's key in UTC (the server runs with `TZ=UTC`): the ISO date.
fn today() -> String {
    js_date::to_iso_string(now_ms() as f64).unwrap()[..10].to_owned()
}

/// A recorded response.
fn expected(got: &Value) -> (u16, Option<String>, String) {
    if got.get("threw").is_some() {
        return (500, None, String::new());
    }
    (
        got["status"].as_u64().unwrap() as u16,
        got["type"].as_str().map(str::to_owned),
        got["body"].as_str().unwrap_or_default().to_owned(),
    )
}

// ------------------------------- /api/limits -------------------------------

/// One file or folder under `limits/`, as the recorder snapshots it.
fn entry(p: &Path) -> Value {
    if std::fs::symlink_metadata(p).unwrap().is_dir() {
        return json!({"dir": true});
    }
    let b = std::fs::read(p).unwrap();
    match String::from_utf8(b) {
        Ok(text) => json!({ "text": text }),
        Err(e) => json!({ "hex": to_hex(e.as_bytes()) }),
    }
}

fn snap(limits: &Path, eproject: &str) -> BTreeMap<String, Value> {
    let mut out = BTreeMap::new();
    let Ok(m) = std::fs::symlink_metadata(limits) else {
        return out;
    };
    out.insert(".".to_owned(), entry(limits));
    if m.is_dir() {
        for e in std::fs::read_dir(limits).unwrap() {
            let name = e.unwrap().file_name().into_string().unwrap();
            out.insert(
                name.replace(eproject, "$EPROJECT"),
                entry(&limits.join(&name)),
            );
        }
    }
    out
}

fn changes(before: &BTreeMap<String, Value>, after: &BTreeMap<String, Value>) -> Value {
    let mut keys: Vec<&String> = before.keys().chain(after.keys()).collect();
    keys.sort();
    keys.dedup();
    Value::Array(
        keys.into_iter()
            .filter(|k| before.get(*k) != after.get(*k))
            .map(|k| json!([k, after.get(k).cloned().unwrap_or(Value::Null)]))
            .collect(),
    )
}

/// `v` with the recorded day replaced by `day` in every string.
fn with_day(v: &Value, recorded: &str, day: &str) -> Value {
    match v {
        Value::String(s) => Value::String(s.replace(recorded, day)),
        Value::Array(a) => Value::Array(a.iter().map(|x| with_day(x, recorded, day)).collect()),
        Value::Object(o) => Value::Object(
            o.iter()
                .map(|(k, x)| (k.clone(), with_day(x, recorded, day)))
                .collect(),
        ),
        v => v.clone(),
    }
}

#[test]
fn limits_replays_the_ts_golden() {
    let fx = fixture();
    let world = World::new();
    let claudius = world.home.join(".claude/.claudius");
    std::fs::create_dir_all(&claudius).unwrap();
    std::fs::write(
        claudius.join("workspaces.json"),
        fx["workspaces"].as_str().unwrap(),
    )
    .unwrap();
    let server = Server::spawn(&world, &[("TZ", "UTC")]);
    let limits = claudius.join("limits");
    let eproject = paths::encode_project_dir(&world.project.display().to_string());
    let recorded_day = fx["day"].as_str().unwrap();
    let mut failures = vec![];
    for (i, s) in fx["limits"]["steps"].as_array().unwrap().iter().enumerate() {
        if s["op"] == "setup" {
            let p = claudius.join(s["path"].as_str().unwrap());
            if s["rm"] == true {
                rm(&p);
            }
            if s["mkdir"] == true {
                std::fs::create_dir_all(&p).unwrap();
            }
            let bytes = match (s["text"].as_str(), s["hex"].as_str()) {
                (Some(t), _) => Some(t.as_bytes().to_vec()),
                (_, Some(h)) => Some(hex(h)),
                _ => None,
            };
            if let Some(b) = bytes {
                std::fs::create_dir_all(p.parent().unwrap()).unwrap();
                std::fs::write(&p, b).unwrap();
            }
            continue;
        }
        let method = s["method"].as_str().unwrap();
        let query = s["query"].as_str().unwrap();
        let path = if query.is_empty() {
            "/api/limits".to_owned()
        } else {
            format!("/api/limits?{query}")
        };
        let body = match (s["body"].as_str(), s["bodyHex"].as_str()) {
            (Some(b), _) => b.as_bytes().to_vec(),
            (_, Some(h)) => hex(h),
            _ => vec![],
        };
        let before = snap(&limits, &eproject);
        let day0 = today();
        let got = request(server.port, method, &path, &body);
        let day1 = today();
        let changed = changes(&before, &snap(&limits, &eproject));
        if s["notExported"] == true {
            if got.0 != 405 {
                failures.push(format!("step {i} {method}: {got:?}, want 405"));
            }
            continue;
        }
        // Midnight between the two reads: either day may be in the answer.
        let ok = [day0, day1].iter().any(|day| {
            let want = expected(&with_day(&s["got"], recorded_day, day));
            got == want && changed == with_day(&s["changes"], recorded_day, day)
        });
        if !ok {
            failures.push(format!(
                "step {i} {method} {path} {:?}:\n  got  {got:?}\n  want {:?}\n  changes {changed}\n  want    {}",
                String::from_utf8_lossy(&body),
                expected(&s["got"]),
                s["changes"]
            ));
        }
    }
    assert!(failures.is_empty(), "{}", failures.join("\n"));
}

// ------------------------------- /api/cost/refresh-prices -------------------------------

/// The recorder's upstream: each connection gets the next scripted answer
/// (the exact bytes, or a hang-up), and its request line is logged.
#[derive(Default)]
struct Upstream {
    queue: VecDeque<Value>,
    served: Vec<String>,
    unscripted: usize,
}

fn upstream() -> (String, Arc<Mutex<Upstream>>) {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let base = format!("http://127.0.0.1:{}", listener.local_addr().unwrap().port());
    let state = Arc::new(Mutex::new(Upstream::default()));
    let st = state.clone();
    std::thread::spawn(move || {
        for conn in listener.incoming() {
            let Ok(conn) = conn else { continue };
            let st = st.clone();
            std::thread::spawn(move || answer(conn, &st));
        }
    });
    (base, state)
}

fn answer(mut conn: TcpStream, st: &Mutex<Upstream>) {
    let mut head = Vec::new();
    let mut buf = [0u8; 4096];
    while !head.windows(4).any(|w| w == b"\r\n\r\n") {
        match conn.read(&mut buf) {
            Ok(0) | Err(_) => return,
            Ok(n) => head.extend_from_slice(&buf[..n]),
        }
    }
    let line = String::from_utf8_lossy(&head);
    let line = line.split("\r\n").next().unwrap_or_default();
    let mut parts = line.split(' ');
    let (method, path) = (parts.next().unwrap_or(""), parts.next().unwrap_or(""));
    let next = {
        let mut st = st.lock().unwrap();
        st.served.push(format!("{method} {path}"));
        let next = st.queue.pop_front();
        if next.is_none() {
            st.unscripted += 1;
        }
        next
    };
    match next {
        Some(r) if r.get("close").is_none() => {
            let bytes = match r.get("wireHex") {
                Some(h) => hex(h.as_str().unwrap()),
                None => r["wire"].as_str().unwrap().as_bytes().to_vec(),
            };
            let _ = conn.write_all(&bytes);
            let _ = conn.shutdown(Shutdown::Write);
            let _ = conn.set_read_timeout(Some(Duration::from_secs(2)));
            let _ = conn.read(&mut buf);
        }
        _ => {
            let _ = conn.shutdown(Shutdown::Both);
        }
    }
}

/// The price cache as the recorder saw it.
fn cache_state(p: &Path) -> Value {
    match std::fs::symlink_metadata(p) {
        Ok(m) if m.is_dir() => json!("dir"),
        Ok(_) => {
            let b = std::fs::read(p).unwrap();
            if b.len() <= 4096 {
                json!({ "text": String::from_utf8_lossy(&b) })
            } else {
                json!({"sha256": sha256_hex(&b), "bytes": b.len()})
            }
        }
        Err(_) => Value::Null,
    }
}

#[test]
fn refresh_prices_replays_the_ts_golden() {
    let fx = fixture();
    let pinned = js_date::to_iso_string(fx["now"].as_f64().unwrap()).unwrap();
    let mut failures = vec![];
    for phase in fx["prices"].as_array().unwrap() {
        let name = phase["name"].as_str().unwrap();
        let world = World::new();
        let cache = world
            .home
            .join(".claude")
            .join(".claudius-litellm-prices.json");
        let (base, up) = upstream();
        // Unset is `""` here: anything but "1" leaves the refresh on.
        let disable = phase["env"].as_str().unwrap_or("");
        let server = Server::spawn(
            &world,
            &[
                ("TZ", "UTC"),
                ("CLAUDIUS_DEV", "1"),
                ("CLAUDIUS_DEV_FETCH_BASE", &base),
                ("CLAUDIUS_DISABLE_PRICE_REFRESH", disable),
            ],
        );
        assert!(
            up.lock().unwrap().served.is_empty(),
            "{name}: startup fetched"
        );
        for (i, s) in phase["steps"].as_array().unwrap().iter().enumerate() {
            if s["op"] == "setup" {
                if s["rm"] == true {
                    rm(&cache);
                }
                if s["mkdir"] == true {
                    std::fs::create_dir_all(&cache).unwrap();
                }
                if let Some(t) = s["text"].as_str() {
                    std::fs::create_dir_all(cache.parent().unwrap()).unwrap();
                    std::fs::write(&cache, t).unwrap();
                }
                if let Some(ns) = s.get("mtimeNs") {
                    set_mtime(&cache, ns);
                }
                continue;
            }
            {
                let mut u = up.lock().unwrap();
                u.queue = s["upstream"].as_array().cloned().unwrap_or_default().into();
                u.served.clear();
            }
            let method = s["method"].as_str().unwrap();
            let t0 = now_ms();
            let got = request(server.port, method, "/api/cost/refresh-prices", b"");
            let t1 = now_ms();
            let u = up.lock().unwrap();
            let at = format!("{name} step {i} {method}");
            if !u.queue.is_empty() || u.unscripted != 0 {
                failures.push(format!("{at}: upstream unused or short: {:?}", u.served));
            }
            if s["notExported"] == true {
                if got.0 != 405 {
                    failures.push(format!("{at}: {got:?}, want 405"));
                }
                continue;
            }
            let mut want = expected(&s["got"]);
            // `fetchedAt` is `new Date()`: a time within the request.
            if want.2.contains(&format!("\"fetchedAt\":\"{pinned}\"")) {
                match (t0..=t1)
                    .filter_map(|t| js_date::to_iso_string(t as f64))
                    .find(|iso| got.2.contains(&format!("\"fetchedAt\":\"{iso}\"")))
                {
                    Some(iso) => want.2 = want.2.replace(&pinned, &iso),
                    None => {
                        failures.push(format!("{at}: fetchedAt outside the request: {}", got.2))
                    }
                }
            }
            if got != want {
                failures.push(format!("{at}:\n  got  {got:?}\n  want {want:?}"));
            }
            if json!(u.served) != s["served"] {
                failures.push(format!("{at}: served {:?}, want {}", u.served, s["served"]));
            }
            let c = cache_state(&cache);
            if c != s["cache"] {
                failures.push(format!("{at}: cache {c}, want {}", s["cache"]));
            }
        }
        drop(server);
    }
    assert!(failures.is_empty(), "{}", failures.join("\n"));
}
