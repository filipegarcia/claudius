//! The pure parts of session.ts `consume()` (S28): the `/model` chat-command
//! parse, the `queued_turn_count` read, and the `plan_usage` event a
//! successful turn's `get_usage` reply becomes (with
//! `lib/shared/plan-usage.ts` `normalizeExtraUsage`). `Session::on_message`
//! calls them. Replayed against the TS, `tests/session_consume_golden.rs`.

use claudius_agent::js;
use serde_json::{Map, Value, json};

/// The model a `system/local_command_output` names:
/// `/^set\s+model\s+to\s+(\S+)/i.exec(content ?? "")`. `content` is coerced
/// as `exec` coerces it (`String(v)`); `\s` is JS whitespace and `/i` (no `u`
/// flag) folds ASCII letters only, so `ſ` (U+017F) is not an `s`.
pub fn set_model_target(content: Option<&Value>) -> Option<String> {
    let text = match content {
        None | Some(Value::Null) => String::new(),
        Some(v) => js::to_string(Some(v)),
    };
    let rest = strip_ascii_ci(&text, "set")?;
    let rest = strip_space(rest)?;
    let rest = strip_ascii_ci(rest, "model")?;
    let rest = strip_space(rest)?;
    let rest = strip_ascii_ci(rest, "to")?;
    let rest = strip_space(rest)?;
    let end = rest.find(js::is_whitespace).unwrap_or(rest.len());
    (end > 0).then(|| rest[..end].to_owned())
}

/// `word` at the start of `s`, ASCII case-insensitively.
fn strip_ascii_ci<'a>(s: &'a str, word: &str) -> Option<&'a str> {
    let head = s.get(..word.len())?;
    head.eq_ignore_ascii_case(word).then(|| &s[word.len()..])
}

/// `\s+`: at least one JS whitespace char, all of them taken (greedy; the
/// next token starts with a non-space, so no backtracking is needed).
fn strip_space(s: &str) -> Option<&str> {
    let rest = s.trim_start_matches(js::is_whitespace);
    (rest.len() < s.len()).then_some(rest)
}

/// `queued_turn_count`: a finite positive number, floored; else 0.
pub fn queued_turns(reported: Option<&Value>) -> f64 {
    reported
        .and_then(Value::as_f64)
        .filter(|n| n.is_finite() && *n > 0.0)
        .map_or(0.0, f64::floor)
}

/// `obj.key` on a parsed JSON value: an object's own property; `None`
/// (`undefined`) on anything else, as for a primitive or an array.
fn prop<'a>(v: &'a Value, key: &str) -> Option<&'a Value> {
    v.as_object()?.get(key)
}

/// `obj.key ?? null`.
fn or_null(v: &Value, key: &str) -> Value {
    prop(v, key).cloned().unwrap_or(Value::Null)
}

/// An object literal's property: an `undefined` value is left out, as
/// `JSON.stringify` leaves it out.
fn put(m: &mut Map<String, Value>, key: &str, v: Option<&Value>) {
    if let Some(v) = v {
        m.insert(key.to_owned(), v.clone());
    }
}

/// `normalizeExtraUsage(raw)`: `None` for a falsy `raw`.
pub fn normalize_extra_usage(raw: Option<&Value>) -> Option<Value> {
    let raw = raw.filter(|r| js::truthy(r))?;
    let mut m = Map::new();
    put(&mut m, "isEnabled", prop(raw, "is_enabled"));
    m.insert("monthlyLimit".into(), or_null(raw, "monthly_limit"));
    m.insert("usedCredits".into(), or_null(raw, "used_credits"));
    m.insert("utilization".into(), or_null(raw, "utilization"));
    m.insert("currency".into(), or_null(raw, "currency"));
    Some(Value::Object(m))
}

/// The rate-limit windows, in the event's key order.
const WINDOWS: [(&str, &str); 5] = [
    ("fiveHour", "five_hour"),
    ("sevenDay", "seven_day"),
    ("sevenDayOauthApps", "seven_day_oauth_apps"),
    ("sevenDayOpus", "seven_day_opus"),
    ("sevenDaySonnet", "seven_day_sonnet"),
];

/// The `plan_usage` event for a `get_usage` reply, stamped `fetched_at`.
/// `None` where the TS throws (an unhandled rejection, so nothing is
/// broadcast): a `null` reply, a truthy `model_scoped` that isn't an array,
/// or a `null` entry in it. A reply without a `response` reads as `{}` here
/// (`QueryHandle::request`), where the SDK hands TS `undefined`, which throws
/// too; the CLI always sends one.
pub fn plan_usage_event(usage: &Value, fetched_at: i64) -> Option<Value> {
    if usage.is_null() {
        return None;
    }
    let rl = prop(usage, "rate_limits");
    let mut ev = Map::new();
    ev.insert("type".into(), json!("plan_usage"));
    put(
        &mut ev,
        "subscriptionType",
        prop(usage, "subscription_type"),
    );
    put(
        &mut ev,
        "rateLimitsAvailable",
        prop(usage, "rate_limits_available"),
    );
    let rate_limits = match rl.filter(|r| js::truthy(r)) {
        None => Value::Null,
        Some(rl) => {
            let mut m = Map::new();
            for (key, field) in WINDOWS {
                // A truthy window is mapped; a falsy one passes through.
                match prop(rl, field) {
                    Some(w) if js::truthy(w) => {
                        let mut wm = Map::new();
                        put(&mut wm, "utilization", prop(w, "utilization"));
                        put(&mut wm, "resetsAt", prop(w, "resets_at"));
                        m.insert(key.into(), Value::Object(wm));
                    }
                    other => put(&mut m, key, other),
                }
            }
            Value::Object(m)
        }
    };
    ev.insert("rateLimits".into(), rate_limits);
    let rl = rl.unwrap_or(&Value::Null);
    if let Some(scoped) = prop(rl, "model_scoped").filter(|v| js::truthy(v)) {
        let mut out = Vec::new();
        // `.map` on a non-array throws; so does `null.display_name`.
        for ms in scoped.as_array()? {
            if ms.is_null() {
                return None;
            }
            let mut m = Map::new();
            put(&mut m, "displayName", prop(ms, "display_name"));
            put(&mut m, "utilization", prop(ms, "utilization"));
            put(&mut m, "resetsAt", prop(ms, "resets_at"));
            out.push(Value::Object(m));
        }
        ev.insert("modelScoped".into(), Value::Array(out));
    }
    if let Some(spend) = prop(rl, "spend_limit").filter(|v| js::truthy(v)) {
        ev.insert(
            "spendLimit".into(),
            json!({
                "limitUsd": or_null(spend, "limit_usd"),
                "usedUsd": or_null(spend, "used_usd"),
                "utilization": or_null(spend, "utilization"),
                "currency": or_null(spend, "currency"),
            }),
        );
    }
    if let Some(extra) = normalize_extra_usage(prop(rl, "extra_usage")) {
        ev.insert("extraUsage".into(), extra);
    }
    ev.insert("fetchedAt".into(), json!(fetched_at));
    Some(Value::Object(ev))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn set_model_follows_the_js_regex() {
        let t = |v: Value| set_model_target(Some(&v));
        assert_eq!(t(json!("Set model to opus")).as_deref(), Some("opus"));
        assert_eq!(t(json!("sEt\tMODEL \u{a0}TO x y")).as_deref(), Some("x"));
        assert_eq!(t(json!("set model to \u{feff}bom")).as_deref(), Some("bom"));
        assert_eq!(t(json!(["Set model to arr"])).as_deref(), Some("arr"));
        assert_eq!(t(json!("set\u{85}model to nel")), None);
        // NEL isn't JS whitespace, BOM is: `\S+` runs through one, not the other.
        assert_eq!(
            t(json!("set model to a\u{85}b\u{feff}c")).as_deref(),
            Some("a\u{85}b")
        );
        assert_eq!(t(json!("\u{17f}et model to s")), None);
        assert_eq!(t(json!("set model to")), None);
        assert_eq!(t(json!("set model to ")), None);
        assert_eq!(t(json!(" set model to x")), None);
        assert_eq!(t(json!("setmodel to x")), None);
        assert_eq!(t(json!(5)), None);
        assert_eq!(set_model_target(None), None);
        assert_eq!(t(Value::Null), None);
        assert_eq!(t(json!("SET MODEL TO \u{e9}x")).as_deref(), Some("\u{e9}x"));
    }

    #[test]
    fn queued_turns_floor_positive_finite_numbers() {
        let q = |v: Value| queued_turns(Some(&v));
        assert_eq!(q(json!(2.7)), 2.0);
        assert_eq!(q(json!(0.5)), 0.0);
        assert_eq!(q(json!(-1)), 0.0);
        assert_eq!(q(json!("3")), 0.0);
        assert_eq!(q(json!(1e300)), 1e300);
        assert_eq!(queued_turns(None), 0.0);
    }
}
