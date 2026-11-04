//! The current branch's PR / MR badge and the `origin` host behind
//! `workspaces/[id]/git/{pr-status,remote-host}` (D09): ports of
//! `lib/server/pr-status.ts`, `lib/shared/pr-badge.ts` and
//! `lib/shared/git-host.ts`.
//!
//! [`get_pr_status`] classifies `origin`'s URL ([`detect_git_remote_host`]),
//! reads the branch (`git rev-parse --abbrev-ref HEAD`, 2 s), and runs
//! `gh pr view <branch> --json …` (GitHub) or `glab mr view <branch> -F
//! json` (GitLab) in the workspace's dir, 6 s and 1 MiB at most, with the
//! server's env plus `GH_PROMPT_DISABLED=1` / `GH_NO_UPDATE_NOTIFIER=1`
//! (gh) or `GLAB_CHECK_UPDATE=false` (glab). Any failure is no badge: a
//! missing CLI, a non-zero exit, a timeout, output that isn't JSON or a
//! shape without a number. Each answer, `null` too, is cached for 30 s per
//! `cwd|host|branch` (the clock read before the CLI ran), in this process,
//! with no eviction. As in TS, the branch reaches the CLI as given: one
//! named like an option (`-x`) reads as one.
//!
//! The CLI's JSON is read like `JSON.parse`: a lone-surrogate escape stays a
//! lone surrogate ([`crate::js_string`]; write the badge with
//! [`crate::js_string::stringify`]), and a number past f64 is ±Infinity (a
//! number, written `null`).

use std::collections::HashMap;
use std::path::Path;
use std::sync::{LazyLock, Mutex};

use claudius_agent::js;
use serde_json::{Map, Value, json};

use crate::db_agents::{as_str, number, number_json, with_infinities};
use crate::exec_file::{self, ExecFileOptions};
use crate::git;
use crate::js_string::{self, NoPrimitive};

/// `CACHE_TTL_MS`.
const CACHE_TTL_MS: i64 = 30_000;
/// `EXEC_TIMEOUT_MS`: the `gh` / `glab` run.
const EXEC_TIMEOUT_MS: u64 = 6_000;
/// `currentBranch`'s timeout.
const BRANCH_TIMEOUT_MS: u64 = 2_000;

// ------------------------------- git-host.ts -------------------------------

/// `GitRemoteHost`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum GitRemoteHost {
    Github,
    Gitlab,
    Other,
}

impl GitRemoteHost {
    pub fn as_str(self) -> &'static str {
        match self {
            GitRemoteHost::Github => "github",
            GitRemoteHost::Gitlab => "gitlab",
            GitRemoteHost::Other => "other",
        }
    }
}

/// The longest prefix of `s` without a `/` or `:` (`[^/:]+`, greedy).
fn host_run(s: &str) -> &str {
    &s[..s.find(['/', ':']).unwrap_or(s.len())]
}

/// `/^[a-z][a-z0-9+.-]*:\/\/(?:[^@/]*@)?([^/:]+)/`'s group: the userinfo
/// (up to the first `@`, if no `/` comes first) is skipped when a host
/// follows it, else the host starts right after `://`.
fn scheme_host(u: &str) -> Option<&str> {
    let mut chars = u.char_indices();
    if !matches!(chars.next(), Some((_, 'a'..='z'))) {
        return None;
    }
    let scheme_end = chars
        .find(|(_, c)| !matches!(c, 'a'..='z' | '0'..='9' | '+' | '.' | '-'))
        .map_or(u.len(), |(i, _)| i);
    let rest = u[scheme_end..].strip_prefix("://")?;
    if let Some(i) = rest.find(['@', '/'])
        && rest[i..].starts_with('@')
    {
        let host = host_run(&rest[i + 1..]);
        if !host.is_empty() {
            return Some(host);
        }
    }
    let host = host_run(rest);
    (!host.is_empty()).then_some(host)
}

/// `/^(?:[^@]*@)?([^/:]+):/`'s group: after the first `@` if a host and a
/// `:` follow it there, else from the start.
fn scp_host(u: &str) -> Option<&str> {
    fn followed_by_colon(s: &str) -> Option<&str> {
        let host = host_run(s);
        (!host.is_empty() && s[host.len()..].starts_with(':')).then_some(host)
    }
    if let Some(i) = u.find('@')
        && let Some(host) = followed_by_colon(&u[i + 1..])
    {
        return Some(host);
    }
    followed_by_colon(u)
}

/// `detectGitRemoteHost`: the lower-cased URL's host, from `scheme://[user@]
/// host…` or the scp-like `[user@]host:path`, is GitHub or GitLab when one
/// of its dot-separated labels is exactly `github` / `gitlab` (so
/// `github.com.attacker.net` is GitHub, `evil.com/github.com` isn't).
pub fn detect_git_remote_host(url: Option<&str>) -> GitRemoteHost {
    let Some(url) = url.filter(|u| !u.is_empty()) else {
        return GitRemoteHost::Other;
    };
    let u = url.to_lowercase();
    let host = scheme_host(&u).or_else(|| scp_host(&u)).unwrap_or("");
    let labels: Vec<&str> = host.split('.').collect();
    if labels.contains(&"github") {
        GitRemoteHost::Github
    } else if labels.contains(&"gitlab") {
        GitRemoteHost::Gitlab
    } else {
        GitRemoteHost::Other
    }
}

// ------------------------------- pr-badge.ts -------------------------------

/// `asRecord`: a non-array object.
fn as_record(v: Option<&Value>) -> Option<&Map<String, Value>> {
    v?.as_object()
}

/// `String(v ?? "").toUpperCase()`; throws (`NoPrimitive`) for an object
/// with its own `toString`.
fn upper_string(v: Option<&Value>) -> Result<String, NoPrimitive> {
    Ok(match v {
        None | Some(Value::Null) => String::new(),
        Some(v) => js_string::to_upper(&js_string::to_js_string(v)?),
    })
}

/// `{ host, number, url, title?, state, checks }`.
fn badge(
    host: &str,
    number: &Value,
    o: &Map<String, Value>,
    url_key: &str,
    state: &str,
    checks: &str,
) -> Value {
    let mut b = Map::new();
    b.insert("host".into(), json!(host));
    b.insert("number".into(), number_json(number));
    let url = o.get(url_key).and_then(as_str).unwrap_or("");
    b.insert("url".into(), json!(url));
    if let Some(title) = o.get("title").and_then(as_str) {
        b.insert("title".into(), json!(title));
    }
    b.insert("state".into(), json!(state));
    b.insert("checks".into(), json!(checks));
    Value::Object(b)
}

/// `normalizeGithubPr`: `None` without a numeric `number`. The state is
/// `MERGED` / `CLOSED` (upper-cased), else `draft` for `isDraft: true`, else
/// `open`. The checks: the first failing run (`conclusion` FAILURE / ERROR /
/// CANCELLED / TIMED_OUT / FAILED, or a FAILURE `state`) makes them
/// `failing`; else any IN_PROGRESS / QUEUED / PENDING `status` or PENDING /
/// EXPECTED `state` makes them `pending`; else a SUCCESS makes them
/// `passing`; else `none`. Each field is read as `String(…)`, which throws
/// for an object with its own `toString` (no badge).
pub fn normalize_github_pr(raw: &Value) -> Result<Option<Value>, NoPrimitive> {
    let Some(o) = as_record(Some(raw)) else {
        return Ok(None);
    };
    let Some(n) = o.get("number").filter(|v| number(v).is_some()) else {
        return Ok(None);
    };
    let gh_state = o
        .get("state")
        .and_then(as_str)
        .map(js_string::to_upper)
        .unwrap_or_default();
    let state = match gh_state.as_str() {
        "MERGED" => "merged",
        "CLOSED" => "closed",
        _ if o.get("isDraft") == Some(&Value::Bool(true)) => "draft",
        _ => "open",
    };
    let rollup = match o.get("statusCheckRollup") {
        Some(Value::Array(a)) => a.as_slice(),
        _ => &[],
    };
    let (mut failing, mut any_pending, mut any_passing) = (false, false, false);
    for c in rollup {
        let Some(cr) = as_record(Some(c)) else {
            continue;
        };
        let status = upper_string(cr.get("status"))?;
        let conclusion = upper_string(cr.get("conclusion"))?;
        let legacy = upper_string(cr.get("state"))?;
        if ["FAILURE", "ERROR", "CANCELLED", "TIMED_OUT", "FAILED"].contains(&conclusion.as_str())
            || legacy == "FAILURE"
        {
            failing = true;
            break;
        }
        if ["IN_PROGRESS", "QUEUED", "PENDING"].contains(&status.as_str())
            || legacy == "PENDING"
            || legacy == "EXPECTED"
        {
            any_pending = true;
        }
        if conclusion == "SUCCESS" || legacy == "SUCCESS" {
            any_passing = true;
        }
    }
    let checks = if failing {
        "failing"
    } else if any_pending {
        "pending"
    } else if any_passing {
        "passing"
    } else {
        "none"
    };
    Ok(Some(badge("github", n, o, "url", state, checks)))
}

/// `normalizeGitlabMr`: `None` without a numeric `iid`. The state is
/// `merged` / `closed` (lower-cased), else `draft` for `draft: true` or
/// `work_in_progress: true`, else `open`. The checks come from `pipeline`
/// (or, when that isn't an object, `head_pipeline`) `status`: `success`,
/// `failed`, one of the waiting states (`pending`), else `none`.
pub fn normalize_gitlab_mr(raw: &Value) -> Option<Value> {
    let o = as_record(Some(raw))?;
    let iid = o.get("iid").filter(|v| number(v).is_some())?;
    let gl_state = o
        .get("state")
        .and_then(as_str)
        .map(str::to_lowercase)
        .unwrap_or_default();
    let is_true = |k: &str| o.get(k) == Some(&Value::Bool(true));
    let state = match gl_state.as_str() {
        "merged" => "merged",
        "closed" => "closed",
        _ if is_true("draft") || is_true("work_in_progress") => "draft",
        _ => "open",
    };
    let pipeline = as_record(o.get("pipeline")).or_else(|| as_record(o.get("head_pipeline")));
    let pstatus = pipeline
        .and_then(|p| p.get("status"))
        .and_then(as_str)
        .map(str::to_lowercase)
        .unwrap_or_default();
    let checks = match pstatus.as_str() {
        "success" => "passing",
        "failed" => "failing",
        "running" | "pending" | "created" | "preparing" | "scheduled" | "waiting_for_resource" => {
            "pending"
        }
        _ => "none",
    };
    Some(badge("gitlab", iid, o, "web_url", state, checks))
}

/// `normalize…(JSON.parse(stdout))` inside `getPrStatus`'s `try`: any throw
/// (not JSON, a field `String()` can't print) is no badge. `host` is GitHub
/// or GitLab.
pub fn badge_from_stdout(host: GitRemoteHost, stdout: &str) -> Option<Value> {
    if js::json_parse_error(stdout).is_some() {
        return None;
    }
    let raw = js_string::parse(&with_infinities(stdout)).ok()?;
    match host {
        GitRemoteHost::Github => normalize_github_pr(&raw).ok().flatten(),
        _ => normalize_gitlab_mr(&raw),
    }
}

// ------------------------------- pr-status.ts -------------------------------

struct Hit {
    at: i64,
    badge: Option<Value>,
}

/// The module's `cache`: `${cwd}|${host}|${branch}` → the answer and when
/// its run started.
static CACHE: LazyLock<Mutex<HashMap<String, Hit>>> = LazyLock::new(Default::default);

/// `currentBranch`: `git rev-parse --abbrev-ref HEAD` in `cwd` (2 s), JS-
/// trimmed; `None` when that fails, is blank, or reads `HEAD` (detached).
async fn current_branch(cwd: &str) -> Option<String> {
    let opts = ExecFileOptions {
        cwd: Some(Path::new(cwd)),
        timeout_ms: BRANCH_TIMEOUT_MS,
        ..ExecFileOptions::default()
    };
    let out = exec_file::exec_file("git", &["rev-parse", "--abbrev-ref", "HEAD"], opts)
        .await
        .ok()?;
    let branch = js::trim(&out.stdout);
    (!branch.is_empty() && branch != "HEAD").then(|| branch.to_owned())
}

/// `getPrStatus(cwd)`: the badge as `JSON.stringify` writes it (through
/// [`js_string::stringify`]), or `None`.
pub async fn get_pr_status(cwd: &str) -> Option<Value> {
    let url = git::get_origin_remote_url(cwd).await;
    let host = detect_git_remote_host(url.as_deref());
    if host == GitRemoteHost::Other {
        return None;
    }
    let branch = current_branch(cwd).await?;
    let key = format!("{cwd}|{}|{branch}", host.as_str());
    let now = crate::now_ms();
    if let Some(hit) = CACHE.lock().unwrap().get(&key)
        && now - hit.at < CACHE_TTL_MS
    {
        return hit.badge.clone();
    }
    let opts = ExecFileOptions {
        cwd: Some(Path::new(cwd)),
        timeout_ms: EXEC_TIMEOUT_MS,
        ..ExecFileOptions::default()
    };
    let run = if host == GitRemoteHost::Github {
        exec_file::exec_file_env(
            "gh",
            &[
                "pr",
                "view",
                &branch,
                "--json",
                "number,state,isDraft,statusCheckRollup,title,url",
            ],
            opts,
            &[("GH_PROMPT_DISABLED", "1"), ("GH_NO_UPDATE_NOTIFIER", "1")],
        )
        .await
    } else {
        exec_file::exec_file_env(
            "glab",
            &["mr", "view", &branch, "-F", "json"],
            opts,
            &[("GLAB_CHECK_UPDATE", "false")],
        )
        .await
    };
    let badge = run
        .ok()
        .and_then(|out| badge_from_stdout(host, &out.stdout));
    CACHE.lock().unwrap().insert(
        key,
        Hit {
            at: now,
            badge: badge.clone(),
        },
    );
    badge
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hosts_by_label() {
        let h = |u: &str| detect_git_remote_host(Some(u)).as_str();
        assert_eq!(h("https://github.com/o/r.git"), "github");
        assert_eq!(h("git@gitlab.com:o/r.git"), "gitlab");
        assert_eq!(h("ssh://git@GitHub.com/o/r"), "github");
        assert_eq!(h("https://evil.com/github.com"), "other");
        assert_eq!(h("https://u@/github"), "other");
        assert_eq!(h("@:x"), "other");
        assert_eq!(detect_git_remote_host(None).as_str(), "other");
    }

    #[test]
    fn scheme_and_scp_groups() {
        assert_eq!(scheme_host("https://a@b@c/x"), Some("b@c"));
        assert_eq!(scheme_host("https://user@/x"), Some("user@"));
        assert_eq!(scheme_host("https:///x"), None);
        assert_eq!(scheme_host("1https://x"), None);
        assert_eq!(scp_host("a:b@c:d"), Some("c"));
        assert_eq!(scp_host("user@host/path:x"), None);
        assert_eq!(scp_host("@:x"), Some("@"));
        assert_eq!(scp_host("c:/x"), Some("c"));
    }
}
