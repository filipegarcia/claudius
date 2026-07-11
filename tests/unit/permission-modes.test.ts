import { describe, expect, test } from "vitest";

import { PERMISSION_MODE_ORDER, nextPermissionMode } from "@/lib/shared/permission-modes";

/**
 * Shift+Tab cycling logic for the ModeSelector. Split out of the component
 * (`components/chat/ModeSelector.tsx`, which re-exports both names) so it's
 * plain TS with no React import, matching the `worktree-settings.test.ts`
 * pattern for settings-page logic that lives in `lib/shared`.
 *
 * The `disabledModes` param is Claude Code TUI parity, 2.1.207's
 * `disableAutoMode` setting (see `useDisableAutoMode`) — cycling must skip
 * "auto" when it's disabled, without ever getting stuck.
 */

describe("nextPermissionMode", () => {
  test("cycles through the full default order", () => {
    expect(nextPermissionMode("default")).toBe("acceptEdits");
    expect(nextPermissionMode("acceptEdits")).toBe("auto");
    expect(nextPermissionMode("auto")).toBe("plan");
    expect(nextPermissionMode("plan")).toBe("dontAsk");
    expect(nextPermissionMode("dontAsk")).toBe("bypassPermissions");
    expect(nextPermissionMode("bypassPermissions")).toBe("default");
  });

  test("falls back to default for an unknown mode", () => {
    // @ts-expect-error - exercising the defensive branch with a bad value
    expect(nextPermissionMode("not-a-mode")).toBe("default");
  });

  test("skips a disabled mode in the cycle", () => {
    expect(nextPermissionMode("acceptEdits", ["auto"])).toBe("plan");
  });

  test("a session already sitting in a since-disabled mode can still cycle away from it", () => {
    // "auto" is disabled, but the CURRENT mode is "auto" — it must still be
    // able to advance to the next mode rather than getting stuck.
    expect(nextPermissionMode("auto", ["auto"])).toBe("plan");
  });

  test("disabling every mode except the current one is a no-op cycle", () => {
    const allButDefault = PERMISSION_MODE_ORDER.filter((m) => m !== "default");
    expect(nextPermissionMode("default", allButDefault)).toBe("default");
  });

  test("an empty disabledModes list behaves like no filter at all", () => {
    expect(nextPermissionMode("default", [])).toBe("acceptEdits");
  });
});
