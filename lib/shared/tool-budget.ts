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

export type ToolBudgetKind = "webSearches" | "subagents";

/** Maps an SDK tool name to the budget it counts against, or `null` if the
 * tool isn't budget-gated. */
export function toolBudgetKindFor(toolName: string): ToolBudgetKind | null {
  if (toolName === "WebSearch") return "webSearches";
  if (toolName === "Task") return "subagents";
  return null;
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
