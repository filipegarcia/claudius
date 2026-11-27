//! System entries, compaction and paging (U01h): `applyEvent`'s `sdk` →
//! `system`, `conversation_reset` and `rate_limit_event` branches, the
//! `session_snapshot` event, and the `loadOlder` / `jumpToUuid` actions.
//!
//! - `system`: every subtype the hook reads, as pills in `systemEntries`
//!   (anchored after the last assistant message) or as state:
//!   - `init` (through U01b's `parse_init`): the slash commands, agents,
//!     skills, cwd, model, permission mode, fast-mode state / reason, the
//!     applied effort and the advisor sentinel, the background-task gate
//!     dropped, and a coalesced "Session ready" pill;
//!   - `hook_started` / `hook_response`: a durable pill for the lifecycle
//!     hooks (and any failed one, with its stderr), else the transient
//!     `runningHook` indicator;
//!   - `status` (coalesced), `compact_boundary` (the divider, through
//!     `merge_compact_boundary`; it disarms `pendingCompact`),
//!     `slash_invoked` (arms `pendingCompact` for an idle `/compact`),
//!     `model_fallback`, `api_retry` (`apiRetry`, which an assistant reply
//!     or a result clears: U01d), `permission_denied`, `informational`,
//!     `worker_shutting_down`, `commands_changed`, `elicitation_complete`,
//!     `model_refusal_*`, `notification` (the fast-mode credits notice
//!     turns fast mode off), `local_command_output`, and the catch-all
//!     `system/<subtype>` pill (minus the suppressed plumbing).
//!   - Not here: `task_*` and `background_tasks_changed` (U01g's
//!     `task_events.rs`), which return before the catch-all, as in the TS,
//!     and `thinking_tokens` (U01e's `user_events.rs`), which `on_sdk`
//!     routes before this.
//! - `conversation_reset`: the divider, with the trigger's label.
//! - `rate_limit_event`: one pill per `rateLimitType`, updated in place,
//!   and the last info kept for the hard-limit panel.
//! - `session_snapshot`: the todos, the init chrome, `todosStale`, and the
//!   last user prompt injected in chronological place.
//! - `loadOlder`: one transcript page before the oldest bubble, prepended
//!   (`synthesizeOlder`), with the compaction divider when the page reaches
//!   the top (`withPagedCompactBoundary`).
//! - `jumpToUuid`: `loadOlder` until a bubble holds the uuid (at most 200
//!   pages); the outcome is an [`Effect::ActionResolved`]. Each page is
//!   looked at once it is folded in, and the next cursor is taken from it
//!   (the TS since U01o; before, it read refs React updates only after the
//!   `await` continued, and re-fetched the first cursor).
//!
//! Deliberate, with the crate's convention for fields the TS copies
//! unchecked: a non-string `uuid` reads as `""`; a non-string `detail`
//! source (`trigger`, `decision_reason_type`), `priority`, `timestamp`,
//! reset `trigger` or `rateLimitType` / other typed `rate_limit_info`
//! field reads as absent, and a `rate_limit_info` that isn't an object as
//! none; `api_retry`'s non-number `error_status` reads as `null` and a
//! non-string `error` as `""`; a non-string `hook_id` is kept as sent
//! (`runningHookIdRef` is JSON). A `null` in those string fields is absent
//! too (the TS shows `null`), and `rate_limit_info` keeps only the
//! `SDKRateLimitInfo` keys. `session_snapshot`'s lists keep only their
//! string items, and a `lastUserPrompt` whose `uuid` or `text` isn't a
//! string isn't injected.

use claudius_agent::js;
use claudius_core::js_string::encode_uri_component;
use serde_json::{Value, json};

use crate::api_retry::{ApiRetryNoResponse, ApiRetryState};
use crate::apply::Cx;
use crate::blocks::coerce_todos;
use crate::compact::{
    merge_compact_boundary, normalize_compact_stats, with_paged_compact_boundary,
};
use crate::effect::{Action, Effect, FetchOutcome};
use crate::event::JsObject;
use crate::labels::conversation_reset_detail;
use crate::messages::{sort_messages_by_chronology, synthesize_older};
use crate::parse_init::parse_init_system_message;
use crate::sdk_filters::is_suppressed_system_event;
use crate::shared::{
    ADVISOR_ACTIVE_SENTINEL, classify_informational_level, hook_event_gets_durable_pill,
    is_fast_mode_credits_rejected_notice,
};
use crate::state::{ChatState, Then};
use crate::system_entries::append_coalesced_system_entry;
use crate::text::{as_num, as_str, prop, strict_eq, to_js_string, truthy, wire_str};
use crate::types::num;
use crate::{
    ClientEnv, DisplayBlock, DisplayMessage, JsThrow, RateLimitInfo, Role, SystemEntry,
    SystemEntryKind,
};

/// `${v ?? fallback}`: the template literal of a field, `fallback` for
/// `null` / `undefined`.
fn tpl(v: Option<&Value>, fallback: &str) -> Result<String, JsThrow> {
    match v {
        None | Some(Value::Null) => Ok(fallback.to_owned()),
        Some(v) => to_js_string(v),
    }
}

/// `a ?? b` on two fields.
fn coalesce<'a>(a: Option<&'a Value>, b: Option<&'a Value>) -> Option<&'a Value> {
    match a {
        None | Some(Value::Null) => b,
        a => a,
    }
}

/// `typeof v === "string" && v.trim() ? v.trim() : undefined`.
fn trimmed(v: Option<&Value>) -> Option<String> {
    as_str(v)
        .map(js::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_owned)
}

/// `(v ?? "").trim()`: a non-string throws, as `String.prototype.trim`
/// isn't on it (`expr` is the TS's callee text in V8's message).
fn trim_or_throw(v: Option<&Value>, expr: &str) -> Result<String, JsThrow> {
    match v {
        None | Some(Value::Null) => Ok(String::new()),
        Some(Value::String(s)) => Ok(js::trim(s).to_owned()),
        Some(_) => Err(JsThrow::type_error(format!("{expr} is not a function"))),
    }
}

/// The `SDKRateLimitInfo` the hook stores as sent, read field by field (a
/// field of the wrong type reads as absent; see the module docs).
fn rate_limit_info(v: &Value) -> Option<RateLimitInfo> {
    let o = v.as_object()?;
    let s = |k: &str| o.get(k).and_then(Value::as_str).map(str::to_owned);
    let n = |k: &str| o.get(k).and_then(Value::as_f64);
    let b = |k: &str| o.get(k).and_then(Value::as_bool);
    Some(RateLimitInfo {
        status: s("status"),
        rate_limit_type: s("rateLimitType"),
        resets_at: n("resetsAt"),
        utilization: n("utilization"),
        overage_status: s("overageStatus"),
        overage_resets_at: n("overageResetsAt"),
        overage_disabled_reason: s("overageDisabledReason"),
        is_using_overage: b("isUsingOverage"),
        overage_in_use: b("overageInUse"),
        overage_enabled: b("overageEnabled"),
        surpassed_threshold: n("surpassedThreshold"),
        error_code: s("errorCode"),
        can_user_purchase_credits: b("canUserPurchaseCredits"),
        has_chargeable_saved_payment_method: b("hasChargeableSavedPaymentMethod"),
        limit_scope: s("limitScope"),
    })
}

/// `commandNamesFromChanged(commands)`: `(commands ?? []).map(...)`
/// throws on anything but an array (or nothing).
fn command_names(commands: Option<&Value>) -> Result<Vec<String>, JsThrow> {
    match commands {
        None | Some(Value::Null) | Some(Value::Array(_)) => {
            Ok(claudius_core::events::command_names_from_changed(commands)
                .into_iter()
                .filter_map(|v| v.as_str().map(str::to_owned))
                .collect())
        }
        Some(_) => Err(JsThrow::type_error(
            "(commands ?? []).map is not a function",
        )),
    }
}

/// The string items of a snapshot list (see the module docs), when it has
/// any items at all (`list.length`); `.length` of `null` / `undefined`
/// throws.
fn snapshot_list(v: Option<&Value>) -> Result<Option<Vec<String>>, JsThrow> {
    match v {
        None => Err(JsThrow::type_error(
            "Cannot read properties of undefined (reading 'length')",
        )),
        Some(Value::Null) => Err(JsThrow::read_of_null("length")),
        Some(Value::Array(items)) if !items.is_empty() => Ok(Some(
            items
                .iter()
                .filter_map(Value::as_str)
                .map(str::to_owned)
                .collect(),
        )),
        // A string's `length` is truthy too, but it isn't a list.
        Some(_) => Ok(None),
    }
}

impl ChatState {
    fn push_entry(&mut self, entry: SystemEntry) {
        self.system_entries.push(entry);
    }

    // ------------------------------------------------------------- system

    /// `if (msg.type === "system") { ... }`.
    pub(crate) fn on_system(&mut self, msg: &Value, cx: &mut Cx<'_>) -> Result<(), JsThrow> {
        let m = Some(msg);
        let anchor = self.last_assistant_uuid.clone();
        let uuid = wire_str(prop(m, "uuid"));
        let entry =
            |kind, label: String| SystemEntry::new(uuid.clone(), anchor.clone(), kind, label);
        let subtype = prop(m, "subtype");
        match as_str(subtype) {
            Some("init") => self.on_init(msg, entry(SystemEntryKind::Init, String::new())),
            Some("hook_started") => {
                let event = coalesce(
                    coalesce(prop(m, "hook_event"), prop(m, "hook_name")),
                    Some(&Value::String(String::new())),
                )
                .cloned()
                .unwrap_or_default();
                if as_str(Some(&event)).is_some_and(|e| hook_event_gets_durable_pill(e, false)) {
                    let name = tpl(coalesce(prop(m, "hook_name"), Some(&event)), "")?;
                    self.push_entry(entry(SystemEntryKind::HookStarted, format!("Hook {name}")));
                } else {
                    self.running_hook_id = prop(m, "hook_id").cloned().unwrap_or(Value::Null);
                    let started_at = num::to_value(cx.env.now_ms());
                    self.running_hook = json!({ "event": event, "startedAt": started_at });
                }
            }
            Some("hook_response") => {
                let id = prop(m, "hook_id");
                if truthy(id) && strict_eq(id, Some(&self.running_hook_id)) {
                    self.running_hook_id = Value::Null;
                    self.running_hook = Value::Null;
                }
                let outcome = prop(m, "outcome");
                let is = |s: &str| strict_eq(outcome, Some(&Value::String(s.into())));
                let failed = is("error") || is("cancelled");
                let stderr = if failed {
                    match prop(m, "stderr") {
                        None | Some(Value::Null) => None,
                        Some(Value::String(s)) => Some(js::trim(s))
                            .filter(|s| !s.is_empty())
                            .map(str::to_owned),
                        Some(_) => {
                            return Err(JsThrow::type_error("h.stderr?.trim is not a function"));
                        }
                    }
                } else {
                    None
                };
                // `hookEventGetsDurablePill(h.hook_event ?? "", failed)`: a
                // non-string event is no lifecycle hook.
                let pill = match as_str(prop(m, "hook_event")) {
                    Some(event) => hook_event_gets_durable_pill(event, failed),
                    None => failed,
                };
                if pill {
                    let name = tpl(prop(m, "hook_name"), "")?;
                    let outcome = tpl(outcome, "ok")?;
                    let mut e = entry(
                        SystemEntryKind::HookResponse,
                        format!("Hook {name} \u{2192} {outcome}"),
                    );
                    e.detail = as_num(prop(m, "exit_code"))
                        .map(|c| format!("exit {}", js::number_to_string(c)));
                    e.hook_failed = Some(failed);
                    e.hook_stderr = stderr;
                    append_coalesced_system_entry(&mut self.system_entries, e);
                }
            }
            Some("status") => {
                let label = format!("Status: {}", tpl(prop(m, "status"), "")?);
                append_coalesced_system_entry(
                    &mut self.system_entries,
                    entry(SystemEntryKind::Status, label),
                );
            }
            Some("compact_boundary") => {
                let meta = coalesce(prop(m, "compact_metadata"), prop(m, "compactMetadata"));
                let stats = normalize_compact_stats(meta);
                self.pending_compact = false;
                merge_compact_boundary(
                    &mut self.system_entries,
                    &uuid,
                    &anchor,
                    stats.as_ref(),
                    None,
                );
            }
            Some("slash_invoked") => {
                let cmd = trim_or_throw(prop(m, "command"), "(s.command ?? \"\").trim")?;
                let cmd = if cmd.is_empty() { "/?".to_owned() } else { cmd };
                let args = trim_or_throw(prop(m, "args"), "(s.args ?? \"\").trim")?;
                if cmd == "/compact" && !self.seen_compact_slash_uuids.contains(&uuid) {
                    self.seen_compact_slash_uuids.insert(uuid.clone());
                    // A /compact queued behind a running turn isn't tracked.
                    if !self.pending {
                        self.pending_compact = true;
                    }
                }
                let args = if args.is_empty() {
                    String::new()
                } else {
                    format!(" {args}")
                };
                self.push_entry(entry(
                    SystemEntryKind::Info,
                    format!("Running {cmd}{args}\u{2026}"),
                ));
            }
            Some(
                "task_started"
                | "task_updated"
                | "task_progress"
                | "task_notification"
                | "background_tasks_changed",
            ) => self.on_task_system(msg, cx)?,
            Some("model_fallback") => {
                let from = prop(m, "original_model");
                let to = prop(m, "fallback_model");
                let label = match trimmed(prop(m, "content")) {
                    Some(c) => c,
                    None if truthy(to) && truthy(from) => format!(
                        "Switched to {} because {} is not available",
                        tpl(to, "")?,
                        tpl(from, "")?
                    ),
                    None => "Switched models".to_owned(),
                };
                let mut e = entry(SystemEntryKind::ModelFallback, label);
                e.detail = as_str(prop(m, "trigger")).map(str::to_owned);
                self.push_entry(e);
            }
            Some("api_retry") => self.api_retry = Some(api_retry_state(m)),
            Some("permission_denied") => {
                let tool = tpl(prop(m, "tool_name"), "(unknown tool)")?;
                let mut e = entry(
                    SystemEntryKind::PermissionDenied,
                    format!("Permission denied: {tool}"),
                );
                let reason = coalesce(prop(m, "decision_reason_type"), prop(m, "decision_reason"));
                e.detail = as_str(reason).map(str::to_owned);
                self.push_entry(e);
            }
            Some("informational") => {
                let level = prop(m, "level");
                // `classifyInformationalLevel(level)`: only `"info"` hides.
                let (hidden, info_level) = classify_informational_level(as_str(level));
                if hidden {
                    return Ok(());
                }
                if let Some(content) = trimmed(prop(m, "content")) {
                    let mut e = entry(SystemEntryKind::Info, content);
                    e.detail = truthy(prop(m, "prevent_continuation")).then(|| "blocked".into());
                    e.info_level = info_level.map(str::to_owned);
                    self.push_entry(e);
                }
            }
            Some("worker_shutting_down") => {
                let reason = tpl(prop(m, "reason"), "worker shutting down")?;
                self.push_entry(entry(
                    SystemEntryKind::Info,
                    format!("Session ended: {reason}"),
                ));
            }
            Some("commands_changed") => {
                let names = command_names(prop(m, "commands"))?;
                if !names.is_empty() {
                    self.slash_commands = names;
                }
            }
            Some("elicitation_complete") => {
                let name = prop(m, "mcp_server_name");
                let label = if truthy(name) {
                    format!("{}: link confirmed", tpl(name, "")?)
                } else {
                    "MCP link confirmed".to_owned()
                };
                self.push_entry(entry(SystemEntryKind::Info, label));
            }
            Some("model_refusal_fallback" | "model_refusal_no_fallback") => {
                let label = trimmed(prop(m, "content")).unwrap_or_else(|| {
                    "The model declined this request for safety reasons.".to_owned()
                });
                let mut e = entry(SystemEntryKind::ModelRefusal, label);
                e.detail = trimmed(prop(m, "api_refusal_explanation"));
                e.refused_user_message_uuid = as_str(prop(m, "refused_user_message_uuid"))
                    .filter(|u| !u.is_empty())
                    .map(str::to_owned);
                self.push_entry(e);
            }
            Some("notification") => {
                if is_fast_mode_credits_rejected_notice(msg) {
                    // Acted on once per notice uuid: a replayed one doesn't
                    // switch fast mode off again.
                    let id = as_str(prop(m, "uuid"));
                    let first_sight =
                        id.is_none_or(|u| !self.handled_fast_credits_notice_uuids.contains(u));
                    if let Some(u) = id {
                        self.handled_fast_credits_notice_uuids.insert(u.to_owned());
                    }
                    if first_sight && !self.replaying {
                        self.fast_mode = false;
                    }
                }
                if let Some(text) = trimmed(prop(m, "text")) {
                    let mut e = entry(SystemEntryKind::Notification, text);
                    e.priority = as_str(prop(m, "priority"))
                        .filter(|p| !p.is_empty())
                        .map(str::to_owned);
                    self.push_entry(e);
                }
            }
            Some("local_command_output") => {
                if let Some(content) = trimmed(prop(m, "content")) {
                    self.push_entry(entry(SystemEntryKind::Info, content));
                }
            }
            _ => {
                // Also drops a missing or `null` subtype, so the TS's
                // `subtype ?? "?"` never shows "?".
                let Some(subtype) = subtype.filter(|s| !is_suppressed_system_event(Some(s))) else {
                    return Ok(());
                };
                let label = format!("system/{}", to_js_string(subtype)?);
                self.push_entry(entry(SystemEntryKind::Info, label));
            }
        }
        Ok(())
    }

    /// `system/init`, through `parseInitSystemMessage`: the chrome only
    /// init carries, then the coalesced "Session ready" pill.
    fn on_init(&mut self, msg: &Value, mut pill: SystemEntry) {
        let init = parse_init_system_message(Some(msg));
        // A CLI (re)start empties the SDK's background-task set: the gate
        // goes inactive until the next `background_tasks_changed`.
        self.live_background_task_ids = None;
        if !init.slash_commands.is_empty() {
            self.slash_commands = init.slash_commands.clone();
        }
        if !init.agents.is_empty() {
            self.agents = init.agents.clone();
        }
        if !init.skills.is_empty() {
            self.skills = init.skills.clone();
        }
        if let Some(cwd) = &init.cwd {
            self.cwd = json!(cwd);
        }
        if let Some(model) = &init.model {
            self.model = json!(model);
        }
        if let Some(mode) = &init.permission_mode {
            self.permission_mode = Some(json!(mode));
        }
        // The edge detector's seed (`prevFastModeState`) is left alone.
        if let Some(state) = &init.fast_mode_state {
            self.fast_mode_state = json!(state);
        }
        if let Some(reason) = &init.fast_mode_disabled_reason {
            self.fast_mode_disabled_reason = json!(reason);
        }
        if let Some(Some(effort)) = &init.effort {
            self.effort = json!(effort);
        }
        if init.advisor_active && self.advisor_model.is_none() {
            self.advisor_model = Some(ADVISOR_ACTIVE_SENTINEL.to_owned());
        }
        pill.label = format!(
            "Session ready \u{b7} {}",
            init.model.as_deref().unwrap_or_default()
        );
        pill.detail = Some(format!(
            "{} tools \u{b7} {} commands \u{b7} {} agents",
            init.tools.len(),
            init.slash_commands.len(),
            init.agents.len()
        ));
        append_coalesced_system_entry(&mut self.system_entries, pill);
    }

    // ------------------------------------------------- conversation_reset

    /// `conversation_reset` (SDK 0.3.281): a divider saying that and why
    /// the CLI discarded the conversation.
    pub(crate) fn on_conversation_reset(&mut self, msg: &Value) -> Result<(), JsThrow> {
        let m = Some(msg);
        let trigger = prop(m, "trigger");
        // `LABEL[r.trigger ?? ""]` indexes with the string of any value
        // (`["clear"]` is `"clear"`).
        let key = tpl(trigger, "")?;
        let mut e = SystemEntry::new(
            wire_str(prop(m, "uuid")),
            self.last_assistant_uuid.clone(),
            SystemEntryKind::ConversationReset,
            "Conversation reset",
        );
        e.detail = Some(conversation_reset_detail(Some(&key)).to_owned());
        e.ts = as_str(prop(m, "timestamp")).map(str::to_owned);
        e.reset_trigger = as_str(trigger).map(str::to_owned);
        self.push_entry(e);
        Ok(())
    }

    // --------------------------------------------------- rate_limit_event

    /// `rate_limit_event`: one pill per `rateLimitType`, the latest payload
    /// shown where the first one was anchored.
    pub(crate) fn on_rate_limit_event(&mut self, msg: &Value) -> Result<(), JsThrow> {
        let m = Some(msg);
        let raw = prop(m, "rate_limit_info");
        let info = raw.and_then(rate_limit_info);
        if truthy(raw) {
            self.last_rate_limit_info = info.clone();
        }
        let status = tpl(prop(raw, "status"), "?")?;
        let kind = tpl(prop(raw, "rateLimitType"), "")?;
        // `info?.rateLimitType ?? "__no_type__"`.
        let no_type = || "__no_type__".to_owned();
        let key = info
            .as_ref()
            .and_then(|i| i.rate_limit_type.clone())
            .unwrap_or_else(no_type);
        let mut incoming = SystemEntry::new(
            wire_str(prop(m, "uuid")),
            self.last_assistant_uuid.clone(),
            SystemEntryKind::RateLimit,
            format!("Rate limit: {status} ({kind})"),
        );
        incoming.rate_limit = info;
        let same = |e: &SystemEntry| {
            e.kind == SystemEntryKind::RateLimit
                && e.rate_limit
                    .as_ref()
                    .and_then(|r| r.rate_limit_type.clone())
                    .unwrap_or_else(no_type)
                    == key
        };
        match self.system_entries.iter_mut().find(|e| same(e)) {
            Some(e) => {
                incoming.after_message_uuid = std::mem::take(&mut e.after_message_uuid);
                incoming.uuid = std::mem::take(&mut e.uuid);
                *e = incoming;
            }
            None => self.push_entry(incoming),
        }
        Ok(())
    }

    // --------------------------------------------------- session_snapshot

    /// `session_snapshot`: the derived state that lives upstream of the
    /// replay window (the todos, init's chrome, the last user prompt).
    pub(crate) fn on_session_snapshot(&mut self, ev: &JsObject) -> Result<(), JsThrow> {
        if let Some(Value::Array(todos)) = ev.get("todos") {
            self.latest_todos = coerce_todos(todos);
        }
        let init = ev.get("init");
        if truthy(init) {
            // Non-empty only: an empty list means "nothing to say".
            if let Some(list) = snapshot_list(prop(init, "slashCommands"))? {
                self.slash_commands = list;
            }
            if let Some(list) = snapshot_list(prop(init, "agents"))? {
                self.agents = list;
            }
            if let Some(list) = snapshot_list(prop(init, "skills"))? {
                self.skills = list;
            }
            if let Some(cwd) = prop(init, "cwd").filter(|c| js::truthy(c)) {
                self.cwd = cwd.clone();
            }
        }
        if let Some(stale @ Value::Bool(_)) = ev.get("todosStale") {
            self.todos_stale = stale.clone();
        }
        let prompt = ev.get("lastUserPrompt");
        if !truthy(prompt) || !truthy(prop(prompt, "uuid")) || !truthy(prop(prompt, "text")) {
            return Ok(());
        }
        let (Some(uuid), Some(text)) = (as_str(prop(prompt, "uuid")), as_str(prop(prompt, "text")))
        else {
            return Ok(());
        };
        if self.messages.iter().any(|m| m.uuid == uuid) {
            return Ok(());
        }
        let mut bubble = DisplayMessage::new(uuid, Role::User, vec![DisplayBlock::text(text)]);
        let Some(at) = as_num(prop(prompt, "at")) else {
            self.messages.insert(0, bubble);
            return Ok(());
        };
        bubble.created_at = Some(at);
        // Before the first message strictly newer; untimed ones are skipped.
        let at_index = self
            .messages
            .iter()
            .position(|m| m.created_at.is_some_and(|t| t > at))
            .unwrap_or(self.messages.len());
        self.messages.insert(at_index, bubble);
        Ok(())
    }

    // ---------------------------------------------------------- loadOlder

    /// `loadOlder()`: fetch the transcript page before the oldest bubble
    /// (its first folded SDK uuid, else its uuid), while there is more
    /// above and no page is in flight. [`ChatState::fetch_settled`] folds
    /// the page in.
    pub fn load_older(&mut self, env: &mut dyn ClientEnv) -> Vec<Effect> {
        let mut cx = Cx::new(env);
        self.start_older(Then::Older(None), &mut cx);
        cx.out
    }

    /// `loadOlder`'s body, the page continuing with `then`: `false` when it
    /// returns without a fetch.
    pub(crate) fn start_older(&mut self, then: Then, cx: &mut Cx<'_>) -> bool {
        let Some(id) = self.session_id.clone().filter(|s| !s.is_empty()) else {
            return false;
        };
        if !truthy(self.has_more_above.as_ref()) || self.loading_older {
            return false;
        }
        self.loading_older = true;
        let mut sorted = self.messages.clone();
        sort_messages_by_chronology(&mut sorted);
        let head = sorted.first().map(|b| {
            b.folded_sdk_uuids
                .as_ref()
                .and_then(|s| s.first())
                .unwrap_or(&b.uuid)
                .clone()
        });
        let url = match head.filter(|h| !h.is_empty()) {
            Some(h) => match encode_uri_component(&h) {
                Some(h) => format!("/api/sessions/{id}/transcript?before={h}&limit=50"),
                None => {
                    // `encodeURIComponent` throws before the fetch: the
                    // promise (`loadOlder`'s, or the jump awaiting it)
                    // rejects.
                    self.loading_older = false;
                    cx.out.push(Effect::UnhandledRejection {
                        error: "URIError: URI malformed".into(),
                    });
                    return true;
                }
            },
            None => format!("/api/sessions/{id}/transcript?limit=50"),
        };
        self.fetch(cx, "GET", url, Vec::new(), None, then);
        true
    }

    /// The page `loadOlder` asked for came back; a jump waiting on it
    /// looks again.
    pub(crate) fn older_settled(
        &mut self,
        jump: Option<Jump>,
        outcome: &FetchOutcome,
        cx: &mut Cx<'_>,
    ) {
        // `finally { setLoadingOlder(false) }`.
        self.loading_older = false;
        match self.fold_older(outcome, cx) {
            // `loadOlder`'s promise rejects (and the jump awaiting it), and
            // nothing catches it.
            Err(error) => cx.out.push(Effect::UnhandledRejection { error }),
            Ok(()) => {
                if let Some(jump) = jump {
                    self.jump_step(jump, cx);
                }
            }
        }
    }

    // --------------------------------------------------------- jumpToUuid

    /// `jumpToUuid(uuid)`: page older history in until a bubble holds
    /// `uuid` (its own, or a folded SDK uuid), for at most 200 pages. The
    /// outcome is an [`Effect::ActionResolved`], now or after the last page
    /// it needed.
    ///
    /// Each page is resolved against once it is folded in, as the TS does
    /// since U01o (it keeps the pages it merged rather than reading
    /// `messagesRef`, which catches up only after React commits).
    pub fn jump_to_uuid(&mut self, uuid: &str, env: &mut dyn ClientEnv) -> Vec<Effect> {
        let mut cx = Cx::new(env);
        let jump = Jump {
            target: uuid.to_owned(),
            pages: 0,
        };
        self.jump_step(jump, &mut cx);
        cx.out
    }

    /// `resolve()`: the primary uuid of the first bubble (oldest first)
    /// holding `uuid`.
    fn resolve_uuid(&self, uuid: &str) -> Option<String> {
        let mut sorted = self.messages.clone();
        sort_messages_by_chronology(&mut sorted);
        sorted
            .into_iter()
            .find(|m| {
                m.uuid == uuid
                    || m.folded_sdk_uuids
                        .as_ref()
                        .is_some_and(|f| f.contains(uuid))
            })
            .map(|m| m.uuid)
    }

    fn jump_step(&mut self, jump: Jump, cx: &mut Cx<'_>) {
        let found = self.resolve_uuid(&jump.target);
        if found.is_some() || jump.pages >= JUMP_PAGE_CAP {
            cx.out.push(jump_resolved(jump.target, found));
            return;
        }
        let next = Jump {
            target: jump.target.clone(),
            pages: jump.pages + 1,
        };
        // `if (!hasMoreAboveRef.current) break;`, or a `loadOlder` that
        // returns without a fetch (one already in flight): either way the
        // TS's remaining turns find nothing more.
        if !self.start_older(Then::Older(Some(next)), cx) {
            cx.out.push(jump_resolved(jump.target, None));
        }
    }

    pub(crate) fn fold_older(
        &mut self,
        outcome: &FetchOutcome,
        cx: &mut Cx<'_>,
    ) -> Result<(), String> {
        let body = match outcome {
            FetchOutcome::Failed(e) => return Err(e.clone()),
            FetchOutcome::Response { .. } if !outcome.ok() => {
                // Most often a 400 "before uuid not found": the cursor can't
                // move, so stop paginating.
                self.has_more_above = Some(Value::Bool(false));
                return Ok(());
            }
            FetchOutcome::Response { body, .. } => body,
        };
        let data = {
            let text = body.strip_prefix('\u{feff}').unwrap_or(body);
            claudius_core::js_string::parse(text).map_err(|e| format!("SyntaxError: {e}"))?
        };
        let raw = match prop(Some(&data), "messages") {
            Some(Value::Array(items)) => items.clone(),
            _ if data.is_null() => {
                return Err(
                    "TypeError: Cannot read properties of null (reading 'messages')".into(),
                );
            }
            _ => return Err("TypeError: raw is not iterable".into()),
        };
        let has_more = prop(Some(&data), "hasMore").cloned();
        let synth = synthesize_older(&raw, cx.env).map_err(|e| e.to_string())?;
        with_paged_compact_boundary(&mut self.system_entries, &raw, truthy(has_more.as_ref()))
            .map_err(|e| e.to_string())?;
        let fresh: Vec<DisplayMessage> = synth
            .into_iter()
            .filter(|m| !self.messages.iter().any(|s| s.uuid == m.uuid))
            .collect();
        if fresh.is_empty() {
            // Every record was already loaded: no progress is possible.
            self.has_more_above = Some(Value::Bool(false));
            return Ok(());
        }
        self.messages.splice(0..0, fresh);
        self.has_more_above = has_more;
        Ok(())
    }
}

/// `jumpToUuid`'s promise value: the bubble's uuid, or `null`.
fn jump_resolved(target: String, uuid: Option<String>) -> Effect {
    Effect::ActionResolved {
        action: Action::JumpToUuid { target },
        outcome: uuid.map_or(Value::Null, Value::String),
    }
}

/// How many pages `jumpToUuid` loads at most.
const JUMP_PAGE_CAP: u32 = 200;

/// A `jumpToUuid` waiting for a page: what it looks for and how many pages
/// it has loaded.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Jump {
    pub target: String,
    pub pages: u32,
}

/// `api_retry`'s `ApiRetryState`, built the hook's way (defaults for odd
/// fields; see the module docs).
fn api_retry_state(m: Option<&Value>) -> ApiRetryState {
    let n = |k: &str, d: f64| as_num(prop(m, k)).unwrap_or(d);
    // `rt.no_response && ...`: a falsy one has neither field.
    let nr = prop(m, "no_response");
    let no_response = match (
        as_num(prop(nr, "waited_ms")),
        as_num(prop(nr, "retry_wait_ms")),
    ) {
        (Some(waited_ms), Some(retry_wait_ms)) => Some(ApiRetryNoResponse {
            waited_ms,
            retry_wait_ms,
        }),
        _ => None,
    };
    ApiRetryState {
        attempt: n("attempt", 1.0),
        max_retries: n("max_retries", 0.0),
        retry_delay_ms: n("retry_delay_ms", 0.0),
        error_status: as_num(prop(m, "error_status")),
        error: match prop(m, "error") {
            None | Some(Value::Null) => "unknown".to_owned(),
            v => wire_str(v),
        },
        no_response,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::FixedEnv;
    use crate::effect::FetchId;

    fn sdk(s: &mut ChatState, message: Value) -> Vec<Effect> {
        let mut env = FixedEnv::new(1000.0);
        let data = json!({ "type": "sdk", "message": message }).to_string();
        s.on_message(&data, &mut env)
    }

    fn bound() -> ChatState {
        let mut s = ChatState::new("tab-1");
        s.session_id = Some("s".into());
        s.has_more_above = Some(json!(true));
        s
    }

    fn page(messages: Value, has_more: Value) -> FetchOutcome {
        FetchOutcome::Response {
            status: 200,
            body: json!({ "messages": messages, "hasMore": has_more }).to_string(),
        }
    }

    fn fetch_of(fx: &[Effect]) -> (FetchId, String) {
        match fx {
            [Effect::Fetch(r)] => (r.id, r.url.clone()),
            other => panic!("{other:?}"),
        }
    }

    fn user(uuid: &str, ts: &str) -> Value {
        json!({ "type": "user", "uuid": uuid, "timestamp": ts, "message": { "role": "user", "content": uuid } })
    }

    #[test]
    fn a_jump_pages_until_a_bubble_holds_the_uuid() {
        let mut s = bound();
        let mut env = FixedEnv::new(1.0);
        sdk(
            &mut s,
            json!({ "type": "assistant", "uuid": "sdk-1", "message": { "id": "msg_1", "content": [] } }),
        );
        // A folded SDK uuid resolves to its bubble, with no fetch.
        assert_eq!(
            s.jump_to_uuid("sdk-1", &mut env),
            vec![Effect::ActionResolved {
                action: Action::JumpToUuid {
                    target: "sdk-1".into()
                },
                outcome: json!("msg_1")
            }]
        );
        let (id, url) = fetch_of(&s.jump_to_uuid("u-old", &mut env));
        assert_eq!(url, "/api/sessions/s/transcript?before=sdk-1&limit=50");
        assert!(s.loading_older);
        let fx = s.fetch_settled(
            id,
            page(json!([user("u-mid", "2025-11-16T10:00:00Z")]), json!(true)),
            &mut env,
        );
        let (id, url) = fetch_of(&fx);
        assert_eq!(url, "/api/sessions/s/transcript?before=u-mid&limit=50");
        let fx = s.fetch_settled(
            id,
            page(json!([user("u-old", "2025-11-16T09:00:00Z")]), json!(true)),
            &mut env,
        );
        assert_eq!(
            fx,
            vec![Effect::ActionResolved {
                action: Action::JumpToUuid {
                    target: "u-old".into()
                },
                outcome: json!("u-old")
            }]
        );
        assert!(!s.loading_older);
        assert_eq!(s.messages[0].uuid, "u-old");
    }

    #[test]
    fn a_jump_resolves_on_the_oldest_matching_bubble() {
        let mut s = bound();
        let mut late = DisplayMessage::new("x", Role::User, vec![]);
        late.created_at = Some(20.0);
        let mut early = DisplayMessage::new("msg_1", Role::Assistant, vec![]);
        early.created_at = Some(10.0);
        early.folded_sdk_uuids = Some(["x".to_owned()].into_iter().collect());
        s.messages = vec![late, early];
        let mut env = FixedEnv::new(1.0);
        assert_eq!(
            s.jump_to_uuid("x", &mut env),
            vec![Effect::ActionResolved {
                action: Action::JumpToUuid { target: "x".into() },
                outcome: json!("msg_1")
            }]
        );
    }

    #[test]
    fn a_jump_gives_up_at_the_top_on_a_failure_or_behind_a_page_in_flight() {
        let mut s = bound();
        let mut env = FixedEnv::new(1.0);
        // The top: the last page says there's nothing more.
        let (id, _) = fetch_of(&s.jump_to_uuid("nope", &mut env));
        let fx = s.fetch_settled(
            id,
            page(json!([user("u1", "2025-11-16T10:00:00Z")]), json!(false)),
            &mut env,
        );
        let gave_up = || Effect::ActionResolved {
            action: Action::JumpToUuid {
                target: "nope".into(),
            },
            outcome: Value::Null,
        };
        assert_eq!(fx, vec![gave_up()]);
        assert_eq!(s.jump_to_uuid("nope", &mut env), vec![gave_up()]);
        // A rejected page rejects the jump: no resolution.
        s.has_more_above = Some(json!(true));
        let (id, _) = fetch_of(&s.jump_to_uuid("nope", &mut env));
        let fx = s.fetch_settled(id, FetchOutcome::Failed("TypeError: x".into()), &mut env);
        assert_eq!(
            fx,
            vec![Effect::UnhandledRejection {
                error: "TypeError: x".into()
            }]
        );
        // A 4xx stops paging, and the jump with it.
        let (id, _) = fetch_of(&s.jump_to_uuid("nope", &mut env));
        let fx = s.fetch_settled(
            id,
            FetchOutcome::Response {
                status: 400,
                body: "{}".into(),
            },
            &mut env,
        );
        assert_eq!(fx, vec![gave_up()]);
        assert_eq!(s.has_more_above, Some(json!(false)));
        // `loadOlder` returns at once while a page is in flight.
        s.has_more_above = Some(json!(true));
        let first = s.load_older(&mut env);
        assert_eq!(first.len(), 1);
        assert!(s.load_older(&mut env).is_empty());
        assert_eq!(s.jump_to_uuid("nope", &mut env), vec![gave_up()]);
    }

    #[test]
    fn a_jump_stops_after_200_pages() {
        let mut s = bound();
        let mut env = FixedEnv::new(1.0);
        let mut fx = s.jump_to_uuid("never", &mut env);
        let mut pages = 0;
        while let [Effect::Fetch(r)] = fx.as_slice() {
            pages += 1;
            assert!(pages <= 200, "past the cap");
            let uuid = format!("u{pages}");
            let at = format!(
                "2025-11-16T10:00:{:02}.{:03}Z",
                59 - pages / 1000,
                999 - pages
            );
            fx = s.fetch_settled(r.id, page(json!([user(&uuid, &at)]), json!(true)), &mut env);
        }
        assert_eq!(pages, 200);
        assert_eq!(
            fx,
            vec![Effect::ActionResolved {
                action: Action::JumpToUuid {
                    target: "never".into()
                },
                outcome: Value::Null,
            }]
        );
    }

    #[test]
    fn load_older_needs_a_session_and_more_above() {
        let mut env = FixedEnv::new(1.0);
        let mut s = bound();
        s.session_id = Some(String::new());
        assert!(s.load_older(&mut env).is_empty());
        s.session_id = None;
        assert!(s.load_older(&mut env).is_empty());
        let mut s = bound();
        s.has_more_above = None;
        assert!(s.load_older(&mut env).is_empty());
        s.has_more_above = Some(json!(0));
        assert!(s.load_older(&mut env).is_empty());
        assert!(!s.loading_older);
        // A head uuid `encodeURIComponent` refuses rejects before the fetch.
        let mut s = bound();
        let lone = claudius_core::js_string::lone(0xD800).to_string();
        s.messages
            .push(DisplayMessage::new(lone, Role::User, vec![]));
        assert_eq!(
            s.load_older(&mut env),
            vec![Effect::UnhandledRejection {
                error: "URIError: URI malformed".into()
            }]
        );
        assert!(!s.loading_older);
    }

    /// The crate's convention for fields the TS copies unchecked (not in
    /// the fixture, where the TS would show the odd value).
    #[test]
    fn odd_fields_read_the_crate_way() {
        let mut s = ChatState::new("tab-1");
        sdk(
            &mut s,
            json!({ "type": "system", "subtype": "worker_shutting_down", "uuid": 5 }),
        );
        assert_eq!(s.system_entries[0].uuid, "");
        sdk(
            &mut s,
            json!({ "type": "conversation_reset", "uuid": "r", "trigger": 5, "timestamp": null }),
        );
        let e = &s.system_entries[1];
        assert_eq!(e.detail.as_deref(), Some("reason unspecified"));
        assert_eq!((e.reset_trigger.as_deref(), e.ts.as_deref()), (None, None));
        sdk(
            &mut s,
            json!({ "type": "conversation_reset", "uuid": "r2", "trigger": ["clear"] }),
        );
        assert_eq!(s.system_entries[2].detail.as_deref(), Some("via /clear"));
        sdk(
            &mut s,
            json!({ "type": "rate_limit_event", "uuid": "l", "rate_limit_info": { "status": 5, "rateLimitType": "five_hour", "resetsAt": "soon", "extra": 1 } }),
        );
        let info = s.system_entries[3].rate_limit.clone().unwrap();
        assert_eq!(info.status, None);
        assert_eq!(info.resets_at, None);
        assert_eq!(s.system_entries[3].label, "Rate limit: 5 (five_hour)");
        // A truthy non-object info keeps nothing to read for the panel.
        sdk(
            &mut s,
            json!({ "type": "rate_limit_event", "uuid": "l2", "rate_limit_info": 5 }),
        );
        assert_eq!(s.last_rate_limit_info, None);
        assert_eq!(s.system_entries[4].rate_limit, None);
        sdk(
            &mut s,
            json!({ "type": "system", "subtype": "api_retry", "uuid": "a", "error": 5, "error_status": "503" }),
        );
        let retry = s.api_retry.clone().unwrap();
        assert_eq!((retry.error.as_str(), retry.error_status), ("", None));
        sdk(
            &mut s,
            json!({ "type": "system", "subtype": "model_fallback", "uuid": "f", "trigger": 5 }),
        );
        sdk(
            &mut s,
            json!({ "type": "system", "subtype": "notification", "uuid": "n", "text": "t", "priority": 5 }),
        );
        let n = s.system_entries.len();
        assert_eq!(s.system_entries[n - 2].detail, None);
        assert_eq!(s.system_entries[n - 1].priority, None);
        // Snapshot lists keep their strings; an odd prompt isn't injected.
        let mut env = FixedEnv::new(1.0);
        let data = json!({ "type": "session_snapshot",
            "init": { "slashCommands": [5, "a"], "agents": "xy", "skills": [] },
            "lastUserPrompt": { "uuid": 5, "text": "x" } })
        .to_string();
        assert!(s.on_message(&data, &mut env).is_empty());
        assert_eq!(s.slash_commands, ["a"]);
        assert!(s.agents.is_empty());
        assert!(s.messages.is_empty());
    }

    #[test]
    fn the_other_slices_subtypes_add_no_pill() {
        let mut s = ChatState::new("tab-1");
        for subtype in [
            "task_started",
            "task_updated",
            "task_progress",
            "task_notification",
            "background_tasks_changed",
            "thinking_tokens",
        ] {
            sdk(
                &mut s,
                json!({ "type": "system", "subtype": subtype, "uuid": subtype }),
            );
        }
        assert!(s.system_entries.is_empty());
        // Init drops the background-task gate back to inactive.
        s.live_background_task_ids = Some(Default::default());
        sdk(
            &mut s,
            json!({ "type": "system", "subtype": "init", "uuid": "i" }),
        );
        assert_eq!(s.live_background_task_ids, None);
    }

    #[test]
    fn an_empty_head_uuid_pages_from_the_end() {
        let mut s = bound();
        s.messages.push(DisplayMessage::new(
            "",
            Role::User,
            vec![DisplayBlock::text("x")],
        ));
        let mut env = FixedEnv::new(1.0);
        let (_, url) = fetch_of(&s.load_older(&mut env));
        assert_eq!(url, "/api/sessions/s/transcript?limit=50");
    }

    #[test]
    fn a_hook_id_is_matched_as_sent() {
        let mut s = ChatState::new("tab-1");
        sdk(
            &mut s,
            json!({ "type": "system", "subtype": "hook_started", "uuid": "a", "hook_id": 5, "hook_event": "PreToolUse" }),
        );
        assert_eq!(s.running_hook_id, json!(5));
        sdk(
            &mut s,
            json!({ "type": "system", "subtype": "hook_response", "uuid": "b", "hook_id": "5" }),
        );
        assert_eq!(s.running_hook["event"], json!("PreToolUse"));
        sdk(
            &mut s,
            json!({ "type": "system", "subtype": "hook_response", "uuid": "c", "hook_id": 5 }),
        );
        assert_eq!(
            (&s.running_hook, &s.running_hook_id),
            (&Value::Null, &Value::Null)
        );
        assert!(s.system_entries.is_empty());
    }
}
