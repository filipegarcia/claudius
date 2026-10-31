//! Session recap parity (S12): `extract_transcript_tail`, `cap_recap` and
//! `generate_recap` replayed against what `lib/server/session-recap.ts` and
//! `lib/shared/recap-cap.ts` produced (`rust/scripts/recap-golden.mjs`).
//!
//! `generate_recap` runs against the fake CLI with the recorded script, and
//! the CLI's argv, env and stdin (the `initialize` request, the prompt, the
//! tool denial) are normalized and compared like `golden-wire.mjs` does.
//! JS outputs are recorded without lone surrogates, plus their JS length.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;
use std::time::Duration;

use claudius_core::session_recap::{
    RECAP_DEDUPE_WINDOW_MS, RECAP_INSTRUCTION, RECAP_MAX_CHARS, RecapInput, RecapOutcome,
    cap_recap, extract_transcript_tail, generate_recap,
};
use serde_json::{Value, json};
use tokio_util::sync::CancellationToken;

fn fixture() -> &'static Value {
    static F: OnceLock<Value> = OnceLock::new();
    F.get_or_init(|| serde_json::from_str(include_str!("fixtures/recap_golden.json")).unwrap())
}

fn units(s: &str) -> u64 {
    s.encode_utf16().count() as u64
}

/// The JS `.length` of a recorded output: what Rust holds plus the lone
/// surrogates it can't.
fn js_length(got: &str, case: &Value) -> u64 {
    units(got) + case["lone"].as_u64().unwrap()
}

#[test]
fn the_constants_match() {
    let f = fixture();
    assert_eq!(f["instruction"], RECAP_INSTRUCTION);
    assert_eq!(f["dedupeWindowMs"], RECAP_DEDUPE_WINDOW_MS);
    assert_eq!(f["maxChars"], RECAP_MAX_CHARS);
}

#[test]
fn the_transcript_tail_matches() {
    let tails = fixture()["tails"].as_array().unwrap();
    assert!(tails.len() >= 15);
    for t in tails {
        let name = t["name"].as_str().unwrap();
        let got = extract_transcript_tail(t["buffer"].as_array().unwrap());
        if t.get("throws").is_some() {
            assert_eq!(got, None, "{name}");
            continue;
        }
        let (text, turns) = got.unwrap_or_else(|| panic!("{name}: no tail"));
        assert_eq!(text, t["text"], "{name}");
        assert_eq!(turns as u64, t["turnCount"].as_u64().unwrap(), "{name}");
        assert_eq!(
            js_length(&text, t),
            t["jsLength"].as_u64().unwrap(),
            "{name}"
        );
    }
}

#[test]
fn cap_recap_matches() {
    for c in fixture()["caps"].as_array().unwrap() {
        let input = c["input"].as_str().unwrap();
        let max = c["max"].as_u64().map_or(RECAP_MAX_CHARS, |m| m as usize);
        let got = cap_recap(input, max);
        let label = format!("{} units, max {max}", units(input));
        assert_eq!(got, c["text"], "{label}");
        assert_eq!(
            js_length(&got, c),
            c["jsLength"].as_u64().unwrap(),
            "{label}"
        );
    }
}

fn fake_cli() -> &'static PathBuf {
    static FAKE: OnceLock<PathBuf> = OnceLock::new();
    FAKE.get_or_init(|| {
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
    })
}

/// `golden-wire.mjs`'s `norm`: the per-run temp dir becomes `$TMP`.
fn norm(v: Value, tmp: &str) -> Value {
    match v {
        Value::String(s) => Value::String(s.replace(tmp, "$TMP")),
        Value::Array(a) => Value::Array(a.into_iter().map(|v| norm(v, tmp)).collect()),
        Value::Object(o) => Value::Object(o.into_iter().map(|(k, v)| (k, norm(v, tmp))).collect()),
        v => v,
    }
}

fn read_json(p: &Path) -> Value {
    std::fs::read_to_string(p)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or(Value::Null)
}

/// The stdin log with host request ids numbered and CLI ids masked.
fn read_stdin(p: &Path) -> Value {
    let Ok(text) = std::fs::read_to_string(p) else {
        return Value::Null;
    };
    let mut ids: Vec<String> = Vec::new();
    let lines = text
        .lines()
        .filter(|l| !l.is_empty())
        .map(|l| {
            let mut m: Value = serde_json::from_str(l).unwrap();
            if let Some(id) = m["request_id"].as_str().map(str::to_owned) {
                let n = ids.iter().position(|x| *x == id).unwrap_or_else(|| {
                    ids.push(id);
                    ids.len() - 1
                });
                m["request_id"] = json!(format!("$ID{n}"));
            } else if m["type"] == "control_response" && m["response"]["request_id"].is_string() {
                m["response"]["request_id"] = json!("$CLI_ID");
            }
            m
        })
        .collect();
    Value::Array(lines)
}

const ABORT_MESSAGES: &[&str] = &["Operation aborted", "Claude Code process aborted by user"];

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn generate_recap_matches_on_the_wire() {
    let f = fixture();
    let fake = fake_cli();
    let runs = f["generate"].as_array().unwrap();
    assert!(runs.len() >= 12);
    let mut failures = Vec::new();
    for g in runs {
        let name = g["name"].as_str().unwrap();
        let root = tempfile::tempdir().unwrap();
        let tmp = root.path().canonicalize().unwrap();
        let tmp_s = tmp.display().to_string();
        let cwd = tmp.join("proj");
        std::fs::create_dir(&cwd).unwrap();
        let (argv, env_file, log) = (
            tmp.join("argv.json"),
            tmp.join("env.json"),
            tmp.join("stdin.log"),
        );
        let env: HashMap<String, String> = [
            ("PATH", "/usr/bin:/bin".to_owned()),
            ("HOME", tmp.join("home").display().to_string()),
            ("FAKE_CLAUDE_SCRIPT", g["script"].to_string()),
            ("FAKE_CLAUDE_ARGV", argv.display().to_string()),
            ("FAKE_CLAUDE_ENV", env_file.display().to_string()),
            ("FAKE_CLAUDE_LOG", log.display().to_string()),
        ]
        .into_iter()
        .map(|(k, v)| (k.to_owned(), v))
        .collect();
        let opts = &g["opts"];
        let token = CancellationToken::new();
        if opts["preAborted"] == true {
            token.cancel();
        }
        if let Some(ms) = opts["abortAfterMs"].as_u64() {
            let t = token.clone();
            tokio::spawn(async move {
                tokio::time::sleep(Duration::from_millis(ms)).await;
                t.cancel();
            });
        }
        let input = RecapInput {
            cwd: cwd.display().to_string(),
            transcript_tail: f["tail"].as_str().unwrap().to_owned(),
            model: opts["model"].as_str().map(str::to_owned),
            env: Some(env),
            claude_bin: Some(fake.clone()),
        };
        let outcome = tokio::time::timeout(Duration::from_secs(30), generate_recap(input, token))
            .await
            .unwrap_or_else(|_| panic!("{name}: timed out"));

        let want = &g["outcome"];
        let outcome_ok = match (&outcome, want["ok"] == true) {
            (RecapOutcome::Ok(text), true) => {
                *text == want["text"]
                    && units(text) + want["lone"].as_u64().unwrap() == want["jsLength"]
            }
            (RecapOutcome::EmptyResponse, false) => want["reason"] == "empty_response",
            // A cancelled query: TS reports the SDK's abort error, which
            // `requestRecap` drops because its signal is aborted.
            (RecapOutcome::Aborted, false) => {
                want["reason"] == "failed"
                    && ABORT_MESSAGES.iter().any(|m| want["message"] == *m)
                    && (opts["preAborted"] == true || opts["abortAfterMs"].is_u64())
            }
            (RecapOutcome::Failed(m), false) => want["reason"] == "failed" && want["message"] == *m,
            _ => false,
        };
        if !outcome_ok {
            failures.push(format!("{name}: outcome {outcome:?}, want {want}"));
        }
        let mut cli_env = read_json(&env_file);
        if let Some(o) = cli_env.as_object_mut() {
            o.retain(|k, _| !k.starts_with("FAKE_CLAUDE_") && !k.starts_with("__CF"));
        }
        for (what, got) in [
            ("argv", norm(read_json(&argv), &tmp_s)),
            ("env", norm(cli_env, &tmp_s)),
            ("stdin", norm(read_stdin(&log), &tmp_s)),
        ] {
            if got != g[what] {
                failures.push(format!("{name}: {what}\n  got  {got}\n  want {}", g[what]));
            }
        }
    }
    assert!(failures.is_empty(), "{}", failures.join("\n"));
}
