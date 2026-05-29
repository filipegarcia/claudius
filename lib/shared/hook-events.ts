// Mirror of @anthropic-ai/claude-agent-sdk HOOK_EVENTS, with display metadata
// for the /hooks editor.

export const HOOK_EVENT_NAMES = [
  "PreToolUse",
  "PostToolUse",
  "PostToolUseFailure",
  "PostToolBatch",
  "Notification",
  "UserPromptSubmit",
  "UserPromptExpansion",
  "SessionStart",
  "SessionEnd",
  "Stop",
  "StopFailure",
  "SubagentStart",
  "SubagentStop",
  "PreCompact",
  "PostCompact",
  "PermissionRequest",
  "PermissionDenied",
  "Setup",
  "TeammateIdle",
  "TaskCreated",
  "TaskCompleted",
  "Elicitation",
  "ElicitationResult",
  "ConfigChange",
  "WorktreeCreate",
  "WorktreeRemove",
  "InstructionsLoaded",
  "CwdChanged",
  "FileChanged",
  "MessageDisplay",
] as const;

export type HookEvent = (typeof HOOK_EVENT_NAMES)[number];

export type HookCategory = "tool" | "session" | "user" | "agent" | "compaction" | "permission" | "context" | "elicitation" | "fs" | "other";

export type HookEventSpec = {
  name: HookEvent;
  category: HookCategory;
  description: string;
  /** When the matcher field is meaningful (e.g. tool name for PreToolUse). */
  matcherHint?: string;
  /** Whether the hook can block the action (exit code 2, JSON deny). */
  canBlock?: boolean;
};

export const HOOK_EVENTS: HookEventSpec[] = [
  // Tool lifecycle
  { name: "PreToolUse", category: "tool", description: "Before any tool execution. Can deny.", matcherHint: "tool name (e.g. Bash, Read) or regex", canBlock: true },
  { name: "PostToolUse", category: "tool", description: "After successful tool execution.", matcherHint: "tool name or regex" },
  { name: "PostToolUseFailure", category: "tool", description: "After a tool execution that failed.", matcherHint: "tool name or regex" },
  { name: "PostToolBatch", category: "tool", description: "After a batch of tool calls in one assistant turn." },

  // Permissions
  { name: "PermissionRequest", category: "permission", description: "When Claude requests permission to use a tool.", matcherHint: "tool name", canBlock: true },
  { name: "PermissionDenied", category: "permission", description: "After a permission request is denied." },

  // Session lifecycle
  { name: "SessionStart", category: "session", description: "When a session is created or resumed.", matcherHint: "startup | resume | clear | compact" },
  { name: "SessionEnd", category: "session", description: "When a session ends." },
  { name: "Setup", category: "session", description: "First-run setup before a session begins." },
  { name: "Stop", category: "session", description: "When the assistant finishes a turn (idle).", canBlock: true },
  { name: "StopFailure", category: "session", description: "When the assistant fails mid-turn (timeout/error)." },

  // User input
  { name: "UserPromptSubmit", category: "user", description: "When the user submits a prompt. Can rewrite or block.", canBlock: true },
  { name: "UserPromptExpansion", category: "user", description: "When the user prompt is expanded (skills, slash commands)." },

  // Subagents / tasks
  { name: "SubagentStart", category: "agent", description: "When a subagent starts." },
  { name: "SubagentStop", category: "agent", description: "When a subagent finishes." },
  { name: "TaskCreated", category: "agent", description: "When a Task tool spawns a subagent." },
  { name: "TaskCompleted", category: "agent", description: "When a Task tool subagent completes." },
  { name: "TeammateIdle", category: "agent", description: "When a multi-agent teammate goes idle." },

  // Compaction
  { name: "PreCompact", category: "compaction", description: "Before context compaction.", matcherHint: "manual | auto", canBlock: true },
  { name: "PostCompact", category: "compaction", description: "After context compaction completes." },

  // Context / config
  { name: "ConfigChange", category: "context", description: "When settings.json is modified mid-session." },
  { name: "CwdChanged", category: "context", description: "When the working directory changes." },
  { name: "InstructionsLoaded", category: "context", description: "When CLAUDE.md / rules are (re)loaded." },

  // Elicitation (user dialogs)
  { name: "Elicitation", category: "elicitation", description: "When an MCP server requests structured user input." },
  { name: "ElicitationResult", category: "elicitation", description: "When elicitation finishes." },

  // Worktrees / filesystem
  { name: "WorktreeCreate", category: "fs", description: "When a git worktree is created from Claude." },
  { name: "WorktreeRemove", category: "fs", description: "When a git worktree is removed." },
  { name: "FileChanged", category: "fs", description: "When a watched file changes on disk." },

  // Message display
  { name: "MessageDisplay", category: "other", description: "When a message is about to be rendered to the user (last chance to rewrite).", canBlock: false },

  // Other
  { name: "Notification", category: "other", description: "Idle / waiting / permission-requested system notifications." },
];

export const CATEGORY_LABELS: Record<HookCategory, string> = {
  tool: "Tool lifecycle",
  permission: "Permissions",
  session: "Session lifecycle",
  user: "User input",
  agent: "Subagents & tasks",
  compaction: "Compaction",
  context: "Context & config",
  elicitation: "Elicitation",
  fs: "Worktrees & files",
  other: "Other",
};

export const CATEGORY_ORDER: HookCategory[] = [
  "tool",
  "permission",
  "session",
  "user",
  "agent",
  "compaction",
  "context",
  "elicitation",
  "fs",
  "other",
];

// ─── Handler shapes ──────────────────────────────────────────────────────

export type HandlerType = "command" | "http" | "prompt" | "agent" | "mcp_tool";

export type HookHandler =
  | { type: "command"; command: string; timeout?: number; async?: boolean; asyncRewake?: boolean; once?: boolean; if?: string }
  | { type: "http"; url: string; method?: "POST" | "GET"; headers?: Record<string, string>; timeout?: number; async?: boolean; asyncRewake?: boolean; once?: boolean; if?: string }
  | { type: "prompt"; prompt: string; once?: boolean; if?: string }
  | { type: "agent"; agent: string; once?: boolean; if?: string }
  | { type: "mcp_tool"; tool: string; arguments?: Record<string, unknown>; once?: boolean; if?: string };

/** Settings.json hooks shape: { [Event]: [{ matcher?, hooks: HookHandler[] }] } */
export type HookGroup = {
  matcher?: string;
  hooks: HookHandler[];
};

export type HooksMap = Partial<Record<HookEvent, HookGroup[]>>;
