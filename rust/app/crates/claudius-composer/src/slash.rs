//! The slash command picker's pure half: `lib/shared/slash-commands.ts`
//! (the registry, `mergeSuggestions`, `slashTokenBeforeCaret`,
//! `descriptionWordPrefixScore`, `fuzzySlashMatchIndices`,
//! `isConfidentSlashMatch`), `SlashCommandPicker.tsx`'s private
//! `fuzzyScore` / `toRuns` / the filtered list, and the two slash patterns of
//! `PromptInput.tsx` (`slashAtStart`'s `/^\s*\/\S*$/` and
//! `insertSlashCommand`'s splice). Replayed against the TS by
//! `tests/composer_pickers_golden.rs`.
//!
//! No regex is compiled: each pattern is matched by hand with JS `\s`.
//! Scores and match indices follow the TS's units: `fuzzyScore` works in
//! UTF-16 code units (`indexOf`, `hay[h]`), `fuzzySlashMatchIndices` in code
//! points (`Array.from`).

use std::cmp::Ordering;

use claudius_agent::js::{trim, truthy};
use claudius_core::collate::locale_compare;
use serde_json::Value;

use crate::rules::is_js_space;

/// `SlashCategory`, in `CATEGORY_ORDER` (slash-commands.ts:51).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Category {
    Session,
    Permissions,
    Tools,
    Memory,
    Model,
    Ui,
    Cost,
    Skill,
    Info,
    Auth,
    Integrations,
    Platform,
    Experimental,
}

use Category::*;

impl Category {
    /// The TS id (`"session"`, ...).
    pub fn id(self) -> &'static str {
        match self {
            Session => "session",
            Permissions => "permissions",
            Tools => "tools",
            Memory => "memory",
            Model => "model",
            Ui => "ui",
            Cost => "cost",
            Skill => "skill",
            Info => "info",
            Auth => "auth",
            Integrations => "integrations",
            Platform => "platform",
            Experimental => "experimental",
        }
    }

    /// `CATEGORY_LABELS` (slash-commands.ts:67).
    pub fn label(self) -> &'static str {
        match self {
            Session => "Session",
            Permissions => "Permissions",
            Tools => "Tools",
            Memory => "Memory & context",
            Model => "Model",
            Ui => "Interface",
            Cost => "Cost & usage",
            Skill => "Skills",
            Info => "Info",
            Auth => "Auth",
            Integrations => "Integrations",
            Platform => "Platform",
            Experimental => "Experimental",
        }
    }

    /// The index in `CATEGORY_ORDER`.
    fn order(self) -> usize {
        self as usize
    }
}

/// `SlashHandler`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Handler {
    Native,
    Sdk,
    External,
}

use Handler::*;

impl Handler {
    pub fn id(self) -> &'static str {
        match self {
            Native => "native",
            Sdk => "sdk",
            External => "external",
        }
    }

    /// `HANDLER_BADGE`'s label (SlashCommandPicker.tsx:34).
    pub fn badge_label(self) -> &'static str {
        match self {
            Native => "app",
            Sdk => "sdk",
            External => "external",
        }
    }
}

/// A `SLASH_COMMANDS` row.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct SlashCommand {
    pub id: &'static str,
    pub name: &'static str,
    pub aliases: &'static [&'static str],
    pub description: &'static str,
    pub category: Category,
    pub handler: Handler,
    pub args_hint: Option<&'static str>,
    pub forwards_args_to_sdk: bool,
}

#[allow(clippy::too_many_arguments)]
const fn cmd(
    id: &'static str,
    name: &'static str,
    aliases: &'static [&'static str],
    description: &'static str,
    category: Category,
    handler: Handler,
    args_hint: Option<&'static str>,
    forwards_args_to_sdk: bool,
) -> SlashCommand {
    SlashCommand {
        id,
        name,
        aliases,
        description,
        category,
        handler,
        args_hint,
        forwards_args_to_sdk,
    }
}

/// `SLASH_COMMANDS` (slash-commands.ts:83), in registry order. The golden
/// replay checks every field against the TS.
pub const SLASH_COMMANDS: &[SlashCommand] = &[
    cmd(
        "clear",
        "clear",
        &["reset", "new"],
        "Start a fresh session (clears context).",
        Session,
        Native,
        None,
        false,
    ),
    cmd(
        "compact",
        "compact",
        &[],
        "Compact the conversation to free up context.",
        Session,
        Sdk,
        Some("[focus instructions]"),
        false,
    ),
    cmd(
        "resume",
        "resume",
        &["continue"],
        "Open the session picker / resume a session.",
        Session,
        Native,
        Some("[id]"),
        false,
    ),
    cmd(
        "fork",
        "fork",
        &["branch"],
        "Fork the current session at the latest message.",
        Session,
        Native,
        Some("[name]"),
        false,
    ),
    cmd(
        "rename",
        "rename",
        &[],
        "Rename the current session.",
        Session,
        Native,
        Some("[title]"),
        false,
    ),
    cmd(
        "export",
        "export",
        &[],
        "Download the current session as plain text.",
        Session,
        Native,
        Some("[filename]"),
        false,
    ),
    cmd(
        "rewind",
        "rewind",
        &["checkpoint", "undo"],
        "Rewind to a previous user message (use the \u{21ba} buttons).",
        Session,
        Native,
        None,
        false,
    ),
    cmd(
        "goal",
        "goal",
        &["objective"],
        "Set a goal for this session \u{2014} shown prominently and tracked until achieved. /goal clear removes it.",
        Session,
        Native,
        Some("[goal text | clear]"),
        false,
    ),
    cmd(
        "exit",
        "exit",
        &["quit"],
        "End the current session.",
        Session,
        Native,
        None,
        false,
    ),
    cmd(
        "permissions",
        "permissions",
        &["allowed-tools"],
        "Manage allow/ask/deny rules across scopes.",
        Permissions,
        Native,
        None,
        false,
    ),
    cmd(
        "sandbox",
        "sandbox",
        &[],
        "Toggle sandbox mode (OS-level filesystem/network isolation).",
        Permissions,
        Sdk,
        None,
        false,
    ),
    cmd(
        "agents",
        "agents",
        &[],
        "Manage subagent configurations.",
        Tools,
        Native,
        None,
        false,
    ),
    cmd(
        "hooks",
        "hooks",
        &[],
        "View hook configurations.",
        Tools,
        Native,
        None,
        false,
    ),
    cmd(
        "mcp",
        "mcp",
        &[],
        "Manage MCP servers and OAuth.",
        Tools,
        Native,
        None,
        false,
    ),
    cmd(
        "plugin",
        "plugin",
        &[],
        "Manage plugins.",
        Tools,
        Native,
        None,
        false,
    ),
    cmd(
        "reload-plugins",
        "reload-plugins",
        &[],
        "Reload plugins to apply changes.",
        Tools,
        Native,
        Some("[force]"),
        false,
    ),
    cmd(
        "reload-skills",
        "reload-skills",
        &[],
        "Pick up skills added or changed on disk during this session.",
        Tools,
        Sdk,
        None,
        false,
    ),
    cmd(
        "tasks",
        "tasks",
        &["bashes"],
        "List and manage background tasks.",
        Tools,
        Native,
        None,
        false,
    ),
    cmd(
        "skills",
        "skills",
        &[],
        "List available skills.",
        Tools,
        Native,
        None,
        false,
    ),
    cmd(
        "memory",
        "memory",
        &[],
        "Edit CLAUDE.md, browse memory, toggle auto-memory.",
        Memory,
        Native,
        None,
        false,
    ),
    cmd(
        "context",
        "context",
        &[],
        "Visualize context window usage.",
        Memory,
        Native,
        None,
        false,
    ),
    cmd(
        "skill-doctor",
        "skill-doctor",
        &[],
        "Show per-skill context cost, so you can prune what's not worth it.",
        Memory,
        Native,
        None,
        false,
    ),
    cmd(
        "init",
        "init",
        &[],
        "Initialize a CLAUDE.md for this project.",
        Memory,
        Sdk,
        None,
        false,
    ),
    cmd(
        "recap",
        "recap",
        &[],
        "Generate a one-line session summary.",
        Memory,
        Native,
        None,
        false,
    ),
    cmd(
        "btw",
        "btw",
        &[],
        "Side question \u{2014} ephemeral, no tools, no history.",
        Memory,
        Sdk,
        Some("<question>"),
        false,
    ),
    cmd(
        "model",
        "model",
        &[],
        "Switch model (e.g. claude-opus-4-7 / claude-sonnet-4-6), or open the picker with no args.",
        Model,
        Native,
        Some("[model-id]"),
        false,
    ),
    cmd(
        "effort",
        "effort",
        &[],
        "Set effort level, or toggle ultracode; open the picker with no args.",
        Model,
        Native,
        Some("[level] | ultracode on|off"),
        false,
    ),
    cmd(
        "fast",
        "fast",
        &[],
        "Toggle fast mode, or open the picker with no args.",
        Model,
        Native,
        Some("[on|off]"),
        true,
    ),
    cmd(
        "advisor",
        "advisor",
        &[],
        "Set the Advisor model (opus/sonnet/fable/off), or open the picker with no args.",
        Model,
        Native,
        Some("[model|off]"),
        false,
    ),
    cmd(
        "settings",
        "settings",
        &["config"],
        "Open the settings editor.",
        Ui,
        Native,
        None,
        false,
    ),
    cmd(
        "theme",
        "theme",
        &[],
        "Pick a color theme.",
        Ui,
        Native,
        None,
        false,
    ),
    cmd(
        "statusline",
        "statusline",
        &[],
        "Configure the status line.",
        Ui,
        Native,
        None,
        false,
    ),
    cmd(
        "keybindings",
        "keybindings",
        &[],
        "Edit keybindings.",
        Ui,
        Native,
        None,
        false,
    ),
    cmd(
        "color",
        "color",
        &[],
        "Set prompt accent color.",
        Ui,
        Native,
        Some("[color|default]"),
        false,
    ),
    cmd(
        "diff",
        "diff",
        &[],
        "Show uncommitted changes as an overlay.",
        Ui,
        Native,
        None,
        false,
    ),
    cmd(
        "focus",
        "focus",
        &[],
        "Cycle focus mode (off \u{2192} focus \u{2192} zen).",
        Ui,
        Native,
        Some("[off|focus|zen]"),
        false,
    ),
    cmd(
        "output-style",
        "output-style",
        &[],
        "List or switch the response output style.",
        Ui,
        Native,
        Some("[name]"),
        false,
    ),
    cmd(
        "zen",
        "zen",
        &[],
        "Toggle Zen mode \u{2014} hide everything but the chat.",
        Ui,
        Native,
        None,
        false,
    ),
    cmd(
        "tui",
        "tui",
        &[],
        "Switch UI renderer.",
        Ui,
        External,
        None,
        false,
    ),
    cmd(
        "cost",
        "cost",
        &[],
        "Show session cost & usage as an overlay.",
        Cost,
        Native,
        None,
        false,
    ),
    cmd(
        "usage",
        "usage",
        &["stats"],
        "Open the Usage & account page.",
        Cost,
        Native,
        None,
        false,
    ),
    cmd(
        "extra-usage",
        "extra-usage",
        &[],
        "Configure extra usage for rate-limit recovery.",
        Cost,
        Sdk,
        None,
        false,
    ),
    cmd(
        "rate-limit-options",
        "rate-limit-options",
        &[],
        "Show options for handling a usage limit (Usage page).",
        Cost,
        Native,
        None,
        false,
    ),
    cmd(
        "login",
        "login",
        &[],
        "Sign in to Anthropic.",
        Auth,
        Native,
        None,
        false,
    ),
    cmd(
        "logout",
        "logout",
        &[],
        "Sign out (helper).",
        Auth,
        Native,
        None,
        false,
    ),
    cmd(
        "setup-bedrock",
        "setup-bedrock",
        &[],
        "Configure Amazon Bedrock.",
        Auth,
        Native,
        None,
        false,
    ),
    cmd(
        "setup-vertex",
        "setup-vertex",
        &[],
        "Configure Google Vertex AI.",
        Auth,
        Native,
        None,
        false,
    ),
    cmd(
        "ide",
        "ide",
        &[],
        "Claudius is the IDE \u{2014} opens the Files browser.",
        Integrations,
        Native,
        None,
        false,
    ),
    cmd(
        "install-github-app",
        "install-github-app",
        &[],
        "Install Claude GitHub Actions.",
        Integrations,
        Native,
        None,
        false,
    ),
    cmd(
        "install-slack-app",
        "install-slack-app",
        &[],
        "Install Claude Slack app.",
        Integrations,
        Native,
        None,
        false,
    ),
    cmd(
        "chrome",
        "chrome",
        &[],
        "Configure Chrome integration (no-op \u{2014} Claudius runs in Chromium).",
        Integrations,
        Native,
        None,
        false,
    ),
    cmd(
        "web-setup",
        "web-setup",
        &[],
        "Connect GitHub for web sessions on claude.ai.",
        Integrations,
        Native,
        None,
        false,
    ),
    cmd(
        "desktop",
        "desktop",
        &["app"],
        "Open or recommend the Claudius desktop app.",
        Platform,
        Native,
        None,
        false,
    ),
    cmd(
        "mobile",
        "mobile",
        &["ios", "android"],
        "Open the Claude mobile app page.",
        Platform,
        Native,
        None,
        false,
    ),
    cmd(
        "passes",
        "passes",
        &[],
        "Share free week with friends (CLI only).",
        Platform,
        Native,
        None,
        false,
    ),
    cmd(
        "stickers",
        "stickers",
        &[],
        "Order Claude Code stickers.",
        Platform,
        Native,
        None,
        false,
    ),
    cmd(
        "teleport",
        "teleport",
        &["tp"],
        "Pull a web session into the terminal (CLI only).",
        Platform,
        Native,
        None,
        false,
    ),
    cmd(
        "remote-control",
        "remote-control",
        &["rc"],
        "Enable remote control from claude.ai (CLI only).",
        Platform,
        Native,
        None,
        false,
    ),
    cmd(
        "remote-env",
        "remote-env",
        &[],
        "Configure default remote environment on claude.ai.",
        Platform,
        Native,
        None,
        false,
    ),
    cmd(
        "upgrade",
        "upgrade",
        &[],
        "Open the Claude plan upgrade page.",
        Platform,
        Native,
        None,
        false,
    ),
    cmd(
        "voice",
        "voice",
        &[],
        "Voice dictation mode.",
        Platform,
        External,
        None,
        false,
    ),
    cmd(
        "help",
        "help",
        &[],
        "Show all slash commands and shortcuts.",
        Info,
        Native,
        None,
        false,
    ),
    cmd(
        "status",
        "status",
        &[],
        "Show session/account/connectivity status.",
        Info,
        Native,
        None,
        false,
    ),
    cmd(
        "release-notes",
        "release-notes",
        &[],
        "Open the changelog.",
        Info,
        Native,
        None,
        false,
    ),
    cmd(
        "feedback",
        "feedback",
        &["bug"],
        "Submit feedback via GitHub Issues.",
        Info,
        Native,
        None,
        false,
    ),
    cmd(
        "insights",
        "insights",
        &[],
        "Generate report on session patterns.",
        Info,
        Sdk,
        None,
        false,
    ),
    cmd(
        "team-onboarding",
        "team-onboarding",
        &[],
        "Generate team onboarding guide.",
        Info,
        Sdk,
        None,
        false,
    ),
    cmd(
        "heapdump",
        "heapdump",
        &[],
        "Write a heap snapshot + diagnostics report (agent subprocess).",
        Info,
        Sdk,
        None,
        false,
    ),
    cmd(
        "doctor",
        "doctor",
        &["checkup"],
        "Full setup checkup \u{2014} diagnose and fix installation/auth/git/permissions issues.",
        Info,
        Native,
        Some("[prompt-audit]"),
        false,
    ),
    cmd(
        "powerup",
        "powerup",
        &[],
        "Open the Release notes (Claudius's feature-tour surface).",
        Info,
        Native,
        None,
        false,
    ),
    cmd(
        "add-dir",
        "add-dir",
        &[],
        "Add a working directory to this session.",
        Info,
        Native,
        Some("<path>"),
        false,
    ),
    cmd(
        "worktrees",
        "worktrees",
        &["worktree"],
        "Open a chat session in a git worktree.",
        Session,
        Native,
        None,
        false,
    ),
    cmd(
        "files",
        "files",
        &[],
        "Browse files in the active workspace.",
        Session,
        Native,
        None,
        false,
    ),
    cmd(
        "batch",
        "batch",
        &[],
        "Large-scale changes across the codebase.",
        Skill,
        Sdk,
        Some("<instruction>"),
        false,
    ),
    cmd(
        "claude-api",
        "claude-api",
        &[],
        "Claude API reference / migration helper.",
        Skill,
        Sdk,
        None,
        false,
    ),
    cmd(
        "debug",
        "debug",
        &[],
        "Enable debug logging and troubleshoot.",
        Skill,
        Sdk,
        None,
        false,
    ),
    cmd(
        "fewer-permission-prompts",
        "fewer-permission-prompts",
        &[],
        "Allowlist common read-only tools.",
        Skill,
        Sdk,
        None,
        false,
    ),
    cmd(
        "loop",
        "loop",
        &[],
        "Run a prompt or slash command on an interval, or self-paced.",
        Skill,
        Sdk,
        Some("[interval] [prompt]"),
        false,
    ),
    cmd(
        "schedule",
        "schedule",
        &["routines"],
        "Manage scheduled routines.",
        Skill,
        Native,
        None,
        false,
    ),
    cmd(
        "simplify",
        "simplify",
        &[],
        "Review files, find issues, apply fixes.",
        Skill,
        Sdk,
        Some("[focus]"),
        false,
    ),
    cmd(
        "review",
        "review",
        &["code-review"],
        "Review the current branch or a PR (alias of /code-review).",
        Skill,
        Sdk,
        Some("[level] [PR] | ultra"),
        false,
    ),
    cmd(
        "security-review",
        "security-review",
        &[],
        "Security review of pending changes.",
        Skill,
        Sdk,
        None,
        false,
    ),
    cmd(
        "ultrareview",
        "ultrareview",
        &[],
        "Deep multi-agent code review.",
        Skill,
        Sdk,
        Some("[PR]"),
        false,
    ),
    cmd(
        "autofix-pr",
        "autofix-pr",
        &[],
        "Watch PR and auto-fix CI failures.",
        Skill,
        Sdk,
        Some("[prompt]"),
        false,
    ),
    cmd(
        "plan",
        "plan",
        &[],
        "Enter plan mode (read-only planning).",
        Experimental,
        Native,
        Some("[description]"),
        false,
    ),
    cmd(
        "copy",
        "copy",
        &[],
        "Copy the last response to clipboard.",
        Ui,
        Native,
        Some("[N]"),
        false,
    ),
];

/// `SlashSuggestion["source"]` (`"mcp"` is declared but never produced).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Source {
    Registry,
    Sdk,
    Skill,
}

impl Source {
    pub fn id(self) -> &'static str {
        match self {
            Source::Registry => "registry",
            Source::Sdk => "sdk",
            Source::Skill => "skill",
        }
    }
}

/// A picker row (`SlashSuggestion`).
#[derive(Clone, Debug, PartialEq)]
pub struct SlashSuggestion {
    pub id: String,
    pub name: String,
    pub aliases: Vec<String>,
    pub description: String,
    pub category: Category,
    pub handler: Handler,
    pub args_hint: Option<String>,
    pub forwards_args_to_sdk: bool,
    pub source: Source,
    /// SDK 0.3.277 `builtin`: set on SDK rows only.
    pub builtin: bool,
}

/// One `supportedCommands()` row (`SdkSlashCommandInfo`), as
/// `GET /api/sessions/<id>/commands` answers it.
///
/// A field of the wrong type reads as absent (the TS's `.trim()` /
/// `.map()` on it would throw in render instead).
#[derive(Clone, Debug, Default, PartialEq)]
pub struct SdkCommand {
    pub name: String,
    pub description: Option<String>,
    pub argument_hint: Option<String>,
    /// `aliases`, its string items.
    pub aliases: Option<Vec<String>>,
    /// `builtin`, as sent (`mergeSuggestions` reads its truthiness).
    pub builtin: Value,
}

/// `useSdkCommands`' `d && Array.isArray(d.commands) ? d.commands : undefined`,
/// keeping the rows `mergeSuggestions` keeps (`rc && typeof rc.name ===
/// "string"`).
pub fn sdk_commands_of(body: Option<&Value>) -> Option<Vec<SdkCommand>> {
    let list = body?.get("commands")?.as_array()?;
    Some(
        list.iter()
            .filter_map(|rc| {
                let name = rc.get("name")?.as_str()?.to_owned();
                let text = |k: &str| rc.get(k).and_then(Value::as_str).map(str::to_owned);
                Some(SdkCommand {
                    name,
                    description: text("description"),
                    argument_hint: text("argumentHint"),
                    aliases: rc.get("aliases").and_then(Value::as_array).map(|a| {
                        a.iter()
                            .filter_map(Value::as_str)
                            .map(str::to_owned)
                            .collect()
                    }),
                    builtin: rc.get("builtin").cloned().unwrap_or(Value::Null),
                })
            })
            .collect(),
    )
}

/// `mergeSuggestions(sdkSlashCommands, sdkSkills, richCommands)`
/// (slash-commands.ts:445): the registry, then every SDK name it doesn't
/// claim (the init list's, then the rich list's), sorted by category
/// order, then `localeCompare` of the names (stable).
pub fn merge_suggestions(
    sdk_slash_commands: &[String],
    sdk_skills: &[String],
    rich: Option<&[SdkCommand]>,
) -> Vec<SlashSuggestion> {
    let mut out: Vec<SlashSuggestion> = Vec::new();
    let mut claimed: Vec<&str> = Vec::new();
    for c in SLASH_COMMANDS {
        out.push(SlashSuggestion {
            id: c.id.into(),
            name: c.name.into(),
            aliases: c.aliases.iter().map(|a| (*a).to_owned()).collect(),
            description: c.description.into(),
            category: c.category,
            handler: c.handler,
            args_hint: c.args_hint.map(str::to_owned),
            forwards_args_to_sdk: c.forwards_args_to_sdk,
            source: Source::Registry,
            builtin: false,
        });
        claimed.push(c.name);
        claimed.extend(c.aliases.iter().copied());
    }
    // `richByName`: the last row of a name wins, at its first name's place.
    let mut rich_by_name: Vec<(&str, &SdkCommand)> = Vec::new();
    for rc in rich.unwrap_or(&[]) {
        match rich_by_name.iter_mut().find(|(n, _)| *n == rc.name) {
            Some(slot) => slot.1 = rc,
            None => rich_by_name.push((&rc.name, rc)),
        }
    }
    let mut names: Vec<&str> = Vec::new();
    for n in sdk_slash_commands
        .iter()
        .map(String::as_str)
        .chain(rich_by_name.iter().map(|(n, _)| *n))
    {
        if !names.contains(&n) {
            names.push(n);
        }
    }
    let mut owned_claims: Vec<String> = Vec::new();
    for name in names {
        if claimed.contains(&name) || owned_claims.iter().any(|c| c == name) {
            continue;
        }
        owned_claims.push(name.to_owned());
        let rc = rich_by_name
            .iter()
            .find(|(n, _)| *n == name)
            .map(|(_, r)| *r);
        let is_skill = sdk_skills.iter().any(|s| s == name);
        let description = rc
            .and_then(|r| r.description.as_deref())
            .map(trim)
            .filter(|d| !d.is_empty())
            .map(str::to_owned)
            .unwrap_or_else(|| {
                if is_skill {
                    "Skill provided by the SDK.".into()
                } else {
                    "Provided by the SDK.".into()
                }
            });
        let args_hint = rc
            .and_then(|r| r.argument_hint.as_deref())
            .map(trim)
            .filter(|h| !h.is_empty())
            .map(str::to_owned);
        let aliases = rc
            .and_then(|r| r.aliases.clone())
            .filter(|a| !a.is_empty())
            .unwrap_or_default();
        out.push(SlashSuggestion {
            id: format!("sdk:{name}"),
            name: name.to_owned(),
            aliases,
            description,
            category: if is_skill { Skill } else { Experimental },
            handler: Sdk,
            args_hint,
            forwards_args_to_sdk: false,
            source: if is_skill { Source::Skill } else { Source::Sdk },
            builtin: rc.is_some_and(|r| truthy(&r.builtin)),
        });
    }
    out.sort_by(|a, b| match a.category.order().cmp(&b.category.order()) {
        Ordering::Equal => locale_compare(&a.name, &b.name),
        o => o,
    });
    out
}

/// The run of non-whitespace that ends `before` (what a `(^|\s)X…$`
/// pattern can match: it starts at the input's start or after a `\s`).
fn last_run(before: &str) -> &str {
    let start = before
        .char_indices()
        .rev()
        .find(|(_, c)| is_js_space(*c))
        .map_or(0, |(i, c)| i + c.len_utf8());
    &before[start..]
}

/// `slashTokenBeforeCaret(before)` (slash-commands.ts:326):
/// `/(^|\s)\/(\S*)$/`'s token, without its `/`.
pub fn slash_token_before_caret(before: &str) -> Option<&str> {
    last_run(before).strip_prefix('/')
}

/// `/^\s*\/\S*$/.test(value)` (PromptInput.tsx:1269): the whole input is
/// one `/word`, so Enter runs the command.
pub fn slash_at_start(value: &str) -> bool {
    let rest = value.trim_start_matches(is_js_space);
    rest.strip_prefix('/')
        .is_some_and(|r| !r.chars().any(is_js_space))
}

/// `insertSlashCommand(cmd)` (PromptInput.tsx:1617): the `/token` before
/// `caret` becomes `/<cmd> ` (`(^|\s)\/(\S*)$` replaced, the rest kept);
/// the new text and where the caret lands. A text with no token before
/// the caret is kept, the caret where it was.
pub fn insert_slash_command(value: &str, caret: usize, cmd: &str) -> (String, usize) {
    splice_token(value, caret, slash_token_before_caret, &format!("/{cmd} "))
}

/// Replaces the token `token(before)` found (its trigger character and
/// itself) with `insert`.
pub(crate) fn splice_token(
    value: &str,
    caret: usize,
    token: fn(&str) -> Option<&str>,
    insert: &str,
) -> (String, usize) {
    let caret = floor_boundary(value, caret);
    let (before, after) = value.split_at(caret);
    let replaced = match token(before) {
        // The trigger is one ASCII byte.
        Some(tok) => format!("{}{insert}", &before[..before.len() - tok.len() - 1]),
        None => before.to_owned(),
    };
    let at = replaced.len();
    (format!("{replaced}{after}"), at)
}

/// `caret` clamped into `s`, on a character boundary.
pub(crate) fn floor_boundary(s: &str, caret: usize) -> usize {
    let mut i = caret.min(s.len());
    while !s.is_char_boundary(i) {
        i -= 1;
    }
    i
}

/// The picker's `filter` (SlashCommandPicker.tsx:125): the token after
/// `/`, trimmed and lowercased.
pub fn picker_filter(slash_query: &str) -> String {
    trim(slash_query).to_lowercase()
}

/// `fuzzyScore(needle, hay)` (SlashCommandPicker.tsx:40), in UTF-16 code
/// units: 100 for a prefix, `60 - i` for a substring at `i`, else the
/// subsequence's length (`-1` when it isn't one); 0 for no needle.
pub fn fuzzy_score(needle: &str, hay: &str) -> i64 {
    if needle.is_empty() {
        return 0;
    }
    let n: Vec<u16> = needle.encode_utf16().collect();
    let h: Vec<u16> = hay.encode_utf16().collect();
    if let Some(i) = h.windows(n.len()).position(|w| w == n.as_slice()) {
        return if i == 0 { 100 } else { 60 - i as i64 };
    }
    let mut k = 0;
    let mut score = 0;
    for u in &h {
        if k == n.len() {
            break;
        }
        if *u == n[k] {
            score += 1;
            k += 1;
        }
    }
    if k == n.len() { score } else { -1 }
}

/// `descriptionWordPrefixScore(filter, description)`
/// (slash-commands.ts:340): 10 when `filter` prefixes a `[a-z0-9]+` word of
/// the lowercased description, else 0.
pub fn description_word_prefix_score(filter: &str, description: &str) -> i64 {
    if filter.is_empty() {
        return 0;
    }
    let f = filter.to_lowercase();
    let d = description.to_lowercase();
    let hit = d
        .split(|c: char| !(c.is_ascii_lowercase() || c.is_ascii_digit()))
        .any(|w| !w.is_empty() && w.starts_with(&f));
    if hit { 10 } else { 0 }
}

/// The picker's `filtered` (SlashCommandPicker.tsx:126): everything for no
/// filter, else the rows whose best score (name and aliases fuzzy, the
/// description by word prefix) is positive, best first (stable).
pub fn filter_suggestions<'a>(
    all: &'a [SlashSuggestion],
    filter: &str,
) -> Vec<&'a SlashSuggestion> {
    if filter.is_empty() {
        return all.iter().collect();
    }
    let mut scored: Vec<(&SlashSuggestion, i64)> = Vec::new();
    for c in all {
        let score = c
            .aliases
            .iter()
            .map(|a| fuzzy_score(filter, a))
            .chain([
                fuzzy_score(filter, &c.name),
                description_word_prefix_score(filter, &c.description),
            ])
            .max()
            .unwrap_or(0);
        if score > 0 {
            scored.push((c, score));
        }
    }
    // Stable, as `Array.prototype.sort`.
    scored.sort_by_key(|a| std::cmp::Reverse(a.1));
    scored.into_iter().map(|(c, _)| c).collect()
}

/// `filtered.slice(0, 16)` (SlashCommandPicker.tsx:144).
pub const VISIBLE_LIMIT: usize = 16;

/// `fuzzySlashMatchIndices(filter, name)` (slash-commands.ts:540): the code
/// point indices of the lowercased `name` that matched (a substring first,
/// else a subsequence), or `None`.
pub fn fuzzy_slash_match_indices(filter: &str, name: &str) -> Option<Vec<usize>> {
    if filter.is_empty() {
        return None;
    }
    let hay: Vec<char> = name.to_lowercase().chars().collect();
    let needle: Vec<char> = filter.to_lowercase().chars().collect();
    if needle.len() <= hay.len() {
        for start in 0..=hay.len() - needle.len() {
            if hay[start..start + needle.len()] == needle[..] {
                return Some((start..start + needle.len()).collect());
            }
        }
    }
    let mut out = Vec::new();
    let mut k = 0;
    for (h, c) in hay.iter().enumerate() {
        if k == needle.len() {
            break;
        }
        if *c == needle[k] {
            out.push(h);
            k += 1;
        }
    }
    (k == needle.len()).then_some(out)
}

/// `toRuns(indices)` (SlashCommandPicker.tsx:60): sorted indices as
/// `[start, end)` runs of consecutive values.
pub fn to_runs(indices: &[usize]) -> Vec<(usize, usize)> {
    let mut runs: Vec<(usize, usize)> = Vec::new();
    for &i in indices {
        match runs.last_mut() {
            Some(r) if r.1 == i => r.1 = i + 1,
            _ => runs.push((i, i + 1)),
        }
    }
    runs
}

/// `HighlightedCommandName` (SlashCommandPicker.tsx:92): `name` in pieces,
/// each `(text, bold)`; the matched runs bold, split by code point.
pub fn highlight_segments(filter: &str, name: &str) -> Vec<(String, bool)> {
    let indices = fuzzy_slash_match_indices(filter, name).unwrap_or_default();
    if indices.is_empty() {
        return vec![(name.to_owned(), false)];
    }
    let chars: Vec<char> = name.chars().collect();
    // `Array.prototype.slice` clamps (a lowercased name can be longer).
    let piece = |a: usize, b: usize| -> String {
        let a = a.min(chars.len());
        chars[a..b.clamp(a, chars.len())].iter().collect()
    };
    let mut out = Vec::new();
    let mut cursor = 0;
    for (start, end) in to_runs(&indices) {
        if start > cursor {
            out.push((piece(cursor, start), false));
        }
        out.push((piece(start, end), true));
        cursor = end;
    }
    if cursor < chars.len() {
        out.push((piece(cursor, chars.len()), false));
    }
    out
}

/// `isConfidentSlashMatch(cmd, filter)` (slash-commands.ts:569): a prefix
/// of the name (or of a `plugin:name`'s bare name) or of an alias. Case
/// as given: the filter is lowercased, the name isn't.
pub fn is_confident_slash_match(name: &str, aliases: &[String], filter: &str) -> bool {
    if filter.is_empty() {
        return false;
    }
    if name.starts_with(filter) {
        return true;
    }
    if let Some(i) = name.rfind(':')
        && name[i + 1..].starts_with(filter)
    {
        return true;
    }
    aliases.iter().any(|a| a.starts_with(filter))
}

/// The picker's header (SlashCommandPicker.tsx:233).
pub const HEADER: &str = "Slash commands \u{b7} Tab to insert";
/// The SDK's own commands' badge (SlashCommandPicker.tsx:290).
pub const BUILTIN_BADGE: &str = "built-in";

#[cfg(test)]
mod tests;
