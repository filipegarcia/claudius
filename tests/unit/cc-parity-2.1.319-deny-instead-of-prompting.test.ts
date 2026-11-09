import { promises as fs } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { makeTempHome, type TmpHome } from "./helpers/tmp-home";

/**
 * CC 2.1.319 parity — "Added `permissions.denyInsteadOfPrompting` setting: a
 * tool call that would wait on a permission prompt is denied and the turn
 * continues".
 *
 * The engine enforces it (before `canUseTool`, read only from user /
 * `--settings` / managed sources). Claudius's side:
 * - the account-scope toggle on /permissions round-trips through
 *   `POST /api/settings/permissions` into `~/.claude/settings.json`;
 * - the in-process goal tool is pre-approved in `allowedTools`, because with
 *   the flag on the engine would deny it before Claudius's `canUseTool`
 *   auto-allow ever ran.
 */
vi.mock("@/lib/server/trusted-cwd", () => ({ resolveTrustedCwd: vi.fn(async () => "/tmp/claudius-dip-cwd") }));

let home: TmpHome;
beforeEach(() => {
  home = makeTempHome();
});
afterEach(() => {
  home.restore();
});

describe("denyInsteadOfPrompting", () => {
  test("the account toggle writes permissions.denyInsteadOfPrompting to user settings, keeping other keys", async () => {
    const dir = join(home.home, ".claude");
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(join(dir, "settings.json"), JSON.stringify({ permissions: { allow: ["Read"] }, model: "opus" }));

    const { POST, GET } = await import("@/app/api/settings/permissions/route");
    const res = await POST(
      new Request("http://x/api/settings/permissions", {
        method: "POST",
        body: JSON.stringify({ scope: "user", patch: { denyInsteadOfPrompting: true } }),
      }),
    );
    expect(res.status).toBe(200);
    const onDisk = JSON.parse(await fs.readFile(join(dir, "settings.json"), "utf8"));
    expect(onDisk).toEqual({ permissions: { allow: ["Read"], denyInsteadOfPrompting: true }, model: "opus" });

    const got = (await (await GET(new Request("http://x/api/settings/permissions"))).json()) as Record<
      string,
      { denyInsteadOfPrompting?: boolean }
    >;
    expect(got.user.denyInsteadOfPrompting).toBe(true);
  });

  test("the goal tool is pre-approved so the engine never routes it to a prompt", async () => {
    const { GOAL_TOOL_NAME, SESSION_ALLOWED_TOOLS, TODO_TASK_TOOL_NAMES } = await import("@/lib/server/session");
    expect(GOAL_TOOL_NAME).toBe("mcp__claudius_goal__report_goal_achieved");
    expect(SESSION_ALLOWED_TOOLS).toEqual([...TODO_TASK_TOOL_NAMES, GOAL_TOOL_NAME]);
  });
});
