import type { PermissionMode } from "@anthropic-ai/claude-agent-sdk";

/**
 * SDK 0.3.283 — one entry of the init message's `plugin_errors` array: a
 * plugin (or `--plugin-dir` / synced directory entry) that hit a load-time
 * failure. A plugin that did not load at all is absent from `plugins[]` and
 * only appears here; a plugin that loaded but lost one component keeps its
 * `plugins[]` row AND gets an entry here.
 *
 * - `plugin` — `name@marketplace`, or the positional `inline[N]` / `synced[N]`
 *   tag for a directory entry that failed before it had a name.
 * - `type` — an open-set category (`path-not-found`, `generic-error`,
 *   `manifest-validation-error`, `dependency-unsatisfied`, `hook-load-failed`,
 *   …). Treat an unrecognized value as a generic failure; never branch on it
 *   in a way that drops the entry.
 * - `message` — display text, author-controlled; render, don't trust.
 * - `path` — present only for a directory/archive entry that failed to load at
 *   all, resolved against the cwd; lets a host pair the error to its own mount.
 * - `managedLock` — SDK 0.3.325 `managed_lock`: present only when a
 *   managed-settings `enabledPlugins` entry dropped this directory copy.
 *   `pluginEnabled` true: the entry turns that plugin on and this copy is not
 *   accepted as it; false: the entry turns it off, so no directory copy of the
 *   name may load. `name` / `marketplace` are byte-exact author text — clean
 *   and bound them before display (see `describeManagedLock`).
 */
export type PluginManagedLock = {
  pluginEnabled: boolean;
  name: string;
  marketplace?: string;
};

export type PluginLoadError = {
  plugin: string;
  type: string;
  message: string;
  path?: string;
  managedLock?: PluginManagedLock;
};

const MANAGED_LOCK_FIELD_MAX = 120;

/** Strip control + bidi-override characters and bound the length (SDK asks hosts to). */
function cleanLockText(s: string): string {
  const cleaned = s.replace(/[\u0000-\u001f\u007f-\u009f\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, "");
  return cleaned.length > MANAGED_LOCK_FIELD_MAX
    ? `${cleaned.slice(0, MANAGED_LOCK_FIELD_MAX)}…`
    : cleaned;
}

/**
 * One-line explanation of why a managed-settings `enabledPlugins` entry
 * dropped a plugin copy (SDK 0.3.325 `managed_lock`).
 */
export function describeManagedLock(lock: PluginManagedLock): string {
  const name = cleanLockText(lock.name);
  const id = lock.marketplace ? `${name}@${cleanLockText(lock.marketplace)}` : name;
  return lock.pluginEnabled
    ? `Managed settings enable ${id}, so this local copy is not accepted as that plugin.`
    : `Managed settings turn ${id} off, so no local copy of that plugin may load.`;
}

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
  /**
   * SDK 0.3.283 — plugins that hit a load-time error this session. The SDK
   * omits the key entirely when every plugin loaded cleanly, so an empty
   * array here means "no errors reported" (and a Remote Control worker always
   * omits it — but Claudius runs local sessions, where absence means clean).
   * Surfaced on the Plugins page so a silently-skipped plugin is visible
   * instead of just missing from the list.
   */
  pluginErrors: PluginLoadError[];
};

function stringArray(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}

function optionalString(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

/**
 * Normalize the init message's `plugin_errors` into a defensive shape. Drops
 * any row missing the required `plugin`/`type`/`message` strings rather than
 * throwing — the parser's schema-drift-tolerant contract (see below) applies
 * here too. Absent / non-array input collapses to `[]`.
 */
function parseManagedLock(v: unknown): PluginManagedLock | undefined {
  if (!v || typeof v !== "object") return undefined;
  const l = v as Record<string, unknown>;
  const name = optionalString(l.name);
  if (typeof l.plugin_enabled !== "boolean" || !name) return undefined;
  const marketplace = optionalString(l.marketplace);
  return {
    pluginEnabled: l.plugin_enabled,
    name,
    ...(marketplace ? { marketplace } : {}),
  };
}

function pluginErrorArray(v: unknown): PluginLoadError[] {
  if (!Array.isArray(v)) return [];
  const out: PluginLoadError[] = [];
  for (const raw of v) {
    if (!raw || typeof raw !== "object") continue;
    const e = raw as Record<string, unknown>;
    const plugin = optionalString(e.plugin);
    const type = optionalString(e.type);
    const message = optionalString(e.message);
    if (!plugin || !type || !message) continue;
    const path = optionalString(e.path);
    const managedLock = parseManagedLock(e.managed_lock);
    out.push({
      plugin,
      type,
      message,
      ...(path ? { path } : {}),
      ...(managedLock ? { managedLock } : {}),
    });
  }
  return out;
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
    pluginErrors: pluginErrorArray(m.plugin_errors),
  };
}
