//! Feedback nudge parity (S26), replayed against what the TS recorded in
//! `tests/fixtures/feedback_survey_golden.json`
//! (`rust/scripts/feedback-survey-golden.mjs`):
//! - `rates` / `decisions`: `coerce_survey_rate` and `should_offer_survey`
//!   against `coerceSurveyRate` / `shouldOfferSurvey`, the `Math.random`
//!   draws included;
//! - `offers`: [`FeedbackSurvey::maybe_offer`] plus the event a session
//!   broadcasts, against the real `Session.prototype.maybeOfferFeedbackSurvey`,
//!   step by step on one throttle per scenario, with the user settings.json
//!   recreated under this binary's `$HOME`;
//! - `submits`: `Session::submit_feedback` on a real session with the fake
//!   CLI, against the real `Session.prototype.submitFeedback` on an SDK
//!   query: the result and the `submit_feedback` request on the wire, byte
//!   for byte (the request id as `$ID`).

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicI64, AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, OnceLock};
use std::time::Duration;

use claudius_agent::js;
use claudius_core::feedback_survey::{
    DEFAULT_FEEDBACK_SURVEY_RATE, FeedbackSurvey, SURVEY_MIN_INTERVAL_MS, SurveyDecisionInput,
    coerce_survey_rate, feedback_survey_event, should_offer_survey,
};
use claudius_core::paths;
use claudius_core::session::{RuntimeOptions, Session, SessionOptions};
use claudius_core::session_manager::SessionManager;
use serde_json::Value;

fn fixture() -> &'static Value {
    static F: OnceLock<Value> = OnceLock::new();
    F.get_or_init(|| {
        serde_json::from_str(include_str!("fixtures/feedback_survey_golden.json")).unwrap()
    })
}

struct World {
    _root: tempfile::TempDir,
    home: PathBuf,
    project: String,
    fake: PathBuf,
}

/// One isolated `$HOME` + config dir per test binary, and the fake CLI built.
fn world() -> &'static World {
    static W: OnceLock<World> = OnceLock::new();
    W.get_or_init(|| {
        let root = tempfile::tempdir().unwrap();
        let home = root.path().join("home");
        let project = root.path().join("project");
        std::fs::create_dir_all(&home).unwrap();
        std::fs::create_dir_all(&project).unwrap();
        assert!(paths::set_home_override(home.clone()));
        assert!(paths::set_config_dir_override(root.path().join("config")));
        let cargo = std::env::var("CARGO").unwrap_or_else(|_| "cargo".into());
        let st = std::process::Command::new(cargo)
            .args([
                "build",
                "-q",
                "-p",
                "claudius-agent",
                "--bin",
                "claudius-fake-claude",
            ])
            .current_dir(env!("CARGO_MANIFEST_DIR"))
            .status()
            .unwrap();
        assert!(st.success());
        World {
            project: project.canonicalize().unwrap().display().to_string(),
            fake: PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                .join("../../target/debug/claudius-fake-claude"),
            home,
            _root: root,
        }
    })
}

#[test]
fn constants_match() {
    let c = &fixture()["constants"];
    assert_eq!(
        c["defaultRate"].as_f64(),
        Some(DEFAULT_FEEDBACK_SURVEY_RATE)
    );
    assert_eq!(c["minIntervalMs"].as_i64(), Some(SURVEY_MIN_INTERVAL_MS));
}

#[test]
fn rates_match() {
    let rates = fixture()["rates"].as_array().unwrap();
    assert!(rates.len() >= 30);
    for c in rates {
        let raw = (!c["missing"].as_bool().unwrap()).then_some(&c["raw"]);
        let got = coerce_survey_rate(raw);
        assert_eq!(Some(got), c["rate"].as_f64(), "{}", c["raw"]);
    }
}

fn decision_input(o: &Value) -> SurveyDecisionInput {
    SurveyDecisionInput {
        rate: o["rate"].as_f64().unwrap(),
        is_error: o["isError"].as_bool().unwrap(),
        saw_user_input: o["sawUserInput"].as_bool().unwrap(),
        now: o["now"].as_i64().unwrap(),
        last_shown_at: o["lastShownAt"].as_i64().unwrap(),
        min_interval_ms: o.get("minIntervalMs").map(|v| v.as_i64().unwrap()),
        random: o.get("random").map(|v| v.as_f64().unwrap()),
    }
}

#[test]
fn decisions_match() {
    let decisions = fixture()["decisions"].as_array().unwrap();
    assert!(decisions.len() >= 500);
    let mut offered = 0;
    for c in decisions {
        let draws = AtomicUsize::new(0);
        let math_random = c["mathRandom"].as_f64().unwrap();
        let offer = should_offer_survey(&decision_input(&c["opts"]), || {
            draws.fetch_add(1, Ordering::SeqCst);
            math_random
        });
        assert_eq!(Value::Bool(offer), c["offer"], "{c}");
        assert_eq!(
            draws.load(Ordering::SeqCst) as u64,
            c["draws"].as_u64().unwrap(),
            "{c}: draws"
        );
        offered += usize::from(offer);
    }
    assert!(offered >= 50 && offered < decisions.len() / 2, "{offered}");
}

// ─────────────────────────────── offers ───────────────────────────────

/// Where Rust knowingly differs from the recording.
const KNOWN: &[(&str, &str)] = &[(
    "nesting past 128 elsewhere",
    "serde_json refuses nesting past 128 levels, which JSON.parse reads: the file counts as {}, so the default rate applies",
)];

/// A [`FeedbackSurvey`] on a pinned clock and roll, counting the reads of
/// both.
struct Pinned {
    survey: Arc<FeedbackSurvey>,
    now: Arc<AtomicI64>,
    roll: Arc<AtomicU64>,
    now_calls: Arc<AtomicUsize>,
    draws: Arc<AtomicUsize>,
}

impl Pinned {
    fn new() -> Pinned {
        let now = Arc::new(AtomicI64::new(0));
        let roll = Arc::new(AtomicU64::new(0));
        let now_calls = Arc::new(AtomicUsize::new(0));
        let draws = Arc::new(AtomicUsize::new(0));
        let (n, r, c, d) = (now.clone(), roll.clone(), now_calls.clone(), draws.clone());
        let survey = Arc::new(FeedbackSurvey::new(
            move || {
                c.fetch_add(1, Ordering::SeqCst);
                n.load(Ordering::SeqCst)
            },
            move || {
                d.fetch_add(1, Ordering::SeqCst);
                f64::from_bits(r.load(Ordering::SeqCst))
            },
        ));
        Pinned {
            survey,
            now,
            roll,
            now_calls,
            draws,
        }
    }
}

/// What one step did.
struct Outcome {
    events: Vec<String>,
    offered: usize,
    draws: usize,
    now_calls: usize,
    last_shown_at: i64,
}

/// Held by the tests that read the user settings.json this binary's
/// `$HOME` shares.
static SETTINGS: std::sync::Mutex<()> = std::sync::Mutex::new(());

/// The step's user settings.json, as the recorder wrote it.
fn write_settings(home: &std::path::Path, settings: &Value) {
    let path = home.join(".claude/settings.json");
    let _ = std::fs::remove_file(&path);
    let _ = std::fs::remove_dir_all(&path);
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    if settings.is_null() {
        return;
    }
    if settings["dir"] == true {
        std::fs::create_dir(&path).unwrap();
    } else if let Some(bytes) = settings["bytes"].as_array() {
        let bytes: Vec<u8> = bytes.iter().map(|b| b.as_u64().unwrap() as u8).collect();
        std::fs::write(&path, bytes).unwrap();
    } else {
        std::fs::write(&path, settings["text"].as_str().unwrap()).unwrap();
    }
}

/// One step: `(events, offered, draws, lastShownAt)`.
fn run_step(p: &Pinned, w: &World, step: &Value) -> Outcome {
    write_settings(&w.home, &step["settings"]);
    if let Some(before) = step.get("before") {
        p.survey.note_shown(before.as_i64().unwrap());
    }
    p.now.store(step["now"].as_i64().unwrap(), Ordering::SeqCst);
    p.roll.store(
        step["mathRandom"].as_f64().unwrap().to_bits(),
        Ordering::SeqCst,
    );
    p.draws.store(0, Ordering::SeqCst);
    p.now_calls.store(0, Ordering::SeqCst);
    let message = &step["message"];
    let mut events = vec![];
    let offered = if step["concurrent"] == true {
        let offers: Vec<bool> = std::thread::scope(|s| {
            let calls: Vec<_> = (0..2)
                .map(|_| s.spawn(|| p.survey.maybe_offer(message, true, &w.project)))
                .collect();
            calls.into_iter().map(|c| c.join().unwrap()).collect()
        });
        offers.iter().filter(|o| **o).count()
    } else {
        let saw = step["sawUserInput"].as_bool().unwrap();
        if p.survey.maybe_offer(message, saw, &w.project) {
            let id = step["id"].as_str().unwrap();
            events.push(js::stringify(&feedback_survey_event(id)));
        }
        events.len()
    };
    Outcome {
        events,
        offered,
        draws: p.draws.load(Ordering::SeqCst),
        now_calls: p.now_calls.load(Ordering::SeqCst),
        last_shown_at: p.survey.last_shown_at(),
    }
}

#[test]
fn offers_match() {
    let w = world();
    let _settings = SETTINGS.lock().unwrap_or_else(|e| e.into_inner());
    let scenarios = fixture()["offers"].as_array().unwrap();
    assert!(scenarios.len() >= 15);
    let (mut checked, mut known_seen) = (0, 0);
    for sc in scenarios {
        let name = sc["name"].as_str().unwrap();
        let p = Pinned::new();
        p.survey.reset();
        for (i, step) in sc["steps"].as_array().unwrap().iter().enumerate() {
            let label = format!("{name} step {i} ({})", step["name"]);
            let got = run_step(&p, w, step);
            let want_offered = match step.get("offered") {
                Some(n) => n.as_u64().unwrap() as usize,
                None => step["events"].as_array().unwrap().len(),
            };
            if let Some((_, why)) = KNOWN
                .iter()
                .find(|(n, _)| Some(*n) == step["name"].as_str())
            {
                // The default rate, whatever the file says.
                let roll = step["mathRandom"].as_f64().unwrap();
                assert_eq!(
                    got.offered,
                    usize::from(roll < DEFAULT_FEEDBACK_SURVEY_RATE),
                    "{label}: {why}"
                );
                known_seen += usize::from(got.offered != want_offered);
                continue;
            }
            if step.get("events").is_some() {
                let want: Vec<String> = step["events"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|e| e.as_str().unwrap().to_owned())
                    .collect();
                assert_eq!(got.events, want, "{label}: events");
            }
            assert_eq!(got.offered, want_offered, "{label}: offered");
            let count = |k: &str| step[k].as_u64().unwrap() as usize;
            assert_eq!(got.draws, count("draws"), "{label}: draws");
            assert_eq!(got.now_calls, count("nowCalls"), "{label}: Date.now calls");
            assert_eq!(
                got.last_shown_at,
                step["lastShownAt"].as_i64().unwrap(),
                "{label}: lastShownAt"
            );
            checked += 1;
        }
    }
    write_settings(&w.home, &Value::Null);
    assert!(
        known_seen > 0,
        "a KNOWN difference matches now: drop it from KNOWN"
    );
    assert!(checked >= 215, "only {checked} steps matched");
}

/// Another session showing the nudge between this one's first throttle
/// check and its roll (TS: while the settings read is awaited) wins: the
/// check under the stamp holds this one back. Both calls read the clock,
/// then meet at the barrier, so both pass the first check.
#[test]
fn a_show_between_the_checks_holds_the_second_back() {
    let w = world();
    let _settings = SETTINGS.lock().unwrap_or_else(|e| e.into_inner());
    write_settings(&w.home, &Value::Null);
    let barrier = Arc::new(std::sync::Barrier::new(2));
    let draws = Arc::new(AtomicUsize::new(0));
    let (b, d) = (barrier.clone(), draws.clone());
    let survey = FeedbackSurvey::new(
        move || {
            b.wait();
            1_800_000_000_000
        },
        move || {
            d.fetch_add(1, Ordering::SeqCst);
            0.0
        },
    );
    let message = serde_json::json!({"type": "result", "subtype": "success", "is_error": false});
    let offers: Vec<bool> = std::thread::scope(|s| {
        let calls: Vec<_> = (0..2)
            .map(|_| s.spawn(|| survey.maybe_offer(&message, true, &w.project)))
            .collect();
        calls.into_iter().map(|c| c.join().unwrap()).collect()
    });
    assert_eq!(offers.iter().filter(|o| **o).count(), 1, "{offers:?}");
    assert_eq!(draws.load(Ordering::SeqCst), 1);
    assert_eq!(survey.last_shown_at(), 1_800_000_000_000);
}

// ─────────────────────────────── submits ───────────────────────────────

fn stdin_lines(log: &std::path::Path) -> Vec<String> {
    std::fs::read_to_string(log)
        .unwrap_or_default()
        .lines()
        .map(str::to_owned)
        .collect()
}

/// The `submit_feedback` control requests written since line `from`, ids
/// as `$ID`.
fn wire_since(log: &std::path::Path, from: usize) -> Vec<String> {
    stdin_lines(log)
        .into_iter()
        .skip(from)
        .filter_map(|l| {
            let m: Value = serde_json::from_str(&l).ok()?;
            (m["type"] == "control_request" && m["request"]["subtype"] == "submit_feedback").then(
                || {
                    let id = serde_json::to_string(&m["request_id"]).unwrap();
                    l.replacen(&id, "\"$ID\"", 1)
                },
            )
        })
        .collect()
}

async fn replay_submit(case: &Value) {
    let w = world();
    let name = case["name"].as_str().unwrap();
    let cwd = tempfile::tempdir().unwrap();
    let log = cwd.path().join("stdin.log");
    let mut env: HashMap<String, String> = HashMap::new();
    env.insert("PATH".into(), std::env::var("PATH").unwrap_or_default());
    env.insert("FAKE_CLAUDE_LOG".into(), log.display().to_string());
    if !case["script"].is_null() {
        env.insert("FAKE_CLAUDE_SCRIPT".into(), case["script"].to_string());
    }
    let opts = SessionOptions {
        cwd: Some(cwd.path().canonicalize().unwrap().display().to_string()),
        runtime: RuntimeOptions {
            claude_bin: Some(w.fake.clone()),
            env_override: Some(env),
        },
        ..Default::default()
    };
    let mgr = Arc::new(SessionManager::default());
    let mode = case["query"].as_str().unwrap();
    let s = match mode {
        "none" => Session::new(opts).unwrap(),
        _ => mgr.create(opts).await.expect("create"),
    };
    if mode != "none" {
        let mut sub = s.subscribe(None, None);
        loop {
            let ev = tokio::time::timeout(Duration::from_secs(10), sub.recv())
                .await
                .expect("event timeout")
                .expect("stream closed");
            if ev["type"] == "tips" {
                break;
            }
        }
    }
    if mode == "ended" {
        s.end().await;
    }
    for (i, c) in case["calls"].as_array().unwrap().iter().enumerate() {
        let from = stdin_lines(&log).len();
        let forwarded = s
            .submit_feedback(
                c["description"].as_str().unwrap(),
                c["surface"].as_str(),
                c["attachTranscript"].as_bool().unwrap_or(false),
            )
            .await;
        assert_eq!(Value::Bool(forwarded), c["forwarded"], "{name} call {i}");
        let want: Vec<String> = c["wire"]
            .as_array()
            .unwrap()
            .iter()
            .map(|l| l.as_str().unwrap().to_owned())
            .collect();
        assert_eq!(wire_since(&log, from), want, "{name} call {i}: wire");
    }
    s.end().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
// The guard only orders this test against the sync ones; nothing awaited
// here takes it.
#[allow(clippy::await_holding_lock)]
async fn submits_match() {
    // `start()` reads the user settings.json, and throws on a `null` one
    // (which `offers_match` writes): none, as recorded.
    let w = world();
    let _settings = SETTINGS.lock().unwrap_or_else(|e| e.into_inner());
    write_settings(&w.home, &Value::Null);
    let cases = fixture()["submits"].as_array().unwrap();
    assert!(cases.len() >= 12);
    for chunk in cases.chunks(7) {
        futures::future::join_all(chunk.iter().map(replay_submit)).await;
    }
}
