//! `lib/server/commit-drafts.ts`: the per-workspace commit-message draft
//! behind `GET/POST/DELETE /api/workspaces/:id/git/commit-draft` (D08).
//!
//! One `commit_drafts` row (migration 004) per cwd, in the cwd's own
//! `.claudius.db`. The read opens the database read-only, and any open
//! failure (no file yet, a project dir that can't be made) is no draft;
//! the query itself isn't caught, so a database without the table throws.
//! The writes open it read-write (creating and migrating it) and throw on
//! any failure, as the TS does (the routes answer Next's empty 500).
//!
//! The message is read as better-sqlite3 hands it to JS ([`Cell`]: a
//! foreign row's number or BLOB reaches the response as `JSON.stringify`
//! writes it, a NULL as `null`, invalid UTF-8 as U+FFFDs), and stored
//! JS-trimmed. Strings are bound as better-sqlite3 binds JS strings
//! ([`JsText`]): a lone surrogate (a [`crate::js_string`] stand-in) goes
//! in as its own 3-byte sequence, which reads back as three U+FFFDs, as in
//! TS. `updated_at` is `Date.now()` bound as better-sqlite3 binds a JS
//! number (a REAL, which the column's INTEGER affinity stores as an
//! integer).

use claudius_agent::js;
use rusqlite::OptionalExtension;
use serde_json::Value;

use crate::asset_list::Cell;
use crate::db::{Mode, open_db, sqlite_message};
use crate::sql_text::JsText;

/// `getCommitDraft(cwd)`: the draft as JSON (`null` for none). `Err` is
/// what the TS throws (the query failing), with better-sqlite3's message.
pub fn get_commit_draft(cwd: &str) -> Result<Value, String> {
    let Ok(db) = open_db(cwd, Mode::ReadOnly) else {
        return Ok(Value::Null);
    };
    let row = db
        .with(|c| {
            c.query_row(
                "SELECT message FROM commit_drafts WHERE cwd = ?",
                [JsText::new(cwd)],
                |r| Ok(Cell::read(r.get_ref(0)?)),
            )
            .optional()
        })
        .map_err(|e| sqlite_message(&e))?;
    // `row?.message ?? null`.
    Ok(row.map_or(Value::Null, |cell| cell.to_json()))
}

/// `setCommitDraft(cwd, message)`: upsert the JS-trimmed message, or delete
/// the row when it trims to nothing. `message` may hold [`crate::js_string`]
/// stand-ins.
pub fn set_commit_draft(cwd: &str, message: &str) -> Result<(), String> {
    let db = open_db(cwd, Mode::ReadWrite).map_err(|e| e.to_string())?;
    let trimmed = js::trim(message);
    db.with(|c| {
        if trimmed.is_empty() {
            c.execute(
                "DELETE FROM commit_drafts WHERE cwd = ?",
                [JsText::new(cwd)],
            )?;
            return Ok(());
        }
        c.execute(
            "INSERT INTO commit_drafts(cwd, message, updated_at)
     VALUES (?, ?, ?)
     ON CONFLICT(cwd) DO UPDATE SET
       message    = excluded.message,
       updated_at = excluded.updated_at",
            rusqlite::params![
                JsText::new(cwd),
                JsText::new(trimmed),
                crate::now_ms() as f64
            ],
        )?;
        Ok(())
    })
    .map_err(|e| sqlite_message(&e))
}

/// `clearCommitDraft(cwd)`.
pub fn clear_commit_draft(cwd: &str) -> Result<(), String> {
    let db = open_db(cwd, Mode::ReadWrite).map_err(|e| e.to_string())?;
    db.with(|c| {
        c.execute(
            "DELETE FROM commit_drafts WHERE cwd = ?",
            [JsText::new(cwd)],
        )
    })
    .map(|_| ())
    .map_err(|e| sqlite_message(&e))
}
