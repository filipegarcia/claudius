import { describe, expect, test } from "vitest";
import { checkToolBudget, resolveCap, parseEnvCap, toolBudgetKindFor } from "@/lib/shared/tool-budget";

/**
 * CC 2.1.212 parity: session-wide WebSearch-call / subagent-spawn caps.
 * Pure-logic coverage for the gate `Session.canUseTool` (lib/server/session.ts)
 * calls into — see lib/shared/tool-budget.ts for why this is split out.
 */
describe("toolBudgetKindFor", () => {
  test("maps WebSearch to the webSearches budget", () => {
    expect(toolBudgetKindFor("WebSearch")).toBe("webSearches");
  });

  test("maps Task to the subagents budget", () => {
    expect(toolBudgetKindFor("Task")).toBe("subagents");
  });

  // A8 regression — the tool was renamed Task → Agent; the new name must also
  // count, or the subagent cap silently stops enforcing on current CLIs.
  test("maps the renamed Agent tool to the subagents budget", () => {
    expect(toolBudgetKindFor("Agent")).toBe("subagents");
  });

  test("returns null for any other tool name", () => {
    expect(toolBudgetKindFor("Bash")).toBeNull();
    expect(toolBudgetKindFor("Read")).toBeNull();
    expect(toolBudgetKindFor("mcp__claudius_goal__report_goal_achieved")).toBeNull();
    expect(toolBudgetKindFor("")).toBeNull();
  });
});

// A8 — the per-cwd Limits setting wins, else fall back to the upstream env.
describe("parseEnvCap / resolveCap (CLAUDE_CODE_MAX_* fallback)", () => {
  test("parseEnvCap accepts a positive integer, rejects the rest", () => {
    expect(parseEnvCap("200")).toBe(200);
    expect(parseEnvCap(" 5 ")).toBe(5);
    expect(parseEnvCap(undefined)).toBeUndefined();
    expect(parseEnvCap("0")).toBeUndefined();
    expect(parseEnvCap("-3")).toBeUndefined();
    expect(parseEnvCap("abc")).toBeUndefined();
    expect(parseEnvCap("1.5")).toBeUndefined();
  });

  test("a positive Limits setting wins over the env", () => {
    expect(resolveCap(10, "200")).toBe(10);
  });

  test("falls back to the env when the Limits setting is unset or non-positive", () => {
    expect(resolveCap(undefined, "200")).toBe(200);
    expect(resolveCap(0, "200")).toBe(200);
  });

  test("no cap when neither is set", () => {
    expect(resolveCap(undefined, undefined)).toBeUndefined();
  });
});

describe("checkToolBudget", () => {
  test("allows when the cap is undefined (disabled)", () => {
    expect(checkToolBudget("webSearches", undefined, 999)).toEqual({ allowed: true });
  });

  test("allows when the cap is 0 (disabled)", () => {
    expect(checkToolBudget("webSearches", 0, 999)).toEqual({ allowed: true });
  });

  test("allows while used is strictly below the cap", () => {
    expect(checkToolBudget("webSearches", 5, 4)).toEqual({ allowed: true });
    expect(checkToolBudget("subagents", 200, 0)).toEqual({ allowed: true });
  });

  test("denies once used reaches the cap, with a webSearches-specific message", () => {
    const decision = checkToolBudget("webSearches", 5, 5);
    expect(decision.allowed).toBe(false);
    if (!decision.allowed) {
      expect(decision.message).toContain("web search cap reached (5)");
      expect(decision.message).toContain("/clear");
    }
  });

  test("denies once used exceeds the cap, with a subagents-specific message", () => {
    const decision = checkToolBudget("subagents", 3, 10);
    expect(decision.allowed).toBe(false);
    if (!decision.allowed) {
      expect(decision.message).toContain("subagent spawn cap reached (3)");
    }
  });

  test("ignores a negative cap (treated as disabled, same as 0)", () => {
    expect(checkToolBudget("webSearches", -1, 999)).toEqual({ allowed: true });
  });
});
