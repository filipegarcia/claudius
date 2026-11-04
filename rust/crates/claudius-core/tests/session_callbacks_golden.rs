//! The session's control-request callbacks (S27b), replayed against the TS
//! recording in `tests/fixtures/session_callbacks_golden.json`
//! (`rust/scripts/session-callbacks-golden.mjs`): `canUseTool` (the goal
//! tool, the per-cwd and env tool budgets, ExitPlanMode, AskUserQuestion,
//! permission prompts), `onElicitation` and the PreToolUse / PostToolUse /
//! CwdChanged / PostModelSwitch hooks, each driven through the fake CLI's
//! `$control` / `$send` steps on a real session, the prompts answered
//! through `resolve_permission` / `submit_ask_answer` / `resolve_plan` /
//! `resolve_elicitation` as the recorder answered them.
//!
//! Each case compares what TS recorded:
//! - `events`: the buffered non-`sdk` events after the turn;
//! - `live`: what a subscriber that joined after `start()` got;
//! - `late`: the prompt events a subscriber joining while each prompt was
//!   pending got;
//! - `answered`: what each resolve call returned;
//! - `controls`: the `control_response` lines the CLI read, byte for byte;
//! - `state`: permission mode, status, pending prompts and the session row's
//!   `state` text.
//!
//! While each prompt is pending, `pending_prompts()` (the `/pending-prompts`
//! route) must also return the broadcast events of the prompts still
//! pending, as the TS route does.
//!
//! Request ids read `$R<n>` and the temp root `$ROOT` / `$EROOT` on both
//! sides. Where Rust is known to differ the case is in [`KNOWN`] with its
//! reason; a stale entry fails.
#![cfg(unix)]

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, OnceLock};
use std::time::Duration;

use claudius_agent::js;
use claudius_core::db::{self, Mode};
use claudius_core::paths;
use claudius_core::session::{
    PermissionDecision, PlanDecision, RuntimeOptions, SendOptions, Session, SessionOptions,
};
use claudius_core::session_manager::SessionManager;
use serde_json::{Map, Value, json};

fn fixture() -> &'static Value {
    static F: OnceLock<Value> = OnceLock::new();
    F.get_or_init(|| {
        let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("tests/fixtures/session_callbacks_golden.json");
        serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap()
    })
}

/// `(case, field, reason)`: where Rust knowingly differs from the recording
/// (`*`: every field that differs).
const KNOWN: &[(&str, &str, &str)] = &[
    // S27b1: a callback that throws. The SDK turns the TypeError into an
    // error control reply, so the turn goes on without a prompt; Rust's
    // `CanUseTool` / `HookCallback` have no error path and park a prompt
    // (or answer `{continue: true}`). The messages are V8's and name the
    // TS source (`toolName.startsWith`), which a minified build changes.
    ("plan input null", "*", THROWS),
    ("plan input missing", "*", THROWS),
    ("tool name a number", "*", THROWS),
    ("tool name missing", "*", THROWS),
    ("suggestions an object", "*", THROWS),
    ("suggestions a string", "*", THROWS),
    ("suggestions holding null", "*", THROWS),
    ("suggested rules holding null", "*", THROWS),
    ("budget counted before a throw", "*", THROWS),
    ("hook input missing or null", "controls", THROWS),
    // S27b2: values Rust's types don't hold. A non-string `to_model` (`5`)
    // becomes the session's model in TS (`model_changed` with `model: 5`,
    // then `effort_applied: null`); Rust's model is a `String`, so the hook
    // ignores it. A limits number past f64 (`1e400`) is `Infinity` in TS (a
    // cap never reached) and `null` from `js::json_parse` (so the env cap
    // applies); only a hand-edited file holds one, as the Limits route
    // writes `JSON.stringify` text.
    (
        "post model switch to a non-string model",
        "*",
        "the session model is a string in Rust",
    ),
    (
        "limits 1e400 is an endless cap",
        "*",
        "js::json_parse reads 1e400 as null",
    ),
];
const THROWS: &str = "TS answers a throwing callback with an error reply";

const CAP_ENV: [&str; 2] = [
    "CLAUDE_CODE_MAX_WEB_SEARCHES_PER_SESSION",
    "CLAUDE_CODE_MAX_SUBAGENTS_PER_SESSION",
];
const PROMPT_TYPES: [&str; 4] = [
    "permission_request",
    "ask_user_question",
    "plan_approval_request",
    "mcp_elicitation_request",
];

struct Env {
    _tmp: tempfile::TempDir,
    root: String,
    fake: PathBuf,
    /// The fake CLI behind a gate (see [`run`]).
    gated: PathBuf,
}

/// One isolated `$HOME` + config dir per test binary, with the recorder's
/// user settings.json (no feedback nudge) and the fake CLI built.
fn env() -> &'static Env {
    static E: OnceLock<Env> = OnceLock::new();
    E.get_or_init(|| {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().canonicalize().unwrap();
        let home = root.join("home");
        let config = root.join("config");
        std::fs::create_dir_all(home.join(".claude/.claudius/limits")).unwrap();
        std::fs::create_dir_all(&config).unwrap();
        assert!(paths::set_home_override(home.clone()));
        assert!(paths::set_config_dir_override(config));
        std::fs::write(
            home.join(".claude/settings.json"),
            "{\n  \"feedbackSurveyRate\": 0\n}\n",
        )
        .unwrap();
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
        let gated = root.join("gated-claude");
        std::fs::write(
            &gated,
            "#!/bin/sh\nwhile [ ! -e \"$CALLBACKS_GATE\" ]; do sleep 0.005; done\nexec \"$CALLBACKS_FAKE\" \"$@\"\n",
        )
        .unwrap();
        std::fs::set_permissions(&gated, std::os::unix::fs::PermissionsExt::from_mode(0o755))
            .unwrap();
        Env {
            _tmp: tmp,
            root: root.display().to_string(),
            fake: PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                .join("../../target/debug/claudius-fake-claude"),
            gated,
        }
    })
}

/// The recorder's `normalize`: `$ROOT` / `$EROOT` for the temp root, `$R<n>`
/// for the request ids in `ids`.
fn normalize(v: &Value, ids: &[String]) -> Value {
    let e = env();
    let mut text = v
        .to_string()
        .replace(&e.root, "$ROOT")
        .replace(&paths::encode_project_dir(&e.root), "$EROOT");
    for (i, id) in ids.iter().enumerate() {
        text = text.replace(id.as_str(), &format!("$R{i}"));
    }
    serde_json::from_str(&text).unwrap()
}

/// `$R<n>` order: each request id's first appearance.
fn id_map(events: &[Value]) -> Vec<String> {
    let mut ids: Vec<String> = Vec::new();
    for e in events {
        if let Some(id) = e["requestId"].as_str()
            && !ids.iter().any(|i| i == id)
        {
            ids.push(id.to_owned());
        }
    }
    ids
}

/// `plan_usage` stamps the time it was read.
fn unstamp(events: Vec<Value>) -> Vec<Value> {
    events
        .into_iter()
        .map(|mut e| {
            if e["type"] == "plan_usage" && e["fetchedAt"].is_number() {
                e["fetchedAt"] = json!(0);
            }
            e
        })
        .collect()
}

fn is_prompt(e: &Value) -> bool {
    PROMPT_TYPES.iter().any(|t| e["type"] == *t)
}

fn read_text(p: &Path) -> Option<String> {
    std::fs::read_to_string(p).ok()
}

async fn wait_for(mut pred: impl FnMut() -> bool, ms: u64) -> bool {
    for _ in 0..ms / 10 {
        if pred() {
            return true;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    pred()
}

/// The recorder's `answer`: the resolve call the case's entry names, or
/// `null` when it names none.
fn answer(s: &Session, ev: &Value, a: &Value) -> Value {
    let id = ev["requestId"].as_str().unwrap();
    if let Some(d) = a.get("perm") {
        let d: PermissionDecision = serde_json::from_value(d.clone()).unwrap();
        json!(s.resolve_permission(id, d))
    } else if let Some(answers) = a.get("ask") {
        json!(s.submit_ask_answer(id, answers.as_array().unwrap()))
    } else if let Some(d) = a.get("plan") {
        let d: PlanDecision = serde_json::from_value(d.clone()).unwrap();
        json!(s.resolve_plan(id, d))
    } else if let Some(d) = a.get("elicit") {
        json!(s.resolve_elicitation(id, d["action"].as_str().unwrap(), d.get("content").cloned()))
    } else {
        Value::Null
    }
}

/// The `control_response` lines the CLI has read for its own (`cli_…`)
/// requests.
fn cli_replies(log: &Path) -> Vec<String> {
    read_text(log)
        .unwrap_or_default()
        .lines()
        .filter(|l| {
            l.contains("\"type\":\"control_response\"") && l.contains("\"request_id\":\"cli_")
        })
        .map(str::to_owned)
        .collect()
}

/// [`answer`], then, when it settled a prompt, a wait for the CLI to read
/// that prompt's reply. TS writes the reply from a microtask, before the
/// recorder's next answer runs; Rust writes it from the control request's
/// task, so prompts answered back to back race to the CLI's stdin
/// (S27b3: the replies land in either order).
async fn answer_in_order(s: &Session, ev: &Value, a: &Value, log: &Path) -> Value {
    let before = cli_replies(log).len();
    let got = answer(s, ev, a);
    if got == true {
        wait_for(|| cli_replies(log).len() > before, 10_000).await;
    }
    got
}

/// One case, recorded the way the recorder records it.
async fn run(i: usize, case: &Value) -> Map<String, Value> {
    let e = env();
    let name = case["name"].as_str().unwrap();
    let id = case["id"].as_str().unwrap();
    let cwd = Path::new(&e.root).join("cases").join(i.to_string());
    std::fs::create_dir_all(&cwd).unwrap();
    let cwd_s = cwd.display().to_string();
    let dir = Path::new(&e.root).join("io").join(i.to_string());
    std::fs::create_dir_all(&dir).unwrap();
    let log = dir.join("stdin.log");
    let limits_path = case["limitsPath"].as_str().map(|p| {
        PathBuf::from(
            p.replace("$EROOT", &paths::encode_project_dir(&e.root))
                .replace("$ROOT", &e.root),
        )
    });
    if let Some(p) = &limits_path {
        // The file's text, or its bytes.
        let bytes = match &case["limits"] {
            Value::Array(b) => b.iter().map(|n| n.as_u64().unwrap() as u8).collect(),
            t => t.as_str().unwrap().as_bytes().to_vec(),
        };
        std::fs::write(p, bytes).unwrap();
    }
    for k in CAP_ENV {
        // SAFETY: this test binary runs one test, one case at a time, and
        // only std reads the process env meanwhile.
        unsafe { std::env::remove_var(k) };
    }
    for (k, v) in case["env"].as_object().unwrap() {
        // SAFETY: as above.
        unsafe { std::env::set_var(k, v.as_str().unwrap()) };
    }

    let mut options = case["options"].as_object().unwrap().clone();
    options.insert("id".into(), json!(id));
    options.insert("cwd".into(), json!(cwd_s));
    let mut opts: SessionOptions = serde_json::from_value(Value::Object(options))
        .unwrap_or_else(|err| panic!("{name}: options: {err}"));
    // The CLI waits for `gate` before it starts, so its `system/init` can't
    // reach the session before the subscriber below joins: in every TS
    // recording the subscribe (in the tick `start()` resolves in) came first,
    // but Rust's reader runs on another thread and sometimes won.
    let gate = dir.join("go");
    opts.runtime = RuntimeOptions {
        claude_bin: Some(e.gated.clone()),
        env_override: Some(HashMap::from([
            ("PATH".to_owned(), std::env::var("PATH").unwrap_or_default()),
            ("CALLBACKS_GATE".to_owned(), gate.display().to_string()),
            ("CALLBACKS_FAKE".to_owned(), e.fake.display().to_string()),
            (
                "FAKE_CLAUDE_SCRIPT".to_owned(),
                case["script"].as_str().unwrap().to_owned(),
            ),
            ("FAKE_CLAUDE_LOG".to_owned(), log.display().to_string()),
        ])),
    };
    let mgr = Arc::new(SessionManager::default());
    let s = mgr
        .create(opts)
        .await
        .unwrap_or_else(|err| panic!("{name}: create: {err}"));
    let mut sub = s.subscribe(None, None);
    std::fs::write(&gate, "").unwrap();
    let mut live: Vec<Value> = Vec::new();
    let drain = |sub: &mut claudius_core::session::Subscription, live: &mut Vec<Value>| {
        while let Ok(ev) = sub.rx.try_recv() {
            if ev["type"] != "sdk" {
                live.push(ev);
            }
        }
    };
    assert!(
        wait_for(
            || read_text(&log).is_some_and(|l| l.contains("\"subtype\":\"initialize\"")),
            10_000
        )
        .await,
        "{name}: no initialize"
    );
    assert!(
        wait_for(
            || {
                drain(&mut sub, &mut live);
                live.iter().any(|e| e["type"] == "effort_applied")
            },
            10_000
        )
        .await,
        "{name}: no effort_applied"
    );
    s.send_input("go", &[], SendOptions::default());

    let prompts = || -> Vec<Value> { s.buffer_snapshot().into_iter().filter(is_prompt).collect() };
    let result_in = || {
        s.buffer_snapshot()
            .iter()
            .any(|e| e["type"] == "sdk" && e["message"]["type"] == "result")
    };
    let answers = case["answers"].as_array().unwrap();
    let mut late = Vec::new();
    let mut answered = Vec::new();
    for k in 0.. {
        // A turn that waits on a prompt the recording didn't have (or never
        // ends) is a difference, not a hang: `end()` drains it below.
        if !wait_for(|| prompts().len() > k || result_in(), 10_000).await {
            answered.push(json!(format!("stuck after {k} prompts")));
            break;
        }
        let Some(ev) = prompts().into_iter().nth(k) else {
            break;
        };
        // A prompt the recorder never saw: a difference already, so don't
        // sit out the wait above for a turn that can't end.
        if k >= case["late"].as_array().unwrap().len() {
            answered.push(json!(format!("prompt {k} is not in the recording")));
            break;
        }
        let mut join = s.subscribe(None, None);
        let mut seen = Vec::new();
        while let Ok(e) = join.rx.try_recv() {
            if is_prompt(&e) {
                seen.push(e);
            }
        }
        drop(join);
        late.push(Value::Array(seen));
        // `/pending-prompts` reads the pending maps: each ask is `{type,
        // requestId, toolUseId, questions}` off its entry, and each
        // permission / elicitation is its `meta`, so TS answers with the
        // broadcast events of the prompts still pending.
        let (asks, perms, elic) = s.pending_prompts();
        let buffered = prompts();
        for p in asks.iter().chain(&perms).chain(&elic) {
            let ev = buffered
                .iter()
                .find(|e| e["type"] == p["type"] && e["requestId"] == p["requestId"]);
            assert_eq!(
                ev.map(js::stringify),
                Some(js::stringify(p)),
                "{name}: /pending-prompts"
            );
        }
        let a = answers.get(k).cloned().unwrap_or(Value::Null);
        if let Some(gate) = a["gate"].as_str() {
            std::fs::write(cwd.join(gate), "").unwrap();
        }
        for (k2, v) in a["env"].as_object().into_iter().flatten() {
            // SAFETY: the cases run one at a time and nothing else in this
            // binary reads the cap env.
            unsafe { std::env::set_var(k2, v.as_str().unwrap()) };
        }
        let got = answer_in_order(&s, &ev, &a, &log).await;
        answered.push(if a["again"] == true {
            json!([got, answer_in_order(&s, &ev, &a, &log).await])
        } else {
            got
        });
        if k + 1 == answers.len() {
            for b in case["after"].as_array().unwrap() {
                let p = prompts()[b["index"].as_u64().unwrap() as usize].clone();
                answered.push(answer_in_order(&s, &p, b, &log).await);
            }
        }
    }
    // As long as the recorder waits for its fire-and-forget writes, and
    // until the background round trips TS saw have come back.
    tokio::time::sleep(Duration::from_millis(150)).await;
    let want_async = case["live"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|e| is_async(e))
        .count();
    wait_for(
        || {
            drain(&mut sub, &mut live);
            live.iter().filter(|e| is_async(e)).count() >= want_async
        },
        10_000,
    )
    .await;
    drop(sub);

    let events: Vec<Value> = unstamp(
        s.buffer_snapshot()
            .into_iter()
            .filter(|e| e["type"] != "sdk")
            .collect(),
    );
    let ids = id_map(&live);
    let controls: Vec<Value> = cli_replies(&log).into_iter().map(Value::from).collect();
    let row: Option<String> = db::open_db(&cwd_s, Mode::ReadOnly)
        .unwrap()
        .with(|c| {
            c.query_row("SELECT state FROM sessions WHERE id = ?", [id], |r| {
                r.get(0)
            })
        })
        .ok()
        .flatten();
    let mut got = Map::new();
    got.insert("events".into(), normalize(&Value::Array(events), &ids));
    got.insert("live".into(), normalize(&Value::Array(unstamp(live)), &ids));
    got.insert("late".into(), normalize(&Value::Array(late), &ids));
    got.insert("answered".into(), Value::Array(answered));
    got.insert("controls".into(), Value::Array(controls));
    got.insert(
        "state".into(),
        json!({
            "permissionMode": s.permission_mode(),
            "status": s.status().as_str(),
            "pendingPrompts": s.has_pending_user_prompts(),
            "row": row,
        }),
    );
    s.end().await;
    if let Some(p) = &limits_path {
        let _ = std::fs::remove_file(p);
    }
    got
}

const FIELDS: [&str; 6] = ["events", "live", "late", "answered", "controls", "state"];

/// What a control round trip the session started without waiting sends
/// when its reply comes back: `refreshAppliedEffort`'s `get_settings` (after
/// a `model_changed`) and a successful turn's `get_usage`. The fake CLI
/// answers them after the turn's `result`; Rust's reader settles a reply on
/// its own task while the messages before it go through the consume loop,
/// so these can land before the result's `turn_status` / `usage_snapshot`
/// (S27b3). As in `session_consume_golden.rs`, they're compared apart, as a
/// sorted list, and the rest in order.
const ASYNC_TYPES: [&str; 3] = ["effort_applied", "plan_usage", "plan_usage_unavailable"];

fn is_async(e: &Value) -> bool {
    ASYNC_TYPES.iter().any(|t| e["type"] == *t)
}

/// `{ordered, async}`: the events without the [`ASYNC_TYPES`], in order,
/// and those, sorted by their JSON text.
fn split_async(v: &Value) -> Value {
    let all = v.as_array().unwrap();
    let ordered: Vec<&Value> = all.iter().filter(|e| !is_async(e)).collect();
    let mut asyncs: Vec<String> = all
        .iter()
        .filter(|e| is_async(e))
        .map(js::stringify)
        .collect();
    asyncs.sort();
    json!({"ordered": ordered, "async": asyncs})
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn callbacks_match_ts() {
    env();
    let cases = fixture()["cases"].as_array().unwrap();
    assert!(cases.len() >= 120, "{} cases", cases.len());
    let mut diffs: Vec<(String, String, String)> = Vec::new();
    for (i, case) in cases.iter().enumerate() {
        let name = case["name"].as_str().unwrap();
        let got = run(i, case).await;
        for field in FIELDS {
            // `JSON.stringify` text on both sides; `controls` are the raw
            // lines, compared as strings.
            let (want, have) = if matches!(field, "events" | "live") {
                (
                    js::stringify(&split_async(&case[field])),
                    js::stringify(&split_async(&got[field])),
                )
            } else {
                (js::stringify(&case[field]), js::stringify(&got[field]))
            };
            if want != have {
                diffs.push((
                    name.to_owned(),
                    field.to_owned(),
                    format!("\n  TS:   {want}\n  Rust: {have}"),
                ));
            }
        }
    }
    for k in CAP_ENV {
        // SAFETY: every case is done.
        unsafe { std::env::remove_var(k) };
    }
    // The static `TempDir` is never dropped, and 134 databases add up.
    let _ = std::fs::remove_dir_all(&env().root);
    let mut unexpected = Vec::new();
    for (name, field, detail) in &diffs {
        if !KNOWN
            .iter()
            .any(|(n, f, _)| n == name && (f == field || *f == "*"))
        {
            unexpected.push(format!("{name} / {field}:{detail}"));
        }
    }
    let stale: Vec<_> = KNOWN
        .iter()
        .filter(|(n, f, _)| {
            !diffs
                .iter()
                .any(|(dn, df, _)| dn == n && (df == f || *f == "*"))
        })
        .collect();
    assert!(
        unexpected.is_empty() && stale.is_empty(),
        "{} unexpected differences:\n{}\nstale KNOWN entries: {stale:?}",
        unexpected.len(),
        unexpected.join("\n")
    );
}
