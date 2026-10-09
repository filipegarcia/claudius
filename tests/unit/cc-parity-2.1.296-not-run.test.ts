import { describe, expect, test } from "vitest";
import { extractToolResult } from "@/lib/client/use-session";

/**
 * CC 2.1.296 — "a tool call that wasn't run because auto mode's check had no
 * usable answer now shows as a dim 'Not run' row instead of a red error". The
 * engine tags it on the wrapper SDK user message's (@internal)
 * `tool_result_meta[].non_execution_kind`.
 */
const content = [
  { type: "tool_result", tool_use_id: "tu1", content: "Auto mode could not check this action.", is_error: true },
];

describe("extractToolResult — tool_result_meta automode-unavailable", () => {
  test("an errored result tagged automode-unavailable is flagged notRun", () => {
    const meta = [{ id: "tu1", non_execution_kind: "automode-unavailable" }];
    expect(extractToolResult(content, undefined, meta)).toMatchObject({ tool_use_id: "tu1", isError: true, notRun: true });
  });

  test("other non-execution kinds stay ordinary errors", () => {
    for (const kind of ["automode-blocked", "automode-parsing-error", "user-rejected", "permission-rule", "interrupted"]) {
      expect(extractToolResult(content, undefined, [{ id: "tu1", non_execution_kind: kind }])).not.toHaveProperty("notRun");
    }
  });

  test("the meta entry must match this tool_use id", () => {
    const meta = [{ id: "other", non_execution_kind: "automode-unavailable" }];
    expect(extractToolResult(content, undefined, meta)).not.toHaveProperty("notRun");
  });

  test("a non-error result is never notRun; malformed meta is ignored", () => {
    const ok = [{ type: "tool_result", tool_use_id: "tu1", content: "fine" }];
    expect(extractToolResult(ok, undefined, [{ id: "tu1", non_execution_kind: "automode-unavailable" }])).not.toHaveProperty("notRun");
    for (const bad of [undefined, null, "x", {}, [null, 3, "s"]]) {
      expect(extractToolResult(content, undefined, bad)).not.toHaveProperty("notRun");
    }
  });
});
