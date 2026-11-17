//! `lib/server/sdk-cost-state.ts`: the usage checkpoint a resumed CLI
//! restores — the LAST valid `{"type":"cost-state"}` record for the session
//! in its transcript (the CLI treats the record as last-wins per session id).
//!
//! The engine writes one when a CLI exits gracefully, so after a reap / kill
//! the checkpoint lags the real spend, and a short-lived side process can
//! leave a $0 one. Either way it's what the next CLI re-reports as the start
//! of its "cumulative" `total_cost_usd` / `modelUsage`, which is why the
//! usage fold ([`crate::sessions_db::fold_result_into_usage`]) seeds `last`
//! with it.

use claudius_agent::js;
use serde_json::{Map, Value};

use crate::jsonl_lines::JsonlLines;
use crate::paths;
use crate::sessions_db::SdkCumulative;

const MODEL_USAGE_NUMERIC_FIELDS: [&str; 6] = [
    "inputTokens",
    "outputTokens",
    "cacheReadInputTokens",
    "cacheCreationInputTokens",
    "webSearchRequests",
    "costUSD",
];

/// `isCount(v, max)`: a finite number in `[0, max]`.
fn is_count(v: Option<&Value>, max: f64) -> bool {
    v.and_then(Value::as_f64)
        .is_some_and(|f| f.is_finite() && f >= 0.0 && f <= max)
}

/// `parseCostState`: mirror of the CLI's own schema check — an entry it
/// rejects isn't restored, so it mustn't become the baseline either.
fn parse_cost_state(entry: &Map<String, Value>) -> Option<SdkCumulative> {
    if !is_count(entry.get("totalCostUSD"), 1e9) || !is_count(entry.get("totalAPIDuration"), 1e15) {
        return None;
    }
    // `!raw || typeof raw !== "object" || Array.isArray(raw)`
    let raw_models = entry.get("modelUsage")?.as_object()?;
    let mut model_usage = Map::new();
    for (model, raw) in js::own_keys_order(raw_models) {
        // An array entry passes TS's `typeof` check but then fails the field
        // checks; either way the whole record is rejected.
        let m = raw.as_object()?;
        if !MODEL_USAGE_NUMERIC_FIELDS
            .iter()
            .all(|f| is_count(m.get(*f), 1e15))
        {
            return None;
        }
        if m.contains_key("thinkingTokens") && !is_count(m.get("thinkingTokens"), 1e15) {
            return None;
        }
        model_usage.insert(model.clone(), Value::Object(m.clone()));
    }
    Some(SdkCumulative {
        total_cost_usd: entry["totalCostUSD"].as_f64()?,
        duration_api_ms: entry["totalAPIDuration"].as_f64()?,
        model_usage: (!model_usage.is_empty()).then_some(model_usage),
    })
}

/// `lastRecordedCostState(id, cwd)`: `None` when there's no checkpoint, the
/// id isn't `/^[\w-]+$/`, or the file can't be read.
pub fn last_recorded_cost_state(id: &str, cwd: &str) -> Option<SdkCumulative> {
    if !crate::is_safe_id(id) {
        return None;
    }
    let dir = paths::project_root(cwd);
    let file = paths::within(&dir, &format!("{id}.jsonl"))?;
    let f = std::fs::File::open(&file).ok()?;
    last_in(JsonlLines::new(f), id)
}

/// The loop over `jsonlLines(createReadStream(file, "utf8"))` (see
/// [`crate::jsonl_lines`]). It sits in one `try`, so a read that fails
/// part-way (a directory's `EISDIR`, V8's string limit on one line) is
/// `null`, even after a valid checkpoint.
fn last_in(
    lines: impl Iterator<Item = std::io::Result<String>>,
    id: &str,
) -> Option<SdkCumulative> {
    let mut last = None;
    for line in lines {
        let line = line.ok()?;
        if !line.contains("\"cost-state\"") {
            continue;
        }
        let Ok(Value::Object(entry)) = js::json_parse(&line) else {
            continue; // torn trailing line mid-write, or not a record
        };
        if entry.get("type").and_then(Value::as_str) != Some("cost-state")
            || entry.get("sessionId").and_then(Value::as_str) != Some(id)
        {
            continue;
        }
        if let Some(parsed) = parse_cost_state(&entry) {
            last = Some(parsed);
        }
    }
    last
}

#[cfg(test)]
mod tests {
    use super::*;

    fn checkpoint(id: &str, cost: u32) -> String {
        format!(
            r#"{{"type":"cost-state","sessionId":"{id}","totalCostUSD":{cost},"totalAPIDuration":1,"modelUsage":{{}}}}"#
        )
    }

    fn cost(lines: impl Iterator<Item = std::io::Result<String>>) -> Option<f64> {
        last_in(lines, "s-1").map(|c| c.total_cost_usd)
    }

    #[test]
    fn a_line_past_the_string_limit_reads_as_no_checkpoint() {
        let (one, two) = (checkpoint("s-1", 1), checkpoint("s-1", 2));
        let limit = one.len().max(two.len());
        // Every line fits: the last checkpoint wins.
        let fits = format!("{one}\n{two}\n");
        assert_eq!(
            cost(JsonlLines::with_limit(fits.as_bytes(), limit)),
            Some(2.0)
        );
        // A later line past the limit throws out of the loop (`RangeError`)
        // into the `catch`: `null`, not the checkpoint read before it.
        let long = format!("{one}\n{}\n{two}\n", "x".repeat(limit + 1));
        assert_eq!(cost(JsonlLines::with_limit(long.as_bytes(), limit)), None);
    }

    #[test]
    fn a_read_error_part_way_reads_as_no_checkpoint() {
        let failing = [
            Ok(checkpoint("s-1", 3)),
            Err(std::io::Error::other("EIO")),
            Ok(checkpoint("s-1", 4)),
        ];
        assert_eq!(cost(failing.into_iter()), None);
        assert_eq!(cost([Ok(checkpoint("s-1", 3))].into_iter()), Some(3.0));
    }
}
