//! The permission card (`components/chat/PermissionPrompt.tsx`) as data:
//! what [`PermissionCard::new`] derives from the queued
//! `permission_request` (the text the card shows, the rule an "Always"
//! click saves, which buttons are offered), the card's own state
//! ([`PermissionForm`]) and the decision each control sends
//! ([`Decision`], `PermissionDecision` in `lib/shared/events.ts:1304`).
//!
//! The request is the event as the server sent it (`Prompt`'s JSON). A
//! string field that isn't a string reads as absent here; the TS would
//! throw on it (`text.replace is not a function`), and the server only
//! sends strings.

use claudius_agent::js;
use claudius_core::js_string;
use serde_json::{Map, Value, json};

use crate::unicode::{visualize_hidden_name_unicode, visualize_invisible_unicode};

fn str_field<'a>(v: &'a Value, key: &str) -> Option<&'a str> {
    v.get(key).and_then(Value::as_str)
}

fn truthy(v: Option<&Value>) -> bool {
    v.is_some_and(js::truthy)
}

/// The "MCP · name (source)" badge (PermissionPrompt.tsx:177).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct McpBadge {
    /// `MCP · {visualized name} ({source})`.
    pub text: String,
    /// `source === "sdk"`: the accent colors; any other source amber.
    pub sdk: bool,
}

/// The symlink row (PermissionPrompt.tsx:209).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SymlinkRow {
    /// The resolved target, visualized.
    pub target: String,
    pub outside_working_dirs: bool,
    /// `read` / `modify`, as sent.
    pub operation: String,
}

impl SymlinkRow {
    /// The row's text: `This will {operation} {target} (outside working
    /// directory) via a symlink`, or `Symlink target: {target}`.
    pub fn text(&self) -> String {
        if self.outside_working_dirs {
            format!(
                "This will {} {} (outside working directory) via a symlink",
                self.operation, self.target
            )
        } else {
            format!("Symlink target: {}", self.target)
        }
    }
}

/// What an "Always" click saves (PermissionPrompt.tsx:280, CC 2.1.235).
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum AlwaysRule {
    /// The SDK's narrow suggestions, as `Tool(ruleContent)` / `Tool`.
    Narrow(Vec<String>),
    /// No suggestion: the whole tool (its name).
    WholeTool(String),
}

impl AlwaysRule {
    /// The preview's text, as the card reads.
    pub fn text(&self) -> String {
        match self {
            AlwaysRule::Narrow(labels) => format!(
                "\u{201C}Always\u{201D} saves {} \u{2014} not the whole tool.",
                labels.join(", ")
            ),
            AlwaysRule::WholeTool(tool) => format!(
                "\u{201C}Always\u{201D} saves the whole {tool} tool \u{2014} every call it can make, not just this one."
            ),
        }
    }
}

/// The card's derived content (everything `PermissionPrompt` computes from
/// its props before rendering).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PermissionCard {
    pub request_id: String,
    pub tool_name: String,
    /// The title, or `Claude wants to use {displayName ?? toolName}`,
    /// visualized (CC 2.1.211).
    pub summary: String,
    pub description: Option<String>,
    /// `1 of {N}` when more than one request waits (CC 2.1.286).
    pub queue_label: Option<String>,
    /// Its tooltip: `{N - 1} more waiting after this one`.
    pub queue_title: Option<String>,
    /// `Subagent · {agentId}`.
    pub agent_badge: Option<String>,
    pub mcp_badge: Option<McpBadge>,
    /// The hook row (CC 2.1.301): `Some(None)` for a hook ask without a
    /// reason, `Some(Some(reason))` with one (visualized).
    pub hook: Option<Option<String>>,
    pub symlink: Option<SymlinkRow>,
    /// The tool input as `JSON.stringify(input, null, 2)`, visualized.
    pub input_text: String,
    /// Hidden characters across every untrusted text the card shows.
    pub hidden_char_count: usize,
    /// `defaultToNo` (SDK 0.3.268): opens on the decline panel.
    pub default_to_no: bool,
    /// `suppressAlwaysAllowRule`: no standing-grant buttons.
    pub hide_always_buttons: bool,
    /// The rule preview; `None` when the always buttons are hidden.
    pub always_rule: Option<AlwaysRule>,
    /// The auto-mode tip (CC 2.1.247) shows.
    pub auto_mode_tip: bool,
}

/// `Contains {n} hidden/bidi character(s), shown below as ‹U+…› — read the
/// command carefully.` (PermissionPrompt.tsx:250).
pub fn hidden_chars_text(n: usize) -> String {
    format!(
        "Contains {n} hidden/bidi character{}, shown below as \u{2039}U+\u{2026}\u{203A} \u{2014} read the command carefully.",
        if n == 1 { "" } else { "s" }
    )
}

impl PermissionCard {
    /// The card for `request` (the queue's head). `queue_total` is
    /// `pendingPermissionCount`; `auto_mode_available` is
    /// `!autoModeDisabled && permissionMode !== "auto"` (ChatSurface.tsx:3124),
    /// and the switch callback is always wired there.
    pub fn new(request: &Value, queue_total: Option<usize>, auto_mode_available: bool) -> Self {
        let tool_name = js::to_string(request.get("toolName"));
        // `request.title ?? \`Claude wants to use ${displayName ?? toolName}\``.
        let title = match str_field(request, "title") {
            Some(t) => t.to_owned(),
            None => {
                let name = match request.get("displayName") {
                    Some(v) if !v.is_null() => js::to_string(Some(v)),
                    _ => js::to_string(request.get("toolName")),
                };
                format!("Claude wants to use {name}")
            }
        };
        let (summary, summary_n) = visualize_invisible_unicode(&title);
        let description = str_field(request, "description")
            .filter(|d| !d.is_empty())
            .map(visualize_invisible_unicode);
        let hook_ask = request.get("hookAsk").filter(|h| js::truthy(h));
        let hook_reason = hook_ask
            .and_then(|h| str_field(h, "reason"))
            .filter(|r| !r.is_empty())
            .map(visualize_invisible_unicode);
        let symlink = request
            .get("symlink")
            .filter(|s| js::truthy(s))
            .and_then(|s| {
                let target = str_field(s, "target")?;
                Some((s, visualize_invisible_unicode(target)))
            });
        let mcp = request.get("mcpServer").filter(|m| js::truthy(m));
        let mcp_name = mcp
            .and_then(|m| str_field(m, "name"))
            .map(visualize_hidden_name_unicode);
        let input = request.get("input").cloned().unwrap_or(Value::Null);
        let (input_text, input_n) =
            visualize_invisible_unicode(&js_string::stringify_pretty(&input));
        let hidden_char_count = summary_n
            + description.as_ref().map_or(0, |d| d.1)
            + input_n
            + hook_reason.as_ref().map_or(0, |r| r.1)
            + symlink.as_ref().map_or(0, |(_, t)| t.1)
            + mcp_name.as_ref().map_or(0, |n| n.1);
        let default_to_no = truthy(request.get("defaultToNo"));
        let hide_always_buttons = truthy(request.get("suppressAlwaysAllowRule"));
        let hide_auto_mode_tip = hide_always_buttons || default_to_no;
        let labels: Vec<String> = request
            .get("suggestedRules")
            .and_then(Value::as_array)
            .map(|rules| {
                rules
                    .iter()
                    .map(|r| {
                        let tool = js::to_string(r.get("toolName"));
                        if truthy(r.get("ruleContent")) {
                            format!("{tool}({})", js::to_string(r.get("ruleContent")))
                        } else {
                            tool
                        }
                    })
                    .collect()
            })
            .unwrap_or_default();
        let always_rule = (!hide_always_buttons).then(|| {
            if labels.is_empty() {
                AlwaysRule::WholeTool(tool_name.clone())
            } else {
                AlwaysRule::Narrow(labels)
            }
        });
        let queue = queue_total.filter(|n| *n > 1);
        PermissionCard {
            request_id: js::to_string(request.get("requestId")),
            summary,
            description: description.map(|d| d.0),
            queue_label: queue.map(|n| format!("1 of {n}")),
            queue_title: queue.map(|n| format!("{} more waiting after this one", n - 1)),
            agent_badge: request
                .get("agentId")
                .filter(|a| js::truthy(a))
                .map(|a| format!("Subagent \u{00B7} {}", js::to_string(Some(a)))),
            mcp_badge: mcp.map(|m| McpBadge {
                text: format!(
                    "MCP \u{00B7} {} ({})",
                    mcp_name
                        .as_ref()
                        .map_or_else(|| js::to_string(m.get("name")), |n| n.0.clone()),
                    js::to_string(m.get("source"))
                ),
                sdk: m.get("source").and_then(Value::as_str) == Some("sdk"),
            }),
            hook: hook_ask.map(|_| hook_reason.map(|r| r.0)),
            symlink: symlink.map(|(s, t)| SymlinkRow {
                target: t.0,
                outside_working_dirs: truthy(s.get("outsideWorkingDirs")),
                operation: js::to_string(s.get("operation")),
            }),
            input_text,
            hidden_char_count,
            default_to_no,
            hide_always_buttons,
            always_rule,
            auto_mode_tip: tool_name == "Bash" && auto_mode_available && !hide_auto_mode_tip,
            tool_name,
        }
    }

    /// The hook row's text: `Asked by a hook` (`:` and the reason when the
    /// hook gave one).
    pub fn hook_text(&self) -> Option<String> {
        self.hook.as_ref().map(|r| match r {
            Some(reason) => format!("Asked by a hook: {reason}"),
            None => "Asked by a hook".to_owned(),
        })
    }

    /// The tool-input toggle's label: `Tool input — {toolName}`.
    pub fn input_toggle_label(&self) -> String {
        format!("Tool input \u{2014} {}", self.tool_name)
    }

    /// The buttons the footer offers, in order (the deny panel's two are
    /// [`PermissionForm::show_deny`]'s).
    pub fn buttons(&self, form: &PermissionForm) -> Vec<&'static str> {
        let mut out = vec!["Allow once"];
        if !self.hide_always_buttons {
            out.extend(["Always (session)", "Always (project)", "Always (user)"]);
        }
        out.push(if form.show_deny {
            "Cancel deny"
        } else {
            "Deny\u{2026}"
        });
        out
    }
}

/// The card's state (`useState`s at PermissionPrompt.tsx:43-45). Keyed per
/// request (ChatSurface mounts it with `key={requestId}`), so the next
/// queued prompt starts fresh.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PermissionForm {
    pub request_id: String,
    /// The decline panel is open; `defaultToNo` opens it.
    pub show_deny: bool,
    pub feedback: String,
    pub show_input: bool,
}

impl PermissionForm {
    pub fn new(card: &PermissionCard) -> Self {
        PermissionForm {
            request_id: card.request_id.clone(),
            show_deny: card.default_to_no,
            feedback: String::new(),
            show_input: false,
        }
    }

    /// "Deny…" / "Cancel deny".
    pub fn toggle_deny(&mut self) {
        self.show_deny = !self.show_deny;
    }

    /// The "Tool input" chevron.
    pub fn toggle_input(&mut self) {
        self.show_input = !self.show_input;
    }
}

/// `PermissionDecision` (events.ts:1304), and what each control sends.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Decision {
    /// "Allow once", and the auto-mode tip's allow.
    AllowOnce,
    /// "Always (session)".
    AllowAlwaysSession,
    /// "Always (project)" (`projectSettings`) / "Always (user)"
    /// (`userSettings`).
    AllowAlwaysSave(&'static str),
    /// Escape, "Deny without feedback" (`None`), "Deny with feedback"
    /// (`feedback || undefined`).
    Deny(Option<String>),
}

impl Decision {
    /// "Deny with feedback": the message, unless it's empty (`feedback ||
    /// undefined`; whitespace is sent as typed).
    pub fn deny_with(feedback: &str) -> Decision {
        Decision::Deny((!feedback.is_empty()).then(|| feedback.to_owned()))
    }

    /// The decision as `resolvePermission` posts it.
    pub fn to_json(&self) -> Value {
        match self {
            Decision::AllowOnce => json!({ "kind": "allow_once" }),
            Decision::AllowAlwaysSession => json!({ "kind": "allow_always_session" }),
            Decision::AllowAlwaysSave(dest) => {
                json!({ "kind": "allow_always_save", "destination": dest })
            }
            Decision::Deny(message) => {
                let mut m = Map::new();
                m.insert("kind".into(), json!("deny"));
                if let Some(msg) = message {
                    m.insert("message".into(), json!(msg));
                }
                Value::Object(m)
            }
        }
    }
}

/// What a click on the card asks for.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum PermissionAction {
    /// `onResolve(decision)`.
    Resolve(Decision),
    /// The auto-mode tip (PermissionPrompt.tsx:269): `setPermissionMode
    /// ("auto")`, then allow this request once.
    SwitchToAutoAndAllow,
}

/// The card's Escape (PermissionPrompt.tsx:113): denies, unless it's an
/// auto-repeat (a held Escape would deny every queued request) or came
/// within the arm window.
pub fn escape_denies(repeat: bool, event_ms: f64, armed_at: Option<f64>) -> bool {
    !repeat && !crate::arm::is_before_prompt_armed(event_ms, armed_at)
}

/// `defaultToNo` puts focus on "Deny without feedback" when the prompt
/// appears (PermissionPrompt.tsx:138), unless the user is typing in a
/// field (CC 2.1.299).
pub fn focuses_decline(card: &PermissionCard, typing_in_field: bool) -> bool {
    card.default_to_no && !typing_in_field
}

#[cfg(test)]
mod tests {
    use super::*;

    fn bash(extra: Value) -> Value {
        let mut r = json!({
            "type": "permission_request",
            "requestId": "r1",
            "toolName": "Bash",
            "toolUseId": "t1",
            "input": { "command": "git status" },
        });
        for (k, v) in extra.as_object().unwrap() {
            r[k] = v.clone();
        }
        r
    }

    #[test]
    fn the_summary_falls_back_to_the_display_name_then_the_tool() {
        assert_eq!(
            PermissionCard::new(&bash(json!({})), None, false).summary,
            "Claude wants to use Bash"
        );
        let c = PermissionCard::new(&bash(json!({ "displayName": "Shell" })), None, false);
        assert_eq!(c.summary, "Claude wants to use Shell");
        // `??`: an empty title is kept; a null display name falls through.
        let c = PermissionCard::new(
            &bash(json!({ "title": "", "displayName": null })),
            None,
            false,
        );
        assert_eq!(c.summary, "");
        let c = PermissionCard::new(&bash(json!({ "displayName": null })), None, false);
        assert_eq!(c.summary, "Claude wants to use Bash");
    }

    #[test]
    fn the_queue_count_shows_past_one() {
        let r = bash(json!({}));
        assert_eq!(PermissionCard::new(&r, None, false).queue_label, None);
        assert_eq!(PermissionCard::new(&r, Some(1), false).queue_label, None);
        let c = PermissionCard::new(&r, Some(3), false);
        assert_eq!(c.queue_label.as_deref(), Some("1 of 3"));
        assert_eq!(
            c.queue_title.as_deref(),
            Some("2 more waiting after this one")
        );
    }

    #[test]
    fn always_rule_labels_are_tool_and_rule_content() {
        let c = PermissionCard::new(
            &bash(json!({ "suggestedRules": [
                { "toolName": "Bash", "ruleContent": "git status:*" },
                { "toolName": "Read", "ruleContent": "" },
                { "toolName": "Edit" }
            ] })),
            None,
            false,
        );
        assert_eq!(
            c.always_rule,
            Some(AlwaysRule::Narrow(vec![
                "Bash(git status:*)".into(),
                "Read".into(),
                "Edit".into()
            ]))
        );
        assert_eq!(
            c.always_rule.unwrap().text(),
            "\u{201C}Always\u{201D} saves Bash(git status:*), Read, Edit \u{2014} not the whole tool."
        );
        let c = PermissionCard::new(&bash(json!({ "suggestedRules": [] })), None, false);
        assert_eq!(c.always_rule, Some(AlwaysRule::WholeTool("Bash".into())));
    }

    #[test]
    fn suppress_always_allow_rule_hides_the_grants_and_the_tip() {
        let c = PermissionCard::new(
            &bash(json!({ "suppressAlwaysAllowRule": true })),
            None,
            true,
        );
        assert!(c.hide_always_buttons);
        assert_eq!(c.always_rule, None);
        assert!(!c.auto_mode_tip);
        let form = PermissionForm::new(&c);
        assert_eq!(c.buttons(&form), ["Allow once", "Deny\u{2026}"]);
    }

    #[test]
    fn the_auto_mode_tip_is_bash_only_and_needs_auto_mode() {
        assert!(PermissionCard::new(&bash(json!({})), None, true).auto_mode_tip);
        assert!(!PermissionCard::new(&bash(json!({})), None, false).auto_mode_tip);
        assert!(
            !PermissionCard::new(&bash(json!({ "toolName": "Edit" })), None, true).auto_mode_tip
        );
        assert!(
            !PermissionCard::new(&bash(json!({ "defaultToNo": true })), None, true).auto_mode_tip
        );
    }

    #[test]
    fn default_to_no_opens_on_the_decline_panel() {
        let c = PermissionCard::new(&bash(json!({ "defaultToNo": true })), None, false);
        let mut form = PermissionForm::new(&c);
        assert!(form.show_deny);
        assert_eq!(*c.buttons(&form).last().unwrap(), "Cancel deny");
        form.toggle_deny();
        assert_eq!(*c.buttons(&form).last().unwrap(), "Deny\u{2026}");
        assert!(focuses_decline(&c, false));
        assert!(!focuses_decline(&c, true));
        let plain = PermissionCard::new(&bash(json!({})), None, false);
        assert!(!PermissionForm::new(&plain).show_deny);
        assert!(!focuses_decline(&plain, false));
    }

    #[test]
    fn hidden_chars_count_every_untrusted_text() {
        let c = PermissionCard::new(
            &bash(json!({
                "title": "t\u{200B}",
                "description": "d\u{202E}",
                "input": { "command": "rm\u{2066}" },
                "hookAsk": { "reason": "r\u{FEFF}" },
                "symlink": { "target": "/x\u{2060}", "outsideWorkingDirs": true, "operation": "modify" },
                "mcpServer": { "name": "srv\u{3164}", "source": "user" }
            })),
            None,
            false,
        );
        assert_eq!(c.hidden_char_count, 6);
        assert_eq!(c.summary, "t\u{2039}U+200B\u{203A}");
        assert_eq!(
            c.hook_text().unwrap(),
            "Asked by a hook: r\u{2039}U+FEFF\u{203A}"
        );
        assert_eq!(
            c.symlink.as_ref().unwrap().text(),
            "This will modify /x\u{2039}U+2060\u{203A} (outside working directory) via a symlink"
        );
        let badge = c.mcp_badge.unwrap();
        assert_eq!(badge.text, "MCP \u{00B7} srv\u{2039}U+3164\u{203A} (user)");
        assert!(!badge.sdk);
        assert!(c.input_text.contains("rm\u{2039}U+2066\u{203A}"));
        assert_eq!(
            hidden_chars_text(1),
            "Contains 1 hidden/bidi character, shown below as \u{2039}U+\u{2026}\u{203A} \u{2014} read the command carefully."
        );
        assert!(hidden_chars_text(6).starts_with("Contains 6 hidden/bidi characters,"));
    }

    #[test]
    fn a_hook_ask_without_a_reason_still_shows_its_row() {
        let c = PermissionCard::new(&bash(json!({ "hookAsk": {} })), None, false);
        assert_eq!(c.hook_text().as_deref(), Some("Asked by a hook"));
        let c = PermissionCard::new(&bash(json!({ "hookAsk": { "reason": "" } })), None, false);
        assert_eq!(c.hook_text().as_deref(), Some("Asked by a hook"));
        assert_eq!(
            PermissionCard::new(&bash(json!({})), None, false).hook,
            None
        );
    }

    #[test]
    fn badges_for_subagents_and_sdk_servers() {
        let c = PermissionCard::new(
            &bash(
                json!({ "agentId": "a-7", "mcpServer": { "name": "claudius", "source": "sdk" } }),
            ),
            None,
            false,
        );
        assert_eq!(c.agent_badge.as_deref(), Some("Subagent \u{00B7} a-7"));
        assert!(c.mcp_badge.unwrap().sdk);
        assert_eq!(
            PermissionCard::new(&bash(json!({ "agentId": "" })), None, false).agent_badge,
            None
        );
    }

    #[test]
    fn decisions_serialize_as_permission_decision() {
        let s = |d: Decision| js_string::stringify(&d.to_json());
        assert_eq!(s(Decision::AllowOnce), r#"{"kind":"allow_once"}"#);
        assert_eq!(
            s(Decision::AllowAlwaysSession),
            r#"{"kind":"allow_always_session"}"#
        );
        assert_eq!(
            s(Decision::AllowAlwaysSave("projectSettings")),
            r#"{"kind":"allow_always_save","destination":"projectSettings"}"#
        );
        assert_eq!(s(Decision::Deny(None)), r#"{"kind":"deny"}"#);
        assert_eq!(s(Decision::deny_with("")), r#"{"kind":"deny"}"#);
        assert_eq!(
            s(Decision::deny_with(" no ")),
            r#"{"kind":"deny","message":" no "}"#
        );
    }

    #[test]
    fn escape_denies_once_armed_and_not_on_repeat() {
        assert!(escape_denies(false, 1_000.0, Some(0.0)));
        assert!(!escape_denies(true, 1_000.0, Some(0.0)));
        assert!(!escape_denies(false, 100.0, Some(0.0)));
        assert!(!escape_denies(false, 100.0, None));
    }
}
