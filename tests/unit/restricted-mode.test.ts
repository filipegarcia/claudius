import { describe, expect, test } from "vitest";

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
  test("disallowed-tools set is exactly the command/code tools + WebFetch", () => {
    expect([...RESTRICTED_MODE_DISALLOWED_TOOLS].sort()).toEqual(
      ["Bash", "BashOutput", "KillBash", "WebFetch"].sort(),
    );
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
