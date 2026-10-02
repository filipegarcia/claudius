import { describe, expect, test } from "vitest";
import { dropPrompt, enqueuePrompt, mergeServerPrompts } from "@/lib/client/prompt-queue";

/**
 * Client-side FIFO for interactive prompts. The bug these pin down: the hook
 * used to hold ONE permission slot, so a second concurrent request (parallel
 * subagents each asking) overwrote the first and that tool call waited
 * forever with nothing on screen.
 */
type P = { requestId: string; label?: string };
const a: P = { requestId: "a" };
const b: P = { requestId: "b" };
const c: P = { requestId: "c" };

describe("enqueuePrompt", () => {
  test("appends in arrival order — oldest stays at the head", () => {
    expect(enqueuePrompt(enqueuePrompt([], a), b)).toEqual([a, b]);
  });

  test("a re-emit of a queued prompt keeps its position instead of duplicating", () => {
    const updated = { requestId: "a", label: "v2" };
    expect(enqueuePrompt([a, b], updated)).toEqual([updated, b]);
  });

  test("returns the same array when nothing changes", () => {
    const q = [a, b];
    expect(enqueuePrompt(q, a)).toBe(q);
  });
});

describe("dropPrompt", () => {
  test("removes only the named prompt, so the next one surfaces", () => {
    expect(dropPrompt([a, b, c], "a")).toEqual([b, c]);
  });

  test("unknown id is a no-op with the same reference", () => {
    const q = [a];
    expect(dropPrompt(q, "zzz")).toBe(q);
  });
});

describe("mergeServerPrompts", () => {
  const none = new Set<string>();

  test("keeps a prompt that arrived over SSE while the fetch was in flight", () => {
    // Why it's a merge, not a replace: the server built its response before
    // `b` existed, but `b` reached the tab first.
    expect(mergeServerPrompts([b], [], none)).toEqual([b]);
  });

  test("appends server prompts this tab never saw, in server order", () => {
    expect(mergeServerPrompts([a], [a, b, c], none)).toEqual([a, b, c]);
  });

  test("never resurrects a prompt this tab already answered or saw settle", () => {
    expect(mergeServerPrompts([], [a, b], new Set(["a"]))).toEqual([b]);
  });

  test("returns the same reference when there's nothing new", () => {
    const q = [a, b];
    expect(mergeServerPrompts(q, [b, a], none)).toBe(q);
  });
});
