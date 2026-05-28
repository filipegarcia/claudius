import { describe, expect, test } from "vitest";
import { mergeSessionDefaults } from "@/lib/shared/session-defaults";

/**
 * Pin the session-create merge rule used by POST /api/sessions:
 *   effective = { ...workspace.defaults, ...request }
 * i.e. an explicit request field wins; the workspace default only fills gaps.
 * A-P2.7 added `agent` (main-thread SDK agent) to this set alongside the
 * existing model / permissionMode.
 */
describe("mergeSessionDefaults", () => {
  test("request fields win over workspace defaults", () => {
    const out = mergeSessionDefaults(
      { model: "claude-opus-4-7", agent: "code-reviewer", permissionMode: "plan" },
      { model: "claude-sonnet-4-6", agent: "explorer", permissionMode: "default" },
    );
    expect(out).toEqual({
      model: "claude-opus-4-7",
      agent: "code-reviewer",
      permissionMode: "plan",
    });
  });

  test("workspace defaults fill gaps when the request omits a field", () => {
    const out = mergeSessionDefaults(
      {},
      { model: "claude-sonnet-4-6", agent: "explorer", permissionMode: "acceptEdits" },
    );
    expect(out).toEqual({
      model: "claude-sonnet-4-6",
      agent: "explorer",
      permissionMode: "acceptEdits",
    });
  });

  test("agent default applies when request has no agent (the A-P2.7 path)", () => {
    const out = mergeSessionDefaults({ model: "claude-opus-4-7" }, { agent: "db-migrator" });
    expect(out.agent).toBe("db-migrator");
    expect(out.model).toBe("claude-opus-4-7");
  });

  test("request agent overrides the workspace default agent", () => {
    const out = mergeSessionDefaults({ agent: "one-off" }, { agent: "workspace-default" });
    expect(out.agent).toBe("one-off");
  });

  test("everything undefined yields all-undefined (no crashes, no injected values)", () => {
    expect(mergeSessionDefaults({}, {})).toEqual({
      model: undefined,
      agent: undefined,
      maxBudgetUsd: undefined,
      permissionMode: undefined,
    });
  });

  test("maxBudgetUsd follows the same precedence (request wins, default fills)", () => {
    expect(mergeSessionDefaults({ maxBudgetUsd: 5 }, { maxBudgetUsd: 20 }).maxBudgetUsd).toBe(5);
    expect(mergeSessionDefaults({}, { maxBudgetUsd: 20 }).maxBudgetUsd).toBe(20);
    // An explicit 0 in the request is preserved (?? only falls through on
    // null/undefined) — lets a caller blank the cap rather than inherit it.
    expect(mergeSessionDefaults({ maxBudgetUsd: 0 }, { maxBudgetUsd: 20 }).maxBudgetUsd).toBe(0);
  });

  test("an explicit empty-string request value is preserved (not treated as absent)", () => {
    // ?? only falls through on null/undefined, so an empty string survives —
    // lets a caller intentionally blank a field rather than inherit the default.
    const out = mergeSessionDefaults({ agent: "" }, { agent: "workspace-default" });
    expect(out.agent).toBe("");
  });
});
