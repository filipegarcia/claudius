//! Replays `tests/fixtures/fork_golden.json`, recorded from the real SDK's
//! `forkSession` by `rust/scripts/fork-golden.mjs`: every case must produce
//! the same normalized JSONL (or the same error) from
//! `sessions_store::fork_file`.

use std::collections::HashMap;
use std::path::Path;

use claudius_core::sessions_store::{self, ForkOptions};
use claudius_core::transcript;
use regex::Regex;
use serde_json::Value;

/// Same normalization as the recorder: fork id → `$FORK`, uuids not in the
/// source → `$U<n>` by first appearance, ISO timestamps not in the source →
/// `$NOW`.
fn normalize(text: &str, source: &str, fork_id: &str) -> Vec<String> {
    let uuid_re =
        Regex::new(r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}").unwrap();
    let iso_re = Regex::new(r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z").unwrap();
    let text = text.replace(fork_id, "$FORK");
    let mut seen: HashMap<String, String> = HashMap::new();
    let text = uuid_re.replace_all(&text, |c: &regex::Captures| {
        let u = &c[0];
        if source.contains(u) {
            return u.to_owned();
        }
        let n = seen.len() + 1;
        seen.entry(u.to_owned())
            .or_insert_with(|| format!("$U{n}"))
            .clone()
    });
    let text = iso_re.replace_all(&text, |c: &regex::Captures| {
        if source.contains(&c[0]) {
            c[0].to_owned()
        } else {
            "$NOW".to_owned()
        }
    });
    text.split('\n').map(str::to_owned).collect()
}

fn fixture() -> Vec<Value> {
    let raw = std::fs::read_to_string(
        Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/fork_golden.json"),
    )
    .unwrap();
    let v: Value = serde_json::from_str(&raw).unwrap();
    v["cases"].as_array().unwrap().clone()
}

/// Write a case's source transcript (and sidecar) into a fresh project dir.
fn stage(case: &Value) -> (tempfile::TempDir, std::path::PathBuf) {
    let tmp = tempfile::tempdir().unwrap();
    let sid = case["sessionId"].as_str().unwrap();
    let file = tmp.path().join(format!("{sid}.jsonl"));
    std::fs::write(&file, case["transcript"].as_str().unwrap()).unwrap();
    if let Some(title) = case["sidecar"].as_str() {
        std::fs::create_dir_all(tmp.path().join(sid)).unwrap();
        std::fs::write(
            tmp.path().join(sid).join("custom-title.json"),
            serde_json::json!({"customTitle": title}).to_string(),
        )
        .unwrap();
    }
    (tmp, file)
}

#[test]
fn fork_matches_the_sdk() {
    let cases = fixture();
    assert!(cases.len() >= 30, "fixture lost cases");
    let mut failures = Vec::new();
    for case in &cases {
        let name = case["name"].as_str().unwrap();
        let sid = case["sessionId"].as_str().unwrap();
        let (tmp, file) = stage(case);
        let opts = &case["options"];
        let got = sessions_store::fork_file(
            &file,
            sid,
            opts["upToMessageId"].as_str(),
            opts["title"].as_str(),
        );
        let expected = &case["result"];
        match (got, expected.get("error")) {
            (Ok(fork_id), None) => {
                let forked =
                    std::fs::read_to_string(tmp.path().join(format!("{fork_id}.jsonl"))).unwrap();
                let lines = normalize(&forked, case["transcript"].as_str().unwrap(), &fork_id);
                let want: Vec<String> = expected["lines"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|l| l.as_str().unwrap().to_owned())
                    .collect();
                if lines != want {
                    let diff: Vec<String> = lines
                        .iter()
                        .zip(want.iter().chain(std::iter::repeat(&String::new())))
                        .filter(|(g, w)| g != w)
                        .map(|(g, w)| format!("    got  {g}\n    want {w}"))
                        .collect();
                    failures.push(format!(
                        "{name} ({} vs {} lines):\n{}",
                        lines.len(),
                        want.len(),
                        diff.join("\n")
                    ));
                }
            }
            (Err(e), Some(msg)) => {
                if e.to_string() != msg.as_str().unwrap() {
                    failures.push(format!("{name}: error {e:?} != {msg}"));
                }
            }
            (got, _) => failures.push(format!("{name}: got {got:?}, want {expected}")),
        }
    }
    assert!(failures.is_empty(), "{}", failures.join("\n"));
}

/// The fork is a normal session: `info` reads its title and the message
/// pipeline rebuilds the chain from the new uuids.
#[test]
fn forked_session_reads_back() {
    let case = fixture()
        .into_iter()
        .find(|c| c["name"] == "progress_bridged_and_dropped")
        .unwrap();
    let sid = case["sessionId"].as_str().unwrap();
    let (tmp, file) = stage(&case);
    let fork_id = sessions_store::fork_file(&file, sid, None, None).unwrap();
    let forked = tmp.path().join(format!("{fork_id}.jsonl"));
    let ht = sessions_store::read_head_tail(&forked).unwrap();
    let info = sessions_store::info_from_head_tail(&fork_id, &ht, None, None).unwrap();
    assert_eq!(info.custom_title.as_deref(), Some("go (fork)"));
    assert_eq!(info.summary, "go (fork)");
    assert_eq!(info.first_prompt.as_deref(), Some("go"));
    let msgs = transcript::session_messages(&std::fs::read_to_string(&forked).unwrap(), true);
    let texts: Vec<String> = msgs
        .iter()
        .map(|m| {
            let c = &m["message"]["content"];
            c.as_str()
                .map(str::to_owned)
                .unwrap_or_else(|| c[0]["text"].as_str().unwrap_or_default().to_owned())
        })
        .collect();
    assert_eq!(texts, ["go", "working", "after", "fin"], "progress bridged");
    assert!(msgs.iter().all(|m| m["session_id"] == fork_id.as_str()));
    // Source untouched.
    assert_eq!(
        std::fs::read_to_string(&file).unwrap(),
        case["transcript"].as_str().unwrap()
    );
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mode = std::fs::metadata(&forked).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode & 0o077, 0, "0600 like the SDK, got {mode:o}");
    }
}

#[test]
fn fork_lookup_errors_match_the_sdk() {
    let e = sessions_store::fork("nope", &ForkOptions::default()).unwrap_err();
    assert_eq!(e.to_string(), "Invalid sessionId: nope");
    let missing = "33333333-3333-4333-8333-333333333333";
    let dir = tempfile::tempdir().unwrap();
    let d = dir.path().to_str().unwrap().to_owned();
    let e = sessions_store::fork(
        missing,
        &ForkOptions {
            dir: Some(d.clone()),
            ..Default::default()
        },
    )
    .unwrap_err();
    assert_eq!(
        e.to_string(),
        format!("Session {missing} not found in project directory for {d}")
    );
}
