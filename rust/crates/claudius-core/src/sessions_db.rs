//! Per-project `sessions` / `session_usage` rows — port of
//! `lib/server/sessions-db.ts` (with its legacy `session-titles.json`
//! fallback) and `lib/server/session-usage-db.ts`.
//!
//! Same SQL, same column semantics, so a row written by the TS backend reads
//! back identically here and vice versa.

use std::path::PathBuf;

use claudius_agent::js;
use rusqlite::types::ValueRef;
use rusqlite::{OptionalExtension, params};
use serde::Serialize;
use serde_json::{Map, Value, json};

use crate::db::{Mode, open_db};
use crate::{js_num, now_ms, paths};

#[derive(Clone, Debug, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionGoal {
    pub goal: Option<String>,
    pub achieved: bool,
    pub summary: Option<String>,
    pub set_at: Option<i64>,
    pub achieved_at: Option<i64>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct SessionRow {
    pub id: String,
    pub cwd: String,
    pub title: Option<String>,
    pub model: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
    pub last_seen_at: i64,
}

/// `upsertSession` — title is only written on INSERT; model is COALESCEd.
pub fn upsert_session(
    id: &str,
    cwd: &str,
    model: Option<&str>,
    title: Option<&str>,
) -> anyhow::Result<()> {
    let db = open_db(cwd, Mode::ReadWrite)?;
    let now = now_ms();
    db.with(|c| {
        c.execute(
            "INSERT INTO sessions(id, cwd, title, model, created_at, updated_at, last_seen_at)
             VALUES (?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(id) DO UPDATE SET
               cwd          = excluded.cwd,
               model        = COALESCE(excluded.model, sessions.model),
               last_seen_at = excluded.last_seen_at",
            params![id, cwd, title, model, now, now, now],
        )
    })?;
    Ok(())
}

pub fn touch_session(cwd: &str, id: &str) -> anyhow::Result<()> {
    let db = open_db(cwd, Mode::ReadWrite)?;
    let now = now_ms();
    db.with(|c| {
        c.execute(
            "UPDATE sessions SET updated_at = ?, last_seen_at = ? WHERE id = ?",
            params![now, now, id],
        )
    })?;
    Ok(())
}

/// `getSessionTitle`: the row's title when it isn't empty, as stored (TEXT
/// decoded as lossy UTF-8, like better-sqlite3). Otherwise the legacy
/// `session-titles.json` entry ([`read_legacy_title`]), copied into the row
/// (best effort: only `title` on an existing row, a new row stamped now) and
/// returned untrimmed. Fails when the database can't be opened or read, and
/// on a BLOB title (TS hands back a `Buffer`).
pub fn get_session_title(cwd: &str, id: &str) -> anyhow::Result<Option<String>> {
    let db = open_db(cwd, Mode::ReadWrite)?;
    let t: Option<Option<String>> = db.with(|c| {
        c.query_row(
            "SELECT title FROM sessions WHERE id = ?",
            [id],
            |r| match r.get_ref(0)? {
                ValueRef::Null => Ok(None),
                ValueRef::Text(b) => Ok(Some(String::from_utf8_lossy(b).into_owned())),
                v => Err(rusqlite::Error::InvalidColumnType(
                    0,
                    "title".into(),
                    v.data_type(),
                )),
            },
        )
        .optional()
    })?;
    if let Some(t) = t.flatten().filter(|s| !s.is_empty()) {
        return Ok(Some(t));
    }
    let Some(legacy) = read_legacy_title(id) else {
        return Ok(None);
    };
    let now = now_ms();
    let _ = db.with(|c| {
        c.execute(
            "INSERT INTO sessions(id, cwd, title, created_at, updated_at, last_seen_at)
             VALUES (?, ?, ?, ?, ?, ?)
             ON CONFLICT(id) DO UPDATE SET title = excluded.title",
            params![id, cwd, legacy, now, now, now],
        )
    });
    Ok(Some(legacy))
}

/// `~/.claude/.claudius/session-titles.json`: the cross-cwd title store that
/// predates the per-project database (`lib/server/session-titles.ts`, which
/// nothing imports any more). Only read, never written.
pub fn legacy_titles_path() -> PathBuf {
    paths::claudius_root().join("session-titles.json")
}

/// `readLegacyTitle(id)`: `JSON.parse(file).titles?.[id]` when that is a
/// string JS `trim()` leaves non-empty, returned untrimmed. The file is read
/// as lossy UTF-8 (a BOM stays, and fails the parse); `version` isn't
/// checked. Any read or parse failure is `None`.
pub fn read_legacy_title(id: &str) -> Option<String> {
    let bytes = std::fs::read(legacy_titles_path()).ok()?;
    let parsed = js::json_parse(&String::from_utf8_lossy(&bytes)).ok()?;
    let title = legacy_member(parsed.as_object()?.get("titles")?, id)?;
    (!js::trim(&title).is_empty()).then_some(title)
}

/// `titles[id]` when it is a string: an object's own property, an array's
/// element, or a string's UTF-16 code unit at that index (a lone surrogate
/// becomes U+FFFD, as it would once written out as UTF-8). Inherited
/// properties (`length`, `constructor`, ...) are never strings.
fn legacy_member(titles: &Value, id: &str) -> Option<String> {
    match titles {
        Value::Object(m) => m.get(id)?.as_str().map(str::to_owned),
        Value::Array(a) => a
            .get(js::array_index(id)? as usize)?
            .as_str()
            .map(str::to_owned),
        Value::String(s) => {
            let unit = s.encode_utf16().nth(js::array_index(id)? as usize)?;
            Some(
                char::decode_utf16([unit])
                    .map(|c| c.unwrap_or('\u{fffd}'))
                    .collect(),
            )
        }
        _ => None,
    }
}

/// `getSessionTitlesByCwd(pairs)`: the stored titles for `(cwd, id)` pairs,
/// keyed `{cwd}:{id}`, or `*:{id}` for a pair without a (non-empty) cwd.
/// Pairs with an empty id are skipped.
///
/// Each cwd's DB is probed read-only (one that won't open is passed over);
/// cwd-less ids are looked up in every workspace's DB in store order, the
/// first title winning, until none is missing; any pair still missing then
/// gets the legacy `session-titles.json` entry. Titles are returned
/// untrimmed but only when JS `trim()` leaves something. As in TS, it
/// throws where `.trim()` would land on a non-string (a truthy number or
/// BLOB title, a legacy entry that isn't a string, an inherited property
/// such as `constructor`), on a `null` workspace entry, and on a query
/// error (a DB without the `sessions` table).
pub fn get_session_titles_by_cwd(
    pairs: &[(Option<&str>, &str)],
) -> anyhow::Result<indexmap::IndexMap<String, String>> {
    let mut by_cwd: indexmap::IndexMap<&str, Vec<&str>> = indexmap::IndexMap::new();
    let mut no_cwd: Vec<&str> = Vec::new();
    for &(cwd, id) in pairs {
        if id.is_empty() {
            continue;
        }
        match cwd.filter(|c| !c.is_empty()) {
            Some(cwd) => by_cwd.entry(cwd).or_default().push(id),
            None => no_cwd.push(id),
        }
    }
    let mut out = indexmap::IndexMap::new();
    for (cwd, ids) in &by_cwd {
        probe_titles(cwd, ids, &mut out, false)?;
    }
    if !no_cwd.is_empty() {
        let workspaces = crate::active_cwd::list_workspaces_raw().unwrap_or_default();
        for ws in &workspaces {
            let root = match ws {
                Value::Null => anyhow::bail!("Cannot read properties of null (reading 'rootPath')"),
                Value::Object(m) => m.get("rootPath").filter(|v| js::truthy(v)),
                _ => None,
            };
            let Some(root) = root else { continue };
            let still_missing: Vec<&str> = no_cwd
                .iter()
                .filter(|id| !out.contains_key(&format!("*:{id}")))
                .copied()
                .collect();
            if still_missing.is_empty() {
                break;
            }
            // `openDb` rejects a non-string root, which `probeCwd` catches.
            if let Some(root) = root.as_str() {
                probe_titles(root, &still_missing, &mut out, true)?;
            }
        }
    }
    let Some(legacy) = read_legacy_titles_map() else {
        return Ok(out);
    };
    for &(cwd, id) in pairs {
        if id.is_empty() {
            continue;
        }
        let key = match cwd.filter(|c| !c.is_empty()) {
            Some(cwd) => format!("{cwd}:{id}"),
            None => format!("*:{id}"),
        };
        if out.contains_key(&key) {
            continue;
        }
        match legacy_property(&legacy, id) {
            LegacyProperty::Own(Value::String(t)) => {
                if !js::trim(t).is_empty() {
                    out.insert(key, t.clone());
                }
            }
            LegacyProperty::Own(v) if !js::truthy(v) => {}
            LegacyProperty::Own(_) | LegacyProperty::Inherited => {
                anyhow::bail!("t.trim is not a function")
            }
            LegacyProperty::Undefined => {}
        }
    }
    Ok(out)
}

/// `probeCwd(cwd, ids, out, {unkeyed})`: `SELECT id, title FROM sessions
/// WHERE title IS NOT NULL AND id IN (...)` in chunks of 500 ids, on the
/// read-only handle (no handle: nothing). The first title per key wins.
fn probe_titles(
    cwd: &str,
    ids: &[&str],
    out: &mut indexmap::IndexMap<String, String>,
    unkeyed: bool,
) -> anyhow::Result<()> {
    let Ok(db) = open_db(cwd, Mode::ReadOnly) else {
        return Ok(());
    };
    for chunk in ids.chunks(500) {
        let placeholders = vec!["?"; chunk.len()].join(",");
        let sql = format!(
            "SELECT id, title FROM sessions WHERE title IS NOT NULL AND id IN ({placeholders})"
        );
        let rows = db.with(|c| {
            let mut stmt = c.prepare(&sql)?;
            let rows = stmt.query_map(rusqlite::params_from_iter(chunk.iter()), |r| {
                Ok((js_string(r.get_ref(0)?), probe_title(r.get_ref(1)?)))
            })?;
            rows.collect::<rusqlite::Result<Vec<_>>>()
        })?;
        for (id, title) in rows {
            let Some(title) = title? else { continue };
            let key = if unkeyed {
                format!("*:{id}")
            } else {
                format!("{cwd}:{id}")
            };
            out.entry(key).or_insert(title);
        }
    }
    Ok(())
}

/// `String(v)` for a column value as better-sqlite3 returns it.
fn js_string(v: ValueRef) -> String {
    match v {
        ValueRef::Null => "null".into(),
        ValueRef::Integer(n) => js::number_to_string(n as f64),
        ValueRef::Real(f) if f.is_infinite() => {
            if f > 0.0 { "Infinity" } else { "-Infinity" }.into()
        }
        ValueRef::Real(f) => js::number_to_string(f),
        ValueRef::Text(t) | ValueRef::Blob(t) => String::from_utf8_lossy(t).into_owned(),
    }
}

/// `if (!r.title || !r.title.trim()) continue;` for one row: `Ok(None)` to
/// skip it, an `Err` where `.trim` isn't a function.
fn probe_title(v: ValueRef) -> anyhow::Result<Option<String>> {
    match v {
        ValueRef::Null | ValueRef::Integer(0) => Ok(None),
        // `-0.0` too.
        ValueRef::Real(0.0) => Ok(None),
        ValueRef::Text(t) => {
            let t = String::from_utf8_lossy(t).into_owned();
            Ok((!js::trim(&t).is_empty()).then_some(t))
        }
        _ => anyhow::bail!("r.title.trim is not a function"),
    }
}

/// `readLegacyTitlesMap()`: `JSON.parse(file).titles` when it is an object
/// or array with at least one own key (`Object.keys(...).length > 0`).
fn read_legacy_titles_map() -> Option<Value> {
    let bytes = std::fs::read(legacy_titles_path()).ok()?;
    let parsed = js::json_parse(&String::from_utf8_lossy(&bytes)).ok()?;
    let titles = parsed.as_object()?.get("titles")?;
    let has_keys = match titles {
        Value::Object(m) => !m.is_empty(),
        Value::Array(a) => !a.is_empty(),
        _ => false,
    };
    has_keys.then(|| titles.clone())
}

enum LegacyProperty<'a> {
    Own(&'a Value),
    /// A property of `Object.prototype` (or `Array.prototype`): a function,
    /// the prototype itself, or an array's non-zero `length`; all truthy.
    Inherited,
    Undefined,
}

/// JS `legacy[id]` on the parsed titles object or array.
fn legacy_property<'a>(legacy: &'a Value, id: &str) -> LegacyProperty<'a> {
    use crate::mcp_config::{ARRAY_PROTOTYPE_KEYS, OBJECT_PROTOTYPE_KEYS};
    let own = match legacy {
        Value::Object(m) => m.get(id),
        Value::Array(a) => js::array_index(id).and_then(|n| a.get(n as usize)),
        _ => None,
    };
    if let Some(v) = own {
        return LegacyProperty::Own(v);
    }
    let inherited = OBJECT_PROTOTYPE_KEYS.contains(&id)
        || (legacy.is_array() && ARRAY_PROTOTYPE_KEYS.contains(&id));
    if inherited {
        LegacyProperty::Inherited
    } else {
        LegacyProperty::Undefined
    }
}

/// `setSessionTitle`: the JS-trimmed title; an empty one clears it to NULL.
pub fn set_session_title(cwd: &str, id: &str, title: &str) -> anyhow::Result<()> {
    let trimmed = js::trim(title);
    let db = open_db(cwd, Mode::ReadWrite)?;
    let now = now_ms();
    db.with(|c| {
        if trimmed.is_empty() {
            c.execute(
                "UPDATE sessions SET title = NULL, updated_at = ? WHERE id = ?",
                params![now, id],
            )
        } else {
            c.execute(
                "INSERT INTO sessions(id, cwd, title, created_at, updated_at, last_seen_at)
                 VALUES (?, ?, ?, ?, ?, ?)
                 ON CONFLICT(id) DO UPDATE SET
                   title      = excluded.title,
                   updated_at = excluded.updated_at",
                params![id, cwd, trimmed, now, now, now],
            )
        }
    })?;
    Ok(())
}

fn goal_from_row(c: &rusqlite::Connection, id: &str) -> rusqlite::Result<SessionGoal> {
    let row = c
        .query_row(
            "SELECT goal, goal_achieved, goal_summary, goal_set_at, goal_achieved_at FROM sessions WHERE id = ?",
            [id],
            |r| {
                Ok((
                    r.get::<_, Option<String>>(0)?,
                    r.get::<_, Option<i64>>(1)?,
                    r.get::<_, Option<String>>(2)?,
                    r.get::<_, Option<i64>>(3)?,
                    r.get::<_, Option<i64>>(4)?,
                ))
            },
        )
        .optional()?;
    Ok(match row {
        Some((Some(goal), achieved, summary, set_at, achieved_at)) if !goal.is_empty() => {
            SessionGoal {
                goal: Some(goal),
                achieved: achieved == Some(1),
                summary,
                set_at,
                achieved_at,
            }
        }
        _ => SessionGoal::default(),
    })
}

pub fn get_session_goal(cwd: &str, id: &str) -> SessionGoal {
    let Ok(db) = open_db(cwd, Mode::ReadWrite) else {
        return SessionGoal::default();
    };
    db.with(|c| goal_from_row(c, id)).unwrap_or_default()
}

pub fn set_session_goal(cwd: &str, id: &str, goal: &str) -> anyhow::Result<SessionGoal> {
    let trimmed = goal.trim();
    if trimmed.is_empty() {
        return clear_session_goal(cwd, id);
    }
    let db = open_db(cwd, Mode::ReadWrite)?;
    let now = now_ms();
    db.with(|c| {
        c.execute(
            "INSERT INTO sessions(id, cwd, goal, goal_achieved, goal_summary, goal_set_at, goal_achieved_at, created_at, updated_at, last_seen_at)
             VALUES (?, ?, ?, 0, NULL, ?, NULL, ?, ?, ?)
             ON CONFLICT(id) DO UPDATE SET
               goal             = excluded.goal,
               goal_achieved    = 0,
               goal_summary     = NULL,
               goal_set_at      = excluded.goal_set_at,
               goal_achieved_at = NULL,
               updated_at       = excluded.updated_at",
            params![id, cwd, trimmed, now, now, now, now],
        )
    })?;
    Ok(SessionGoal {
        goal: Some(trimmed.to_owned()),
        achieved: false,
        summary: None,
        set_at: Some(now),
        achieved_at: None,
    })
}

pub fn clear_session_goal(cwd: &str, id: &str) -> anyhow::Result<SessionGoal> {
    let db = open_db(cwd, Mode::ReadWrite)?;
    db.with(|c| {
        c.execute(
            "UPDATE sessions
                SET goal = NULL, goal_achieved = 0, goal_summary = NULL,
                    goal_set_at = NULL, goal_achieved_at = NULL, updated_at = ?
              WHERE id = ?",
            params![now_ms(), id],
        )
    })?;
    Ok(SessionGoal::default())
}

pub fn set_goal_achieved(cwd: &str, id: &str, summary: &str) -> anyhow::Result<SessionGoal> {
    let db = open_db(cwd, Mode::ReadWrite)?;
    let now = now_ms();
    let clean = Some(summary.trim()).filter(|s| !s.is_empty());
    Ok(db.with(|c| {
        c.execute(
            "UPDATE sessions
                SET goal_achieved = 1, goal_summary = ?, goal_achieved_at = ?, updated_at = ?
              WHERE id = ? AND goal IS NOT NULL",
            params![clean, now, now, id],
        )?;
        goal_from_row(c, id)
    })?)
}

pub fn get_session_state(cwd: &str, id: &str) -> Map<String, Value> {
    let Ok(db) = open_db(cwd, Mode::ReadWrite) else {
        return Map::new();
    };
    let raw: Option<Option<String>> = db
        .with(|c| {
            c.query_row("SELECT state FROM sessions WHERE id = ?", [id], |r| {
                r.get(0)
            })
            .optional()
        })
        .unwrap_or(None);
    match raw
        .flatten()
        .and_then(|s| serde_json::from_str::<Value>(&s).ok())
    {
        Some(Value::Object(m)) => m,
        _ => Map::new(),
    }
}

pub fn merge_session_state(cwd: &str, id: &str, patch: Map<String, Value>) -> anyhow::Result<()> {
    let mut current = get_session_state(cwd, id);
    for (k, v) in patch {
        current.insert(k, v);
    }
    let next = serde_json::to_string(&Value::Object(current))?;
    let db = open_db(cwd, Mode::ReadWrite)?;
    let now = now_ms();
    db.with(|c| {
        c.execute(
            "INSERT INTO sessions(id, cwd, state, created_at, updated_at, last_seen_at)
             VALUES (?, ?, ?, ?, ?, ?)
             ON CONFLICT(id) DO UPDATE SET
               state      = excluded.state,
               updated_at = excluded.updated_at",
            params![id, cwd, next, now, now, now],
        )
    })?;
    Ok(())
}

pub fn list_indexed_sessions(cwd: &str) -> anyhow::Result<Vec<SessionRow>> {
    let db = open_db(cwd, Mode::ReadWrite)?;
    Ok(db.with(|c| {
        let mut st = c.prepare(
            "SELECT id, cwd, title, model, created_at, updated_at, last_seen_at FROM sessions ORDER BY updated_at DESC",
        )?;
        let rows = st.query_map([], |r| {
            Ok(SessionRow {
                id: r.get(0)?,
                cwd: r.get(1)?,
                title: r.get(2)?,
                model: r.get(3)?,
                created_at: r.get(4)?,
                updated_at: r.get(5)?,
                last_seen_at: r.get(6)?,
            })
        })?;
        rows.collect()
    })?)
}

/// `recordSuggestedMessage` / `recordGoalMessage`.
pub fn record_tagged_message(
    cwd: &str,
    goal: bool,
    session_id: &str,
    message_uuid: &str,
    text: &str,
) -> anyhow::Result<()> {
    if session_id.is_empty() || message_uuid.is_empty() {
        return Ok(());
    }
    let db = open_db(cwd, Mode::ReadWrite)?;
    let sql = if goal {
        "INSERT INTO goal_messages(session_id, message_uuid, goal_text, created_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(session_id, message_uuid) DO UPDATE SET goal_text = excluded.goal_text"
    } else {
        "INSERT INTO suggested_messages(session_id, message_uuid, suggestion_text, created_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(session_id, message_uuid) DO UPDATE SET suggestion_text = excluded.suggestion_text"
    };
    db.with(|c| c.execute(sql, params![session_id, message_uuid, text, now_ms()]))?;
    Ok(())
}

/// `setPromptDraft` (text + `PromptDraftImage[]` JSON); empty clears.
pub fn set_prompt_draft(
    cwd: &str,
    session_id: &str,
    text: &str,
    images: &Value,
) -> anyhow::Result<()> {
    let db = open_db(cwd, Mode::ReadWrite)?;
    let empty_images = images.as_array().is_none_or(|a| a.is_empty());
    if text.is_empty() && empty_images {
        db.with(|c| {
            c.execute(
                "DELETE FROM prompt_drafts WHERE session_id = ?",
                [session_id],
            )
        })?;
        return Ok(());
    }
    db.with(|c| {
        c.execute(
            "INSERT INTO prompt_drafts(session_id, text, images, updated_at) VALUES (?, ?, ?, ?)
             ON CONFLICT(session_id) DO UPDATE SET text = excluded.text, images = excluded.images, updated_at = excluded.updated_at",
            params![session_id, text, images.to_string(), now_ms()],
        )
    })?;
    Ok(())
}

/// `getPromptDraft` → `{text, images, updatedAt}` or `None`. Images that
/// don't match the `PromptDraftImage` shape are dropped (`parseImages`).
pub fn get_prompt_draft(cwd: &str, session_id: &str) -> Option<Value> {
    let db = open_db(cwd, Mode::ReadOnly).ok()?;
    let row: Option<(String, String, f64)> = db
        .with(|c| {
            c.query_row(
                "SELECT text, images, updated_at FROM prompt_drafts WHERE session_id = ?",
                [session_id],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .optional()
        })
        .ok()
        .flatten();
    let (text, images, updated_at) = row?;
    let images: Vec<Value> = match serde_json::from_str::<Value>(&images) {
        Ok(Value::Array(a)) => a
            .into_iter()
            .filter(|x| {
                x.get("id").is_some_and(Value::is_string)
                    && x.get("ordinal").is_some_and(Value::is_number)
                    && x.get("data").is_some_and(Value::is_string)
                    && x.get("mediaType").is_some_and(Value::is_string)
            })
            .collect(),
        _ => vec![],
    };
    Some(json!({"text": text, "images": images, "updatedAt": js_num(updated_at)}))
}

/// `clearPromptDraft` — best-effort.
pub fn clear_prompt_draft(cwd: &str, session_id: &str) {
    if let Ok(db) = open_db(cwd, Mode::ReadWrite) {
        let _ = db.with(|c| {
            c.execute(
                "DELETE FROM prompt_drafts WHERE session_id = ?",
                [session_id],
            )
        });
    }
}

/// `listGoalMessageUuids` / `listSuggestedMessageUuids` — empty on any error.
pub fn list_tagged_message_uuids(cwd: &str, goal: bool, session_id: &str) -> Vec<String> {
    let Ok(db) = open_db(cwd, Mode::ReadOnly) else {
        return vec![];
    };
    let sql = if goal {
        "SELECT message_uuid FROM goal_messages WHERE session_id = ?"
    } else {
        "SELECT message_uuid FROM suggested_messages WHERE session_id = ?"
    };
    db.with(|c| {
        let mut st = c.prepare(sql)?;
        let rows = st.query_map([session_id], |r| r.get::<_, String>(0))?;
        rows.collect::<Result<Vec<_>, _>>()
    })
    .unwrap_or_default()
}

// ───────────────────────────── session_usage ─────────────────────────────

/// `SessionUsageTotals`. Numbers are f64 like the JS side; serialize with
/// [`UsageTotals::to_json`] so integral values print as `3`, not `3.0`.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct UsageTotals {
    pub total_cost_usd: f64,
    pub num_turns: f64,
    pub duration_ms: f64,
    pub duration_api_ms: f64,
    pub input_tokens: f64,
    pub output_tokens: f64,
    pub cache_read_input_tokens: f64,
    pub cache_creation_input_tokens: f64,
    pub model_usage: Option<Map<String, Value>>,
}

const ADDITIVE_MODEL_USAGE_FIELDS: [&str; 7] = [
    "inputTokens",
    "outputTokens",
    "thinkingTokens",
    "cacheReadInputTokens",
    "cacheCreationInputTokens",
    "webSearchRequests",
    "costUSD",
];

/// `mergeModelUsage`.
pub fn merge_model_usage(
    base: Option<&Map<String, Value>>,
    next: Option<&Map<String, Value>>,
) -> Option<Map<String, Value>> {
    let (base, next) = match (base, next) {
        (None, n) => return n.cloned(),
        (b, None) => return b.cloned(),
        (Some(b), Some(n)) => (b, n),
    };
    let mut out = base.clone();
    for (model, raw_next) in next {
        match (out.get(model), raw_next) {
            (Some(Value::Object(prev)), Value::Object(nx)) => {
                let mut merged = prev.clone();
                for (field, value) in nx {
                    let v = match (merged.get(field).and_then(Value::as_f64), value.as_f64()) {
                        (Some(b), Some(n))
                            if ADDITIVE_MODEL_USAGE_FIELDS.contains(&field.as_str()) =>
                        {
                            js_num(b + n)
                        }
                        _ => value.clone(),
                    };
                    merged.insert(field.clone(), v);
                }
                out.insert(model.clone(), Value::Object(merged));
            }
            _ => {
                out.insert(model.clone(), raw_next.clone());
            }
        }
    }
    Some(out)
}

impl UsageTotals {
    pub fn to_json(&self) -> Value {
        let mut m = Map::new();
        m.insert("totalCostUsd".into(), js_num(self.total_cost_usd));
        m.insert("numTurns".into(), js_num(self.num_turns));
        m.insert("durationMs".into(), js_num(self.duration_ms));
        m.insert("durationApiMs".into(), js_num(self.duration_api_ms));
        m.insert("inputTokens".into(), js_num(self.input_tokens));
        m.insert("outputTokens".into(), js_num(self.output_tokens));
        m.insert(
            "cacheReadInputTokens".into(),
            js_num(self.cache_read_input_tokens),
        );
        m.insert(
            "cacheCreationInputTokens".into(),
            js_num(self.cache_creation_input_tokens),
        );
        if let Some(mu) = &self.model_usage {
            m.insert("modelUsage".into(), Value::Object(mu.clone()));
        }
        Value::Object(m)
    }
}

/// `SdkCumulativeUsage` (lib/server/sdk-cost-state.ts): the SDK's
/// process-cumulative counters as last seen for one CLI process — or, before
/// its first `result`, what it restored from the transcript's `cost-state`
/// checkpoint ([`crate::sdk_cost_state::last_recorded_cost_state`]).
#[derive(Clone, Debug, Default, PartialEq)]
pub struct SdkCumulative {
    pub total_cost_usd: f64,
    pub duration_api_ms: f64,
    pub model_usage: Option<Map<String, Value>>,
}

impl SdkCumulative {
    /// `{totalCostUsd, durationApiMs, modelUsage?}`, the TS object's shape.
    pub fn to_json(&self) -> Value {
        let mut m = Map::new();
        m.insert("totalCostUsd".into(), js_num(self.total_cost_usd));
        m.insert("durationApiMs".into(), js_num(self.duration_api_ms));
        if let Some(mu) = &self.model_usage {
            m.insert("modelUsage".into(), Value::Object(mu.clone()));
        }
        Value::Object(m)
    }
}

/// `modelUsageDelta`: per-model counter growth from `prev` to `cur`. A
/// counter that shrank restarted, so its whole current value is new; other
/// fields are carried from `cur`. Non-object (and array) entries are skipped.
fn model_usage_delta(
    cur: &Map<String, Value>,
    prev: Option<&Map<String, Value>>,
) -> Map<String, Value> {
    let mut out = Map::new();
    for (model, raw_cur) in js::own_keys_order(cur) {
        let Value::Object(cur_entry) = raw_cur else {
            continue;
        };
        let prev_entry = prev.and_then(|p| p.get(model)).and_then(Value::as_object);
        let mut entry = Map::new();
        for (field, value) in js::own_keys_order(cur_entry) {
            let was = prev_entry
                .and_then(|p| p.get(field))
                .and_then(Value::as_f64);
            let v = match (value.as_f64(), was) {
                (Some(v), Some(was))
                    if ADDITIVE_MODEL_USAGE_FIELDS.contains(&field.as_str()) && v >= was =>
                {
                    js_num(v - was)
                }
                _ => value.clone(),
            };
            entry.insert(field.clone(), v);
        }
        out.insert(model.clone(), Value::Object(entry));
    }
    out
}

/// `foldResultIntoSessionUsage(totals, last, message)` → `(totals, last)`,
/// or `None` for a frame that carries no usage (zeroed crash/startup result,
/// empty queued-completion result).
///
/// `num_turns` and `duration_ms` are PER-TURN (summed); `total_cost_usd`,
/// `modelUsage` and `duration_api_ms` are PROCESS-CUMULATIVE (only their
/// growth since `last` is added). Only a decrease in `total_cost_usd` is a
/// reset (`/clear`, or a CLI that didn't restore the seeded checkpoint),
/// after which the whole cumulative value is new.
pub fn fold_result_into_usage(
    totals: &UsageTotals,
    last: &SdkCumulative,
    message: &Value,
) -> Option<(UsageTotals, SdkCumulative)> {
    // `typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0`
    let num = |v: Option<&Value>| {
        v.and_then(Value::as_f64)
            .filter(|f| f.is_finite() && *f > 0.0)
            .unwrap_or(0.0)
    };
    let cost = num(message.get("total_cost_usd"));
    let turns = num(message.get("num_turns"));
    let duration_ms = num(message.get("duration_ms"));
    let duration_api_ms = num(message.get("duration_api_ms"));
    let model_usage = message
        .get("modelUsage")
        .and_then(Value::as_object)
        .filter(|m| !m.is_empty());
    if cost == 0.0 && turns == 0.0 && model_usage.is_none() {
        return None;
    }

    let zero = SdkCumulative::default();
    let prev = if cost < last.total_cost_usd - 1e-9 {
        &zero
    } else {
        last
    };
    // `Math.max(0, …)`; the difference is never NaN here.
    let cost_delta = (cost - prev.total_cost_usd).max(0.0);
    let api_delta = if duration_api_ms >= prev.duration_api_ms {
        duration_api_ms - prev.duration_api_ms
    } else {
        duration_api_ms
    };

    let (mut i, mut o, mut cr, mut cc) = (0.0, 0.0, 0.0, 0.0);
    let mut delta: Option<Map<String, Value>> = None;
    if let Some(mu) = model_usage {
        let d = model_usage_delta(mu, prev.model_usage.as_ref());
        for (_, entry) in js::own_keys_order(&d) {
            i += num(entry.get("inputTokens"));
            o += num(entry.get("outputTokens"));
            cr += num(entry.get("cacheReadInputTokens"));
            cc += num(entry.get("cacheCreationInputTokens"));
        }
        delta = Some(d);
    } else if let Some(u) = message.get("usage").filter(|u| u.is_object()) {
        i = num(u.get("input_tokens"));
        o = num(u.get("output_tokens"));
        cr = num(u.get("cache_read_input_tokens"));
        cc = num(u.get("cache_creation_input_tokens"));
    }

    Some((
        UsageTotals {
            total_cost_usd: totals.total_cost_usd + cost_delta,
            num_turns: totals.num_turns + turns,
            duration_ms: totals.duration_ms + duration_ms,
            duration_api_ms: totals.duration_api_ms + api_delta,
            input_tokens: totals.input_tokens + i,
            output_tokens: totals.output_tokens + o,
            cache_read_input_tokens: totals.cache_read_input_tokens + cr,
            cache_creation_input_tokens: totals.cache_creation_input_tokens + cc,
            model_usage: merge_model_usage(totals.model_usage.as_ref(), delta.as_ref()),
        },
        SdkCumulative {
            total_cost_usd: cost,
            duration_api_ms,
            model_usage: model_usage.cloned().or_else(|| prev.model_usage.clone()),
        },
    ))
}

pub fn get_session_usage(cwd: &str, session_id: &str) -> Option<UsageTotals> {
    let db = open_db(cwd, Mode::ReadWrite).ok()?;
    db.with(|c| {
        c.query_row(
            "SELECT total_cost_usd, num_turns, duration_ms, duration_api_ms,
                    input_tokens, output_tokens, cache_read_input_tokens,
                    cache_creation_input_tokens, model_usage_json
               FROM session_usage WHERE session_id = ?",
            [session_id],
            |r| {
                let mu: Option<String> = r.get(8)?;
                Ok(UsageTotals {
                    total_cost_usd: r.get(0)?,
                    num_turns: r.get::<_, f64>(1)?,
                    duration_ms: r.get::<_, f64>(2)?,
                    duration_api_ms: r.get::<_, f64>(3)?,
                    input_tokens: r.get::<_, f64>(4)?,
                    output_tokens: r.get::<_, f64>(5)?,
                    cache_read_input_tokens: r.get::<_, f64>(6)?,
                    cache_creation_input_tokens: r.get::<_, f64>(7)?,
                    model_usage: mu.and_then(|s| match serde_json::from_str::<Value>(&s) {
                        Ok(Value::Object(m)) => Some(m),
                        _ => None,
                    }),
                })
            },
        )
        .optional()
    })
    .ok()
    .flatten()
}

pub fn save_session_usage(cwd: &str, session_id: &str, u: &UsageTotals) -> anyhow::Result<()> {
    let db = open_db(cwd, Mode::ReadWrite)?;
    let mu = u
        .model_usage
        .as_ref()
        .map(serde_json::to_string)
        .transpose()?;
    // JS `Math.round`, bound as a REAL: the INTEGER columns store it as an
    // integer when it fits (better-sqlite3 binds a JS number the same way, so
    // `1e21` stays a REAL instead of saturating, and a `-0` lands as `0`).
    let r = crate::loop_ticks_db::math_round;
    db.with(|c| {
        c.execute(
            "INSERT INTO session_usage(session_id, total_cost_usd, num_turns, duration_ms,
               duration_api_ms, input_tokens, output_tokens, cache_read_input_tokens,
               cache_creation_input_tokens, model_usage_json, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(session_id) DO UPDATE SET
               total_cost_usd = excluded.total_cost_usd,
               num_turns = excluded.num_turns,
               duration_ms = excluded.duration_ms,
               duration_api_ms = excluded.duration_api_ms,
               input_tokens = excluded.input_tokens,
               output_tokens = excluded.output_tokens,
               cache_read_input_tokens = excluded.cache_read_input_tokens,
               cache_creation_input_tokens = excluded.cache_creation_input_tokens,
               model_usage_json = excluded.model_usage_json,
               updated_at = excluded.updated_at",
            params![
                session_id,
                u.total_cost_usd,
                r(u.num_turns),
                r(u.duration_ms),
                r(u.duration_api_ms),
                r(u.input_tokens),
                r(u.output_tokens),
                r(u.cache_read_input_tokens),
                r(u.cache_creation_input_tokens),
                mu,
                now_ms()
            ],
        )
    })?;
    Ok(())
}

pub fn goal_event(goal: &SessionGoal) -> Value {
    json!({
        "type": "goal_changed",
        "goal": goal.goal,
        "achieved": goal.achieved,
        "summary": goal.summary,
        "setAt": goal.set_at,
        "achievedAt": goal.achieved_at,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fold_sums_per_turn_fields_and_adds_cumulative_growth() {
        let z = UsageTotals::default();
        let l0 = SdkCumulative::default();
        // A long turn, then a shorter one: `num_turns` drops, which is NOT a
        // reset (the old fold re-banked the whole cost here).
        let r1 = json!({"type":"result","total_cost_usd":10.0,"num_turns":40,"duration_ms":5,
                        "modelUsage":{"m":{"outputTokens":1000,"costUSD":10.0}}});
        let (t, l) = fold_result_into_usage(&z, &l0, &r1).unwrap();
        let r2 = json!({"type":"result","total_cost_usd":11.0,"num_turns":3,"duration_ms":7,
                        "modelUsage":{"m":{"outputTokens":1100,"costUSD":11.0}}});
        let (t, l) = fold_result_into_usage(&t, &l, &r2).unwrap();
        assert_eq!(t.total_cost_usd, 11.0);
        assert_eq!(t.num_turns, 43.0);
        assert_eq!(t.duration_ms, 12.0);
        assert_eq!(t.output_tokens, 1100.0);
        assert_eq!(t.model_usage.as_ref().unwrap()["m"]["costUSD"], json!(11));
        // A /clear: cumulative cost restarts, so all of it is new.
        let r3 = json!({"type":"result","total_cost_usd":0.5,"num_turns":1,
                        "modelUsage":{"m":{"outputTokens":50,"costUSD":0.5}}});
        let (t, l) = fold_result_into_usage(&t, &l, &r3).unwrap();
        assert_eq!(t.total_cost_usd, 11.5);
        assert_eq!(t.output_tokens, 1150.0);
        assert_eq!(l.total_cost_usd, 0.5);
        // A zeroed frame contributes nothing.
        assert!(
            fold_result_into_usage(&t, &l, &json!({"type":"result","duration_ms":9})).is_none()
        );
    }
}
