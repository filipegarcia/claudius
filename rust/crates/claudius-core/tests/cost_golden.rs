//! Replays the `core` half of `tests/fixtures/cost_golden.json`, recorded by
//! `rust/scripts/cost-golden.mjs` from the real `lib/server/cost-aggregate.ts`
//! and `lib/server/cost-overview.ts`, against
//! [`claudius_core::cost_aggregate`] and [`claudius_core::cost_overview`]:
//!
//! - `dayKey(ms)` per time zone (DST edges, LMT, far years, invalid dates);
//! - `rowUsd(row, table, pricing)` per row and `modelPricing` value (the
//!   200k / 100k tier boundaries, the 5m vs 1h cache-write split, the
//!   recorded `costUSD`, the `us` inference geo, the override layer, odd
//!   numbers) and `hasModelPricingOverride(pricing)`;
//! - every `aggregate(cwd)` / `aggregateOverview()` call of the recorded
//!   world, in order, on the same files (one padded root, so file sizes that
//!   hold it agree), clock and time zone: the same report text (or the same
//!   message thrown), and the same changes under `home/.claude` (folders and
//!   the per-project `.claudius-cost-cache.json` files).
//!
//! The routes replay on the binary in `claudius-server/tests/cost_routes.rs`.
#![cfg(unix)]

use std::collections::BTreeMap;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, UNIX_EPOCH};

use claudius_agent::js;
use claudius_core::cost_aggregate::{self, Clock, Row};
use claudius_core::db::{self, Mode};
use claudius_core::fetch::{Fetch, FetchError, Request, Response};
use claudius_core::litellm_pricing::{PricingCache, PricingTable};
use claudius_core::{cost_overview, db_agents, js_string, paths};
use jiff::tz::TimeZone;
use serde_json::{Value, json};

fn fixture() -> Value {
    let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/cost_golden.json");
    serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap()
}

/// A [`Fetch`] the refresh must never reach.
struct NoFetch;

impl Fetch for NoFetch {
    fn fetch<'a>(
        &'a self,
        _req: &'a Request,
    ) -> futures::future::BoxFuture<'a, Result<Response, FetchError>> {
        panic!("the refresh is disabled")
    }
}

/// The recorder's root: a temp dir (through realpath) plus `r`s up to
/// `len` characters.
fn padded_root(len: usize) -> (tempfile::TempDir, PathBuf) {
    let tmp = tempfile::tempdir().unwrap();
    let base = tmp.path().canonicalize().unwrap();
    let base_len = base.to_str().unwrap().len();
    assert!(base_len <= len - 3, "tmpdir too long: {}", base.display());
    let root = base.join("r".repeat(len - base_len - 1));
    for d in ["home", "config"] {
        std::fs::create_dir_all(root.join(d)).unwrap();
    }
    (tmp, root)
}

struct World {
    root: PathBuf,
    root_s: String,
    eroot: String,
}

impl World {
    fn norm(&self, s: &str) -> String {
        s.replace(&self.root_s, "$ROOT")
            .replace(&self.eroot, "$EROOT")
    }

    fn unnorm(&self, s: &str) -> String {
        s.replace("$EROOT", &self.eroot)
            .replace("$ROOT", &self.root_s)
    }

    fn abs(&self, rel: &str) -> PathBuf {
        self.root.join(self.unnorm(rel))
    }

    /// `snap()`: every folder under `home/.claude` ("d", "d?" when it can't
    /// be read), each cost cache's text; symlinks skipped.
    fn snap(&self) -> BTreeMap<String, String> {
        let mut out = BTreeMap::new();
        self.walk(
            &self.root.join("home/.claude"),
            "home/.claude".into(),
            0,
            &mut out,
        );
        out
    }

    fn walk(&self, p: &Path, rel: String, depth: u32, out: &mut BTreeMap<String, String>) {
        let Ok(m) = std::fs::symlink_metadata(p) else {
            return;
        };
        if m.file_type().is_symlink() {
            return;
        }
        if m.is_dir() {
            let Ok(rd) = std::fs::read_dir(p) else {
                out.insert(self.norm(&rel), "d?".into());
                return;
            };
            out.insert(self.norm(&rel), "d".into());
            if depth < 14 {
                for e in rd.flatten() {
                    let name = e.file_name().into_string().unwrap();
                    self.walk(&p.join(&name), format!("{rel}/{name}"), depth + 1, out);
                }
            }
        } else if rel.ends_with(&format!("/{}", cost_aggregate::CACHE_FILE)) {
            let text = String::from_utf8_lossy(&std::fs::read(p).unwrap()).into_owned();
            out.insert(self.norm(&rel), self.norm(&text));
        }
    }
}

fn changes(before: &BTreeMap<String, String>, after: &BTreeMap<String, String>) -> Value {
    let mut keys: Vec<&String> = before.keys().chain(after.keys()).collect();
    keys.sort();
    keys.dedup();
    Value::Array(
        keys.into_iter()
            .filter(|k| before.get(*k) != after.get(*k))
            .map(|k| json!([k, after.get(k)]))
            .collect(),
    )
}

fn hex(s: &str) -> Vec<u8> {
    (0..s.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&s[i..i + 2], 16).unwrap())
        .collect()
}

fn set_mtime(p: &Path, secs: f64) {
    let d = Duration::from_secs_f64(secs.abs());
    let t = if secs >= 0.0 {
        UNIX_EPOCH + d
    } else {
        UNIX_EPOCH - d
    };
    std::fs::File::open(p).unwrap().set_modified(t).unwrap();
}

/// A recorded number: NaN / +-Infinity / -0 are strings.
fn num(v: &Value) -> f64 {
    match v {
        Value::String(s) => match s.as_str() {
            "NaN" => f64::NAN,
            "Infinity" => f64::INFINITY,
            "-Infinity" => f64::NEG_INFINITY,
            "-0" => -0.0,
            s => panic!("not a number: {s}"),
        },
        v => v.as_f64().unwrap(),
    }
}

/// `String(x)`.
fn js_string_of(x: f64) -> String {
    if x.is_nan() {
        "NaN".into()
    } else if x == f64::INFINITY {
        "Infinity".into()
    } else if x == f64::NEG_INFINITY {
        "-Infinity".into()
    } else {
        js::number_to_string(x)
    }
}

/// Where `a` and `b` first differ, with some context.
fn first_diff(a: &str, b: &str) -> String {
    let i = a
        .bytes()
        .zip(b.bytes())
        .position(|(x, y)| x != y)
        .unwrap_or(a.len().min(b.len()));
    let lo = i.saturating_sub(120);
    let cut = |s: &str| s.get(lo..(i + 120).min(s.len())).unwrap_or("").to_owned();
    format!("at {i}:\n    got  …{}…\n    want …{}…", cut(a), cut(b))
}

#[test]
fn cost_core_replays_the_ts_golden() {
    let fx = fixture();
    let core = &fx["core"];
    let (_tmp, root) = padded_root(fx["rootLen"].as_u64().unwrap() as usize);
    let home = root.join("home");
    assert!(paths::set_home_override(home.clone()));
    assert!(paths::set_config_dir_override(root.join("config")));
    let root_s = root.to_str().unwrap().to_owned();
    let w = World {
        eroot: paths::encode_project_dir(&root_s),
        root_s,
        root: root.clone(),
    };
    let base = core["now"].as_f64().unwrap();
    let mut failures: Vec<String> = vec![];

    // The price cache, then the table every call prices with.
    let prices = home.join(".claude/.claudius-litellm-prices.json");
    std::fs::create_dir_all(prices.parent().unwrap()).unwrap();
    std::fs::write(&prices, core["prices"].as_str().unwrap()).unwrap();
    set_mtime(&prices, (base / 1000.0).floor());
    let cache = Arc::new(
        PricingCache::new(&home, Arc::new(NoFetch))
            .with_clock(move || base)
            .with_disabled(|| true),
    );
    let rt = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap();
    let table: Arc<PricingTable> = rt.block_on(cache.get_pricing_table());

    // ---- dayKey ----
    for k in core["dayKeys"].as_array().unwrap() {
        let tz = TimeZone::get(k[0].as_str().unwrap()).unwrap();
        let ms = k[1].as_f64().unwrap();
        let got = cost_aggregate::day_key_in(ms, &tz);
        if got != k[2].as_str().unwrap() {
            failures.push(format!("dayKey {} {ms}: got {got}, want {}", k[0], k[2]));
        }
    }

    // ---- rowUsd ----
    let ru = &core["rowUsd"];
    let rows: Vec<Row> = ru["rows"]
        .as_array()
        .unwrap()
        .iter()
        .map(|r| Row {
            k: r["k"].as_str().map(str::to_owned),
            m: r["m"].as_str().unwrap().to_owned(),
            d: r["d"].as_str().unwrap().to_owned(),
            i: num(&r["i"]),
            o: num(&r["o"]),
            cr: num(&r["cr"]),
            cw: num(&r["cw"]),
            cw1h: num(&r["cw1h"]),
            u: (!r["u"].is_null()).then(|| num(&r["u"])),
            geo: r["geo"].as_str().map(str::to_owned),
        })
        .collect();
    let pricings: Vec<Option<Value>> = ru["pricings"]
        .as_array()
        .unwrap()
        .iter()
        .map(|p| p.as_str().map(|t| db_agents::json_parse_js(t).unwrap()))
        .collect();
    for (p, want) in ru["hasOverride"].as_array().unwrap().iter().enumerate() {
        let got = match cost_aggregate::has_override(pricings[p].as_ref()) {
            Ok(b) => json!(b),
            Err(e) => json!({ "threw": e }),
        };
        if &got != want {
            failures.push(format!(
                "hasOverride {:?}: got {got}, want {want}",
                ru["pricings"][p]
            ));
        }
    }
    for c in ru["cases"].as_array().unwrap() {
        let (r, p) = (
            c[0].as_u64().unwrap() as usize,
            c[1].as_u64().unwrap() as usize,
        );
        let got = match cost_aggregate::row_usd(&rows[r], &table, pricings[p].as_ref()) {
            Ok(x) if x == 0.0 && x.is_sign_negative() => json!("-0"),
            Ok(x) => json!(js_string_of(x)),
            Err(e) => json!({ "threw": e }),
        };
        if got != c[2] {
            failures.push(format!(
                "rowUsd row {r} {:?} pricing {:?}: got {got}, want {}",
                ru["rows"][r], ru["pricings"][p], c[2]
            ));
        }
    }

    // ---- the steps ----
    let mut now = base;
    let mut tz = TimeZone::get("UTC").unwrap();
    let mut before = w.snap();
    for (i, s) in core["steps"].as_array().unwrap().iter().enumerate() {
        let op = s["op"].as_str().unwrap();
        let p = s["path"].as_str().map(|r| w.abs(r));
        match op {
            "write" => {
                let p = p.unwrap();
                std::fs::create_dir_all(p.parent().unwrap()).unwrap();
                let bytes = match s["hex"].as_str() {
                    Some(h) => hex(h),
                    None => w.unnorm(s["text"].as_str().unwrap()).into_bytes(),
                };
                std::fs::write(&p, bytes).unwrap();
                if let Some(t) = s["mtime"].as_f64() {
                    set_mtime(&p, t);
                }
            }
            "mkdir" => std::fs::create_dir_all(p.unwrap()).unwrap(),
            "rm" => {
                let p = p.unwrap();
                match std::fs::symlink_metadata(&p) {
                    Ok(m) if m.is_dir() => std::fs::remove_dir_all(&p).unwrap(),
                    Ok(_) => std::fs::remove_file(&p).unwrap(),
                    Err(_) => {}
                }
            }
            "chmod" => {
                let mode = s["mode"].as_u64().unwrap() as u32;
                std::fs::set_permissions(p.unwrap(), std::fs::Permissions::from_mode(mode))
                    .unwrap();
            }
            "symlink" => {
                let p = p.unwrap();
                std::fs::create_dir_all(p.parent().unwrap()).unwrap();
                std::os::unix::fs::symlink(s["target"].as_str().unwrap(), &p).unwrap();
            }
            "sql" => {
                let cwd = s["cwd"].as_str().unwrap();
                db::open_db(cwd, Mode::ReadWrite)
                    .unwrap()
                    .with(|c| c.execute_batch(s["sql"].as_str().unwrap()))
                    .unwrap();
            }
            "clock" => now = s["ms"].as_f64().unwrap(),
            "tz" => tz = TimeZone::get(s["tz"].as_str().unwrap()).unwrap(),
            "aggregate" | "overview" => {
                let clock = Clock {
                    now_ms: now,
                    tz: tz.clone(),
                };
                let r = if op == "aggregate" {
                    let cwd = s["cwd"].as_str().unwrap();
                    cost_aggregate::aggregate(cwd, &clock, &mut || table.clone())
                } else {
                    cost_overview::aggregate_overview(table.clone(), &clock)
                };
                let got = match r {
                    Ok(v) => json!({ "json": w.norm(&js_string::stringify(&v)) }),
                    Err(e) => json!({ "threw": w.norm(&e) }),
                };
                let after = w.snap();
                let changed = changes(&before, &after);
                before = after;
                let what = format!("step {i} {op} {}", s["cwd"].as_str().unwrap_or(""));
                if got != s["got"] {
                    let detail = match (got["json"].as_str(), s["got"]["json"].as_str()) {
                        (Some(a), Some(b)) => first_diff(a, b),
                        _ => format!("got {got}\n    want {}", s["got"]),
                    };
                    failures.push(format!("{what}: {detail}"));
                }
                if changed != s["changes"] {
                    let (a, b) = (changed.to_string(), s["changes"].to_string());
                    failures.push(format!("{what} changes: {}", first_diff(&a, &b)));
                }
            }
            other => panic!("unknown op {other}"),
        }
    }

    // Leave the tree removable.
    for s in core["steps"].as_array().unwrap() {
        if s["op"] == "chmod" {
            let _ = std::fs::set_permissions(
                w.abs(s["path"].as_str().unwrap()),
                std::fs::Permissions::from_mode(0o755),
            );
        }
    }
    assert!(
        failures.is_empty(),
        "{} failures:\n{}",
        failures.len(),
        failures.join("\n")
    );
}
