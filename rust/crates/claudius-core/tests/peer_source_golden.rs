//! `claudius_core::peer_source` and `jsonl_lines` against
//! `fixtures/peer_source_golden.json`, recorded from the real TS by
//! `rust/scripts/peer-source-golden.mjs`:
//! * `defaults`: the module's bounds are [`Limits::default`], and its
//!   snippet constants the Rust ones;
//! * `lines`: what `jsonlLines(createReadStream(file, {encoding: "utf8"}))`
//!   yields for each recorded byte string, line for line;
//! * `core`: `resolvePeerSource(q, roots)` on module copies with replaced
//!   bounds, each over its own world and cache, at the recorded virtual
//!   clock: every answer (as `JSON.stringify` prints it) and how many times
//!   it read the clock.
//!
//! The route's steps replay on the real binary in claudius-server's
//! `tests/peer_source.rs`.
#![cfg(unix)]

#[path = "common_peer/mod.rs"]
mod common_peer;

use std::sync::{Arc, Mutex};

use claudius_core::jsonl_lines::JsonlLines;
use claudius_core::peer_source::{
    Limits, MIN_SNIPPET, PEER_SNIPPET_MAX, PeerSourceQuery, PeerSourceRoots, Resolver,
};
use common_peer::{apply, bytes, fixture, live};
use serde_json::Value;

#[test]
fn the_bounds_are_the_ts_ones() {
    let fx = fixture();
    let d = &fx["defaults"];
    let l = Limits::default();
    assert_eq!(d["SCAN_SLACK_MS"].as_f64(), Some(l.scan_slack_ms));
    assert_eq!(d["SCAN_BYTE_BUDGET"].as_f64(), Some(l.byte_budget));
    assert_eq!(d["SCAN_TIME_BUDGET_MS"].as_f64(), Some(l.time_budget_ms));
    assert_eq!(d["CACHE_MAX"].as_u64(), Some(l.cache_max as u64));
    assert_eq!(d["MISS_TTL_MS"].as_f64(), Some(l.miss_ttl_ms));
    assert_eq!(d["MIN_SNIPPET"].as_u64(), Some(MIN_SNIPPET as u64));
    assert_eq!(
        d["PEER_SNIPPET_MAX"].as_u64(),
        Some(PEER_SNIPPET_MAX as u64)
    );
}

/// A recorded line: text parts and `{rep, n}` runs.
fn line_text(parts: &Value) -> String {
    let mut s = String::new();
    for p in parts.as_array().unwrap() {
        match p.as_str() {
            Some(t) => s.push_str(t),
            None => s.push_str(
                &p["rep"]
                    .as_str()
                    .unwrap()
                    .repeat(p["n"].as_u64().unwrap() as usize),
            ),
        }
    }
    s
}

#[test]
fn lines_read_like_jsonl_lines() {
    let fx = fixture();
    let dir = tempfile::tempdir().unwrap();
    let cases = fx["lines"].as_array().unwrap();
    for (i, c) in cases.iter().enumerate() {
        let p = dir.path().join(format!("{i}.jsonl"));
        std::fs::write(&p, bytes(&c["parts"])).unwrap();
        let got: Vec<String> = JsonlLines::new(std::fs::File::open(&p).unwrap())
            .map(Result::unwrap)
            .collect();
        let want: Vec<String> = c["got"].as_array().unwrap().iter().map(line_text).collect();
        assert_eq!(got, want, "lines case {i}: {}", c["parts"]);
    }
    assert_eq!(cases.len(), 29);
}

/// The recorder's virtual `Date.now`: each read adds `tick` first.
#[derive(Default)]
struct Clock {
    now: f64,
    tick: f64,
    calls: usize,
}

fn limits(v: &Value) -> Limits {
    let mut l = Limits::default();
    let num = |k: &str| v[k].as_str().map(|s| s.parse::<f64>().unwrap());
    if let Some(n) = num("SCAN_SLACK_MS") {
        l.scan_slack_ms = n;
    }
    if let Some(n) = num("SCAN_BYTE_BUDGET") {
        l.byte_budget = n;
    }
    if let Some(n) = num("SCAN_TIME_BUDGET_MS") {
        l.time_budget_ms = n;
    }
    if let Some(n) = num("CACHE_MAX") {
        l.cache_max = n as usize;
    }
    if let Some(n) = num("MISS_TTL_MS") {
        l.miss_ttl_ms = n;
    }
    l
}

fn query(q: &Value) -> PeerSourceQuery {
    let num = |v: &Value| match v {
        Value::String(s) if s == "@LIVE@" => live().parse().ok(),
        v => v.as_f64(),
    };
    PeerSourceQuery {
        pid: num(&q["pid"]),
        from: q["from"].as_str().map(str::to_owned),
        msg_id: q["msgId"].as_str().map(str::to_owned),
        snippet: q["snippet16"].as_array().map(|u| {
            u.iter()
                .map(|x| u16::try_from(x.as_u64().unwrap()).unwrap())
                .collect()
        }),
        at: num(&q["at"]),
    }
}

#[test]
fn resolve_replays_the_ts_module() {
    let fx = fixture();
    let mut calls = 0;
    for g in fx["core"].as_array().unwrap() {
        let name = g["name"].as_str().unwrap();
        let base = tempfile::tempdir().unwrap();
        let clock = Arc::new(Mutex::new(Clock::default()));
        let c = clock.clone();
        let resolver = Resolver::new(
            limits(&g["limits"]),
            Arc::new(move || {
                let mut c = c.lock().unwrap();
                c.calls += 1;
                c.now += c.tick;
                c.now
            }),
        );
        let roots = PeerSourceRoots {
            claude_dir: base.path().join("claude").display().to_string(),
            profiles_root: base.path().join("profiles").display().to_string(),
        };
        for (i, s) in g["steps"].as_array().unwrap().iter().enumerate() {
            if s["op"] != "resolve" {
                apply(base.path(), s);
                continue;
            }
            calls += 1;
            {
                let mut c = clock.lock().unwrap();
                c.now = s["now"]["set"].as_f64().unwrap();
                c.tick = s["now"]["tick"].as_f64().unwrap_or(0.0);
                c.calls = 0;
            }
            let got = resolver.resolve(&query(&s["q"]), &roots);
            let got = got.map(|r| r.to_json());
            assert_eq!(got.as_deref(), s["got"].as_str(), "{name} #{i}: {}", s["q"]);
            assert_eq!(
                clock.lock().unwrap().calls as u64,
                s["nowCalls"].as_u64().unwrap(),
                "{name} #{i}: Date.now reads"
            );
        }
        common_peer::open_up(base.path());
    }
    assert_eq!(calls, 48);
}
