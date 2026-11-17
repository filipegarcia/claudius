//! The updater's pure parts against the TS (D27a): `toReleaseTag`,
//! `classifyCommit` and `buildReleaseChangelog` (`lib/shared/
//! release-changelog.ts`), `extendedPath` / `bunInstallCandidates`
//! (`lib/server/updater/spawn-env.ts`), and `getReleaseChangelog`'s
//! failure cache over a moving clock, replayed from the `pure` and
//! `messages` parts of `tests/fixtures/updater_golden.json` (recorded by
//! `rust/scripts/updater-golden.mjs`). The routes themselves replay in
//! `claudius-server/tests/updater_routes.rs`.
#![cfg(unix)]

use std::collections::VecDeque;
use std::io::{Read, Write};
use std::net::{Shutdown, TcpListener, TcpStream};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use claudius_core::fetch::{Fetch, FetchError, HttpsClient, Request, Response};
use claudius_core::js_string;
use claudius_core::updater::release_changelog::{self as rc, ChangelogCache, Commit};
use claudius_core::updater::spawn_env;
use futures::future::BoxFuture;
use serde_json::{Value, json};

fn fixture() -> Value {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/updater_golden.json");
    js_string::parse(&std::fs::read_to_string(path).unwrap()).unwrap()
}

fn arr(v: &Value) -> &Vec<Value> {
    v.as_array().unwrap()
}

#[test]
fn release_tags_match_the_ts() {
    let fx = fixture();
    for c in arr(&fx["pure"]["tags"]) {
        let v = c["v"].as_str().unwrap();
        assert_eq!(
            rc::to_release_tag(v).map_or(Value::Null, Value::String),
            c["tag"],
            "toReleaseTag({v:?})"
        );
    }
}

/// `classifyCommit`'s answer as the recorder printed it.
fn classified(r: Result<Option<(rc::Group, rc::Entry)>, String>) -> Value {
    match r.unwrap() {
        None => Value::Null,
        Some((group, entry)) => json!({
            "group": group.key().unwrap_or("<proto>"),
            "entry": entry.to_json(),
        }),
    }
}

#[test]
fn classify_commit_matches_the_ts() {
    let fx = fixture();
    let sha = json!("0123456789abcdef");
    for c in arr(&fx["pure"]["classify"]) {
        let got = classified(rc::classify_commit(&c["message"], Some(&sha)));
        assert_eq!(
            js_string::stringify(&got),
            js_string::stringify(&c["got"]),
            "{:?}",
            c["message"]
        );
    }
    for c in arr(&fx["pure"]["shaCases"]) {
        let (_, entry) = rc::classify_commit(&json!("fix: sha cut"), Some(&c["sha"]))
            .unwrap()
            .unwrap();
        assert_eq!(entry.sha, c["got"], "sha {:?}", c["sha"]);
    }
}

#[test]
fn build_release_changelog_matches_the_ts() {
    let fx = fixture();
    for b in arr(&fx["pure"]["build"]) {
        let commits: Vec<Commit> = arr(&b["commits"])
            .iter()
            .map(|c| Commit {
                sha: Some(c["sha"].clone()),
                message: c["message"].clone(),
            })
            .collect();
        let got = rc::build_release_changelog(
            "v1.0.0",
            "v1.0.1",
            &commits,
            &json!("https://example.com/c"),
        )
        .unwrap();
        assert_eq!(js_string::stringify(&got), js_string::stringify(&b["got"]));
    }
}

#[test]
fn extended_path_matches_the_ts() {
    let fx = fixture();
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp
        .path()
        .canonicalize()
        .unwrap()
        .to_string_lossy()
        .into_owned();
    std::fs::create_dir_all(format!("{root}/eh/with/.bun/bin")).unwrap();
    std::fs::create_dir_all(format!("{root}/eh/without")).unwrap();
    // The `machine` cases depend on which of the absolute dirs exist.
    let here: Vec<Value> = arr(&fx["abs"])
        .iter()
        .map(|d| Value::Bool(std::path::Path::new(d.as_str().unwrap()).exists()))
        .collect();
    let same_machine = &here == arr(&fx["absExists"]);
    let sub = |s: &str| s.replace(&root, "$ROOT");
    let mut checked = 0;
    for c in arr(&fx["pure"]["extended"]) {
        if c["machine"] == true && !same_machine {
            continue;
        }
        let home = c["home"].as_str().unwrap().replace("$ROOT", &root);
        let path = c["path"].as_str().unwrap().replace("$ROOT", &root);
        let label = format!("{} / {}", c["label"], c["home"]);
        assert_eq!(
            sub(&spawn_env::extended_path(Some(&path), &home)),
            c["got"].as_str().unwrap(),
            "{label}"
        );
        let candidates: Vec<Value> = spawn_env::bun_install_candidates(&home)
            .iter()
            .map(|d| Value::String(sub(d)))
            .collect();
        assert_eq!(&candidates, arr(&c["candidates"]), "{label}");
        checked += 1;
    }
    assert!(checked >= 42, "only {checked} cases checked");
    assert_eq!(spawn_env::extended_path(None, "/nonexistent-home"), {
        let mut want: Vec<&str> = spawn_env::ABSOLUTE_LOCATIONS
            .iter()
            .copied()
            .filter(|d| std::path::Path::new(d).exists())
            .collect();
        want.dedup();
        want.join(":")
    });
}

// ---- the failure cache, over a local upstream -----------------------------------

#[derive(Default)]
struct Upstream {
    queue: VecDeque<Value>,
    served: usize,
}

fn hex(s: &str) -> Vec<u8> {
    (0..s.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&s[i..i + 2], 16).unwrap())
        .collect()
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
    let next = {
        let mut st = st.lock().unwrap();
        st.served += 1;
        st.queue.pop_front()
    };
    match next.as_ref().and_then(|r| r["wireHex"].as_str()) {
        Some(h) => {
            let _ = conn.write_all(&hex(h));
            let _ = conn.shutdown(Shutdown::Write);
            let _ = conn.set_read_timeout(Some(Duration::from_secs(2)));
            let _ = conn.read(&mut buf);
        }
        None => {
            let _ = conn.shutdown(Shutdown::Both);
        }
    }
}

fn result_json(r: Result<Value, String>) -> Value {
    match r {
        Ok(changelog) => json!({"ok": true, "changelog": changelog}),
        Err(error) => json!({"ok": false, "error": error}),
    }
}

#[tokio::test]
async fn the_failure_cache_matches_the_ts() {
    let fx = fixture();
    let (base, up) = upstream();
    let client = HttpsClient::new().with_base(base);
    let cache = ChangelogCache::new();
    let clock = Arc::new(Mutex::new(fx["t0"].as_f64().unwrap()));
    let now = {
        let clock = clock.clone();
        move || *clock.lock().unwrap()
    };
    for step in arr(&fx["pure"]["ttl"]) {
        let label = step["label"].as_str().unwrap();
        let (from, to) = if step.get("advance").is_some() {
            ("v9.0.0", "v9.0.1")
        } else {
            ("1.2.3", "v1.2.4")
        };
        if let Some(a) = step["advance"].as_f64() {
            *clock.lock().unwrap() += a;
        }
        {
            let mut u = up.lock().unwrap();
            u.served = 0;
            u.queue = step["responses"]
                .as_array()
                .cloned()
                .unwrap_or_default()
                .into();
        }
        let got = result_json(cache.get(&client, from, to, &now).await);
        assert_eq!(
            js_string::stringify(&got),
            js_string::stringify(&step["got"]),
            "{label}"
        );
        let u = up.lock().unwrap();
        assert!(u.queue.is_empty(), "{label}: responses left");
        if let Some(n) = step["fetched"].as_u64() {
            assert_eq!(u.served as u64, n, "{label}: fetches");
        }
    }
}

/// A `fetch` that never settles.
struct Hang;

impl Fetch for Hang {
    fn fetch<'a>(&'a self, _req: &'a Request) -> BoxFuture<'a, Result<Response, FetchError>> {
        Box::pin(futures::future::pending())
    }
}

#[tokio::test(start_paused = true)]
async fn a_fetch_past_eight_seconds_fails_like_abort_signal_timeout() {
    let fx = fixture();
    assert_eq!(fx["messages"]["timeout"], rc::TIMEOUT_MESSAGE);
    assert_eq!(fx["messages"]["timeoutIsError"], true);
    let cache = ChangelogCache::new();
    let t = std::sync::atomic::AtomicU64::new(0);
    let now = || t.load(std::sync::atomic::Ordering::SeqCst) as f64;
    let started = tokio::time::Instant::now();
    let got = cache.get(&Hang, "v1.0.0", "v1.0.1", &now).await;
    assert_eq!(got, Err(rc::TIMEOUT_MESSAGE.to_owned()));
    assert_eq!(
        started.elapsed(),
        Duration::from_millis(rc::FETCH_TIMEOUT_MS)
    );
    // Cached as a failure for 5 minutes, like any other.
    let got = cache.get(&Hang, "v1.0.0", "v1.0.1", &now).await;
    assert_eq!(got, Err(rc::TIMEOUT_MESSAGE.to_owned()));
    assert_eq!(
        started.elapsed(),
        Duration::from_millis(rc::FETCH_TIMEOUT_MS)
    );
}
