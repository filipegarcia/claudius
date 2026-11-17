//! `lib/server/asset-ingest.ts`: putting a chat's images into the store
//! ([`crate::asset_store`]) and the `assets` / `asset_uses` index.
//!
//! * [`record_send_uses`] (`recordSendUses`): for each image, the bytes
//!   (Node's lenient base64), the file (`writeIfAbsent`), the dimensions
//!   for an `image/*` type ([`crate::image_size`]), then the `assets` upsert
//!   (the newest `last_seen_ms` wins; the first media type and dimensions
//!   are kept) and an `asset_uses` row per (session, message, ordinal).
//!   An image that fails is logged and skipped; nothing here fails the
//!   send. `POST /api/sessions/:id/input` calls it, off the request, for
//!   a prompt with images (sent now or queued), with the posted elements as
//!   they are: `data` goes through `Buffer.from` (a string as base64, an
//!   array or array-like as bytes), and a `null` element, a `data` Node
//!   refuses or a non-string `mediaType` is a TypeError that skips it (S29).
//! * [`backfill_project`] (`backfillProject`): the Files page's first open
//!   walks every `<encoded cwd>/*.jsonl` under `<home>/.claude/projects`
//!   (the Claudius state root, not the CLI's config dir, as in TS) and
//!   ingests every base64 `image` block of the user messages. A file's
//!   `(mtimeMs, size)` is kept in `schema_meta` so an unchanged file is
//!   skipped next time.
//!
//! Values reach SQLite as better-sqlite3 binds them: every number a REAL
//! (the INTEGER columns store whole ones as integers).

use rusqlite::types::Value as Sql;
use serde_json::{Map, Value, json};

use crate::db::{Mode, open_db};
use crate::image_size::{Dim, image_size};
use crate::js_date::date_parse;
use crate::{asset_store, js_num, js_params, log, node_path, paths, sql_text};

/// `IngestUseResult`.
#[derive(Clone, Debug, PartialEq)]
pub struct IngestUseResult {
    pub hash: String,
    pub ordinal: f64,
    pub bytes: usize,
    pub width: Dim,
    pub height: Dim,
    pub new_on_disk: bool,
    pub new_row: bool,
}

impl IngestUseResult {
    /// As `JSON.stringify` prints it (`undefined` dimensions left out).
    pub fn to_json(&self) -> Value {
        let mut m = Map::new();
        m.insert("hash".into(), json!(self.hash));
        m.insert("ordinal".into(), js_num(self.ordinal));
        m.insert("bytes".into(), json!(self.bytes));
        if let Some(w) = self.width {
            m.insert("width".into(), js_num(w));
        }
        if let Some(h) = self.height {
            m.insert("height".into(), js_num(h));
        }
        m.insert("newOnDisk".into(), json!(self.new_on_disk));
        m.insert("newRow".into(), json!(self.new_row));
        Value::Object(m)
    }
}

/// A base64 digit of either alphabet.
fn unbase64(c: u8) -> Option<u8> {
    Some(match c {
        b'A'..=b'Z' => c - b'A',
        b'a'..=b'z' => c - b'a' + 26,
        b'0'..=b'9' => c - b'0' + 52,
        b'+' | b'-' => 62,
        b'/' | b'_' => 63,
        _ => return None,
    })
}

/// `Buffer.from(s, "base64")`: both alphabets (`+/` and `-_`), every other
/// character skipped, decoding stops at the first `=`, and a trailing lone
/// character is dropped. A UTF-16 unit past Latin-1 is read by its low byte,
/// as Node's decoder reads a two-byte string.
pub fn buffer_from_base64(s: &str) -> Vec<u8> {
    let mut out = Vec::with_capacity(s.len() / 4 * 3 + 2);
    let mut hi = 0u8;
    let mut n = 0usize;
    for unit in s.encode_utf16() {
        let c = unit as u8;
        let Some(lo) = unbase64(c) else {
            if c == b'=' {
                break;
            }
            continue;
        };
        match n % 4 {
            1 => out.push(((hi & 0x3F) << 2) | ((lo & 0x30) >> 4)),
            2 => out.push(((hi & 0x0F) << 4) | ((lo & 0x3C) >> 2)),
            3 => out.push(((hi & 0x03) << 6) | (lo & 0x3F)),
            _ => {}
        }
        hi = lo;
        n += 1;
    }
    out
}

/// The bytes `Buffer.from(v)` copies from an array-like (`fromArrayLike`):
/// `length` elements (none for `length <= 0`), each `ToUint8(ToNumber(x))`.
/// A length past 2^31 is refused (V8 would need that many bytes).
fn from_array_like(length: f64, get: impl Fn(usize) -> Option<Value>) -> Result<Vec<u8>, String> {
    if length.is_nan() || length <= 0.0 {
        return Ok(Vec::new());
    }
    if length > f64::from(i32::MAX) {
        return Err("RangeError: Array buffer allocation failed".into());
    }
    Ok((0..length as usize)
        .map(|k| {
            let n = match get(k) {
                None => f64::NAN,
                Some(Value::Null) => 0.0,
                Some(Value::Bool(b)) => f64::from(u8::from(b)),
                Some(Value::Number(n)) => n.as_f64().unwrap_or(f64::NAN),
                Some(v) => claudius_agent::js::to_number(&claudius_agent::js::to_string(Some(&v))),
            };
            if n.is_finite() {
                n.trunc().rem_euclid(256.0) as u8
            } else {
                0
            }
        })
        .collect())
}

/// `Buffer.from(img.data, "base64")` on a parsed JSON value: a string is
/// base64; an array is its bytes; an object with a `length` is array-like
/// (empty when that isn't a number), and `{type: "Buffer", data: [...]}`
/// is `data`'s bytes. Anything else is Node's `ERR_INVALID_ARG_TYPE`.
fn buffer_from(data: Option<&Value>) -> Result<Vec<u8>, String> {
    match data {
        Some(Value::String(s)) => Ok(buffer_from_base64(s)),
        Some(Value::Array(a)) => from_array_like(a.len() as f64, |k| a.get(k).cloned()),
        Some(Value::Object(o)) if o.contains_key("length") => match o.get("length") {
            Some(Value::Number(n)) => from_array_like(n.as_f64().unwrap_or(f64::NAN), |k| {
                o.get(&k.to_string()).cloned()
            }),
            _ => Ok(Vec::new()),
        },
        Some(Value::Object(o))
            if o.get("type").and_then(Value::as_str) == Some("Buffer")
                && o.get("data").is_some_and(Value::is_array) =>
        {
            let a = o["data"].as_array().unwrap();
            from_array_like(a.len() as f64, |k| a.get(k).cloned())
        }
        _ => Err("TypeError [ERR_INVALID_ARG_TYPE]: The first argument must be of type string or an instance of Buffer, ArrayBuffer, or Array or an Array-like Object.".into()),
    }
}

/// `safeImageSize(buf)`: the dimensions, or none when `imageSize` throws.
fn safe_image_size(buf: &[u8]) -> (Dim, Dim) {
    match image_size(buf) {
        Ok(s) => (s.width, s.height),
        Err(_) => (None, None),
    }
}

/// A dimension bound as better-sqlite3 binds `dim.width ?? null`.
fn bind_dim(d: Dim) -> Sql {
    match d {
        Some(x) => Sql::Real(x),
        None => Sql::Null,
    }
}

const UPSERT: &str =
    "INSERT INTO assets(hash, media_type, size_bytes, width, height, first_seen_ms, last_seen_ms)
         VALUES(?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(hash) DO UPDATE SET
           last_seen_ms = max(last_seen_ms, excluded.last_seen_ms),
           media_type   = COALESCE(media_type, excluded.media_type),
           width        = COALESCE(width, excluded.width),
           height       = COALESCE(height, excluded.height)";

const USE: &str =
    "INSERT OR IGNORE INTO asset_uses(asset_hash, session_id, message_uuid, ordinal, occurred_ms)
         VALUES(?, ?, ?, ?, ?)";

/// `recordSendUses({cwd, sessionId, messageUuid, occurredMs, images})`: one
/// result per image that made it in. An image without a numeric `ordinal`
/// is its 1-based position.
pub fn record_send_uses(
    cwd: &str,
    session_id: &str,
    message_uuid: &str,
    occurred_ms: f64,
    images: &[Value],
) -> Vec<IngestUseResult> {
    let mut out = Vec::new();
    if images.is_empty() {
        return out;
    }
    let db = match open_db(cwd, Mode::ReadWrite) {
        Ok(db) => db,
        Err(e) => {
            tracing::warn!(target: log::API, "[asset-ingest] openDb failed: {e}");
            return out;
        }
    };
    for (i, img) in images.iter().enumerate() {
        // `img.data` / `img.mediaType`: V8's TypeErrors skip the image.
        if img.is_null() {
            tracing::warn!(target: log::API, "[asset-ingest] failed: TypeError: Cannot read properties of null (reading 'data')");
            continue;
        }
        let buf = match buffer_from(img.get("data")) {
            Ok(b) => b,
            Err(e) => {
                tracing::warn!(target: log::API, "[asset-ingest] failed: {e}");
                continue;
            }
        };
        let Some(media_type) = img.get("mediaType").and_then(Value::as_str) else {
            tracing::warn!(target: log::API, "[asset-ingest] failed: TypeError: mediaType.toLowerCase is not a function");
            continue;
        };
        let written = match asset_store::write_if_absent(cwd, &buf, media_type) {
            Ok(w) => w,
            Err(e) => {
                tracing::warn!(target: log::API, "[asset-ingest] failed: {}", e.message);
                continue;
            }
        };
        let (width, height) = if media_type.starts_with("image/") {
            safe_image_size(&buf)
        } else {
            (None, None)
        };
        let ordinal = img
            .get("ordinal")
            .and_then(Value::as_f64)
            .unwrap_or((i + 1) as f64);
        let rows = db.with(|c| {
            let upserted = c.execute(
                UPSERT,
                js_params![
                    written.hash,
                    media_type,
                    buf.len() as f64,
                    bind_dim(width),
                    bind_dim(height),
                    occurred_ms,
                    occurred_ms,
                ],
            )?;
            let used = c.execute(
                USE,
                js_params![written.hash, session_id, message_uuid, ordinal, occurred_ms],
            )?;
            Ok((upserted, used))
        });
        match rows {
            Ok((upserted, used)) => out.push(IngestUseResult {
                hash: written.hash,
                ordinal,
                bytes: buf.len(),
                width,
                height,
                new_on_disk: written.created,
                new_row: upserted > 0 || used > 0,
            }),
            Err(e) => tracing::warn!(target: log::API, "[asset-ingest] failed: {e}"),
        }
    }
    out
}

/// `BackfillProgress` (the route reads none of it).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct BackfillProgress {
    pub total: usize,
    pub scanned: usize,
    pub ingested: usize,
}

/// `metaKey(sessionId)`.
fn meta_key(session_id: &str) -> String {
    format!("last_jsonl_scan_{session_id}")
}

/// `readCursor`: the stored `{mtimeMs, size}`, when it parses and both are
/// numbers.
fn read_cursor(c: &rusqlite::Connection, session_id: &str) -> rusqlite::Result<Option<(f64, f64)>> {
    use rusqlite::OptionalExtension;
    let row: Option<Sql> = c
        .query_row(
            "SELECT value FROM schema_meta WHERE key = ?",
            js_params![meta_key(session_id)],
            |r| sql_text::get(r, 0),
        )
        .optional()?;
    let Some(value) = row else {
        return Ok(None);
    };
    // `JSON.parse(row.value)`: a non-string goes through `String()`.
    let text = match value {
        Sql::Text(t) => t,
        Sql::Integer(n) => n.to_string(),
        Sql::Real(f) => claudius_agent::js::number_to_string(f),
        Sql::Blob(b) => String::from_utf8_lossy(&b).into_owned(),
        Sql::Null => "null".into(),
    };
    let Ok(parsed) = claudius_agent::js::json_parse(&text) else {
        return Ok(None);
    };
    match (parsed.get("mtimeMs"), parsed.get("size")) {
        (Some(Value::Number(m)), Some(Value::Number(s))) => Ok(Some((
            m.as_f64().unwrap_or(f64::NAN),
            s.as_f64().unwrap_or(f64::NAN),
        ))),
        _ => Ok(None),
    }
}

/// `writeCursor`: `JSON.stringify({mtimeMs, size})`.
fn write_cursor(
    c: &rusqlite::Connection,
    session_id: &str,
    mtime: f64,
    size: f64,
) -> rusqlite::Result<()> {
    let value =
        claudius_agent::js::stringify(&json!({"mtimeMs": js_num(mtime), "size": js_num(size)}));
    c.execute(
        "INSERT INTO schema_meta(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
        js_params![meta_key(session_id), value],
    )?;
    Ok(())
}

/// `backfillProject(cwd)` on the real clock.
pub fn backfill_project(cwd: &str) -> anyhow::Result<BackfillProgress> {
    backfill_project_with(cwd, &|| crate::now_ms() as f64)
}

/// `backfillProject(cwd)`: `Err` where TS throws (the database can't be
/// opened, or a cursor can't be written). `now` is `Date.now`; an
/// offset-less timestamp is read in the process's zone (`TZ`), as V8 reads
/// it.
pub fn backfill_project_with(cwd: &str, now: &dyn Fn() -> f64) -> anyhow::Result<BackfillProgress> {
    let home = paths::home_dir().to_string_lossy().into_owned();
    let dir = node_path::join(&[
        &home,
        ".claude",
        "projects",
        &paths::encode_project_dir(cwd),
    ]);
    let Ok(entries) = crate::node_fs::readdir(&dir) else {
        return Ok(BackfillProgress::default());
    };
    let jsonls: Vec<String> = entries
        .into_iter()
        .filter(|n| n.ends_with(".jsonl"))
        .collect();
    let db = open_db(cwd, Mode::ReadWrite)?;
    let mut progress = BackfillProgress {
        total: jsonls.len(),
        ..Default::default()
    };
    for name in &jsonls {
        let path = node_path::join(&[&dir, name]);
        let session_id = name.strip_suffix(".jsonl").unwrap_or(name);
        let Ok(meta) = std::fs::metadata(&path) else {
            progress.scanned += 1;
            continue;
        };
        let (mtime, size) = (
            meta.modified().map_or(0.0, crate::node_fs::mtime_ms),
            meta.len() as f64,
        );
        let cursor = db.with(|c| read_cursor(c, session_id))?;
        if cursor.is_some_and(|(m, s)| m == mtime && s == size) {
            progress.scanned += 1;
            continue;
        }
        match scan_file(cwd, session_id, &path, now) {
            Ok(n) => progress.ingested += n,
            Err(e) => tracing::warn!(target: log::API, "[asset-ingest] scanFile failed: {e}"),
        }
        db.with(|c| write_cursor(c, session_id, mtime, size))?;
        progress.scanned += 1;
    }
    Ok(progress)
}

/// `scanFile`: the images recorded from one transcript.
fn scan_file(
    cwd: &str,
    session_id: &str,
    path: &str,
    now: &dyn Fn() -> f64,
) -> std::io::Result<usize> {
    let bytes = std::fs::read(path)?;
    let text = String::from_utf8_lossy(&bytes);
    let mut count = 0;
    for line in text.split('\n') {
        if !line.starts_with('{') {
            continue;
        }
        let Ok(r) = claudius_agent::js::json_parse(line) else {
            continue;
        };
        if r.get("type").and_then(Value::as_str) != Some("user") {
            continue;
        }
        // `r.message?.content` (a primitive message has no `content`).
        let Some(Value::Array(content)) = r
            .get("message")
            .and_then(|m| m.as_object())
            .and_then(|m| m.get("content"))
        else {
            continue;
        };
        let ts = match r.get("timestamp") {
            Some(Value::String(s)) => date_parse(s).map_or(f64::NAN, |t| t as f64),
            _ => now(),
        };
        let message_uuid = match r.get("uuid") {
            Some(Value::String(u)) => u.clone(),
            _ => format!("{session_id}-{count}"),
        };
        let mut images: Vec<Value> = Vec::new();
        let mut ordinal = 0.0;
        for c in content {
            let source = c
                .get("source")
                .filter(|_| c.get("type").and_then(Value::as_str) == Some("image"));
            let Some(source) = source.and_then(Value::as_object) else {
                continue;
            };
            if source.get("type").and_then(Value::as_str) != Some("base64") {
                continue;
            }
            let Some(Value::String(data)) = source.get("data") else {
                continue;
            };
            ordinal += 1.0;
            // `media_type ?? "application/octet-stream"`. A non-string one
            // fails `extFor` in `recordSendUses` before anything is written
            // (the database is already open), so it's skipped here.
            let media_type = match source.get("media_type") {
                None | Some(Value::Null) => "application/octet-stream".to_owned(),
                Some(Value::String(m)) => m.clone(),
                Some(_) => continue,
            };
            images.push(json!({"data": data, "mediaType": media_type, "ordinal": js_num(ordinal)}));
        }
        if images.is_empty() {
            continue;
        }
        let occurred = if ts.is_finite() { ts } else { now() };
        count += record_send_uses(cwd, session_id, &message_uuid, occurred, &images).len();
    }
    Ok(count)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn base64_like_node() {
        assert_eq!(buffer_from_base64("QUJD"), b"ABC");
        assert_eq!(buffer_from_base64("QUJ D\nRA=="), b"ABCD");
        assert_eq!(buffer_from_base64("QQ==QUJD"), b"A");
        assert_eq!(buffer_from_base64("-_"), [0xfb]);
        assert_eq!(buffer_from_base64("Q"), b"");
        assert_eq!(buffer_from_base64(""), b"");
    }
}
