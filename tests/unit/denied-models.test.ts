import { describe, expect, test } from "vitest";
import { isModelDeniedByManaged } from "@/lib/shared/denied-models";

/**
 * CC 2.1.283 (E13) — a managed deniedModels entry must hide an always-shown
 * picker alias.
 */
describe("isModelDeniedByManaged (E13)", () => {
  test("exact id / alias match", () => {
    expect(isModelDeniedByManaged("fable", ["fable"])).toBe(true);
    expect(isModelDeniedByManaged("claude-opus-5-5", ["claude-opus-5-5"])).toBe(true);
  });

  test("bare family alias denies the family and its alias", () => {
    expect(isModelDeniedByManaged("fable", ["fable"])).toBe(true);
    expect(isModelDeniedByManaged("claude-fable-5-1", ["fable"])).toBe(true);
    expect(isModelDeniedByManaged("opus", ["opus"])).toBe(true);
    expect(isModelDeniedByManaged("claude-opus-4-8", ["opus"])).toBe(true);
  });

  test("prefix mode denies id extensions; exact mode does not", () => {
    expect(isModelDeniedByManaged("claude-opus-5-5", ["claude-opus-5"], "prefix")).toBe(true);
    expect(isModelDeniedByManaged("claude-opus-5-5", ["claude-opus-5"], "exact")).toBe(false);
  });

  test("not denied when nothing matches / empty list", () => {
    expect(isModelDeniedByManaged("fable", ["opus"])).toBe(false);
    expect(isModelDeniedByManaged("fable", [])).toBe(false);
    expect(isModelDeniedByManaged("fable", undefined)).toBe(false);
  });
});
