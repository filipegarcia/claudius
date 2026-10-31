//! Server-side message queue (`queued_messages`) — port of
//! `lib/server/queued-messages-db.ts`.

use rusqlite::{OptionalExtension, Row, params};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use crate::db::{Mode, open_db};
use crate::now_ms;

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
    pub images: Option<Vec<ImageInput>>,
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
    let images_json: Option<String> = r.get(4)?;
    Ok(QueuedRow {
        uuid: r.get(0)?,
        session_id: r.get(1)?,
        position: r.get(2)?,
        text: r.get(3)?,
        images: images_json.and_then(|s| serde_json::from_str::<Vec<ImageInput>>(&s).ok()),
        slash: r.get::<_, i64>(5)? == 1,
        from_suggestion: r.get::<_, i64>(6)? == 1,
        from_goal: r.get::<_, i64>(7)? == 1,
        created_at_ms: r.get(8)?,
    })
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
        let rows = st.query_map([session_id], to_row)?;
        rows.collect()
    })
    .unwrap_or_default()
}

#[derive(Default)]
pub struct NewQueued<'a> {
    pub session_id: &'a str,
    pub uuid: &'a str,
    pub text: &'a str,
    pub images: Option<&'a [ImageInput]>,
    pub slash: bool,
    pub from_suggestion: bool,
    pub from_goal: bool,
}

pub fn enqueue_tail(cwd: &str, input: NewQueued) -> anyhow::Result<QueuedRow> {
    let db = open_db(cwd, Mode::ReadWrite)?;
    let ij = images_json(input.images);
    Ok(db.with_mut(|c| {
        let tx = c.transaction()?;
        let position: i64 = tx.query_row(
            "SELECT COALESCE(MAX(position) + 1, 0) FROM queued_messages WHERE session_id = ?",
            [input.session_id],
            |r| r.get(0),
        )?;
        let created = now_ms();
        tx.execute(
            "INSERT INTO queued_messages (uuid, session_id, position, text, images_json, slash, from_suggestion, from_goal, created_at_ms)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
            params![
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
            images: input.images.filter(|i| !i.is_empty()).map(<[ImageInput]>::to_vec),
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
                    [session_id],
                    to_row,
                )
                .optional()?,
            Some(u) => tx
                .query_row(
                    &format!("SELECT {COLS} FROM queued_messages WHERE session_id = ? AND uuid = ?"),
                    [session_id, u],
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
            [session_id, uuid],
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
            params![t, images_json(i), session_id, uuid],
        ),
        (Some(t), None) => {
            c.execute("UPDATE queued_messages SET text = ? WHERE session_id = ? AND uuid = ?", params![t, session_id, uuid])
        }
        (None, Some(i)) => c.execute(
            "UPDATE queued_messages SET images_json = ? WHERE session_id = ? AND uuid = ?",
            params![images_json(i), session_id, uuid],
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
                [session_id, uuid],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()?;
        let Some((me_uuid, me_pos)) = me else { return Ok(false) };
        let sql = if up {
            "SELECT uuid, position FROM queued_messages WHERE session_id = ? AND position < ? ORDER BY position DESC LIMIT 1"
        } else {
            "SELECT uuid, position FROM queued_messages WHERE session_id = ? AND position > ? ORDER BY position ASC LIMIT 1"
        };
        let nb: Option<(String, i64)> =
            tx.query_row(sql, params![session_id, me_pos], |r| Ok((r.get(0)?, r.get(1)?))).optional()?;
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
            [session_id],
        )
    })?;
    Ok(())
}
