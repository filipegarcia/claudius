//! The `<system-reminder>` channels (`lib/server/system-reminders.ts`), the
//! linter-modified-file reminder (session.ts `postWriteSnapshots`, the
//! `PostToolUse` hook's capture, `flushLinterModifiedReminder` and
//! `linterModifiedReminderBody`) and the date-change body
//! (`localDateKey` / `dateChangeReminderBody`). Replayed against the TS,
//! `tests/reminders_golden.rs`.
//!
//! The session owns two [`ReminderQueue`]s: the next-turn one, prepended to
//! the next user message after the `!` output and the goal, and the mid-turn
//! one, drained by the `PreToolUse` hook into `additionalContext`. TS tags
//! each entry with a `kind`, but only for debugging: it's never on the tag,
//! never deduped and never read outside its test-only counters, so it isn't
//! kept here.

use chrono::{Datelike, NaiveDate};
use indexmap::IndexMap;
use serde_json::Value;
use sha2::{Digest, Sha256};

/// `wrapReminder`: the canonical block, with the trailing blank line that
/// keeps concatenated blocks (and the user's text) apart.
pub fn wrap_reminder(body: &str) -> String {
    format!("<system-reminder>\n{body}\n</system-reminder>\n\n")
}

/// One reminder channel: `queueReminder` / `takePendingReminders`, or
/// `queueMidTurnReminder` / `takeMidTurnReminders`. First in, first out,
/// with no dedupe.
#[derive(Debug, Default)]
pub struct ReminderQueue(Vec<String>);

impl ReminderQueue {
    /// Wrap `body` and append it.
    pub fn push(&mut self, body: &str) {
        self.0.push(wrap_reminder(body));
    }

    /// Every queued block, joined, and the queue emptied; `None` (TS
    /// `null`) when nothing is queued.
    pub fn take(&mut self) -> Option<String> {
        if self.0.is_empty() {
            return None;
        }
        Some(std::mem::take(&mut self.0).concat())
    }

    /// `pendingReminderCount` / `midTurnReminderCount`.
    pub fn len(&self) -> usize {
        self.0.len()
    }

    pub fn is_empty(&self) -> bool {
        self.0.is_empty()
    }
}

// ─────────────────────────── linter-modified-file ───────────────────────────

/// The tools whose target the `PostToolUse` hook snapshots.
pub const POST_WRITE_TOOLS: [&str; 4] = ["Edit", "Write", "MultiEdit", "NotebookEdit"];

/// The path the `PostToolUse` hook snapshots for this hook input: for one of
/// [`POST_WRITE_TOOLS`], a string `tool_input.file_path`, else a string
/// `notebook_path`; `None` when that's empty or there's neither. (A string
/// `file_path` wins even when empty, as TS's `typeof` chain does.)
pub fn post_write_target(input: &Value) -> Option<&str> {
    let tool = input.get("tool_name").and_then(Value::as_str)?;
    if !POST_WRITE_TOOLS.contains(&tool) {
        return None;
    }
    let ti = input.get("tool_input")?;
    ti.get("file_path")
        .and_then(Value::as_str)
        .or_else(|| ti.get("notebook_path").and_then(Value::as_str))
        .filter(|t| !t.is_empty())
}

/// SHA-256 of `bytes`, lowercase hex (`digest("hex")`).
pub fn sha256_hex(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

/// The hash `flushLinterModifiedReminder` compares (`readFileSync`); `None`
/// when the file can't be read (gone, a directory, no permission).
pub fn file_sha256(path: &str) -> Option<String> {
    std::fs::read(path).ok().map(|b| sha256_hex(&b))
}

/// The hash the `PostToolUse` hook stores (`fsp.readFile`).
pub async fn file_sha256_async(path: &str) -> Option<String> {
    tokio::fs::read(path).await.ok().map(|b| sha256_hex(&b))
}

/// `postWriteSnapshots`: the hash of each written path right after the
/// write, in first-write order.
#[derive(Debug, Default)]
pub struct PostWriteSnapshots(IndexMap<String, String>);

impl PostWriteSnapshots {
    /// `postWriteSnapshots.set(path, hex)`: the last write wins, and a path
    /// written again keeps its place (JS `Map` order).
    pub fn record(&mut self, path: &str, hex: String) {
        self.0.insert(path.to_owned(), hex);
    }

    /// `flushLinterModifiedReminder`'s scan: re-hash every path in order,
    /// keep those whose bytes changed (an unreadable one is skipped), clear
    /// the map, and return the `linter-modified-file` body for them (`None`
    /// when none changed).
    pub fn flush(&mut self) -> Option<String> {
        let changed: Vec<String> = self
            .0
            .drain(..)
            .filter(|(path, prev)| file_sha256(path).is_some_and(|now| now != *prev))
            .map(|(path, _)| path)
            .collect();
        linter_modified_reminder_body(&changed)
    }
}

/// `linterModifiedReminderBody(paths)`: one paragraph per path, `None` for
/// none.
pub fn linter_modified_reminder_body<S: AsRef<str>>(paths: &[S]) -> Option<String> {
    if paths.is_empty() {
        return None;
    }
    let paragraphs: Vec<String> = paths
        .iter()
        .map(|p| {
            format!(
                "{} was modified, either by the user or by a linter. This change was intentional, \
                 so make sure to take it into account as you proceed (ie. don't revert it unless \
                 the user asks you to). Don't tell the user this, since they are already aware.",
                p.as_ref()
            )
        })
        .collect();
    Some(paragraphs.join("\n\n"))
}

// ──────────────────────────────── date-change ────────────────────────────────

/// `localDateKey(d)`: `YYYY-MM-DD` of the local calendar date (the year
/// unpadded, as `getFullYear()` prints it).
pub fn local_date_key(d: NaiveDate) -> String {
    format!("{}-{:02}-{:02}", d.year(), d.month(), d.day())
}

/// `Date.prototype.toDateString()` of a local date: `Tue Oct 27 2026` (the
/// year at least 4 digits, signed when negative).
pub fn to_date_string(d: NaiveDate) -> String {
    let y = d.year();
    let sign = if y < 0 { "-" } else { "" };
    format!("{} {sign}{:04}", d.format("%a %b %d"), y.unsigned_abs())
}

/// `dateChangeReminderBody(prevKey, now)` with `now`'s local date: `None`
/// on the same day.
pub fn date_change_reminder_body(prev_key: &str, today: NaiveDate) -> Option<String> {
    if local_date_key(today) == prev_key {
        return None;
    }
    Some(format!(
        "The date has changed. Today's date is now {}. DO NOT mention this to the user \
         explicitly because they are already aware.",
        to_date_string(today)
    ))
}
