import { describe, expect, test } from "vitest";
import {
  autoCompactWindowInputWarning,
  isAutoCompactWindowOutOfRange,
  parseAutoCompactWindowInput,
  readPerModelAutoCompact,
  setModelAutoCompactWindow,
} from "@/lib/shared/auto-compact-window";

/**
 * CC 2.1.288 (F8) — per-model autoCompactWindow override helpers.
 */
describe("parseAutoCompactWindowInput (F8)", () => {
  test("blank → remove", () => {
    expect(parseAutoCompactWindowInput("")).toEqual({ kind: "remove" });
    expect(parseAutoCompactWindowInput("   ")).toEqual({ kind: "remove" });
  });
  test("'auto' (any case) → set auto", () => {
    expect(parseAutoCompactWindowInput("auto")).toEqual({ kind: "set", value: "auto" });
    expect(parseAutoCompactWindowInput("AUTO")).toEqual({ kind: "set", value: "auto" });
  });
  test("numeric → set number", () => {
    expect(parseAutoCompactWindowInput("200000")).toEqual({ kind: "set", value: 200000 });
  });
  test("non-numeric non-auto → ignore (don't wipe the stored value)", () => {
    expect(parseAutoCompactWindowInput("au")).toEqual({ kind: "ignore" });
    expect(parseAutoCompactWindowInput("abc")).toEqual({ kind: "ignore" });
  });
});

describe("parseAutoCompactWindowInput — k/M suffixes (CC 2.1.304)", () => {
  test("k suffix scales by 1,000 (any case, optional space)", () => {
    expect(parseAutoCompactWindowInput("200k")).toEqual({ kind: "set", value: 200_000 });
    expect(parseAutoCompactWindowInput("200K")).toEqual({ kind: "set", value: 200_000 });
    expect(parseAutoCompactWindowInput(" 150 k ")).toEqual({ kind: "set", value: 150_000 });
  });
  test("M suffix scales by 1,000,000, decimals allowed", () => {
    expect(parseAutoCompactWindowInput("1M")).toEqual({ kind: "set", value: 1_000_000 });
    expect(parseAutoCompactWindowInput("0.5m")).toEqual({ kind: "set", value: 500_000 });
    expect(parseAutoCompactWindowInput("1.5M")).toEqual({ kind: "set", value: 1_500_000 });
  });
  test("unknown suffixes and bare suffixes are ignored", () => {
    expect(parseAutoCompactWindowInput("200g")).toEqual({ kind: "ignore" });
    expect(parseAutoCompactWindowInput("k")).toEqual({ kind: "ignore" });
    expect(parseAutoCompactWindowInput("200kk")).toEqual({ kind: "ignore" });
  });
  test("allowAuto: false ignores 'auto' instead of saving it", () => {
    expect(parseAutoCompactWindowInput("auto", { allowAuto: false })).toEqual({ kind: "ignore" });
    expect(parseAutoCompactWindowInput("300k", { allowAuto: false })).toEqual({
      kind: "set",
      value: 300_000,
    });
  });
});

describe("autoCompactWindowInputWarning (CC 2.1.304)", () => {
  test("no warning for blank, auto and in-range values", () => {
    expect(autoCompactWindowInputWarning("")).toBeNull();
    expect(autoCompactWindowInputWarning("auto")).toBeNull();
    expect(autoCompactWindowInputWarning("200k")).toBeNull();
    expect(autoCompactWindowInputWarning("1M")).toBeNull();
  });
  test("warns 'ignored' for text that doesn't parse", () => {
    expect(autoCompactWindowInputWarning("abc")).toBe("ignored");
    expect(autoCompactWindowInputWarning("auto", { allowAuto: false })).toBe("ignored");
  });
  test("warns 'out-of-range' outside 100k–1M", () => {
    expect(autoCompactWindowInputWarning("50k")).toBe("out-of-range");
    expect(autoCompactWindowInputWarning("2M")).toBe("out-of-range");
  });
});

describe("isAutoCompactWindowOutOfRange (F8)", () => {
  test("in range is fine", () => {
    expect(isAutoCompactWindowOutOfRange(100000)).toBe(false);
    expect(isAutoCompactWindowOutOfRange(500000)).toBe(false);
    expect(isAutoCompactWindowOutOfRange(1000000)).toBe(false);
  });
  test("out of range warns", () => {
    expect(isAutoCompactWindowOutOfRange(50000)).toBe(true);
    expect(isAutoCompactWindowOutOfRange(2000000)).toBe(true);
  });
  test("non-numbers (auto/undefined) never warn", () => {
    expect(isAutoCompactWindowOutOfRange("auto")).toBe(false);
    expect(isAutoCompactWindowOutOfRange(undefined)).toBe(false);
  });
});

describe("readPerModelAutoCompact (F8)", () => {
  test("lists only models that carry an autoCompactWindow", () => {
    const ms = {
      "claude-opus-4-8": { autoCompactWindow: 200000, effortLevel: "high" },
      "claude-sonnet-4-5": { effortLevel: "medium" }, // no window → excluded
      "claude-haiku-4-5": { autoCompactWindow: "auto" },
    };
    expect(readPerModelAutoCompact(ms)).toEqual([
      { model: "claude-opus-4-8", window: 200000 },
      { model: "claude-haiku-4-5", window: "auto" },
    ]);
  });
  test("non-object input → empty", () => {
    expect(readPerModelAutoCompact(undefined)).toEqual([]);
    expect(readPerModelAutoCompact(null)).toEqual([]);
  });
});

describe("setModelAutoCompactWindow (F8)", () => {
  test("sets a window while preserving sibling per-model fields", () => {
    const ms = { "claude-opus-4-8": { effortLevel: "high" } };
    expect(setModelAutoCompactWindow(ms, "claude-opus-4-8", 300000)).toEqual({
      "claude-opus-4-8": { effortLevel: "high", autoCompactWindow: 300000 },
    });
  });

  test("adds a brand-new model entry", () => {
    expect(setModelAutoCompactWindow(undefined, "claude-opus-4-8", "auto")).toEqual({
      "claude-opus-4-8": { autoCompactWindow: "auto" },
    });
  });

  test("removing the window keeps the model if siblings remain", () => {
    const ms = { "claude-opus-4-8": { effortLevel: "high", autoCompactWindow: 300000 } };
    expect(setModelAutoCompactWindow(ms, "claude-opus-4-8", undefined)).toEqual({
      "claude-opus-4-8": { effortLevel: "high" },
    });
  });

  test("removing the last field drops the model, and the last model → undefined map", () => {
    const ms = { "claude-opus-4-8": { autoCompactWindow: 300000 } };
    expect(setModelAutoCompactWindow(ms, "claude-opus-4-8", undefined)).toBeUndefined();
  });

  test("does not mutate the input", () => {
    const ms = { "claude-opus-4-8": { effortLevel: "high" } };
    setModelAutoCompactWindow(ms, "claude-opus-4-8", 300000);
    expect(ms).toEqual({ "claude-opus-4-8": { effortLevel: "high" } });
  });
});
