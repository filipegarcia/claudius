//! `refreshSessions` and the 30 s safety-net poll (U01k, ported ahead of
//! its slice: the poll is the one timer every mount arms, so replaying a
//! recorded log across time needs it).
//!
//! `refreshSessions` merges the live list (`/api/sessions`) over the disk
//! list (`/api/sessions/all?limit=25`): titles only from `claudiusTitle` /
//! `customTitle` (trimmed), a live row spread over its disk row, sorted by
//! `lastModified` (newest first), the top 20 plus any live session past
//! them. Whatever throws in the TS (a `null` row, a non-string truthy title,
//! a reply that isn't JSON) leaves `sessions` alone, after
//! `accountsConfigured` has been taken from the disk reply.
//!
//! Not replayed, and simplified: a non-numeric `lastModified` (V8 sorts
//! with the comparator's `NaN` as `0`; the port's stable sort agrees only
//! while the order stays consistent) and an object or array as a session
//! id (the TS compares those by reference).

use serde_json::{Map, Value};

use crate::apply::Cx;
use crate::effect::{Effect, FetchOutcome};
use crate::state::{AfterRefresh, ChatState, Refresh, Then, TimerFn};
use crate::text::{prop, strict_eq, truthy};
use crate::types::num;
use crate::{ClientEnv, JsThrow};

/// How many recent sessions the list keeps (`slice(0, 20)`).
const TOP: usize = 20;

impl ChatState {
    /// The mount effect that arms the 30 s poll (`setInterval(..., 30_000)`);
    /// U01k's mount calls it.
    pub fn start_sessions_poll(&mut self) -> Vec<Effect> {
        let mut out = Vec::new();
        self.set_timer(&mut out, TimerFn::SessionsPoll, 30_000.0, true);
        out
    }

    /// The poll's tick: while this tab thinks a turn is running, or the list
    /// shows any session running, refresh the list and settle a turn the
    /// server says is over. Skipped while the document is hidden.
    pub(crate) fn sessions_poll(&mut self, cx: &mut Cx<'_>) {
        if self.hidden {
            return;
        }
        let running = Value::String("running".into());
        let any_running = self
            .sessions
            .iter()
            .any(|s| strict_eq(prop(Some(s), "status"), Some(&running)));
        if !self.pending && !any_running {
            return;
        }
        self.refresh_sessions(AfterRefresh::Poll, cx);
    }

    /// `refreshSessions()`: both fetches at once (`Promise.allSettled`).
    pub(crate) fn refresh_sessions(&mut self, then: AfterRefresh, cx: &mut Cx<'_>) {
        self.next_refresh += 1;
        let op = self.next_refresh;
        self.refreshes.insert(
            op,
            Refresh {
                live: None,
                disk: None,
                then,
            },
        );
        for (disk, url) in [
            (false, "/api/sessions"),
            (true, "/api/sessions/all?limit=25"),
        ] {
            self.fetch(
                cx,
                "GET",
                url.to_owned(),
                Vec::new(),
                None,
                Then::Sessions { op, disk },
            );
        }
    }

    pub(crate) fn refresh_half(
        &mut self,
        op: u64,
        disk: bool,
        outcome: FetchOutcome,
        cx: &mut Cx<'_>,
    ) {
        let Some(r) = self.refreshes.get_mut(&op) else {
            return;
        };
        if disk {
            r.disk = Some(outcome);
        } else {
            r.live = Some(outcome);
        }
        let (Some(_), Some(_)) = (&r.live, &r.disk) else {
            return;
        };
        let r = self.refreshes.shift_remove(&op).expect("just seen");
        let (live, disk) = (r.live.expect("settled"), r.disk.expect("settled"));
        let merged = match self.merge_sessions(&live, &disk, cx.env) {
            Ok(merged) => {
                self.sessions = merged.clone();
                merged
            }
            // `catch { return [] }`.
            Err(_) => Vec::new(),
        };
        r.then.run(self, &merged, cx);
    }

    /// The body of `refreshSessions` after both fetches settled. `Err` is a
    /// throw (the TS catches it and returns `[]`); `accountsConfigured` may
    /// already be set by then.
    fn merge_sessions(
        &mut self,
        live_res: &FetchOutcome,
        disk_res: &FetchOutcome,
        env: &mut dyn ClientEnv,
    ) -> Result<Vec<Value>, JsThrow> {
        let not_json = || JsThrow {
            name: "SyntaxError",
            message: "not JSON".into(),
        };
        let mut live: Vec<Value> = Vec::new();
        if live_res.ok() {
            if let Value::Array(items) = live_res.json().ok_or_else(not_json)? {
                live = items;
            }
        }
        let mut disk: Vec<Value> = Vec::new();
        if disk_res.ok() {
            let data = disk_res.json().ok_or_else(not_json)?;
            if data.is_null() {
                return Err(JsThrow::read_of_null("sessions"));
            }
            if let Some(Value::Array(items)) = prop(Some(&data), "sessions") {
                disk = items.clone();
            }
            if let Some(n) = prop(Some(&data), "accountsConfigured").and_then(Value::as_f64) {
                self.accounts_configured = n;
            }
        }

        // A JS `Map` keyed by session id, in insertion order.
        let mut by_id: Vec<(Value, Map<String, Value>)> = Vec::new();
        fn slot(by_id: &[(Value, Map<String, Value>)], id: &Value) -> Option<usize> {
            by_id.iter().position(|(k, _)| same_value_zero(k, id))
        }
        fn upsert(
            by_id: &mut Vec<(Value, Map<String, Value>)>,
            id: Value,
            row: Map<String, Value>,
        ) {
            match slot(by_id, &id) {
                Some(i) => by_id[i].1 = row,
                None => by_id.push((id, row)),
            }
        }

        for d in &disk {
            if d.is_null() {
                return Err(JsThrow::read_of_null("sessionId"));
            }
            let Some(id) = prop(Some(d), "sessionId").filter(|v| claudius_agent::js::truthy(v))
            else {
                continue;
            };
            let title = match trusted_title(prop(Some(d), "claudiusTitle"), "claudiusTitle")? {
                Some(t) => Value::String(t),
                None => trusted_title(prop(Some(d), "customTitle"), "customTitle")?
                    .map_or(Value::Null, Value::String),
            };
            let mut row = Map::new();
            row.insert("id".into(), id.clone());
            put(&mut row, "cwd", prop(Some(d), "cwd"));
            row.insert("title".into(), title);
            put(&mut row, "lastModified", prop(Some(d), "lastModified"));
            put(&mut row, "accountId", prop(Some(d), "accountId"));
            put(&mut row, "accountLabel", prop(Some(d), "accountLabel"));
            upsert(&mut by_id, id.clone(), row);
        }

        for l in &live {
            let Some(id) = prop(Some(l), "id").filter(|v| claudius_agent::js::truthy(v)) else {
                continue;
            };
            let prev = slot(&by_id, id).map(|i| by_id[i].1.clone());
            // `{ ...prev, ...l, title, lastModified }`.
            let mut row = prev.clone().unwrap_or_default();
            if let Value::Object(lo) = l {
                for (k, v) in claudius_agent::js::own_keys_order(lo) {
                    row.insert(k.clone(), v.clone());
                }
            }
            let prev_get = |k: &str| prev.as_ref().and_then(|p| p.get(k));
            let title = match prop(Some(l), "title") {
                Some(t) if !t.is_null() => t.clone(),
                _ => prev_get("title")
                    .filter(|t| !t.is_null())
                    .cloned()
                    .unwrap_or(Value::Null),
            };
            row.insert("title".into(), title);
            let last = match prev_get("lastModified") {
                Some(t) if !t.is_null() => t.clone(),
                _ => num::to_value(env.now_ms()),
            };
            row.insert("lastModified".into(), last);
            upsert(&mut by_id, id.clone(), row);
        }

        // `sort((a, b) => (b.lastModified ?? 0) - (a.lastModified ?? 0))`;
        // a single row is never compared, so its key can't throw.
        let compared = by_id.len() > 1;
        let mut sorted: Vec<(f64, Value, Map<String, Value>)> = Vec::with_capacity(by_id.len());
        for (id, row) in by_id {
            let key = match row.get("lastModified") {
                None | Some(Value::Null) => 0.0,
                Some(v) => match claudius_core::js_string::to_js_number(Some(v)) {
                    Ok(n) => n,
                    Err(_) if compared => {
                        return Err(JsThrow::type_error(
                            "Cannot convert object to primitive value",
                        ));
                    }
                    Err(_) => 0.0,
                },
            };
            sorted.push((key, id, row));
        }
        sorted.sort_by(|a, b| b.0.partial_cmp(&a.0).unwrap_or(std::cmp::Ordering::Equal));

        // `live.map((l) => l.id)` reads `.id` of every row, `null` too.
        let mut live_ids: Vec<Option<&Value>> = Vec::with_capacity(live.len());
        for l in &live {
            if l.is_null() {
                return Err(JsThrow::read_of_null("id"));
            }
            live_ids.push(prop(Some(l), "id"));
        }
        let in_top: Vec<&Value> = sorted.iter().take(TOP).map(|(_, id, _)| id).collect();
        let mut merged: Vec<Value> = sorted
            .iter()
            .take(TOP)
            .map(|(_, _, row)| Value::Object(row.clone()))
            .collect();
        for (_, id, row) in &sorted {
            let is_live = live_ids
                .iter()
                .any(|l| l.is_some_and(|l| same_value_zero(l, id)));
            if is_live && !in_top.iter().any(|t| same_value_zero(t, id)) {
                merged.push(Value::Object(row.clone()));
            }
        }
        Ok(merged)
    }
}

/// `{ key: v }` with `v` possibly `undefined` (left out).
fn put(row: &mut Map<String, Value>, key: &str, v: Option<&Value>) {
    if let Some(v) = v {
        row.insert(key.into(), v.clone());
    }
}

/// `(t && t.trim())` as a title: the trimmed text, `None` for a falsy `t`
/// or a blank one, and V8's `TypeError` for a truthy non-string.
fn trusted_title(t: Option<&Value>, key: &str) -> Result<Option<String>, JsThrow> {
    if !truthy(t) {
        return Ok(None);
    }
    match t {
        Some(Value::String(s)) => {
            let s = claudius_agent::js::trim(s);
            Ok((!s.is_empty()).then(|| s.to_owned()))
        }
        _ => Err(JsThrow::type_error(format!(
            "d.{key}.trim is not a function"
        ))),
    }
}

/// `Map` / `Set` key equality (SameValueZero) on JSON values; two parsed
/// objects are never the same key.
fn same_value_zero(a: &Value, b: &Value) -> bool {
    strict_eq(Some(a), Some(b))
}
