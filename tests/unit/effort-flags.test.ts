import { describe, expect, test } from "vitest";
import { buildEffortFlagSettings, parseEffortArgs } from "@/lib/shared/effort-flags";

/**
 * CC 2.1.284 (E3a) — an effort change keeps ultracode on by sending both keys;
 * an effortLevel sent alone (ultracode off) leaves it off.
 */
describe("buildEffortFlagSettings (E3)", () => {
  test("ultracode on → both keys sent (level change keeps it on)", () => {
    expect(buildEffortFlagSettings("high", true)).toEqual({ effortLevel: "high", ultracode: true });
    expect(buildEffortFlagSettings("low", true)).toEqual({ effortLevel: "low", ultracode: true });
  });

  test("ultracode off → only effortLevel sent (no ultracode key)", () => {
    expect(buildEffortFlagSettings("high", false)).toEqual({ effortLevel: "high" });
    expect(buildEffortFlagSettings("high", false)).not.toHaveProperty("ultracode");
  });

  test("auto clears the effort override (null), ultracode preserved when on", () => {
    expect(buildEffortFlagSettings("auto", false)).toEqual({ effortLevel: null });
    expect(buildEffortFlagSettings("auto", true)).toEqual({ effortLevel: null, ultracode: true });
  });
});

describe("parseEffortArgs (E3d)", () => {
  test("a bare /effort shows the current state", () => {
    expect(parseEffortArgs("")).toEqual({ kind: "show" });
    expect(parseEffortArgs("   ")).toEqual({ kind: "show" });
  });

  test("a valid level persists by default (sessionOnly false)", () => {
    expect(parseEffortArgs("high")).toEqual({ kind: "level", level: "high", sessionOnly: false });
    expect(parseEffortArgs("XHIGH")).toEqual({ kind: "level", level: "xhigh", sessionOnly: false });
    expect(parseEffortArgs("auto")).toEqual({ kind: "level", level: "auto", sessionOnly: false });
  });

  test("CC 2.1.257 — a trailing s/session makes it session-only", () => {
    expect(parseEffortArgs("high s")).toEqual({ kind: "level", level: "high", sessionOnly: true });
    expect(parseEffortArgs("xhigh session")).toEqual({ kind: "level", level: "xhigh", sessionOnly: true });
    // an unrelated trailing token is invalid, not session-only
    expect(parseEffortArgs("high please")).toMatchObject({ kind: "invalid" });
  });

  test("ultracode on/off", () => {
    expect(parseEffortArgs("ultracode on")).toEqual({ kind: "ultracode", on: true });
    expect(parseEffortArgs("ultracode off")).toEqual({ kind: "ultracode", on: false });
  });

  test("ultracode without on|off is invalid", () => {
    expect(parseEffortArgs("ultracode")).toMatchObject({ kind: "invalid" });
    expect(parseEffortArgs("ultracode maybe")).toMatchObject({ kind: "invalid" });
  });

  test("an unknown level is invalid", () => {
    expect(parseEffortArgs("turbo")).toMatchObject({ kind: "invalid" });
    expect(parseEffortArgs("high extra")).toMatchObject({ kind: "invalid" });
  });
});
