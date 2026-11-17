//! `applyEvent`'s `sdk` branch: the SDK messages the server forwards
//! (`{ type: "sdk", message, at }`), folded into the transcript.
//!
//! U01d ports the message and stream assembly:
//! - `assistant`: one `SDKAssistantMessage` split, folded into the bubble
//!   of its Anthropic `message.id` (`upsertAssistantSplit`), with the
//!   rate-limit / Opus-high-demand / model-unavailable tags and the error
//!   tag; its per-call usage estimate; its thinking and tool rows in the
//!   activity rail. A subagent's split (`parent_tool_use_id`) goes to that
//!   Task's trail instead.
//! - `stream_event`: the Anthropic streaming events, kept per message in a
//!   delta scratch ([`DeltaScratch`]) and merged into the streaming bubble
//!   after every block event (`buildMerged`).
//! - `result`: the turn's end (`pending`, `lastTurnCompletedAt`, the idle
//!   sweep, the trailing bubble), the session-list refresh, fast-mode edges
//!   and the resume / startup-failure / budget / compaction notices.
//! - `prompt_suggestion`: the next-prompt chips (the last four, deduped).
//!
//! Not yet: the `user`, `tool_progress`, `system`, `conversation_reset`
//! and `rate_limit_event` messages (U01e / U01h), and the assistant
//! handler's per-tool side effects (TodoWrite / TaskCreate / TaskUpdate,
//! Edit / MultiEdit / Write, background Bash, KillBash, CronCreate /
//! CronDelete, ScheduleWakeup: U01e / U01g). They are accepted and ignored
//! until their slices land.
//!
//! Deliberate, with the crate's convention for SDK fields the TS copies
//! unchecked: a non-string `uuid`, `parent_tool_use_id`, stream
//! `message.id`, `tool_use` id / name, `error`, `resume_reason`,
//! `startup_failure_reason` or suggestion reads as absent (`""` for an
//! id); a usage count that isn't a number reads as `0` (the TS would
//! concatenate a string); a `result` `errors` that isn't an array reads as
//! none.

use claudius_agent::js;
use serde_json::{Map, Value, json};

use crate::apply::Cx;
use crate::blocks::{blocks_from_sdk_content, pick_primary_arg};
use crate::effort_wait::effort_request_started;
use crate::event::JsObject;
use crate::idle_reconcile::{ToolHistoryEntry, ToolHistoryKind};
use crate::labels::{
    RESUME_REASON_LABELS, STARTUP_FAILURE_REASON_LABELS, is_opus_high_demand_text,
    is_rate_limit_hit_text, label, rate_limit_hit_from_blocks, rewrite_model_unavailable_blocks,
};
use crate::messages::{AssistantSplit, upsert_assistant_split};
use crate::shared::{TokenBreakdown, cost_from_tokens};
use crate::state::{AfterRefresh, ChatState};
use crate::task_status::set_task_model_for_tool_use;
use crate::text::{as_num, as_str, prop, push_js, strict_eq, to_js_string, truthy};
use crate::types::num;
use crate::{
    DisplayBlock, DisplayMessage, JsThrow, Role, SystemEntry, SystemEntryKind, record_set,
};

/// How many rows the activity rail's Tools list keeps (`slice(0, 100)`).
const TOOL_HISTORY_CAP: usize = 100;

/// How many prompt suggestions show (`slice(-4)`).
const SUGGESTIONS_CAP: usize = 4;

/// `DeltaScratch["blocks"]`'s slot kinds.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SlotKind {
    Text,
    Thinking,
    ToolUse,
}

/// One content block being streamed. Deltas append to `text` or
/// `partial_json` whatever the slot's kind (the TS doesn't check it).
#[derive(Debug, Clone, PartialEq)]
pub struct Slot {
    pub kind: SlotKind,
    pub text: Option<String>,
    pub redacted: bool,
    pub tool_use_id: String,
    pub tool_name: String,
    pub partial_json: Option<String>,
}

impl Slot {
    fn new(kind: SlotKind, text: Option<String>) -> Self {
        Self {
            kind,
            text,
            redacted: false,
            tool_use_id: String::new(),
            tool_name: String::new(),
            partial_json: None,
        }
    }
}

/// `DeltaScratch`: one message's streamed blocks by content-block index (a
/// `Map<number, slot>`; `-0` and `0` are one key, as `==` has it).
#[derive(Debug, Clone, Default, PartialEq)]
pub struct DeltaScratch {
    pub blocks: Vec<(f64, Slot)>,
}

impl DeltaScratch {
    fn get_mut(&mut self, index: f64) -> Option<&mut Slot> {
        self.blocks
            .iter_mut()
            .find(|(i, _)| *i == index)
            .map(|(_, s)| s)
    }

    /// `blocks.set(index, slot)`: a known index keeps its place.
    fn set(&mut self, index: f64, slot: Slot) {
        match self.get_mut(index) {
            Some(s) => *s = slot,
            None => self.blocks.push((index, slot)),
        }
    }

    /// `buildMerged(existingBlocks)`: the slots in index order as display
    /// blocks, keeping the `result` and `startedAt` already on a tool_use
    /// the bubble has (a new one is stamped `now`).
    fn build_merged(&self, existing: &[DisplayBlock], now: f64) -> Vec<DisplayBlock> {
        let mut slots: Vec<&(f64, Slot)> = self.blocks.iter().collect();
        slots.sort_by(|a, b| a.0.total_cmp(&b.0));
        let mut results = Vec::new();
        let mut started = Vec::new();
        for b in existing {
            if let DisplayBlock::ToolUse {
                id,
                result,
                started_at,
                ..
            } = b
            {
                if let Some(r) = result {
                    results.retain(|(k, _)| k != id);
                    results.push((id.clone(), r.clone()));
                }
                if let Some(t) = started_at.filter(|t| *t != 0.0 && !t.is_nan()) {
                    started.retain(|(k, _)| k != id);
                    started.push((id.clone(), t));
                }
            }
        }
        slots
            .into_iter()
            .map(|(_, slot)| match slot.kind {
                SlotKind::Text => DisplayBlock::text(slot.text.clone().unwrap_or_default()),
                SlotKind::Thinking => DisplayBlock::Thinking {
                    text: slot.text.clone().unwrap_or_default(),
                    redacted: slot.redacted.then_some(true),
                },
                SlotKind::ToolUse => {
                    let input = match slot.partial_json.as_deref() {
                        // `partialJson ? JSON.parse(partialJson) : {}`; deltas
                        // only ever append non-empty text.
                        None => Value::Object(Map::new()),
                        Some(p) => claudius_core::js_string::parse(p)
                            .unwrap_or_else(|_| json!({ "__partial": p })),
                    };
                    let id = slot.tool_use_id.clone();
                    let result = results.iter().find(|(k, _)| *k == id).map(|(_, r)| r);
                    let started_at = started.iter().find(|(k, _)| *k == id).map(|(_, t)| *t);
                    DisplayBlock::ToolUse {
                        result: result.cloned(),
                        started_at: Some(started_at.unwrap_or(now)),
                        id,
                        name: slot.tool_name.clone(),
                        input,
                    }
                }
            })
            .collect()
    }
}

/// `prev.some((e) => e.toolUseId === id)`, else the row goes first.
fn add_tool_row(history: &mut Vec<ToolHistoryEntry>, row: ToolHistoryEntry) {
    if history.iter().any(|e| e.tool_use_id == row.tool_use_id) {
        return;
    }
    history.insert(0, row);
    history.truncate(TOOL_HISTORY_CAP);
}

/// A synthetic thinking row (`thinking:<message id>:<index>`).
fn thinking_row(id: String, redacted: bool, now: f64, done: bool) -> ToolHistoryEntry {
    ToolHistoryEntry {
        tool_use_id: id,
        tool_name: if redacted {
            "Thinking (encrypted)"
        } else {
            "Thinking"
        }
        .into(),
        primary_arg: None,
        started_at: now,
        ended_at: done.then_some(now),
        done: done.then_some(true),
        is_error: None,
        not_run: None,
        parent_tool_use_id: None,
        kind: Some(ToolHistoryKind::Thinking),
        estimated_thinking_tokens: None,
        user_message_uuid: None,
    }
}

/// V8's `TypeError` for `undefined.<key>` / `null.<key>`.
fn read_of(v: Option<&Value>, key: &str) -> Option<JsThrow> {
    match v {
        None => Some(JsThrow::type_error(format!(
            "Cannot read properties of undefined (reading '{key}')"
        ))),
        Some(Value::Null) => Some(JsThrow::read_of_null(key)),
        Some(_) => None,
    }
}

/// `x ?? 0` for a count.
fn count(v: Option<&Value>, key: &str) -> f64 {
    as_num(prop(v, key)).unwrap_or(0.0)
}

impl ChatState {
    /// `if (ev.type !== "sdk") return; const msg = ev.message; ...`.
    pub(crate) fn on_sdk(&mut self, ev: JsObject, cx: &mut Cx<'_>) -> Result<(), JsThrow> {
        let msg = ev.get("message");
        if let Some(e) = read_of(msg, "type") {
            return Err(e);
        }
        let msg = msg.expect("checked");
        let at = as_num(ev.get("at"));
        match as_str(prop(Some(msg), "type")) {
            Some("assistant") => self.on_assistant(msg, at, cx),
            Some("stream_event") => self.on_stream_event(msg, at, cx),
            Some("result") => self.on_result(msg, cx),
            Some("prompt_suggestion") => {
                self.on_prompt_suggestion(msg);
                Ok(())
            }
            // Not yet: U01e (`user`, `tool_progress`) and U01h (`system`,
            // `conversation_reset`, `rate_limit_event`).
            Some(
                "user" | "tool_progress" | "system" | "conversation_reset" | "rate_limit_event",
            ) => Ok(()),
            _ => Ok(()),
        }
    }

    // ---------------------------------------------------------- assistant

    fn on_assistant(
        &mut self,
        msg: &Value,
        at: Option<f64>,
        cx: &mut Cx<'_>,
    ) -> Result<(), JsThrow> {
        // A real reply means the request went through: no retry in flight.
        self.api_retry = None;
        let beta = prop(Some(msg), "message");
        if let Some(e) = read_of(beta, "id") {
            return Err(e);
        }
        let sdk_uuid = as_str(prop(Some(msg), "uuid"))
            .unwrap_or_default()
            .to_owned();
        let message_id = as_str(prop(beta, "id"))
            .filter(|id| !id.is_empty())
            .map_or_else(|| sdk_uuid.clone(), str::to_owned);
        // Usage is counted once per Anthropic message (every split carries
        // the whole call's), subagent calls included.
        if let Some(u) = prop(beta, "usage").filter(|u| js::truthy(u))
            && !self.counted_usage.contains(&message_id)
        {
            self.counted_usage.insert(message_id.clone());
            let model = match prop(beta, "model") {
                None | Some(Value::Null) => self.model.as_str(),
                Some(m) => m.as_str(),
            }
            .map(str::to_owned);
            self.add_usage_estimate(model.as_deref(), u);
        }
        let parent = as_str(prop(Some(msg), "parent_tool_use_id")).map(str::to_owned);
        let aborted = prop(Some(msg), "aborted") == Some(&Value::Bool(true));
        let blocks = blocks_from_sdk_content(prop(beta, "content"), cx.env)?;
        let has_stream_scratch = self
            .scratch
            .get(&message_id)
            .is_some_and(|s| !s.blocks.is_empty());
        if let Some(p) = parent.as_deref().filter(|p| !p.is_empty()) {
            // Subagent traffic goes to its Task's trail, untagged.
            let mut list = self.subagent_messages.get(p).cloned().unwrap_or_default();
            upsert_assistant_split(
                &mut list,
                &AssistantSplit {
                    message_id,
                    sdk_uuid,
                    blocks,
                    has_stream_scratch,
                    parent_tool_use_id: Some(p.to_owned()),
                    at,
                    aborted: Some(aborted),
                    ..Default::default()
                },
            );
            record_set(&mut self.subagent_messages, p, list);
            // The model the subagent ran on, stamped on its task once.
            if let Some(model) = as_str(prop(beta, "model")).filter(|m| !m.is_empty()) {
                set_task_model_for_tool_use(&mut self.tasks, p, model);
            }
            return Ok(());
        }
        let error = as_str(prop(Some(msg), "error"));
        let rate_limit_hit =
            (error == Some("rate_limit") || is_rate_limit_hit_text(&blocks)).then(|| {
                rate_limit_hit_from_blocks(
                    &blocks,
                    self.last_rate_limit_info.as_ref(),
                    self.fallback_model.as_str(),
                    self.subscription_type.as_str(),
                )
            });
        let opus_high_demand = is_opus_high_demand_text(&blocks).then_some(true);
        let display =
            rewrite_model_unavailable_blocks(&blocks, error).unwrap_or_else(|| blocks.clone());
        let error_tag = error.filter(|e| *e != "rate_limit").map(str::to_owned);
        self.last_assistant_uuid = message_id.clone();
        upsert_assistant_split(
            &mut self.messages,
            &AssistantSplit {
                message_id: message_id.clone(),
                sdk_uuid,
                blocks: display,
                has_stream_scratch,
                parent_tool_use_id: None,
                at,
                rate_limit_hit,
                opus_high_demand,
                aborted: Some(aborted),
                error_tag,
            },
        );
        self.set_pending_tracked(true, cx);
        let now = cx.env.now_ms();
        // Thinking that arrived whole (a replay, or no partials): done rows.
        for (i, b) in blocks.iter().enumerate() {
            if let DisplayBlock::Thinking { redacted, .. } = b {
                let id = format!("thinking:{message_id}:{i}");
                add_tool_row(
                    &mut self.tool_history,
                    thinking_row(id, *redacted == Some(true), now, true),
                );
            }
        }
        for b in &blocks {
            let DisplayBlock::ToolUse {
                id, name, input, ..
            } = b
            else {
                continue;
            };
            if !self.tool_history.iter().any(|e| e.tool_use_id == *id) {
                let row = ToolHistoryEntry {
                    tool_use_id: id.clone(),
                    tool_name: name.clone(),
                    primary_arg: pick_primary_arg(name, Some(input))?,
                    started_at: now,
                    ended_at: None,
                    done: None,
                    is_error: None,
                    not_run: None,
                    parent_tool_use_id: Some(parent.clone()),
                    kind: None,
                    estimated_thinking_tokens: None,
                    user_message_uuid: None,
                };
                self.tool_history.insert(0, row);
                self.tool_history.truncate(TOOL_HISTORY_CAP);
            }
            // Not yet: the per-tool branches after this point (TodoWrite /
            // TaskCreate / TaskUpdate and the loops: U01g; Edit / MultiEdit /
            // Write and background Bash / KillBash: U01e).
        }
        Ok(())
    }

    /// The mid-turn usage estimate: token counts added onto the session's,
    /// and the call's cost at the model's prices (`costFromTokens`). The
    /// server's `usage_snapshot` replaces it at the turn's end (U01i).
    fn add_usage_estimate(&mut self, model: Option<&str>, u: &Value) {
        let u = Some(u);
        let (input, output) = (count(u, "input_tokens"), count(u, "output_tokens"));
        let cache_read = count(u, "cache_read_input_tokens");
        let cache_write = count(u, "cache_creation_input_tokens");
        let estimate = cost_from_tokens(
            model,
            &TokenBreakdown {
                input,
                output,
                cache_read,
                cache_write_5m: cache_write,
                cache_write_1h: 0.0,
            },
        );
        // `prev?.x ?? 0`: nothing to read off `null`.
        let prev = Some(&self.usage);
        let mut next = Map::new();
        for (key, add) in [
            ("totalCostUsd", Some(estimate)),
            ("numTurns", None),
            ("durationMs", None),
            ("durationApiMs", None),
            ("inputTokens", Some(input)),
            ("outputTokens", Some(output)),
            ("cacheReadInputTokens", Some(cache_read)),
            ("cacheCreationInputTokens", Some(cache_write)),
        ] {
            let had = prop(prev, key).and_then(num::from_value).unwrap_or(0.0);
            next.insert(key.into(), num::to_value(had + add.unwrap_or(0.0)));
        }
        if let Some(m) = prop(prev, "modelUsage") {
            next.insert("modelUsage".into(), m.clone());
        }
        self.usage = Value::Object(next);
    }

    // ------------------------------------------------------- stream_event

    fn on_stream_event(
        &mut self,
        msg: &Value,
        at: Option<f64>,
        cx: &mut Cx<'_>,
    ) -> Result<(), JsThrow> {
        let evt = prop(Some(msg), "event");
        if let Some(e) = read_of(evt, "type") {
            return Err(e);
        }
        let parent = as_str(prop(Some(msg), "parent_tool_use_id")).map(str::to_owned);
        let scope_key = parent.clone().unwrap_or_default();
        let kind = as_str(prop(evt, "type"));
        if kind == Some("message_start")
            && let Some(id) = as_str(prop(prop(evt, "message"), "id")).filter(|id| !id.is_empty())
        {
            // A new main-thread request carries the newly picked effort
            // (the TS checks `inForce !== null` first, which changes
            // nothing: with none in force the state stays as it is).
            if parent.is_none() {
                let next = effort_request_started(&self.effort_wait);
                self.effort_change_waits = next.waits;
                self.effort_wait = next;
            }
            // The TS also seeds an empty scratch here; an empty one reads
            // as none, and the first block event creates it.
            self.scope_message_id.insert(scope_key, id.to_owned());
            return Ok(());
        }
        // Partials anchor on the scope's open message, else on the
        // envelope's uuid (a replay window that started mid-message).
        let anchor = match self.scope_message_id.get(&scope_key) {
            Some(a) => a.clone(),
            None => as_str(prop(Some(msg), "uuid"))
                .unwrap_or_default()
                .to_owned(),
        };
        if anchor.is_empty() {
            return Ok(());
        }
        let subagent = parent.filter(|p| !p.is_empty());
        let index = as_num(prop(evt, "index"));
        let block = prop(evt, "content_block").filter(|b| js::truthy(b));
        let now = cx.env.now_ms();
        let scratch = self.scratch.entry(anchor.clone()).or_default();
        match (kind, index) {
            (Some("content_block_start"), Some(index)) if block.is_some() => {
                let cb = block;
                match as_str(prop(cb, "type")) {
                    Some("text") => {
                        let text = as_str(prop(cb, "text")).unwrap_or_default();
                        scratch.set(index, Slot::new(SlotKind::Text, Some(text.to_owned())));
                    }
                    Some(t @ ("thinking" | "redacted_thinking")) => {
                        let redacted = t == "redacted_thinking";
                        let text = match as_str(prop(cb, "thinking")) {
                            Some(s) if !redacted => s,
                            _ => "",
                        };
                        let mut slot = Slot::new(SlotKind::Thinking, Some(text.to_owned()));
                        slot.redacted = redacted;
                        scratch.set(index, slot);
                        // A spinner row in the rail; subagent thinking isn't
                        // tracked there.
                        if subagent.is_none() {
                            let id = format!("thinking:{anchor}:{}", js::number_to_string(index));
                            add_tool_row(
                                &mut self.tool_history,
                                thinking_row(id, redacted, now, false),
                            );
                        }
                    }
                    Some("tool_use") => {
                        let mut slot = Slot::new(SlotKind::ToolUse, None);
                        // `partialJson: ""`, which merges as `{}` like none.
                        slot.tool_use_id = as_str(prop(cb, "id")).unwrap_or_default().into();
                        slot.tool_name = as_str(prop(cb, "name")).unwrap_or_default().into();
                        scratch.set(index, slot);
                    }
                    _ => {}
                }
            }
            (Some("content_block_delta"), Some(index))
                if prop(evt, "delta").is_some_and(js::truthy) =>
            {
                let delta = prop(evt, "delta");
                let Some(slot) = scratch.get_mut(index) else {
                    return Ok(());
                };
                let field = |k| prop(delta, k).filter(|v| js::truthy(v));
                match as_str(prop(delta, "type")) {
                    Some("text_delta") if field("text").is_some() => {
                        let add = to_js_string(field("text").expect("checked"))?;
                        push_js(slot.text.get_or_insert_default(), &add);
                    }
                    Some("thinking_delta") if field("thinking").is_some() => {
                        let add = to_js_string(field("thinking").expect("checked"))?;
                        push_js(slot.text.get_or_insert_default(), &add);
                    }
                    Some("input_json_delta") if field("partial_json").is_some() => {
                        let add = to_js_string(field("partial_json").expect("checked"))?;
                        push_js(slot.partial_json.get_or_insert_default(), &add);
                    }
                    _ => {}
                }
            }
            (Some("content_block_stop"), Some(index)) if block.is_some() => {
                // A short thinking block whose body came only on the stop.
                if let Some(slot) = scratch.get_mut(index)
                    && slot.kind == SlotKind::Thinking
                    && slot.text.as_deref().is_none_or(str::is_empty)
                    && as_str(prop(block, "type")) == Some("thinking")
                    && let Some(t) = as_str(prop(block, "thinking"))
                {
                    slot.text = Some(t.to_owned());
                }
            }
            (Some("message_stop"), _) => {
                self.on_message_stop(&anchor, &scope_key, subagent.as_deref(), now);
                return Ok(());
            }
            _ => return Ok(()),
        }
        let scratch = self.scratch[&anchor].clone();
        match subagent {
            Some(p) => {
                let mut list = self.subagent_messages.get(&p).cloned().unwrap_or_default();
                match list.iter_mut().find(|m| m.uuid == anchor) {
                    Some(m) => m.blocks = scratch.build_merged(&m.blocks, now),
                    None => {
                        let mut m = DisplayMessage::new(
                            anchor,
                            Role::Assistant,
                            scratch.build_merged(&[], now),
                        );
                        m.streaming = Some(true);
                        m.parent_tool_use_id = Some(p.clone());
                        m.created_at = at;
                        list.push(m);
                    }
                }
                record_set(&mut self.subagent_messages, &p, list);
            }
            None => match self.messages.iter_mut().find(|m| m.uuid == anchor) {
                Some(m) => m.blocks = scratch.build_merged(&m.blocks, now),
                None => {
                    // A partial before its terminal split: a placeholder on
                    // the message id, which system pills now anchor under.
                    let mut m = DisplayMessage::new(
                        anchor.clone(),
                        Role::Assistant,
                        scratch.build_merged(&[], now),
                    );
                    m.streaming = Some(true);
                    m.created_at = at;
                    self.messages.push(m);
                    self.last_assistant_uuid = anchor;
                }
            },
        }
        Ok(())
    }

    /// `message_stop`: the bubble stops streaming, its thinking rows close,
    /// and the scope's next `message_start` opens a new anchor.
    fn on_message_stop(&mut self, anchor: &str, scope_key: &str, subagent: Option<&str>, now: f64) {
        match subagent {
            Some(p) => {
                let mut list = self.subagent_messages.get(p).cloned().unwrap_or_default();
                for m in list.iter_mut().filter(|m| m.uuid == anchor) {
                    m.streaming = Some(false);
                }
                record_set(&mut self.subagent_messages, p, list);
            }
            None => {
                for m in self.messages.iter_mut().filter(|m| m.uuid == anchor) {
                    m.streaming = Some(false);
                }
                let prefix = format!("thinking:{anchor}:");
                for e in &mut self.tool_history {
                    if e.kind != Some(ToolHistoryKind::Thinking)
                        || e.done == Some(true)
                        || !e.tool_use_id.starts_with(&prefix)
                    {
                        continue;
                    }
                    e.done = Some(true);
                    e.ended_at = Some(now);
                    e.estimated_thinking_tokens = None;
                }
            }
        }
        // The anchor is the scope's open message whenever the scope has one.
        self.scope_message_id.shift_remove(scope_key);
    }

    // ------------------------------------------------------------- result

    fn on_result(&mut self, r: &Value, cx: &mut Cx<'_>) -> Result<(), JsThrow> {
        self.set_pending_tracked(false, cx);
        self.api_retry = None;
        self.reconcile_to_idle(cx);
        // Repaint the other tabs' status dots.
        self.refresh_sessions(AfterRefresh::Nothing, cx);
        let anchor = self.last_assistant_uuid.clone();
        if !anchor.is_empty() {
            for m in self.messages.iter_mut().filter(|m| m.uuid == anchor) {
                m.streaming = Some(false);
            }
        }
        let r = Some(r);
        if let Some(state) = prop(r, "fast_mode_state").filter(|v| js::truthy(v)) {
            let on = Value::String("on".into());
            let cooldown = Value::String("cooldown".into());
            let reason = prop(r, "fast_mode_disabled_reason");
            self.fast_mode_state = state.clone();
            self.fast_mode_disabled_reason = if strict_eq(Some(state), Some(&on)) {
                Value::Null
            } else {
                reason.cloned().unwrap_or(Value::Null)
            };
            // The first observation only seeds the edge detector, and a
            // replay never toasts.
            let prev = std::mem::replace(&mut self.prev_fast_mode_state, state.clone());
            if !prev.is_null() && !strict_eq(Some(&prev), Some(state)) && !self.replaying {
                let is = |v: &Value, s: &Value| strict_eq(Some(v), Some(s));
                if is(state, &cooldown) {
                    let mut notice = Map::new();
                    notice.insert("uuid".into(), json!(cx.env.random_uuid()));
                    notice.insert("kind".into(), json!("cooldown"));
                    if let Some(reason) = reason {
                        notice.insert("reason".into(), reason.clone());
                    }
                    self.fast_mode_notice = Value::Object(notice);
                } else if is(state, &on) && is(&prev, &cooldown) {
                    let uuid = cx.env.random_uuid();
                    self.fast_mode_notice = json!({ "uuid": uuid, "kind": "recovered" });
                }
            }
        }
        // A result the stream replays is folded once.
        let uuid = as_str(prop(r, "uuid")).filter(|u| !u.is_empty());
        if let Some(u) = uuid {
            if self.seen_result_uuids.contains(u) {
                return Ok(());
            }
            self.seen_result_uuids.insert(u.to_owned());
        }
        if let Some(reason) = as_str(prop(r, "resume_reason")).filter(|s| !s.is_empty()) {
            let uuid = match uuid {
                Some(u) => format!("{u}-resumed"),
                None => cx.env.random_uuid(),
            };
            let mut entry = SystemEntry::new(
                uuid,
                anchor,
                SystemEntryKind::Info,
                "Turn resumed after interruption",
            );
            entry.detail = Some(label(RESUME_REASON_LABELS, reason).unwrap_or(reason).into());
            self.system_entries.push(entry);
        }
        let errors = match prop(r, "errors") {
            Some(Value::Array(e)) => e.as_slice(),
            _ => &[],
        };
        if let Some(reason) = as_str(prop(r, "startup_failure_reason")).filter(|s| !s.is_empty()) {
            let detail = label(STARTUP_FAILURE_REASON_LABELS, reason).unwrap_or(reason);
            let mut text = format!("Session failed to start: {detail}.");
            if let Some(first) = errors.first() {
                text.push_str(" (");
                push_js(&mut text, &to_js_string(first)?);
                text.push(')');
            }
            self.errors.push(Value::String(text));
        }
        let subtype = prop(r, "subtype");
        let is = |s: &str| strict_eq(subtype, Some(&Value::String(s.into())));
        if is("error_max_budget_usd") {
            let spent = as_num(prop(r, "total_cost_usd"))
                .map(|c| format!(" (${} spent)", to_fixed(c, 2)))
                .unwrap_or_default();
            self.errors.push(Value::String(format!(
                "Session stopped: max budget reached{spent}. Raise the cap in workspace settings to continue."
            )));
        }
        // A tracked /compact that ended without a boundary failed.
        if self.pending_compact {
            self.pending_compact = false;
            if truthy(subtype) && !is("success") && !is("error_max_budget_usd") {
                let detail = to_js_string(errors.first().or(subtype).expect("truthy"))?;
                let mut text = "Compaction failed: ".to_owned();
                push_js(&mut text, &detail);
                self.errors.push(Value::String(text));
            }
        }
        Ok(())
    }

    // -------------------------------------------------- prompt_suggestion

    fn on_prompt_suggestion(&mut self, msg: &Value) {
        let Some(s) = as_str(prop(Some(msg), "suggestion")) else {
            return;
        };
        if js::trim(s).is_empty() || self.prompt_suggestions.iter().any(|p| p == s) {
            return;
        }
        self.prompt_suggestions.push(s.to_owned());
        let extra = self
            .prompt_suggestions
            .len()
            .saturating_sub(SUGGESTIONS_CAP);
        self.prompt_suggestions.drain(..extra);
    }
}

/// `Number.prototype.toFixed(digits)`: the exact value rounded to `digits`
/// places, a tie going to the larger magnitude; `String(x)` from `1e21` up.
pub(crate) fn to_fixed(x: f64, digits: u32) -> String {
    // `NaN` falls through to Rust's `NaN`.
    // `-0` isn't below zero, and prints as `0`.
    let (sign, a) = if x < 0.0 { ("-", -x) } else { ("", x + 0.0) };
    if a.is_infinite() {
        return format!("{sign}Infinity");
    }
    if a >= 1e21 {
        return format!("{sign}{}", js::number_to_string(a));
    }
    // A tie is `a = j / 2^(digits + 1)` with `j` odd.
    let scaled = a * 2f64.powi(digits as i32 + 1);
    let body = if scaled.fract() == 0.0 && scaled % 2.0 == 1.0 {
        let n = ((scaled as u128) * 5u128.pow(digits)).div_ceil(2);
        let s = format!("{n:0>width$}", width = digits as usize + 1);
        let (int, frac) = s.split_at(s.len() - digits as usize);
        if digits == 0 {
            int.to_owned()
        } else {
            format!("{int}.{frac}")
        }
    } else {
        format!("{a:.prec$}", prec = digits as usize)
    };
    format!("{sign}{body}")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::FixedEnv;
    use crate::effort_wait::{EffortWaitState, NO_EFFORT_WAIT};

    fn sdk(s: &mut ChatState, message: Value) -> Vec<crate::effect::Effect> {
        let mut env = FixedEnv::new(1000.0);
        let data = json!({ "type": "sdk", "message": message, "at": 5 }).to_string();
        s.on_message(&data, &mut env)
    }

    /// The slices that set these cells (U01h `api_retry` / `init` /
    /// `compact`, U01i `model_changed` / `setEffort`, U01g tasks) aren't
    /// ported yet, so the recorder can't reach these paths.
    #[test]
    fn a_main_thread_request_start_drops_an_applied_effort_wait() {
        let mut s = ChatState::new("tab-1");
        let waiting = EffortWaitState {
            in_force: Some("high".into()),
            waits: true,
            applied_seen: true,
        };
        s.effort_wait = waiting.clone();
        s.effort_change_waits = true;
        let start = json!({ "type": "message_start", "message": { "id": "m1" } });
        let ev = |parent: Value| json!({ "type": "stream_event", "uuid": "u", "parent_tool_use_id": parent, "event": start });
        sdk(&mut s, ev(json!("toolu_sub")));
        assert_eq!(s.effort_wait, waiting, "a subagent request doesn't count");
        sdk(&mut s, ev(Value::Null));
        assert_eq!(s.effort_wait, NO_EFFORT_WAIT);
        assert!(!s.effort_change_waits);
        // Not applied yet: the request still runs at the old level.
        let unseen = EffortWaitState {
            applied_seen: false,
            ..waiting
        };
        s.effort_wait = unseen.clone();
        s.effort_change_waits = true;
        sdk(&mut s, ev(Value::Null));
        assert_eq!(s.effort_wait, unseen);
        assert!(s.effort_change_waits);
        assert_eq!(s.scope_message_id.get(""), Some(&"m1".to_owned()));
    }

    #[test]
    fn a_failed_compaction_is_reported_once() {
        let mut s = ChatState::new("tab-1");
        for (subtype, errors, want) in [
            (
                json!("error_during_execution"),
                json!(["boom"]),
                Some("Compaction failed: boom"),
            ),
            (
                json!("error_max_turns"),
                json!([]),
                Some("Compaction failed: error_max_turns"),
            ),
            (
                json!("error_max_turns"),
                json!("x"),
                Some("Compaction failed: error_max_turns"),
            ),
            (json!("success"), json!(["ignored"]), None),
            (Value::Null, json!(["ignored"]), None),
        ] {
            s.errors.clear();
            s.pending_compact = true;
            sdk(
                &mut s,
                json!({ "type": "result", "subtype": subtype, "errors": errors }),
            );
            assert!(!s.pending_compact);
            assert_eq!(s.errors, want.map(|w| vec![json!(w)]).unwrap_or_default());
        }
        // The budget stop has its own banner.
        s.errors.clear();
        s.pending_compact = true;
        sdk(
            &mut s,
            json!({ "type": "result", "subtype": "error_max_budget_usd" }),
        );
        assert_eq!(
            s.errors,
            vec![json!(
                "Session stopped: max budget reached. Raise the cap in workspace settings to continue."
            )]
        );
        // No compact in flight: nothing.
        s.errors.clear();
        sdk(
            &mut s,
            json!({ "type": "result", "subtype": "error_max_turns" }),
        );
        assert!(s.errors.is_empty());
    }

    #[test]
    fn a_reply_ends_a_retry_and_prices_on_the_current_model() {
        let mut s = ChatState::new("tab-1");
        let retry = || {
            Some(crate::api_retry::ApiRetryState {
                attempt: 1.0,
                max_retries: 3.0,
                retry_delay_ms: 500.0,
                error_status: None,
                error: "overloaded".into(),
                no_response: None,
            })
        };
        s.api_retry = retry();
        assert_eq!(s.snapshot()["apiRetry"]["error"], json!("overloaded"));
        s.model = json!("claude-haiku-4-5");
        let usage = json!({ "input_tokens": 1_000_000, "output_tokens": 0 });
        sdk(
            &mut s,
            json!({ "type": "assistant", "uuid": "a", "message": { "id": "m", "content": [], "usage": usage } }),
        );
        assert_eq!(s.api_retry, None);
        let haiku = cost_from_tokens(
            Some("claude-haiku-4-5"),
            &TokenBreakdown {
                input: 1_000_000.0,
                output: 0.0,
                cache_read: 0.0,
                cache_write_5m: 0.0,
                cache_write_1h: 0.0,
            },
        );
        assert_eq!(s.usage["totalCostUsd"], num::to_value(haiku));
        // The message's own model wins; `modelUsage` carries over.
        s.usage["modelUsage"] = json!({ "x": 1 });
        sdk(
            &mut s,
            json!({ "type": "assistant", "uuid": "b", "message": { "id": "m2", "model": "claude-opus-4-5", "usage": usage } }),
        );
        assert_eq!(s.usage["modelUsage"], json!({ "x": 1 }));
        assert_eq!(s.usage["inputTokens"], json!(2_000_000));
        s.api_retry = retry();
        sdk(&mut s, json!({ "type": "result" }));
        assert_eq!(s.api_retry, None);
    }

    #[test]
    fn a_subagent_reply_stamps_its_task_model_once() {
        let mut s = ChatState::new("tab-1");
        let task: crate::task_status::TaskInfo = serde_json::from_value(json!({
            "taskId": "t1", "toolUseId": "toolu_A", "description": "d", "status": "running"
        }))
        .unwrap();
        s.tasks.insert("t1".into(), task);
        let reply = |uuid: &str, model: Value| {
            json!({ "type": "assistant", "uuid": uuid, "parent_tool_use_id": "toolu_A",
                    "message": { "id": uuid, "model": model, "content": [] } })
        };
        sdk(&mut s, reply("a", json!("")));
        assert_eq!(s.tasks["t1"].model, None);
        sdk(&mut s, reply("b", json!("claude-haiku-4-5")));
        sdk(&mut s, reply("c", json!("claude-opus-4-5")));
        assert_eq!(s.tasks["t1"].model.as_deref(), Some("claude-haiku-4-5"));
        assert_eq!(s.subagent_messages["toolu_A"].len(), 3);
        assert!(s.messages.is_empty());
    }

    #[test]
    fn the_later_slices_messages_are_ignored_for_now() {
        let mut s = ChatState::new("tab-1");
        let before = s.clone();
        for message in [
            json!({ "type": "user", "message": { "content": "hi" } }),
            json!({ "type": "system", "subtype": "init", "model": "x" }),
            json!({ "type": "tool_progress", "tool_use_id": "t" }),
            json!({ "type": "conversation_reset" }),
            json!({ "type": "rate_limit_event", "rate_limit_info": {} }),
        ] {
            assert!(sdk(&mut s, message).is_empty());
        }
        assert_eq!(s, before);
    }

    #[test]
    fn to_fixed_is_js_to_fixed() {
        for (x, d, want) in [
            (0.125, 2, "0.13"),
            (0.375, 2, "0.38"),
            (1.005, 2, "1.00"),
            (2.675, 2, "2.67"),
            (2.5, 0, "3"),
            (1.5, 0, "2"),
            (-0.125, 2, "-0.13"),
            (-0.0, 2, "0.00"),
            (0.0, 2, "0.00"),
            (12.0, 2, "12.00"),
            (0.004, 2, "0.00"),
            (1e21, 2, "1e+21"),
            (-1e21, 2, "-1e+21"),
            (f64::INFINITY, 2, "Infinity"),
            (f64::NEG_INFINITY, 2, "-Infinity"),
            (f64::NAN, 2, "NaN"),
            (0.5, 0, "1"),
            (0.045, 2, "0.04"),
            (-0.001, 2, "-0.00"),
        ] {
            assert_eq!(to_fixed(x, d), want, "{x}.toFixed({d})");
        }
    }

    /// Tool results (U01e) and thinking estimates (U01e) aren't recorded
    /// yet: a rebuild keeps both the result and the start time a tool_use
    /// already has (the last of duplicate ids), and a closed thinking row
    /// drops its estimate.
    #[test]
    fn a_rebuild_keeps_what_the_bubble_already_has() {
        use crate::ToolResult;
        let mut s = DeltaScratch::default();
        let mut slot = Slot::new(SlotKind::ToolUse, None);
        slot.tool_use_id = "t".into();
        slot.tool_name = "Read".into();
        s.set(0.0, slot);
        let tool = |result: &str, started_at: f64| DisplayBlock::ToolUse {
            id: "t".into(),
            name: "Read".into(),
            input: json!({}),
            result: Some(ToolResult {
                content: result.into(),
                ..Default::default()
            }),
            started_at: Some(started_at),
        };
        let merged = s.build_merged(&[tool("first", 5.0), tool("last", 7.0)], 99.0);
        assert_eq!(merged, vec![tool("last", 7.0)]);
        // A falsy start time is re-stamped; no result stays none.
        let bare = DisplayBlock::ToolUse {
            id: "t".into(),
            name: "Read".into(),
            input: json!({}),
            result: None,
            started_at: Some(0.0),
        };
        let merged = s.build_merged(&[bare], 99.0);
        let DisplayBlock::ToolUse {
            result, started_at, ..
        } = &merged[0]
        else {
            panic!("{merged:?}");
        };
        assert_eq!((result, *started_at), (&None, Some(99.0)));

        let mut st = ChatState::new("tab-1");
        let mut row = thinking_row("thinking:m:0".into(), false, 1.0, false);
        row.estimated_thinking_tokens = Some(120.0);
        st.tool_history.push(row);
        st.on_message_stop("m", "", None, 50.0);
        assert_eq!(st.tool_history[0].estimated_thinking_tokens, None);
        assert_eq!(st.tool_history[0].ended_at, Some(50.0));
    }

    #[test]
    fn scratch_indices_are_numbers() {
        let mut s = DeltaScratch::default();
        s.set(-0.0, Slot::new(SlotKind::Text, Some("a".into())));
        s.set(0.0, Slot::new(SlotKind::Text, Some("b".into())));
        s.set(-1.0, Slot::new(SlotKind::Text, Some("c".into())));
        assert_eq!(s.blocks.len(), 2);
        let merged = s.build_merged(&[], 1.0);
        assert_eq!(
            merged,
            vec![DisplayBlock::text("c"), DisplayBlock::text("b")]
        );
    }
}
