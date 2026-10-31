//! Per-project SQLite (`~/.claude/projects/<enc>/.claudius.db`), port of
//! `lib/server/db.ts`. Same file, same `schema_meta.version` bookkeeping and
//! the same embedded migrations, so the TS and Rust backends can open the
//! same database interchangeably.

use std::collections::HashMap;
use std::path::Path;
use std::sync::{Arc, Mutex, OnceLock};

use claudius_agent::js;
use rusqlite::types::ValueRef;
use rusqlite::{Connection, OpenFlags, OptionalExtension, params};

include!(concat!(env!("OUT_DIR"), "/migrations.rs"));

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Mode {
    ReadWrite,
    ReadOnly,
}

/// A shared connection. better-sqlite3 is synchronous too; keep queries short.
pub struct Db {
    conn: Mutex<Connection>,
}

impl Db {
    pub fn with<R>(
        &self,
        f: impl FnOnce(&Connection) -> rusqlite::Result<R>,
    ) -> rusqlite::Result<R> {
        let conn = self.conn.lock().unwrap();
        f(&conn)
    }

    pub fn with_mut<R>(
        &self,
        f: impl FnOnce(&mut Connection) -> rusqlite::Result<R>,
    ) -> rusqlite::Result<R> {
        let mut conn = self.conn.lock().unwrap();
        f(&mut conn)
    }
}

type HandleCache = Mutex<HashMap<(Mode, String), Arc<Db>>>;

fn handles() -> &'static HandleCache {
    static H: OnceLock<HandleCache> = OnceLock::new();
    H.get_or_init(Default::default)
}

pub fn latest_version() -> u32 {
    MIGRATIONS.last().map(|(id, _)| *id).unwrap_or(0)
}

/// `Number(v)` of a value as better-sqlite3 hands it to JS: `null` is 0, a
/// BLOB (a `Buffer`) reads as its UTF-8 text.
fn js_number(v: ValueRef) -> f64 {
    match v {
        ValueRef::Null => 0.0,
        ValueRef::Integer(i) => i as f64,
        ValueRef::Real(f) => f,
        ValueRef::Text(t) | ValueRef::Blob(t) => js::to_number(&String::from_utf8_lossy(t)),
    }
}

pub fn apply_migrations(conn: &mut Connection) -> rusqlite::Result<()> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS schema_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);",
    )?;
    // `row ? Number(row.value) : 0`: ` 24 `, `24.0`, `0x18` and `Infinity`
    // count as up to date; NaN (`abc`) runs every migration.
    let current: f64 = conn
        .query_row(
            "SELECT value FROM schema_meta WHERE key = ?",
            ["version"],
            |r| Ok(js_number(r.get_ref(0)?)),
        )
        .optional()?
        .unwrap_or(0.0);
    let last = latest_version();
    let up_to_date = current >= f64::from(last);
    if !up_to_date {
        let tx = conn.transaction()?;
        for (id, sql) in MIGRATIONS {
            if f64::from(*id) <= current {
                continue;
            }
            tx.execute_batch(sql)?;
        }
        tx.execute(
            "INSERT INTO schema_meta(key, value) VALUES('version', ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
            [last.to_string()],
        )?;
        tx.commit()?;
    }
    apply_post_migration_cleanups(conn)
}

/// One-shot data fixups gated by `schema_meta` flags (see db.ts).
fn apply_post_migration_cleanups(conn: &Connection) -> rusqlite::Result<()> {
    // `flagged?.value === "1"`: only the text `1`.
    let flagged = conn
        .query_row(
            "SELECT value FROM schema_meta WHERE key = ?",
            ["notifications_abort_cleanup_v1"],
            |r| Ok(matches!(r.get_ref(0)?, ValueRef::Text(b"1"))),
        )
        .optional()?;
    if flagged == Some(true) {
        return Ok(());
    }
    let has_table: Option<String> = conn
        .query_row(
            "SELECT name FROM sqlite_master WHERE type='table' AND name='notifications'",
            [],
            |r| r.get(0),
        )
        .optional()?;
    if has_table.is_some() {
        conn.execute(
            "UPDATE notifications SET read_at = ?
               WHERE read_at IS NULL
                 AND kind = 'session_error'
                 AND body = 'Claude Code process aborted by user'",
            params![crate::now_ms()],
        )?;
    }
    conn.execute(
        "INSERT INTO schema_meta(key, value) VALUES('notifications_abort_cleanup_v1', '1') ON CONFLICT(key) DO UPDATE SET value='1'",
        [],
    )?;
    Ok(())
}

/// Open the DB at an explicit path: `openDb`'s steps after the cache. An
/// error reads as the one `openDb` rejects with: Node's `mkdir` message
/// (`EACCES: permission denied, mkdir '…'`) or SQLite's own, as
/// better-sqlite3 reports it ([`sqlite_message`]).
pub fn open_path(path: &Path, mode: Mode) -> anyhow::Result<Connection> {
    if let Some(dir) = path.parent() {
        // `fs.mkdir(dirname(path), { recursive: true })`.
        crate::node_fs::mkdir_recursive(&dir.to_string_lossy(), 0o777)
            .map_err(|e| anyhow::anyhow!(e.message))?;
    }
    open_conn(path, mode).map_err(|e| {
        let message = sqlite_message(&e);
        // rusqlite names the file after SQLite's "unable to open database file".
        let suffix = format!(": {}", path.to_string_lossy());
        anyhow::anyhow!(
            message
                .strip_suffix(&suffix)
                .map_or_else(|| message.clone(), str::to_owned)
        )
    })
}

fn open_conn(path: &Path, mode: Mode) -> rusqlite::Result<Connection> {
    let mut conn = match mode {
        Mode::ReadOnly => Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY)?,
        Mode::ReadWrite => Connection::open(path)?,
    };
    conn.pragma_update(None, "journal_mode", "WAL")?;
    conn.pragma_update(None, "foreign_keys", "ON")?;
    conn.busy_timeout(std::time::Duration::from_secs(5))?;
    if mode == Mode::ReadWrite {
        apply_migrations(&mut conn)?;
    }
    Ok(conn)
}

/// The `message` better-sqlite3 throws for a failed call: SQLite's
/// `sqlite3_errmsg` (`no such table: ui_state`), without the SQL and offset
/// rusqlite adds to a syntax error.
pub fn sqlite_message(e: &rusqlite::Error) -> String {
    match e {
        rusqlite::Error::SqlInputError { msg, .. } => msg.clone(),
        other => other.to_string(),
    }
}

/// `openDb(cwd, mode)` — cached per (mode, cwd).
pub fn open_db(cwd: &str, mode: Mode) -> anyhow::Result<Arc<Db>> {
    let key = (mode, cwd.to_owned());
    if let Some(db) = handles().lock().unwrap().get(&key) {
        return Ok(db.clone());
    }
    // One first open at a time. Two threads that both missed the cache would
    // otherwise both open and migrate the file: the loser's open can fail
    // outright ("database is locked" on the WAL pragma, "duplicate column"
    // from migrating twice) or leave it a second writer of its own, whose
    // deferred transactions can fail with SQLITE_BUSY. TS's one thread runs
    // each open and transaction to the end, so they never interleave.
    static OPENING: Mutex<()> = Mutex::new(());
    let _opening = OPENING.lock().unwrap_or_else(|e| e.into_inner());
    if let Some(db) = handles().lock().unwrap().get(&key) {
        return Ok(db.clone());
    }
    let conn = open_path(&crate::paths::db_path(cwd), mode)?;
    let db = Arc::new(Db {
        conn: Mutex::new(conn),
    });
    handles().lock().unwrap().insert(key, db.clone());
    Ok(db)
}

/// `getCachedDb(cwd, mode)`: the connection [`open_db`] cached for (mode,
/// cwd), without opening one. The notification bus's synchronous state
/// flush reads through it.
pub fn cached_db(cwd: &str, mode: Mode) -> Option<Arc<Db>> {
    handles()
        .lock()
        .unwrap()
        .get(&(mode, cwd.to_owned()))
        .cloned()
}

pub fn close_db(cwd: &str) {
    let mut h = handles().lock().unwrap();
    h.remove(&(Mode::ReadWrite, cwd.to_owned()));
    h.remove(&(Mode::ReadOnly, cwd.to_owned()));
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn migrations_are_embedded_and_apply() {
        assert!(
            MIGRATIONS.len() >= 24,
            "expected the TS migrations to be embedded"
        );
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("t.db");
        let conn = open_path(&path, Mode::ReadWrite).unwrap();
        let v: String = conn
            .query_row(
                "SELECT value FROM schema_meta WHERE key='version'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(v, latest_version().to_string());
        // A table from a late migration exists.
        let n: i64 = conn
            .query_row(
                "SELECT count(*) FROM sqlite_master WHERE type='table' AND name='queued_messages'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(n, 1);
        drop(conn);
        // Re-open is idempotent.
        open_path(&path, Mode::ReadWrite).unwrap();
    }

    /// better-sqlite3's message, without the path rusqlite appends.
    #[test]
    fn open_failures_carry_sqlites_message() {
        let dir = tempfile::tempdir().unwrap();
        let missing = dir.path().join("missing.db");
        let e = open_path(&missing, Mode::ReadOnly).err().unwrap();
        assert_eq!(e.to_string(), "unable to open database file");
        let e = open_path(dir.path(), Mode::ReadWrite).err().unwrap();
        assert_eq!(e.to_string(), "unable to open database file");
    }
}
