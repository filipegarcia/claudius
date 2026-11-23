import { describe, expect, test, vi } from "vitest";

const { resolveSettings, matchDeniedModels } = vi.hoisted(() => ({
  resolveSettings: vi.fn(),
  matchDeniedModels: vi.fn(),
}));
vi.mock("@anthropic-ai/claude-agent-sdk", () => ({ resolveSettings, matchDeniedModels }));

import { matchManagedDeniedModels, resolveManagedModelPolicy } from "@/lib/server/managed-model-policy";

describe("managed model policy (SDK 0.3.323)", () => {
  test("carries machinePolicy.didNotLoad through", async () => {
    resolveSettings.mockResolvedValueOnce({
      sources: [{ source: "managed", settings: { deniedModels: ["opus"] } }],
      machinePolicy: { didNotLoad: ["profile"] },
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const p = await resolveManagedModelPolicy("/tmp");
    expect(p.didNotLoad).toEqual(["profile"]);
    expect(p.deniedModels).toEqual(["opus"]);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  test("didNotLoad defaults to false when the SDK omits machinePolicy", async () => {
    resolveSettings.mockResolvedValueOnce({ sources: [] });
    expect((await resolveManagedModelPolicy("/tmp")).didNotLoad).toBe(false);
  });

  test("matchManagedDeniedModels maps the SDK's denied[] and degrades to all-false", async () => {
    matchDeniedModels.mockResolvedValueOnce({ denied: [true, false], warnings: [] });
    expect(await matchManagedDeniedModels(["a", "b"], ["a"])).toEqual([true, false]);
    matchDeniedModels.mockRejectedValueOnce(new Error("boom"));
    expect(await matchManagedDeniedModels(["a", "b"], ["a"])).toEqual([false, false]);
    expect(await matchManagedDeniedModels(["a"], undefined)).toEqual([false]);
  });
});
