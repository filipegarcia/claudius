import { describe, expect, test } from "vitest";
import { BUILTIN_TOOL_NAMES, LEGACY_TOOL_NAME_ALIASES } from "@anthropic-ai/claude-agent-sdk";

import { Session, RESTRICTED_MODE_DISALLOWED_TOOLS } from "@/lib/server/session";
import { mergeSessionDefaults } from "@/lib/shared/session-defaults";

/**
 * Restricted mode (Claude Code 2.1.248 `--restricted` / `CLAUDE_CODE_RESTRICTED=1`).
 * Claudius reimplements it as a per-workspace `restrictedMode` default that
 * (1) blocks the command/code-execution tools + WebFetch via
 * `Options.disallowedTools`, and (2) refuses `bypassPermissions`, coercing it
 * to `default` both at construction and on any later `setPermissionMode`.
 *
 * The Session constructor does no IO (field assignment + id/uuid + Date.now),
 * so it's safe to construct directly here to pin the permission coercion
 * without exercising the heavier `start()` plumbing.
 */
describe("restricted mode", () => {
  test("disallowed-tools set is exactly the shell/network tools (no stale names)", () => {
    // A3 — dropped stale `KillBash` (gone from the 0.3.288 union), added
    // `Monitor` (runs a shell command) and `TaskStop`.
    expect([...RESTRICTED_MODE_DISALLOWED_TOOLS].sort()).toEqual(
      ["Bash", "BashOutput", "Monitor", "TaskStop", "WebFetch"].sort(),
    );
    expect(RESTRICTED_MODE_DISALLOWED_TOOLS).not.toContain("KillBash");
  });

  test("mergeSessionDefaults threads restrictedMode (request wins, else default)", () => {
    expect(mergeSessionDefaults({}, { restrictedMode: true }).restrictedMode).toBe(true);
    expect(
      mergeSessionDefaults({ restrictedMode: false }, { restrictedMode: true })
        .restrictedMode,
    ).toBe(false);
    expect(mergeSessionDefaults({}, {}).restrictedMode).toBeUndefined();
  });

  test("constructor refuses bypassPermissions when restricted (coerced to default)", () => {
    const s = new Session({ restrictedMode: true, permissionMode: "bypassPermissions" });
    expect(s.getPermissionMode()).toBe("default");
  });

  test("constructor keeps a non-bypass mode under restriction", () => {
    const s = new Session({ restrictedMode: true, permissionMode: "acceptEdits" });
    expect(s.getPermissionMode()).toBe("acceptEdits");
  });

  test("unrestricted sessions keep bypassPermissions", () => {
    const s = new Session({ permissionMode: "bypassPermissions" });
    expect(s.getPermissionMode()).toBe("bypassPermissions");
  });

  test("setPermissionMode cannot switch a restricted session into bypass", async () => {
    const s = new Session({ restrictedMode: true, permissionMode: "default" });
    await s.setPermissionMode("bypassPermissions");
    expect(s.getPermissionMode()).toBe("default");
    // A normal switch still works.
    await s.setPermissionMode("acceptEdits");
    expect(s.getPermissionMode()).toBe("acceptEdits");
  });

  test("getRebuildOpts carries restrictedMode so recovery/resume preserves it", () => {
    const s = new Session({ restrictedMode: true, permissionMode: "default" });
    expect(s.getRebuildOpts().restrictedMode).toBe(true);
  });
});

// SDK 0.3.301 exports the public built-in tool names and the earlier names
// they replaced. Guard the restricted-mode deny list against drifting onto a
// stale alias (a deny rule on a renamed tool silently blocks nothing).
describe("RESTRICTED_MODE_DISALLOWED_TOOLS vs SDK tool names", () => {
  test("no entry is a legacy alias of a renamed tool", () => {
    for (const name of RESTRICTED_MODE_DISALLOWED_TOOLS) {
      expect(Object.keys(LEGACY_TOOL_NAME_ALIASES)).not.toContain(name);
    }
  });

  test("every entry is a current built-in name (BashOutput is the one documented extra)", () => {
    const builtin = new Set<string>(BUILTIN_TOOL_NAMES);
    const unknown = RESTRICTED_MODE_DISALLOWED_TOOLS.filter((n) => !builtin.has(n) && n !== "BashOutput");
    expect(unknown).toEqual([]);
  });
});
