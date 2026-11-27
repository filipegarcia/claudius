//! The shapes the Git routes answer (`lib/server/git.ts`, `pr-badge.ts`,
//! `workspaces-store.ts`), as the page reads them, and the few JS string
//! rules the page's helpers lean on (UTF-16 lengths and slices, `trim`,
//! `String(number)`).

use serde::{Deserialize, Serialize};
use serde_json::Value;

/// `GitFileChange`: one porcelain entry. `index` / `worktree` are the
/// one-letter `GitStatusCode`s (`" "`, `M`, `A`, `D`, `R`, `C`, `T`, `U`,
/// `?`, `!`).
#[derive(Clone, Debug, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitFileChange {
    pub path: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub old_path: Option<String>,
    pub index: String,
    pub worktree: String,
    #[serde(default)]
    pub untracked: bool,
}

impl GitFileChange {
    /// A tracked change (`index` + `worktree` codes).
    pub fn new(path: &str, index: &str, worktree: &str) -> Self {
        GitFileChange {
            path: path.into(),
            old_path: None,
            index: index.into(),
            worktree: worktree.into(),
            untracked: false,
        }
    }

    /// An untracked file (`??`).
    pub fn untracked(path: &str) -> Self {
        GitFileChange {
            path: path.into(),
            old_path: None,
            index: "?".into(),
            worktree: "?".into(),
            untracked: true,
        }
    }
}

/// `GitStatusPayload` (`useGitStatus.ts`): `GET git/status`.
#[derive(Clone, Debug, Default, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitStatusPayload {
    pub is_repo: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub repo_root: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub branch: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub head: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ahead: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub behind: Option<f64>,
    #[serde(default)]
    pub files: Vec<GitFileChange>,
}

/// `BranchInfo` (`BranchSwitcher.tsx`): one row of `GET git/branches`.
#[derive(Clone, Debug, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BranchInfo {
    pub name: String,
    /// `"local"` or `"remote"`.
    pub kind: String,
    pub sha: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub upstream: Option<String>,
    #[serde(default)]
    pub committer_date: String,
    #[serde(default)]
    pub current: bool,
}

impl BranchInfo {
    pub fn is_local(&self) -> bool {
        self.kind == "local"
    }
    pub fn is_remote(&self) -> bool {
        self.kind == "remote"
    }
}

/// `PrBadge` (`lib/shared/pr-badge.ts`): `GET git/pr-status`'s `badge`.
#[derive(Clone, Debug, PartialEq, Deserialize, Serialize)]
pub struct PrBadge {
    /// `"github"` or `"gitlab"`.
    pub host: String,
    pub number: f64,
    #[serde(default)]
    pub url: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    /// `open` / `draft` / `merged` / `closed`.
    pub state: String,
    /// `passing` / `failing` / `pending` / `none`.
    pub checks: String,
}

/// `{ diff, binary }`: `GET git/diff`.
#[derive(Clone, Debug, Default, PartialEq, Eq, Deserialize, Serialize)]
pub struct DiffPayload {
    #[serde(default)]
    pub diff: String,
    #[serde(default)]
    pub binary: bool,
}

/// `POST git/commit`'s `{ sha, subject }`.
#[derive(Clone, Debug, Default, PartialEq, Eq, Deserialize, Serialize)]
pub struct CommitOk {
    #[serde(default)]
    pub sha: Option<String>,
    #[serde(default)]
    pub subject: Option<String>,
}

/// `CommitPrefixConfig` (`lib/shared/commit-prefix.ts`): a workspace's
/// `commitPrefix`.
#[derive(Clone, Debug, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitPrefixConfig {
    pub enabled: bool,
    pub branch_pattern: String,
    pub template: String,
}

impl CommitPrefixConfig {
    /// A workspace's `commitPrefix` as the store holds it: `None` unless it
    /// is an object with string `branchPattern` / `template` (the page
    /// would throw at `.trim()` on anything else); `enabled` is JS truthy.
    pub fn from_value(v: &Value) -> Option<CommitPrefixConfig> {
        let o = v.as_object()?;
        let enabled = o.get("enabled").is_some_and(truthy);
        let branch_pattern = o.get("branchPattern")?.as_str()?.to_owned();
        let template = o.get("template")?.as_str()?.to_owned();
        Some(CommitPrefixConfig {
            enabled,
            branch_pattern,
            template,
        })
    }
}

/// JS truthiness of a JSON value.
pub fn truthy(v: &Value) -> bool {
    match v {
        Value::Null => false,
        Value::Bool(b) => *b,
        Value::Number(n) => n.as_f64().is_some_and(|f| f != 0. && !f.is_nan()),
        Value::String(s) => !s.is_empty(),
        _ => true,
    }
}

// ---- JS string rules ------------------------------------------------------

/// JS whitespace (`\s`, what `trim` strips): Unicode `White_Space` minus
/// U+0085, plus U+FEFF.
pub fn is_js_whitespace(c: char) -> bool {
    (c.is_whitespace() && c != '\u{85}') || c == '\u{feff}'
}

/// `String.prototype.trim`.
pub fn js_trim(s: &str) -> &str {
    s.trim_matches(is_js_whitespace)
}

/// `String.prototype.trimEnd`.
pub fn js_trim_end(s: &str) -> &str {
    s.trim_end_matches(is_js_whitespace)
}

/// `s.length` (UTF-16 code units).
pub fn js_len(s: &str) -> usize {
    s.encode_utf16().count()
}

/// `s.slice(0, n)` on UTF-16 units (a split surrogate pair becomes U+FFFD,
/// as the lone half would print).
pub fn js_slice_to(s: &str, n: usize) -> String {
    let units: Vec<u16> = s.encode_utf16().take(n).collect();
    String::from_utf16_lossy(&units)
}

/// `String(n)` for the numbers the page prints (counts, line numbers, PR
/// numbers): integers below 1e21 in full, larger ones with an exponent.
pub fn js_number(n: f64) -> String {
    if n.is_nan() {
        return "NaN".into();
    }
    if n.is_infinite() {
        return if n > 0. { "Infinity" } else { "-Infinity" }.into();
    }
    if n == 0. {
        return "0".into();
    }
    if n.abs() >= 1e21 {
        let s = format!("{n:e}");
        return match s.split_once('e') {
            Some((m, e)) if !e.starts_with('-') => format!("{m}e+{e}"),
            _ => s,
        };
    }
    format!("{n}")
}

/// The `s` suffix of the page's counts (`file{n === 1 ? "" : "s"}`).
pub fn plural(n: usize) -> &'static str {
    if n == 1 { "" } else { "s" }
}
