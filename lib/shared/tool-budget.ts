/**
 * CC 2.1.212 parity: session-wide WebSearch-call / subagent-spawn caps —
 * runaway-loop safety nets upstream ships as `CLAUDE_CODE_MAX_WEB_SEARCHES_PER_SESSION`
 * / `CLAUDE_CODE_MAX_SUBAGENTS_PER_SESSION` env vars (both default 200).
 * Claudius reimplements them as a per-cwd Limits setting instead
 * (`lib/server/limits-store.ts`), enforced from `Session.canUseTool`
 * (`lib/server/session.ts`).
 *
 * Pulled out as pure functions — no fs/SDK imports — so the gate logic is
 * unit-testable without spinning up a full `Session` + mocked SDK `query()`.
 */

import { SUBAGENT_TOOL_NAMES } from "./subagent-tool";

export type ToolBudgetKind = "webSearches" | "subagents";

/** Maps an SDK tool name to the budget it counts against, or `null` if the
 * tool isn't budget-gated. */
export function toolBudgetKindFor(toolName: string): ToolBudgetKind | null {
  if (toolName === "WebSearch") return "webSearches";
  // CC 2.1.212/parity-fix — the subagent tool was renamed Task → Agent; match
  // BOTH wire names or the cap silently stops counting spawns under the new
  // "Agent" name (the only name current CLIs emit).
  if ((SUBAGENT_TOOL_NAMES as readonly string[]).includes(toolName)) return "subagents";
  return null;
}

/** Parse a `CLAUDE_CODE_MAX_*_PER_SESSION` env value into a positive integer
 * cap, or `undefined` when unset / non-positive / non-numeric. */
export function parseEnvCap(raw: string | undefined): number | undefined {
  if (raw == null) return undefined;
  const n = Number(raw.trim());
  return Number.isInteger(n) && n > 0 ? n : undefined;
}

/**
 * The effective cap for a budget: the per-cwd Limits value when the user set
 * a positive one, otherwise the upstream `CLAUDE_CODE_MAX_*_PER_SESSION` env
 * fallback (CC's own knob). `undefined` means no cap. The UI setting wins over
 * the env so a user's explicit choice is never overridden by the environment.
 */
export function resolveCap(configured: number | undefined, envRaw: string | undefined): number | undefined {
  if (typeof configured === "number" && configured > 0) return configured;
  return parseEnvCap(envRaw);
}

export type ToolBudgetDecision = { allowed: true } | { allowed: false; message: string };

/**
 * `cap`: the configured limit (0/undefined = disabled, matching
 * `Limits`'s "0/undefined disables" convention). `used`: the count of calls
 * already made in this session for `kind`, BEFORE this call.
 */
export function checkToolBudget(kind: ToolBudgetKind, cap: number | undefined, used: number): ToolBudgetDecision {
  if (cap && cap > 0 && used >= cap) {
    const label = kind === "webSearches" ? "web search" : "subagent spawn";
    return {
      allowed: false,
      message: `Session ${label} cap reached (${cap}). Raise or disable it in Settings → Limits, or run /clear to start a fresh session with a reset count.`,
    };
  }
  return { allowed: true };
}
