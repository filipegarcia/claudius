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
  };
}
