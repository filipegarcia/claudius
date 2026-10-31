//! The to-do helpers the session engine uses: `parseTaskListResult`
//! (`lib/shared/parse-tasklist-result.ts`), the TaskCreate result → real id
//! parse inside `captureSnapshotState`, `openTodoCount`, and the reminder
//! bodies (`lib/server/session.ts`). The regexes are hand-matched with JS
//! semantics (`\s` is JS whitespace, `.` stops at JS line terminators, `/i`
//! folds ASCII only), checked against the TS by `tests/todos_golden.rs`.

use claudius_agent::js;
use serde_json::{Value, json};

/// `STALE_TODO_TURN_THRESHOLD`: user turns without a TodoWrite before the
/// stale-TodoWrite nudge (only when a list exists).
pub const STALE_TODO_TURN_THRESHOLD: u32 = 15;

/// `TODOS_MIDTURN_TOOLUSE_THRESHOLD`: non-todo tool uses in one turn, with
/// an open list, before the mid-turn reminder.
pub const TODOS_MIDTURN_TOOLUSE_THRESHOLD: u32 = 12;

/// `TODOS_STALE_FLAG_TURNS`: turns ending with open items and no progress
/// (no more items done, list not shrunk) before the list is flagged stale.
pub const TODOS_STALE_FLAG_TURNS: u32 = 3;

/// `TODOS_STALE_CLEAR_TURNS`: such turns before it's cleared (`stale`).
pub const TODOS_STALE_CLEAR_TURNS: u32 = 6;

/// JS `\s`: `WhiteSpace` + `LineTerminator`, i.e. Unicode `White_Space`
/// minus U+0085, plus U+FEFF (the same set `trim` strips).
fn is_js_space(c: char) -> bool {
    (c.is_whitespace() && c != '\u{85}') || c == '\u{feff}'
}

/// What JS `.` (no `s` flag) refuses to match.
fn is_line_terminator(c: char) -> bool {
    matches!(c, '\n' | '\r' | '\u{2028}' | '\u{2029}')
}

/// `parseTaskListResult(text)`: one `{id, content, status}` per
/// `#<id> [<status>] <subject>` line. `None` input → `None`; blank → `[]`
/// (the SDK store is empty); non-blank with no matching line → `None` (an
/// unknown shape leaves the snapshot alone).
pub fn parse_task_list_result(text: Option<&str>) -> Option<Vec<Value>> {
    let trimmed = js::trim(text?);
    if trimmed.is_empty() {
        return Some(vec![]);
    }
    let parsed: Vec<Value> = trimmed
        .split('\n')
        .filter_map(|line| parse_task_line(js::trim(line)))
        .collect();
    (!parsed.is_empty()).then_some(parsed)
}

/// `TASK_LIST_LINE_RE = /^#(\S+)\s+\[([^\]]+)\]\s+(\S.*)$/`. Each
/// quantifier meets a disjoint class, so the greedy runs are the only way to
/// match and no backtracking is needed.
fn parse_task_line(line: &str) -> Option<Value> {
    let rest = line.strip_prefix('#')?;
    // `(\S+)\s+`: the id runs to the first space, and a space must follow.
    let (id, rest) = rest.split_at(rest.find(is_js_space)?);
    if id.is_empty() {
        return None;
    }
    // `\s+\[([^\]]+)\]`: the status runs to the first `]`.
    let rest = rest.trim_start_matches(is_js_space).strip_prefix('[')?;
    let (status, rest) = rest.split_at(rest.find(']')?);
    if status.is_empty() {
        return None;
    }
    // `\s+(\S.*)$`: at least one space, then a subject with no line
    // terminator (its first char is non-space by construction).
    let rest = &rest[1..];
    let subject = rest.trim_start_matches(is_js_space);
    if subject.len() == rest.len() || subject.is_empty() || subject.contains(is_line_terminator) {
        return None;
    }
    Some(json!({"id": id, "content": js::trim(subject), "status": js::trim(status)}))
}

/// The real id in a TaskCreate tool result: `/Task #(\S+)\s+created/i`
/// first (the in-process tool's plain-string shape), else a JSON
/// `{task: {id}}` with a non-empty string id.
pub fn task_create_real_id(result_text: &str) -> Option<String> {
    if let Some(id) = find_task_created(result_text) {
        return Some(id);
    }
    let payload: Value = serde_json::from_str(result_text).ok()?;
    payload
        .get("task")?
        .get("id")?
        .as_str()
        .filter(|id| !id.is_empty())
        .map(str::to_owned)
}

/// Leftmost `/Task #(\S+)\s+created/i`. Without the `u` flag `/i` folds
/// ASCII only (`ſ` doesn't match `s`), and the literal space after "Task"
/// is a single U+0020.
fn find_task_created(s: &str) -> Option<String> {
    let ascii_ci = |hay: &str, needle: &[u8]| {
        hay.len() >= needle.len() && hay.as_bytes()[..needle.len()].eq_ignore_ascii_case(needle)
    };
    for (start, _) in s.char_indices() {
        let rest = &s[start..];
        if !ascii_ci(rest, b"task #") {
            continue;
        }
        let after = &rest[6..];
        let end = after.find(is_js_space).unwrap_or(after.len());
        let (id, tail) = after.split_at(end);
        let created = tail.trim_start_matches(is_js_space);
        if !id.is_empty() && created.len() < tail.len() && ascii_ci(created, b"created") {
            return Some(id.to_owned());
        }
    }
    None
}

/// `Session.openTodoCount(snapshot)`: items whose `status` isn't
/// `"completed"`. A `null` item counts as open here; TS throws reading
/// `.status` off it.
pub fn open_todo_count(snapshot: Option<&[Value]>) -> usize {
    snapshot.map_or(0, |items| {
        items
            .iter()
            .filter(|t| t.get("status").and_then(Value::as_str) != Some("completed"))
            .count()
    })
}

fn with_todos(base: &str, todos: &[Value]) -> String {
    if todos.is_empty() {
        return base.to_owned();
    }
    format!(
        "{base}\n\nCurrent todos:\n{}",
        js::stringify_pretty(&Value::Array(todos.to_vec()))
    )
}

/// `todosCurrentReminderBody(todos)`: the next-turn `todos-current` body.
pub fn todos_current_reminder_body(todos: &[Value]) -> String {
    with_todos(
        "The current to-do list for this session is shown below. As you work, \
         keep it aligned with reality: mark items completed when finished \
         (TodoWrite with status \"completed\", or TaskUpdate with \
         status=\"completed\"), and prune items that are no longer relevant \
         (TaskUpdate with status=\"deleted\", or omit them from the next \
         TodoWrite call). Add new items as they emerge via TaskCreate or by \
         extending the next TodoWrite call. The list is visible to the user \
         in real time — keeping it accurate is part of the turn's work.",
        todos,
    )
}

/// `todosMidTurnReminderBody(todos)`: the mid-turn `todos-stale-midturn`
/// body, delivered through PreToolUse `additionalContext`.
pub fn todos_mid_turn_reminder_body(todos: &[Value]) -> String {
    with_todos(
        "You've taken several actions without updating the to-do list below. \
         If any tracked item is now finished, mark it completed (TodoWrite with \
         status \"completed\", or TaskUpdate with status=\"completed\"); if one is no \
         longer relevant, prune it (TaskUpdate with status=\"deleted\", or omit it \
         from the next TodoWrite). The list is visible to the user in real time \
         and is currently showing items as open — keep it honest as you work.",
        todos,
    )
}

/// `staleTodoReminderBody(todos)`: the `stale-todowrite` nudge.
pub fn stale_todo_reminder_body(todos: &[Value]) -> String {
    with_todos(
        "The TodoWrite tool hasn't been used recently. If you're working on \
         tasks that would benefit from tracking progress, consider using the \
         TodoWrite tool to track progress. Also consider cleaning up the todo \
         list if has become stale and no longer matches what you are working \
         on. Only use it if it's relevant to the current work. This is just a \
         gentle reminder - ignore if not applicable.",
        todos,
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_task_lines() {
        assert_eq!(
            parse_task_list_result(Some("#1 [completed] Ship it\n#2 [pending] Then this")),
            Some(vec![
                json!({"id": "1", "content": "Ship it", "status": "completed"}),
                json!({"id": "2", "content": "Then this", "status": "pending"}),
            ])
        );
        assert_eq!(parse_task_list_result(Some(" \n ")), Some(vec![]));
        assert_eq!(parse_task_list_result(Some("No tasks found")), None);
        assert_eq!(parse_task_list_result(None), None);
    }

    #[test]
    fn finds_the_created_id() {
        assert_eq!(
            task_create_real_id("Task #3 created successfully: x").as_deref(),
            Some("3")
        );
        assert_eq!(
            task_create_real_id(r#"{"task":{"id":"9"}}"#).as_deref(),
            Some("9")
        );
        assert_eq!(task_create_real_id("Task #3created"), None);
    }

    #[test]
    fn counts_open_items() {
        let items = [json!({"status": "completed"}), json!({}), Value::Null];
        assert_eq!(open_todo_count(Some(&items)), 2);
        assert_eq!(open_todo_count(None), 0);
    }
}
