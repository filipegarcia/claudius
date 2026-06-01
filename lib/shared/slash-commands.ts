// Canonical registry of Claude Code slash commands. Keep entries in sync with the
// Claude Code feature inventory; this is the single source of truth for the picker,
// the help modal, and which commands the web app intercepts vs. forwards to the SDK.

export type SlashHandler =
  // Handled in the web app — the SDK never sees the input.
  | "native"
  // Forwarded to the SDK as plain user input — Claude Code interprets the slash command.
  | "sdk"
  // Surfaced for awareness only; either tied to terminal-only flows or hosted services.
  | "external";

export type SlashCategory =
  | "session"
  | "permissions"
  | "tools"
  | "memory"
  | "model"
  | "ui"
  | "cost"
  | "auth"
  | "platform"
  | "integrations"
  | "info"
  | "skill"
  | "experimental";

export type SlashCommand = {
  id: string;
  /** Primary trigger (without slash). */
  name: string;
  /** Aliases — also without slash. */
  aliases?: string[];
  description: string;
  category: SlashCategory;
  handler: SlashHandler;
  /** Free-text "argument hint" appended after the command in the picker. */
  argsHint?: string;
};

// Categories sorted in a useful display order:
const CATEGORY_ORDER: SlashCategory[] = [
  "session",
  "permissions",
  "tools",
  "memory",
  "model",
  "ui",
  "cost",
  "skill",
  "info",
  "auth",
  "integrations",
  "platform",
  "experimental",
];

export const CATEGORY_LABELS: Record<SlashCategory, string> = {
  session: "Session",
  permissions: "Permissions",
  tools: "Tools",
  memory: "Memory & context",
  model: "Model",
  ui: "Interface",
  cost: "Cost & usage",
  skill: "Skills",
  info: "Info",
  auth: "Auth",
  integrations: "Integrations",
  platform: "Platform",
  experimental: "Experimental",
};

export const SLASH_COMMANDS: SlashCommand[] = [
  // ── Session ──────────────────────────────────────────────────────────
  { id: "clear", name: "clear", aliases: ["reset", "new"], description: "Start a fresh session (clears context).", category: "session", handler: "native" },
  { id: "compact", name: "compact", description: "Compact the conversation to free up context.", category: "session", handler: "sdk", argsHint: "[focus instructions]" },
  { id: "resume", name: "resume", aliases: ["continue"], description: "Open the session picker / resume a session.", category: "session", handler: "native", argsHint: "[id]" },
  { id: "fork", name: "fork", aliases: ["branch"], description: "Fork the current session at the latest message.", category: "session", handler: "native", argsHint: "[name]" },
  { id: "rename", name: "rename", description: "Rename the current session.", category: "session", handler: "native", argsHint: "[title]" },
  { id: "export", name: "export", description: "Download the current session as plain text.", category: "session", handler: "native", argsHint: "[filename]" },
  { id: "rewind", name: "rewind", aliases: ["checkpoint", "undo"], description: "Rewind to a previous user message (use the ↺ buttons).", category: "session", handler: "native" },
  { id: "goal", name: "goal", aliases: ["objective"], description: "Set a goal for this session — shown prominently and tracked until achieved.", category: "session", handler: "native", argsHint: "[goal text]" },
  { id: "exit", name: "exit", aliases: ["quit"], description: "End the current session.", category: "session", handler: "native" },

  // ── Permissions ──────────────────────────────────────────────────────
  { id: "permissions", name: "permissions", aliases: ["allowed-tools"], description: "Manage allow/ask/deny rules across scopes.", category: "permissions", handler: "native" },
  { id: "sandbox", name: "sandbox", description: "Toggle sandbox mode (OS-level filesystem/network isolation).", category: "permissions", handler: "sdk" },

  // ── Tools / agents / hooks / mcp / plugins ───────────────────────────
  { id: "agents", name: "agents", description: "Manage subagent configurations.", category: "tools", handler: "native" },
  { id: "hooks", name: "hooks", description: "View hook configurations.", category: "tools", handler: "native" },
  { id: "mcp", name: "mcp", description: "Manage MCP servers and OAuth.", category: "tools", handler: "native" },
  { id: "plugin", name: "plugin", description: "Manage plugins.", category: "tools", handler: "native" },
  { id: "reload-plugins", name: "reload-plugins", description: "Reload plugins to apply changes.", category: "tools", handler: "native" },
  { id: "tasks", name: "tasks", aliases: ["bashes"], description: "List and manage background tasks.", category: "tools", handler: "native" },
  { id: "skills", name: "skills", description: "List available skills.", category: "tools", handler: "native" },

  // ── Memory & context ─────────────────────────────────────────────────
  { id: "memory", name: "memory", description: "Edit CLAUDE.md, browse memory, toggle auto-memory.", category: "memory", handler: "native" },
  { id: "context", name: "context", description: "Visualize context window usage.", category: "memory", handler: "native" },
  { id: "init", name: "init", description: "Initialize a CLAUDE.md for this project.", category: "memory", handler: "sdk" },
  { id: "recap", name: "recap", description: "Generate a one-line session summary.", category: "memory", handler: "native" },
  { id: "btw", name: "btw", description: "Side question — ephemeral, no tools, no history.", category: "memory", handler: "sdk", argsHint: "<question>" },

  // ── Model ────────────────────────────────────────────────────────────
  { id: "model", name: "model", description: "Pick a model (e.g. claude-opus-4-7 / claude-sonnet-4-6).", category: "model", handler: "native", argsHint: "[model-id]" },
  { id: "effort", name: "effort", description: "Set effort level (low/medium/high/xhigh/max/auto).", category: "model", handler: "sdk", argsHint: "[level]" },
  { id: "fast", name: "fast", description: "Toggle fast mode.", category: "model", handler: "sdk", argsHint: "[on|off]" },

  // ── UI ───────────────────────────────────────────────────────────────
  { id: "settings", name: "settings", aliases: ["config"], description: "Open the settings editor.", category: "ui", handler: "native" },
  { id: "theme", name: "theme", description: "Pick a color theme.", category: "ui", handler: "native" },
  { id: "statusline", name: "statusline", description: "Configure the status line.", category: "ui", handler: "native" },
  { id: "keybindings", name: "keybindings", description: "Edit keybindings.", category: "ui", handler: "native" },
  { id: "color", name: "color", description: "Set prompt accent color.", category: "ui", handler: "sdk", argsHint: "[color|default]" },
  { id: "diff", name: "diff", description: "Open the interactive diff viewer.", category: "ui", handler: "sdk" },
  { id: "focus", name: "focus", description: "Toggle focus view.", category: "ui", handler: "sdk" },
  { id: "tui", name: "tui", description: "Switch UI renderer.", category: "ui", handler: "external" },

  // ── Cost & usage ─────────────────────────────────────────────────────
  { id: "cost", name: "cost", description: "Show session cost & usage as an overlay.", category: "cost", handler: "native" },
  { id: "usage", name: "usage", aliases: ["stats"], description: "Open the Usage & account page.", category: "cost", handler: "native" },
  { id: "extra-usage", name: "extra-usage", description: "Configure extra usage for rate-limit recovery.", category: "cost", handler: "sdk" },

  // ── Auth / providers ─────────────────────────────────────────────────
  { id: "login", name: "login", description: "Sign in to Anthropic.", category: "auth", handler: "native" },
  { id: "logout", name: "logout", description: "Sign out (helper).", category: "auth", handler: "native" },
  { id: "setup-bedrock", name: "setup-bedrock", description: "Configure Amazon Bedrock.", category: "auth", handler: "native" },
  { id: "setup-vertex", name: "setup-vertex", description: "Configure Google Vertex AI.", category: "auth", handler: "native" },

  // ── Integrations ─────────────────────────────────────────────────────
  { id: "ide", name: "ide", description: "Manage IDE integrations.", category: "integrations", handler: "external" },
  { id: "install-github-app", name: "install-github-app", description: "Install Claude GitHub Actions.", category: "integrations", handler: "external" },
  { id: "install-slack-app", name: "install-slack-app", description: "Install Claude Slack app.", category: "integrations", handler: "external" },
  { id: "chrome", name: "chrome", description: "Configure Chrome integration.", category: "integrations", handler: "external" },
  { id: "web-setup", name: "web-setup", description: "Connect GitHub for web sessions.", category: "integrations", handler: "external" },

  // ── Platform / hosted ────────────────────────────────────────────────
  { id: "desktop", name: "desktop", aliases: ["app"], description: "Continue session in the Desktop app.", category: "platform", handler: "external" },
  { id: "mobile", name: "mobile", aliases: ["ios", "android"], description: "Open mobile app via QR.", category: "platform", handler: "external" },
  { id: "passes", name: "passes", description: "Share free week with friends.", category: "platform", handler: "external" },
  { id: "stickers", name: "stickers", description: "Order Claude Code stickers.", category: "platform", handler: "external" },
  { id: "teleport", name: "teleport", aliases: ["tp"], description: "Pull a web session into the terminal.", category: "platform", handler: "external" },
  { id: "remote-control", name: "remote-control", aliases: ["rc"], description: "Enable remote control from claude.ai.", category: "platform", handler: "external" },
  { id: "remote-env", name: "remote-env", description: "Configure default remote environment.", category: "platform", handler: "external" },
  { id: "upgrade", name: "upgrade", description: "Open upgrade page.", category: "platform", handler: "external" },
  { id: "voice", name: "voice", description: "Voice dictation mode.", category: "platform", handler: "external" },

  // ── Info / meta ──────────────────────────────────────────────────────
  { id: "help", name: "help", description: "Show all slash commands and shortcuts.", category: "info", handler: "native" },
  { id: "status", name: "status", description: "Show session/account/connectivity status.", category: "info", handler: "native" },
  { id: "release-notes", name: "release-notes", description: "Open the changelog.", category: "info", handler: "native" },
  { id: "feedback", name: "feedback", aliases: ["bug"], description: "Submit feedback.", category: "info", handler: "external" },
  { id: "insights", name: "insights", description: "Generate report on session patterns.", category: "info", handler: "sdk" },
  { id: "team-onboarding", name: "team-onboarding", description: "Generate team onboarding guide.", category: "info", handler: "sdk" },
  { id: "heapdump", name: "heapdump", description: "Write a Node diagnostic report.", category: "info", handler: "native" },
  { id: "doctor", name: "doctor", description: "Diagnose installation/auth/git/permissions.", category: "info", handler: "native" },
  { id: "powerup", name: "powerup", description: "Animated feature lessons.", category: "info", handler: "external" },
  { id: "add-dir", name: "add-dir", description: "Add a working directory to this session.", category: "info", handler: "native", argsHint: "<path>" },
  { id: "worktrees", name: "worktrees", aliases: ["worktree"], description: "Open a chat session in a git worktree.", category: "session", handler: "native" },
  { id: "files", name: "files", description: "Browse files in the active workspace.", category: "session", handler: "native" },

  // ── Skill commands (handled by the SDK as installed skills) ─────────
  { id: "batch", name: "batch", description: "Large-scale changes across the codebase.", category: "skill", handler: "sdk", argsHint: "<instruction>" },
  { id: "claude-api", name: "claude-api", description: "Claude API reference / migration helper.", category: "skill", handler: "sdk" },
  { id: "debug", name: "debug", description: "Enable debug logging and troubleshoot.", category: "skill", handler: "sdk" },
  { id: "fewer-permission-prompts", name: "fewer-permission-prompts", description: "Allowlist common read-only tools.", category: "skill", handler: "sdk" },
  { id: "loop", name: "loop", description: "Run a prompt or slash command on an interval.", category: "skill", handler: "native", argsHint: "[interval] [prompt]" },
  { id: "schedule", name: "schedule", aliases: ["routines"], description: "Manage scheduled routines.", category: "skill", handler: "native" },
  { id: "simplify", name: "simplify", description: "Review files, find issues, apply fixes.", category: "skill", handler: "sdk", argsHint: "[focus]" },
  { id: "review", name: "review", description: "Review a pull request.", category: "skill", handler: "sdk", argsHint: "[PR]" },
  { id: "security-review", name: "security-review", description: "Security review of pending changes.", category: "skill", handler: "sdk" },
  { id: "ultraplan", name: "ultraplan", description: "Browser-based plan, then execute.", category: "skill", handler: "sdk", argsHint: "<prompt>" },
  { id: "ultrareview", name: "ultrareview", description: "Deep multi-agent code review.", category: "skill", handler: "sdk", argsHint: "[PR]" },
  { id: "autofix-pr", name: "autofix-pr", description: "Watch PR and auto-fix CI failures.", category: "skill", handler: "sdk", argsHint: "[prompt]" },
  { id: "team-onboarding-skill", name: "team-onboarding", description: "Generate team onboarding guide (skill).", category: "skill", handler: "sdk" },

  // ── Experimental / niche ─────────────────────────────────────────────
  { id: "plan", name: "plan", description: "Enter plan mode (read-only planning).", category: "experimental", handler: "native", argsHint: "[description]" },
  { id: "copy", name: "copy", description: "Copy the last response to clipboard.", category: "ui", handler: "native", argsHint: "[N]" },
];

const ALIAS_INDEX: Map<string, SlashCommand> = (() => {
  const m = new Map<string, SlashCommand>();
  for (const c of SLASH_COMMANDS) {
    m.set(c.name, c);
    for (const a of c.aliases ?? []) m.set(a, c);
  }
  return m;
})();

export function findSlashCommand(nameOrAlias: string): SlashCommand | undefined {
  return ALIAS_INDEX.get(nameOrAlias);
}

export type SlashSuggestion = SlashCommand & {
  source: "registry" | "sdk" | "skill" | "mcp";
};

/**
 * A live slash command as reported by the SDK's `supportedCommands()` control
 * request — richer than the bare names in the system:init message. Optional
 * input to {@link mergeSuggestions} so SDK/plugin-provided commands can show
 * real descriptions and argument hints instead of generic placeholder text.
 */
export type SdkSlashCommandInfo = {
  name: string;
  description?: string;
  argumentHint?: string;
  aliases?: string[];
};

/**
 * Merge our curated static registry with what the live SDK reports. Command
 * names come from the system:init `slash_commands` list; when the richer
 * `supportedCommands()` payload is available (`richCommands`), SDK-only
 * entries are upgraded with the SDK's own description + argument hint, and any
 * rich command the init list omitted is still surfaced. SDK-only entries are
 * tagged by source so the picker can surface plugin-bundled commands we don't
 * recognize statically.
 *
 * The curated registry stays the source of truth for commands it defines —
 * notably the `handler` field (native vs. sdk vs. external) that decides
 * whether the web app intercepts a command or forwards it — so a command
 * present in both keeps its registry entry.
 */
export function mergeSuggestions(
  sdkSlashCommands: string[] | undefined,
  sdkSkills: string[] | undefined,
  richCommands?: SdkSlashCommandInfo[] | undefined,
): SlashSuggestion[] {
  const out: SlashSuggestion[] = [];
  const claimed = new Set<string>();

  for (const cmd of SLASH_COMMANDS) {
    out.push({ ...cmd, source: "registry" });
    claimed.add(cmd.name);
    for (const a of cmd.aliases ?? []) claimed.add(a);
  }

  const skillSet = new Set(sdkSkills ?? []);
  const richByName = new Map<string, SdkSlashCommandInfo>();
  for (const rc of richCommands ?? []) {
    if (rc && typeof rc.name === "string") richByName.set(rc.name, rc);
  }

  // Union of names from the init list and the rich payload, so neither source
  // alone limits what the picker shows. Dedupe via the `claimed` set as we go.
  const sdkNames = new Set<string>([...(sdkSlashCommands ?? []), ...richByName.keys()]);

  for (const name of sdkNames) {
    if (claimed.has(name)) continue;
    claimed.add(name);
    const rich = richByName.get(name);
    const isSkill = skillSet.has(name);
    out.push({
      id: `sdk:${name}`,
      name,
      description:
        rich?.description?.trim() ||
        (isSkill ? "Skill provided by the SDK." : "Provided by the SDK."),
      category: isSkill ? "skill" : "experimental",
      handler: "sdk",
      source: isSkill ? "skill" : "sdk",
      ...(rich?.argumentHint?.trim() ? { argsHint: rich.argumentHint.trim() } : {}),
      ...(rich?.aliases && rich.aliases.length > 0 ? { aliases: rich.aliases } : {}),
    });
  }

  // Sort: by category order, then alphabetically.
  const orderIndex = new Map(CATEGORY_ORDER.map((c, i) => [c, i] as const));
  out.sort((a, b) => {
    const ca = orderIndex.get(a.category) ?? 99;
    const cb = orderIndex.get(b.category) ?? 99;
    if (ca !== cb) return ca - cb;
    return a.name.localeCompare(b.name);
  });

  return out;
}
