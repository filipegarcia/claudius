//! Replays `fixtures/keepalive_golden.json`, recorded by
//! `rust/scripts/keepalive-golden.mjs` from `lib/server/loop-keepalive.ts`
//! with TZ=America/New_York: `isLoopArmed` for wake-ups and session crons at
//! every edge (the tick grace, the 7-day cap, a one-shot cron's first fire),
//! and `hasArmedLoop` over lists. The recorder's local zone is played by an
//! explicit zone.

use std::path::PathBuf;

use claudius_core::cron::Zone;
use claudius_core::loop_keepalive::{
    LOOP_KEEPALIVE_MAX_MS, LOOP_TICK_GRACE_MS, has_armed_loop_in, is_loop_armed_in,
};
use claudius_core::session_loops::{LoopKind, SessionLoop};
use serde_json::Value;

fn fixture() -> Value {
    let path =
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/keepalive_golden.json");
    serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap()
}

/// A recorded `SessionLoop` object.
fn loop_of(v: &Value) -> SessionLoop {
    let text = |k: &str| v[k].as_str().map(str::to_owned);
    SessionLoop {
        kind: match v["kind"].as_str().unwrap() {
            "wakeup" => LoopKind::Wakeup,
            "cron" => LoopKind::Cron,
            k => panic!("kind {k}"),
        },
        id: text("id").unwrap(),
        tool_use_id: text("toolUseId").unwrap(),
        cron: text("cron"),
        human_schedule: text("humanSchedule"),
        delay_seconds: v["delaySeconds"].as_f64(),
        prompt: text("prompt").unwrap(),
        reason: text("reason"),
        recurring: v["recurring"].as_bool().unwrap(),
        durable: v["durable"].as_bool().unwrap(),
        started_at: v["startedAt"].as_i64().unwrap(),
        next_fire_at: v["nextFireAt"].as_f64(),
        noop: v["noop"].as_bool().unwrap_or(false),
        noop_streak: v["noopStreak"].as_u64().unwrap_or(0),
        cancelled: v["cancelled"].as_bool().unwrap(),
    }
}

#[test]
fn is_loop_armed_matches_at_every_edge() {
    let fx = fixture();
    assert_eq!(fx["graceMs"].as_i64(), Some(LOOP_TICK_GRACE_MS));
    assert_eq!(fx["maxMs"].as_i64(), Some(LOOP_KEEPALIVE_MAX_MS));
    let zone = Zone::named(fx["zone"].as_str().unwrap()).unwrap();
    let mut failures = Vec::new();
    let mut checked = 0;
    for case in fx["cases"].as_array().unwrap() {
        let l = loop_of(&case["loop"]);
        let nows = case["nows"].as_array().unwrap();
        for (now, want) in nows.iter().zip(case["got"].as_array().unwrap()) {
            checked += 1;
            let now = now.as_i64().unwrap();
            let got = is_loop_armed_in(&l, now, zone);
            if Some(got) != want.as_bool() {
                failures.push(format!("{} at {now}: ts {want}, rust {got}", case["loop"]));
            }
        }
    }
    assert!(checked > 300, "{checked}");
    assert!(failures.is_empty(), "{}", failures.join("\n"));
}

#[test]
fn has_armed_loop_matches() {
    let fx = fixture();
    let zone = Zone::named(fx["zone"].as_str().unwrap()).unwrap();
    for case in fx["lists"].as_array().unwrap() {
        let loops: Vec<SessionLoop> = case["loops"]
            .as_array()
            .unwrap()
            .iter()
            .map(loop_of)
            .collect();
        let got = has_armed_loop_in(&loops, case["now"].as_i64().unwrap(), zone);
        assert_eq!(Some(got), case["got"].as_bool(), "{case}");
    }
}
