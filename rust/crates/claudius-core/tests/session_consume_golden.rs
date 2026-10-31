//! S28: `consume()` replayed against the real TS. The `consume` half of
//! `tests/fixtures/session_stream_golden.json`
//! (`rust/scripts/session-stream-golden.mjs`): a real session on the fake
//! CLI (`FAKE_CLAUDE_SCRIPT`), one `send_input` per prompt. Per prompt, what
//! a subscriber registered after start saw until the turn settled: `ordered`
//! (in order) and `async` (the events a background round trip sends,
//! sorted by their JSON text). Per case, the sessions row and the user
//! settings.json text.
//!
//! Where the TS has an unhandled rejection (`rejections`), it broadcasts
//! nothing; so does Rust, so the field isn't compared.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::{Duration, Instant};

use claudius_agent::js;
use claudius_core::db::{Mode, open_db};
use claudius_core::paths;
use claudius_core::session::{RuntimeOptions, SendOptions, Session, SessionOptions, Subscription};
use serde_json::{Value, json};

const ASYNC_TYPES: [&str; 7] = [
    "effort_applied",
    "plan_usage",
    "plan_usage_unavailable",
    "mcp_needs_auth_notice",
    "mcp_disconnected_notice",
    "advisor_disabled_on_model_change",
    "feedback_survey",
];

fn fixture() -> Value {
    serde_json::from_str(include_str!("fixtures/session_stream_golden.json")).unwrap()
}

fn fake_cli() -> PathBuf {
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
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../target/debug/claudius-fake-claude")
}

fn is_uuid(s: &str) -> bool {
    let b = s.as_bytes();
    b.len() == 36
        && b.iter().enumerate().all(|(i, c)| match i {
            8 | 13 | 18 | 23 => *c == b'-',
            _ => c.is_ascii_digit() || (b'a'..=b'f').contains(c),
        })
}

fn is_msg_id(s: &str) -> bool {
    s.strip_prefix("msg_").is_some_and(|h| {
        h.len() == 32
            && h.bytes()
                .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
    })
}

/// The recorder's `normConsume`.
fn norm(v: Value, cwd: &str, key: Option<&str>) -> Value {
    match v {
        Value::Number(_) if key == Some("at") => json!("$AT"),
        Value::Number(_) if key == Some("fetchedAt") => json!("$NOW"),
        Value::String(s) if is_uuid(&s) => json!("$UUID"),
        Value::String(s) if key == Some("id") && is_msg_id(&s) => json!("$MSG"),
        Value::String(s) => json!(s.split(cwd).collect::<Vec<_>>().join("$CWD")),
        Value::Array(a) => Value::Array(a.into_iter().map(|x| norm(x, cwd, None)).collect()),
        Value::Object(o) => Value::Object(
            o.into_iter()
                .map(|(k, x)| {
                    let x = norm(x, cwd, Some(&k));
                    (k, x)
                })
                .collect(),
        ),
        v => v,
    }
}

fn is_async(ev: &Value) -> bool {
    ev["type"]
        .as_str()
        .is_some_and(|t| ASYNC_TYPES.contains(&t))
}

/// The recorder's `settled`: a result (or an `error`) and an idle
/// `turn_status` after it; without either, the stream's end and an idle.
fn settled(evs: &[Value], s: &Session) -> bool {
    let idle = |e: &Value| e["type"] == "turn_status" && e["status"] == "idle";
    let end = evs.iter().position(|e| {
        (e["type"] == "sdk" && e["message"]["type"] == "result") || e["type"] == "error"
    });
    match end {
        Some(i) => evs[i..].iter().any(idle),
        None => s.is_done() && evs.iter().any(idle),
    }
}

/// Everything the subscription has now, waiting up to `quiet` for more.
async fn drain(sub: &mut Subscription, quiet: Duration, into: &mut Vec<Value>) {
    while let Ok(Some(ev)) = tokio::time::timeout(quiet, sub.recv()).await {
        into.push(ev);
    }
}

async fn wait_until(what: &str, mut f: impl FnMut() -> bool) {
    let start = Instant::now();
    while !f() {
        assert!(
            start.elapsed() < Duration::from_secs(20),
            "timed out: {what}"
        );
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
}

fn row(cwd: &str, id: &str) -> Value {
    let db = open_db(cwd, Mode::ReadWrite).unwrap();
    db.with(|c| {
        c.query_row(
            "SELECT model, created_at, updated_at, last_seen_at FROM sessions WHERE id = ?",
            [id],
            |r| {
                let created: i64 = r.get(1)?;
                let updated: i64 = r.get(2)?;
                let seen: i64 = r.get(3)?;
                Ok(json!({
                    "model": r.get::<_, Option<String>>(0)?,
                    "updatedMoved": updated > created,
                    "lastSeenMoved": seen > created,
                }))
            },
        )
    })
    .unwrap()
}

/// Every prompt's first difference, as `(case, prompt, field)`.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn consume_matches_ts() {
    let root = tempfile::tempdir().unwrap();
    let root_path = root.path().canonicalize().unwrap();
    let home = root_path.join("home");
    std::fs::create_dir_all(home.join(".claude")).unwrap();
    std::fs::create_dir_all(root_path.join("config")).unwrap();
    assert!(paths::set_home_override(home.clone()));
    assert!(paths::set_config_dir_override(root_path.join("config")));
    let settings_file = home.join(".claude/settings.json");
    let fake = fake_cli();

    let fx = fixture();
    let mut diffs: Vec<String> = Vec::new();
    let mut prompts_seen = 0;
    for (ci, case) in fx["consume"].as_array().unwrap().iter().enumerate() {
        let name = case["name"].as_str().unwrap();
        let id = case["id"].as_str().unwrap();
        let cwd = root_path.join("consume").join(ci.to_string());
        std::fs::create_dir_all(&cwd).unwrap();
        let cwd = cwd.display().to_string();
        std::fs::write(
            &settings_file,
            format!("{}\n", js::stringify_pretty(&case["settings"])),
        )
        .unwrap();
        let mut env: HashMap<String, String> = HashMap::new();
        env.insert("PATH".into(), std::env::var("PATH").unwrap_or_default());
        env.insert("FAKE_CLAUDE_SCRIPT".into(), case["script"].to_string());
        let s: Arc<Session> = Session::new(SessionOptions {
            id: Some(id.to_owned()),
            cwd: Some(cwd.clone()),
            runtime: RuntimeOptions {
                claude_bin: Some(fake.clone()),
                env_override: Some(env),
            },
            ..Default::default()
        })
        .unwrap();
        s.start().await;
        wait_until(&format!("{name}: init"), || {
            s.buffer_snapshot()
                .iter()
                .any(|e| e["type"] == "sdk" && e["message"]["subtype"] == "init")
        })
        .await;
        // The init's own round trips (effort, MCP status) settle first, then
        // the subscription's snapshot and its async extras are drained.
        tokio::time::sleep(Duration::from_millis(400)).await;
        let mut sub = s.subscribe(None, None);
        let mut first = Vec::new();
        drain(&mut sub, Duration::from_millis(300), &mut first).await;
        // `sendQueueSnapshot` (session.ts 7595): nothing queued on either
        // side, so no `queue:updated`.
        assert!(
            !first.iter().any(|e| e["type"] == "queue:updated"),
            "{name}: {first:?}"
        );

        for want in case["prompts"].as_array().unwrap() {
            prompts_seen += 1;
            let prompt = want["prompt"].as_str().unwrap();
            let mut evs: Vec<Value> = Vec::new();
            s.send_input(prompt, &[], SendOptions::default());
            let start = Instant::now();
            while !settled(&evs, &s) {
                assert!(
                    start.elapsed() < Duration::from_secs(20),
                    "{name}: {prompt} never settled: {evs:?}"
                );
                drain(&mut sub, Duration::from_millis(10), &mut evs).await;
            }
            // The background round trips: as many as the TS saw, then a
            // grace period for any the TS didn't send.
            let n_async = want["async"].as_array().unwrap().len();
            let start = Instant::now();
            while evs.iter().filter(|e| is_async(e)).count() < n_async
                && start.elapsed() < Duration::from_secs(10)
            {
                drain(&mut sub, Duration::from_millis(10), &mut evs).await;
            }
            drain(&mut sub, Duration::from_millis(250), &mut evs).await;

            let evs: Vec<Value> = evs.into_iter().map(|e| norm(e, &cwd, None)).collect();
            let ordered: Vec<&Value> = evs.iter().filter(|e| !is_async(e)).collect();
            let mut asynced: Vec<String> = evs
                .iter()
                .filter(|e| is_async(e))
                .map(js::stringify)
                .collect();
            asynced.sort();
            let asynced = format!("[{}]", asynced.join(","));
            let checks = [
                (
                    "ordered",
                    js::stringify(&json!(ordered)),
                    js::stringify(&want["ordered"]),
                ),
                ("async", asynced, js::stringify(&want["async"])),
            ];
            for (what, got, exp) in checks {
                if got != exp {
                    eprintln!("{name} / {prompt}: {what}\n  got:  {got}\n  want: {exp}");
                    diffs.push(format!("{name} / {prompt}: {what}"));
                    break;
                }
            }
        }
        drop(sub);
        // A late subscriber gets the turn's last SDK count while it's above 0.
        let last = case["prompts"]
            .as_array()
            .unwrap()
            .iter()
            .flat_map(|p| p["ordered"].as_array().unwrap())
            .rfind(|e| e["type"] == "queue:updated")
            .cloned();
        let want_late: Vec<Value> = last
            .filter(|e| e["sdkQueuedTurns"].as_f64().is_some_and(|n| n > 0.0))
            .into_iter()
            .collect();
        let mut late = Vec::new();
        let mut sub = s.subscribe(None, None);
        drain(&mut sub, Duration::from_millis(300), &mut late).await;
        drop(sub);
        late.retain(|e| e["type"] == "queue:updated");
        assert_eq!(
            js::stringify(&json!(late)),
            js::stringify(&json!(want_late)),
            "{name}: a late subscriber's queue snapshot"
        );
        let got_row = row(&cwd, id);
        if got_row != case["row"] {
            eprintln!("{name}: row\n  got:  {got_row}\n  want: {}", case["row"]);
            diffs.push(format!("{name}: row"));
        }
        let after = std::fs::read_to_string(&settings_file).unwrap();
        if after != case["settingsAfter"].as_str().unwrap() {
            eprintln!(
                "{name}: settings\n  got:  {after:?}\n  want: {}",
                case["settingsAfter"]
            );
            diffs.push(format!("{name}: settings"));
        }
        s.end().await;
    }
    assert_eq!(prompts_seen, 55);
    assert!(diffs.is_empty(), "{diffs:#?}");
}
