//! Session usage parity (S17): `price_for`, `cost_from_tokens`,
//! `inference_geo_multiplier`, the start-of-session seed (the resumed CLI's
//! `cost-state` checkpoint + `seed_usage_totals`), the result fold
//! (`fold_result_into_usage`) and `last_recorded_cost_state`, replayed
//! against what `lib/shared/cost-pricing.ts`, the real
//! `Session.prototype.seedUsageBaseline`, `foldResultIntoSessionUsage` and
//! `lastRecordedCostState` produced (`rust/scripts/usage-estimate-golden.mjs`),
//! including the `session_usage` row the seed leaves behind. Numbers are
//! compared as `JSON.stringify` text.

use std::path::{Path, PathBuf};
use std::sync::OnceLock;

use claudius_agent::js;
use claudius_core::cost_pricing::{
    MODEL_PRICING_MULTIPLIER_MAX, TokenBreakdown, cost_from_tokens, inference_geo_multiplier,
    price_for,
};
use claudius_core::sessions_db::{self, SdkCumulative, UsageTotals};
use claudius_core::{paths, sdk_cost_state, usage_seed};
use serde_json::{Value, json};

fn fixture() -> &'static Value {
    static F: OnceLock<Value> = OnceLock::new();
    F.get_or_init(|| {
        serde_json::from_str(include_str!("fixtures/usage_estimate_golden.json")).unwrap()
    })
}

/// An isolated `$HOME` (the per-project databases and transcripts live under
/// it), once per test binary; each case gets its own project dir in it.
fn root() -> &'static Path {
    static R: OnceLock<(tempfile::TempDir, PathBuf)> = OnceLock::new();
    &R.get_or_init(|| {
        let root = tempfile::tempdir().unwrap();
        let home = root.path().join("home");
        std::fs::create_dir_all(&home).unwrap();
        assert!(paths::set_home_override(home));
        assert!(paths::set_config_dir_override(root.path().join("config")));
        let canonical = root.path().canonicalize().unwrap();
        (root, canonical)
    })
    .1
}

/// A fresh project dir (`<root>/<name>`) as a cwd string.
fn project(name: &str) -> String {
    let dir = root().join(name);
    std::fs::create_dir_all(&dir).unwrap();
    dir.display().to_string()
}

/// Writes a case's transcript files under the project root, as recorded.
fn write_files(cwd: &str, files: &Value) {
    let base = paths::project_root(cwd);
    for f in files.as_array().unwrap() {
        let path = base.join(f["rel"].as_str().unwrap());
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        if let Some(text) = f["text"].as_str() {
            std::fs::write(&path, text).unwrap();
        } else if let Some(hex) = f["hex"].as_str() {
            let bytes: Vec<u8> = (0..hex.len())
                .step_by(2)
                .map(|i| u8::from_str_radix(&hex[i..i + 2], 16).unwrap())
                .collect();
            std::fs::write(&path, bytes).unwrap();
        } else {
            let target = f["symlink"].as_str().unwrap();
            std::os::unix::fs::symlink(target, &path).unwrap();
        }
    }
}

fn model_of(case: &Value) -> Option<&str> {
    case["model"].as_str()
}

#[test]
fn prices_match() {
    let f = fixture();
    assert_eq!(
        f["multiplierMax"],
        json!(MODEL_PRICING_MULTIPLIER_MAX as i64)
    );
    let prices = f["prices"].as_array().unwrap();
    assert!(prices.len() >= 35);
    for c in prices {
        let p = price_for(model_of(c));
        let got = json!({
            "input": p.input, "output": p.output, "cacheRead": p.cache_read,
            "cacheWrite5m": p.cache_write_5m, "cacheWrite1h": p.cache_write_1h,
        });
        assert_eq!(
            js::stringify(&got),
            js::stringify(&c["pricing"]),
            "{}",
            c["model"]
        );
    }
}

#[test]
fn costs_match() {
    let costs = fixture()["costs"].as_array().unwrap();
    assert!(costs.len() >= 300);
    for c in costs {
        let t = &c["tokens"];
        let n = |k: &str| t[k].as_f64().unwrap();
        let tokens = TokenBreakdown {
            input: n("input"),
            output: n("output"),
            cache_read: n("cacheRead"),
            cache_write_5m: n("cacheWrite5m"),
            cache_write_1h: n("cacheWrite1h"),
        };
        let got = js::number_to_string(cost_from_tokens(model_of(c), &tokens));
        assert_eq!(got, c["cost"].as_str().unwrap(), "{} {t}", c["model"]);
    }
}

#[test]
fn the_geo_multiplier_matches() {
    for c in fixture()["geo"].as_array().unwrap() {
        let got = inference_geo_multiplier(c["geo"].as_str());
        assert_eq!(
            js::number_to_string(got),
            js::stringify(&c["multiplier"]),
            "{}",
            c["geo"]
        );
    }
}

/// A recorded `SessionUsageTotals` as the Rust struct.
fn totals(v: &Value) -> UsageTotals {
    let n = |k: &str| v[k].as_f64().unwrap();
    UsageTotals {
        total_cost_usd: n("totalCostUsd"),
        num_turns: n("numTurns"),
        duration_ms: n("durationMs"),
        duration_api_ms: n("durationApiMs"),
        input_tokens: n("inputTokens"),
        output_tokens: n("outputTokens"),
        cache_read_input_tokens: n("cacheReadInputTokens"),
        cache_creation_input_tokens: n("cacheCreationInputTokens"),
        model_usage: v["modelUsage"].as_object().cloned(),
    }
}

/// A recorded `SdkCumulativeUsage` as the Rust struct.
fn cumulative(v: &Value) -> SdkCumulative {
    SdkCumulative {
        total_cost_usd: v["totalCostUsd"].as_f64().unwrap(),
        duration_api_ms: v["durationApiMs"].as_f64().unwrap(),
        model_usage: v["modelUsage"].as_object().cloned(),
    }
}

#[test]
fn the_session_seed_matches() {
    let seeds = fixture()["seeds"].as_array().unwrap();
    assert!(seeds.len() >= 30);
    let (mut estimated, mut checkpoints) = (0, 0);
    for c in seeds {
        let (name, id) = (c["name"].as_str().unwrap(), c["id"].as_str().unwrap());
        let cwd = project(&format!("project-{}", c["case"].as_str().unwrap()));
        write_files(&cwd, &c["files"]);
        if !c["persisted"].is_null() {
            sessions_db::save_session_usage(&cwd, id, &totals(&c["persisted"])).unwrap();
        }
        let resume = c["resume"].as_str();
        // Session start: the checkpoint the resumed CLI restores, then totals.
        let checkpoint = resume
            .and_then(|r| sdk_cost_state::last_recorded_cost_state(r, &cwd))
            .unwrap_or_default();
        checkpoints += usize::from(checkpoint != SdkCumulative::default());
        assert_eq!(
            js::stringify(&checkpoint.to_json()),
            c["checkpoint"].as_str().unwrap(),
            "{name}: checkpoint"
        );
        let seeded = usage_seed::seed_usage_totals(&cwd, id, resume);
        estimated += usize::from(seeded.is_some() && c["persisted"].is_null());
        assert_eq!(
            js::stringify(&seeded.unwrap_or_default().to_json()),
            c["totals"].as_str().unwrap(),
            "{name}: totals"
        );
        let row = sessions_db::get_session_usage(&cwd, id).map(|u| js::stringify(&u.to_json()));
        assert_eq!(row.as_deref(), c["row"].as_str(), "{name}: row");
    }
    assert!(estimated >= 20, "{estimated}");
    assert!(checkpoints >= 4, "{checkpoints}");
}

#[test]
fn the_result_fold_matches() {
    let folds = fixture()["folds"].as_array().unwrap();
    assert!(folds.len() >= 10);
    let mut steps = 0;
    for c in folds {
        let name = c["name"].as_str().unwrap();
        let mut totals_now = totals(&c["totals"]);
        let mut last = cumulative(&c["last"]);
        for (i, (message, want)) in c["messages"]
            .as_array()
            .unwrap()
            .iter()
            .zip(c["steps"].as_array().unwrap())
            .enumerate()
        {
            steps += 1;
            match sessions_db::fold_result_into_usage(&totals_now, &last, message) {
                None => assert!(want.is_null(), "{name} #{i}: folded nothing, want {want}"),
                Some((t, l)) => {
                    assert!(!want.is_null(), "{name} #{i}: folded, want nothing");
                    assert_eq!(
                        js::stringify(&t.to_json()),
                        want["totals"].as_str().unwrap(),
                        "{name} #{i}: totals"
                    );
                    assert_eq!(
                        js::stringify(&l.to_json()),
                        want["last"].as_str().unwrap(),
                        "{name} #{i}: last"
                    );
                    (totals_now, last) = (t, l);
                }
            }
        }
    }
    assert!(steps >= 30, "{steps}");
}

#[test]
fn the_cost_state_checkpoint_matches() {
    let f = &fixture()["costStates"];
    let cases = f["cases"].as_array().unwrap();
    assert!(cases.len() >= 8);
    let cwd = project("project-cost-state");
    write_files(&cwd, &f["files"]);
    let mut found = 0;
    for c in cases {
        let id = c["id"].as_str().unwrap();
        let got = sdk_cost_state::last_recorded_cost_state(id, &cwd);
        found += usize::from(got.is_some());
        let got = got.map_or_else(|| "null".to_owned(), |cp| js::stringify(&cp.to_json()));
        assert_eq!(got, c["checkpoint"].as_str().unwrap(), "{id:?}");
    }
    assert_eq!(found, 2);
}
