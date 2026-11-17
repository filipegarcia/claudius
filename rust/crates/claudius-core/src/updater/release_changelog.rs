//! `lib/shared/release-changelog.ts` and
//! `lib/server/updater/release-changelog.ts`: the "What's new" list the
//! desktop update modal shows, built from the commits between two release
//! tags (GitHub's public compare API), grouped by Conventional Commit type.
//!
//! The values are JS values, as the TS sees them: GitHub's JSON is read with
//! [`js_string::parse`] (a lone-surrogate escape stays one), every member
//! the TS reads is read the way JS reads it, and where the TS throws on an
//! odd shape (`sha.slice is not a function`, a `null` commit, a `length`
//! that can't become a number) the same `TypeError` message is the result,
//! which the route answers as a 502 and caches for 5 minutes like any other
//! failure. A success is cached for the life of the process.

use std::collections::{HashMap, HashSet};
use std::sync::Mutex;
use std::time::Duration;

use claudius_agent::js;
use serde_json::{Map, Value};

use crate::fetch::{Fetch, Request};
use crate::{js_num, js_string};

pub const OWNER: &str = "filipegarcia";
pub const REPO: &str = "claudius";
/// `FAILURE_TTL_MS`: how long a failed fetch is answered from the cache.
pub const FAILURE_TTL_MS: f64 = 5.0 * 60.0 * 1000.0;
/// `FETCH_TIMEOUT_MS` (`AbortSignal.timeout`).
pub const FETCH_TIMEOUT_MS: u64 = 8_000;
/// What `fetch` rejects with when `AbortSignal.timeout` fires (node 22's
/// `DOMException` `TimeoutError`).
pub const TIMEOUT_MESSAGE: &str = "The operation was aborted due to timeout";
/// `ToPrimitive` on a JSON object that shadows `toString`.
pub const CANNOT_CONVERT: &str = "Cannot convert object to primitive value";

// ---- lib/shared/release-changelog.ts -------------------------------------------

/// `RELEASE_TAG_RE.test(tag)`: `v` + three or four parts of 1 to 4 ASCII
/// digits (`$` is the end of the input: a trailing newline fails).
pub fn is_release_tag(tag: &str) -> bool {
    let Some(rest) = tag.strip_prefix('v') else {
        return false;
    };
    let parts: Vec<&str> = rest.split('.').collect();
    (3..=4).contains(&parts.len())
        && parts
            .iter()
            .all(|p| (1..=4).contains(&p.len()) && p.bytes().all(|b| b.is_ascii_digit()))
}

/// `toReleaseTag(version)`: `v`-prefixed unless it already starts with `v`,
/// then checked.
pub fn to_release_tag(version: &str) -> Option<String> {
    let tag = if version.starts_with('v') {
        version.to_owned()
    } else {
        format!("v{version}")
    };
    is_release_tag(&tag).then_some(tag)
}

/// `TYPE_TO_GROUP[type]`. `Proto` is a member `Object.prototype` answers
/// for a lower-case type (`constructor`, `__proto__`): truthy, so the
/// commit is classified, but no group of the changelog is it.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Group {
    Feat,
    Fix,
    Improve,
    Proto,
}

impl Group {
    fn of(ty: &str) -> Option<Group> {
        match ty {
            "feat" => Some(Group::Feat),
            "fix" => Some(Group::Fix),
            "perf" | "refactor" => Some(Group::Improve),
            "constructor" | "__proto__" => Some(Group::Proto),
            _ => None,
        }
    }

    /// The group's `key` (`None` for [`Group::Proto`]).
    pub fn key(self) -> Option<&'static str> {
        match self {
            Group::Feat => Some("feat"),
            Group::Fix => Some("fix"),
            Group::Improve => Some("improve"),
            Group::Proto => None,
        }
    }

    fn title(self) -> &'static str {
        match self {
            Group::Feat => "New",
            Group::Fix => "Fixes",
            Group::Improve => "Improvements",
            Group::Proto => "",
        }
    }
}

/// `GROUP_ORDER`.
const GROUP_ORDER: [Group; 3] = [Group::Feat, Group::Fix, Group::Improve];

/// `INTERNAL_SCOPES`: scopes naming the release machinery, not the app.
const INTERNAL_SCOPES: [&str; 7] = [
    "ci",
    "e2e",
    "release",
    "releases",
    "test",
    "tests",
    "update-pipeline",
];

/// A `ChangelogEntry`. `sha` is whatever `sha.slice(0, 8)` gave: a string,
/// or (for an array `sha`) an array.
#[derive(Clone, Debug, PartialEq)]
pub struct Entry {
    pub scope: Option<String>,
    pub text: String,
    pub sha: Value,
}

impl Entry {
    pub fn to_json(&self) -> Value {
        let mut m = Map::new();
        m.insert(
            "scope".into(),
            self.scope.clone().map_or(Value::Null, Value::String),
        );
        m.insert("text".into(), Value::String(self.text.clone()));
        m.insert("sha".into(), self.sha.clone());
        Value::Object(m)
    }
}

/// A line terminator: what `.` doesn't match.
fn is_line_terminator(c: char) -> bool {
    matches!(c, '\n' | '\r' | '\u{2028}' | '\u{2029}')
}

/// `CONVENTIONAL_RE.exec(subject)` = `/^(\w+)(?:\(([^)]*)\))?!?:\s*(.+)$/`:
/// the type, the scope and the subject text. The pattern leaves no choice
/// to backtracking: `\w+` has to be all the leading word characters, the
/// scope runs to the first `)`, and `(.+)$` is what follows the colon's
/// whitespace, which mustn't hold a line terminator (`.` won't cross one).
fn conventional(s: &str) -> Option<(&str, Option<&str>, &str)> {
    let word = s
        .bytes()
        .take_while(|b| b.is_ascii_alphanumeric() || *b == b'_')
        .count();
    if word == 0 {
        return None;
    }
    let (ty, mut rest) = s.split_at(word);
    let mut scope = None;
    if let Some(r) = rest.strip_prefix('(') {
        let close = r.find(')')?;
        scope = Some(&r[..close]);
        rest = &r[close + 1..];
    }
    let rest = rest.strip_prefix('!').unwrap_or(rest);
    let rest = rest.strip_prefix(':')?;
    let text = rest.trim_start_matches(js::is_whitespace);
    (!text.is_empty() && !text.contains(is_line_terminator)).then_some((ty, scope, text))
}

/// Whether `PARITY_SUFFIX_RE` (`/\s*\(CC \d+(?:\.\d+)*(?: [a-z ]+)?\)\s*$/i`)
/// matches from byte `at`. Without the `u` flag, `i` folds ASCII letters
/// only.
fn parity_suffix_at(s: &str, at: usize) -> bool {
    let rest = s[at..].trim_start_matches(js::is_whitespace);
    let Some(r) = rest.strip_prefix('(') else {
        return false;
    };
    let b = r.as_bytes();
    if b.len() < 3 || !b[0].eq_ignore_ascii_case(&b'c') || !b[1].eq_ignore_ascii_case(&b'c') {
        return false;
    }
    if b[2] != b' ' {
        return false;
    }
    let digits = |from: usize| {
        b[from.min(b.len())..]
            .iter()
            .take_while(|c| c.is_ascii_digit())
            .count()
    };
    let mut j = 3;
    let d = digits(j);
    if d == 0 {
        return false;
    }
    j += d;
    while b.get(j) == Some(&b'.') && digits(j + 1) > 0 {
        j += 1 + digits(j + 1);
    }
    if b.get(j) == Some(&b' ') {
        let words = b[j + 1..]
            .iter()
            .take_while(|c| c.is_ascii_alphabetic() || **c == b' ')
            .count();
        if words == 0 {
            return false;
        }
        j += 1 + words;
    }
    if b.get(j) != Some(&b')') {
        return false;
    }
    r[j + 1..].chars().all(js::is_whitespace)
}

/// `text.replace(PARITY_SUFFIX_RE, "")`: cut at the leftmost match.
fn strip_parity_suffix(s: &str) -> &str {
    s.char_indices()
        .map(|(i, _)| i)
        .find(|&i| parity_suffix_at(s, i))
        .map_or(s, |i| &s[..i])
}

/// `text[0].toUpperCase() + text.slice(1)`: the first UTF-16 unit, so an
/// astral character (whose first unit is a lone high surrogate, which has no
/// case) stays as it is.
fn upper_first(text: &str) -> String {
    let mut chars = text.chars();
    let Some(first) = chars.next() else {
        return String::new();
    };
    if first.len_utf16() != 1 || js_string::lone_unit(first).is_some() {
        return text.to_owned();
    }
    let mut out: String = first.to_uppercase().collect();
    out.push_str(chars.as_str());
    out
}

/// `sha.slice(0, 8)` on a JS value (`None` is `undefined`).
fn slice_sha(sha: Option<&Value>) -> Result<Value, String> {
    match sha {
        None => Err("Cannot read properties of undefined (reading 'slice')".into()),
        Some(Value::Null) => Err("Cannot read properties of null (reading 'slice')".into()),
        Some(Value::String(s)) => {
            let u = js_string::units(s);
            Ok(Value::String(js_string::from_units(&u[..u.len().min(8)])))
        }
        Some(Value::Array(a)) => Ok(Value::Array(a[..a.len().min(8)].to_vec())),
        Some(_) => Err("sha.slice is not a function".into()),
    }
}

/// `classifyCommit(message, sha)`: `Ok(None)` for the internal changes the
/// changelog hides, `Err` for what throws (a `message` that isn't a string,
/// a `sha` without `slice`).
pub fn classify_commit(
    message: &Value,
    sha: Option<&Value>,
) -> Result<Option<(Group, Entry)>, String> {
    let Value::String(message) = message else {
        return Err("message.split is not a function".into());
    };
    let first_line = message.split('\n').next().unwrap_or_default();
    let subject = js::trim(first_line);
    let Some((ty, scope, rest)) = conventional(subject) else {
        return Ok(None);
    };
    let Some(group) = Group::of(&ty.to_ascii_lowercase()) else {
        return Ok(None);
    };
    let scope = scope.map(js::trim).filter(|s| !s.is_empty());
    if let Some(s) = scope
        && INTERNAL_SCOPES.contains(&js_string::to_lower(s).as_str())
    {
        return Ok(None);
    }
    let text = js::trim(strip_parity_suffix(rest));
    if text.is_empty() {
        return Ok(None);
    }
    let entry = Entry {
        scope: scope.map(str::to_owned),
        text: upper_first(text),
        sha: slice_sha(sha)?,
    };
    Ok(Some((group, entry)))
}

/// One commit as `buildReleaseChangelog` gets it: `sha` (`None` is
/// `undefined`) and `message`, both as the compare API had them.
#[derive(Clone, Debug)]
pub struct Commit {
    pub sha: Option<Value>,
    pub message: Value,
}

/// `buildReleaseChangelog({from, to, commits, compareUrl})`: newest first,
/// one entry per group, scope and lower-cased text.
pub fn build_release_changelog(
    from: &str,
    to: &str,
    commits: &[Commit],
    compare_url: &Value,
) -> Result<Value, String> {
    let mut buckets: HashMap<Group, Vec<Entry>> = HashMap::new();
    let mut seen: HashSet<String> = HashSet::new();
    for c in commits.iter().rev() {
        let Some((group, entry)) = classify_commit(&c.message, c.sha.as_ref())? else {
            continue;
        };
        // One string, as the TS builds it (a `:` in the scope can collide).
        let key = format!(
            "{}:{}:{}",
            group.key().unwrap_or("<proto>"),
            entry.scope.as_deref().unwrap_or_default(),
            js_string::to_lower(&entry.text),
        );
        if !seen.insert(key) {
            continue;
        }
        buckets.entry(group).or_default().push(entry);
    }
    let groups: Vec<Value> = GROUP_ORDER
        .iter()
        .filter_map(|g| {
            let entries = buckets.get(g)?;
            let mut m = Map::new();
            m.insert("key".into(), Value::String(g.key()?.into()));
            m.insert("title".into(), Value::String(g.title().into()));
            m.insert(
                "entries".into(),
                Value::Array(entries.iter().map(Entry::to_json).collect()),
            );
            Some(Value::Object(m))
        })
        .collect();
    let mut m = Map::new();
    m.insert("from".into(), Value::String(from.into()));
    m.insert("to".into(), Value::String(to.into()));
    m.insert("total".into(), js_num(commits.len() as f64));
    m.insert("groups".into(), Value::Array(groups));
    m.insert("compareUrl".into(), compare_url.clone());
    Ok(Value::Object(m))
}

// ---- lib/server/updater/release-changelog.ts -------------------------------------

/// `(c.parents?.length ?? 1) <= 1`, the merge-commit filter.
fn single_parent(c: &Value) -> Result<bool, String> {
    let parents = match c {
        Value::Null => return Err("Cannot read properties of null (reading 'parents')".into()),
        Value::Object(m) => m.get("parents"),
        _ => None,
    };
    let length = match parents {
        None | Some(Value::Null) => return Ok(true),
        Some(Value::String(s)) => return Ok(js_string::len16(s) <= 1),
        Some(Value::Array(a)) => return Ok(a.len() <= 1),
        Some(Value::Object(p)) => p.get("length"),
        Some(_) => None,
    };
    match length {
        None | Some(Value::Null) => Ok(true),
        // `v <= 1` against a number compares numbers (NaN: false).
        Some(v) => js_string::to_js_number(Some(v))
            .map(|n| n <= 1.0)
            .map_err(|_| CANNOT_CONVERT.to_owned()),
    }
}

/// The commits of a compare body (`(body.commits ?? []).filter(...).map(...)`).
fn compare_commits(body: &Value) -> Result<Vec<Commit>, String> {
    let commits = match body {
        Value::Null => return Err("Cannot read properties of null (reading 'commits')".into()),
        Value::Object(m) => m.get("commits"),
        _ => None,
    };
    let list: &[Value] = match commits {
        None | Some(Value::Null) => &[],
        Some(Value::Array(a)) => a,
        Some(_) => return Err("(body.commits ?? []).filter is not a function".into()),
    };
    let mut kept = Vec::new();
    for c in list {
        if single_parent(c)? {
            kept.push(c);
        }
    }
    Ok(kept
        .into_iter()
        .map(|c| {
            let Value::Object(m) = c else {
                return Commit {
                    sha: None,
                    message: Value::String(String::new()),
                };
            };
            // `c.commit?.message ?? ""`.
            let message = match m.get("commit") {
                Some(Value::Object(cm)) => match cm.get("message") {
                    None | Some(Value::Null) => Value::String(String::new()),
                    Some(v) => v.clone(),
                },
                _ => Value::String(String::new()),
            };
            Commit {
                sha: m.get("sha").cloned(),
                message,
            }
        })
        .collect())
}

enum CacheEntry {
    Ok(Value),
    Failed { at: f64, error: String },
}

/// `getReleaseChangelog`'s module state: one entry per `from...to` pair.
#[derive(Default)]
pub struct ChangelogCache {
    entries: Mutex<HashMap<String, CacheEntry>>,
}

impl ChangelogCache {
    pub fn new() -> ChangelogCache {
        ChangelogCache::default()
    }

    /// `getReleaseChangelog(from, to)` over `fetch`, with `now` as
    /// `Date.now`: the changelog, or the error the route answers 502 with.
    pub async fn get(
        &self,
        fetch: &dyn Fetch,
        from: &str,
        to: &str,
        now: &(dyn Fn() -> f64 + Send + Sync),
    ) -> Result<Value, String> {
        if !is_release_tag(from) || !is_release_tag(to) {
            return Err("invalid release tag".into());
        }
        let key = format!("{from}...{to}");
        {
            let entries = self.entries.lock().expect("changelog cache");
            match entries.get(&key) {
                Some(CacheEntry::Ok(v)) => return Ok(v.clone()),
                Some(CacheEntry::Failed { at, error }) if now() - at < FAILURE_TTL_MS => {
                    return Err(error.clone());
                }
                _ => {}
            }
        }
        let result = fetch_changelog(fetch, from, to, &key).await;
        let mut entries = self.entries.lock().expect("changelog cache");
        match &result {
            Ok(v) => entries.insert(key, CacheEntry::Ok(v.clone())),
            Err(error) => entries.insert(
                key,
                CacheEntry::Failed {
                    at: now(),
                    error: error.clone(),
                },
            ),
        };
        result
    }
}

/// The `try` block: fetch the range and build its changelog.
async fn fetch_changelog(
    fetch: &dyn Fetch,
    from: &str,
    to: &str,
    key: &str,
) -> Result<Value, String> {
    let fallback_url = format!("https://github.com/{OWNER}/{REPO}/compare/{key}");
    let req = Request {
        method: "GET".into(),
        url: format!("https://api.github.com/repos/{OWNER}/{REPO}/compare/{key}"),
        headers: vec![
            ("Accept".into(), "application/vnd.github+json".into()),
            ("User-Agent".into(), "claudius-updater".into()),
            ("X-GitHub-Api-Version".into(), "2022-11-28".into()),
            // What `cache: "no-store"` adds to the request.
            ("pragma".into(), "no-cache".into()),
            ("cache-control".into(), "no-cache".into()),
        ],
        body: None,
    };
    // `AbortSignal.timeout` covers the body as well as the headers.
    let res = tokio::time::timeout(Duration::from_millis(FETCH_TIMEOUT_MS), fetch.fetch(&req))
        .await
        .map_err(|_| TIMEOUT_MESSAGE.to_owned())?
        .map_err(|e| e.message)?;
    if !res.ok() {
        return Err(format!("GitHub compare returned {}", res.status));
    }
    let body = js_string::parse(&res.text()?)?;
    let commits = compare_commits(&body)?;
    let compare_url = match &body {
        Value::Object(m) => match m.get("html_url") {
            None | Some(Value::Null) => Value::String(fallback_url),
            Some(v) => v.clone(),
        },
        _ => Value::String(fallback_url),
    };
    build_release_changelog(from, to, &commits, &compare_url)
}
