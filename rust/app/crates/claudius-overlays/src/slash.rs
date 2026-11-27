//! `lib/shared/slash-commands.ts`' registry (`SLASH_COMMANDS`, its
//! categories, `CATEGORY_LABELS` and the private `CATEGORY_ORDER`) and
//! `mergeSuggestions`, with `lib/shared/slash-help.ts`' `findHelpTopic` and
//! `usageLine`: what the palette's slash rows and the help overlay list.
//! Replayed against the TS by `tests/overlays_golden.rs` (the table entry
//! by entry).
//!
//! The same table is being ported for the composer's slash picker (U07b,
//! `claudius-composer`'s `slash` module, with the same field names); once
//! that merges, one of the two should re-export the other.

use std::cmp::Ordering;

use claudius_core::collate::locale_compare;

use crate::js;

/// `SlashCategory`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Category {
    Session,
    Permissions,
    Tools,
    Memory,
    Model,
    Ui,
    Cost,
    Auth,
    Platform,
    Integrations,
    Info,
    Skill,
    Experimental,
}

impl Category {
    /// The private `CATEGORY_ORDER` (slash-commands.ts:51-65): the display
    /// order `mergeSuggestions` sorts by.
    pub const ORDER: [Category; 13] = [
        Category::Session,
        Category::Permissions,
        Category::Tools,
        Category::Memory,
        Category::Model,
        Category::Ui,
        Category::Cost,
        Category::Skill,
        Category::Info,
        Category::Auth,
        Category::Integrations,
        Category::Platform,
        Category::Experimental,
    ];

    /// The TS id (`"session"`).
    pub fn id(self) -> &'static str {
        match self {
            Category::Session => "session",
            Category::Permissions => "permissions",
            Category::Tools => "tools",
            Category::Memory => "memory",
            Category::Model => "model",
            Category::Ui => "ui",
            Category::Cost => "cost",
            Category::Auth => "auth",
            Category::Platform => "platform",
            Category::Integrations => "integrations",
            Category::Info => "info",
            Category::Skill => "skill",
            Category::Experimental => "experimental",
        }
    }

    /// `CATEGORY_LABELS` (slash-commands.ts:67-81).
    pub fn label(self) -> &'static str {
        match self {
            Category::Session => "Session",
            Category::Permissions => "Permissions",
            Category::Tools => "Tools",
            Category::Memory => "Memory & context",
            Category::Model => "Model",
            Category::Ui => "Interface",
            Category::Cost => "Cost & usage",
            Category::Auth => "Auth",
            Category::Platform => "Platform",
            Category::Integrations => "Integrations",
            Category::Info => "Info",
            Category::Skill => "Skills",
            Category::Experimental => "Experimental",
        }
    }

    /// Its place in [`Self::ORDER`].
    pub fn rank(self) -> usize {
        Category::ORDER
            .iter()
            .position(|c| *c == self)
            .expect("every category is in the order")
    }
}

/// `SlashHandler`: who answers the command.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Handler {
    /// Handled in the app; the SDK never sees it.
    Native,
    /// Forwarded to the SDK as plain input.
    Sdk,
    /// Surfaced for awareness only (terminal-only or hosted flows).
    External,
}

impl Handler {
    /// The TS id, which the help overlay's badge prints.
    pub fn id(self) -> &'static str {
        match self {
            Handler::Native => "native",
            Handler::Sdk => "sdk",
            Handler::External => "external",
        }
    }
}

/// A `SLASH_COMMANDS` entry.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct SlashCommand {
    pub id: &'static str,
    /// The trigger, without the slash.
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

/// `SLASH_COMMANDS` (slash-commands.ts:83-286), in registry order.
pub const SLASH_COMMANDS: &[SlashCommand] = &[
    cmd(
        "clear",
        "clear",
        &["reset", "new"],
        "Start a fresh session (clears context).",
        Category::Session,
        Handler::Native,
        None,
        false,
    ),
    cmd(
        "compact",
        "compact",
        &[],
        "Compact the conversation to free up context.",
        Category::Session,
        Handler::Sdk,
        Some("[focus instructions]"),
        false,
    ),
    cmd(
        "resume",
        "resume",
        &["continue"],
        "Open the session picker / resume a session.",
        Category::Session,
        Handler::Native,
        Some("[id]"),
        false,
    ),
    cmd(
        "fork",
        "fork",
        &["branch"],
        "Fork the current session at the latest message.",
        Category::Session,
        Handler::Native,
        Some("[name]"),
        false,
    ),
    cmd(
        "rename",
        "rename",
        &[],
        "Rename the current session.",
        Category::Session,
        Handler::Native,
        Some("[title]"),
        false,
    ),
    cmd(
        "export",
        "export",
        &[],
        "Download the current session as plain text.",
        Category::Session,
        Handler::Native,
        Some("[filename]"),
        false,
    ),
    cmd(
        "rewind",
        "rewind",
        &["checkpoint", "undo"],
        "Rewind to a previous user message (use the \u{21ba} buttons).",
        Category::Session,
        Handler::Native,
        None,
        false,
    ),
    cmd(
        "goal",
        "goal",
        &["objective"],
        "Set a goal for this session \u{2014} shown prominently and tracked until achieved. /goal clear removes it.",
        Category::Session,
        Handler::Native,
        Some("[goal text | clear]"),
        false,
    ),
    cmd(
        "exit",
        "exit",
        &["quit"],
        "End the current session.",
        Category::Session,
        Handler::Native,
        None,
        false,
    ),
    cmd(
        "permissions",
        "permissions",
        &["allowed-tools"],
        "Manage allow/ask/deny rules across scopes.",
        Category::Permissions,
        Handler::Native,
        None,
        false,
    ),
    cmd(
        "sandbox",
        "sandbox",
        &[],
        "Toggle sandbox mode (OS-level filesystem/network isolation).",
        Category::Permissions,
        Handler::Sdk,
        None,
        false,
    ),
    cmd(
        "agents",
        "agents",
        &[],
        "Manage subagent configurations.",
        Category::Tools,
        Handler::Native,
        None,
        false,
    ),
    cmd(
        "hooks",
        "hooks",
        &[],
        "View hook configurations.",
        Category::Tools,
        Handler::Native,
        None,
        false,
    ),
    cmd(
        "mcp",
        "mcp",
        &[],
        "Manage MCP servers and OAuth.",
        Category::Tools,
        Handler::Native,
        None,
        false,
    ),
    cmd(
        "plugin",
        "plugin",
        &[],
        "Manage plugins.",
        Category::Tools,
        Handler::Native,
        None,
        false,
    ),
    cmd(
        "reload-plugins",
        "reload-plugins",
        &[],
        "Reload plugins to apply changes.",
        Category::Tools,
        Handler::Native,
        Some("[force]"),
        false,
    ),
    cmd(
        "reload-skills",
        "reload-skills",
        &[],
        "Pick up skills added or changed on disk during this session.",
        Category::Tools,
        Handler::Sdk,
        None,
        false,
    ),
    cmd(
        "tasks",
        "tasks",
        &["bashes"],
        "List and manage background tasks.",
        Category::Tools,
        Handler::Native,
        None,
        false,
    ),
    cmd(
        "skills",
        "skills",
        &[],
        "List available skills.",
        Category::Tools,
        Handler::Native,
        None,
        false,
    ),
    cmd(
        "memory",
        "memory",
        &[],
        "Edit CLAUDE.md, browse memory, toggle auto-memory.",
        Category::Memory,
        Handler::Native,
        None,
        false,
    ),
    cmd(
        "context",
        "context",
        &[],
        "Visualize context window usage.",
        Category::Memory,
        Handler::Native,
        None,
        false,
    ),
    cmd(
        "skill-doctor",
        "skill-doctor",
        &[],
        "Show per-skill context cost, so you can prune what's not worth it.",
        Category::Memory,
        Handler::Native,
        None,
        false,
    ),
    cmd(
        "init",
        "init",
        &[],
        "Initialize a CLAUDE.md for this project.",
        Category::Memory,
        Handler::Sdk,
        None,
        false,
    ),
    cmd(
        "recap",
        "recap",
        &[],
        "Generate a one-line session summary.",
        Category::Memory,
        Handler::Native,
        None,
        false,
    ),
    cmd(
        "btw",
        "btw",
        &[],
        "Side question \u{2014} ephemeral, no tools, no history.",
        Category::Memory,
        Handler::Sdk,
        Some("<question>"),
        false,
    ),
    cmd(
        "model",
        "model",
        &[],
        "Switch model (e.g. claude-opus-4-7 / claude-sonnet-4-6), or open the picker with no args.",
        Category::Model,
        Handler::Native,
        Some("[model-id]"),
        false,
    ),
    cmd(
        "effort",
        "effort",
        &[],
        "Set effort level, or toggle ultracode; open the picker with no args.",
        Category::Model,
        Handler::Native,
        Some("[level] | ultracode on|off"),
        false,
    ),
    cmd(
        "fast",
        "fast",
        &[],
        "Toggle fast mode, or open the picker with no args.",
        Category::Model,
        Handler::Native,
        Some("[on|off]"),
        true,
    ),
    cmd(
        "advisor",
        "advisor",
        &[],
        "Set the Advisor model (opus/sonnet/fable/off), or open the picker with no args.",
        Category::Model,
        Handler::Native,
        Some("[model|off]"),
        false,
    ),
    cmd(
        "settings",
        "settings",
        &["config"],
        "Open the settings editor.",
        Category::Ui,
        Handler::Native,
        None,
        false,
    ),
    cmd(
        "theme",
        "theme",
        &[],
        "Pick a color theme.",
        Category::Ui,
        Handler::Native,
        None,
        false,
    ),
    cmd(
        "statusline",
        "statusline",
        &[],
        "Configure the status line.",
        Category::Ui,
        Handler::Native,
        None,
        false,
    ),
    cmd(
        "keybindings",
        "keybindings",
        &[],
        "Edit keybindings.",
        Category::Ui,
        Handler::Native,
        None,
        false,
    ),
    cmd(
        "color",
        "color",
        &[],
        "Set prompt accent color.",
        Category::Ui,
        Handler::Native,
        Some("[color|default]"),
        false,
    ),
    cmd(
        "diff",
        "diff",
        &[],
        "Show uncommitted changes as an overlay.",
        Category::Ui,
        Handler::Native,
        None,
        false,
    ),
    cmd(
        "focus",
        "focus",
        &[],
        "Cycle focus mode (off \u{2192} focus \u{2192} zen).",
        Category::Ui,
        Handler::Native,
        Some("[off|focus|zen]"),
        false,
    ),
    cmd(
        "output-style",
        "output-style",
        &[],
        "List or switch the response output style.",
        Category::Ui,
        Handler::Native,
        Some("[name]"),
        false,
    ),
    cmd(
        "zen",
        "zen",
        &[],
        "Toggle Zen mode \u{2014} hide everything but the chat.",
        Category::Ui,
        Handler::Native,
        None,
        false,
    ),
    cmd(
        "tui",
        "tui",
        &[],
        "Switch UI renderer.",
        Category::Ui,
        Handler::External,
        None,
        false,
    ),
    cmd(
        "cost",
        "cost",
        &[],
        "Show session cost & usage as an overlay.",
        Category::Cost,
        Handler::Native,
        None,
        false,
    ),
    cmd(
        "usage",
        "usage",
        &["stats"],
        "Open the Usage & account page.",
        Category::Cost,
        Handler::Native,
        None,
        false,
    ),
    cmd(
        "extra-usage",
        "extra-usage",
        &[],
        "Configure extra usage for rate-limit recovery.",
        Category::Cost,
        Handler::Sdk,
        None,
        false,
    ),
    cmd(
        "rate-limit-options",
        "rate-limit-options",
        &[],
        "Show options for handling a usage limit (Usage page).",
        Category::Cost,
        Handler::Native,
        None,
        false,
    ),
    cmd(
        "login",
        "login",
        &[],
        "Sign in to Anthropic.",
        Category::Auth,
        Handler::Native,
        None,
        false,
    ),
    cmd(
        "logout",
        "logout",
        &[],
        "Sign out (helper).",
        Category::Auth,
        Handler::Native,
        None,
        false,
    ),
    cmd(
        "setup-bedrock",
        "setup-bedrock",
        &[],
        "Configure Amazon Bedrock.",
        Category::Auth,
        Handler::Native,
        None,
        false,
    ),
    cmd(
        "setup-vertex",
        "setup-vertex",
        &[],
        "Configure Google Vertex AI.",
        Category::Auth,
        Handler::Native,
        None,
        false,
    ),
    cmd(
        "ide",
        "ide",
        &[],
        "Claudius is the IDE \u{2014} opens the Files browser.",
        Category::Integrations,
        Handler::Native,
        None,
        false,
    ),
    cmd(
        "install-github-app",
        "install-github-app",
        &[],
        "Install Claude GitHub Actions.",
        Category::Integrations,
        Handler::Native,
        None,
        false,
    ),
    cmd(
        "install-slack-app",
        "install-slack-app",
        &[],
        "Install Claude Slack app.",
        Category::Integrations,
        Handler::Native,
        None,
        false,
    ),
    cmd(
        "chrome",
        "chrome",
        &[],
        "Configure Chrome integration (no-op \u{2014} Claudius runs in Chromium).",
        Category::Integrations,
        Handler::Native,
        None,
        false,
    ),
    cmd(
        "web-setup",
        "web-setup",
        &[],
        "Connect GitHub for web sessions on claude.ai.",
        Category::Integrations,
        Handler::Native,
        None,
        false,
    ),
    cmd(
        "desktop",
        "desktop",
        &["app"],
        "Open or recommend the Claudius desktop app.",
        Category::Platform,
        Handler::Native,
        None,
        false,
    ),
    cmd(
        "mobile",
        "mobile",
        &["ios", "android"],
        "Open the Claude mobile app page.",
        Category::Platform,
        Handler::Native,
        None,
        false,
    ),
    cmd(
        "passes",
        "passes",
        &[],
        "Share free week with friends (CLI only).",
        Category::Platform,
        Handler::Native,
        None,
        false,
    ),
    cmd(
        "stickers",
        "stickers",
        &[],
        "Order Claude Code stickers.",
        Category::Platform,
        Handler::Native,
        None,
        false,
    ),
    cmd(
        "teleport",
        "teleport",
        &["tp"],
        "Pull a web session into the terminal (CLI only).",
        Category::Platform,
        Handler::Native,
        None,
        false,
    ),
    cmd(
        "remote-control",
        "remote-control",
        &["rc"],
        "Enable remote control from claude.ai (CLI only).",
        Category::Platform,
        Handler::Native,
        None,
        false,
    ),
    cmd(
        "remote-env",
        "remote-env",
        &[],
        "Configure default remote environment on claude.ai.",
        Category::Platform,
        Handler::Native,
        None,
        false,
    ),
    cmd(
        "upgrade",
        "upgrade",
        &[],
        "Open the Claude plan upgrade page.",
        Category::Platform,
        Handler::Native,
        None,
        false,
    ),
    cmd(
        "voice",
        "voice",
        &[],
        "Voice dictation mode.",
        Category::Platform,
        Handler::External,
        None,
        false,
    ),
    cmd(
        "help",
        "help",
        &[],
        "Show all slash commands and shortcuts.",
        Category::Info,
        Handler::Native,
        None,
        false,
    ),
    cmd(
        "status",
        "status",
        &[],
        "Show session/account/connectivity status.",
        Category::Info,
        Handler::Native,
        None,
        false,
    ),
    cmd(
        "release-notes",
        "release-notes",
        &[],
        "Open the changelog.",
        Category::Info,
        Handler::Native,
        None,
        false,
    ),
    cmd(
        "feedback",
        "feedback",
        &["bug"],
        "Submit feedback via GitHub Issues.",
        Category::Info,
        Handler::Native,
        None,
        false,
    ),
    cmd(
        "insights",
        "insights",
        &[],
        "Generate report on session patterns.",
        Category::Info,
        Handler::Sdk,
        None,
        false,
    ),
    cmd(
        "team-onboarding",
        "team-onboarding",
        &[],
        "Generate team onboarding guide.",
        Category::Info,
        Handler::Sdk,
        None,
        false,
    ),
    cmd(
        "heapdump",
        "heapdump",
        &[],
        "Write a heap snapshot + diagnostics report (agent subprocess).",
        Category::Info,
        Handler::Sdk,
        None,
        false,
    ),
    cmd(
        "doctor",
        "doctor",
        &["checkup"],
        "Full setup checkup \u{2014} diagnose and fix installation/auth/git/permissions issues.",
        Category::Info,
        Handler::Native,
        Some("[prompt-audit]"),
        false,
    ),
    cmd(
        "powerup",
        "powerup",
        &[],
        "Open the Release notes (Claudius's feature-tour surface).",
        Category::Info,
        Handler::Native,
        None,
        false,
    ),
    cmd(
        "add-dir",
        "add-dir",
        &[],
        "Add a working directory to this session.",
        Category::Info,
        Handler::Native,
        Some("<path>"),
        false,
    ),
    cmd(
        "worktrees",
        "worktrees",
        &["worktree"],
        "Open a chat session in a git worktree.",
        Category::Session,
        Handler::Native,
        None,
        false,
    ),
    cmd(
        "files",
        "files",
        &[],
        "Browse files in the active workspace.",
        Category::Session,
        Handler::Native,
        None,
        false,
    ),
    cmd(
        "batch",
        "batch",
        &[],
        "Large-scale changes across the codebase.",
        Category::Skill,
        Handler::Sdk,
        Some("<instruction>"),
        false,
    ),
    cmd(
        "claude-api",
        "claude-api",
        &[],
        "Claude API reference / migration helper.",
        Category::Skill,
        Handler::Sdk,
        None,
        false,
    ),
    cmd(
        "debug",
        "debug",
        &[],
        "Enable debug logging and troubleshoot.",
        Category::Skill,
        Handler::Sdk,
        None,
        false,
    ),
    cmd(
        "fewer-permission-prompts",
        "fewer-permission-prompts",
        &[],
        "Allowlist common read-only tools.",
        Category::Skill,
        Handler::Sdk,
        None,
        false,
    ),
    cmd(
        "loop",
        "loop",
        &[],
        "Run a prompt or slash command on an interval, or self-paced.",
        Category::Skill,
        Handler::Sdk,
        Some("[interval] [prompt]"),
        false,
    ),
    cmd(
        "schedule",
        "schedule",
        &["routines"],
        "Manage scheduled routines.",
        Category::Skill,
        Handler::Native,
        None,
        false,
    ),
    cmd(
        "simplify",
        "simplify",
        &[],
        "Review files, find issues, apply fixes.",
        Category::Skill,
        Handler::Sdk,
        Some("[focus]"),
        false,
    ),
    cmd(
        "review",
        "review",
        &["code-review"],
        "Review the current branch or a PR (alias of /code-review).",
        Category::Skill,
        Handler::Sdk,
        Some("[level] [PR] | ultra"),
        false,
    ),
    cmd(
        "security-review",
        "security-review",
        &[],
        "Security review of pending changes.",
        Category::Skill,
        Handler::Sdk,
        None,
        false,
    ),
    cmd(
        "ultrareview",
        "ultrareview",
        &[],
        "Deep multi-agent code review.",
        Category::Skill,
        Handler::Sdk,
        Some("[PR]"),
        false,
    ),
    cmd(
        "autofix-pr",
        "autofix-pr",
        &[],
        "Watch PR and auto-fix CI failures.",
        Category::Skill,
        Handler::Sdk,
        Some("[prompt]"),
        false,
    ),
    cmd(
        "plan",
        "plan",
        &[],
        "Enter plan mode (read-only planning).",
        Category::Experimental,
        Handler::Native,
        Some("[description]"),
        false,
    ),
    cmd(
        "copy",
        "copy",
        &[],
        "Copy the last response to clipboard.",
        Category::Ui,
        Handler::Native,
        Some("[N]"),
        false,
    ),
];

/// Where a merged command came from (`SlashSuggestion.source`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Source {
    Registry,
    Sdk,
    Skill,
    Mcp,
}

impl Source {
    pub fn id(self) -> &'static str {
        match self {
            Source::Registry => "registry",
            Source::Sdk => "sdk",
            Source::Skill => "skill",
            Source::Mcp => "mcp",
        }
    }
}

/// `SlashSuggestion`: a registry entry or a command only the SDK reports.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SlashSuggestion {
    pub id: String,
    pub name: String,
    pub aliases: Vec<String>,
    pub description: String,
    pub category: Category,
    pub handler: Handler,
    pub args_hint: Option<String>,
    pub source: Source,
    /// The SDK's `builtin` flag (only on SDK-only rows).
    pub builtin: bool,
}

impl SlashSuggestion {
    fn of(c: &SlashCommand) -> SlashSuggestion {
        SlashSuggestion {
            id: c.id.into(),
            name: c.name.into(),
            aliases: c.aliases.iter().map(|a| (*a).into()).collect(),
            description: c.description.into(),
            category: c.category,
            handler: c.handler,
            args_hint: c.args_hint.map(Into::into),
            source: Source::Registry,
            builtin: false,
        }
    }
}

/// `SdkSlashCommandInfo`: a command as the SDK's `supportedCommands()`
/// reports it (`GET /api/sessions/<id>/commands`).
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct SdkCommandInfo {
    pub name: String,
    pub description: Option<String>,
    pub argument_hint: Option<String>,
    pub aliases: Option<Vec<String>>,
    pub builtin: bool,
}

/// `mergeSuggestions(sdkSlashCommands, sdkSkills, richCommands)`
/// (slash-commands.ts:445-498): the registry, then every SDK name it
/// doesn't claim (by name or alias), described from the rich list when
/// there is one; sorted by category order, then `localeCompare` of the
/// names (a stable sort).
pub fn merge_suggestions(
    sdk_slash_commands: &[String],
    sdk_skills: &[String],
    rich: Option<&[SdkCommandInfo]>,
) -> Vec<SlashSuggestion> {
    let mut out: Vec<SlashSuggestion> = Vec::new();
    let mut claimed: Vec<String> = Vec::new();
    for c in SLASH_COMMANDS {
        out.push(SlashSuggestion::of(c));
        claimed.push(c.name.into());
        claimed.extend(c.aliases.iter().map(|a| (*a).to_owned()));
    }
    // `richByName`: a Map keeps a name's first place and its last value.
    let mut rich_by_name: Vec<(&str, &SdkCommandInfo)> = Vec::new();
    for rc in rich.unwrap_or_default() {
        match rich_by_name.iter_mut().find(|(n, _)| *n == rc.name) {
            Some(slot) => slot.1 = rc,
            None => rich_by_name.push((&rc.name, rc)),
        }
    }
    // The union of the init list and the rich names, in that order.
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
    for name in names {
        if claimed.iter().any(|c| c == name) {
            continue;
        }
        claimed.push(name.into());
        let rich = rich_by_name
            .iter()
            .find(|(n, _)| *n == name)
            .map(|(_, r)| *r);
        let is_skill = sdk_skills.iter().any(|s| s == name);
        let description = rich
            .and_then(|r| r.description.as_deref())
            .map(js::trim)
            .filter(|d| !d.is_empty())
            .map(str::to_owned)
            .unwrap_or_else(|| {
                if is_skill {
                    "Skill provided by the SDK.".into()
                } else {
                    "Provided by the SDK.".into()
                }
            });
        out.push(SlashSuggestion {
            id: format!("sdk:{name}"),
            name: name.into(),
            aliases: rich
                .and_then(|r| r.aliases.clone())
                .filter(|a| !a.is_empty())
                .unwrap_or_default(),
            description,
            category: if is_skill {
                Category::Skill
            } else {
                Category::Experimental
            },
            handler: Handler::Sdk,
            args_hint: rich
                .and_then(|r| r.argument_hint.as_deref())
                .map(js::trim)
                .filter(|h| !h.is_empty())
                .map(str::to_owned),
            source: if is_skill { Source::Skill } else { Source::Sdk },
            builtin: rich.is_some_and(|r| r.builtin),
        });
    }
    out.sort_by(|a, b| match a.category.rank().cmp(&b.category.rank()) {
        Ordering::Equal => locale_compare(&a.name, &b.name),
        o => o,
    });
    out
}

/// `findHelpTopic(all, topic)` (slash-help.ts:35-38): the command a topic
/// names, by primary name, else by alias (case-insensitively).
pub fn find_help_topic<'a>(all: &'a [SlashSuggestion], topic: &str) -> Option<&'a SlashSuggestion> {
    let t = js::lower(topic);
    all.iter().find(|c| js::lower(&c.name) == t).or_else(|| {
        all.iter()
            .find(|c| c.aliases.iter().any(|a| js::lower(a) == t))
    })
}

/// `usageLine(cmd)` (slash-help.ts:41-43): `/name <args>`.
pub fn usage_line(c: &SlashSuggestion) -> String {
    match c.args_hint.as_deref().filter(|h| !h.is_empty()) {
        Some(h) => format!("/{} {h}", c.name),
        None => format!("/{}", c.name),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn s(v: &[&str]) -> Vec<String> {
        v.iter().map(|x| (*x).to_owned()).collect()
    }

    #[test]
    fn the_registry_ids_are_unique_and_core_s() {
        let mut ids: Vec<&str> = SLASH_COMMANDS.iter().map(|c| c.id).collect();
        // claudius-core's lookup half lists the same commands in the same order.
        let core: Vec<&str> = claudius_core::slash_commands::SLASH_COMMANDS
            .iter()
            .map(|(id, _, _)| *id)
            .collect();
        assert_eq!(ids, core);
        ids.sort_unstable();
        ids.dedup();
        assert_eq!(ids.len(), SLASH_COMMANDS.len());
    }

    #[test]
    fn merge_suggestions_skips_claimed_names_and_aliases() {
        let all = merge_suggestions(&s(&["clear", "reset", "deploy"]), &[], None);
        assert_eq!(all.len(), SLASH_COMMANDS.len() + 1);
        let d = all.iter().find(|c| c.name == "deploy").unwrap();
        assert_eq!(d.id, "sdk:deploy");
        assert_eq!(d.description, "Provided by the SDK.");
        assert_eq!(
            (d.category, d.handler, d.source),
            (Category::Experimental, Handler::Sdk, Source::Sdk)
        );
    }

    #[test]
    fn merge_suggestions_describes_skills_and_rich_commands() {
        let rich = [SdkCommandInfo {
            name: "deploy".into(),
            description: Some("  Ship it. ".into()),
            argument_hint: Some(" <env> ".into()),
            aliases: Some(s(&["ship"])),
            builtin: true,
        }];
        let all = merge_suggestions(&s(&["sk"]), &s(&["sk"]), Some(&rich));
        let sk = all.iter().find(|c| c.name == "sk").unwrap();
        assert_eq!(sk.description, "Skill provided by the SDK.");
        assert_eq!((sk.category, sk.source), (Category::Skill, Source::Skill));
        let d = all.iter().find(|c| c.name == "deploy").unwrap();
        assert_eq!(d.description, "Ship it.");
        assert_eq!(d.args_hint.as_deref(), Some("<env>"));
        assert_eq!(d.aliases, s(&["ship"]));
        assert!(d.builtin);
    }

    #[test]
    fn merge_suggestions_sorts_by_category_then_name() {
        let all = merge_suggestions(&[], &[], None);
        assert_eq!(all[0].category, Category::Session);
        assert_eq!(all.last().unwrap().category, Category::Experimental);
        for w in all.windows(2) {
            let (a, b) = (&w[0], &w[1]);
            assert!(
                a.category.rank() < b.category.rank()
                    || (a.category == b.category && locale_compare(&a.name, &b.name).is_le()),
                "{} before {}",
                a.name,
                b.name
            );
        }
    }

    #[test]
    fn find_help_topic_prefers_names_then_aliases() {
        let all = merge_suggestions(&[], &[], None);
        assert_eq!(find_help_topic(&all, "CLEAR").unwrap().id, "clear");
        assert_eq!(find_help_topic(&all, "reset").unwrap().id, "clear");
        assert!(find_help_topic(&all, "nope").is_none());
    }

    #[test]
    fn usage_line_appends_the_args_hint() {
        let all = merge_suggestions(&[], &[], None);
        let c = |id: &str| all.iter().find(|c| c.id == id).unwrap();
        assert_eq!(usage_line(c("clear")), "/clear");
        assert_eq!(usage_line(c("compact")), "/compact [focus instructions]");
    }
}
