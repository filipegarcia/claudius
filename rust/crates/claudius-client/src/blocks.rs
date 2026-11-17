//! The hook's readers of raw SDK content and tool output: `coerceTodos`,
//! `blocksFromSDKContent`, `extractUserContent`, `extractPeerOrigin`,
//! `extractToolResult`, `applyBashAutoBackground`, `pickPrimaryArg` and
//! `toolProgressInfoFromSdkMessage`.

use claudius_core::user_prompt::{split_leading_system_reminders, strip_goal_reminder};
use serde_json::Value;

use crate::text::{as_num, as_str, prop, push_js, strict_eq, to_js_string, truthy, wire_str};
use crate::{
    AgentTodo, AttachedImage, BackgroundBash, ClientEnv, DisplayBlock, JsRecord, JsThrow,
    SubagentRetry, ToolProgressInfo, record_set,
};

/// `coerceTodos`: a raw `todos` payload as the activity rail's rows, with
/// `t<i>` ids, `subject` for a missing `content`, and `pending` for a
/// missing status.
pub fn coerce_todos(raw: &[Value]) -> Vec<AgentTodo> {
    raw.iter()
        .enumerate()
        .map(|(i, t)| {
            let o = Some(t);
            let content = as_str(prop(o, "content"))
                .or_else(|| as_str(prop(o, "subject")))
                .unwrap_or("");
            AgentTodo {
                id: as_str(prop(o, "id")).map_or_else(|| format!("t{i}"), str::to_owned),
                content: content.to_owned(),
                status: as_str(prop(o, "status")).unwrap_or("pending").to_owned(),
                active_form: as_str(prop(o, "activeForm")).map(str::to_owned),
            }
        })
        .collect()
}

/// `for (const raw of content) raw.type …`: a `null` item throws.
fn item_type(raw: &Value) -> Result<Option<&str>, JsThrow> {
    if raw.is_null() {
        return Err(JsThrow::read_of_null("type"));
    }
    Ok(as_str(prop(Some(raw), "type")))
}

/// `blocksFromSDKContent`: SDK message content as display blocks. Text and
/// thinking need string bodies; `redacted_thinking` is an empty thinking
/// block; a `tool_use` keeps its fields as sent and is stamped `now`.
pub fn blocks_from_sdk_content(
    content: Option<&Value>,
    env: &mut dyn ClientEnv,
) -> Result<Vec<DisplayBlock>, JsThrow> {
    let items = match content {
        Some(Value::String(s)) => return Ok(vec![DisplayBlock::text(s.clone())]),
        Some(Value::Array(items)) => items,
        _ => return Ok(Vec::new()),
    };
    let mut out = Vec::new();
    for raw in items {
        let r = Some(raw);
        match item_type(raw)? {
            Some("text") => {
                if let Some(t) = as_str(prop(r, "text")) {
                    out.push(DisplayBlock::text(t));
                }
            }
            Some("thinking") => {
                if let Some(t) = as_str(prop(r, "thinking")) {
                    out.push(DisplayBlock::Thinking {
                        text: t.to_owned(),
                        redacted: None,
                    });
                }
            }
            Some("redacted_thinking") => out.push(DisplayBlock::Thinking {
                text: String::new(),
                redacted: Some(true),
            }),
            Some("tool_use") => out.push(DisplayBlock::ToolUse {
                id: wire_str(prop(r, "id")),
                name: wire_str(prop(r, "name")),
                input: match prop(r, "input") {
                    None | Some(Value::Null) => Value::Object(Default::default()),
                    Some(v) => v.clone(),
                },
                result: None,
                started_at: Some(env.now_ms()),
            }),
            _ => {}
        }
    }
    Ok(out)
}

/// `extractUserContent`'s result: the user's text with `[Image #n]` tokens
/// where the images were, the base64 images, and the bodies of the leading
/// `<system-reminder>` blocks (taken out of the text).
#[derive(Debug, Clone, PartialEq)]
pub struct UserContent {
    pub text: String,
    pub images: Vec<AttachedImage>,
    pub reminder_bodies: Vec<String>,
}

/// `extractUserContent`.
pub fn extract_user_content(content: Option<&Value>) -> UserContent {
    let split = |text: &str, images| {
        let (reminders, rest) = split_leading_system_reminders(&strip_goal_reminder(text));
        UserContent {
            text: rest,
            images,
            reminder_bodies: reminders,
        }
    };
    let items = match content {
        Some(Value::String(s)) => return split(s, Vec::new()),
        Some(Value::Array(items)) => items,
        _ => {
            return UserContent {
                text: String::new(),
                images: Vec::new(),
                reminder_bodies: Vec::new(),
            };
        }
    };
    let mut text = String::new();
    let mut images = Vec::new();
    for raw in items {
        if !raw.is_object() && !raw.is_array() {
            continue;
        }
        let r = Some(raw);
        match as_str(prop(r, "type")) {
            Some("text") => {
                if let Some(t) = as_str(prop(r, "text")) {
                    push_js(&mut text, t);
                }
            }
            Some("image") => {
                let src = prop(r, "source");
                if truthy(src)
                    && as_str(prop(src, "type")) == Some("base64")
                    && let (Some(data), Some(media_type)) =
                        (as_str(prop(src, "data")), as_str(prop(src, "media_type")))
                {
                    let ord = images.len() + 1;
                    text.push_str(&format!("[Image #{ord}]"));
                    images.push(AttachedImage {
                        id: format!("replay-{ord}"),
                        ordinal: ord as f64,
                        data: data.to_owned(),
                        media_type: media_type.to_owned(),
                    });
                }
            }
            _ => {}
        }
    }
    split(&text, images)
}

/// `extractPeerOrigin`'s result: a `kind: "peer"` origin's sender.
#[derive(Debug, Clone, PartialEq)]
pub struct PeerOrigin {
    pub from: String,
    pub name: Option<String>,
    pub body: Option<String>,
    pub pid: Option<f64>,
    pub msg_id: Option<String>,
}

impl PeerOrigin {
    /// `toDisplayPeer`: the `DisplayMessage.peer` shape (no body).
    pub fn to_display_peer(&self) -> crate::PeerInfo {
        crate::PeerInfo {
            from: self.from.clone(),
            name: self.name.clone(),
            pid: self.pid,
            msg_id: self.msg_id.clone(),
        }
    }
}

/// `extractPeerOrigin`: the sender of a message another Claude Code
/// session sent (`origin.kind === "peer"` with a non-empty `from`).
/// Empty strings read as absent, and `pid` must be a positive safe integer.
pub fn extract_peer_origin(msg: Option<&Value>) -> Option<PeerOrigin> {
    let origin = prop(msg, "origin");
    if !truthy(origin) || as_str(prop(origin, "kind")) != Some("peer") {
        return None;
    }
    let nonempty = |k: &str| {
        as_str(prop(origin, k))
            .filter(|s| !s.is_empty())
            .map(str::to_owned)
    };
    let from = nonempty("from")?;
    const MAX_SAFE: f64 = 9_007_199_254_740_991.0;
    let pid = as_num(prop(origin, "verifiedPeerPid"))
        .filter(|p| p.fract() == 0.0 && p.abs() <= MAX_SAFE && *p > 0.0);
    Some(PeerOrigin {
        from,
        name: nonempty("name"),
        body: nonempty("body"),
        pid,
        msg_id: nonempty("msg_id"),
    })
}

/// `extractToolResult`'s result: the first `tool_result` block.
#[derive(Debug, Clone, PartialEq)]
pub struct ToolResultInfo {
    pub tool_use_id: String,
    pub text: String,
    pub is_error: Option<bool>,
    /// `tool_use_result.staged === true`: an Edit/Write held for review.
    pub staged: bool,
    /// `tool_use_result.detachedToolCall === true`.
    pub detached: bool,
    /// An error result `tool_result_meta` tags `automode-unavailable`.
    pub not_run: bool,
}

/// `isAutoModeUnavailable`.
fn is_auto_mode_unavailable(meta: Option<&Value>, tool_use_id: Option<&Value>) -> bool {
    let Some(Value::Array(items)) = meta else {
        return false;
    };
    items.iter().any(|m| {
        m.is_object()
            && strict_eq(prop(Some(m), "id"), tool_use_id)
            && as_str(prop(Some(m), "non_execution_kind")) == Some("automode-unavailable")
    })
}

/// `extractToolResult`: the first `tool_result` block of a user message,
/// its text (a string, or the joined `text` of its parts), and the flags
/// the wrapper's `tool_use_result` / `tool_result_meta` carry.
pub fn extract_tool_result(
    content: Option<&Value>,
    tool_use_result: Option<&Value>,
    tool_result_meta: Option<&Value>,
) -> Result<Option<ToolResultInfo>, JsThrow> {
    let Some(Value::Array(items)) = content else {
        return Ok(None);
    };
    for raw in items {
        if item_type(raw)? != Some("tool_result") {
            continue;
        }
        let r = Some(raw);
        let text = match prop(r, "content") {
            Some(Value::String(s)) => s.clone(),
            Some(Value::Array(parts)) => {
                // `.map(c => c.text ?? "").join("")`
                let mut text = String::new();
                for c in parts {
                    if let Some(t) = prop(Some(c), "text")
                        && !t.is_null()
                    {
                        push_js(&mut text, &to_js_string(t)?);
                    }
                }
                text
            }
            _ => String::new(),
        };
        let tur = tool_use_result.filter(|v| v.is_object() || v.is_array());
        let tool_use_id = prop(r, "tool_use_id");
        let is_error = prop(r, "is_error");
        return Ok(Some(ToolResultInfo {
            tool_use_id: wire_str(tool_use_id),
            text,
            is_error: is_error.and_then(Value::as_bool),
            staged: prop(tur, "staged") == Some(&Value::Bool(true)),
            detached: prop(tur, "detachedToolCall") == Some(&Value::Bool(true)),
            not_run: is_error == Some(&Value::Bool(true))
                && is_auto_mode_unavailable(tool_result_meta, tool_use_id),
        }));
    }
    Ok(None)
}

/// `applyBashAutoBackground`: fold a Bash result's `tool_use_result`
/// (`backgroundTaskId`, `timedOutAfterMs`, `backgroundEndsWithFinalResponse`)
/// into the background shells. A shell already tracked keeps its command
/// and start; a foreground command the SDK backgrounded on its timeout gets
/// an entry. `false` (unchanged) when the result shows no background shell.
pub fn apply_bash_auto_background(
    shells: &mut JsRecord<BackgroundBash>,
    tool_use_id: &str,
    command: &str,
    tool_use_result: Option<&Value>,
    started_at: f64,
) -> bool {
    if !truthy(tool_use_result) {
        return false;
    }
    let task_id = prop(tool_use_result, "backgroundTaskId");
    let timed_out = prop(tool_use_result, "timedOutAfterMs");
    if !truthy(task_id) && as_num(timed_out).is_none() {
        return false;
    }
    let ends = prop(tool_use_result, "backgroundEndsWithFinalResponse");
    let existing = shells.get(tool_use_id);
    // `a ?? existing?.x`: the existing value only for `null` / `undefined`.
    let nullish = |v: Option<&Value>| v.is_none_or(Value::is_null);
    let entry = BackgroundBash {
        tool_use_id: tool_use_id.to_owned(),
        bash_id: if nullish(task_id) {
            existing.and_then(|e| e.bash_id.clone())
        } else {
            as_str(task_id).map(str::to_owned)
        },
        command: existing
            .map(|e| e.command.as_str())
            .filter(|c| !c.is_empty())
            .unwrap_or(command)
            .to_owned(),
        started_at: existing.map_or(started_at, |e| e.started_at),
        killed: existing.and_then(|e| e.killed),
        timed_out_after_ms: if nullish(timed_out) {
            existing.and_then(|e| e.timed_out_after_ms)
        } else {
            as_num(timed_out)
        },
        ends_with_agent_final_response: if nullish(ends) {
            existing.and_then(|e| e.ends_with_agent_final_response)
        } else {
            ends.and_then(Value::as_bool)
        },
    };
    record_set(shells, tool_use_id, entry);
    true
}

/// The keys `pickPrimaryArg` reads per tool, in order.
const PRIMARY_ARG_KEYS: &[(&str, &[&str])] = &[
    ("Bash", &["command"]),
    ("BashOutput", &["bash_id", "shell_id"]),
    ("KillBash", &["shell_id", "bash_id"]),
    ("Edit", &["file_path"]),
    ("MultiEdit", &["file_path"]),
    ("Write", &["file_path"]),
    ("Read", &["file_path"]),
    ("NotebookEdit", &["notebook_path"]),
    ("Glob", &["pattern"]),
    ("Grep", &["pattern"]),
    ("WebFetch", &["url"]),
    ("WebSearch", &["query"]),
    ("Task", &["description"]),
    ("TodoWrite", &[]),
    ("TaskCreate", &["subject"]),
    ("TaskUpdate", &["taskId"]),
    ("TaskGet", &["taskId"]),
    ("TaskList", &[]),
    ("ExitPlanMode", &[]),
    ("CronCreate", &["cron"]),
    ("CronDelete", &["id"]),
    ("ScheduleWakeup", &["reason"]),
    ("Schedule", &["action"]),
    ("RemoteTrigger", &["action"]),
];

/// The keys for a tool the table doesn't name.
const PRIMARY_ARG_FALLBACK: &[&str] = &[
    "file_path",
    "command",
    "pattern",
    "url",
    "query",
    "description",
    "path",
];

/// `Object.prototype`'s own keys: `perTool[name]` finds them on a plain
/// object literal, so a tool named one of them reads a function (or the
/// prototype), which isn't iterable.
pub(crate) const OBJECT_PROTOTYPE_KEYS: &[&str] = &[
    "__defineGetter__",
    "__defineSetter__",
    "__lookupGetter__",
    "__lookupSetter__",
    "__proto__",
    "constructor",
    "hasOwnProperty",
    "isPrototypeOf",
    "propertyIsEnumerable",
    "toLocaleString",
    "toString",
    "valueOf",
];

/// `pickPrimaryArg`: the one input value the activity rail shows under a
/// tool call (the first non-empty string of the tool's keys).
pub fn pick_primary_arg(name: &str, input: Option<&Value>) -> Result<Option<String>, JsThrow> {
    if !truthy(input) || !(input.is_some_and(|v| v.is_object() || v.is_array())) {
        return Ok(None);
    }
    let keys = match PRIMARY_ARG_KEYS.iter().find(|(n, _)| *n == name) {
        Some((_, keys)) => *keys,
        None if OBJECT_PROTOTYPE_KEYS.contains(&name) => {
            return Err(JsThrow::type_error("keys is not iterable"));
        }
        None => PRIMARY_ARG_FALLBACK,
    };
    Ok(keys
        .iter()
        .find_map(|k| as_str(prop(input, k)).filter(|v| !v.is_empty()))
        .map(str::to_owned))
}

/// `toolProgressInfoFromSdkMessage`: a `tool_progress` message as the
/// client's camelCase shape, with the subagent's retry state when the
/// frame carries one.
pub fn tool_progress_info_from_sdk_message(tp: &Value) -> Result<ToolProgressInfo, JsThrow> {
    if tp.is_null() {
        return Err(JsThrow::read_of_null("tool_use_id"));
    }
    let t = Some(tp);
    let retry = prop(t, "subagent_retry");
    Ok(ToolProgressInfo {
        tool_use_id: wire_str(prop(t, "tool_use_id")),
        tool_name: wire_str(prop(t, "tool_name")),
        elapsed_seconds: as_num(prop(t, "elapsed_time_seconds")),
        parent_tool_use_id: as_str(prop(t, "parent_tool_use_id")).map(str::to_owned),
        subagent_type: as_str(prop(t, "subagent_type")).map(str::to_owned),
        subagent_retry: truthy(retry).then(|| SubagentRetry {
            agent_id: wire_str(prop(retry, "agent_id")),
            attempt: as_num(prop(retry, "attempt")),
            max_retries: as_num(prop(retry, "max_retries")),
            retry_delay_ms: as_num(prop(retry, "retry_delay_ms")),
            error_status: as_num(prop(retry, "error_status")),
            error_category: wire_str(prop(retry, "error_category")),
        }),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::FixedEnv;
    use serde_json::json;

    /// The one deliberate difference from the TS (see the crate docs): an
    /// SDK field typed as a string but holding something else reads as
    /// `""`, a non-boolean `is_error` as absent.
    #[test]
    fn wire_fields_of_the_wrong_type() {
        let content = json!([{ "type": "tool_use", "id": 5, "name": null }]);
        let blocks = blocks_from_sdk_content(Some(&content), &mut FixedEnv::new(1.0)).unwrap();
        assert_eq!(
            blocks,
            [DisplayBlock::ToolUse {
                id: String::new(),
                name: String::new(),
                input: json!({}),
                result: None,
                started_at: Some(1.0),
            }]
        );
        let content = json!([{ "type": "tool_result", "content": "x", "is_error": "yes" }]);
        let r = extract_tool_result(Some(&content), None, None)
            .unwrap()
            .unwrap();
        assert_eq!((r.tool_use_id.as_str(), r.is_error), ("", None));
        let tp =
            tool_progress_info_from_sdk_message(&json!({ "elapsed_time_seconds": "3" })).unwrap();
        assert_eq!(tp.elapsed_seconds, None);
        assert_eq!(tp.parent_tool_use_id, None);
    }
}
