import { describe, expect, test } from "vitest";
import { applyBashAutoBackground } from "@/lib/client/use-session";
import type { BackgroundBash } from "@/lib/client/types";

/**
 * SDK 0.3.210 — `BashOutput` gained `timedOutAfterMs`, set when a command
 * hits its timeout and is auto-backgrounded, delivered on the SDK message's
 * `tool_use_result` field (a sibling of `message.content`). Before this,
 * Claudius only tracked a background shell when the tool_use input carried
 * `run_in_background: true` — a command that ran in the foreground and
 * later timed out was invisible. `applyBashAutoBackground` closes that gap.
 */
describe("applyBashAutoBackground", () => {
  test("no tool_use_result is a no-op", () => {
    const prev: Record<string, BackgroundBash> = {};
    const next = applyBashAutoBackground(prev, {
      toolUseId: "toolu_1",
      command: "sleep 999",
      toolUseResult: undefined,
      startedAt: 100,
    });
    expect(next).toBe(prev);
  });

  test("tool_use_result with neither backgroundTaskId nor timedOutAfterMs is a no-op", () => {
    const prev: Record<string, BackgroundBash> = {};
    const next = applyBashAutoBackground(prev, {
      toolUseId: "toolu_1",
      command: "echo hi",
      toolUseResult: {},
      startedAt: 100,
    });
    expect(next).toBe(prev);
  });

  test("creates a new entry for a foreground command auto-backgrounded on timeout", () => {
    const prev: Record<string, BackgroundBash> = {};
    const next = applyBashAutoBackground(prev, {
      toolUseId: "toolu_1",
      command: "sleep 999",
      toolUseResult: { backgroundTaskId: "bash_abc", timedOutAfterMs: 120000 },
      startedAt: 100,
    });
    expect(next["toolu_1"]).toEqual({
      toolUseId: "toolu_1",
      bashId: "bash_abc",
      command: "sleep 999",
      startedAt: 100,
      killed: undefined,
      timedOutAfterMs: 120000,
    });
  });

  test("creates an entry from timedOutAfterMs alone, with no backgroundTaskId yet", () => {
    const prev: Record<string, BackgroundBash> = {};
    const next = applyBashAutoBackground(prev, {
      toolUseId: "toolu_1",
      command: "sleep 999",
      toolUseResult: { timedOutAfterMs: 60000 },
      startedAt: 100,
    });
    expect(next["toolu_1"]?.bashId).toBeUndefined();
    expect(next["toolu_1"]?.timedOutAfterMs).toBe(60000);
  });

  test("merges into an already-tracked run_in_background entry, preserving its startedAt/killed", () => {
    const prev: Record<string, BackgroundBash> = {
      toolu_1: {
        toolUseId: "toolu_1",
        command: "sleep 999",
        startedAt: 50,
        killed: false,
      },
    };
    const next = applyBashAutoBackground(prev, {
      toolUseId: "toolu_1",
      command: "sleep 999",
      toolUseResult: { backgroundTaskId: "bash_xyz" },
      startedAt: 999, // launch-time re-derivation should NOT override the original startedAt
    });
    expect(next["toolu_1"]).toEqual({
      toolUseId: "toolu_1",
      bashId: "bash_xyz",
      command: "sleep 999",
      startedAt: 50,
      killed: false,
      timedOutAfterMs: undefined,
    });
  });

  test("does not clobber an existing bashId when the new result omits backgroundTaskId", () => {
    const prev: Record<string, BackgroundBash> = {
      toolu_1: {
        toolUseId: "toolu_1",
        bashId: "bash_original",
        command: "sleep 999",
        startedAt: 50,
      },
    };
    const next = applyBashAutoBackground(prev, {
      toolUseId: "toolu_1",
      command: "sleep 999",
      toolUseResult: { timedOutAfterMs: 30000 },
      startedAt: 999,
    });
    expect(next["toolu_1"]?.bashId).toBe("bash_original");
    expect(next["toolu_1"]?.timedOutAfterMs).toBe(30000);
  });
});
