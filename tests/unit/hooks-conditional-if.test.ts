import { mkdtempSync } from "node:fs";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { addGroup, listAll } from "@/lib/server/hooks";
import { makeTempHome, type TmpHome } from "./helpers/tmp-home";

/**
 * Conditional hooks (`hooks: if`). The data model carries `if?: string` on every
 * `HookHandler` variant, and the server is pure JSON passthrough: `addGroup`
 * writes the group object verbatim into `.claude/settings.json` and `listAll`
 * reads it back.
 *
 * These tests pin the behavioral claim the feature rests on — that a per-handler
 * `if` rule round-trips through the settings store unchanged with no special
 * server handling — by exercising the real write→read path against a throwaway
 * $HOME so the on-disk settings file is the source of truth. They also guard the
 * other half of the change: the dead group-level `if` was removed, so it must
 * not reappear on the persisted group object.
 */

let tmp: TmpHome;
let cwd: string;

beforeEach(() => {
  tmp = makeTempHome();
  // Project scope writes to `<cwd>/.claude/settings.json`; keep cwd under the
  // temp HOME so cleanup reaps it. `writeSettings` mkdirs the `.claude` dir.
  cwd = mkdtempSync(join(tmp.home, "ws-"));
});

afterEach(() => {
  tmp.restore();
});

describe("conditional hooks (handler-level `if`)", () => {
  test("a command handler's `if` rule round-trips through addGroup/listAll", async () => {
    await addGroup("project", cwd, "PreToolUse", {
      matcher: "Bash",
      hooks: [{ type: "command", command: "echo guarded", if: "Bash(git *)" }],
    });

    const scoped = (await listAll(cwd)).find((s) => s.scope === "project");
    expect(scoped).toBeDefined();
    const groups = scoped!.hooks.PreToolUse ?? [];
    expect(groups).toHaveLength(1);
    const handler = groups[0].hooks[0];
    expect(handler.type).toBe("command");
    // The gating rule must survive the write→read trip untouched.
    expect(handler.if).toBe("Bash(git *)");
    // And the group object stays the flat `{ matcher, hooks }` shape — the dead
    // group-level `if` was removed, so it must NOT leak back onto the group.
    expect("if" in groups[0]).toBe(false);
  });

  test("`if` round-trips across every handler variant", async () => {
    await addGroup("project", cwd, "PostToolUse", {
      matcher: "*",
      hooks: [
        { type: "command", command: "c", if: "Bash(git *)" },
        { type: "http", url: "https://h/x", if: "Read(*)" },
        { type: "prompt", prompt: "p", if: "Write(*)" },
        { type: "agent", agent: "a", if: "Edit(*)" },
        { type: "mcp_tool", tool: "t", if: "Bash(npm *)" },
      ],
    });

    const scoped = (await listAll(cwd)).find((s) => s.scope === "project")!;
    const handlers = (scoped.hooks.PostToolUse ?? [])[0].hooks;
    expect(handlers.map((h) => h.if)).toEqual([
      "Bash(git *)",
      "Read(*)",
      "Write(*)",
      "Edit(*)",
      "Bash(npm *)",
    ]);
  });

  test("a handler without `if` stays unconditional (field absent, not empty)", async () => {
    await addGroup("project", cwd, "Stop", {
      hooks: [{ type: "command", command: "cleanup" }],
    });

    const scoped = (await listAll(cwd)).find((s) => s.scope === "project")!;
    const handler = (scoped.hooks.Stop ?? [])[0].hooks[0];
    expect("if" in handler).toBe(false);
  });
});
