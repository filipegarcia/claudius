import { describe, expect, test } from "vitest";
import { fastModeLabel } from "@/lib/shared/fast-mode";

/**
 * CC 2.1.321 parity — the fast mode label names the current model when it
 * supports fast mode ("Fast mode (Opus 5.5)").
 */
describe("fastModeLabel", () => {
  test("names the resolved model", () => {
    expect(fastModeLabel("claude-opus-5-5")).toBe("Fast mode (Opus 5.5)");
    expect(fastModeLabel("claude-fable-5-2")).toBe("Fast mode (Fable 5.2)");
    expect(fastModeLabel("claude-opus-4-8")).toBe("Fast mode (Opus 4.8)");
    expect(fastModeLabel("us.anthropic.claude-opus-5-5-v1:0")).toBe("Fast mode (Opus 5.5)");
    expect(fastModeLabel("claude-opus-5-5[1m]")).toBe("Fast mode (Opus 5.5)");
  });

  test("keeps the plain label when the id isn't a known model", () => {
    for (const id of ["opus", "default", "my-gateway-model", "", null, undefined]) {
      expect(fastModeLabel(id)).toBe("Fast mode");
    }
  });
});
