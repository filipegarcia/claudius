//! `lib/server/asset-list.ts`: the Files page's queries over the `assets`
//! and `asset_uses` tables (migration 001): `listAssets` for one project or
//! for every project of the account, `listUses`, `getAssetMeta` and
//! `deleteAssetRow`.
//!
//! Every column is kept as better-sqlite3 hands it to JS ([`Cell`]): a row
//! another writer stored with a TEXT size or a BLOB hash answers it as such
//! (`"12"`, `{"type":"Buffer","data":[…]}`), and the account scope's sort
//! and cursor coerce it the way JS's `-` and `<` do. Numbers are bound as
//! better-sqlite3 binds them, as REALs, so a fractional `LIMIT` fails in
//! SQLite the same way.
//!
//! The account scope reads every `<home>/.claude/projects/*/.claudius.db`
//! read-only and skips one it can't open or query. Its sort is V8's: for
//! fewer than 64 rows the binary insertion sort of V8's TimSort, step for
//! step, so even a comparison that coerces to `NaN` orders rows as V8
//! does; past that a stable merge sort, the same order whenever no
//! comparison is `NaN`.
//!
//! better-sqlite3's SQLite is built with `SQLITE_LIKE_DOESNT_MATCH_BLOBS`:
//! `LIKE` is false whenever an operand is a BLOB. The bundled SQLite here
//! isn't, so every `LIKE` spells that out (`typeof(x) <> 'blob' AND …`).

use rusqlite::types::{ToSqlOutput, Value as Sql, ValueRef};
use rusqlite::{Connection, OpenFlags, ToSql};
use serde_json::{Map, Value, json};

use crate::db::{Mode, open_db};
use crate::sql_text::JsText;
use crate::{js_num, js_params, node_path, paths};

/// A column value as better-sqlite3 reads it into JS.
#[derive(Clone, Debug, PartialEq)]
pub enum Cell {
    Null,
    /// INTEGER (rounded past 2^53, as JS rounds it) or REAL.
    Num(f64),
    Text(String),
    /// A Node `Buffer`.
    Blob(Vec<u8>),
}

impl Cell {
    pub fn read(v: ValueRef) -> Cell {
        match v {
            ValueRef::Null => Cell::Null,
            ValueRef::Integer(n) => Cell::Num(n as f64),
            ValueRef::Real(f) => Cell::Num(f),
            ValueRef::Text(t) => Cell::Text(String::from_utf8_lossy(t).into_owned()),
            ValueRef::Blob(b) => Cell::Blob(b.to_vec()),
        }
    }

    /// `JSON.stringify`'s view (`Buffer.prototype.toJSON` for a blob).
    pub fn to_json(&self) -> Value {
        match self {
            Cell::Null => Value::Null,
            Cell::Num(f) => js_num(*f),
            Cell::Text(s) => json!(s),
            Cell::Blob(b) => json!({"type": "Buffer", "data": b}),
        }
    }

    /// `ToNumber`, as `-` and `<` coerce it (a `Buffer` through its UTF-8
    /// `toString()`, `null` to 0).
    pub fn to_number(&self) -> f64 {
        use claudius_agent::js::to_number;
        match self {
            Cell::Null => 0.0,
            Cell::Num(f) => *f,
            Cell::Text(s) => to_number(s),
            Cell::Blob(b) => to_number(&String::from_utf8_lossy(b)),
        }
    }

    /// `String(v)`, as a header value or template literal prints it.
    pub fn to_js_string(&self) -> String {
        match self {
            Cell::Null => "null".into(),
            Cell::Num(f) if f.is_nan() => "NaN".into(),
            Cell::Num(f) if *f == f64::INFINITY => "Infinity".into(),
            Cell::Num(f) if *f == f64::NEG_INFINITY => "-Infinity".into(),
            Cell::Num(f) => claudius_agent::js::number_to_string(*f),
            Cell::Text(s) => s.clone(),
            Cell::Blob(b) => String::from_utf8_lossy(b).into_owned(),
        }
    }

    pub fn as_str(&self) -> Option<&str> {
        match self {
            Cell::Text(s) => Some(s),
            _ => None,
        }
    }

    /// JS truthiness: a `Buffer` is truthy even when empty.
    pub fn truthy(&self) -> bool {
        match self {
            Cell::Null => false,
            Cell::Num(f) => *f != 0.0 && !f.is_nan(),
            Cell::Text(s) => !s.is_empty(),
            Cell::Blob(_) => true,
        }
    }
}

/// Bound as better-sqlite3 binds the JS value: a number as a REAL, a
/// `Buffer` as a BLOB.
impl ToSql for Cell {
    fn to_sql(&self) -> rusqlite::Result<ToSqlOutput<'_>> {
        Ok(match self {
            Cell::Null => ToSqlOutput::Owned(Sql::Null),
            Cell::Num(f) => ToSqlOutput::Owned(Sql::Real(*f)),
            Cell::Text(s) => ToSqlOutput::Borrowed(ValueRef::Text(s.as_bytes())),
            Cell::Blob(b) => ToSqlOutput::Borrowed(ValueRef::Blob(b)),
        })
    }
}

/// `AssetRow`.
#[derive(Clone, Debug, PartialEq)]
pub struct AssetRow {
    pub hash: Cell,
    pub media_type: Cell,
    pub size_bytes: Cell,
    pub width: Cell,
    pub height: Cell,
    pub first_seen_ms: Cell,
    pub last_seen_ms: Cell,
    pub uses: Cell,
    /// The project's cwd, or (account scope) its encoded folder name.
    pub cwd: Option<String>,
}

impl AssetRow {
    /// `rowToAsset`'s object as `JSON.stringify` prints it: a `null` width
    /// or height (`?? undefined`) is left out.
    pub fn to_json(&self) -> Value {
        let mut m = Map::new();
        m.insert("hash".into(), self.hash.to_json());
        m.insert("mediaType".into(), self.media_type.to_json());
        m.insert("sizeBytes".into(), self.size_bytes.to_json());
        if self.width != Cell::Null {
            m.insert("width".into(), self.width.to_json());
        }
        if self.height != Cell::Null {
            m.insert("height".into(), self.height.to_json());
        }
        m.insert("firstSeenMs".into(), self.first_seen_ms.to_json());
        m.insert("lastSeenMs".into(), self.last_seen_ms.to_json());
        m.insert("uses".into(), self.uses.to_json());
        if let Some(cwd) = &self.cwd {
            m.insert("cwd".into(), json!(cwd));
        }
        Value::Object(m)
    }
}

/// A bound parameter, as better-sqlite3 binds the JS value.
enum Param {
    Text(String),
    Num(f64),
}

impl ToSql for Param {
    fn to_sql(&self) -> rusqlite::Result<ToSqlOutput<'_>> {
        Ok(ToSqlOutput::Owned(match self {
            Param::Text(s) => Sql::Text(s.clone()),
            Param::Num(f) => Sql::Real(*f),
        }))
    }
}

const SELECT: &str = "
    SELECT a.hash AS hash,
           a.media_type AS media_type,
           a.size_bytes AS size_bytes,
           a.width AS width,
           a.height AS height,
           a.first_seen_ms AS first_seen_ms,
           a.last_seen_ms AS last_seen_ms,
           (SELECT COUNT(*) FROM asset_uses u WHERE u.asset_hash = a.hash) AS uses
    FROM assets a";

/// `x LIKE pat` as better-sqlite3's SQLite answers it: false for a BLOB.
fn like(x: &str, pat: &str) -> String {
    format!("(typeof({x}) <> 'blob' AND {x} LIKE {pat})")
}

/// `applyTypeFilter`.
fn type_filter(sql: &mut String, kind: &str) {
    match kind {
        "image" => sql.push_str(&format!(" AND {}", like("a.media_type", "'image/%'"))),
        "file" => sql.push_str(&format!(" AND NOT {}", like("a.media_type", "'image/%'"))),
        _ => {}
    }
}

fn query_rows(
    conn: &Connection,
    sql: &str,
    params: &[Param],
    cwd: &str,
) -> rusqlite::Result<Vec<AssetRow>> {
    let mut st = conn.prepare(sql)?;
    let params = rusqlite::params_from_iter(params.iter().map(JsText::new));
    st.query_map(params, |r| {
        Ok(AssetRow {
            hash: Cell::read(r.get_ref(0)?),
            media_type: Cell::read(r.get_ref(1)?),
            size_bytes: Cell::read(r.get_ref(2)?),
            width: Cell::read(r.get_ref(3)?),
            height: Cell::read(r.get_ref(4)?),
            first_seen_ms: Cell::read(r.get_ref(5)?),
            last_seen_ms: Cell::read(r.get_ref(6)?),
            uses: Cell::read(r.get_ref(7)?),
            cwd: Some(cwd.to_owned()),
        })
    })?
    .collect()
}

/// `listProject`: `Ok(vec![])` when the database can't be opened; a query
/// that fails (a fractional `LIMIT`, a schema without the tables) is `Err`,
/// a throw in TS.
fn list_project(
    cwd: &str,
    kind: &str,
    q: &str,
    limit: f64,
    cursor: Option<f64>,
) -> anyhow::Result<Vec<AssetRow>> {
    let Ok(db) = open_db(cwd, Mode::ReadWrite) else {
        return Ok(Vec::new());
    };
    let mut sql = format!("{SELECT}\n    WHERE 1=1\n  ");
    let mut params = Vec::new();
    type_filter(&mut sql, kind);
    if !q.is_empty() {
        sql.push_str(&format!(
            " AND ({} OR a.hash IN (SELECT asset_hash FROM asset_uses WHERE {}))",
            like("a.hash", "?"),
            like("session_id", "?")
        ));
        params.push(Param::Text(format!("{q}%")));
        params.push(Param::Text(format!("%{q}%")));
    }
    if let Some(c) = cursor {
        sql.push_str(" AND a.last_seen_ms < ?");
        params.push(Param::Num(c));
    }
    sql.push_str(" ORDER BY a.last_seen_ms DESC LIMIT ?");
    params.push(Param::Num(limit));
    Ok(db.with(|c| query_rows(c, &sql, &params, cwd))?)
}

/// `listAccount`: the newest 200 rows of every project database, newest
/// first, then the page after `cursor`.
fn list_account(kind: &str, q: &str, limit: f64, cursor: Option<f64>) -> Vec<AssetRow> {
    let home = paths::home_dir().to_string_lossy().into_owned();
    let root = node_path::join(&[&home, ".claude", "projects"]);
    let Ok(entries) = crate::node_fs::readdir(&root) else {
        return Vec::new();
    };
    let mut all: Vec<AssetRow> = Vec::new();
    for name in entries {
        let file = node_path::join(&[&root, &name, ".claudius.db"]);
        // `fs.access(file)`: it exists, through symlinks.
        if std::fs::metadata(&file).is_err() {
            continue;
        }
        let Ok(conn) = Connection::open_with_flags(&file, OpenFlags::SQLITE_OPEN_READ_ONLY) else {
            continue;
        };
        let mut sql = format!("{SELECT}\n      WHERE 1=1\n    ");
        let mut params = Vec::new();
        type_filter(&mut sql, kind);
        if !q.is_empty() {
            sql.push_str(&format!(" AND {}", like("a.hash", "?")));
            params.push(Param::Text(format!("{q}%")));
        }
        sql.push_str(" ORDER BY a.last_seen_ms DESC LIMIT 200");
        // A failing query (another schema, not a database) is skipped.
        if let Ok(rows) = query_rows(&conn, &sql, &params, &name) {
            all.extend(rows);
        }
    }
    // `all.sort((a, b) => b.lastSeenMs - a.lastSeenMs)`.
    v8_sort(&mut all, |a, b| {
        b.last_seen_ms.to_number() - a.last_seen_ms.to_number()
    });
    let from = match cursor {
        None => 0,
        Some(c) => all
            .iter()
            .position(|r| r.last_seen_ms.to_number() < c)
            .unwrap_or(all.len()),
    };
    // `all.slice(from, from + limit)`: the end truncated toward zero (`NaN`
    // is 0) and kept within `from..=len`.
    let end = (from as f64 + limit).trunc();
    let end = if end.is_nan() {
        from
    } else {
        end.clamp(from as f64, all.len() as f64) as usize
    };
    all.drain(from..end).collect()
}

/// `Array.prototype.sort(cmp)` in V8 (`cmp`'s `NaN` reads as 0): one run
/// made with `CountAndMakeRun` and finished with `BinaryInsertionSort`
/// below 64 elements, a stable merge sort from there on.
pub fn v8_sort<T: Clone>(items: &mut Vec<T>, cmp: impl Fn(&T, &T) -> f64) {
    let n = items.len();
    if n < 2 {
        return;
    }
    let order = |a: &T, b: &T| {
        let v = cmp(a, b);
        if v.is_nan() { 0.0 } else { v }
    };
    if n >= 64 {
        // Never panics on an inconsistent comparison, unlike `sort_by`.
        let mut v = std::mem::take(items);
        merge_sort(&mut v, &|a: &T, b: &T| order(a, b) > 0.0);
        *items = v;
        return;
    }
    // CountAndMakeRun(0, n).
    let mut run = 2;
    let descending = order(&items[1], &items[0]) < 0.0;
    let mut prev = 1;
    for idx in 2..n {
        let o = order(&items[idx], &items[prev]);
        if descending {
            if o >= 0.0 {
                break;
            }
        } else if o < 0.0 {
            break;
        }
        prev = idx;
        run += 1;
    }
    if descending {
        items[..run].reverse();
    }
    // BinaryInsertionSort(0, run, n).
    for start in run..n {
        let pivot = items[start].clone();
        let (mut left, mut right) = (0, start);
        while left < right {
            let mid = left + ((right - left) >> 1);
            if order(&pivot, &items[mid]) < 0.0 {
                right = mid;
            } else {
                left = mid + 1;
            }
        }
        items[left..=start].rotate_right(1);
    }
}

/// A stable top-down merge sort; `after(a, b)`: `a` goes after `b`.
fn merge_sort<T: Clone>(v: &mut [T], after: &dyn Fn(&T, &T) -> bool) {
    if v.len() <= 1 {
        return;
    }
    let mid = v.len() / 2;
    merge_sort(&mut v[..mid], after);
    merge_sort(&mut v[mid..], after);
    let mut out = Vec::with_capacity(v.len());
    let (mut i, mut j) = (0, mid);
    while i < mid && j < v.len() {
        if after(&v[i], &v[j]) {
            out.push(v[j].clone());
            j += 1;
        } else {
            out.push(v[i].clone());
            i += 1;
        }
    }
    out.extend_from_slice(&v[i..mid]);
    out.extend_from_slice(&v[j..]);
    v.clone_from_slice(&out);
}

/// `listAssets(opts)`'s result.
#[derive(Clone, Debug, PartialEq)]
pub struct AssetPage {
    pub items: Vec<AssetRow>,
    /// The last item's `lastSeenMs` when the page is full.
    pub next_cursor: Option<Cell>,
}

impl AssetPage {
    pub fn to_json(&self) -> Value {
        let mut m = Map::new();
        m.insert(
            "items".into(),
            Value::Array(self.items.iter().map(AssetRow::to_json).collect()),
        );
        if let Some(c) = &self.next_cursor {
            m.insert("nextCursor".into(), c.to_json());
        }
        Value::Object(m)
    }
}

/// `listAssets({scope, cwd, type, q, limit, cursor})`: `scope` other than
/// `"project"` is the account; `limit` is clamped to `[1, 500]` (after the
/// caller's own defaulting). `Err` where TS throws (a project query).
pub fn list_assets(
    scope: &str,
    cwd: &str,
    kind: &str,
    q: &str,
    limit: f64,
    cursor: Option<f64>,
) -> anyhow::Result<AssetPage> {
    // `Math.min(Math.max(1, limit), 500)`: NaN stays NaN.
    let limit = limit.clamp(1.0, 500.0);
    let items = if scope == "project" {
        list_project(cwd, kind, q, limit, cursor)?
    } else {
        list_account(kind, q, limit, cursor)
    };
    let next_cursor = match items.last() {
        Some(last) if items.len() as f64 == limit => Some(last.last_seen_ms.clone()),
        _ => None,
    };
    Ok(AssetPage { items, next_cursor })
}

/// `UseRow`.
#[derive(Clone, Debug, PartialEq)]
pub struct UseRow {
    pub session_id: Cell,
    pub message_uuid: Cell,
    pub ordinal: Cell,
    pub occurred_ms: Cell,
}

impl UseRow {
    pub fn to_json(&self) -> Value {
        let mut m = Map::new();
        m.insert("sessionId".into(), self.session_id.to_json());
        m.insert("messageUuid".into(), self.message_uuid.to_json());
        m.insert("ordinal".into(), self.ordinal.to_json());
        m.insert("occurredMs".into(), self.occurred_ms.to_json());
        Value::Object(m)
    }
}

/// `listUses(cwd, hash)`: newest first; `Ok(vec![])` without a database.
pub fn list_uses(cwd: &str, hash: &str) -> anyhow::Result<Vec<UseRow>> {
    let Ok(db) = open_db(cwd, Mode::ReadWrite) else {
        return Ok(Vec::new());
    };
    Ok(db.with(|c| {
        let mut st = c.prepare(
            "SELECT session_id, message_uuid, ordinal, occurred_ms
       FROM asset_uses WHERE asset_hash = ? ORDER BY occurred_ms DESC",
        )?;
        st.query_map(js_params![hash], |r| {
            Ok(UseRow {
                session_id: Cell::read(r.get_ref(0)?),
                message_uuid: Cell::read(r.get_ref(1)?),
                ordinal: Cell::read(r.get_ref(2)?),
                occurred_ms: Cell::read(r.get_ref(3)?),
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()
    })?)
}

/// `getAssetMeta(cwd, hash)`: `Ok(None)` for no row or no database.
pub fn get_asset_meta(cwd: &str, hash: &str) -> anyhow::Result<Option<AssetRow>> {
    let Ok(db) = open_db(cwd, Mode::ReadWrite) else {
        return Ok(None);
    };
    let sql = format!("{SELECT} WHERE a.hash = ?");
    let rows = db.with(|c| query_rows(c, &sql, &[Param::Text(hash.to_owned())], cwd))?;
    Ok(rows.into_iter().next())
}

/// `deleteAssetRow(cwd, hash)` (its uses go with it, `ON DELETE CASCADE`):
/// `Ok(false)` without a database.
pub fn delete_asset_row(cwd: &str, hash: &str) -> anyhow::Result<bool> {
    let Ok(db) = open_db(cwd, Mode::ReadWrite) else {
        return Ok(false);
    };
    Ok(db.with(|c| c.execute("DELETE FROM assets WHERE hash = ?", js_params![hash]))? > 0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cmp::Ordering;

    #[test]
    fn v8_sort_is_stable_and_takes_nan_as_equal() {
        let mut v: Vec<(f64, u32)> = (0..10).map(|i| (f64::from(i % 3), i)).collect();
        v8_sort(&mut v, |a, b| b.0 - a.0);
        let keys: Vec<u32> = v.iter().map(|x| x.1).collect();
        assert_eq!(keys, [2, 5, 8, 1, 4, 7, 0, 3, 6, 9]);
        let mut big: Vec<(f64, u32)> = (0..100).map(|i| (f64::from(i % 7), i)).collect();
        let mut want = big.clone();
        want.sort_by(|a, b| b.0.partial_cmp(&a.0).unwrap_or(Ordering::Equal));
        v8_sort(&mut big, |a, b| b.0 - a.0);
        assert_eq!(big, want);
    }
}
