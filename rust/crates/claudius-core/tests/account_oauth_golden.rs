//! Replays `fixtures/account_oauth_golden.json`, recorded by
//! `rust/scripts/account-oauth-golden.mjs` from the real TS: the browser
//! sign-in of `lib/server/account-oauth.ts` and the handler of
//! `app/api/accounts/oauth/route.ts`, over the real account store.
//!
//! Each case rebuilds its world under a temp dir (`$W`) and runs the same
//! steps through `claudius_core::account_oauth` (`post_route`, `start`,
//! `exchange_code`) with the recorder's clock and random bytes, shared by
//! the flows and the store as `randomBytes` is. For every step it compares
//! the answer (status, content type and body text, or the throw), each
//! request handed to `fetch` (url, method, headers, body) with what undici
//! made of the scripted response fed back, the sizes of the random draws,
//! the pending-flow count and the whole world tree. All tokens and codes are
//! fake; nothing outside the temp dirs is touched and nothing goes on the
//! network.
#![cfg(unix)]

#[path = "common_oauth/mod.rs"]
mod common_oauth;

use std::collections::{BTreeMap, VecDeque};
use std::sync::atomic::{AtomicI64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, OnceLock};

use claudius_agent::js;
use claudius_core::account_oauth::{
    self, OAuthFlows, RouteAnswer, SecureRandom, code_challenge, post_route,
};
use claudius_core::accounts::{self, AccountsStore, accounts_dir_for};
use claudius_core::fetch::{Fetch, FetchError, Request, Response};
use claudius_core::tls_cert_hint;
use common_oauth::{build, fill, fixture, hex, recorded_tree, request_body, sub, tree, unlock};
use futures::future::BoxFuture;
use serde_json::{Value, json};

fn set_umask() {
    static ONCE: OnceLock<()> = OnceLock::new();
    ONCE.get_or_init(|| unsafe {
        libc::umask(0o022);
    });
}

/// The recorder's `randomBytes`: byte i of call n is `(n * 37 + i * 11 + 5)
/// & 255`, one counter for the flows and the store; the sizes are logged.
#[derive(Default)]
struct Counter {
    calls: AtomicUsize,
    sizes: Mutex<Vec<usize>>,
}

impl Counter {
    fn fill(&self, buf: &mut [u8]) {
        let n = self.calls.fetch_add(1, Ordering::SeqCst);
        self.sizes.lock().unwrap().push(buf.len());
        for (i, b) in buf.iter_mut().enumerate() {
            *b = ((n * 37 + i * 11 + 5) & 0xff) as u8;
        }
    }
}

/// `fetch`, scripted with what undici made of each recorded response.
#[derive(Default)]
struct Scripted {
    queue: Mutex<VecDeque<Value>>,
    calls: Mutex<Vec<Value>>,
}

impl Fetch for Scripted {
    fn fetch<'a>(&'a self, req: &'a Request) -> BoxFuture<'a, Result<Response, FetchError>> {
        let headers: Vec<Value> = req.headers.iter().map(|(k, v)| json!([k, v])).collect();
        self.calls.lock().unwrap().push(json!({
            "url": req.url,
            "method": req.method,
            "headers": headers,
            "body": req.body,
        }));
        let next = self.queue.lock().unwrap().pop_front();
        Box::pin(async move {
            let next = next.expect("unscripted fetch");
            if let Some(m) = next["throws"].as_str() {
                // The recorded rejection, with the verdict the real client
                // reaches from the handshake (the recorder's `cause` is the
                // Node error undici wrapped).
                let err = json!({"message": m, "cause": next["cause"].clone()});
                return Err(if tls_cert_hint::is_ca_trust_failure(&err) {
                    FetchError::ca_trust(m)
                } else {
                    FetchError::new(m)
                });
            }
            Ok(Response {
                status: next["status"].as_u64().unwrap() as u16,
                status_text: next["statusText"].as_str().unwrap().to_owned(),
                body: match next["hex"].as_str() {
                    Some(h) => Ok(hex(h)),
                    None => Err(next["error"].as_str().unwrap().to_owned()),
                },
            })
        })
    }
}

/// `await req.json()`: two BOMs dropped, lossy UTF-8, `JSON.parse`.
fn parse_body(bytes: &[u8]) -> Result<Value, String> {
    let once = bytes.strip_prefix(b"\xEF\xBB\xBF").unwrap_or(bytes);
    let twice = once.strip_prefix(b"\xEF\xBB\xBF").unwrap_or(once);
    js::json_parse(&String::from_utf8_lossy(twice))
}

/// The recorded `got` for a route answer.
fn got(w: &str, answer: RouteAnswer) -> Value {
    match answer {
        RouteAnswer::Json(status, v) => {
            json!({"status": status, "type": "application/json", "body": sub(w, &js::stringify(&v))})
        }
        RouteAnswer::Thrown(message) => json!({"threw": sub(w, &message)}),
    }
}

async fn replay(case: &Value) {
    set_umask();
    let case = &common_oauth::expected_case(case);
    let name = case["name"].as_str().unwrap();
    let dir = tempfile::tempdir().unwrap();
    let w = dir.path().canonicalize().unwrap().display().to_string();
    let env = fill(&w, &case["env"]);
    let home = format!("{w}/home");
    let store_dir = accounts_dir_for(env["CLAUDIUS_ACCOUNTS_DIR"].as_str(), &home);

    let t0 = fixture()["t0"].as_i64().unwrap();
    let now = Arc::new(AtomicI64::new(t0));
    let counter = Arc::new(Counter::default());
    let clock = {
        let now = now.clone();
        Arc::new(move || now.load(Ordering::SeqCst)) as accounts::Clock
    };
    let store_random = {
        let c = counter.clone();
        Arc::new(move |b: &mut [u8]| c.fill(b)) as accounts::Random
    };
    let flow_random = {
        let c = counter.clone();
        Arc::new(move |b: &mut [u8]| {
            c.fill(b);
            Ok(())
        }) as SecureRandom
    };
    let store = AccountsStore::new(store_dir, home)
        .with_clock(clock.clone())
        .with_random(store_random);
    let oauth = OAuthFlows::new().with_clock(clock).with_random(flow_random);

    build(&w, &case["files"]);
    let start = tree(&w, &[]);
    assert_eq!(start, recorded_tree(&case["start"]), "{name}: the world");
    let mut last = start;
    let mut flows: Vec<(String, String)> = Vec::new();
    for (i, step) in case["steps"].as_array().unwrap().iter().enumerate() {
        let at = format!("{name} / step {i} ({})", step["op"]);
        let fetch = Scripted::default();
        if let Some(fetches) = step["fetches"].as_array() {
            fetch
                .queue
                .lock()
                .unwrap()
                .extend(fetches.iter().map(|f| f["res"].clone()));
        }
        counter.sizes.lock().unwrap().clear();
        match step["op"].as_str().unwrap() {
            "post" => {
                let body = request_body(step, &flows);
                let answer = match parse_body(&body) {
                    Err(_) => RouteAnswer::Json(400, json!({"error": "invalid JSON"})),
                    Ok(b) => post_route(&oauth, &fetch, &store, None, &b).await,
                };
                let got = got(&w, answer);
                assert_eq!(got, step["got"], "{at}");
                if got["status"] == 200 {
                    let v: Value = serde_json::from_str(got["body"].as_str().unwrap()).unwrap();
                    if let (Some(f), Some(s)) = (v["flowId"].as_str(), v["state"].as_str()) {
                        flows.push((f.to_owned(), s.to_owned()));
                    }
                }
            }
            "start" => {
                let flow = oauth.start().unwrap();
                assert_eq!(js::stringify(&flow.to_json()), step["out"], "{at}");
                flows.push((flow.flow_id, flow.state));
            }
            "exchange" => {
                let arg = |k: &str| {
                    step.get(k).map(|v| {
                        serde_json::from_str::<Value>(&common_oauth::fill_flows(
                            &v.to_string(),
                            &flows,
                        ))
                        .unwrap()
                    })
                };
                let (flow, code) = (arg("flow"), arg("code"));
                match oauth
                    .exchange_code(&fetch, flow.as_ref(), code.as_ref())
                    .await
                {
                    Ok(x) => assert_eq!(sub(&w, &js::stringify(&x.to_json())), step["out"], "{at}"),
                    Err(e) => assert_eq!(sub(&w, &e), step["throws"], "{at}"),
                }
            }
            "advance" => {
                now.fetch_add(step["ms"].as_i64().unwrap(), Ordering::SeqCst);
            }
            "files" => build(&w, &step["files"]),
            op => panic!("unknown op {op}"),
        }
        // The CC 2.1.309 log line, which the port writes with the same
        // wording (pinned as text: no tracing subscriber here).
        let want_warns: Vec<&str> = step["warns"]
            .as_array()
            .map(|a| a.iter().map(|v| v.as_str().unwrap()).collect())
            .unwrap_or_default();
        for warn in want_warns {
            assert_eq!(
                warn,
                format!(
                    "[accounts] token exchange failed certificate verification \u{2014} {}",
                    tls_cert_hint::OWN_REQUEST_HINT
                ),
                "{at}: the warning"
            );
        }
        let calls: Vec<Value> = std::mem::take(&mut *fetch.calls.lock().unwrap());
        let want: Vec<Value> = step["fetches"]
            .as_array()
            .map(|f| {
                f.iter()
                    .map(|c| {
                        let mut c = c.clone();
                        c.as_object_mut().unwrap().remove("res");
                        c
                    })
                    .collect()
            })
            .unwrap_or_default();
        let calls: Vec<Value> = calls
            .into_iter()
            .map(|c| serde_json::from_str(&sub(&w, &c.to_string())).unwrap())
            .collect();
        assert_eq!(calls, want, "{at}: the fetches");
        assert!(
            fetch.queue.lock().unwrap().is_empty(),
            "{at}: unused responses"
        );
        let sizes = std::mem::take(&mut *counter.sizes.lock().unwrap());
        let want_sizes: Vec<usize> = step["rng"]
            .as_array()
            .map(|a| a.iter().map(|n| n.as_u64().unwrap() as usize).collect())
            .unwrap_or_default();
        assert_eq!(sizes, want_sizes, "{at}: the random draws");
        assert_eq!(
            oauth.pending_count() as u64,
            step["pending"].as_u64().unwrap(),
            "{at}: pending flows"
        );
        let now_tree = tree(&w, &[]);
        let want_tree: BTreeMap<String, Value> = match step.get("tree") {
            Some(t) => recorded_tree(t),
            None => last.clone(),
        };
        assert_eq!(now_tree, want_tree, "{at}: the world tree");
        last = now_tree;
    }
    unlock(dir.path());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn every_recorded_case_matches() {
    let f = fixture();
    let cases = f["cases"].as_array().unwrap();
    assert!(cases.len() >= 80, "{} cases", cases.len());
    common_oauth::check_known_differences(&f);
    for case in cases {
        replay(case).await;
    }
}

/// The recorded start answers carry the PKCE pair the token requests use:
/// each `code_challenge` is the S256 of the verifier sent for its flow.
#[test]
fn recorded_challenges_are_s256_of_the_verifiers() {
    let f = fixture();
    let mut checked = 0;
    for case in f["cases"].as_array().unwrap() {
        let mut challenges = BTreeMap::new();
        for step in case["steps"].as_array().unwrap() {
            let start = if step["op"] == "post" && step["got"]["status"] == 200 {
                serde_json::from_str::<Value>(step["got"]["body"].as_str().unwrap()).ok()
            } else if step["op"] == "start" {
                serde_json::from_str::<Value>(step["out"].as_str().unwrap()).ok()
            } else {
                None
            };
            if let Some(url) = start.as_ref().and_then(|v| v["authUrl"].as_str()) {
                let u = url::Url::parse(url).unwrap();
                let q: BTreeMap<String, String> = u.query_pairs().into_owned().collect();
                challenges.insert(q["state"].clone(), q["code_challenge"].clone());
            }
            for call in step["fetches"].as_array().into_iter().flatten() {
                let body = js::json_parse(call["body"].as_str().unwrap()).unwrap();
                let verifier = body["code_verifier"].as_str().unwrap();
                let want = &challenges[body["state"].as_str().unwrap()];
                assert_eq!(&code_challenge(verifier), want, "{}", case["name"]);
                checked += 1;
            }
        }
    }
    assert!(checked > 100, "{checked}");
}

/// CC 2.1.311: `isRefusedAuthCode(status, bodyText)` on every recorded
/// status / body pair.
#[test]
fn the_refused_code_predicate_matches_the_ts() {
    let f = fixture();
    let rows = f["refusedCodes"].as_array().unwrap();
    assert!(rows.len() >= 200, "{} rows", rows.len());
    let mut refused = 0;
    for row in rows {
        let (status, body, want) = (
            row[0].as_i64().unwrap(),
            row[1].as_str().unwrap(),
            row[2].as_bool().unwrap(),
        );
        // The status reaches the port as the response's `u16`; the recorder
        // also asks about values no HTTP response can carry.
        let got = u16::try_from(status)
            .map(|s| account_oauth::is_refused_auth_code(s, body))
            .unwrap_or(false);
        assert_eq!(got, want, "status {status}, body {body:?}");
        refused += u32::from(want);
    }
    assert!(refused >= 12, "{refused} refusals recorded");
    assert_eq!(
        account_oauth::REFUSED_AUTH_CODE_MESSAGE,
        "That code wasn't accepted. It may be incomplete, expired, already used, or from an earlier sign-in attempt. Sign in again to get a new code."
    );
}

/// CC 2.1.309: `isCaTrustFailure` / `ownRequestCertFailureHint` on every
/// recorded error shape.
#[test]
fn the_cert_hint_matches_the_ts() {
    let f = fixture();
    let rows = f["certHints"].as_array().unwrap();
    assert!(rows.len() >= 40, "{} rows", rows.len());
    let mut hinted = 0;
    for row in rows {
        let (spec, want_trust, want_hint) = (&row[0], row[1].as_bool().unwrap(), &row[2]);
        let trust = tls_cert_hint::is_ca_trust_failure(spec);
        assert_eq!(trust, want_trust, "{spec}");
        let hint = tls_cert_hint::own_request_cert_failure_hint(spec);
        assert_eq!(hint.map_or(Value::Null, Value::from), *want_hint, "{spec}");
        // The classified form the HTTPS client's verdict goes through.
        assert_eq!(tls_cert_hint::own_request_hint_for(trust), hint, "{spec}");
        hinted += u32::from(want_trust);
    }
    assert!(hinted >= 15, "{hinted} failures recorded");
}

/// The constants the authorize URL and the token request are built from.
#[test]
fn constants() {
    assert_eq!(account_oauth::FLOW_TTL_MS, 600_000);
    assert_eq!(account_oauth::TOKEN_EXPIRES_IN_S, 31_536_000);
    assert_eq!(account_oauth::OAUTH_SCOPES, ["user:inference"]);
}

/// A failing CSPRNG fails the start (TS: `randomBytes` throws, an empty
/// 500) and leaves no flow behind.
#[tokio::test]
async fn a_failing_random_source_fails_the_start() {
    let flows = OAuthFlows::new().with_random(Arc::new(|_: &mut [u8]| Err("no entropy".into())));
    assert_eq!(flows.start(), Err("no entropy".to_owned()));
    let dir = tempfile::tempdir().unwrap();
    let store = AccountsStore::new(dir.path().display().to_string(), "/nonexistent-home");
    let answer = post_route(
        &flows,
        &Scripted::default(),
        &store,
        None,
        &json!({"action": "start"}),
    )
    .await;
    assert_eq!(answer, RouteAnswer::Thrown("no entropy".into()));
    assert_eq!(flows.pending_count(), 0);
}

/// The default source is the OS CSPRNG: fresh values every start, in the
/// recorded shapes.
#[test]
fn the_default_random_source_is_fresh() {
    let flows = OAuthFlows::new();
    let a = flows.start().unwrap();
    let b = flows.start().unwrap();
    assert_ne!(a.state, b.state);
    assert_ne!(a.flow_id, b.flow_id);
    for f in [&a, &b] {
        assert_eq!(f.state.len(), 32);
        assert!(f.flow_id.starts_with("oauth_") && f.flow_id.len() == 22);
        assert!(f.auth_url.ends_with(&format!("&state={}", f.state)));
    }
    assert_eq!(flows.pending_count(), 2);
}

/// `Debug` never prints the token.
#[test]
fn debug_prints_no_secret() {
    let x = account_oauth::OAuthExchange {
        access_token: json!("sk-ant-oat01-FAKE-debug"),
        refresh_token: Some(json!("sk-ant-ort01-FAKE-debug")),
        ..Default::default()
    };
    let printed = format!("{x:?}");
    assert!(!printed.contains("FAKE-debug"), "{printed}");
}

/// No fetch is ever asked for here (the profiles are API keys).
struct NoProfileFetch;

impl claudius_core::account_profile::ProfileFetch for NoProfileFetch {
    fn get<'a>(
        &'a self,
        _: &'a str,
        _: &'a [(String, String)],
    ) -> BoxFuture<'a, Result<claudius_core::account_profile::FetchResponse, FetchError>> {
        panic!("no profile fetch expected")
    }
}

/// TS `invalidateProfileCache(added.profile.id)`: a caller that keeps the
/// profile-info cache passes it in, and the new id's entry is dropped. (A
/// fresh random id is never cached, so this takes a hand-made duplicate id.)
#[tokio::test]
async fn complete_drops_the_new_id_from_the_profile_cache() {
    use claudius_core::account_profile::ProfileInfoResolver;
    use claudius_core::claude_global_config::ClaudeGlobalConfig;

    let counter = Arc::new(Counter::default());
    let c = counter.clone();
    let flows = OAuthFlows::new().with_random(Arc::new(move |b: &mut [u8]| {
        c.fill(b);
        Ok(())
    }));
    let c = counter.clone();
    let dir = tempfile::tempdir().unwrap();
    let w = dir.path().display().to_string();
    let store = AccountsStore::new(format!("{w}/acc"), format!("{w}/home"))
        .with_random(Arc::new(move |b: &mut [u8]| c.fill(b)));
    // The id the pinned counter gives the new profile: call 3 (after the
    // start's three draws), 8 bytes.
    let id = format!(
        "acc_{}",
        (0..8)
            .map(|i| format!("{:02x}", (3 * 37 + i * 11 + 5) & 0xff))
            .collect::<String>()
    );
    let profile = |label: &str| json!({"id": id, "label": label, "kind": "api-key", "secret": "sk-ant-api03-FAKE-cache", "createdAt": "2026-01-02T03:04:05.006Z"});
    let write = |label: &str| {
        std::fs::create_dir_all(format!("{w}/acc")).unwrap();
        let state = json!({"profiles": [profile(label)], "activeProfileId": id, "autoRotateOnRateLimit": false});
        std::fs::write(format!("{w}/acc/accounts.json"), state.to_string()).unwrap();
    };
    write("Before");
    let resolver = ProfileInfoResolver::new(
        store.clone(),
        Arc::new(ClaudeGlobalConfig::new(format!("{w}/home/.claude.json"))),
        Arc::new(NoProfileFetch),
    );
    let label = |v: Option<Value>| v.unwrap()["profileLabel"].clone();
    let cached = resolver.get_profile_info_for_account(&id, false).await;
    assert_eq!(label(cached.unwrap()), "Before");
    write("Renamed");
    let still = resolver.get_profile_info_for_account(&id, false).await;
    assert_eq!(label(still.unwrap()), "Before", "cached");

    let started = post_route(
        &flows,
        &Scripted::default(),
        &store,
        Some(&resolver),
        &json!({"action": "start"}),
    )
    .await;
    let RouteAnswer::Json(200, start) = started else {
        panic!("{started:?}")
    };
    let fetch = Scripted::default();
    fetch.queue.lock().unwrap().push_back(json!({
        "status": 200,
        "statusText": "OK",
        "hex": "7b226163636573735f746f6b656e223a2266616b65227d",
    }));
    let body =
        json!({"action": "complete", "flowId": start["flowId"], "code": "c", "label": "Dup"});
    let done = post_route(&flows, &fetch, &store, Some(&resolver), &body).await;
    assert!(matches!(done, RouteAnswer::Json(200, _)), "{done:?}");
    let fresh = resolver.get_profile_info_for_account(&id, false).await;
    assert_eq!(
        label(fresh.unwrap()),
        "Renamed",
        "re-read after the sign-in"
    );
    unlock(dir.path());
}
