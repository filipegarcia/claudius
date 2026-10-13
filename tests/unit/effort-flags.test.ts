import { describe, expect, test } from "vitest";
import {
  buildEffortFlagSettings,
  capEffortLevels,
  parseAppliedEffort,
  parseEffortArgs,
  type EffortTier,
} from "@/lib/shared/effort-flags";

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

describe("capEffortLevels (CC 2.1.267 — E5)", () => {
  const ALL: EffortTier[] = ["low", "medium", "high", "xhigh", "max"];

  test("caps the list at maxEffortLevel", () => {
    expect(capEffortLevels(ALL, "high")).toEqual(["low", "medium", "high"]);
    expect(capEffortLevels(ALL, "low")).toEqual(["low"]);
  });

  test("'max' or absent cap leaves the list unchanged", () => {
    expect(capEffortLevels(ALL, "max")).toEqual(ALL);
    expect(capEffortLevels(ALL, undefined)).toEqual(ALL);
  });

  test("an unknown cap leaves the list unchanged", () => {
    expect(capEffortLevels(ALL, "turbo")).toEqual(ALL);
  });

  test("preserves the model's own subset ordering", () => {
    expect(capEffortLevels(["low", "high", "xhigh"], "high")).toEqual(["low", "high"]);
  });
});

/**
 * `get_settings` → `applied.effort` is the level the session will really send.
 * The SessionCard pill shows it instead of "auto", so the parser must accept
 * every real tier, keep `null` (no effort param) distinct, and return
 * `undefined` for anything it can't trust so the client keeps its own mirror.
 */
describe("parseAppliedEffort", () => {
  test("returns the applied tier", () => {
    for (const level of ["low", "medium", "high", "xhigh", "max"] as const) {
      expect(parseAppliedEffort({ effective: {}, applied: { model: "claude-opus-5-5", effort: level } })).toBe(level);
    }
  });

  test("null applied effort (no effort parameter sent) stays null", () => {
    expect(parseAppliedEffort({ applied: { model: "claude-haiku-4-5", effort: null } })).toBeNull();
  });

  test("missing / malformed payloads are undefined (leave state untouched)", () => {
    expect(parseAppliedEffort(undefined)).toBeUndefined();
    expect(parseAppliedEffort(null)).toBeUndefined();
    expect(parseAppliedEffort("high")).toBeUndefined();
    expect(parseAppliedEffort({})).toBeUndefined();
    expect(parseAppliedEffort({ applied: null })).toBeUndefined();
    expect(parseAppliedEffort({ applied: { model: "x" } })).toBeUndefined();
  });

  test("an unknown level is undefined, not passed through", () => {
    expect(parseAppliedEffort({ applied: { effort: "turbo" } })).toBeUndefined();
    expect(parseAppliedEffort({ applied: { effort: 32000 } })).toBeUndefined();
    // "auto" is a picker concept, never an applied level.
    expect(parseAppliedEffort({ applied: { effort: "auto" } })).toBeUndefined();
  });
});
