import { describe, expect, test } from "vitest";
import { clearStreaming, sweepToolHistoryDone } from "@/lib/client/idle-reconcile";
import type { DisplayMessage, ToolHistoryEntry } from "@/lib/client/types";

function entry(partial: Partial<ToolHistoryEntry> & { toolUseId: string }): ToolHistoryEntry {
  return { toolName: "Bash", startedAt: 0, ...partial };
}

describe("sweepToolHistoryDone", () => {
  test("marks non-done entries done with an endedAt", () => {
    const prev = [entry({ toolUseId: "a" }), entry({ toolUseId: "b", done: true, endedAt: 5 })];
    const next = sweepToolHistoryDone(prev, 1000);
    expect(next[0].done).toBe(true);
    expect(next[0].endedAt).toBe(1000);
    expect(next[1]).toBe(prev[1]); // already done — untouched reference
  });

  test("preserves an existing endedAt when marking done", () => {
    const next = sweepToolHistoryDone([entry({ toolUseId: "a", endedAt: 42 })], 1000);
    expect(next[0]).toMatchObject({ done: true, endedAt: 42 });
  });

  test("returns the same array reference when everything is already done", () => {
    const prev = [entry({ toolUseId: "a", done: true }), entry({ toolUseId: "b", done: true })];
    expect(sweepToolHistoryDone(prev, 1000)).toBe(prev);
  });

  test("sweeps synthetic thinking rows too", () => {
    const prev = [entry({ toolUseId: "thinking:x:0", toolName: "Thinking", kind: "thinking" })];
    expect(sweepToolHistoryDone(prev, 1000)[0].done).toBe(true);
  });
});

describe("clearStreaming", () => {
  const msg = (uuid: string, streaming?: boolean): DisplayMessage => ({
    uuid,
    role: "assistant",
    blocks: [],
    ...(streaming ? { streaming: true } : {}),
  });

  test("clears the streaming flag where set", () => {
    const prev = [msg("a", true), msg("b")];
    const next = clearStreaming(prev);
    expect(next[0].streaming).toBe(false);
    expect(next[1]).toBe(prev[1]);
  });

  test("returns the same array reference when nothing is streaming", () => {
    const prev = [msg("a"), msg("b")];
    expect(clearStreaming(prev)).toBe(prev);
  });
});
