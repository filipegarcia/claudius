import type { PermissionMode } from "@anthropic-ai/claude-agent-sdk";

/**
 * Normalized view of the SDK `system:init` message (SDKSystemMessage with
 * subtype "init"). The init message announces, for the freshly-started
 * session, the tools, slash commands, **subagents**, skills, cwd, model, and
 * permission mode the SDK loaded.
 *
 * The client threads these into session state for early paint — the agent /
 * skill / command overlays render off this before any per-feature SDK control
 * request (`supportedAgents()`, `supportedCommands()`) resolves.
 *
 * `agents` is the list of subagent *names* the SDK reports at init. It's the
 * cheap, always-present signal; the richer `AgentInfo[]` (with descriptions
 * and models) comes from `supportedAgents()` on demand.
 */
export type InitInfo = {
  tools: string[];
  slashCommands: string[];
  agents: string[];
  skills: string[];
  cwd?: string;
  model?: string;
  permissionMode?: PermissionMode;
  claudeCodeVersion?: string;
  /**
   * Whether the SDK has the server-side advisor tool registered for this
   * session — derived from `tools.includes("advisor")`. The init message
   * doesn't carry the *model id* for the advisor (the SDK keeps that to
   * itself), but the presence of the `advisor` tool is a reliable
   * "advisor is on" signal we can use to seed the SessionCard badge
   * when our `GET /api/sessions/[id]/advisor` fallback fails (stale
   * server build, profile-dir divergence, settings.json read error).
   */
  advisorActive: boolean;
  /**
   * SDK 0.3.219 — the init message's `fast_mode_state` is now trustworthy
   * even right after a `/model` switch (previously it could report the
   * spawn-time model's state instead of the just-switched-to model's). We
   * start reading it here so the StatusLine's `⚡` chip and fast-mode
   * notice can paint their initial state from session start instead of
   * waiting for the first `result` message.
   */
  fastModeState?: "off" | "cooldown" | "on";
  /**
   * SDK 0.3.219 — why fast mode can't serve right now (absent when nothing
   * blocks it). Kept as a raw string, not a strict union: the SDK's reason
   * list is an open set that may grow, and this parser is tolerant of
   * schema drift by contract (see below) — an unrecognized reason should
   * fall back to neutral copy at the display layer
   * (`fastModeDisabledReasonLabel` in `lib/shared/fast-mode.ts`), not get
   * silently dropped here.
   */
  fastModeDisabledReason?: string;
  /**
   * SDK 0.3.234 — the session's *applied* effort level: the value the
   * session will actually send on its next request, after env overrides,
   * session state, org caps, and model-support downgrades. `null` means no
   * effort parameter will be sent (a model without effort support, or
   * CLAUDE_CODE_EFFORT_LEVEL unset). `undefined` means the field wasn't on
   * the message at all — an older CLI that predates it, or a host that
   * doesn't publish it. Only the three literal-level case corrects the
   * client's optimistic effort mirror (see `effort` state in use-session.ts);
   * `null`/absent leave the mirror as-is, since "no effort param" doesn't
   * necessarily mean the UI's "auto" state is wrong.
   */
  effort?: "low" | "medium" | "high" | "xhigh" | "max" | null;
};

function stringArray(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}

function optionalString(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

/**
 * Extract the init fields from a raw SDK `system:init` message into a stable,
 * defensively-typed shape. Tolerant of schema drift — unknown / missing
 * fields collapse to empty arrays or `undefined` rather than throwing, so an
 * SDK upgrade that renames a sibling field can't crash the session reducer.
 *
 * Pass the raw message object (the client receives it verbatim inside the
 * `{ type: "sdk", message }` SSE event); only the init-relevant keys are read.
 */
export function parseInitSystemMessage(msg: unknown): InitInfo {
  const m = (msg ?? {}) as Record<string, unknown>;
  const tools = stringArray(m.tools);
  return {
    tools,
    slashCommands: stringArray(m.slash_commands),
    agents: stringArray(m.agents),
    skills: stringArray(m.skills),
    cwd: optionalString(m.cwd),
    model: optionalString(m.model),
    permissionMode: optionalString(m.permissionMode) as PermissionMode | undefined,
    claudeCodeVersion: optionalString(m.claude_code_version),
    // The SDK registers the `advisor` tool only when an advisorModel is
    // configured. Reliable "is the advisor on" signal — see InitInfo doc.
    advisorActive: tools.includes("advisor"),
    fastModeState: (["off", "cooldown", "on"] as const).includes(
      m.fast_mode_state as "off" | "cooldown" | "on",
    )
      ? (m.fast_mode_state as "off" | "cooldown" | "on")
      : undefined,
    fastModeDisabledReason: optionalString(m.fast_mode_disabled_reason),
    effort: (["low", "medium", "high", "xhigh", "max"] as const).includes(
      m.effort as "low" | "medium" | "high" | "xhigh" | "max",
    )
      ? (m.effort as "low" | "medium" | "high" | "xhigh" | "max")
      : m.effort === null
        ? null
        : undefined,
  };
}
