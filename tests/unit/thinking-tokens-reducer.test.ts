import { describe, expect, test } from "vitest";
import { applyThinkingTokensEstimate } from "@/lib/client/idle-reconcile";
import type { ToolHistoryEntry } from "@/lib/client/types";

/**
 * Unit tests for the SDKThinkingTokensMessage reducer helper.
 *
 * SDKThinkingTokensMessage (added in 0.3.153) is a system event emitted during
 * the redacted-thinking phase that carries a live estimate of how many tokens
 * the model has used for thinking. `applyThinkingTokensEstimate` attaches the
 * estimate to the most-recent open thinking row in the Activity rail.
 */

function thinkingEntry(overrides?: Partial<ToolHistoryEntry>): ToolHistoryEntry {
  return {
    toolUseId: "thinking:msg-1:0",
    toolName: "Thinking",
    startedAt: 1000,
    kind: "thinking",
    ...overrides,
  };
}

function toolEntry(overrides?: Partial<ToolHistoryEntry>): ToolHistoryEntry {
  return {
    toolUseId: "tool-use-id-1",
    toolName: "Read",
    primaryArg: "src/foo.ts",
    startedAt: 900,
    kind: "tool",
    ...overrides,
  };
}

describe("applyThinkingTokensEstimate", () => {
  test("sets estimatedThinkingTokens on the most-recent open thinking row", () => {
    const entries: ToolHistoryEntry[] = [thinkingEntry()];
    const result = applyThinkingTokensEstimate(entries, 1234);
    expect(result[0].estimatedThinkingTokens).toBe(1234);
  });

  test("updates existing estimatedThinkingTokens with the latest value", () => {
    const entries: ToolHistoryEntry[] = [thinkingEntry({ estimatedThinkingTokens: 500 })];
    const result = applyThinkingTokensEstimate(entries, 800);
    expect(result[0].estimatedThinkingTokens).toBe(800);
  });

  test("targets only the most-recent open thinking row when multiple exist", () => {
    const entries: ToolHistoryEntry[] = [
      thinkingEntry({ toolUseId: "thinking:msg-1:0", startedAt: 800 }),
      toolEntry(),
      thinkingEntry({ toolUseId: "thinking:msg-2:0", startedAt: 1200 }),
    ];
    const result = applyThinkingTokensEstimate(entries, 999);
    expect(result[0].estimatedThinkingTokens).toBeUndefined();
    expect(result[2].estimatedThinkingTokens).toBe(999);
  });

  test("skips done thinking rows — they belong to a completed message", () => {
    const entries: ToolHistoryEntry[] = [
      thinkingEntry({ done: true, endedAt: 2000 }),
    ];
    const result = applyThinkingTokensEstimate(entries, 500);
    expect(result).toBe(entries); // same reference = no change
    expect(result[0].estimatedThinkingTokens).toBeUndefined();
  });

  test("returns the same reference when no open thinking row is found", () => {
    const entries: ToolHistoryEntry[] = [toolEntry(), toolEntry({ toolUseId: "t2" })];
    const result = applyThinkingTokensEstimate(entries, 100);
    expect(result).toBe(entries);
  });

  test("returns the same reference when the list is empty", () => {
    const entries: ToolHistoryEntry[] = [];
    const result = applyThinkingTokensEstimate(entries, 100);
    expect(result).toBe(entries);
  });

  test("does not mutate the original array", () => {
    const original: ToolHistoryEntry[] = [thinkingEntry()];
    const frozen = [...original];
    applyThinkingTokensEstimate(original, 42);
    expect(original[0]).toEqual(frozen[0]);
  });

  test("ignores regular (non-thinking) tool rows", () => {
    const entries: ToolHistoryEntry[] = [
      toolEntry(),
      toolEntry({ toolUseId: "t2", toolName: "Edit" }),
    ];
    const result = applyThinkingTokensEstimate(entries, 77);
    expect(result).toBe(entries);
  });
});
