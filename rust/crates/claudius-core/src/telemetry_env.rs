//! `lib/shared/telemetry-env.ts` (D22): the env keys a project / local
//! `settings.json` sets that Claude Code ignores at those scopes, for the
//! doctor. Keys come back in `Object.keys` order, spelled as stored.
//! Replayed against the TS in `tests/prompt_audit_golden.rs`.

use claudius_agent::js;
use serde_json::Value;

use crate::js_string;

/// `Object.keys(env)` for a value that passed `!env || typeof env !==
/// "object"` (an object or an array; `None` otherwise).
fn keys(env: Option<&Value>) -> Option<Vec<String>> {
    match env? {
        Value::Object(m) => Some(
            js::own_keys_order(m)
                .into_iter()
                .map(|(k, _)| k.clone())
                .collect(),
        ),
        Value::Array(items) => Some((0..items.len()).map(|i| i.to_string()).collect()),
        _ => None,
    }
}

/// `/^otel_/i.test(k)`: no `u` flag, so only ASCII letters fold.
fn otel_prefix(k: &str) -> bool {
    k.len() >= 5 && k.as_bytes()[..5].eq_ignore_ascii_case(b"otel_")
}

/// `ignoredTelemetryEnvKeys(env)`: `OTEL_*` (any case) and keys whose
/// `toUpperCase()` is `CLAUDE_CODE_ENABLE_TELEMETRY`.
pub fn ignored_telemetry_env_keys(env: Option<&Value>) -> Vec<String> {
    keys(env)
        .unwrap_or_default()
        .into_iter()
        .filter(|k| otel_prefix(k) || js_string::to_upper(k) == "CLAUDE_CODE_ENABLE_TELEMETRY")
        .collect()
}

/// `ignoredAttachmentsEnvKeys(env)`: keys whose `toUpperCase()` is
/// `CLAUDE_CODE_DISABLE_ATTACHMENTS` (so `ı` and `ſ` spell it too).
pub fn ignored_attachments_env_keys(env: Option<&Value>) -> Vec<String> {
    keys(env)
        .unwrap_or_default()
        .into_iter()
        .filter(|k| js_string::to_upper(k) == "CLAUDE_CODE_DISABLE_ATTACHMENTS")
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn matches() {
        let env = json!({"OTEL_X": "1", "otel_y": "1", "OTELX": "1", "Claude_Code_Enable_Telemetry": "1",
            "claude_code_dısable_attachmentſ": "1", "PATH": "x"});
        assert_eq!(
            ignored_telemetry_env_keys(Some(&env)),
            ["OTEL_X", "otel_y", "Claude_Code_Enable_Telemetry"]
        );
        assert_eq!(
            ignored_attachments_env_keys(Some(&env)),
            ["claude_code_dısable_attachmentſ"]
        );
        assert!(ignored_telemetry_env_keys(Some(&json!("OTEL_X"))).is_empty());
        assert!(ignored_telemetry_env_keys(None).is_empty());
    }
}
