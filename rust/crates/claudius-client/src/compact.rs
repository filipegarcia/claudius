//! The compaction divider and the resumed-transcript path:
//! `mergeCompactBoundary`, `normalizeCompactStats`,
//! `withPagedCompactBoundary` (CC 2.1.301) and `nextTranscriptPath`.

use claudius_agent::js;
use serde_json::Value;

use crate::sdk_filters::is_compact_summary_content;
use crate::text::{as_num, as_str, prop, push_js, to_js_string, truthy};
use crate::{CompactStats, JsThrow, SystemEntry, SystemEntryKind};

/// The divider's label.
pub const COMPACT_LABEL: &str = "Compacted earlier conversation";

/// `nextTranscriptPath`: after a `ready`, the resumed transcript's path. A
/// `ready` without the key keeps the previous one; `null` clears it.
pub fn next_transcript_path(prev: Option<&str>, ev: &Value) -> Result<Option<String>, JsThrow> {
    let Some(obj) = ev.as_object() else {
        if ev.is_array() {
            return Ok(prev.map(str::to_owned));
        }
        // `"transcriptPath" in 5` throws.
        let shown = match ev {
            Value::String(s) => s.clone(),
            v => js::to_string(Some(v)),
        };
        return Err(JsThrow::type_error(format!(
            "Cannot use 'in' operator to search for 'transcriptPath' in {shown}"
        )));
    };
    Ok(match obj.get("transcriptPath") {
        None => prev.map(str::to_owned),
        Some(v) => as_str(Some(v)).map(str::to_owned),
    })
}

/// `withPagedCompactBoundary`: when the `loadOlder` page that reaches the
/// top of the history (`has_more` false) holds the post-compact summary,
/// add the anchorless divider for it, unless a divider for this page (or an
/// anchorless one) is already there.
pub fn with_paged_compact_boundary(
    entries: &mut Vec<SystemEntry>,
    raw: &[Value],
    has_more: bool,
) -> Result<bool, JsThrow> {
    if has_more {
        return Ok(false);
    }
    let summary = raw.iter().find(|r| {
        let rec = Some(*r);
        truthy(rec)
            && as_str(prop(rec, "type")) == Some("user")
            && !truthy(prop(rec, "parent_tool_use_id"))
            && (prop(rec, "isCompactSummary") == Some(&Value::Bool(true))
                || is_compact_summary_content(prop(prop(rec, "message"), "content")))
    });
    let Some(summary) = summary else {
        return Ok(false);
    };
    let Some(uuid) = as_str(prop(Some(summary), "uuid")).filter(|u| !u.is_empty()) else {
        return Ok(false);
    };
    let mut page_uuids = vec![uuid];
    for r in raw {
        if as_str(prop(Some(r), "type")) == Some("system")
            && let Some(u) = as_str(prop(Some(r), "uuid"))
        {
            page_uuids.push(u);
        }
    }
    if entries.iter().any(|e| {
        e.kind == SystemEntryKind::CompactBoundary
            && (page_uuids.contains(&e.uuid.as_str()) || e.after_message_uuid.is_empty())
    }) {
        return Ok(false);
    }
    let mut text = String::new();
    match prop(prop(Some(summary), "message"), "content") {
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
    let text = js::trim(&text);
    let mut entry = SystemEntry::new(uuid, "", SystemEntryKind::CompactBoundary, COMPACT_LABEL);
    entry.compact_summary = (!text.is_empty()).then(|| text.to_owned());
    entries.push(entry);
    Ok(true)
}

/// `mergeCompactBoundary`: the boundary record (stats) and the summary
/// record arrive separately for one compaction; the first creates the
/// divider (matched by `uuid` or by its anchor) and the other enriches it.
pub fn merge_compact_boundary(
    entries: &mut Vec<SystemEntry>,
    uuid: &str,
    anchor: &str,
    compact_stats: Option<&CompactStats>,
    compact_summary: Option<&str>,
) {
    let summary = compact_summary.filter(|s| !s.is_empty());
    let idx = entries.iter().position(|e| {
        e.kind == SystemEntryKind::CompactBoundary
            && (e.uuid == uuid || e.after_message_uuid == anchor)
    });
    let Some(idx) = idx else {
        let mut entry = SystemEntry::new(
            uuid,
            anchor,
            SystemEntryKind::CompactBoundary,
            COMPACT_LABEL,
        );
        entry.compact_stats = compact_stats.cloned();
        entry.compact_summary = summary.map(str::to_owned);
        entries.push(entry);
        return;
    };
    let existing = &mut entries[idx];
    if let Some(patch) = compact_stats {
        let old = existing.compact_stats.take().unwrap_or_default();
        existing.compact_stats = Some(CompactStats {
            pre_tokens: patch.pre_tokens.or(old.pre_tokens),
            post_tokens: patch.post_tokens.or(old.post_tokens),
            duration_ms: patch.duration_ms.or(old.duration_ms),
            trigger: patch.trigger.clone().or(old.trigger),
        });
    }
    if let Some(s) = summary {
        existing.compact_summary = Some(s.to_owned());
    }
}

/// `normalizeCompactStats`: the SDK's compact metadata (snake_case live,
/// camelCase on disk) as `compactStats`; `None` when it carries none.
pub fn normalize_compact_stats(meta: Option<&Value>) -> Option<CompactStats> {
    if !truthy(meta) || !meta.is_some_and(|m| m.is_object() || m.is_array()) {
        return None;
    }
    let num = |keys: [&str; 2]| {
        keys.iter()
            .find_map(|k| as_num(prop(meta, k)).filter(|v| v.is_finite()))
    };
    let trigger = as_str(prop(meta, "trigger")).filter(|t| !t.is_empty());
    let stats = CompactStats {
        pre_tokens: num(["pre_tokens", "preTokens"]),
        post_tokens: num(["post_tokens", "postTokens"]),
        duration_ms: num(["duration_ms", "durationMs"]),
        trigger: trigger.map(str::to_owned),
    };
    (stats != CompactStats::default()).then_some(stats)
}
