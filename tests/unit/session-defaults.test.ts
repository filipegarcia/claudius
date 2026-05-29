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
      taskBudgetTokens: undefined,
      maxTurns: undefined,
      fallbackModel: undefined,
      sandboxEnabled: undefined,
      enable1mContext: undefined,
      persistSession: undefined,
      additionalDirectories: undefined,
      systemPromptAppend: undefined,
      planModeInstructions: undefined,
      permissionMode: undefined,
    });
  });

  test("taskBudgetTokens + maxTurns follow the same precedence (request wins, default fills)", () => {
    expect(mergeSessionDefaults({ taskBudgetTokens: 100 }, { taskBudgetTokens: 200 }).taskBudgetTokens).toBe(100);
    expect(mergeSessionDefaults({}, { taskBudgetTokens: 200 }).taskBudgetTokens).toBe(200);
    expect(mergeSessionDefaults({ maxTurns: 5 }, { maxTurns: 9 }).maxTurns).toBe(5);
    expect(mergeSessionDefaults({}, { maxTurns: 9 }).maxTurns).toBe(9);
  });

  test("persistSession follows the same precedence; explicit false survives", () => {
    expect(mergeSessionDefaults({ persistSession: false }, { persistSession: true }).persistSession).toBe(false);
    expect(mergeSessionDefaults({}, { persistSession: false }).persistSession).toBe(false);
    expect(mergeSessionDefaults({}, {}).persistSession).toBeUndefined();
  });

  test("additionalDirectories follows the same precedence (request wins, default fills)", () => {
    expect(
      mergeSessionDefaults({ additionalDirectories: ["/a"] }, { additionalDirectories: ["/b"] })
        .additionalDirectories,
    ).toEqual(["/a"]);
    expect(mergeSessionDefaults({}, { additionalDirectories: ["/b"] }).additionalDirectories).toEqual([
      "/b",
    ]);
  });

  test("planModeInstructions follows the same precedence (request wins, default fills)", () => {
    expect(
      mergeSessionDefaults({ planModeInstructions: "req" }, { planModeInstructions: "def" })
        .planModeInstructions,
    ).toBe("req");
    expect(mergeSessionDefaults({}, { planModeInstructions: "def" }).planModeInstructions).toBe("def");
  });

  test("systemPromptAppend follows the same precedence (request wins, default fills)", () => {
    expect(
      mergeSessionDefaults({ systemPromptAppend: "use TS" }, { systemPromptAppend: "use JS" })
        .systemPromptAppend,
    ).toBe("use TS");
    expect(mergeSessionDefaults({}, { systemPromptAppend: "house style" }).systemPromptAppend).toBe(
      "house style",
    );
  });

  test("enable1mContext follows the same precedence (request wins, default fills)", () => {
    expect(mergeSessionDefaults({ enable1mContext: true }, { enable1mContext: false }).enable1mContext).toBe(true);
    expect(mergeSessionDefaults({}, { enable1mContext: true }).enable1mContext).toBe(true);
    expect(mergeSessionDefaults({ enable1mContext: false }, { enable1mContext: true }).enable1mContext).toBe(false);
  });

  test("sandboxEnabled follows the same precedence (request wins, default fills)", () => {
    // request:true wins over default:false
    expect(mergeSessionDefaults({ sandboxEnabled: true }, { sandboxEnabled: false }).sandboxEnabled).toBe(true);
    // default fills when omitted
    expect(mergeSessionDefaults({}, { sandboxEnabled: true }).sandboxEnabled).toBe(true);
    // explicit request:false overrides default:true — ?? only falls through on
    // null/undefined, so a deliberate disable survives.
    expect(mergeSessionDefaults({ sandboxEnabled: false }, { sandboxEnabled: true }).sandboxEnabled).toBe(false);
  });

  test("fallbackModel follows the same precedence (request wins, default fills)", () => {
    expect(
      mergeSessionDefaults({ fallbackModel: "claude-haiku-4-5" }, { fallbackModel: "claude-sonnet-4-6" })
        .fallbackModel,
    ).toBe("claude-haiku-4-5");
    expect(mergeSessionDefaults({}, { fallbackModel: "claude-sonnet-4-6" }).fallbackModel).toBe(
      "claude-sonnet-4-6",
    );
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
