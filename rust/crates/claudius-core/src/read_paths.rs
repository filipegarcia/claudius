//! `lib/shared/read-tool-paths.ts` and the session's B2.3 re-seed: the
//! files the model has Read, so that after a `compact_boundary` (which strips
//! the CLI's readFileState cache) they can be replayed through
//! `seed_read_state(path, mtime)` and a later Edit doesn't fail "file not
//! read yet".

use std::time::SystemTime;

use serde_json::Value;

/// `extractReadPaths(message)`: the non-empty `file_path` of every `Read`
/// `tool_use` block in an assistant message's `message.content`, in order
/// and with repeats. Anything else, including an unexpected shape, yields
/// nothing.
pub fn extract_read_paths(message: &Value) -> Vec<String> {
    if message.get("type").and_then(Value::as_str) != Some("assistant") {
        return Vec::new();
    }
    let Some(content) = message
        .get("message")
        .and_then(|m| m.get("content"))
        .and_then(Value::as_array)
    else {
        return Vec::new();
    };
    content
        .iter()
        .filter(|b| b.get("type").and_then(Value::as_str) == Some("tool_use"))
        .filter(|b| b.get("name").and_then(Value::as_str) == Some("Read"))
        .filter_map(|b| b.get("input")?.get("file_path")?.as_str())
        .filter(|p| !p.is_empty())
        .map(str::to_owned)
        .collect()
}

/// `Math.floor(stat.mtimeMs)`: Node's `mtimeMs` is the double
/// `sec * 1e3 + nsec / 1e6`, so a time a few nanoseconds short of a whole
/// second floors up to it. The CLI derives the mtime it compares against the
/// same way.
pub fn floored_mtime_ms(t: SystemTime) -> i64 {
    crate::node_fs::mtime_ms(t).floor() as i64
}

#[cfg(test)]
mod tests {
    use super::floored_mtime_ms;
    use std::time::{Duration, UNIX_EPOCH};

    #[test]
    fn the_mtime_floors_nodes_double() {
        for (sec, nsec, want) in [
            (1_700_000_000, 999_999_999, 1_700_000_001_000),
            (1_700_000_000, 999_999_000, 1_700_000_000_999),
            (1_792_970_818, 569_123_456, 1_792_970_818_569),
            (0, 1, 0),
        ] {
            let t = UNIX_EPOCH + Duration::new(sec, nsec);
            assert_eq!(floored_mtime_ms(t), want, "{sec}.{nsec}");
        }
        for (before, want) in [
            (Duration::new(1, 500_000_000), -1500),
            (Duration::new(2, 0), -2000),
            (Duration::new(0, 1), -1),
            // Far enough back that a truncating split rounds differently.
            (
                Duration::new(380_674_193_700_000, 844_687_930),
                -380_674_193_700_000_896,
            ),
        ] {
            assert_eq!(floored_mtime_ms(UNIX_EPOCH - before), want, "{before:?}");
        }
    }
}
