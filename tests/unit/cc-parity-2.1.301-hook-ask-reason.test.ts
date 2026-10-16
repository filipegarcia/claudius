import { describe, expect, test } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { PermissionPrompt } from "@/components/chat/PermissionPrompt";
import type { PermissionRequestEvent } from "@/lib/shared/events";
import { HOOK_ASK_REASON_MAX, hookAsk, stripAnsi } from "@/lib/shared/hook-ask";

/**
 * CC 2.1.301 — the permission prompt for a hook's `ask` decision says a hook
 * raised it (Claudius used to drop `decisionReason` entirely).
 */
describe("hookAsk", () => {
  test("marks hook asks and carries the reason when there is one", () => {
    expect(hookAsk("Production deploys need a human", "hook")).toEqual({
      reason: "Production deploys need a human",
    });
    expect(hookAsk("Matched rule Bash(rm:*)", "rule")).toBeUndefined();
    expect(hookAsk("anything", undefined)).toBeUndefined();
  });

  test("a hook ask without a reason is still a hook ask", () => {
    expect(hookAsk(undefined, "hook")).toEqual({});
    expect(hookAsk("   ", "hook")).toEqual({});
    expect(hookAsk("\u001b[0m", "hook")).toEqual({});
  });

  test("strips ANSI colour and OSC sequences", () => {
    expect(stripAnsi("\u001b[31mred\u001b[0m text")).toBe("red text");
    expect(stripAnsi("\u001b]8;;https://x\u0007link\u001b]8;;\u0007")).toBe("link");
    expect(hookAsk("\u001b[1mguard:\u001b[22m confirm", "hook")?.reason).toBe("guard: confirm");
  });

  test("caps a runaway reason", () => {
    const out = hookAsk("x".repeat(5000), "hook")!.reason!;
    expect(out.length).toBe(HOOK_ASK_REASON_MAX);
    expect(out.endsWith("…")).toBe(true);
  });
});

describe("permission prompt hook row", () => {
  const base: PermissionRequestEvent = {
    type: "permission_request",
    requestId: "r1",
    toolName: "Bash",
    toolUseId: "t1",
    input: { command: "ls" },
  };
  const render = (extra: Partial<PermissionRequestEvent>) =>
    renderToStaticMarkup(createElement(PermissionPrompt, { request: { ...base, ...extra }, onResolve: () => {} }));

  test("shows the hook's reason", () => {
    const html = render({ hookAsk: { reason: "deploy-guard: confirm" } });
    expect(html).toContain('data-testid="permission-hook-reason"');
    expect(html).toContain("Asked by a hook:");
    expect(html).toContain("deploy-guard: confirm");
  });

  test("still says a hook asked when it gave no reason", () => {
    const html = render({ hookAsk: {} });
    expect(html).toContain('data-testid="permission-hook-reason"');
    expect(html).toContain("Asked by a hook");
    expect(html).not.toContain("Asked by a hook:");
  });

  test("an ordinary ask has no hook row", () => {
    expect(render({})).not.toContain("permission-hook-reason");
  });
});
