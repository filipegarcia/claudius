import { describe, expect, test } from "vitest";
import { prettyModelName } from "@/lib/shared/advisor";

/**
 * CC 2.1.261 (E6) — current-model pills (SessionCard, StatusLine) show a
 * friendly name, not a raw Bedrock/Vertex/gateway id. prettyModelName (via
 * canonicalModelId) is what the pills now call.
 */
describe("friendly model names in pills (E6)", () => {
  test("plain claude ids", () => {
    expect(prettyModelName("claude-sonnet-5-5")).toBe("Sonnet 5.5");
    expect(prettyModelName("claude-opus-4-8")).toBe("Opus 4.8");
  });

  test("provider-wrapped ids are unwrapped to the friendly name", () => {
    expect(prettyModelName("us.anthropic.claude-sonnet-5-5")).toBe("Sonnet 5.5");
    expect(prettyModelName("vertex_ai/claude-opus-5-5")).toBe("Opus 5.5");
  });

  test("a bare alias falls back to itself (no crash)", () => {
    expect(prettyModelName("sonnet")).toBe("sonnet");
  });
});
