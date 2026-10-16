import { describe, expect, test } from "vitest";
import { applyToolResultToList, applyToolResultToTrails } from "@/lib/client/use-session";
import type { DisplayMessage } from "@/lib/client/types";

/**
 * CC 2.1.301 — "a long-running subagent's progress trail now updates
 * incrementally". TaskBlock memoizes each trail message on its object
 * identity, so a tool_result must only replace the message it lands on.
 */
function trail(): DisplayMessage[] {
  return [
    { uuid: "m1", role: "assistant", blocks: [{ kind: "text", text: "Looking…" }] },
    {
      uuid: "m2",
      role: "assistant",
      blocks: [
        { kind: "text", text: "Reading" },
        { kind: "tool_use", id: "tu-1", name: "Read", input: { file_path: "/a" } },
      ],
    },
    { uuid: "m3", role: "assistant", blocks: [{ kind: "tool_use", id: "tu-2", name: "Grep", input: {} }] },
  ] as DisplayMessage[];
}

describe("applyToolResultToList", () => {
  test("a result for a tool_use not in the list returns the same list", () => {
    const list = trail();
    expect(applyToolResultToList(list, "tu-elsewhere", { content: "ok" })).toBe(list);
  });

  test("only the message holding the tool_use is replaced", () => {
    const list = trail();
    const out = applyToolResultToList(list, "tu-1", { content: "file body", isError: false });
    expect(out).not.toBe(list);
    expect(out[0]).toBe(list[0]);
    expect(out[2]).toBe(list[2]);
    expect(out[1]).not.toBe(list[1]);
    // Untouched blocks keep identity too; the matching one carries the result.
    expect(out[1].blocks[0]).toBe(list[1].blocks[0]);
    expect(out[1].blocks[1]).toMatchObject({ kind: "tool_use", id: "tu-1", result: { content: "file body", isError: false } });
    // The input list is not mutated.
    expect((list[1].blocks[1] as { result?: unknown }).result).toBeUndefined();
  });
});

describe("applyToolResultToTrails", () => {
  test("a result that lands in no trail returns the same record", () => {
    const trails = { "task-a": trail(), "task-b": trail() };
    expect(applyToolResultToTrails(trails, "tu-main-thread", { content: "ok" })).toBe(trails);
  });

  test("only the trail holding the tool_use is replaced", () => {
    const trails = { "task-a": trail(), "task-b": [] as DisplayMessage[] };
    const out = applyToolResultToTrails(trails, "tu-2", { content: "3 matches" });
    expect(out).not.toBe(trails);
    expect(out["task-b"]).toBe(trails["task-b"]);
    expect(out["task-a"][0]).toBe(trails["task-a"][0]);
    expect(out["task-a"][1]).toBe(trails["task-a"][1]);
    expect(out["task-a"][2].blocks[0]).toMatchObject({ result: { content: "3 matches" } });
  });
});
