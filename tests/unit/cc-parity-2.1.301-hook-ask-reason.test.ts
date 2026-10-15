import { describe, expect, test } from "vitest";
import { HOOK_ASK_REASON_MAX, hookAskReason, stripAnsi } from "@/lib/shared/hook-ask";

/**
 * CC 2.1.301 — the permission prompt for a hook's `ask` decision says a hook
 * raised it (Claudius used to drop `decisionReason` entirely).
 */
describe("hookAskReason", () => {
  test("returns the reason only for hook asks", () => {
    expect(hookAskReason("Production deploys need a human", "hook")).toBe("Production deploys need a human");
    expect(hookAskReason("Matched rule Bash(rm:*)", "rule")).toBeUndefined();
    expect(hookAskReason("anything", undefined)).toBeUndefined();
    expect(hookAskReason(undefined, "hook")).toBeUndefined();
    expect(hookAskReason("   ", "hook")).toBeUndefined();
  });

  test("strips ANSI colour and OSC sequences", () => {
    expect(stripAnsi("\u001b[31mred\u001b[0m text")).toBe("red text");
    expect(stripAnsi("\u001b]8;;https://x\u0007link\u001b]8;;\u0007")).toBe("link");
    expect(hookAskReason("\u001b[1mguard:\u001b[22m confirm", "hook")).toBe("guard: confirm");
  });

  test("caps a runaway reason", () => {
    const out = hookAskReason("x".repeat(5000), "hook")!;
    expect(out.length).toBe(HOOK_ASK_REASON_MAX);
    expect(out.endsWith("…")).toBe(true);
  });
});
