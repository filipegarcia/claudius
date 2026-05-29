// Rotating "did you know" tips shown under the working spinner — the
// browser-side analog of the Claude Code CLI spinner tips. The SDK only
// renders its spinner (and `spinnerTipsOverride`) in a terminal, never in
// Claudius's programmatic use, so we surface our own Claudius-specific tips.
//
// This is the single source of truth for tip content. The shape is kept
// deliberately small and serializable so a backend/SDK-driven feed could
// later replace {@link DEFAULT_TIPS} without touching the renderer.

export type Tip = {
  /** Stable id — used as a React key and for de-duping a backend feed. */
  id: string;
  /** The tip body. One short line; the renderer truncates rather than wraps. */
  text: string;
  /**
   * Optional slash command surfaced as a clickable affordance, *without* the
   * leading slash (e.g. `"skills"` renders and runs as `/skills`). Every value
   * here must resolve to a real command in `lib/shared/slash-commands.ts` whose
   * action is non-destructive (navigation/overlay), since a tip can be clicked
   * mid-turn.
   */
  command?: string;
};

// Each command below maps to a native, non-destructive handler in the chat
// page's `runNative` dispatcher (navigation or an overlay) — safe to invoke
// while the agent is mid-turn.
export const DEFAULT_TIPS: Tip[] = [
  {
    id: "agents",
    text: "Define specialist subagents — reviewers, planners, debuggers — each with their own prompt, tools, and model.",
    command: "agents",
  },
  {
    id: "mcp",
    text: "Plug in tools from anywhere over the Model Context Protocol — they show up to Claude automatically.",
    command: "mcp",
  },
  {
    id: "skills",
    text: "Skills are short, opinionated playbooks Claude calls up when the moment is right.",
    command: "skills",
  },
  {
    id: "cost",
    text: "See exactly where your tokens go — spend broken down per session, per model, per day.",
    command: "cost",
  },
  {
    id: "schedule",
    text: "Run the agent on a cron schedule — daily standups, deploy checks, log triage, without you there.",
    command: "schedule",
  },
  {
    id: "memory",
    text: "Claude keeps notes that persist across sessions, so you don't re-explain the same context.",
    command: "memory",
  },
  {
    id: "context",
    text: "Watch how full your context window is — and compact it before it overflows.",
    command: "context",
  },
  {
    id: "goal",
    text: "Set a goal for this session and Claude tracks it until it's achieved.",
    command: "goal",
  },
  {
    id: "files",
    text: "Browse the exact project tree the agent sees — with quick file previews.",
    command: "files",
  },
  {
    id: "hooks",
    text: "Run shell commands at lifecycle events — guardrails, notifications, auto-formatting.",
    command: "hooks",
  },
  {
    id: "plugins",
    text: "Install community plugins from any marketplace you trust — skills, agents, MCP servers, and hooks.",
    command: "plugin",
  },
  {
    id: "keybindings",
    text: "Rebind any shortcut — including chords — to match the muscle memory you already have.",
    command: "keybindings",
  },
  {
    id: "help",
    text: "Lost? Open the full list of slash commands and keyboard shortcuts.",
    command: "help",
  },
];

/**
 * The tips the server surfaces to a session's clients (broadcast as a `tips`
 * SSE event). This is the single injection point for backend/SDK-driven tips:
 * today it returns the default catalog, optionally gated to the slash commands
 * a given session actually supports, so a tip never points at a command that
 * isn't available on this surface. A future backend feed (e.g. "new feature"
 * announcements) appends here without touching the renderer.
 *
 * Pure and server-agnostic so it stays unit-testable. Command-less tips always
 * pass; command tips pass only when their command is available (when no
 * availability list is supplied, nothing is gated).
 */
export function selectTips(opts?: { availableCommands?: readonly string[] }): Tip[] {
  const avail = opts?.availableCommands;
  if (!avail) return DEFAULT_TIPS;
  const set = new Set(avail);
  return DEFAULT_TIPS.filter((t) => !t.command || set.has(t.command));
}

/**
 * Advance the rotation index, wrapping at the end. Pure so it can be unit
 * tested without driving a React interval. Guards against an empty list and a
 * non-finite/out-of-range current index so a bad backend feed can't crash the
 * spinner.
 */
export function nextTipIndex(current: number, count: number): number {
  if (count <= 0) return 0;
  const safe = Number.isFinite(current) ? Math.floor(current) : 0;
  return ((safe % count) + count + 1) % count;
}
