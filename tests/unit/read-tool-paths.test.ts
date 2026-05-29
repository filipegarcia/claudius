import { describe, expect, test } from "vitest";
import { extractReadPaths } from "@/lib/shared/read-tool-paths";

/**
 * Pin the message-shape sniffing for B2.3's post-compaction re-seed path.
 * The Session walks every assistant message through this helper to track
 * which file paths the model has Read; after a `compact_boundary` it
 * iterates the resulting set and calls `query.seedReadState(path, mtime)`
 * to repopulate the CLI's readFileState cache.
 *
 * Shape correctness matters here: a silent return-[] on a real Read would
 * leave the model with un-seeded files post-compaction, surfacing as
 * spurious "file not read yet" Edit failures the user can't explain.
 */
describe("extractReadPaths", () => {
  function assistant(content: unknown): unknown {
    return { type: "assistant", message: { content } };
  }

  test("returns the file_path from a single Read tool_use", () => {
    const m = assistant([
      { type: "tool_use", id: "t1", name: "Read", input: { file_path: "/abs/foo.ts" } },
    ]);
    expect(extractReadPaths(m)).toEqual(["/abs/foo.ts"]);
  });

  test("returns all paths when the same message has multiple Reads", () => {
    const m = assistant([
      { type: "text", text: "checking" },
      { type: "tool_use", id: "t1", name: "Read", input: { file_path: "/a.ts" } },
      { type: "tool_use", id: "t2", name: "Read", input: { file_path: "/b.ts" } },
    ]);
    expect(extractReadPaths(m)).toEqual(["/a.ts", "/b.ts"]);
  });

  test("ignores non-Read tool_use blocks (Bash, Edit, Agent…)", () => {
    const m = assistant([
      { type: "tool_use", id: "t1", name: "Bash", input: { command: "ls" } },
      { type: "tool_use", id: "t2", name: "Read", input: { file_path: "/x.ts" } },
      { type: "tool_use", id: "t3", name: "Edit", input: { file_path: "/x.ts" } },
      { type: "tool_use", id: "t4", name: "Agent", input: { subagent_type: "Explore" } },
    ]);
    expect(extractReadPaths(m)).toEqual(["/x.ts"]);
  });

  test("non-assistant messages return [] (user replay, system, result, partial)", () => {
    for (const t of ["user", "user_replay", "system", "result", "stream_event", "partial_assistant"]) {
      expect(extractReadPaths({ type: t, message: { content: [] } })).toEqual([]);
    }
  });

  test("malformed inputs never throw — defensive empty list", () => {
    expect(extractReadPaths(null)).toEqual([]);
    expect(extractReadPaths(undefined)).toEqual([]);
    expect(extractReadPaths("not a message")).toEqual([]);
    expect(extractReadPaths(42)).toEqual([]);
    expect(extractReadPaths({ type: "assistant" })).toEqual([]);
    // Wrapped message missing or non-object
    expect(extractReadPaths({ type: "assistant", message: null })).toEqual([]);
    expect(extractReadPaths({ type: "assistant", message: { content: "string instead of array" } })).toEqual([]);
    // Block missing required fields
    expect(extractReadPaths(assistant([{}]))).toEqual([]);
    expect(extractReadPaths(assistant([{ type: "tool_use", name: "Read" }]))).toEqual([]); // no input
    expect(extractReadPaths(assistant([{ type: "tool_use", name: "Read", input: {} }]))).toEqual([]); // no file_path
  });

  test("rejects non-string and empty-string file_path values", () => {
    const m = assistant([
      { type: "tool_use", id: "t1", name: "Read", input: { file_path: 42 } },
      { type: "tool_use", id: "t2", name: "Read", input: { file_path: null } },
      { type: "tool_use", id: "t3", name: "Read", input: { file_path: "" } },
      { type: "tool_use", id: "t4", name: "Read", input: { file_path: "/valid.ts" } },
    ]);
    expect(extractReadPaths(m)).toEqual(["/valid.ts"]);
  });

  test("is case-sensitive on the tool name — 'read' / 'READ' do NOT match", () => {
    // The wire format is exact-case "Read"; if the SDK ever lowercases the
    // name, this assertion would surface the change as a test failure.
    const m = assistant([
      { type: "tool_use", id: "t1", name: "read", input: { file_path: "/lower.ts" } },
      { type: "tool_use", id: "t2", name: "READ", input: { file_path: "/upper.ts" } },
    ]);
    expect(extractReadPaths(m)).toEqual([]);
  });
});
