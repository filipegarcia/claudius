//! Replays `fixtures/cron_golden.json`, recorded by
//! `rust/scripts/cron-golden.mjs` from `lib/shared/cron.ts` (cron-parser
//! 5.5.0 + luxon) with `TZ` set to each zone in turn:
//! - `validateCron` over valid and invalid expressions;
//! - `nextFires(cron, 5, from)` for every expression × start instant, in
//!   each local zone (expressions with `H` are random and skipped);
//! - `nextFireAfter` with an explicit `tz` (luxon's zone forms included) and
//!   without one, in each local zone (a stalled iterator falls back to the
//!   local zone even with a `tz`);
//! - `nextFires` over `H` expressions with `Math.random()` pinned, and from
//!   invalid dates.
//!
//! The recorder's local zone is played by an explicit [`Zone::Tz`], and once
//! more by [`Zone::Local`] in a child process with `TZ` set.

use std::path::PathBuf;

use claudius_core::cron::{
    FIRE_ANCHOR_MAX_AGE_MS, Zone, next_fire_after, next_fire_after_in, next_fires, next_fires_in,
    next_fires_seeded, validate_cron,
};
use serde_json::{Value, json};

fn fixture() -> Value {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/cron_golden.json");
    serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap()
}

fn zone(name: &str) -> Zone {
    Zone::named(name).unwrap_or_else(|| panic!("unknown zone {name}"))
}

#[test]
fn validate_cron_matches() {
    let fx = fixture();
    let mut failures = Vec::new();
    for case in fx["validate"].as_array().unwrap() {
        let input = case["input"].as_str().unwrap();
        let got = match validate_cron(input) {
            Ok(cron) => json!({"ok": true, "cron": cron}),
            Err(error) => json!({"ok": false, "error": error}),
        };
        if got != case["got"] {
            failures.push(format!("{input:?}\n  ts:   {}\n  rust: {got}", case["got"]));
        }
    }
    assert!(failures.is_empty(), "{}", failures.join("\n"));
}

/// The `nextFires` mismatches for every expression × start in `zone`,
/// computed by `run` (an explicit zone, or the process's).
fn next_fires_failures(
    fx: &Value,
    zone_name: &str,
    run: &dyn Fn(&str, f64) -> Vec<i64>,
) -> (usize, Vec<String>) {
    let froms: Vec<f64> = fx["froms"]
        .as_array()
        .unwrap()
        .iter()
        .map(|f| f.as_f64().unwrap())
        .collect();
    let exprs = fx["expressions"].as_array().unwrap();
    let mut failures = Vec::new();
    let mut checked = 0;
    let per_expr = fx["nextFires"][zone_name].as_array().unwrap();
    for (expr, want) in exprs.iter().zip(per_expr) {
        let expr = expr.as_str().unwrap();
        let Some(want) = want.as_array() else {
            continue; // `H`: random (see `hashed`)
        };
        for (from, want) in froms.iter().zip(want) {
            checked += 1;
            let got = json!(run(expr, *from));
            if &got != want {
                failures.push(format!(
                    "{zone_name} {expr:?} from {from}\n  ts:   {want}\n  rust: {got}"
                ));
            }
        }
    }
    (checked, failures)
}

#[test]
fn next_fires_match_in_every_zone() {
    let fx = fixture();
    let mut failures = Vec::new();
    let mut checked = 0;
    for zone_name in fx["nextFires"].as_object().unwrap().keys() {
        let z = zone(zone_name);
        let (n, f) = next_fires_failures(&fx, zone_name, &|expr, from| {
            next_fires_in(expr, 5, from, z)
        });
        checked += n;
        failures.extend(f);
    }
    assert!(checked > 5000, "{checked}");
    let shown: Vec<_> = failures.iter().take(15).cloned().collect();
    assert!(
        failures.is_empty(),
        "{} of {checked} differ:\n{}",
        failures.len(),
        shown.join("\n")
    );
}

/// A recorded number: `null` is absent, a string is `Number(s)`.
fn number_of(v: &Value) -> Option<f64> {
    match v {
        Value::Null => None,
        Value::String(s) => Some(s.parse().unwrap_or(f64::NAN)),
        v => Some(v.as_f64().unwrap()),
    }
}

/// `nextFireAfter(cron, anchor, now, tz)` in some local zone.
type NextFireAfter<'a> = dyn Fn(&str, Option<f64>, f64, Option<&str>) -> Option<i64> + 'a;

/// The `nextFireAfter` mismatches in `local_name`.
fn next_fire_after_failures(fx: &Value, local_name: &str, run: &NextFireAfter<'_>) -> Vec<String> {
    let mut failures = Vec::new();
    let cases = fx["after"][local_name].as_array().unwrap();
    let bare = fx["afterLocal"][local_name].as_array().unwrap();
    for (case, want_local) in cases.iter().zip(bare) {
        let cron = case["cron"].as_str().unwrap();
        let anchor = number_of(&case["anchor"]);
        let now = number_of(&case["now"]).unwrap();
        let tz = case["tz"].as_str();
        let got = json!(run(cron, anchor, now, tz));
        if got != case["got"] {
            failures.push(format!(
                "local {local_name}, tz {tz:?}: {case}\n  rust: {got}"
            ));
        }
        let got = json!(run(cron, anchor, now, None));
        if &got != want_local {
            failures.push(format!(
                "local {local_name}, no tz: {case}\n  ts:   {want_local}\n  rust: {got}"
            ));
        }
    }
    failures
}

#[test]
fn next_fire_after_matches_with_and_without_tz() {
    let fx = fixture();
    assert_eq!(fx["anchorMaxAgeMs"].as_f64(), Some(FIRE_ANCHOR_MAX_AGE_MS));
    let mut failures = Vec::new();
    for local_name in fx["after"].as_object().unwrap().keys() {
        let local = zone(local_name);
        failures.extend(next_fire_after_failures(&fx, local_name, &|c, a, n, tz| {
            next_fire_after_in(c, a, n, tz, local)
        }));
    }
    assert!(failures.is_empty(), "{}", failures.join("\n"));
}

#[test]
fn hashed_fields_match_with_a_pinned_random() {
    let fx = fixture();
    // A zone per thread: the stalling cases run 9 999 steps a fire.
    let failures: Vec<String> = std::thread::scope(|scope| {
        let runs: Vec<_> = fx["hashed"]
            .as_object()
            .unwrap()
            .iter()
            .map(|(zone_name, h)| scope.spawn(move || hashed_failures(zone_name, h)))
            .collect();
        runs.into_iter().flat_map(|r| r.join().unwrap()).collect()
    });
    assert!(failures.is_empty(), "{}", failures.join("\n"));
}

/// The seeded `nextFires` mismatches recorded in one zone.
fn hashed_failures(zone_name: &str, h: &Value) -> Vec<String> {
    let z = zone(zone_name);
    let froms = h["froms"].as_array().unwrap();
    let randoms = h["randoms"].as_array().unwrap();
    let mut failures = Vec::new();
    for (expr, per_random) in h["expressions"]
        .as_array()
        .unwrap()
        .iter()
        .zip(h["got"].as_array().unwrap())
    {
        let expr = expr.as_str().unwrap();
        for (r, per_from) in randoms.iter().zip(per_random.as_array().unwrap()) {
            let r = r.as_f64().unwrap();
            for (from, want) in froms.iter().zip(per_from.as_array().unwrap()) {
                let from = from.as_f64().unwrap();
                let got = json!(next_fires_seeded(expr, 5, from, z, r));
                if &got != want {
                    failures.push(format!(
                        "{zone_name} {expr:?} random {r} from {from}\n  ts:   {want}\n  rust: {got}"
                    ));
                }
            }
        }
    }
    failures
}

#[test]
fn an_invalid_start_date_has_no_fires() {
    let fx = fixture();
    for case in fx["edges"].as_array().unwrap() {
        let from = number_of(&case["from"]).unwrap();
        let got = json!(next_fires_in("* * * * *", 5, from, Zone::Fixed(0)));
        assert_eq!(got, case["got"], "{case}");
    }
}

/// [`Zone::Local`] is the process's zone, as Node's: each recorder zone is
/// replayed in a child test process with `TZ` set to it.
#[test]
fn the_local_zone_follows_tz() {
    const CHILD: &str = "CRON_GOLDEN_LOCAL_ZONE";
    let fx = fixture();
    if let Ok(zone_name) = std::env::var(CHILD) {
        let (checked, mut failures) =
            next_fires_failures(&fx, &zone_name, &|expr, from| next_fires(expr, 5, from));
        assert!(checked > 700, "{checked}");
        failures.extend(next_fire_after_failures(&fx, &zone_name, &next_fire_after));
        let shown: Vec<_> = failures.iter().take(15).cloned().collect();
        assert!(failures.is_empty(), "{}", shown.join("\n"));
        return;
    }
    let exe = std::env::current_exe().unwrap();
    for zone_name in fx["nextFires"].as_object().unwrap().keys() {
        let out = std::process::Command::new(&exe)
            .args(["--exact", "the_local_zone_follows_tz", "--test-threads=1"])
            .env("TZ", zone_name)
            .env(CHILD, zone_name)
            .output()
            .unwrap();
        assert!(
            out.status.success(),
            "TZ={zone_name}:\n{}\n{}",
            String::from_utf8_lossy(&out.stdout),
            String::from_utf8_lossy(&out.stderr)
        );
        // The filter matched: the child ran the replay, not zero tests.
        assert!(
            String::from_utf8_lossy(&out.stdout).contains("1 passed"),
            "TZ={zone_name}: {}",
            String::from_utf8_lossy(&out.stdout)
        );
    }
}
