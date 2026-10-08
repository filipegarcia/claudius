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
  "PreModelSwitch",
  "PostModelSwitch",
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
  "DirectoryAdded",
  "MessageDisplay",
] as const;

export type HookEvent = (typeof HOOK_EVENT_NAMES)[number];

export type HookCategory = "tool" | "session" | "user" | "agent" | "compaction" | "model" | "permission" | "context" | "elicitation" | "fs" | "other";

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
  { name: "PostToolUse", category: "tool", description: "After successful tool execution. Can assert classifierContext to inform the auto-mode permission classifier.", matcherHint: "tool name or regex" },
  { name: "PostToolUseFailure", category: "tool", description: "After a tool execution that failed.", matcherHint: "tool name or regex" },
  { name: "PostToolBatch", category: "tool", description: "After a batch of tool calls in one assistant turn." },

  // Permissions
  { name: "PermissionRequest", category: "permission", description: "When Claude requests permission to use a tool.", matcherHint: "tool name", canBlock: true },
  { name: "PermissionDenied", category: "permission", description: "After a permission request is denied." },

  // Session lifecycle
  { name: "SessionStart", category: "session", description: "When a session is created or resumed.", matcherHint: "startup | resume | clear | compact | fork" },
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

  // Model switching (SDK 0.3.251)
  { name: "PreModelSwitch", category: "model", description: "Before the model changes mid-session (command, picker, or sdk). Can allow, deny, or ask for confirmation — a headless session refuses when asked.", matcherHint: "command | picker | sdk", canBlock: true },
  { name: "PostModelSwitch", category: "model", description: "After the model changes mid-session (command, picker, sdk, automatic fallback, or resume). Can inject additionalContext for the new model's next request.", matcherHint: "command | picker | sdk | auto | resume" },

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
  { name: "DirectoryAdded", category: "fs", description: "When a new working directory is registered mid-session (/add-dir or the SDK's register_repo_root control request).", matcherHint: "slash_command | register_repo_root" },

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
  model: "Model switching",
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
  "model",
  "context",
  "elicitation",
  "fs",
  "other",
];

// ─── Handler shapes ──────────────────────────────────────────────────────

export type HandlerType = "command" | "http" | "prompt" | "agent" | "mcp_tool";

/**
 * CC 2.1.271 — hook events that keep a durable transcript pill. These are the
 * one-time lifecycle hooks (always emitted, low volume). Every other hook event
 * (PreToolUse, PostToolUse, UserPromptSubmit, …) streams with `includeHookEvents`
 * and is shown as a transient "Running <event> hook · Ns" status-line indicator
 * instead, to avoid flooding the transcript with a pill per tool call.
 */
export const HOOK_PILL_EVENTS: ReadonlySet<string> = new Set([
  "SessionStart",
  "Setup",
  "SubagentStart",
  "SessionEnd",
]);

/** Whether a hook event's completion gets a durable transcript pill: the
 * one-time lifecycle hooks always do, and ANY hook that failed does (so the
 * error stays visible); a routine success of a frequent hook does not. */
export function hookEventGetsDurablePill(event: string, failed: boolean): boolean {
  return failed || HOOK_PILL_EVENTS.has(event);
}

/**
 * CC 2.1.295 parity — `onFailure: "block"` on `command` and `http` hooks makes
 * the hook fail-closed: if it can't start, times out, or exits with an
 * unexpected code, the engine BLOCKS the action instead of letting it through.
 * Absent (the default) keeps the historical fail-open behaviour. Only these two
 * handler types accept it.
 */
export type HookOnFailure = "block";

export type HookHandler =
  | { type: "command"; command: string; timeout?: number; async?: boolean; asyncRewake?: boolean; once?: boolean; if?: string; onFailure?: HookOnFailure }
  | { type: "http"; url: string; method?: "POST" | "GET"; headers?: Record<string, string>; timeout?: number; async?: boolean; asyncRewake?: boolean; once?: boolean; if?: string; onFailure?: HookOnFailure }
  | { type: "prompt"; prompt: string; continueOnBlock?: boolean; once?: boolean; if?: string }
  | { type: "agent"; agent: string; once?: boolean; if?: string }
  | { type: "mcp_tool"; tool: string; arguments?: Record<string, unknown>; once?: boolean; if?: string };

/**
 * CC 2.1.280 — the engine refuses to RUN an `agent`-type hook on these events
 * (it fails the hook and points the author at `command`/`http` instead). The
 * `PermissionRequest` case is a safety boundary: a sub-agent deciding whether
 * to grant a permission is a privilege-escalation shape. The editor mirrors
 * this — it neither offers nor saves an `agent` handler on such an event.
 */
export const AGENT_HANDLER_DISALLOWED_EVENTS: readonly HookEvent[] = ["PermissionRequest"];

/** Whether an `agent`-type hook handler may be attached to `event`. */
export function agentHandlerAllowed(event: HookEvent): boolean {
  return !AGENT_HANDLER_DISALLOWED_EVENTS.includes(event);
}

/** CC 2.1.295 parity — handler types that accept `onFailure: "block"`. */
export function handlerSupportsOnFailure(type: HandlerType): type is "command" | "http" {
  return type === "command" || type === "http";
}

/** Whether a saved handler is configured fail-closed (`onFailure: "block"`). */
export function handlerBlocksOnFailure(h: HookHandler): boolean {
  return handlerSupportsOnFailure(h.type) && "onFailure" in h && h.onFailure === "block";
}

/**
 * CC 2.1.295 parity — events on which the engine ignores `onFailure: "block"`
 * (it logs `not blocking (onFailure: "block" is ignored on <event>)` and lets
 * the action through). Mirrors the bundled 2.1.295 CLI and the SDK's
 * `onFailure` JSDoc: "Ignored for async hooks and on Stop, SubagentStop,
 * TaskCompleted and TeammateIdle".
 */
export const ON_FAILURE_IGNORED_EVENTS: readonly HookEvent[] = [
  "Stop",
  "SubagentStop",
  "TaskCompleted",
  "TeammateIdle",
];

/** Why a saved/drafted `onFailure: "block"` has no effect. */
export type OnFailureIgnoredReason = "async" | "asyncRewake" | "event";

/**
 * CC 2.1.295 parity — why `onFailure: "block"` would be ignored by the engine,
 * or `null` when it takes effect (or isn't set). Two cases, both read from the
 * bundled 2.1.295 CLI:
 * - a background **command** hook (`async` / `asyncRewake`): the action has
 *   already proceeded by the time the hook fails. The engine only applies this
 *   to `command` handlers — an `http` handler's block holds regardless.
 * - an event in {@link ON_FAILURE_IGNORED_EVENTS}.
 * The editor shows a hint for these combos but still lets them save (the engine
 * ignores the key rather than rejecting the hook).
 */
export function onFailureBlockIgnoredReason(opts: {
  type: HandlerType;
  event?: HookEvent;
  onFailure?: HookOnFailure;
  async?: boolean;
  asyncRewake?: boolean;
}): OnFailureIgnoredReason | null {
  if (opts.onFailure !== "block" || !handlerSupportsOnFailure(opts.type)) return null;
  if (opts.type === "command") {
    if (opts.async) return "async";
    if (opts.asyncRewake) return "asyncRewake";
  }
  if (opts.event && ON_FAILURE_IGNORED_EVENTS.includes(opts.event)) return "event";
  return null;
}

/** Settings.json hooks shape: { [Event]: [{ matcher?, hooks: HookHandler[] }] } */
export type HookGroup = {
  matcher?: string;
  hooks: HookHandler[];
};

export type HooksMap = Partial<Record<HookEvent, HookGroup[]>>;
