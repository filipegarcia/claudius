//! `lib/server/workspace-relocate.ts`: carrying a workspace's sessions along
//! when its root folder moves (Workspace settings → Root folder; G09).
//!
//! Everything Claudius keeps about a root's sessions sits in
//! `homedir()/.claude/projects/<encodeProjectDir(root)>/` (the home dir, not
//! the CLI's config dir): `<id>.jsonl` transcripts, `<id>/` sidecars,
//! `assets/` and the per-workspace `.claudius.db`.
//! [`relocate_workspace_sessions`] moves them to the new root's folder:
//!
//! * each `<uuid>.jsonl` (case-insensitive) in `readdir` order: refused when
//!   the name already exists there (`lstat`), else `rename`d, its sidecar
//!   (any entry named `<id>`) moved after it, and the SDK's
//!   `{"type":"relocated",…}` stamp appended on a line of its own. A failure
//!   is reported per session (`failed`), and whatever already moved stays
//!   moved;
//! * then `assets/`. A directory that exists on both sides (a sidecar or
//!   `assets/`) is merged with Node's `fs.cp(…, {recursive, force: false,
//!   errorOnExist: false})` (existing files win; its `SystemError` wording
//!   included, ported here) and the source removed with `fs.rm(…,
//!   {recursive, force})` (Node's rimraf, [`node_fs::rm_recursive`]);
//! * then the database: the source is migrated, attached to the destination
//!   and copied in with `INSERT OR IGNORE` over the column intersection (a
//!   lone `INTEGER` primary key left out), every `cwd` column re-keyed, in
//!   one transaction with deferred foreign keys; the old file (and its
//!   `-wal` / `-shm`) is unlinked only when that commits. An assets or
//!   database failure lands in `dataError`;
//! * last, the emptied old folder is `rmdir`ed (anything left keeps it).
//!
//! Two roots that encode to the same folder (`/a/b-c`, `/a/b/c`) only get
//! the stamps and the re-key. Errors read as the TS ones: Node's fs messages
//! ([`node_fs::FsError`]), better-sqlite3's (`db::sqlite_message`), and the
//! `PathInjectionError`s of the containment checks, which sit right above
//! their fs calls where the TS has them (`startsWith(base + sep)` on
//! `path.resolve`d paths). Replayed against the TS in
//! `tests/workspace_relocate_golden.rs` and, through the route,
//! `claudius-server/tests/workspace_relocate.rs`.

use std::io::{self, Write};

use rusqlite::Connection;
use rusqlite::types::ValueRef;
use serde_json::{Map, Value, json};

use crate::asset_list::Cell;
pub use crate::auto_memory::Thrown;
use crate::db::{self, Mode};
use crate::node_fs::{self, FsError};
use crate::session_history;
use crate::sql_text::JsText;
use crate::{js_num, js_string, node_path, paths};

const DB_FILE: &str = ".claudius.db";

/// What a relocation did (`RelocateResult`).
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct RelocateResult {
    /// Transcripts moved into the new folder (and stamped).
    pub moved: u64,
    /// `(sessionId, error)` per transcript that didn't make it.
    pub failed: Vec<(String, String)>,
    /// Moving the assets or merging the database failed.
    pub data_error: Option<String>,
}

impl RelocateResult {
    /// The TS object, in its key order: `{moved, failed, dataError?}`.
    pub fn to_json(&self) -> Map<String, Value> {
        let mut m = Map::new();
        m.insert("moved".into(), json!(self.moved));
        m.insert(
            "failed".into(),
            Value::Array(
                self.failed
                    .iter()
                    .map(|(id, error)| json!({"sessionId": id, "error": error}))
                    .collect(),
            ),
        );
        if let Some(e) = &self.data_error {
            m.insert("dataError".into(), json!(e));
        }
        m
    }
}

/// A member of `listWorkspaceSessionIds`'s `Set`: a transcript name, or a
/// `sessions.id` cell as better-sqlite3 hands it to JS. Strings and numbers
/// dedupe by value (SameValueZero), `null` once; every BLOB is a new
/// `Buffer`, so it never dedupes.
#[derive(Clone, Debug, PartialEq)]
pub enum SessionKey {
    Str(String),
    Num(f64),
    Null,
    Blob(Vec<u8>),
}

impl SessionKey {
    /// `JSON.stringify` of the value (a `Buffer` as `{type, data}`).
    pub fn to_json(&self) -> Value {
        match self {
            SessionKey::Str(s) => json!(s),
            SessionKey::Num(n) => js_num(*n),
            SessionKey::Null => Value::Null,
            SessionKey::Blob(b) => json!({"type": "Buffer", "data": b}),
        }
    }

    fn of(cell: ValueRef) -> SessionKey {
        match cell {
            ValueRef::Null => SessionKey::Null,
            // better-sqlite3 reads every number as a JS double.
            ValueRef::Integer(i) => SessionKey::Num(i as f64),
            ValueRef::Real(f) => SessionKey::Num(f),
            ValueRef::Text(t) => SessionKey::Str(String::from_utf8_lossy(t).into_owned()),
            ValueRef::Blob(b) => SessionKey::Blob(b.to_vec()),
        }
    }
}

/// `Set.prototype.has`: a `Buffer` is a fresh object every read, so it is
/// never already in the set.
fn has(ids: &[SessionKey], key: &SessionKey) -> bool {
    match key {
        SessionKey::Blob(_) => false,
        SessionKey::Num(n) => ids
            .iter()
            .any(|k| matches!(k, SessionKey::Num(m) if m == n || (m.is_nan() && n.is_nan()))),
        _ => ids.contains(key),
    }
}

/// `Set.prototype.add`.
fn add(ids: &mut Vec<SessionKey>, key: SessionKey) {
    if !has(ids, &key) {
        ids.push(key);
    }
}

/// `projectsBase()`: `resolve(homedir(), ".claude", "projects")`.
pub fn projects_base() -> String {
    let home = paths::home_dir();
    node_path::resolve(&[&home.to_string_lossy(), ".claude", "projects"])
}

/// `SESSION_JSONL_RE` (`/^([0-9a-f]{8}-…-[0-9a-f]{12})\.jsonl$/i`): the id
/// (as written) of a transcript name.
pub fn session_id_of(name: &str) -> Option<&str> {
    let b = name.as_bytes();
    if b.len() != 42 || !b[36..].eq_ignore_ascii_case(b".jsonl") {
        return None;
    }
    let shape_ok = b[..36].iter().enumerate().all(|(i, c)| match i {
        8 | 13 | 18 | 23 => *c == b'-',
        _ => c.is_ascii_hexdigit(),
    });
    shape_ok.then(|| &name[..36])
}

fn is_enoent(e: &io::Error) -> bool {
    node_fs::code(e).as_deref() == Some("ENOENT")
}

/// `listWorkspaceSessionIds(root, opts)`: every transcript id in the root's
/// folder, then the `sessions` rows recorded for the root (read-only; a
/// database that can't be opened, has no such table or no `title` column
/// adds nothing). A missing folder is empty; any other `readdir` failure
/// throws.
///
/// With `is_live` (CC 2.1.309, the move-sessions preview) a row is counted
/// only when history shows it
/// ([`session_history::is_history_worthy_db_row`]); without it every row
/// counts, as the move carries the whole database anyway. Like the TS, a
/// row whose title has no `trim` (a number, a BLOB) ends the row loop
/// inside the same `catch` a pre-v2 database lands in, so the rows already
/// added stay.
pub fn list_workspace_session_ids(
    root: &str,
    is_live: Option<&dyn Fn(&str) -> bool>,
) -> Result<Vec<SessionKey>, Thrown> {
    let base = projects_base();
    let dir = node_path::resolve(&[&base, &paths::encode_project_dir(root)]);
    if !dir.starts_with(&format!("{base}/")) {
        return Err(Thrown::PathInjection("project dir escapes base".into()));
    }
    let names = match node_fs::readdir(&dir) {
        Ok(names) => names,
        Err(e) if is_enoent(&e) => return Ok(vec![]),
        Err(e) => return Err(FsError::new(&e, "scandir", Some(&dir), None).into()),
    };
    let mut ids = Vec::new();
    for name in &names {
        if let Some(id) = session_id_of(name) {
            add(&mut ids, SessionKey::Str(id.to_owned()));
        }
    }
    if names.iter().any(|n| n == DB_FILE)
        && let Ok(db) = db::open_db(root, Mode::ReadOnly)
    {
        let rows = db.with(|conn| {
            let mut st = conn.prepare("SELECT id, title FROM sessions WHERE cwd = ?")?;
            let mut rows = st.query([JsText::new(root)])?;
            let mut out = Vec::new();
            while let Some(r) = rows.next()? {
                out.push((SessionKey::of(r.get_ref(0)?), Cell::read(r.get_ref(1)?)));
            }
            Ok(out)
        });
        // A pre-v2 database without the table (or without `title`): the
        // transcripts are the set.
        for (key, title) in rows.unwrap_or_default() {
            if has(&ids, &key) {
                continue;
            }
            if let Some(is_live) = is_live {
                let live = || match &key {
                    SessionKey::Str(s) => is_live(s),
                    _ => false,
                };
                match session_history::is_history_worthy_db_row(
                    session_history::title_of(&title),
                    live,
                ) {
                    Ok(true) => {}
                    // The `TypeError` lands in the same `catch`: the rows
                    // read so far stay, the rest are dropped.
                    Err(_) => break,
                    Ok(false) => continue,
                }
            }
            add(&mut ids, key);
        }
    }
    Ok(ids)
}

/// `relocateWorkspaceSessions(fromRoot, toRoot)`. Callers stop the live
/// sessions in `from_root` first. Throws only before anything moved: a
/// root whose folder would be the projects dir itself (`""`), or a failed
/// `readdir` / `mkdir` of the folders.
pub fn relocate_workspace_sessions(
    from_root: &str,
    to_root: &str,
) -> Result<RelocateResult, Thrown> {
    let mut result = RelocateResult::default();
    if from_root == to_root {
        return Ok(result);
    }
    let base = projects_base();
    let inside = format!("{base}/");
    let from_dir = node_path::resolve(&[&base, &paths::encode_project_dir(from_root)]);
    let to_dir = node_path::resolve(&[&base, &paths::encode_project_dir(to_root)]);
    if !from_dir.starts_with(&inside) || !to_dir.starts_with(&inside) {
        return Err(Thrown::PathInjection("project dir escapes base".into()));
    }
    let same_dir = from_dir == to_dir;
    let names = match node_fs::readdir(&from_dir) {
        Ok(names) => names,
        Err(e) if is_enoent(&e) => return Ok(result),
        Err(e) => return Err(FsError::new(&e, "scandir", Some(&from_dir), None).into()),
    };
    if !same_dir {
        node_fs::mkdir_recursive(&to_dir, 0o777)?;
    }

    for name in &names {
        let Some(session_id) = session_id_of(name) else {
            continue;
        };
        let src = node_path::resolve(&[&from_dir, name]);
        let dst = node_path::resolve(&[&to_dir, name]);
        if !dst.starts_with(&inside) {
            continue;
        }
        let moved = (|| -> Result<(), Thrown> {
            if !same_dir {
                if path_exists(&dst)? {
                    return Err(Thrown::Fs(FsError {
                        code: None,
                        message: "a transcript with this id already exists in the new folder"
                            .into(),
                    }));
                }
                node_fs::rename(&src, &dst)?;
                let src_sidecar = node_path::resolve(&[&from_dir, session_id]);
                if path_exists(&src_sidecar)? {
                    move_dir_merging(&src_sidecar, &node_path::resolve(&[&to_dir, session_id]))?;
                }
            }
            append_relocated_stamp(&dst, session_id, to_root)
        })();
        match moved {
            Ok(()) => result.moved += 1,
            Err(e) => result
                .failed
                .push((session_id.to_owned(), e.message().to_owned())),
        }
    }

    if !same_dir && names.iter().any(|n| n == "assets") {
        let moved = move_dir_merging(
            &node_path::resolve(&[&from_dir, "assets"]),
            &node_path::resolve(&[&to_dir, "assets"]),
        );
        if let Err(e) = moved {
            // The sessions are fine; their images stay behind.
            result.data_error = Some(format!("assets: {}", e.message()));
        }
    }

    if names.iter().any(|n| n == DB_FILE) {
        let merged = if same_dir {
            rekey_in_place(from_root, to_root)
        } else {
            merge_db(
                from_root,
                to_root,
                &node_path::resolve(&[&from_dir, DB_FILE]),
            )
        };
        if let Err(msg) = merged {
            result.data_error = Some(match result.data_error.take() {
                Some(prev) => format!("{prev}; database: {msg}"),
                None => format!("database: {msg}"),
            });
        }
    }

    // Tidy up an emptied folder; anything left in it (memory, failed
    // transcripts) keeps it, since `rmdir` refuses a non-empty one.
    if !same_dir {
        let _ = std::fs::remove_dir(&from_dir);
    }
    Ok(result)
}

/// `pathExists`: `lstat`; only `ENOENT` is "no".
fn path_exists(p: &str) -> Result<bool, FsError> {
    match std::fs::symlink_metadata(p) {
        Ok(_) => Ok(true),
        Err(e) if is_enoent(&e) => Ok(false),
        Err(e) => Err(FsError::new(&e, "lstat", Some(p), None)),
    }
}

/// `moveDirMerging(src, dst)`: `rename` when `dst` is free, else copy into
/// it (what's there wins) and remove `src`.
fn move_dir_merging(src: &str, dst: &str) -> Result<(), Thrown> {
    let base = projects_base();
    if !dst.starts_with(&format!("{base}/")) {
        return Err(Thrown::PathInjection("destination escapes base".into()));
    }
    if !path_exists(dst)? {
        node_fs::rename(src, dst)?;
        return Ok(());
    }
    cp::cp(src, dst)?;
    node_fs::rm_recursive(src, true)?;
    Ok(())
}

/// `appendRelocatedStamp(file, sessionId, toRoot)`: the SDK's `relocated`
/// entry, on a line of its own.
fn append_relocated_stamp(file: &str, session_id: &str, to_root: &str) -> Result<(), Thrown> {
    let base = projects_base();
    if !file.starts_with(&format!("{base}/")) {
        return Err(Thrown::PathInjection("transcript escapes base".into()));
    }
    let mut prefix = "";
    {
        let fh =
            std::fs::File::open(file).map_err(|e| FsError::new(&e, "open", Some(file), None))?;
        let size = fh
            .metadata()
            .map_err(|e| FsError::new(&e, "fstat", None, None))?
            .len();
        if size > 0 {
            // `Buffer.alloc(1)`: a short read leaves the zero byte.
            let mut last = [0u8; 1];
            read_at(&fh, &mut last, size - 1).map_err(|e| FsError::new(&e, "read", None, None))?;
            if last[0] != b'\n' {
                prefix = "\n";
            }
        }
    }
    let line = js_string::stringify(
        &json!({"type": "relocated", "sessionId": session_id, "relocatedCwd": to_root}),
    );
    let mut o = std::fs::OpenOptions::new();
    o.append(true).create(true);
    #[cfg(unix)]
    std::os::unix::fs::OpenOptionsExt::mode(&mut o, 0o666);
    let mut f = o
        .open(file)
        .map_err(|e| FsError::new(&e, "open", Some(file), None))?;
    f.write_all(format!("{prefix}{line}\n").as_bytes())
        .map_err(|e| FsError::new(&e, "write", None, None))?;
    Ok(())
}

#[cfg(unix)]
fn read_at(f: &std::fs::File, buf: &mut [u8], pos: u64) -> io::Result<usize> {
    std::os::unix::fs::FileExt::read_at(f, buf, pos)
}

#[cfg(not(unix))]
fn read_at(mut f: &std::fs::File, buf: &mut [u8], pos: u64) -> io::Result<usize> {
    use std::io::{Read, Seek, SeekFrom};
    f.seek(SeekFrom::Start(pos))?;
    f.read(buf)
}

/// `quoteIdent`.
fn quote_ident(name: &str) -> String {
    format!("\"{}\"", name.replace('"', "\"\""))
}

/// `rekeyCwdColumns`: every table of `main` with a `cwd` column moves its
/// `from_root` rows to `to_root`; a key conflict keeps the row already
/// there.
fn rekey_cwd_columns(conn: &Connection, from_root: &str, to_root: &str) -> rusqlite::Result<()> {
    let tables: Vec<String> = conn
        .prepare(
            "SELECT name FROM sqlite_master
        WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
        )?
        .query_map([], |r| r.get(0))?
        .collect::<Result<_, _>>()?;
    let (from, to) = (JsText::new(from_root), JsText::new(to_root));
    for name in tables {
        let has_cwd = conn
            .prepare("SELECT 1 FROM pragma_table_info(?, 'main') WHERE name = 'cwd'")?
            .exists([&name])?;
        if !has_cwd {
            continue;
        }
        let t = quote_ident(&name);
        conn.execute(
            &format!("UPDATE OR IGNORE {t} SET cwd = ? WHERE cwd = ?"),
            (&to, &from),
        )?;
        conn.execute(&format!("DELETE FROM {t} WHERE cwd = ?"), [&from])?;
    }
    Ok(())
}

/// Two roots in one folder: only the re-key, in a transaction.
fn rekey_in_place(from_root: &str, to_root: &str) -> Result<(), String> {
    let db = db::open_db(to_root, Mode::ReadWrite).map_err(|e| e.to_string())?;
    db.with_mut(|conn| {
        let tx = conn.transaction()?;
        rekey_cwd_columns(&tx, from_root, to_root)?;
        tx.commit()
    })
    .map_err(|e| db::sqlite_message(&e))
}

/// `mergeDb(fromRoot, toRoot, fromDbFile)`.
fn merge_db(from_root: &str, to_root: &str, from_db_file: &str) -> Result<(), String> {
    // Bring the source schema up to date, then let go of it before its
    // file is deleted.
    db::close_db(from_root);
    db::open_db(from_root, Mode::ReadWrite).map_err(|e| e.to_string())?;
    db::close_db(from_root);

    let dst = db::open_db(to_root, Mode::ReadWrite).map_err(|e| e.to_string())?;
    dst.with_mut(|conn| {
        conn.execute(
            "ATTACH DATABASE ? AS reloc_src",
            [js_string::lossy(from_db_file).as_ref()],
        )?;
        let copied = copy_attached(conn, from_root, to_root);
        // `finally { DETACH }`: its own failure wins over the copy's.
        conn.execute_batch("DETACH DATABASE reloc_src")?;
        copied
    })
    .map_err(|e| db::sqlite_message(&e))?;
    drop(dst);

    for suffix in ["", "-wal", "-shm"] {
        let file = format!("{from_db_file}{suffix}");
        match std::fs::remove_file(&file) {
            Ok(()) => {}
            Err(e) if is_enoent(&e) => {}
            Err(e) => return Err(FsError::new(&e, "unlink", Some(&file), None).message),
        }
    }
    Ok(())
}

/// The transaction in `mergeDb`: every `reloc_src` table this schema
/// knows, copied over the shared columns (the destination keeps its own
/// rows on a conflict and numbers a lone `INTEGER` primary key itself),
/// then the re-key.
fn copy_attached(conn: &mut Connection, from_root: &str, to_root: &str) -> rusqlite::Result<()> {
    let tx = conn.transaction()?;
    // asset_uses → assets is a real foreign key: checked at COMMIT.
    tx.execute_batch("PRAGMA defer_foreign_keys = ON")?;
    let tables: Vec<String> = tx
        .prepare(
            "SELECT name FROM reloc_src.sqlite_master
            WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name <> 'schema_meta'",
        )?
        .query_map([], |r| r.get(0))?
        .collect::<Result<_, _>>()?;
    for name in tables {
        let dst_cols: Vec<(String, String, i64)> = tx
            .prepare("SELECT name, type, pk FROM pragma_table_info(?, 'main')")?
            .query_map([&name], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?
            .collect::<Result<_, _>>()?;
        if dst_cols.is_empty() {
            continue; // unknown to this schema
        }
        let src_cols: Vec<String> = tx
            .prepare("SELECT name FROM pragma_table_info(?, 'reloc_src')")?
            .query_map([&name], |r| r.get(0))?
            .collect::<Result<_, _>>()?;
        let pk: Vec<&(String, String, i64)> = dst_cols.iter().filter(|c| c.2 > 0).collect();
        let rowid_alias = match pk.as_slice() {
            [only] if js_string::to_upper(&only.1) == "INTEGER" => Some(only.0.as_str()),
            _ => None,
        };
        let cols: Vec<String> = dst_cols
            .iter()
            .filter(|c| Some(c.0.as_str()) != rowid_alias && src_cols.contains(&c.0))
            .map(|c| quote_ident(&c.0))
            .collect();
        if cols.is_empty() {
            continue;
        }
        let list = cols.join(", ");
        let t = quote_ident(&name);
        tx.execute_batch(&format!(
            "INSERT OR IGNORE INTO main.{t} ({list}) SELECT {list} FROM reloc_src.{t}"
        ))?;
    }
    rekey_cwd_columns(&tx, from_root, to_root)?;
    tx.commit()
}

/// File metadata as Node's `Stats` exposes it to `fs.cp`.
#[derive(Clone, Copy, Debug)]
struct Stat {
    kind: Kind,
    ino: u64,
    dev: u64,
    mode: u32,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Kind {
    Dir,
    File,
    Symlink,
    Device,
    Socket,
    Fifo,
    Unknown,
}

impl Stat {
    fn of(m: &std::fs::Metadata) -> Stat {
        let ft = m.file_type();
        #[cfg(unix)]
        let (ino, dev, mode, kind) = {
            use std::os::unix::fs::{FileTypeExt, MetadataExt};
            let kind = if ft.is_dir() {
                Kind::Dir
            } else if ft.is_file() {
                Kind::File
            } else if ft.is_symlink() {
                Kind::Symlink
            } else if ft.is_char_device() || ft.is_block_device() {
                Kind::Device
            } else if ft.is_socket() {
                Kind::Socket
            } else if ft.is_fifo() {
                Kind::Fifo
            } else {
                Kind::Unknown
            };
            (m.ino(), m.dev(), m.mode(), kind)
        };
        #[cfg(not(unix))]
        let (ino, dev, mode, kind) = {
            let kind = if ft.is_dir() {
                Kind::Dir
            } else if ft.is_file() {
                Kind::File
            } else if ft.is_symlink() {
                Kind::Symlink
            } else {
                Kind::Unknown
            };
            (
                0,
                0,
                if m.permissions().readonly() {
                    0o444
                } else {
                    0o666
                },
                kind,
            )
        };
        Stat {
            kind,
            ino,
            dev,
            mode,
        }
    }

    fn is_dir(&self) -> bool {
        self.kind == Kind::Dir
    }
}

/// `fs.promises.cp(src, dest, {recursive: true, force: false,
/// errorOnExist: false})` (node 22's `internal/fs/cp/cp.js`): no filter,
/// no dereference, symlinks re-pointed at absolute targets, an existing
/// destination file left as it is.
mod cp {
    use super::*;

    fn lstat(p: &str) -> Result<Stat, FsError> {
        std::fs::symlink_metadata(p)
            .map(|m| Stat::of(&m))
            .map_err(|e| FsError::new(&e, "lstat", Some(p), None))
    }

    /// `stat`, with `ENOENT` as `None`.
    fn stat_opt(p: &str) -> Result<Option<Stat>, FsError> {
        match std::fs::metadata(p) {
            Ok(m) => Ok(Some(Stat::of(&m))),
            Err(e) if is_enoent(&e) => Ok(None),
            Err(e) => Err(FsError::new(&e, "stat", Some(p), None)),
        }
    }

    /// A `SystemError` (`ERR_FS_CP_*`): `<prefix>: cp returned <code>
    /// (<message>) <path>`.
    fn system_error(key: &str, prefix: &str, code: &str, message: &str, path: &str) -> FsError {
        FsError {
            code: Some(key.to_owned()),
            message: format!("{prefix}: cp returned {code} ({message}) {path}"),
        }
    }

    fn einval(message: &str, path: &str) -> FsError {
        system_error(
            "ERR_FS_CP_EINVAL",
            "Invalid src or dest",
            "EINVAL",
            message,
            path,
        )
    }

    /// `areIdentical`.
    fn identical(src: &Stat, dest: &Stat) -> bool {
        dest.ino != 0 && dest.dev != 0 && dest.ino == src.ino && dest.dev == src.dev
    }

    /// `isSrcSubdir`: every segment of the resolved `src` starts the
    /// resolved `dest`.
    fn is_src_subdir(src: &str, dest: &str) -> bool {
        let parts = |p: &str| -> Vec<String> {
            node_path::resolve(&[p])
                .split('/')
                .filter(|s| !s.is_empty())
                .map(str::to_owned)
                .collect()
        };
        let (s, d) = (parts(src), parts(dest));
        s.iter().enumerate().all(|(i, c)| d.get(i) == Some(c))
    }

    pub fn cp(src: &str, dest: &str) -> Result<(), FsError> {
        let (src_stat, dest_stat) = check_paths(src, dest)?;
        check_parent_paths(src, &src_stat, dest)?;
        check_parent_dir(dest_stat.as_ref(), src, dest)
    }

    fn check_paths(src: &str, dest: &str) -> Result<(Stat, Option<Stat>), FsError> {
        let src_stat = lstat(src)?;
        let dest_stat = match std::fs::symlink_metadata(dest) {
            Ok(m) => Some(Stat::of(&m)),
            Err(e) if is_enoent(&e) => None,
            Err(e) => return Err(FsError::new(&e, "lstat", Some(dest), None)),
        };
        if let Some(d) = &dest_stat {
            if identical(&src_stat, d) {
                return Err(einval("src and dest cannot be the same", dest));
            }
            if src_stat.is_dir() && !d.is_dir() {
                return Err(system_error(
                    "ERR_FS_CP_DIR_TO_NON_DIR",
                    "Cannot overwrite non-directory with directory",
                    "EISDIR",
                    &format!("cannot overwrite non-directory {dest} with directory {src}"),
                    dest,
                ));
            }
            if !src_stat.is_dir() && d.is_dir() {
                return Err(system_error(
                    "ERR_FS_CP_NON_DIR_TO_DIR",
                    "Cannot overwrite directory with non-directory",
                    "ENOTDIR",
                    &format!("cannot overwrite directory {dest} with non-directory {src}"),
                    dest,
                ));
            }
        }
        if src_stat.is_dir() && is_src_subdir(src, dest) {
            return Err(einval(
                &format!("cannot copy {src} to a subdirectory of self {dest}"),
                dest,
            ));
        }
        Ok((src_stat, dest_stat))
    }

    /// `checkParentPaths`: no parent of `dest` (followed) is `src` itself.
    fn check_parent_paths(src: &str, src_stat: &Stat, dest: &str) -> Result<(), FsError> {
        let src_parent = node_path::resolve(&[&node_path::dirname(src)]);
        let dest_parent = node_path::resolve(&[&node_path::dirname(dest)]);
        if dest_parent == src_parent || dest_parent == "/" {
            return Ok(());
        }
        match stat_opt(&dest_parent)? {
            None => Ok(()),
            Some(st) if identical(src_stat, &st) => Err(einval(
                &format!("cannot copy {src} to a subdirectory of self {dest}"),
                dest,
            )),
            Some(_) => check_parent_paths(src, src_stat, &dest_parent),
        }
    }

    fn check_parent_dir(dest_stat: Option<&Stat>, src: &str, dest: &str) -> Result<(), FsError> {
        let dest_parent = node_path::dirname(dest);
        if stat_opt(&dest_parent)?.is_none() {
            node_fs::mkdir_recursive(&dest_parent, 0o777)?;
        }
        get_stats_for_copy(dest_stat, src, dest)
    }

    fn get_stats_for_copy(dest_stat: Option<&Stat>, src: &str, dest: &str) -> Result<(), FsError> {
        let src_stat = lstat(src)?;
        match src_stat.kind {
            Kind::Dir => on_dir(&src_stat, dest_stat, src, dest),
            Kind::File | Kind::Device => on_file(&src_stat, dest_stat, src, dest),
            Kind::Symlink => on_link(dest_stat, src, dest),
            Kind::Socket => Err(system_error(
                "ERR_FS_CP_SOCKET",
                "Cannot copy a socket file",
                "EINVAL",
                &format!("cannot copy a socket file: {dest}"),
                dest,
            )),
            Kind::Fifo => Err(system_error(
                "ERR_FS_CP_FIFO_PIPE",
                "Cannot copy a FIFO pipe",
                "EINVAL",
                &format!("cannot copy a FIFO pipe: {dest}"),
                dest,
            )),
            Kind::Unknown => Err(system_error(
                "ERR_FS_CP_UNKNOWN",
                "Cannot copy an unknown file type",
                "EINVAL",
                &format!("cannot copy an unknown file type: {dest}"),
                dest,
            )),
        }
    }

    fn chmod(dest: &str, mode: u32) -> Result<(), FsError> {
        node_fs::chmod(dest, mode & 0o7777).map_err(|e| FsError::new(&e, "chmod", Some(dest), None))
    }

    /// `onFile`: a new file is copied (then given the source's mode); an
    /// existing one is skipped.
    fn on_file(
        src_stat: &Stat,
        dest_stat: Option<&Stat>,
        src: &str,
        dest: &str,
    ) -> Result<(), FsError> {
        if dest_stat.is_some() {
            return Ok(());
        }
        std::fs::copy(src, dest)
            .map_err(|e| FsError::new(&e, "copyfile", Some(src), Some(dest)))?;
        chmod(dest, src_stat.mode)
    }

    fn on_dir(
        src_stat: &Stat,
        dest_stat: Option<&Stat>,
        src: &str,
        dest: &str,
    ) -> Result<(), FsError> {
        if dest_stat.is_some() {
            return copy_dir(src, dest);
        }
        let mut b = std::fs::DirBuilder::new();
        #[cfg(unix)]
        std::os::unix::fs::DirBuilderExt::mode(&mut b, 0o777);
        b.create(dest)
            .map_err(|e| FsError::new(&e, "mkdir", Some(dest), None))?;
        copy_dir(src, dest)?;
        chmod(dest, src_stat.mode)
    }

    /// `copyDir`: the entries in the order `opendir` reads them.
    fn copy_dir(src: &str, dest: &str) -> Result<(), FsError> {
        let dir =
            std::fs::read_dir(src).map_err(|e| FsError::new(&e, "opendir", Some(src), None))?;
        for entry in dir {
            let entry = entry.map_err(|e| FsError::new(&e, "readdir", None, None))?;
            let name = entry.file_name().to_string_lossy().into_owned();
            let src_item = node_path::join(&[src, &name]);
            let dest_item = node_path::join(&[dest, &name]);
            let (_, dest_stat) = check_paths(&src_item, &dest_item)?;
            get_stats_for_copy(dest_stat.as_ref(), &src_item, &dest_item)?;
        }
        Ok(())
    }

    fn readlink(p: &str) -> io::Result<String> {
        std::fs::read_link(p).map(|t| t.to_string_lossy().into_owned())
    }

    fn symlink(target: &str, path: &str) -> Result<(), FsError> {
        node_fs::symlink(target, path)
            .map_err(|e| FsError::new(&e, "symlink", Some(target), Some(path)))
    }

    fn on_link(dest_stat: Option<&Stat>, src: &str, dest: &str) -> Result<(), FsError> {
        let mut resolved_src =
            readlink(src).map_err(|e| FsError::new(&e, "readlink", Some(src), None))?;
        if !node_path::is_absolute(&resolved_src) {
            resolved_src = node_path::resolve(&[&node_path::dirname(src), &resolved_src]);
        }
        if dest_stat.is_none() {
            return symlink(&resolved_src, dest);
        }
        let mut resolved_dest = match readlink(dest) {
            Ok(t) => t,
            // A regular file there: the symlink call fails on it.
            Err(e) if matches!(node_fs::code(&e).as_deref(), Some("EINVAL" | "UNKNOWN")) => {
                return symlink(&resolved_src, dest);
            }
            Err(e) => return Err(FsError::new(&e, "readlink", Some(dest), None)),
        };
        if !node_path::is_absolute(&resolved_dest) {
            resolved_dest = node_path::resolve(&[&node_path::dirname(dest), &resolved_dest]);
        }
        if is_src_subdir(&resolved_src, &resolved_dest) {
            return Err(einval(
                &format!("cannot copy {resolved_src} to a subdirectory of self {resolved_dest}"),
                dest,
            ));
        }
        let src_stat = std::fs::metadata(src)
            .map(|m| Stat::of(&m))
            .map_err(|e| FsError::new(&e, "stat", Some(src), None))?;
        if src_stat.is_dir() && is_src_subdir(&resolved_dest, &resolved_src) {
            return Err(system_error(
                "ERR_FS_CP_SYMLINK_TO_SUBDIRECTORY",
                "Cannot overwrite symlink in subdirectory of self",
                "EINVAL",
                &format!("cannot overwrite {resolved_dest} with {resolved_src}"),
                dest,
            ));
        }
        std::fs::remove_file(dest).map_err(|e| FsError::new(&e, "unlink", Some(dest), None))?;
        symlink(&resolved_src, dest)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn transcript_names() {
        let id = "0123abcd-ABCD-4ef0-89ab-0123456789AB";
        assert_eq!(session_id_of(&format!("{id}.jsonl")), Some(id));
        assert_eq!(session_id_of(&format!("{id}.JsOnL")), Some(id));
        for bad in [
            format!("{id}.jsonl.bak"),
            format!("{id}jsonl"),
            format!("x{id}.jsonl"),
            id.to_owned(),
            format!("{}g.jsonl", &id[..35]),
            format!("{}_{}.jsonl", &id[..8], &id[9..]),
            "0123abcd-abcd-4ef0-89ab-0123456789ab.jsonl\n".into(),
            "0123abcd-abcd-4ef0-89ab-0123456789\u{e9}.jsonl".into(),
        ] {
            assert_eq!(session_id_of(&bad), None, "{bad:?}");
        }
    }

    #[test]
    fn set_semantics() {
        let mut ids = vec![];
        for k in [
            SessionKey::Str("a".into()),
            SessionKey::Str("a".into()),
            SessionKey::Num(5.0),
            SessionKey::Num(5.0),
            SessionKey::Num(0.0),
            SessionKey::Num(-0.0),
            SessionKey::Str("5".into()),
            SessionKey::Null,
            SessionKey::Null,
            SessionKey::Blob(vec![1]),
            SessionKey::Blob(vec![1]),
        ] {
            add(&mut ids, k);
        }
        assert_eq!(ids.len(), 7);
        assert_eq!(
            Value::Array(ids.iter().map(SessionKey::to_json).collect()).to_string(),
            r#"["a",5,0,"5",null,{"type":"Buffer","data":[1]},{"type":"Buffer","data":[1]}]"#
        );
    }

    #[test]
    fn result_shape() {
        let mut r = RelocateResult::default();
        assert_eq!(
            Value::Object(r.to_json()).to_string(),
            r#"{"moved":0,"failed":[]}"#
        );
        r.moved = 2;
        r.failed.push(("x".into(), "boom".into()));
        r.data_error = Some("assets: no".into());
        assert_eq!(
            Value::Object(r.to_json()).to_string(),
            r#"{"moved":2,"failed":[{"sessionId":"x","error":"boom"}],"dataError":"assets: no"}"#
        );
    }
}
