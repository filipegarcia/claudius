import { HOOK_EVENTS as SDK_HOOK_EVENTS } from "@anthropic-ai/claude-agent-sdk";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { POST } from "@/app/api/hooks/route";
import {
  agentHandlerAllowed,
  handlerTypeAllowed,
  HOOK_EVENT_NAMES,
  HOOK_EVENTS,
  PROMPT_HANDLER_DISALLOWED_EVENTS,
  promptHandlerAllowed,
} from "@/lib/shared/hook-events";
import { makeTempHome, type TmpHome } from "./helpers/tmp-home";

/**
 * SDK 0.3.332 — `HOOK_EVENTS` gained `PreSkillShellCommand`: "a hook event
 * that can refuse a skill or command's inline shell commands as it loads"
 * (CC 2.1.332). Claudius's hand mirror lacked it, so `/hooks` had no row for
 * it and `POST /api/hooks` answered 400 "invalid event". The bundled 2.1.332
 * CLI refuses prompt and agent handlers on it ("prompt and agent hooks don't
 * run on PreSkillShellCommand") by blocking every command, so the editor and
 * the route refuse those handler types there.
 */

describe("PreSkillShellCommand hook event", () => {
  test("HOOK_EVENT_NAMES matches the SDK's runtime HOOK_EVENTS exactly", () => {
    // The drift guard the hand mirror never had: a future SDK event fails here.
    expect([...HOOK_EVENT_NAMES].sort()).toEqual([...SDK_HOOK_EVENTS].sort());
  });

  test("has a blocking tool-lifecycle row matched on the shell tool's name", () => {
    const spec = HOOK_EVENTS.find((e) => e.name === "PreSkillShellCommand");
    expect(spec).toBeDefined();
    expect(spec?.category).toBe("tool");
    expect(spec?.canBlock).toBe(true);
    expect(spec?.matcherHint).toBe("Bash | PowerShell");
  });

  test("prompt and agent handlers are refused on it, others are not", () => {
    expect(agentHandlerAllowed("PreSkillShellCommand")).toBe(false);
    expect(promptHandlerAllowed("PreSkillShellCommand")).toBe(false);
    expect(PROMPT_HANDLER_DISALLOWED_EVENTS).toEqual(["PreSkillShellCommand"]);
    for (const t of ["command", "http", "mcp_tool"] as const) {
      expect(handlerTypeAllowed(t, "PreSkillShellCommand")).toBe(true);
    }
    expect(handlerTypeAllowed("prompt", "PreSkillShellCommand")).toBe(false);
    expect(handlerTypeAllowed("agent", "PreSkillShellCommand")).toBe(false);
  });

  test("prompt hooks stay allowed elsewhere, including PermissionRequest", () => {
    expect(promptHandlerAllowed("PreToolUse")).toBe(true);
    expect(promptHandlerAllowed("PermissionRequest")).toBe(true);
    expect(handlerTypeAllowed("agent", "PermissionRequest")).toBe(false);
  });
});

describe("POST /api/hooks", () => {
  // The cwd check reads the workspace store; keep it off the real HOME.
  let home: TmpHome;
  beforeEach(() => {
    home = makeTempHome();
  });
  afterEach(() => home.restore());

  const post = (body: unknown) =>
    POST(new Request("http://localhost/api/hooks", { method: "POST", body: JSON.stringify(body) }));

  test("refuses a prompt hook on PreSkillShellCommand before touching any file", async () => {
    const res = await post({
      scope: "project",
      cwd: "/nonexistent",
      event: "PreSkillShellCommand",
      group: { matcher: "Bash", hooks: [{ type: "prompt", prompt: "Is this safe?" }] },
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe(
      "prompt hooks don't run on PreSkillShellCommand — use command or http",
    );
  });

  test("accepts the event name itself (no more 'invalid event')", async () => {
    // A command hook gets past the event and handler checks; the unknown cwd
    // is what stops it, so nothing is written.
    const res = await post({
      scope: "project",
      cwd: "/nonexistent-claudius-test-cwd",
      event: "PreSkillShellCommand",
      group: { matcher: "Bash", hooks: [{ type: "command", command: "./guard.sh" }] },
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe("unknown cwd");
  });
});
