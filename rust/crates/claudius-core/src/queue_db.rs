//! Server-side message queue (`queued_messages`) — port of
//! `lib/server/queued-messages-db.ts`.

use rusqlite::{OptionalExtension, Row, params};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use crate::db::{Mode, open_db};
use crate::sql_text::get;
use crate::{js_params, now_ms};

/// `{data, mediaType, ordinal?}` — an inline image attached to a prompt.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImageInput {
    pub data: String,
    pub media_type: String,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        serialize_with = "ser_js_num"
    )]
    pub ordinal: Option<f64>,
}

fn ser_js_num<S: serde::Serializer>(v: &Option<f64>, s: S) -> Result<S::Ok, S::Error> {
    match v {
        Some(f) => crate::js_num(*f).serialize(s),
        None => s.serialize_none(),
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct QueuedRow {
    pub uuid: String,
    pub session_id: String,
    pub position: i64,
    pub text: String,
    /// `JSON.parse(images_json)` when that is an array, its elements as
    /// stored (whatever the sender put in them).
    pub images: Option<Vec<Value>>,
    pub slash: bool,
    pub from_suggestion: bool,
    pub from_goal: bool,
    pub created_at_ms: i64,
}

impl QueuedRow {
    /// `toQueueMeta` — the SSE-safe view (no image payloads).
    pub fn meta(&self) -> Value {
        let mut m = serde_json::Map::new();
        m.insert("uuid".into(), json!(self.uuid));
        m.insert("text".into(), json!(self.text));
        if self.slash {
            m.insert("slash".into(), json!(true));
        }
        if self.from_suggestion {
            m.insert("fromSuggestion".into(), json!(true));
        }
        if self.from_goal {
            m.insert("fromGoal".into(), json!(true));
        }
        if self.images.as_ref().is_some_and(|i| !i.is_empty()) {
            m.insert("hasImages".into(), json!(true));
        }
        m.insert("createdAtMs".into(), json!(self.created_at_ms));
        Value::Object(m)
    }
}

const COLS: &str = "uuid, session_id, position, text, images_json, slash, from_suggestion, from_goal, created_at_ms";

fn to_row(r: &Row) -> rusqlite::Result<QueuedRow> {
    let images_json: Option<String> = get(r, 4)?;
    Ok(QueuedRow {
        uuid: get(r, 0)?,
        session_id: get(r, 1)?,
        position: r.get(2)?,
        text: get(r, 3)?,
        images: images_json.as_deref().and_then(parse_images),
        slash: r.get::<_, i64>(5)? == 1,
        from_suggestion: r.get::<_, i64>(6)? == 1,
        from_goal: r.get::<_, i64>(7)? == 1,
        created_at_ms: r.get(8)?,
    })
}

/// `toRow`'s images: `if (r.images_json)`, then `JSON.parse`, kept when it
/// is an array.
fn parse_images(images_json: &str) -> Option<Vec<Value>> {
    if images_json.is_empty() {
        return None;
    }
    match claudius_agent::js::json_parse(images_json) {
        Ok(Value::Array(a)) => Some(a),
        _ => None,
    }
}

/// `input.images && input.images.length > 0 ? JSON.stringify(input.images)
/// : null`, on the value the sender posted.
fn raw_images_json(images: Option<&Value>) -> Option<String> {
    use claudius_agent::js;
    let v = images?;
    let length_positive = match v {
        Value::Array(a) => !a.is_empty(),
        Value::String(s) => !s.is_empty(),
        // `obj.length > 0`: the comparison converts the property to a number.
        Value::Object(o) => match o.get("length") {
            None | Some(Value::Null) => false,
            Some(Value::Number(n)) => n.as_f64().is_some_and(|n| n > 0.0),
            Some(Value::Bool(b)) => *b,
            Some(l) => js::to_number(&js::to_string(Some(l))) > 0.0,
        },
        // A primitive's `length` is `undefined` (and `false`, `0`, `null` are falsy).
        _ => false,
    };
    length_positive.then(|| js::stringify(v))
}

fn images_json(images: Option<&[ImageInput]>) -> Option<String> {
    images
        .filter(|i| !i.is_empty())
        .and_then(|i| serde_json::to_string(i).ok())
}

pub fn list_queue(cwd: &str, session_id: &str) -> Vec<QueuedRow> {
    let Ok(db) = open_db(cwd, Mode::ReadWrite) else {
        return vec![];
    };
    db.with(|c| {
        let mut st = c.prepare(&format!(
            "SELECT {COLS} FROM queued_messages WHERE session_id = ? ORDER BY position ASC"
        ))?;
        let rows = st.query_map(js_params![session_id], to_row)?;
        rows.collect()
    })
    .unwrap_or_default()
}

#[derive(Default)]
pub struct NewQueued<'a> {
    pub session_id: &'a str,
    pub uuid: &'a str,
    pub text: &'a str,
    /// The images as posted (`JSON.stringify`ed as they are).
    pub images: Option<&'a Value>,
    pub slash: bool,
    pub from_suggestion: bool,
    pub from_goal: bool,
}

pub fn enqueue_tail(cwd: &str, input: NewQueued) -> anyhow::Result<QueuedRow> {
    let db = open_db(cwd, Mode::ReadWrite)?;
    let ij = raw_images_json(input.images);
    Ok(db.with_mut(|c| {
        let tx = c.transaction()?;
        let position: i64 = tx.query_row(
            "SELECT COALESCE(MAX(position) + 1, 0) FROM queued_messages WHERE session_id = ?",
            js_params![input.session_id],
            |r| r.get(0),
        )?;
        let created = now_ms();
        tx.execute(
            "INSERT INTO queued_messages (uuid, session_id, position, text, images_json, slash, from_suggestion, from_goal, created_at_ms)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
            js_params![
                input.uuid,
                input.session_id,
                position,
                input.text,
                ij,
                input.slash as i64,
                input.from_suggestion as i64,
                input.from_goal as i64,
                created
            ],
        )?;
        tx.commit()?;
        Ok(QueuedRow {
            uuid: input.uuid.to_owned(),
            session_id: input.session_id.to_owned(),
            position,
            text: input.text.to_owned(),
            images: ij.as_deref().and_then(parse_images),
            slash: input.slash,
            from_suggestion: input.from_suggestion,
            from_goal: input.from_goal,
            created_at_ms: created,
        })
    })?)
}

fn pop_where(cwd: &str, session_id: &str, uuid: Option<&str>) -> anyhow::Result<Option<QueuedRow>> {
    let db = open_db(cwd, Mode::ReadWrite)?;
    Ok(db.with_mut(|c| {
        let tx = c.transaction()?;
        let row = match uuid {
            None => tx
                .query_row(
                    &format!("SELECT {COLS} FROM queued_messages WHERE session_id = ? ORDER BY position ASC LIMIT 1"),
                    js_params![session_id],
                    to_row,
                )
                .optional()?,
            Some(u) => tx
                .query_row(
                    &format!("SELECT {COLS} FROM queued_messages WHERE session_id = ? AND uuid = ?"),
                    js_params![session_id, u],
                    to_row,
                )
                .optional()?,
        };
        if let Some(r) = &row {
            tx.execute("DELETE FROM queued_messages WHERE uuid = ?", [&r.uuid])?;
        }
        tx.commit()?;
        Ok(row)
    })?)
}

pub fn pop_head(cwd: &str, session_id: &str) -> anyhow::Result<Option<QueuedRow>> {
    pop_where(cwd, session_id, None)
}

pub fn pop_by_uuid(cwd: &str, session_id: &str, uuid: &str) -> anyhow::Result<Option<QueuedRow>> {
    pop_where(cwd, session_id, Some(uuid))
}

pub fn remove_by_uuid(cwd: &str, session_id: &str, uuid: &str) -> anyhow::Result<bool> {
    let db = open_db(cwd, Mode::ReadWrite)?;
    Ok(db.with(|c| {
        c.execute(
            "DELETE FROM queued_messages WHERE session_id = ? AND uuid = ?",
            js_params![session_id, uuid],
        )
    })? > 0)
}

/// `updateByUuid`. `images`: `None` = leave, `Some(None)`/`Some(empty)` = clear.
pub fn update_by_uuid(
    cwd: &str,
    session_id: &str,
    uuid: &str,
    text: Option<&str>,
    images: Option<Option<&[ImageInput]>>,
) -> anyhow::Result<bool> {
    if text.is_none() && images.is_none() {
        return Ok(false);
    }
    let db = open_db(cwd, Mode::ReadWrite)?;
    let n = db.with(|c| match (text, images) {
        (Some(t), Some(i)) => c.execute(
            "UPDATE queued_messages SET text = ?, images_json = ? WHERE session_id = ? AND uuid = ?",
            js_params![t, images_json(i), session_id, uuid],
        ),
        (Some(t), None) => {
            c.execute("UPDATE queued_messages SET text = ? WHERE session_id = ? AND uuid = ?", js_params![t, session_id, uuid])
        }
        (None, Some(i)) => c.execute(
            "UPDATE queued_messages SET images_json = ? WHERE session_id = ? AND uuid = ?",
            js_params![images_json(i), session_id, uuid],
        ),
        (None, None) => Ok(0),
    })?;
    Ok(n > 0)
}

pub fn move_by_uuid(cwd: &str, session_id: &str, uuid: &str, up: bool) -> anyhow::Result<bool> {
    let db = open_db(cwd, Mode::ReadWrite)?;
    Ok(db.with_mut(|c| {
        let tx = c.transaction()?;
        let me: Option<(String, i64)> = tx
            .query_row(
                "SELECT uuid, position FROM queued_messages WHERE session_id = ? AND uuid = ?",
                js_params![session_id, uuid],
                |r| Ok((get(r, 0)?, r.get(1)?)),
            )
            .optional()?;
        let Some((me_uuid, me_pos)) = me else { return Ok(false) };
        let sql = if up {
            "SELECT uuid, position FROM queued_messages WHERE session_id = ? AND position < ? ORDER BY position DESC LIMIT 1"
        } else {
            "SELECT uuid, position FROM queued_messages WHERE session_id = ? AND position > ? ORDER BY position ASC LIMIT 1"
        };
        let nb: Option<(String, i64)> =
            tx.query_row(sql, js_params![session_id, me_pos], |r| Ok((get(r, 0)?, r.get(1)?))).optional()?;
        let Some((nb_uuid, nb_pos)) = nb else { return Ok(false) };
        tx.execute("UPDATE queued_messages SET position = -1 WHERE uuid = ?", [&me_uuid])?;
        tx.execute("UPDATE queued_messages SET position = ? WHERE uuid = ?", params![me_pos, nb_uuid])?;
        tx.execute("UPDATE queued_messages SET position = ? WHERE uuid = ?", params![nb_pos, me_uuid])?;
        tx.commit()?;
        Ok(true)
    })?)
}

pub fn clear_all(cwd: &str, session_id: &str) -> anyhow::Result<()> {
    let db = open_db(cwd, Mode::ReadWrite)?;
    db.with(|c| {
        c.execute(
            "DELETE FROM queued_messages WHERE session_id = ?",
            js_params![session_id],
        )
    })?;
    Ok(())
}
