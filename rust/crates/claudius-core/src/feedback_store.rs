//! `lib/server/feedback-store.ts`: the local copy of each feedback-survey
//! submission, in the `feedback` table of the session cwd's `.claudius.db`
//! (migrations 008 and 015). `POST /api/feedback` writes a row whether or
//! not the forward to Anthropic landed; `GET /api/feedback` lists them.
//!
//! As in TS, values are bound the way better-sqlite3 binds them (every
//! number a REAL; the INTEGER columns store an integral one as an INTEGER)
//! and read the way it hands them to JS ([`Cell`]), so a row another writer
//! filled with foreign values, or a table it created with other column
//! types, reads back as it does in TS.

use serde_json::{Map, Value, json};

use crate::db::{Mode, open_db, sqlite_message};
use crate::js_params;
use crate::notifications_db::Cell;

/// `FeedbackRecord` as `insertFeedback` binds it.
#[derive(Clone, Debug)]
pub struct FeedbackRecord {
    pub id: String,
    pub session_id: Option<String>,
    /// `"up"` / `"down"`, or none.
    pub rating: Option<String>,
    pub comment: String,
    pub surface: Option<String>,
    pub forwarded: bool,
    pub attach_transcript: bool,
    /// `Date.now()`.
    pub created_at: f64,
}

const INSERT: &str = "INSERT INTO feedback(id, session_id, cwd, rating, comment, surface, forwarded, attach_transcript, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)";

const SELECT: &str =
    "SELECT id, session_id, rating, comment, surface, forwarded, attach_transcript, created_at
         FROM feedback
        ORDER BY created_at DESC
        LIMIT ?";

/// `insertFeedback(cwd, record)`. A database that can't be opened stores
/// nothing and is no error (`openDb(cwd).catch(() => null)`); a failing
/// statement (no `feedback` table, a constraint) is the `Err`, with
/// better-sqlite3's message.
pub fn insert_feedback(cwd: &str, record: &FeedbackRecord) -> anyhow::Result<()> {
    let Ok(db) = open_db(cwd, Mode::ReadWrite) else {
        return Ok(());
    };
    let flag = |b: bool| f64::from(u8::from(b));
    db.with(|c| {
        c.execute(
            INSERT,
            js_params![
                record.id,
                record.session_id,
                cwd,
                record.rating,
                record.comment,
                record.surface,
                flag(record.forwarded),
                flag(record.attach_transcript),
                record.created_at,
            ],
        )
    })
    .map(|_| ())
    .map_err(|e| anyhow::anyhow!(sqlite_message(&e)))
}

/// `listFeedback(cwd, limit)`: the newest `limit` rows, as `rowToRecord`
/// makes them (`JSON.stringify`'s view, in its key order). Read-only; a
/// database that can't be opened (none yet) lists nothing. `limit` is bound
/// as the JS number it is, so a fractional one fails the statement
/// (`datatype mismatch`), as in TS.
pub fn list_feedback(cwd: &str, limit: f64) -> anyhow::Result<Vec<Value>> {
    let Ok(db) = open_db(cwd, Mode::ReadOnly) else {
        return Ok(vec![]);
    };
    db.with(|c| {
        let mut st = c.prepare(SELECT)?;
        let rows = st.query_map(js_params![limit], |r| {
            let cells = (0..8)
                .map(|i| r.get_ref(i).map(Cell::read))
                .collect::<rusqlite::Result<Vec<Cell>>>()?;
            Ok(row_to_record(&cells))
        })?;
        rows.collect::<rusqlite::Result<Vec<Value>>>()
    })
    .map_err(|e| anyhow::anyhow!(sqlite_message(&e)))
}

/// `rowToRecord(row)` over the `SELECT`'s eight cells.
fn row_to_record(c: &[Cell]) -> Value {
    let is_one = |cell: &Cell| matches!(cell, Cell::Number(n) if *n == 1.0);
    let mut m = Map::new();
    m.insert("id".into(), c[0].to_json());
    m.insert("sessionId".into(), c[1].to_json());
    // `row.rating ?? null`
    m.insert("rating".into(), c[2].to_json());
    // `row.comment ?? ""`
    let comment = match &c[3] {
        Cell::Null => json!(""),
        cell => cell.to_json(),
    };
    m.insert("comment".into(), comment);
    m.insert("surface".into(), c[4].to_json());
    // `=== 1`: a REAL 1.0 counts, TEXT '1' doesn't.
    m.insert("forwarded".into(), json!(is_one(&c[5])));
    m.insert("attachTranscript".into(), json!(is_one(&c[6])));
    m.insert("createdAt".into(), c[7].to_json());
    Value::Object(m)
}
