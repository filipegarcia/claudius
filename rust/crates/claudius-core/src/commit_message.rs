//! `lib/server/commit-message.ts`: the Git page's "Generate" button, one
//! tool-less, single-turn query that turns a unified diff into a commit
//! message (D08), behind `POST /api/workspaces/:id/git/commit-message`.
//!
//! The options are the TS ones: the workspace as `cwd`, the system prompt
//! (replacing Claude Code's), `tools: []`, `bypassPermissions`, one turn
//! and `verbatimPrompts` (a diff is full of `@path`-looking text). No
//! model, env or account: the CLI inherits the server's environment and
//! picks its default model, as the SDK's does. The first `result` decides:
//! a `success` is its `result`, JS-trimmed and unfenced; anything else is
//! `claude returned <subtype>`; a stream that ends without one is `no result
//! from claude`; a throw (the CLI failing) is its message.
//!
//! The diff is cut at [`MAX_DIFF_CHARS`] UTF-16 units. A cut through a
//! surrogate pair drops the unit JS would keep as a lone surrogate (a Rust
//! string can't hold one).

use std::path::PathBuf;

use claudius_agent::{Options, SystemPrompt, Tools, js, oneshot};
use serde_json::Value;

use crate::customization_description::strip_fences;
use crate::js_string;

/// `SYSTEM_PROMPT`, verbatim.
pub const SYSTEM_PROMPT: &str = "You write concise git commit messages from a unified diff.\n\nRules:\n- Output ONLY the commit message. No preamble, no quotes, no code fences.\n- Imperative mood (\"add X\", not \"added X\").\n- Subject line under 72 characters.\n- If the change spans multiple distinct concerns, add a short body separated from the subject by one blank line. Skip the body for trivial changes.\n- Focus on what changed and why, not a file-by-file rundown.";

/// `MAX_DIFF_CHARS`, in UTF-16 units.
pub const MAX_DIFF_CHARS: usize = 200_000;

/// `diff.slice(0, n)` in UTF-16 units, without a trailing half pair.
fn utf16_head(s: &str, n: usize) -> &str {
    let mut used = 0;
    for (i, c) in s.char_indices() {
        used += c.len_utf16();
        if used > n {
            return &s[..i];
        }
    }
    s
}

/// The user prompt: the diff (cut past [`MAX_DIFF_CHARS`]) in a `diff`
/// fence.
pub fn user_prompt(diff: &str) -> String {
    let trimmed = if js_string::len16(diff) > MAX_DIFF_CHARS {
        format!("{}\n\n[diff truncated]", utf16_head(diff, MAX_DIFF_CHARS))
    } else {
        diff.to_owned()
    };
    format!("Generate a commit message for this diff:\n\n```diff\n{trimmed}\n```")
}

/// `generateCommitMessage`'s result: `Ok` is `{ok: true, message}`, `Err`
/// `{ok: false, error}`.
pub type Generated = Result<String, String>;

/// What the first `result` message reads as.
fn outcome_of(msg: &Value) -> Generated {
    let subtype = msg.get("subtype");
    if subtype.map(|s| s == "success") != Some(true) {
        // `` `claude returned ${msg.subtype}` ``.
        let text = match subtype {
            Some(v) => js_string::to_js_string(v)
                .unwrap_or_else(|_| "Cannot convert object to primitive value".to_owned()),
            None => "undefined".to_owned(),
        };
        return Err(format!("claude returned {text}"));
    }
    // `stripFences(msg.result.trim())`, its TypeErrors caught.
    match msg.get("result") {
        Some(Value::String(s)) => Ok(strip_fences(js::trim(s))),
        Some(Value::Null) => Err("Cannot read properties of null (reading 'trim')".to_owned()),
        Some(_) => Err("msg.result.trim is not a function".to_owned()),
        None => Err("Cannot read properties of undefined (reading 'trim')".to_owned()),
    }
}

/// `generateCommitMessage(cwd, diff)`. `claude_bin` is the CLI the server
/// runs (TS lets the SDK find it).
pub async fn generate_commit_message(
    cwd: &str,
    diff: &str,
    claude_bin: Option<PathBuf>,
) -> Generated {
    if js::trim(diff).is_empty() {
        return Err("no changes to summarise".to_owned());
    }
    let options = Options {
        cwd: Some(PathBuf::from(cwd)),
        system_prompt: Some(SystemPrompt::Custom {
            prompt: SYSTEM_PROMPT.to_owned(),
            snapshot: None,
        }),
        tools: Some(Tools::List(vec![])),
        permission_mode: Some("bypassPermissions".to_owned()),
        max_turns: Some(1.0),
        verbatim_prompts: true,
        path_to_claude_code_executable: claude_bin,
        ..Default::default()
    };
    match oneshot(&user_prompt(diff), options).await {
        Ok(Some(msg)) => outcome_of(&msg),
        Ok(None) => Err("no result from claude".to_owned()),
        Err(e) => Err(e.to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn the_prompt_is_cut_in_utf16_units() {
        let at = |s: &str| user_prompt(s);
        assert_eq!(
            at("d"),
            "Generate a commit message for this diff:\n\n```diff\nd\n```"
        );
        let exact = "x".repeat(MAX_DIFF_CHARS);
        assert!(at(&exact).ends_with(&format!("{exact}\n```")));
        let over = format!("{exact}y");
        assert!(at(&over).ends_with(&format!("{exact}\n\n[diff truncated]\n```")));
        // A pair across the cut: its high half is dropped.
        let pair = format!("{}\u{1f600}z", "x".repeat(MAX_DIFF_CHARS - 1));
        assert!(at(&pair).ends_with(&format!(
            "{}\n\n[diff truncated]\n```",
            "x".repeat(MAX_DIFF_CHARS - 1)
        )));
    }

    #[test]
    fn result_messages() {
        let r = |v: Value| outcome_of(&v);
        assert_eq!(
            r(json!({"subtype": "success", "result": " ```\nfix x\n``` "})),
            Ok("fix x".to_owned())
        );
        assert_eq!(
            r(json!({"subtype": "error_max_turns"})),
            Err("claude returned error_max_turns".to_owned())
        );
        assert_eq!(
            r(json!({"subtype": {}})),
            Err("claude returned [object Object]".to_owned())
        );
        assert_eq!(r(json!({})), Err("claude returned undefined".to_owned()));
        assert_eq!(
            r(json!({"subtype": "success", "result": 5})),
            Err("msg.result.trim is not a function".to_owned())
        );
    }
}
