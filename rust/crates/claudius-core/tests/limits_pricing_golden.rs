//! Replays `tests/fixtures/limits_pricing_golden.json`, recorded by
//! `rust/scripts/limits-pricing-golden.mjs` from the real
//! `lib/server/limits-store.ts` and `lib/server/litellm-pricing.ts`, against
//! [`claudius_core::limits_store`] and [`claudius_core::litellm_pricing`]:
//! the day key per time zone, the bundled table, the table and status a disk
//! cache gives, `priceForModel`, `costFromUsage`, and the background refresh
//! (the same cache files and mtimes, the same scripted upstream behind the
//! real [`HttpsClient`], the same `Date.now()`), and the `modelPricing`
//! override layer ([`claudius_core::model_pricing_override`]) over the same
//! settings, models and token counts. The routes are replayed against the
//! binary in `claudius-server/tests/limits_prices.rs`.

use std::collections::VecDeque;
use std::io::{Read, Write};
use std::net::{Shutdown, TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, UNIX_EPOCH};

use claudius_agent::js;
use claudius_core::asset_store::sha256_hex;
use claudius_core::fetch::{Fetch, HttpsClient};
use claudius_core::limits_store::today_key_in;
use claudius_core::litellm_pricing::{
    self as lp, LiteLlmPricing, OBJECT_PROTOTYPE_KEYS, PriceMatch, PricingCache, PricingTable,
    Usage,
};
use claudius_core::model_pricing_override::{self as mpo, OverrideTokens};
use claudius_core::{db_agents, js_string, limits_store};
use serde_json::{Value, json};

fn fixture() -> Value {
    let path =
        Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/limits_pricing_golden.json");
    serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap()
}

/// `{count, sha256, delta}` of a table, as the recorder summarises one.
fn summary(t: &PricingTable) -> Value {
    let bundle = lp::bundled();
    let bundle_keys: Vec<&str> = bundle.keys().collect();
    let mut delta = vec![];
    for (i, (k, v)) in t.iter().enumerate() {
        if delta.len() == 30 {
            break;
        }
        let entry = js_string::stringify(&v.to_json());
        let same = bundle_keys.get(i) == Some(&k)
            && bundle.get(k).map(|b| js_string::stringify(&b.to_json())) == Some(entry.clone());
        if !same {
            delta.push(json!([i, js_string::stringify(&json!(k)), entry]));
        }
    }
    json!({
        "count": t.len(),
        "sha256": sha256_hex(js_string::stringify(&t.to_json()).as_bytes()),
        "delta": delta,
    })
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

fn rm(p: &Path) {
    match std::fs::symlink_metadata(p) {
        Ok(m) if m.is_dir() => std::fs::remove_dir_all(p).unwrap(),
        Ok(_) => std::fs::remove_file(p).unwrap(),
        Err(_) => {}
    }
}

fn hex(s: &str) -> Vec<u8> {
    (0..s.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&s[i..i + 2], 16).unwrap())
        .collect()
}

/// A home with its `.claude` folder, and the price cache path in it.
fn home() -> (tempfile::TempDir, PathBuf) {
    let d = tempfile::tempdir().unwrap();
    std::fs::create_dir_all(d.path().join(".claude")).unwrap();
    let cache = d.path().join(".claude").join(lp::CACHE_FILE);
    (d, cache)
}

/// A [`Fetch`] the refresh must never reach.
struct NoFetch;

impl Fetch for NoFetch {
    fn fetch<'a>(
        &'a self,
        _req: &'a claudius_core::fetch::Request,
    ) -> futures::future::BoxFuture<'a, Result<claudius_core::fetch::Response, String>> {
        panic!("the refresh is disabled")
    }
}

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
            // Let the client read to the end before the socket goes.
            let _ = conn.set_read_timeout(Some(Duration::from_secs(2)));
            let _ = conn.read(&mut buf);
        }
        _ => {
            let _ = conn.shutdown(Shutdown::Both);
        }
    }
}

/// What the recorder saw at the cache path.
fn cache_state(p: &Path) -> Value {
    match std::fs::symlink_metadata(p) {
        Ok(m) if m.is_dir() => json!("dir"),
        Ok(_) => {
            let b = std::fs::read(p).unwrap();
            json!({"sha256": sha256_hex(&b), "bytes": b.len()})
        }
        Err(_) => Value::Null,
    }
}

#[test]
fn today_key_is_the_local_date() {
    let fx = fixture();
    for t in fx["today"].as_array().unwrap() {
        let tz = jiff::tz::TimeZone::get(t["tz"].as_str().unwrap()).unwrap();
        let ms = t["ms"].as_f64().unwrap() as i64;
        assert_eq!(today_key_in(ms, &tz), t["key"].as_str().unwrap(), "{t}");
    }
}

#[test]
fn object_prototype_keys_are_v8s() {
    let fx = fixture();
    let got: Vec<Value> = OBJECT_PROTOTYPE_KEYS.iter().map(|k| json!(k)).collect();
    assert_eq!(Value::Array(got), fx["protoKeys"]);
}

#[test]
fn the_bundle_is_the_ts_normalized_snapshot() {
    let fx = fixture();
    let b = lp::bundled();
    assert_eq!(json!(b.len()), fx["bundle"]["count"]);
    assert_eq!(
        js_string::stringify(&b.to_json()),
        fx["bundle"]["text"].as_str().unwrap()
    );
}

#[tokio::test]
async fn the_cache_overlays_the_bundle() {
    let fx = fixture();
    let now = fx["now"].as_f64().unwrap();
    let mut failures = vec![];
    for case in fx["tables"].as_array().unwrap() {
        let (home, cache) = home();
        match &case["cache"] {
            Value::Null => {}
            c if c.get("dir").is_some() => std::fs::create_dir(&cache).unwrap(),
            c => match c.get("hex") {
                Some(h) => std::fs::write(&cache, hex(h.as_str().unwrap())).unwrap(),
                None => std::fs::write(&cache, c["text"].as_str().unwrap()).unwrap(),
            },
        }
        if !case["mtimeNs"].is_null() {
            set_mtime(&cache, &case["mtimeNs"]);
        }
        let pc = Arc::new(
            PricingCache::new(home.path(), Arc::new(NoFetch))
                .with_clock(move || now)
                .with_disabled(|| true),
        );
        let status = js_string::stringify(&pc.get_pricing_status().to_json());
        let table = summary(&*pc.get_pricing_table().await);
        if status != case["status"].as_str().unwrap() || table != case["table"] {
            failures.push(format!(
                "{}:\n  status {status}\n  want   {}\n  table {table}\n  want  {}",
                case["name"], case["status"], case["table"]
            ));
        }
    }
    assert!(failures.is_empty(), "{}", failures.join("\n"));
}

#[test]
fn price_for_model_picks_the_ts_entry() {
    let fx = fixture();
    let custom: Vec<PricingTable> = fx["customTables"]
        .as_array()
        .unwrap()
        .iter()
        .map(|t| PricingTable::normalize(&db_agents::json_parse_js(t.as_str().unwrap()).unwrap()))
        .collect();
    let mut failures = vec![];
    for l in fx["lookups"].as_array().unwrap() {
        let table = match l["t"].as_i64().unwrap() {
            -1 => lp::bundled(),
            i => &custom[i as usize],
        };
        let model = str16(&l["model"]);
        let got = match lp::match_model(model.as_deref(), table) {
            None => Value::Null,
            Some(PriceMatch::Key(k)) => json!(k),
            Some(PriceMatch::Inherited) => json!("inherited"),
        };
        let want = match &l["got"] {
            w if w.get("inherited").is_some() => json!("inherited"),
            w => str16(w).map_or(Value::Null, |k| json!(k)),
        };
        if got != want {
            failures.push(format!("{l}: got {got}"));
        }
        // An inherited hit prices nothing; an own one is that entry.
        let priced = lp::price_for_model(model.as_deref(), table);
        match lp::match_model(model.as_deref(), table) {
            None => assert_eq!(priced, None),
            Some(PriceMatch::Inherited) => assert_eq!(priced, Some(LiteLlmPricing::default())),
            Some(PriceMatch::Key(k)) => assert_eq!(priced.as_ref(), table.get(k)),
        }
    }
    assert!(failures.is_empty(), "{}", failures.join("\n"));
}

/// A recorded number: NaN, the infinities and -0 are strings.
fn num(v: &Value) -> f64 {
    match v.as_str() {
        Some("NaN") => f64::NAN,
        Some("Infinity") => f64::INFINITY,
        Some("-Infinity") => f64::NEG_INFINITY,
        Some("-0") => -0.0,
        Some(s) => panic!("{s}"),
        None => v.as_f64().unwrap(),
    }
}

fn pricing(v: &Value) -> Option<LiteLlmPricing> {
    let mut p = LiteLlmPricing::default();
    for (k, v) in v.as_object()? {
        let f = Some(num(v));
        match k.as_str() {
            "input_cost_per_token" => p.input_cost_per_token = f,
            "output_cost_per_token" => p.output_cost_per_token = f,
            "cache_creation_input_token_cost" => p.cache_creation_input_token_cost = f,
            "cache_read_input_token_cost" => p.cache_read_input_token_cost = f,
            "input_cost_per_token_above_100k_tokens" => {
                p.input_cost_per_token_above_100k_tokens = f;
            }
            "output_cost_per_token_above_100k_tokens" => {
                p.output_cost_per_token_above_100k_tokens = f;
            }
            "cache_creation_input_token_cost_above_100k_tokens" => {
                p.cache_creation_input_token_cost_above_100k_tokens = f;
            }
            "cache_read_input_token_cost_above_100k_tokens" => {
                p.cache_read_input_token_cost_above_100k_tokens = f;
            }
            "input_cost_per_token_above_200k_tokens" => {
                p.input_cost_per_token_above_200k_tokens = f;
            }
            "output_cost_per_token_above_200k_tokens" => {
                p.output_cost_per_token_above_200k_tokens = f;
            }
            "cache_creation_input_token_cost_above_200k_tokens" => {
                p.cache_creation_input_token_cost_above_200k_tokens = f;
            }
            "cache_read_input_token_cost_above_200k_tokens" => {
                p.cache_read_input_token_cost_above_200k_tokens = f;
            }
            k => panic!("{k}"),
        }
    }
    Some(p)
}

/// `String(x)`, `-0` kept apart.
fn show(x: f64) -> String {
    if x.is_nan() {
        "NaN".into()
    } else if x.is_infinite() {
        if x > 0.0 { "Infinity" } else { "-Infinity" }.into()
    } else if x == 0.0 && x.is_sign_negative() {
        "-0".into()
    } else {
        js::number_to_string(x)
    }
}

#[test]
fn cost_from_usage_is_the_ts_arithmetic() {
    let fx = fixture();
    let pricings: Vec<Option<LiteLlmPricing>> = fx["pricings"]
        .as_array()
        .unwrap()
        .iter()
        .map(pricing)
        .collect();
    let usages: Vec<Usage> = fx["usages"]
        .as_array()
        .unwrap()
        .iter()
        .map(|u| Usage {
            input: num(&u["input"]),
            output: num(&u["output"]),
            cache_read: num(&u["cacheRead"]),
            cache_creation: num(&u["cacheCreation"]),
            cache_creation_1h: u.get("cacheCreation1h").map(num),
        })
        .collect();
    let mut failures = vec![];
    for c in fx["costs"].as_array().unwrap() {
        let (p, u) = (
            c["p"].as_u64().unwrap() as usize,
            c["u"].as_u64().unwrap() as usize,
        );
        let got = show(lp::cost_from_usage(pricings[p].as_ref(), &usages[u]));
        if got != c["got"].as_str().unwrap() {
            failures.push(format!("{c}: got {got}"));
        }
    }
    assert!(failures.is_empty(), "{}", failures.join("\n"));
}

/// On a current-thread runtime the refreshes run only when the test awaits
/// them (`settle`), as the TS's do only once its event loop turns: on the
/// server's worker threads one can land between two back-to-back calls.
#[tokio::test]
async fn the_background_refresh_follows_the_ts() {
    let fx = fixture();
    let now = fx["now"].as_f64().unwrap();
    let (base, up) = upstream();
    let (home, cache) = home();
    let disabled = Arc::new(AtomicBool::new(false));
    let off = disabled.clone();
    let fetch: Arc<dyn Fetch> = Arc::new(HttpsClient::new().with_base(base));
    let pc = Arc::new(
        PricingCache::new(home.path(), fetch)
            .with_clock(move || now)
            .with_disabled(move || off.load(Ordering::SeqCst)),
    );
    for step in fx["background"].as_array().unwrap() {
        let name = step["name"].as_str().unwrap();
        match step.get("env") {
            Some(Value::Null) => disabled.store(false, Ordering::SeqCst),
            Some(v) => disabled.store(lp::disabled_by_env(v.as_str()), Ordering::SeqCst),
            None => {}
        }
        if step["rm"] == true {
            rm(&cache);
        }
        if step["mkdir"] == true {
            std::fs::create_dir(&cache).unwrap();
        }
        if let Some(w) = step["write"].as_str() {
            std::fs::write(&cache, w).unwrap();
        }
        if let Some(ns) = step.get("mtimeNs") {
            set_mtime(&cache, ns);
        }
        if step["reset"] == true {
            pc.reset_memo();
        }
        {
            let mut u = up.lock().unwrap();
            u.queue = step["upstream"]
                .as_array()
                .cloned()
                .unwrap_or_default()
                .into();
            u.served.clear();
        }
        let mut got = vec![];
        for _ in 0..step["calls"].as_u64().unwrap_or(1) {
            got.push(summary(&*pc.get_pricing_table().await));
        }
        pc.settle().await;
        let u = up.lock().unwrap();
        assert!(
            u.queue.is_empty() && u.unscripted == 0,
            "{name}: upstream unused or short"
        );
        assert_eq!(Value::Array(got), step["got"], "{name}: tables");
        assert_eq!(json!(u.served), step["served"], "{name}: served");
        assert_eq!(cache_state(&cache), step["cache"], "{name}: cache");
    }
}

// ------------------------------- the modelPricing override -------------------------------

/// `typeof v` for a settings value (`None` is `undefined`).
fn type_of(v: Option<&Value>) -> &'static str {
    match v {
        None => "undefined",
        Some(v) if db_agents::number(v).is_some() => "number",
        Some(Value::String(_)) => "string",
        Some(Value::Bool(_)) => "boolean",
        Some(Value::Null | Value::Array(_) | Value::Object(_)) => "object",
        Some(Value::Number(_)) => "number",
    }
}

/// A recorded string: itself, or `{u: [code units]}` when it holds a lone
/// surrogate.
fn str16(v: &Value) -> Option<String> {
    match v {
        Value::Null => None,
        Value::String(s) => Some(s.clone()),
        v => {
            let units: Vec<u16> = v["u"]
                .as_array()
                .unwrap()
                .iter()
                .map(|n| n.as_u64().unwrap() as u16)
                .collect();
            Some(js_string::from_units(&units))
        }
    }
}

/// A `Result` as the recorder wrote it: the value, or `{threw}`.
fn settled(r: Result<Value, String>) -> Value {
    match r {
        Ok(v) => v,
        Err(t) => json!({ "threw": t }),
    }
}

#[test]
fn model_pricing_override_is_the_ts_layer() {
    let fx = fixture();
    let mp = &fx["modelPricing"];
    let base = mp["base"].as_f64().unwrap();
    let tokens: Vec<OverrideTokens> = mp["tokens"]
        .as_array()
        .unwrap()
        .iter()
        .map(|t| OverrideTokens {
            input: num(&t["input"]),
            output: num(&t["output"]),
            cache_read: num(&t["cacheRead"]),
            cache_write: num(&t["cacheWrite"]),
            cache_write_1h: t.get("cacheWrite1h").map(num),
        })
        .collect();
    let mut failures = vec![];
    for c in mp["cases"].as_array().unwrap() {
        let p = db_agents::json_parse_js(c["s"].as_str().unwrap()).unwrap();
        let t = &tokens[c["t"].as_u64().unwrap() as usize];
        let model = str16(&c["model"]).unwrap();
        let model = model.as_str();
        let want = &c["got"];
        let mut got = serde_json::Map::new();

        // `effectiveOverrideRates`, as `J(rates)` wrote it (`undefined` null).
        let rates = mpo::effective_override_rates(&p);
        got.insert(
            "rates".into(),
            settled(rates.clone().map(|r| match r {
                None => Value::Null,
                Some(v) => json!(limits_store::to_text(&v, false)),
            })),
        );
        // `effectiveMultiplier`: its `typeof` and `String()`.
        got.insert(
            "mult".into(),
            settled(mpo::effective_multiplier(&p).map(|m| {
                json!({
                    "type": type_of(m.as_ref()),
                    "text": m.as_ref().map(|v| json!(db_agents::js_string(v))).unwrap_or(Value::Null),
                })
            })),
        );
        if let Ok(rates) = &rates {
            let rate = mpo::match_model_pricing_rate(model, rates.as_ref());
            got.insert(
                "match".into(),
                match &rate {
                    None => Value::Null,
                    Some(mpo::RateMatch::Inherited) => json!("inherited"),
                    Some(mpo::RateMatch::Entry { key, .. }) => json!(key),
                },
            );
            if let Some(r) = &rate {
                got.insert("truthy".into(), json!(r.truthy()));
                if r.truthy() {
                    got.insert(
                        "cost".into(),
                        settled(
                            r.rate()
                                .and_then(|rate| mpo::cost_from_override_rate(&rate, t))
                                .map(|usd| json!(show(usd))),
                        ),
                    );
                }
            } else {
                got.insert("truthy".into(), json!(false));
            }
        }
        got.insert(
            "apply".into(),
            settled(mpo::apply_model_pricing(base, model, t, Some(&p)).map(|usd| json!(show(usd)))),
        );
        got.insert(
            "has".into(),
            settled(mpo::has_model_pricing_override(Some(&p)).map(Value::Bool)),
        );

        // An Object.prototype (or `length`) hit is recorded with its typeof,
        // and a key with a lone surrogate as its code units.
        let mut want = want.clone();
        if want["match"].get("inherited").is_some() {
            want["match"] = json!("inherited");
        } else if want["match"].is_object() {
            want["match"] = json!(str16(&want["match"]).unwrap());
        }
        if Value::Object(got.clone()) != want {
            failures.push(format!(
                "{} {model:?} t{}:\n  got  {}\n  want {want}",
                c["s"],
                c["t"],
                Value::Object(got)
            ));
        }
    }
    assert!(
        failures.is_empty(),
        "{} cases differ:\n{}",
        failures.len(),
        failures.join("\n")
    );
}
