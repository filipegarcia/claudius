//! The server-side half of `lib/shared/effort-flags.ts`: the
//! `applyFlagSettings` payload for an effort pick, and the applied effort in
//! a `get_settings` response. (`capEffortLevels` and `parseEffortArgs` are
//! client-only.)

use serde_json::{Map, Value, json};

/// `EffortFlagLevel`: what the picker and `POST /:id/effort` accept.
pub const EFFORT_LEVELS: [&str; 6] = ["low", "medium", "high", "xhigh", "max", "auto"];

/// `EFFORT_TIER_ORDER`: the levels the CLI can apply, low → high ("auto" is
/// adaptive, not a tier).
pub const EFFORT_TIERS: [&str; 5] = ["low", "medium", "high", "xhigh", "max"];

/// `buildEffortFlagSettings(level, ultracode)`. "auto" clears the override
/// (`effortLevel: null`). An `effortLevel` sent without an `ultracode` key
/// turns ultracode off (CC 2.1.284), so the key rides along only when
/// ultracode is on.
pub fn build_effort_flag_settings(level: &str, ultracode: bool) -> Value {
    let mut out = Map::new();
    out.insert(
        "effortLevel".into(),
        if level == "auto" {
            Value::Null
        } else {
            json!(level)
        },
    );
    if ultracode {
        out.insert("ultracode".into(), Value::Bool(true));
    }
    Value::Object(out)
}

/// `parseAppliedEffort(response)`: `applied.effort` from a `get_settings`
/// response. `Some(tier)`, `Some(null)` (no effort parameter will be sent),
/// or `None` (`undefined`) when the response doesn't carry a usable value: an
/// older CLI, a malformed payload or an unknown future level.
pub fn parse_applied_effort(response: &Value) -> Option<Value> {
    // `Value::get` is `None` on anything but an object: the JS `typeof
    // applied !== "object"` and `"effort" in applied` checks in one.
    let effort = response.get("applied")?.get("effort")?;
    if effort.is_null() {
        return Some(Value::Null);
    }
    effort
        .as_str()
        .filter(|e| EFFORT_TIERS.contains(e))
        .map(|e| json!(e))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn builds_the_flag_payload() {
        assert_eq!(
            build_effort_flag_settings("high", false),
            json!({"effortLevel": "high"})
        );
        assert_eq!(
            build_effort_flag_settings("auto", true),
            json!({"effortLevel": null, "ultracode": true})
        );
    }

    #[test]
    fn parses_applied_effort() {
        assert_eq!(
            parse_applied_effort(&json!({"applied": {"effort": "max"}})),
            Some(json!("max"))
        );
        assert_eq!(
            parse_applied_effort(&json!({"applied": {"effort": null}})),
            Some(Value::Null)
        );
        assert_eq!(
            parse_applied_effort(&json!({"applied": {"effort": "auto"}})),
            None
        );
        assert_eq!(parse_applied_effort(&json!({"applied": {}})), None);
        assert_eq!(parse_applied_effort(&json!(null)), None);
    }
}
