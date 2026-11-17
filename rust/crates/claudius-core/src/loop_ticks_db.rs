//! `lib/server/loop-ticks-db.ts`: the history of dynamic-`/loop`
//! (`ScheduleWakeup`) ticks behind the Cost page's Loops breakdown (Claude
//! Code 2.1.243 parity). One row per observed tick; `tokens` stays NULL until
//! the tick's turn ends with a `result`. Lives in the per-cwd database, like
//! `session_tasks`.

use rusqlite::types::ValueRef;
use rusqlite::{OptionalExtension, params};
use serde_json::{Value, json};

use crate::db::{Mode, open_db};
use crate::sql_text::get;
use crate::{js_num, js_params, now_ms};

/// `LoopTick`.
#[derive(Clone, Debug, PartialEq)]
pub struct LoopTick {
    pub session_id: String,
    pub session_title: Option<String>,
    pub tool_use_id: String,
    pub prompt: String,
    /// A JS number: whole values land as INTEGER (column affinity).
    pub fired_at: f64,
    pub noop: bool,
}

/// `recordLoopTick`: insert the tick; a second record for the same tool use
/// is ignored. Best effort: no database, no row.
pub fn record_loop_tick(cwd: &str, tick: &LoopTick) {
    let Ok(db) = open_db(cwd, Mode::ReadWrite) else {
        return;
    };
    let _ = db.with(|c| {
        c.execute(
            "INSERT INTO loop_ticks(session_id, session_title, tool_use_id, prompt, fired_at, noop, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(tool_use_id) DO NOTHING",
            js_params![
                tick.session_id,
                tick.session_title,
                tick.tool_use_id,
                tick.prompt,
                tick.fired_at,
                i64::from(tick.noop),
                now_ms(),
            ],
        )
    });
}

/// JS `Math.round`: halves go up (towards +∞), unlike `f64::round`.
pub fn math_round(x: f64) -> f64 {
    let f = x.floor();
    if x - f >= 0.5 { f + 1.0 } else { f }
}

/// `attachLoopTickTokens`: the main-loop token usage of the turn that
/// produced the tick. Only the first attach sticks; an unknown tool use is a
/// no-op.
pub fn attach_loop_tick_tokens(cwd: &str, tool_use_id: &str, tokens: f64) {
    let Ok(db) = open_db(cwd, Mode::ReadWrite) else {
        return;
    };
    let tokens = math_round(tokens).max(0.0);
    let _ = db.with(|c| {
        c.execute(
            "UPDATE loop_ticks SET tokens = ? WHERE tool_use_id = ? AND tokens IS NULL",
            js_params![tokens, tool_use_id],
        )
    });
}

/// `LoopBreakdownRow`.
#[derive(Clone, Debug, PartialEq)]
pub struct LoopBreakdownRow {
    pub session_id: String,
    pub session_title: Option<String>,
    pub run_count: f64,
    pub total_tokens: f64,
    pub tokens_per_run: f64,
    pub last_run: f64,
    pub last_prompt: String,
}

impl LoopBreakdownRow {
    /// The route's JSON, in the TS object's key order.
    pub fn to_json(&self) -> Value {
        json!({
            "sessionId": self.session_id,
            "sessionTitle": self.session_title,
            "runCount": js_num(self.run_count),
            "totalTokens": js_num(self.total_tokens),
            "tokensPerRun": js_num(self.tokens_per_run),
            "lastRun": js_num(self.last_run),
            "lastPrompt": self.last_prompt,
        })
    }
}

fn number(v: ValueRef) -> Option<f64> {
    match v {
        ValueRef::Integer(n) => Some(n as f64),
        ValueRef::Real(f) => Some(f),
        _ => None,
    }
}

/// `listLoopBreakdown`: one row per session, most recent run first; `[]`
/// without a database.
pub fn list_loop_breakdown(cwd: &str) -> Vec<LoopBreakdownRow> {
    let Ok(db) = open_db(cwd, Mode::ReadOnly) else {
        return vec![];
    };
    db.with(|c| {
        let mut st = c.prepare(
            "SELECT session_id, MAX(session_title) AS session_title, COUNT(*) AS run_count,
                    SUM(COALESCE(tokens, 0)) AS total_tokens, MAX(fired_at) AS last_run
               FROM loop_ticks
              GROUP BY session_id
              ORDER BY last_run DESC",
        )?;
        let rows = st
            .query_map([], |r| {
                Ok((
                    get::<String, _>(r, 0)?,
                    get::<Option<String>, _>(r, 1)?,
                    number(r.get_ref(2)?).unwrap_or(0.0),
                    number(r.get_ref(3)?),
                    number(r.get_ref(4)?).unwrap_or(0.0),
                ))
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        let mut last = c.prepare(
            "SELECT prompt FROM loop_ticks WHERE session_id = ? ORDER BY fired_at DESC LIMIT 1",
        )?;
        rows.into_iter()
            .map(|(session_id, session_title, run_count, total, last_run)| {
                let total_tokens = total.unwrap_or(0.0);
                let last_prompt = last
                    .query_row(params![session_id], |r| get::<String, _>(r, 0))
                    .unwrap_or_default();
                Ok(LoopBreakdownRow {
                    session_id,
                    session_title,
                    run_count,
                    total_tokens,
                    tokens_per_run: if run_count > 0.0 {
                        math_round(total_tokens / run_count)
                    } else {
                        0.0
                    },
                    last_run,
                    last_prompt,
                })
            })
            .collect::<rusqlite::Result<Vec<_>>>()
    })
    .unwrap_or_default()
}

/// `listLoopBreakdown(cwd)` as the `GET /api/cost/loops` route hands it to
/// `JSON.stringify` (D18b): each column as better-sqlite3 reads it (a
/// foreign row's BLOB, number or text kept as it is), the last prompt
/// looked up with the row's `session_id` bound as better-sqlite3 binds it.
/// `[]` when the database doesn't open read-only; `Err` is SQLite's message
/// when a query fails (no `loop_ticks` table, an integer overflow in `SUM`),
/// which TS throws.
pub fn list_loop_breakdown_js(cwd: &str) -> Result<Vec<Value>, String> {
    use crate::asset_list::Cell;
    let Ok(db) = open_db(cwd, Mode::ReadOnly) else {
        return Ok(vec![]);
    };
    db.with(|c| {
        let mut st = c.prepare(
            "SELECT session_id, MAX(session_title) AS session_title, COUNT(*) AS run_count,
                    SUM(COALESCE(tokens, 0)) AS total_tokens, MAX(fired_at) AS last_run
               FROM loop_ticks
              GROUP BY session_id
              ORDER BY last_run DESC",
        )?;
        let rows = st
            .query_map([], |r| {
                Ok([
                    Cell::read(r.get_ref(0)?),
                    Cell::read(r.get_ref(1)?),
                    Cell::read(r.get_ref(2)?),
                    Cell::read(r.get_ref(3)?),
                    Cell::read(r.get_ref(4)?),
                ])
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        let mut last = c.prepare(
            "SELECT prompt FROM loop_ticks WHERE session_id = ? ORDER BY fired_at DESC LIMIT 1",
        )?;
        let num = |c: &Cell| match c {
            Cell::Num(n) => *n,
            _ => 0.0,
        };
        let mut out = Vec::with_capacity(rows.len());
        for [session_id, session_title, run_count, total, last_run] in rows {
            let run = num(&run_count);
            let total_tokens = if matches!(total, Cell::Null) {
                Cell::Num(0.0)
            } else {
                total
            };
            let id: rusqlite::types::Value = match &session_id {
                Cell::Null => rusqlite::types::Value::Null,
                Cell::Num(n) => rusqlite::types::Value::Real(*n),
                Cell::Text(t) => rusqlite::types::Value::Text(t.clone()),
                Cell::Blob(b) => rusqlite::types::Value::Blob(b.clone()),
            };
            let prompt = last
                .query_row([id], |r| Ok(Cell::read(r.get_ref(0)?)))
                .optional()?;
            let prompt = match prompt {
                None | Some(Cell::Null) => Cell::Text(String::new()),
                Some(p) => p,
            };
            out.push(json!({
                "sessionId": session_id.to_json(),
                "sessionTitle": session_title.to_json(),
                "runCount": run_count.to_json(),
                "totalTokens": total_tokens.to_json(),
                "tokensPerRun": js_num(if run > 0.0 { math_round(num(&total_tokens) / run) } else { 0.0 }),
                "lastRun": last_run.to_json(),
                "lastPrompt": prompt.to_json(),
            }));
        }
        Ok(out)
    })
    .map_err(|e| crate::db::sqlite_message(&e))
}

#[cfg(test)]
mod tests {
    use super::math_round;

    #[test]
    fn math_round_is_javascripts() {
        for (x, want) in [
            (2.5, 3.0),
            (-2.5, -2.0),
            (-0.5, 0.0),
            (0.49999999999999994, 0.0),
            (12.4, 12.0),
            (-3.0, -3.0),
            (1e12, 1e12),
        ] {
            assert_eq!(math_round(x), want, "{x}");
        }
    }
}
