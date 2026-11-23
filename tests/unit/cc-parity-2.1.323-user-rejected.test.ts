import { afterEach, beforeEach, describe, expect, test } from "vitest";
import type { PermissionResult } from "@anthropic-ai/claude-agent-sdk";
import { extractToolResult } from "@/lib/client/use-session";
import { openDb } from "@/lib/server/db";
import { Session } from "@/lib/server/session";
import { makeTempHome, type TmpHome } from "./helpers/tmp-home";
import { nonExecutionKindOf, stampUserRejectedToolResults } from "@/lib/shared/user-rejected-stamp";

/**
 * CC 2.1.323 — "Fixed a collapsed tool call looking as if it ran after you
 * rejected it with a reason: it now shows 'Not run · rejected'". The engine
 * stamps a host canUseTool deny `permission-rule`, so Claudius's server
 * re-stamps the calls the user denied from its permission card.
 */
type Meta = { id: string; non_execution_kind?: string; [k: string]: unknown }[];
const denied = (id: string, extra: { tool_result_meta?: Meta } = {}): {
  type: string;
  message: { content: { type: string; tool_use_id: string; content: string; is_error: boolean }[] };
  tool_result_meta?: Meta;
} => ({
  type: "user",
  message: {
    content: [{ type: "tool_result", tool_use_id: id, content: "Not now — wrong folder", is_error: true }],
  },
  ...extra,
});

describe("stampUserRejectedToolResults", () => {
  test("re-stamps the engine's permission-rule entry and consumes the id", () => {
    const ids = new Set(["tu1"]);
    const msg = denied("tu1", { tool_result_meta: [{ id: "tu1", non_execution_kind: "permission-rule", built_in_tool: "Bash" }] });
    const out = stampUserRejectedToolResults(msg, ids);
    expect(out).not.toBe(msg);
    expect(out.tool_result_meta).toEqual([{ id: "tu1", non_execution_kind: "user-rejected", built_in_tool: "Bash" }]);
    expect(msg.tool_result_meta?.[0].non_execution_kind).toBe("permission-rule"); // input untouched
    expect(ids.size).toBe(0);
  });

  test("adds an entry when the engine sent no meta", () => {
    const ids = new Set(["tu2"]);
    const out = stampUserRejectedToolResults(denied("tu2"), ids) as { tool_result_meta?: unknown };
    expect(nonExecutionKindOf(out.tool_result_meta, "tu2")).toBe("user-rejected");
  });

  test("leaves other messages, other ids and successful results alone", () => {
    const ids = new Set(["tu3"]);
    const other = denied("tu9");
    expect(stampUserRejectedToolResults(other, ids)).toBe(other);
    const ok = {
      type: "user",
      message: { content: [{ type: "tool_result", tool_use_id: "tu3", content: "fine", is_error: false }] },
    };
    expect(stampUserRejectedToolResults(ok, ids)).toBe(ok);
    const assistant = { type: "assistant", message: { content: [] } };
    expect(stampUserRejectedToolResults(assistant, ids)).toBe(assistant);
    expect(ids.has("tu3")).toBe(true);
  });
});

describe("extractToolResult — user-rejected", () => {
  test("a user-rejected error result is notRun + rejected", () => {
    const msg = stampUserRejectedToolResults(denied("tu1"), new Set(["tu1"]));
    expect(extractToolResult(msg.message.content, undefined, msg.tool_result_meta)).toMatchObject({
      tool_use_id: "tu1",
      isError: true,
      notRun: true,
      rejected: true,
      text: "Not now — wrong folder",
    });
  });

  test("automode-unavailable stays notRun without rejected; a deny rule stays an error", () => {
    const c = denied("tu1").message.content;
    const auto = extractToolResult(c, undefined, [{ id: "tu1", non_execution_kind: "automode-unavailable" }]);
    expect(auto).toMatchObject({ notRun: true });
    expect(auto).not.toHaveProperty("rejected");
    const rule = extractToolResult(c, undefined, [{ id: "tu1", non_execution_kind: "permission-rule" }]);
    expect(rule).not.toHaveProperty("notRun");
    expect(rule).not.toHaveProperty("rejected");
  });
});

describe("Session marks what the user turned down", () => {
  const CWD = "/tmp/claudius-cc-parity-323-user-rejected";
  let tmp: TmpHome;
  beforeEach(async () => {
    tmp = makeTempHome();
    await openDb(CWD);
  });
  afterEach(() => tmp.restore());

  type Internals = Pick<Session, "resolvePlan"> & {
    userRejectedToolUseIds: Set<string>;
    pendingPlans: Map<string, { requestId: string; toolUseId: string; plan: string; resolve: (r: PermissionResult) => void }>;
  };

  test("a rejected plan is stamped user-rejected; an accepted one is not", async () => {
    const session = new Session({ id: "s-323-plan", cwd: CWD, permissionMode: "plan" }) as unknown as Internals;
    session.pendingPlans.set("req-r", { requestId: "req-r", toolUseId: "tool-plan-r", plan: "p", resolve: () => {} });
    expect(await session.resolvePlan("req-r", { kind: "reject", message: "Not yet" })).toBe(true);
    expect(session.userRejectedToolUseIds.has("tool-plan-r")).toBe(true);
    const stamped = stampUserRejectedToolResults(denied("tool-plan-r"), session.userRejectedToolUseIds);
    expect(nonExecutionKindOf(stamped.tool_result_meta, "tool-plan-r")).toBe("user-rejected");
  });
});
