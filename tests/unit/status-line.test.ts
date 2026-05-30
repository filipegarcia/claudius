/**
 * Pin the pure merge logic behind the Settings "Status line" group. The core
 * bug this guards against: editing the command used to REBUILD the statusLine
 * object as `{ type, command }`, silently dropping any existing
 * `refreshInterval` / `padding` / `hideVimModeIndicator`. These helpers merge
 * instead — `next build` type-checks the page but won't catch a clobber.
 */
import { describe, expect, test } from "vitest";
import {
  setStatusLineCommand,
  setStatusLineRefreshInterval,
  type StatusLineConfig,
} from "@/lib/shared/status-line";

describe("setStatusLineCommand", () => {
  test("CORE BUG: preserves sub-fields when only the command changes", () => {
    const existing: StatusLineConfig = {
      type: "command",
      command: "/old.sh",
      refreshInterval: 5,
      padding: 2,
      hideVimModeIndicator: true,
    };
    expect(setStatusLineCommand(existing, "/new.sh")).toEqual({
      type: "command",
      command: "/new.sh",
      refreshInterval: 5,
      padding: 2,
      hideVimModeIndicator: true,
    });
  });

  test("creates a fresh object when there was none", () => {
    expect(setStatusLineCommand(undefined, "/s.sh")).toEqual({
      type: "command",
      command: "/s.sh",
    });
  });

  test("clearing the command returns undefined (no orphaned object)", () => {
    const existing: StatusLineConfig = {
      type: "command",
      command: "/old.sh",
      refreshInterval: 5,
    };
    expect(setStatusLineCommand(existing, "")).toBeUndefined();
    expect(setStatusLineCommand(existing, "   ")).toBeUndefined();
  });
});

describe("setStatusLineRefreshInterval", () => {
  const base: StatusLineConfig = { type: "command", command: "/s.sh" };

  test("sets refreshInterval while preserving the command", () => {
    expect(setStatusLineRefreshInterval(base, 10)).toEqual({
      type: "command",
      command: "/s.sh",
      refreshInterval: 10,
    });
  });

  test("undefined DELETES the key rather than storing 0/NaN", () => {
    const withInterval: StatusLineConfig = { ...base, refreshInterval: 10 };
    const result = setStatusLineRefreshInterval(withInterval, undefined);
    expect(result).toEqual({ type: "command", command: "/s.sh" });
    expect(result && "refreshInterval" in result).toBe(false);
  });

  test("NaN DELETES the key", () => {
    const withInterval: StatusLineConfig = { ...base, refreshInterval: 10 };
    const result = setStatusLineRefreshInterval(withInterval, Number.NaN);
    expect(result).toEqual({ type: "command", command: "/s.sh" });
  });

  test("no existing command → returns existing unchanged (no orphaned interval)", () => {
    expect(setStatusLineRefreshInterval(undefined, 10)).toBeUndefined();
    const noCommand = { type: "command", command: "" } as StatusLineConfig;
    expect(setStatusLineRefreshInterval(noCommand, 10)).toBe(noCommand);
  });
});
