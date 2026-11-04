//! `detectGitRemoteHost` and `normalizeGithubPr` / `normalizeGitlabMr`, as
//! `getPrStatus` runs them on the CLI's stdout, against the `hosts` and
//! `badges` of `tests/fixtures/git_sync_golden.json` (recorded from the real
//! `lib/shared/git-host.ts` and `lib/shared/pr-badge.ts` by
//! `rust/scripts/git-sync-golden.mjs`; its `steps` are replayed by
//! `claudius-server/tests/git_sync.rs`).
//!
//! Each badge is compared as the `JSON.stringify` text TS wrote (`null` when
//! there is none), and `how` says which step gave the `null`: `JSON.parse`
//! threw, or the normalizer did (a field `String()` can't print).

use claudius_agent::js;
use claudius_core::db_agents;
use claudius_core::js_string;
use claudius_core::pr_status::{self, GitRemoteHost};
use serde_json::Value;

fn fixture() -> Value {
    let path = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/tests/fixtures/git_sync_golden.json"
    );
    // `js_string::parse`: the URLs hold lone surrogates.
    js_string::parse(&std::fs::read_to_string(path).unwrap()).unwrap()
}

/// More than serde_json's 128 levels of nesting: V8 parses any depth, so TS
/// has a badge where Rust's parse fails (no badge).
fn too_deep(stdout: &str) -> bool {
    stdout.contains(&"[".repeat(129))
}

#[test]
fn hosts_match_the_ts() {
    let fx = fixture();
    let hosts = fx["hosts"].as_array().unwrap();
    assert!(hosts.len() >= 70, "{}", hosts.len());
    let mut failures = vec![];
    for h in hosts {
        let url = h["url"].as_str();
        let got = pr_status::detect_git_remote_host(url).as_str();
        if got != h["got"] {
            failures.push(format!("{url:?}: want {}, got {got}", h["got"]));
        }
    }
    assert!(failures.is_empty(), "{}", failures.join("\n"));
}

#[test]
fn badges_match_the_ts() {
    let fx = fixture();
    let badges = fx["badges"].as_array().unwrap();
    assert!(badges.len() >= 150, "{}", badges.len());
    let mut failures = vec![];
    let (mut deep, mut throws, mut parses) = (0, 0, 0);
    for b in badges {
        let stdout = b["stdout"].as_str().unwrap();
        let host = match b["host"].as_str().unwrap() {
            "github" => GitRemoteHost::Github,
            _ => GitRemoteHost::Gitlab,
        };
        let badge = pr_status::badge_from_stdout(host, stdout);
        let got = js_string::stringify(&badge.unwrap_or(Value::Null));
        if too_deep(stdout) {
            deep += 1;
            assert_ne!(b["got"], "null", "{stdout:.40}");
            assert_eq!(got, "null", "{stdout:.40}");
            continue;
        }
        if got != b["got"] {
            failures.push(format!(
                "{} {stdout:?}:\n  want {}\n  got  {got}",
                b["host"], b["got"]
            ));
        }
        match b["how"].as_str().unwrap() {
            "parse" => {
                parses += 1;
                assert!(js::json_parse_error(stdout).is_some(), "{stdout:?}");
            }
            "throw" => {
                throws += 1;
                let raw = db_agents::json_parse(stdout).unwrap();
                let thrown = match host {
                    GitRemoteHost::Github => pr_status::normalize_github_pr(&raw).is_err(),
                    _ => false,
                };
                assert!(thrown, "{stdout:?}");
            }
            _ => assert!(js::json_parse_error(stdout).is_none(), "{stdout:?}"),
        }
    }
    assert!(failures.is_empty(), "{}", failures.join("\n"));
    assert_eq!(deep, 2);
    assert!(throws >= 4 && parses >= 10, "{throws} {parses}");
}
