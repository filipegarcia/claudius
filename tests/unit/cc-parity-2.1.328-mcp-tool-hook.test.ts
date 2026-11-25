import { mkdtempSync } from "node:fs";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { addGroup, listAll } from "@/lib/server/hooks";
import {
  handlerBlocksOnFailure,
  handlerSupportsOnFailure,
  isLegacyMcpToolHook,
  MCP_TOOL_ON_FAILURE_IGNORED_EVENTS,
  ON_FAILURE_IGNORED_EVENTS,
  onFailureBlockIgnoredReason,
  onFailureIgnoredEvents,
  type HookHandler,
} from "@/lib/shared/hook-events";
import { makeTempHome, type TmpHome } from "./helpers/tmp-home";

/**
 * CC 2.1.328 — "Added `"onFailure": "block"` for `mcp_tool` hooks, as for
 * command and HTTP hooks: a hook whose call fails blocks the action".
 *
 * Claudius couldn't offer it because its mcp_tool hooks had the wrong shape:
 * it saved `{tool: "mcp__srv__tool", arguments}`, but the engine schema
 * (sdk.d.ts) is `{server, tool, input?, timeout?, onFailure?, …}` with
 * `server` required — so no Claudius-written mcp_tool hook ever loaded.
 */

describe("mcp_tool onFailure helpers", () => {
  test("mcp_tool supports onFailure and a saved block reads as fail-closed", () => {
    expect(handlerSupportsOnFailure("mcp_tool")).toBe(true);
    expect(
      handlerBlocksOnFailure({ type: "mcp_tool", server: "guard", tool: "check", onFailure: "block" }),
    ).toBe(true);
    expect(handlerBlocksOnFailure({ type: "mcp_tool", server: "guard", tool: "check" })).toBe(false);
  });

  test("mcp_tool ignores block on Setup and SessionStart too; command/http don't", () => {
    // SDK JSDoc: "Ignored on Setup, SessionStart, Stop, SubagentStop,
    // TaskCompleted and TeammateIdle".
    expect([...MCP_TOOL_ON_FAILURE_IGNORED_EVENTS].sort()).toEqual(
      ["Setup", "SessionStart", "Stop", "SubagentStop", "TaskCompleted", "TeammateIdle"].sort(),
    );
    expect(onFailureIgnoredEvents("mcp_tool")).toBe(MCP_TOOL_ON_FAILURE_IGNORED_EVENTS);
    expect(onFailureIgnoredEvents("command")).toBe(ON_FAILURE_IGNORED_EVENTS);

    const r = onFailureBlockIgnoredReason;
    for (const event of ["Setup", "SessionStart", "Stop"] as const) {
      expect(r({ type: "mcp_tool", event, onFailure: "block" })).toBe("event");
    }
    expect(r({ type: "command", event: "SessionStart", onFailure: "block" })).toBeNull();
    expect(r({ type: "http", event: "Setup", onFailure: "block" })).toBeNull();
    expect(r({ type: "mcp_tool", event: "PreToolUse", onFailure: "block" })).toBeNull();
  });

  test("mcp_tool has no async branch", () => {
    // Even if a stray `async` reached the helper, mcp_tool has no background
    // mode — only command hooks drop the block for it.
    expect(onFailureBlockIgnoredReason({ type: "mcp_tool", onFailure: "block", async: true })).toBeNull();
  });
});

describe("isLegacyMcpToolHook", () => {
  test("flags the old Claudius shape (no server, arguments key)", () => {
    expect(isLegacyMcpToolHook({ type: "mcp_tool", tool: "mcp__slack__notify", arguments: { c: 1 } })).toBe(true);
    expect(isLegacyMcpToolHook({ type: "mcp_tool", tool: "mcp__slack__notify" })).toBe(true);
  });

  test("flags an `arguments` key even when server is set (the engine reads `input`)", () => {
    expect(isLegacyMcpToolHook({ type: "mcp_tool", server: "slack", tool: "notify", arguments: {} })).toBe(true);
  });

  test("passes the engine shape and other handler types", () => {
    expect(isLegacyMcpToolHook({ type: "mcp_tool", server: "slack", tool: "notify", input: { c: 1 } })).toBe(false);
    expect(isLegacyMcpToolHook({ type: "mcp_tool", server: "slack", tool: "notify" })).toBe(false);
    expect(isLegacyMcpToolHook({ type: "command", command: "x" })).toBe(false);
    expect(isLegacyMcpToolHook(null)).toBe(false);
  });
});

describe("mcp_tool hook round-trip through the settings store", () => {
  let home: TmpHome;
  let cwd: string;

  beforeEach(() => {
    home = makeTempHome();
    cwd = mkdtempSync(join(home.home, "proj-"));
  });
  afterEach(() => home.restore());

  test("{server, tool, input, timeout, onFailure} is written verbatim", async () => {
    const handler: HookHandler = {
      type: "mcp_tool",
      server: "guard",
      tool: "check_command",
      input: { command: "${tool_input.command}" },
      timeout: 10,
      onFailure: "block",
    };
    await addGroup("project", cwd, "PreToolUse", { matcher: "Bash", hooks: [handler] });

    const scoped = (await listAll(cwd)).find((s) => s.scope === "project")!;
    const saved = (scoped.hooks.PreToolUse ?? [])[0].hooks[0];
    expect(saved).toEqual(handler);
    expect(saved).not.toHaveProperty("arguments");
    expect(isLegacyMcpToolHook(saved)).toBe(false);
  });
});
