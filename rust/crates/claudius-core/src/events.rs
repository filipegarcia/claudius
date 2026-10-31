//! Server-event helpers — the pure functions from `lib/server/session.ts`
//! and `lib/shared/events.ts` that shape what goes over SSE.
//!
//! Events stay as `serde_json::Value` objects end-to-end: the TS
//! `ServerEvent` union has ~40 members and the browser client consumes them
//! as raw JSON, so modelling them as Rust enums would only add a lossy layer.

use std::sync::LazyLock;

use claudius_agent::js;
use serde_json::{Map, Value, json};

use crate::user_prompt::is_anchorable_user_prompt;

pub type Event = Value;

pub fn ev_type(ev: &Event) -> &str {
    ev.get("type").and_then(Value::as_str).unwrap_or("")
}

fn sdk_type(ev: &Event) -> Option<&str> {
    ev.get("message")?.get("type")?.as_str()
}

/// `shouldBufferEvent` — what goes into the replay buffer.
pub fn should_buffer_event(ev: &Event) -> bool {
    match ev_type(ev) {
        "queue:updated" | "holder_changed" | "usage_snapshot" | "prompt_settled"
        | "effort_applied" => false,
        "sdk" => sdk_type(ev) != Some("command_lifecycle"),
        _ => true,
    }
}

/// Event types `subscribe()` skips during replay: they're re-sent from the
/// live pending maps instead (or are one-shot nudges).
pub const REPLAY_SKIP_TYPES: [&str; 13] = [
    "permission_request",
    "ask_user_question",
    "mcp_elicitation_request",
    "plan_approval_request",
    "feedback_survey",
    "opus_overload_nudge",
    "long_context_credits_required",
    "auth_failed_required",
    "mcp_needs_auth_notice",
    "mcp_disconnected_notice",
    "token_expiring_required",
    "session_recap",
    "session_recap_error",
];

fn at_of(ev: &Event) -> Option<f64> {
    ev.get("at")
        .and_then(Value::as_f64)
        .filter(|f| f.is_finite())
}

/// `computeReplayWindow` → `(start_idx, has_more_above)`.
pub fn compute_replay_window(buffer: &[Event], tail: Option<usize>) -> (usize, bool) {
    let Some(tail) = tail.filter(|t| *t > 0) else {
        return (0, false);
    };
    let mut turn_idx: Vec<usize> = Vec::new();
    let mut latest_user: Option<(f64, usize)> = None;
    for (i, ev) in buffer.iter().enumerate() {
        if ev_type(ev) != "sdk" {
            continue;
        }
        let Some(m) = ev.get("message") else { continue };
        let t = m.get("type").and_then(Value::as_str);
        if t != Some("assistant") && t != Some("user") {
            continue;
        }
        if m.get("parent_tool_use_id")
            .and_then(Value::as_str)
            .is_some_and(|s| !s.is_empty())
        {
            continue;
        }
        let is_user_prompt = t == Some("user")
            && is_anchorable_user_prompt(m.get("message").and_then(|x| x.get("content")));
        if t == Some("user") && !is_user_prompt {
            continue;
        }
        turn_idx.push(i);
        if is_user_prompt {
            let at = at_of(ev).unwrap_or(f64::NEG_INFINITY);
            if latest_user.is_none_or(|(la, li)| at > la || (at == la && i > li)) {
                latest_user = Some((at, i));
            }
        }
    }
    let skip = turn_idx.len().saturating_sub(tail);
    if skip == 0 {
        return (0, false);
    }
    let mut start = turn_idx[skip];
    if let Some((_, li)) = latest_user
        && li < start
    {
        start = li;
    }
    (start, start > 0)
}

/// `orderSdkEventsChronologically` — stable-sort only the `sdk` events by
/// `at`, leaving synthetic events in their slots.
pub fn order_sdk_events_chronologically(events: &[Event]) -> Vec<Event> {
    let positions: Vec<usize> = events
        .iter()
        .enumerate()
        .filter(|(_, e)| ev_type(e) == "sdk")
        .map(|(i, _)| i)
        .collect();
    if positions.len() <= 1 {
        return events.to_vec();
    }
    let mut sorted = positions.clone();
    let key = |i: usize| events[i].get("at").and_then(Value::as_f64).unwrap_or(0.0);
    sorted.sort_by(|&a, &b| {
        key(a)
            .partial_cmp(&key(b))
            .unwrap_or(std::cmp::Ordering::Equal)
            .then(a.cmp(&b))
    });
    if sorted == positions {
        return events.to_vec();
    }
    let mut out = events.to_vec();
    for (slot, src) in positions.iter().zip(sorted.iter()) {
        out[*slot] = events[*src].clone();
    }
    out
}

/// `selectReplayWindow` → `(events, start_idx, has_more_above)`.
pub fn select_replay_window(buffer: &[Event], tail: Option<usize>) -> (Vec<Event>, usize, bool) {
    let ordered = order_sdk_events_chronologically(buffer);
    let (start, more) = compute_replay_window(&ordered, tail);
    let events = if start == 0 {
        ordered
    } else {
        ordered[start..].to_vec()
    };
    (events, start, more)
}

// ─────────────────────────── AskUserQuestion ────────────────────────────

/// `parseAskQuestions` — returns the normalized `AskQuestion[]` JSON.
pub fn parse_ask_questions(input: &Value) -> Vec<Value> {
    let Some(raw) = input.get("questions").and_then(Value::as_array) else {
        return vec![];
    };
    let mut out = Vec::new();
    for q in raw {
        let Some(qo) = q.as_object() else { continue };
        let s = |k: &str| qo.get(k).and_then(Value::as_str).unwrap_or("").to_owned();
        let question = s("question");
        let header = s("header");
        let multi = qo.get("multiSelect") == Some(&Value::Bool(true));
        let mut options = Vec::new();
        for o in qo
            .get("options")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
        {
            let Some(oo) = o.as_object() else { continue };
            let label = oo.get("label").and_then(Value::as_str).unwrap_or("");
            let description = oo.get("description").and_then(Value::as_str).unwrap_or("");
            if label.is_empty() {
                continue;
            }
            let mut opt = Map::new();
            opt.insert("label".into(), json!(label));
            opt.insert("description".into(), json!(description));
            if let Some(p) = oo.get("preview").and_then(Value::as_str) {
                opt.insert("preview".into(), json!(p));
            }
            options.push(Value::Object(opt));
        }
        if !question.is_empty() && options.len() >= 2 {
            out.push(json!({"question": question, "header": header, "options": options, "multiSelect": multi}));
        }
    }
    out
}

fn answer_has_content(a: &Value) -> bool {
    if a.get("label")
        .and_then(Value::as_str)
        .is_some_and(|s| !s.is_empty())
    {
        return true;
    }
    if a.get("selected")
        .and_then(Value::as_array)
        .is_some_and(|v| !v.is_empty())
    {
        return true;
    }
    a.get("custom")
        .and_then(Value::as_str)
        .is_some_and(|s| !s.trim().is_empty())
}

/// Any answer carrying a label, a selection, or custom text.
pub fn ask_answers_have_content(answers: &[Value]) -> bool {
    !answers.is_empty() && answers.iter().any(answer_has_content)
}

/// `buildAskUpdatedInput`.
pub fn build_ask_updated_input(questions: &[Value], answers: &[Value]) -> Value {
    let empty = json!({});
    let mut answers_map = Map::new();
    let mut annotations = Map::new();
    for (i, q) in questions.iter().enumerate() {
        let a = answers.get(i).filter(|a| a.is_object()).unwrap_or(&empty);
        let custom = a
            .get("custom")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|s| !s.is_empty());
        let label = a.get("label").and_then(Value::as_str);
        let value = if q.get("multiSelect") == Some(&Value::Bool(true)) {
            let mut all: Vec<String> = a
                .get("selected")
                .and_then(Value::as_array)
                .map(|v| {
                    v.iter()
                        .map(|x| {
                            x.as_str()
                                .map(str::to_owned)
                                .unwrap_or_else(|| x.to_string())
                        })
                        .collect()
                })
                .unwrap_or_default();
            if let Some(c) = custom {
                all.push(c.to_owned());
            }
            all.join(", ")
        } else if let Some(c) = custom {
            c.to_owned()
        } else {
            label.filter(|l| !l.is_empty()).unwrap_or("").to_owned()
        };
        let qtext = q
            .get("question")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_owned();
        answers_map.insert(qtext.clone(), json!(value));
        let chosen = q.get("options").and_then(Value::as_array).and_then(|opts| {
            opts.iter()
                .find(|o| o.get("label").and_then(Value::as_str) == label && label.is_some())
        });
        if let Some(p) = chosen
            .and_then(|o| o.get("preview"))
            .and_then(Value::as_str)
            .filter(|p| !p.is_empty())
        {
            annotations.insert(qtext, json!({"preview": p}));
        }
    }
    let mut out = Map::new();
    out.insert("questions".into(), Value::Array(questions.to_vec()));
    out.insert("answers".into(), Value::Object(answers_map));
    if questions.len() == 1 {
        let a0 = answers.first().unwrap_or(&empty);
        if a0.get("label") == Some(&Value::Null)
            && let Some(c) = a0
                .get("custom")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|s| !s.is_empty())
        {
            out.insert("response".into(), json!(c));
        }
    }
    if !annotations.is_empty() {
        out.insert("annotations".into(), Value::Object(annotations));
    }
    Value::Object(out)
}

/// `allowRuleSuggestions` — the `addRules`/`allow` entries with rules.
pub fn allow_rule_suggestions(suggestions: Option<&Value>) -> Vec<Value> {
    suggestions
        .and_then(Value::as_array)
        .map(|arr| {
            arr.iter()
                .filter(|u| {
                    u.get("type").and_then(Value::as_str) == Some("addRules")
                        && u.get("behavior").and_then(Value::as_str) == Some("allow")
                        && u.get("rules")
                            .and_then(Value::as_array)
                            .is_some_and(|r| !r.is_empty())
                })
                .cloned()
                .collect()
        })
        .unwrap_or_default()
}

// ─────────────────────────── init / snapshot ────────────────────────────

fn string_array(v: Option<&Value>) -> Vec<Value> {
    v.and_then(Value::as_array)
        .map(|a| a.iter().filter(|x| x.is_string()).cloned().collect())
        .unwrap_or_default()
}

/// The `init` part of `session_snapshot`, from a `system/init` message.
pub fn init_snapshot(msg: &Value) -> Value {
    let mut m = Map::new();
    m.insert(
        "slashCommands".into(),
        Value::Array(string_array(msg.get("slash_commands"))),
    );
    m.insert(
        "agents".into(),
        Value::Array(string_array(msg.get("agents"))),
    );
    m.insert(
        "skills".into(),
        Value::Array(string_array(msg.get("skills"))),
    );
    if let Some(cwd) = msg
        .get("cwd")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
    {
        m.insert("cwd".into(), json!(cwd));
    }
    Value::Object(m)
}

/// `commandNamesFromChanged`.
pub fn command_names_from_changed(commands: Option<&Value>) -> Vec<Value> {
    commands
        .and_then(Value::as_array)
        .map(|a| {
            a.iter()
                .filter_map(|c| {
                    c.get("name")
                        .and_then(Value::as_str)
                        .filter(|s| !s.is_empty())
                        .map(|s| json!(s))
                })
                .collect()
        })
        .unwrap_or_default()
}

/// `buildSessionSnapshot`.
pub fn build_session_snapshot(
    todos: Option<(&Vec<Value>, bool)>,
    last_user_prompt: Option<&Value>,
    init: Option<&Value>,
) -> Option<Value> {
    if todos.is_none() && last_user_prompt.is_none() && init.is_none() {
        return None;
    }
    let mut m = Map::new();
    m.insert("type".into(), json!("session_snapshot"));
    if let Some((t, stale)) = todos {
        m.insert("todos".into(), Value::Array(t.clone()));
        m.insert("todosStale".into(), json!(stale));
    }
    if let Some(p) = last_user_prompt {
        m.insert("lastUserPrompt".into(), p.clone());
    }
    if let Some(i) = init {
        m.insert("init".into(), i.clone());
    }
    Some(Value::Object(m))
}

// ───────────────────────────────── tips ─────────────────────────────────

/// `DEFAULT_TIPS`, exported from `lib/shared/tips.ts`
/// (regenerate with `rust/scripts/gen-default-tips.sh`).
pub static DEFAULT_TIPS: LazyLock<Value> = LazyLock::new(|| {
    serde_json::from_str(include_str!("../data/default-tips.json")).expect("default-tips.json")
});

/// `selectTips` (server side; no `availableCommands` gate). `over` is the
/// cached override `crate::spinner_tips` builds; text, ids and the label are
/// trimmed like JS `trim()`.
pub fn select_tips(enabled: Option<bool>, over: Option<&Value>) -> Value {
    if enabled == Some(false) {
        return json!([]);
    }
    let Some(over) = over.filter(|o| o.is_object()) else {
        return DEFAULT_TIPS.clone();
    };
    let label = over
        .get("label")
        .and_then(Value::as_str)
        .map(js::trim)
        .filter(|s| !s.is_empty());
    let mut seen = std::collections::HashSet::new();
    let mut custom: Vec<(f64, Value)> = Vec::new();
    for (i, t) in over
        .get("tips")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .enumerate()
    {
        let text = js::trim(match t {
            Value::String(s) => s,
            Value::Object(o) => o.get("text").and_then(Value::as_str).unwrap_or(""),
            _ => "",
        });
        if text.is_empty() {
            continue;
        }
        let raw_id = t
            .get("id")
            .and_then(Value::as_str)
            .map(js::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_owned);
        let id = format!("custom:{}", raw_id.unwrap_or_else(|| i.to_string()));
        if !seen.insert(id.clone()) {
            continue;
        }
        let priority = t.get("priority").and_then(Value::as_f64);
        let cooldown = t.get("cooldownSessions").and_then(Value::as_f64);
        let mut m = Map::new();
        m.insert("id".into(), json!(id));
        m.insert("text".into(), json!(text));
        if let Some(l) = label {
            m.insert("label".into(), json!(l));
        }
        if let Some(p) = priority {
            m.insert("priority".into(), crate::js_num(p));
        }
        if let Some(c) = cooldown {
            m.insert("cooldownSessions".into(), crate::js_num(c));
        }
        custom.push((priority.unwrap_or(0.0), Value::Object(m)));
    }
    custom.sort_by(|a, b| b.0.partial_cmp(&a.0).unwrap_or(std::cmp::Ordering::Equal));
    let custom: Vec<Value> = custom.into_iter().map(|(_, v)| v).collect();
    if over.get("excludeDefault") == Some(&Value::Bool(true)) {
        return Value::Array(custom);
    }
    let mut all = DEFAULT_TIPS.as_array().cloned().unwrap_or_default();
    all.extend(custom);
    Value::Array(all)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sdk(t: &str, content: Value, at: i64) -> Value {
        json!({"type":"sdk","at":at,"message":{"type":t,"message":{"content":content}}})
    }

    #[test]
    fn replay_window_anchors_on_latest_prompt() {
        let buf = vec![
            sdk("user", json!("one"), 1),
            sdk("assistant", json!([{"type":"text","text":"a"}]), 2),
            json!({"type":"turn_status","status":"idle"}),
            sdk("user", json!("two"), 3),
            sdk("assistant", json!([]), 4),
            sdk("assistant", json!([]), 5),
        ];
        assert_eq!(compute_replay_window(&buf, None), (0, false));
        assert_eq!(compute_replay_window(&buf, Some(10)), (0, false));
        // tail=1 → last assistant, but anchored back to prompt "two".
        assert_eq!(compute_replay_window(&buf, Some(1)), (3, true));
    }

    #[test]
    fn chronological_reorder_keeps_synthetic_slots() {
        let buf = vec![
            sdk("assistant", json!([]), 5),
            json!({"type":"x"}),
            sdk("user", json!("u"), 1),
        ];
        let out = order_sdk_events_chronologically(&buf);
        assert_eq!(out[0]["at"], json!(1));
        assert_eq!(out[1]["type"], json!("x"));
        assert_eq!(out[2]["at"], json!(5));
    }

    #[test]
    fn ask_round_trip() {
        let qs = parse_ask_questions(&json!({"questions":[
            {"question":"Q?","header":"H","options":[{"label":"A","description":"a","preview":"<b>"},{"label":"B","description":"b"}],"multiSelect":false},
            {"question":"bad","options":[{"label":"only"}]}
        ]}));
        assert_eq!(qs.len(), 1);
        let out = build_ask_updated_input(&qs, &[json!({"label":"A"})]);
        assert_eq!(out["answers"]["Q?"], json!("A"));
        assert_eq!(out["annotations"]["Q?"]["preview"], json!("<b>"));
        let out = build_ask_updated_input(&qs, &[json!({"label":null,"custom":" mine "})]);
        assert_eq!(out["response"], json!("mine"));
        assert!(!ask_answers_have_content(&[json!({})]));
    }

    #[test]
    fn tips_default_and_override() {
        assert_eq!(select_tips(None, None), *DEFAULT_TIPS);
        assert_eq!(select_tips(Some(false), None), json!([]));
        let t = select_tips(
            None,
            Some(&json!({"excludeDefault":true,"tips":["x",{"id":"y","text":"Y","priority":2}]})),
        );
        assert_eq!(t[0]["id"], json!("custom:y"));
        assert_eq!(t[1]["id"], json!("custom:0"));
    }
}
