//! session.ts `seedUsageBaseline` and cost-aggregate.ts
//! `estimateSessionUsageFromTranscripts`: where a session's cost/usage
//! totals start. The persisted `session_usage` row wins; without one, a
//! resumed session gets a one-time estimate priced from every API call in its
//! transcripts — the main `<id>.jsonl` AND the Task-subagent / Workflow-agent
//! transcripts under `<id>/subagents/` — which is then saved so it isn't
//! recomputed. (The old estimate read the resume's message chain, which is
//! only the post-compaction tail: a long session seeded near $0.)
//!
//! Calls dedupe by `message.id:requestId` across the files (the JSONL writes
//! one record per content-block split, each with the full `usage`), price
//! with [`crate::cost_pricing::cost_from_tokens`] (the record's own `costUSD`
//! wins; the 1-hour cache-write share at its own rate; times the US
//! data-residency premium), count a turn per main-thread call, and leave the
//! durations at 0 (result frames never reach the JSONL).

use std::path::Path;

use claudius_agent::js;
use serde_json::{Map, Value};

use crate::cost_pricing::{TokenBreakdown, cost_from_tokens, inference_geo_multiplier};
use crate::sessions_db::{self, UsageTotals};
use crate::{js_num, paths};

/// Workflow agents nest at `subagents/workflows/wf_<id>/agent-*.jsonl`.
const SUBAGENT_MAX_DEPTH: usize = 4;

/// `subagentTranscripts(dir, id)`: every `*.jsonl` under `<dir>/<id>/subagents/`
/// (plain files and directories only — symlinks are neither), sorted like
/// JS `Array.prototype.sort` (UTF-16 code units).
pub(crate) fn subagent_transcripts(dir: &Path, session_id: &str) -> Vec<String> {
    if !crate::is_safe_id(session_id) {
        return Vec::new();
    }
    let Some(root) = paths::within(dir, &format!("{session_id}/subagents")) else {
        return Vec::new();
    };
    let mut out = Vec::new();
    let mut stack = vec![(root, 0usize)];
    while let Some((at, depth)) = stack.pop() {
        if !at.starts_with(dir) {
            continue;
        }
        let Ok(entries) = std::fs::read_dir(&at) else {
            continue; // no subagents dir (the common case) or unreadable
        };
        for e in entries.flatten() {
            let Ok(ft) = e.file_type() else { continue };
            let child = at.join(e.file_name());
            if ft.is_dir() {
                if depth < SUBAGENT_MAX_DEPTH {
                    stack.push((child, depth + 1));
                }
            } else if ft.is_file() && e.file_name().to_string_lossy().ends_with(".jsonl") {
                out.push(child.to_string_lossy().into_owned());
            }
        }
    }
    out.sort_by(|a, b| a.encode_utf16().cmp(b.encode_utf16()));
    out
}

/// One API call read off a transcript line (`transcriptApiCall`).
struct ApiCall {
    key: Option<String>,
    model: String,
    input: f64,
    output: f64,
    cache_read: f64,
    cache_write: f64,
    usd: f64,
}

/// JS `Math.max(a, b)` / `Math.min(a, b)` on non-NaN numbers, `-0 < +0`.
fn js_max(a: f64, b: f64) -> f64 {
    if a == b {
        if a.is_sign_positive() { a } else { b }
    } else {
        a.max(b)
    }
}
fn js_min(a: f64, b: f64) -> f64 {
    if a == b {
        if a.is_sign_negative() { a } else { b }
    } else {
        a.min(b)
    }
}

/// `transcriptApiCall(line)`: an assistant record with a plain-object
/// `message.usage`, skipping `<synthetic>` models. Token fields count only
/// when they're finite numbers.
fn transcript_api_call(line: &str) -> Option<ApiCall> {
    if !line.starts_with('{') {
        return None;
    }
    let r = js::json_parse(line).ok()?;
    let r = r.as_object()?;
    if r.get("type").and_then(Value::as_str) != Some("assistant") {
        return None;
    }
    let message = r.get("message")?.as_object()?;
    let u = message.get("usage")?.as_object()?;
    let model = message
        .get("model")
        .and_then(Value::as_str)
        .unwrap_or("(unknown)");
    if model.starts_with("<synthetic>") {
        return None;
    }
    let n = |v: Option<&Value>| {
        v.and_then(Value::as_f64)
            .filter(|f| f.is_finite())
            .unwrap_or(0.0)
    };
    let buckets = u.get("cache_creation").and_then(Value::as_object);
    let input = n(u.get("input_tokens"));
    let output = n(u.get("output_tokens"));
    let cache_read = n(u.get("cache_read_input_tokens"));
    // `n(total) || n(5m) + n(1h)` — `||` falls through on 0 and -0.
    let total = n(u.get("cache_creation_input_tokens"));
    let b1h = n(buckets.and_then(|b| b.get("ephemeral_1h_input_tokens")));
    let cache_write = if total != 0.0 {
        total
    } else {
        n(buckets.and_then(|b| b.get("ephemeral_5m_input_tokens"))) + b1h
    };
    let cache_write_1h = js_min(js_max(b1h, 0.0), js_max(cache_write, 0.0));
    let id = message.get("id").and_then(Value::as_str);
    let req = r.get("requestId").and_then(Value::as_str).unwrap_or("");
    let usd = match r.get("costUSD").and_then(Value::as_f64) {
        Some(c) if c.is_finite() => c,
        _ => {
            cost_from_tokens(
                Some(model),
                &TokenBreakdown {
                    input,
                    output,
                    cache_read,
                    cache_write_5m: cache_write - cache_write_1h,
                    cache_write_1h,
                },
            ) * inference_geo_multiplier(u.get("inference_geo").and_then(Value::as_str))
        }
    };
    Some(ApiCall {
        key: id.map(|id| format!("{id}:{req}")),
        model: model.to_owned(),
        input,
        output,
        cache_read,
        cache_write,
        usd,
    })
}

/// `estimateSessionUsageFromTranscripts(cwd, id)`: `None` when the id isn't
/// `/^[\w-]+$/` or no API call is found.
pub fn estimate_usage_from_transcripts(cwd: &str, session_id: &str) -> Option<UsageTotals> {
    if !crate::is_safe_id(session_id) {
        return None;
    }
    let dir = paths::project_root(cwd);
    let main = paths::within(&dir, &format!("{session_id}.jsonl"))?;
    let main = main.to_string_lossy().into_owned();
    let mut files = vec![main.clone()];
    files.extend(subagent_transcripts(&dir, session_id));

    let mut est = UsageTotals::default();
    // Insertion-ordered per-model rows (`Object.fromEntries(map)`).
    let mut models: Vec<(String, [f64; 5])> = Vec::new();
    let mut seen = std::collections::HashSet::new();
    let mut calls = 0usize;
    for path in &files {
        let Ok(bytes) = std::fs::read(path) else {
            continue;
        };
        let text = String::from_utf8_lossy(&bytes);
        for line in text.split('\n') {
            let Some(call) = transcript_api_call(line) else {
                continue;
            };
            if let Some(key) = &call.key
                && !seen.insert(key.clone())
            {
                continue;
            }
            calls += 1;
            if *path == main {
                est.num_turns += 1.0;
            }
            est.total_cost_usd += call.usd;
            est.input_tokens += call.input;
            est.output_tokens += call.output;
            est.cache_read_input_tokens += call.cache_read;
            est.cache_creation_input_tokens += call.cache_write;
            let i = match models.iter().position(|(m, _)| *m == call.model) {
                Some(i) => i,
                None => {
                    models.push((call.model.clone(), [0.0; 5]));
                    models.len() - 1
                }
            };
            let m = &mut models[i].1;
            m[0] += call.input;
            m[1] += call.output;
            m[2] += call.cache_read;
            m[3] += call.cache_write;
            m[4] += call.usd;
        }
    }
    if calls == 0 {
        return None;
    }
    let mut model_usage = Map::new();
    for (model, m) in models {
        let mut entry = Map::new();
        entry.insert("inputTokens".into(), js_num(m[0]));
        entry.insert("outputTokens".into(), js_num(m[1]));
        entry.insert("cacheReadInputTokens".into(), js_num(m[2]));
        entry.insert("cacheCreationInputTokens".into(), js_num(m[3]));
        entry.insert("webSearchRequests".into(), js_num(0.0));
        entry.insert("costUSD".into(), js_num(m[4]));
        model_usage.insert(model, Value::Object(entry));
    }
    est.model_usage = Some(model_usage);
    Some(est)
}

/// The totals half of `seedUsageBaseline`: the persisted row, else (for a
/// resumed session) the transcript estimate of `resume`, saved as this
/// session's row (best effort, like the TS `void saveSessionUsage(…)`).
/// `None` keeps the zero totals.
pub fn seed_usage_totals(cwd: &str, session_id: &str, resume: Option<&str>) -> Option<UsageTotals> {
    if let Some(persisted) = sessions_db::get_session_usage(cwd, session_id) {
        return Some(persisted);
    }
    let est = estimate_usage_from_transcripts(cwd, resume?)?;
    if let Err(e) = sessions_db::save_session_usage(cwd, session_id, &est) {
        tracing::debug!(target: crate::log::SESSION, "[session] {session_id}: usage estimate not saved: {e}");
    }
    Some(est)
}
