//! `lib/client/sdk-message-filters.ts`: the recognizers over SDK user
//! content the transcript paths use to drop CLI plumbing (slash-command
//! wrappers, the compact summary, caveats, image-resize notes, task
//! notifications) before it becomes a user bubble.

use std::sync::LazyLock;

use claudius_agent::js;
use claudius_core::user_prompt::COMPACT_SUMMARY_PREFIX;
use regex::Regex;
use serde_json::Value;

use crate::JsThrow;
use crate::text::{AsciiCi, as_str, js_pattern, prop, push_js, to_js_string, truthy};
use crate::types::{DisplayMessage, Role};

/// The `SLASH_COMMANDS` ids (lib/shared/slash-commands.ts) whose `handler`
/// is `"sdk"` or that set `forwardsArgsToSdk`: the commands whose typed
/// form lands in the JSONL as a user message. The golden test checks it
/// against the TS registry.
pub const SDK_SLASH_COMMANDS: &[&str] = &[
    "compact",
    "sandbox",
    "reload-skills",
    "init",
    "btw",
    "fast",
    "extra-usage",
    "insights",
    "team-onboarding",
    "heapdump",
    "batch",
    "claude-api",
    "debug",
    "fewer-permission-prompts",
    "loop",
    "simplify",
    "review",
    "security-review",
    "ultrareview",
    "autofix-pr",
];

/// `isSdkSlashUserMessage`'s match.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SlashUse {
    pub command: String,
    pub args: String,
}

static SLASH: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(&js_pattern(r"^/([^{WS}/]+)(?:[{WS}]+((?s:.)*))?$")).unwrap());

/// `isSdkSlashUserMessage`: content that is exactly an SDK-handled slash
/// command (`/compact focus`), as the command and its trimmed args.
pub fn is_sdk_slash_user_message(content: Option<&Value>) -> Result<Option<SlashUse>, JsThrow> {
    let text = match content {
        Some(Value::String(s)) => s.clone(),
        Some(Value::Array(items)) => {
            let mut acc = String::new();
            for c in items {
                let t = prop(Some(c), "text");
                if as_str(prop(Some(c), "type")) == Some("text") && truthy(t) {
                    push_js(&mut acc, &to_js_string(t.expect("truthy"))?);
                } else {
                    return Ok(None);
                }
            }
            acc
        }
        _ => return Ok(None),
    };
    let trimmed = js::trim(&text);
    if !trimmed.starts_with('/') {
        return Ok(None);
    }
    let Some(m) = SLASH.captures(trimmed) else {
        return Ok(None);
    };
    let name = &m[1];
    let sdk = claudius_core::slash_commands::find_slash_command(name)
        .is_some_and(|id| SDK_SLASH_COMMANDS.contains(&id));
    if !sdk {
        return Ok(None);
    }
    Ok(Some(SlashUse {
        command: format!("/{name}"),
        args: js::trim(m.get(2).map_or("", |a| a.as_str())).to_owned(),
    }))
}

/// `SyntheticCliWrapper`: the CLI's own user-role plumbing around a slash
/// command run, with the user's prose after it (`trailing`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CliWrapper {
    Command {
        command: String,
        args: String,
        trailing: String,
    },
    Stdout {
        text: String,
        trailing: String,
    },
    Stderr {
        text: String,
        trailing: String,
    },
}

impl CliWrapper {
    pub fn trailing(&self) -> &str {
        match self {
            Self::Command { trailing, .. }
            | Self::Stdout { trailing, .. }
            | Self::Stderr { trailing, .. } => trailing,
        }
    }
}

static CMD_NAME: LazyLock<AsciiCi> = LazyLock::new(|| {
    AsciiCi::new(&js_pattern(
        r"^<command-name>[{WS}]*(/[^{WS}<]+)[{WS}]*</command-name>",
    ))
});
static CMD_MESSAGE: LazyLock<AsciiCi> =
    LazyLock::new(|| AsciiCi::new(r"<command-message>(?s:.)*?</command-message>"));
static CMD_ARGS: LazyLock<AsciiCi> =
    LazyLock::new(|| AsciiCi::new(r"<command-args>((?s:.)*?)</command-args>"));
static STDOUT: LazyLock<AsciiCi> =
    LazyLock::new(|| AsciiCi::new(r"^<local-command-stdout>((?s:.)*?)</local-command-stdout>"));
static STDERR: LazyLock<AsciiCi> =
    LazyLock::new(|| AsciiCi::new(r"^<local-command-stderr>((?s:.)*?)</local-command-stderr>"));

/// `parseSyntheticCliWrapper`.
pub fn parse_synthetic_cli_wrapper(content: Option<&Value>) -> Option<CliWrapper> {
    let trimmed = content_as_trimmed_text(content);
    if trimmed.is_empty() {
        return None;
    }
    let t = trimmed.as_str();
    // Text after the tags is the user's prose, unless it opens with `<`.
    let user_trailing = |after: &str| {
        let a = js::trim(after);
        if a.starts_with('<') {
            String::new()
        } else {
            a.to_owned()
        }
    };
    if let Some(c) = CMD_NAME.captures(t) {
        let (_, mut end) = c[0].expect("whole match");
        let (cs, ce) = c[1].expect("group 1");
        if let Some(m) = CMD_MESSAGE.captures(t) {
            end = end.max(m[0].expect("whole match").1);
        }
        let args = CMD_ARGS.captures(t);
        if let Some(a) = &args {
            end = end.max(a[0].expect("whole match").1);
        }
        let args = args
            .and_then(|a| a[1])
            .map_or("", |(s, e)| js::trim(&t[s..e]));
        return Some(CliWrapper::Command {
            command: t[cs..ce].to_owned(),
            args: args.to_owned(),
            trailing: user_trailing(&t[end..]),
        });
    }
    if let Some(c) = STDOUT.captures(t) {
        let (s, e) = c[1].expect("group 1");
        return Some(CliWrapper::Stdout {
            text: js::trim(&t[s..e]).to_owned(),
            trailing: user_trailing(&t[c[0].expect("whole match").1..]),
        });
    }
    if let Some(c) = STDERR.captures(t) {
        let (s, e) = c[1].expect("group 1");
        return Some(CliWrapper::Stderr {
            text: js::trim(&t[s..e]).to_owned(),
            trailing: user_trailing(&t[c[0].expect("whole match").1..]),
        });
    }
    None
}

/// `contentAsTrimmedText`: string content, or the string `text` of every
/// `text` block, trimmed; `""` for anything else.
fn content_as_trimmed_text(content: Option<&Value>) -> String {
    match content {
        Some(Value::String(s)) => js::trim(s).to_owned(),
        Some(Value::Array(items)) => {
            let mut buf = String::new();
            for c in items {
                if as_str(prop(Some(c), "type")) == Some("text")
                    && let Some(t) = as_str(prop(Some(c), "text"))
                {
                    push_js(&mut buf, t);
                }
            }
            js::trim(&buf).to_owned()
        }
        _ => String::new(),
    }
}

/// `isCompactSummaryContent`: the SDK's post-compact "This session is being
/// continued…" summary.
pub fn is_compact_summary_content(content: Option<&Value>) -> bool {
    let t = content_as_trimmed_text(content);
    !t.is_empty() && t.starts_with(COMPACT_SUMMARY_PREFIX)
}

static CAVEAT: LazyLock<AsciiCi> =
    LazyLock::new(|| AsciiCi::new(&js_pattern(r"^<local-command-caveat[{WS}>]")));

/// `isLocalCommandCaveatContent`.
pub fn is_local_command_caveat_content(content: Option<&Value>) -> bool {
    let t = content_as_trimmed_text(content);
    !t.is_empty() && CAVEAT.is_match(&t)
}

static IMAGE_RESIZE_NOTE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(&js_pattern(
        r"^(?:\[Image: original [0-9]+x[0-9]+, displayed at [0-9]+x[0-9]+\. Multiply coordinates by [0-9.]+ to map to original image\.\][{WS}]*)+$",
    ))
    .unwrap()
});

/// `isImageResizeNoteContent`: only the CLI's "[Image: original WxH,
/// displayed at …]" notes, and no other block.
pub fn is_image_resize_note_content(content: Option<&Value>) -> bool {
    if let Some(Value::Array(items)) = content
        && items
            .iter()
            .any(|c| as_str(prop(Some(c), "type")) != Some("text"))
    {
        return false;
    }
    let t = content_as_trimmed_text(content);
    !t.is_empty() && IMAGE_RESIZE_NOTE.is_match(&t)
}

/// `isSdkInternalEnvelope`: a record flagged `isMeta`, `isCompactSummary`
/// or `isVisibleInTranscriptOnly` (`=== true`).
pub fn is_sdk_internal_envelope(msg: Option<&Value>) -> bool {
    ["isMeta", "isCompactSummary", "isVisibleInTranscriptOnly"]
        .iter()
        .any(|k| prop(msg, k) == Some(&Value::Bool(true)))
}

static TASK_NOTIFICATION: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(&js_pattern(r"^<task-notification[{WS}>]")).unwrap());

/// `isSyntheticTaskNotification`: the SDK's `<task-notification>` wrapper.
pub fn is_synthetic_task_notification(content: Option<&Value>) -> bool {
    let t = content_as_trimmed_text(content);
    !t.is_empty() && TASK_NOTIFICATION.is_match(&t)
}

/// `isRealUserDisplayMessage(m)`: a user bubble whose text blocks, joined,
/// are a real prompt by the server's rule (`isRealUserPrompt`, shared with
/// `claudius_core::user_prompt`). The transcript's last-prompt pin reads
/// it.
pub fn is_real_user_display_message(m: &DisplayMessage) -> bool {
    if m.role != Role::User {
        return false;
    }
    let mut text = String::new();
    for b in &m.blocks {
        if let Some(t) = b.as_text() {
            push_js(&mut text, t);
        }
    }
    claudius_core::user_prompt::is_real_user_prompt(Some(&Value::String(text)))
}

/// `SUPPRESSED_SYSTEM_SUBTYPES`: the SDK `system` subtypes that are
/// internal chatter, already shown by a dedicated pill or carrying nothing
/// worth a row.
pub const SUPPRESSED_SYSTEM_SUBTYPES: &[&str] = &[
    "stop_hook_summary",
    "hook_progress",
    "hook_callback",
    "mcp_status",
    "thinking_tokens",
];

/// `isSuppressedSystemEvent(subtype)`: an unrecognized `system` event that
/// is dropped instead of becoming the catch-all `system/<subtype>` pill: no
/// subtype (`null`, absent or `""`), or one of
/// [`SUPPRESSED_SYSTEM_SUBTYPES`]. Any other value, a non-string included,
/// gets the pill.
pub fn is_suppressed_system_event(subtype: Option<&Value>) -> bool {
    match subtype {
        None | Some(Value::Null) => true,
        Some(Value::String(s)) => s.is_empty() || SUPPRESSED_SYSTEM_SUBTYPES.contains(&s.as_str()),
        Some(_) => false,
    }
}
