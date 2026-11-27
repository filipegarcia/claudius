//! The hook's message-list helpers: folding SDK splits into bubbles
//! (`upsertAssistantSplit`), a subagent's replayed transcript
//! (`buildSubagentMessages`), a page of older history (`synthesizeOlder`),
//! patching a tool result in (`applyToolResultToList` / `…ToTrails`) and the
//! chronological sort (`sortMessagesByChronology`).
//!
//! The TS returns the same array when nothing changes (React's cheap
//! equality); these work in place and return whether anything did.

use indexmap::IndexSet;
use serde_json::Value;

use crate::blocks::{
    blocks_from_sdk_content, extract_peer_origin, extract_tool_result, extract_user_content,
};
use crate::labels::{
    is_opus_high_demand_text, is_rate_limit_hit_text, rate_limit_hit_from_blocks,
    rewrite_model_unavailable_blocks,
};
use crate::sdk_filters::{
    is_compact_summary_content, is_image_resize_note_content, is_local_command_caveat_content,
    is_sdk_internal_envelope, is_sdk_slash_user_message, is_synthetic_task_notification,
    parse_synthetic_cli_wrapper,
};
use crate::text::{as_num, as_str, prop, push_js, to_js_string, truthy};
use crate::{
    ClientEnv, DisplayBlock, DisplayMessage, JsRecord, JsThrow, RateLimitHit, Role, ToolResult,
};

/// One SDK split for [`upsert_assistant_split`]: an `SDKAssistantMessage`
/// folded into the bubble of its Anthropic `message.id`.
#[derive(Debug, Clone, Default)]
pub struct AssistantSplit {
    pub message_id: String,
    /// The SDK envelope's `uuid`: each split is folded once.
    pub sdk_uuid: String,
    pub blocks: Vec<DisplayBlock>,
    /// `stream_event` partials build this message's blocks (a new bubble
    /// starts empty).
    pub has_stream_scratch: bool,
    pub parent_tool_use_id: Option<String>,
    /// The server's `at` stamp (epoch ms).
    pub at: Option<f64>,
    // The sticky tags: once a split sets one, later splits keep it.
    pub rate_limit_hit: Option<RateLimitHit>,
    pub opus_high_demand: Option<bool>,
    pub aborted: Option<bool>,
    pub error_tag: Option<String>,
}

/// `upsertAssistantSplit`: a new bubble for an unseen `message_id`
/// (streaming), or the split's new blocks appended to the existing one
/// (`tool_use` by id, `text` and `thinking` by equal text, empty `text`
/// skipped). A split already folded only re-marks the bubble streaming.
pub fn upsert_assistant_split(list: &mut Vec<DisplayMessage>, split: &AssistantSplit) -> bool {
    let Some(idx) = list.iter().position(|m| m.uuid == split.message_id) else {
        let mut m = DisplayMessage::new(
            split.message_id.clone(),
            Role::Assistant,
            if split.has_stream_scratch {
                Vec::new()
            } else {
                split.blocks.clone()
            },
        );
        m.streaming = Some(true);
        m.folded_sdk_uuids = Some(IndexSet::from([split.sdk_uuid.clone()]));
        m.parent_tool_use_id = split.parent_tool_use_id.clone().filter(|p| !p.is_empty());
        m.created_at = split.at;
        m.rate_limit_hit = split.rate_limit_hit.clone();
        m.opus_high_demand = split.opus_high_demand.filter(|b| *b);
        m.aborted = split.aborted.filter(|b| *b);
        m.error_tag = split.error_tag.clone().filter(|t| !t.is_empty());
        list.push(m);
        return true;
    };
    let existing = &mut list[idx];
    let folded = existing.folded_sdk_uuids.get_or_insert_with(IndexSet::new);
    if folded.contains(&split.sdk_uuid) {
        if existing.streaming == Some(true) {
            return false;
        }
        existing.streaming = Some(true);
        return true;
    }
    folded.insert(split.sdk_uuid.clone());
    let mut tool_ids = IndexSet::new();
    let mut texts = IndexSet::new();
    let mut thinkings = IndexSet::new();
    for b in &existing.blocks {
        match b {
            DisplayBlock::ToolUse { id, .. } => tool_ids.insert(id.clone()),
            DisplayBlock::Text { text } => texts.insert(text.clone()),
            DisplayBlock::Thinking { text, .. } => thinkings.insert(text.clone()),
        };
    }
    for b in &split.blocks {
        let skip = match b {
            DisplayBlock::ToolUse { id, .. } => tool_ids.contains(id),
            DisplayBlock::Text { text } => text.is_empty() || texts.contains(text),
            DisplayBlock::Thinking { text, .. } => thinkings.contains(text),
        };
        if !skip {
            existing.blocks.push(b.clone());
        }
    }
    existing.streaming = Some(true);
    if existing.rate_limit_hit.is_none() {
        existing.rate_limit_hit = split.rate_limit_hit.clone();
    }
    // Sticky: an existing `true` stays, and this split can only set it.
    if split.opus_high_demand == Some(true) {
        existing.opus_high_demand = Some(true);
    }
    if split.aborted == Some(true) {
        existing.aborted = Some(true);
    }
    let sticky_tag = existing
        .error_tag
        .clone()
        .or_else(|| split.error_tag.clone());
    if sticky_tag.as_deref().is_some_and(|t| !t.is_empty()) {
        existing.error_tag = sticky_tag;
    }
    true
}

/// `const { at, message } of raw`, then `message.type`: an item without a
/// `message` object throws the way V8 does.
fn subagent_item(item: &Value) -> Result<(Option<f64>, &Value), JsThrow> {
    if item.is_null() {
        return Err(JsThrow::type_error(
            "Cannot destructure property 'at' of '.for' as it is null.",
        ));
    }
    match prop(Some(item), "message") {
        None => Err(JsThrow::type_error(
            "Cannot read properties of undefined (reading 'type')",
        )),
        Some(Value::Null) => Err(JsThrow::read_of_null("type")),
        Some(m) => Ok((as_num(prop(Some(item), "at")), m)),
    }
}

/// `m.uuid ?? crypto.randomUUID()`.
fn uuid_or_random(m: &Value, env: &mut dyn ClientEnv) -> String {
    match prop(Some(m), "uuid") {
        None | Some(Value::Null) => env.random_uuid(),
        Some(v) => as_str(Some(v)).unwrap_or_default().to_owned(),
    }
}

/// `text += c.text` over the truthy `text` of each `text` block.
fn joined_text(content: Option<&Value>) -> Result<String, JsThrow> {
    let mut text = String::new();
    match content {
        Some(Value::String(s)) => push_js(&mut text, s),
        Some(Value::Array(items)) => {
            for c in items {
                let t = prop(Some(c), "text");
                if as_str(prop(Some(c), "type")) == Some("text") && truthy(t) {
                    push_js(&mut text, &to_js_string(t.expect("truthy"))?);
                }
            }
        }
        _ => {}
    }
    Ok(text)
}

/// `buildSubagentMessages`: a subagent's transcript from the raw SDK
/// envelopes a `task_snapshot` replays, folded like the live reducer, tagged
/// with the parent Task's tool_use id, and settled (not streaming).
pub fn build_subagent_messages(
    raw: &[Value],
    parent_tool_use_id: &str,
    env: &mut dyn ClientEnv,
) -> Result<Vec<DisplayMessage>, JsThrow> {
    let mut out: Vec<DisplayMessage> = Vec::new();
    let mut seen_user_uuids: IndexSet<String> = IndexSet::new();
    for item in raw {
        let (at, m) = subagent_item(item)?;
        match as_str(prop(Some(m), "type")) {
            Some("assistant") => {
                let sdk_uuid = uuid_or_random(m, env);
                let inner = prop(Some(m), "message");
                let message_id = as_str(prop(inner, "id"))
                    .filter(|s| !s.is_empty())
                    .map_or_else(|| sdk_uuid.clone(), str::to_owned);
                let blocks = blocks_from_sdk_content(prop(inner, "content"), env)?;
                upsert_assistant_split(
                    &mut out,
                    &AssistantSplit {
                        message_id,
                        sdk_uuid,
                        blocks,
                        parent_tool_use_id: Some(parent_tool_use_id.to_owned()),
                        at,
                        ..Default::default()
                    },
                );
            }
            Some("user") => {
                let uuid = uuid_or_random(m, env);
                if seen_user_uuids.contains(&uuid) {
                    continue;
                }
                let text = joined_text(prop(prop(Some(m), "message"), "content"))?;
                if text.is_empty() {
                    continue;
                }
                seen_user_uuids.insert(uuid.clone());
                let mut msg = DisplayMessage::new(uuid, Role::User, vec![DisplayBlock::text(text)]);
                msg.parent_tool_use_id = Some(parent_tool_use_id.to_owned());
                msg.created_at = at;
                out.push(msg);
            }
            _ => {}
        }
    }
    for msg in &mut out {
        if msg.role == Role::Assistant && msg.streaming == Some(true) {
            msg.streaming = Some(false);
        }
    }
    Ok(out)
}

/// `sortMessagesByChronology`: a stable sort by `createdAt`, a message
/// without one taking the last known time before it (0 before any).
/// `false` when the order was already right.
pub fn sort_messages_by_chronology(messages: &mut Vec<DisplayMessage>) -> bool {
    if messages.len() <= 1 {
        return false;
    }
    let effective: Vec<f64> = effective_times(messages).collect();
    let mut order: Vec<usize> = (0..messages.len()).collect();
    // `-0` and `0` tie, as `!==` sees them.
    order.sort_by(|&a, &b| {
        effective[a]
            .partial_cmp(&effective[b])
            .unwrap_or(std::cmp::Ordering::Equal)
            .then(a.cmp(&b))
    });
    if order.iter().enumerate().all(|(i, &j)| i == j) {
        return false;
    }
    let mut slots: Vec<Option<DisplayMessage>> = messages.drain(..).map(Some).collect();
    messages.extend(
        order
            .into_iter()
            .map(|j| slots[j].take().expect("a permutation")),
    );
    true
}

/// Each message's sort key in [`sort_messages_by_chronology`]: its
/// `createdAt`, else the last known one before it (0 before any).
fn effective_times(messages: &[DisplayMessage]) -> impl Iterator<Item = f64> + '_ {
    let mut last_known = f64::NEG_INFINITY;
    messages.iter().map(move |m| match m.created_at {
        Some(at) if at.is_finite() => {
            last_known = at;
            at
        }
        _ if last_known == f64::NEG_INFINITY => 0.0,
        _ => last_known,
    })
}

/// The first message `pred` accepts in the order
/// [`sort_messages_by_chronology`] gives, without sorting a copy: that order
/// is total on (effective time, index), so it is the accepted message with
/// the smallest effective time, the earliest on a tie (`-0` ties `0`, as in
/// the sort). One pass and no clone, so the per-event lookups over
/// `messagesRef.current` (the transcript as last rendered, i.e. sorted)
/// stay linear (U05e: a cloned, sorted copy per tool result made a replay
/// quadratic in deep clones).
pub fn first_chronological(
    messages: &[DisplayMessage],
    mut pred: impl FnMut(&DisplayMessage) -> bool,
) -> Option<&DisplayMessage> {
    let mut best: Option<(f64, &DisplayMessage)> = None;
    for (at, m) in effective_times(messages).zip(messages) {
        if best.is_none_or(|(b, _)| at < b) && pred(m) {
            best = Some((at, m));
        }
    }
    best.map(|(_, m)| m)
}

/// `applyToolResultToList`: set `result` on every `tool_use` block with
/// this id. `false` when no message holds one.
pub fn apply_tool_result_to_list(
    list: &mut [DisplayMessage],
    tool_use_id: &str,
    result: Option<&ToolResult>,
) -> bool {
    let mut changed = false;
    for m in list.iter_mut() {
        if !m
            .blocks
            .iter()
            .any(|b| b.tool_use_id() == Some(tool_use_id))
        {
            continue;
        }
        changed = true;
        for b in &mut m.blocks {
            if let DisplayBlock::ToolUse { id, result: r, .. } = b
                && id == tool_use_id
            {
                *r = result.cloned();
            }
        }
    }
    changed
}

/// `applyToolResultToTrails`: [`apply_tool_result_to_list`] over every
/// subagent trail.
pub fn apply_tool_result_to_trails(
    trails: &mut JsRecord<Vec<DisplayMessage>>,
    tool_use_id: &str,
    result: Option<&ToolResult>,
) -> bool {
    let mut changed = false;
    for list in trails.values_mut() {
        changed |= apply_tool_result_to_list(list, tool_use_id, result);
    }
    changed
}

/// `synthesizeOlder`: a page of raw JSONL records (a `loadOlder` page) as
/// top-level bubbles. Splits of one `message.id` fold into one bubble,
/// tool results patch their tool_use, CLI plumbing and subagent traffic are
/// dropped, user records carry their parsed `timestamp`, and assistants
/// inherit it (+1 ms per bubble).
pub fn synthesize_older(
    raw: &[Value],
    env: &mut dyn ClientEnv,
) -> Result<Vec<DisplayMessage>, JsThrow> {
    let mut out: Vec<DisplayMessage> = Vec::new();
    let mut carried_at: Option<f64> = None;
    for r in raw {
        let rec = Some(r);
        let kind = as_str(prop(rec, "type"));
        if !truthy(rec) || !matches!(kind, Some("assistant" | "user")) {
            continue;
        }
        if truthy(prop(rec, "parent_tool_use_id")) {
            continue;
        }
        let Some(uuid) = as_str(prop(rec, "uuid")).filter(|u| !u.is_empty()) else {
            continue;
        };
        if is_sdk_internal_envelope(rec) {
            continue;
        }
        let inner = prop(rec, "message");
        let content = prop(inner, "content");

        if kind == Some("assistant") {
            let msg_id = as_str(prop(inner, "id"))
                .filter(|s| !s.is_empty())
                .unwrap_or(uuid);
            let new_blocks = blocks_from_sdk_content(content, env)?;
            if let Some(last) = out.last_mut()
                && last.role == Role::Assistant
                && last.uuid == msg_id
            {
                let folded = last.folded_sdk_uuids.get_or_insert_with(IndexSet::new);
                if folded.insert(uuid.to_owned()) {
                    let tool_ids: IndexSet<String> = last
                        .blocks
                        .iter()
                        .filter_map(|b| b.tool_use_id().map(str::to_owned))
                        .collect();
                    last.blocks.extend(
                        new_blocks
                            .into_iter()
                            .filter(|b| b.tool_use_id().is_none_or(|id| !tool_ids.contains(id))),
                    );
                }
            } else {
                let at = carried_at;
                if let Some(c) = carried_at.as_mut() {
                    *c += 1.0;
                }
                let rate_limit_hit = is_rate_limit_hit_text(&new_blocks)
                    .then(|| rate_limit_hit_from_blocks(&new_blocks, None, None, None));
                let opus = is_opus_high_demand_text(&new_blocks).then_some(true);
                let blocks =
                    rewrite_model_unavailable_blocks(&new_blocks, None).unwrap_or(new_blocks);
                let mut m = DisplayMessage::new(msg_id, Role::Assistant, blocks);
                m.streaming = Some(false);
                m.folded_sdk_uuids = Some(IndexSet::from([uuid.to_owned()]));
                m.created_at = at;
                m.rate_limit_hit = rate_limit_hit;
                m.opus_high_demand = opus;
                out.push(m);
            }
            continue;
        }

        // A user record: a tool_result envelope, plumbing, or a prompt.
        if let Some(tr) = extract_tool_result(
            content,
            prop(rec, "tool_use_result"),
            prop(rec, "tool_result_meta"),
        )? {
            let patch = ToolResult {
                content: tr.text,
                is_error: tr.is_error,
                staged: tr.staged.then_some(true),
                detached: tr.detached.then_some(true),
                not_run: tr.not_run.then_some(true),
            };
            for m in out.iter_mut().rev() {
                if m.role != Role::Assistant {
                    continue;
                }
                let hit = m.blocks.iter_mut().find_map(|b| match b {
                    DisplayBlock::ToolUse { id, result, .. } if *id == tr.tool_use_id => {
                        Some(result)
                    }
                    _ => None,
                });
                if let Some(result) = hit {
                    *result = Some(patch);
                    break;
                }
            }
            continue;
        }
        if is_synthetic_task_notification(content)
            || is_compact_summary_content(content)
            || is_local_command_caveat_content(content)
            || is_image_resize_note_content(content)
            || is_sdk_slash_user_message(content)?.is_some()
        {
            continue;
        }
        if let Some(wrap) = parse_synthetic_cli_wrapper(content) {
            if !wrap.trailing().is_empty() {
                out.push(DisplayMessage::new(
                    trailing_bubble_uuid(uuid),
                    Role::User,
                    vec![DisplayBlock::text(wrap.trailing())],
                ));
            }
            continue;
        }
        let parsed_ts = as_str(prop(rec, "timestamp"))
            .and_then(claudius_core::js_date::date_parse)
            .map(|t| t as f64);
        if parsed_ts.is_some() {
            carried_at = parsed_ts;
        }
        let user = extract_user_content(content);
        let peer = extract_peer_origin(rec);
        let display_text = peer
            .as_ref()
            .and_then(|p| p.body.clone())
            .unwrap_or(user.text);
        let mut m = DisplayMessage::new(
            uuid,
            Role::User,
            if display_text.is_empty() {
                Vec::new()
            } else {
                vec![DisplayBlock::text(display_text)]
            },
        );
        m.images = (!user.images.is_empty()).then_some(user.images);
        m.created_at = parsed_ts;
        m.peer = peer.map(|p| p.to_display_peer());
        out.push(m);
    }
    Ok(out)
}

/// `trailingBubbleUuid` (lib/shared/forkable-uuid.ts): the display id of
/// the user prose lifted out of record `uuid`.
pub fn trailing_bubble_uuid(uuid: &str) -> String {
    format!("{uuid}{TRAILING_BUBBLE_SUFFIX}")
}

/// `TRAILING_BUBBLE_SUFFIX`.
pub const TRAILING_BUBBLE_SUFFIX: &str = ":trailing";
