//! The server-side half of `lib/shared/schedule-form.ts`: the effort levels
//! a scheduled job can run at and [`parse_schedule_effort`], the validation
//! the schedule create / patch routes run over an untrusted body (CC
//! 2.1.312). `isScheduleFormDirty` is the form's own, client-only.

use serde_json::Value;

/// `SCHEDULE_EFFORT_LEVELS`, in picker order.
pub const SCHEDULE_EFFORT_LEVELS: [&str; 5] = ["low", "medium", "high", "xhigh", "max"];

/// What `parseScheduleEffort` returns.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ScheduleEffort<'a> {
    /// A known level.
    Level(&'a str),
    /// `null`: back to the model's default (`null` or `""` in the body).
    Clear,
    /// `undefined`: absent, or not a known level (the caller 400s).
    Unknown,
}

/// `parseScheduleEffort(v)`: the level, `Clear` for an explicit `null` / `""`,
/// `Unknown` for anything else. `v` is `None` for a key that isn't there
/// (`undefined`), which the callers tell apart before calling this.
pub fn parse_schedule_effort(v: Option<&Value>) -> ScheduleEffort<'_> {
    match v {
        Some(Value::Null) => ScheduleEffort::Clear,
        Some(Value::String(s)) if s.is_empty() => ScheduleEffort::Clear,
        Some(Value::String(s)) if SCHEDULE_EFFORT_LEVELS.contains(&s.as_str()) => {
            ScheduleEffort::Level(s)
        }
        _ => ScheduleEffort::Unknown,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn only_a_known_level_or_an_explicit_clear_parses() {
        for level in SCHEDULE_EFFORT_LEVELS {
            assert_eq!(
                parse_schedule_effort(Some(&json!(level))),
                ScheduleEffort::Level(level)
            );
        }
        assert_eq!(
            parse_schedule_effort(Some(&Value::Null)),
            ScheduleEffort::Clear
        );
        assert_eq!(
            parse_schedule_effort(Some(&json!(""))),
            ScheduleEffort::Clear
        );
        for bad in [
            json!("LOW"),
            json!(" low"),
            json!("auto"),
            json!("none"),
            json!(5),
            json!(true),
            json!(["low"]),
            json!({"level": "low"}),
            // `includes` finds no prototype name.
            json!("toString"),
        ] {
            assert_eq!(
                parse_schedule_effort(Some(&bad)),
                ScheduleEffort::Unknown,
                "{bad}"
            );
        }
        assert_eq!(parse_schedule_effort(None), ScheduleEffort::Unknown);
    }
}
