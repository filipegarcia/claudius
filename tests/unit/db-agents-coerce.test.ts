import { describe, expect, test } from "vitest";
import { coerceAgentDefinition, assertValidAgentName } from "@/lib/server/db-agents";

/**
 * Pin the pure validation/coercion for DB-backed programmatic agents (A-P3.8).
 * This gates both the write path (reject bad input → 400) and the read path
 * (skip a corrupt row rather than crash session start), so its correctness is
 * load-bearing for `Options.agents`.
 */
describe("coerceAgentDefinition", () => {
  test("accepts a minimal valid definition (description + prompt)", () => {
    const def = coerceAgentDefinition({ description: "Reviews code", prompt: "You review." });
    expect(def).toEqual({ description: "Reviews code", prompt: "You review." });
  });

  test("rejects missing/empty required fields", () => {
    expect(coerceAgentDefinition({ prompt: "x" })).toBeNull();
    expect(coerceAgentDefinition({ description: "x" })).toBeNull();
    expect(coerceAgentDefinition({ description: "  ", prompt: "x" })).toBeNull();
    expect(coerceAgentDefinition({ description: "x", prompt: "   " })).toBeNull();
    expect(coerceAgentDefinition(null)).toBeNull();
    expect(coerceAgentDefinition("nope")).toBeNull();
  });

  test("carries through recognized optional fields", () => {
    const def = coerceAgentDefinition({
      description: "d",
      prompt: "p",
      tools: ["Read", "Grep"],
      disallowedTools: ["Bash"],
      skills: ["pdf"],
      model: "sonnet",
      initialPrompt: "go",
      maxTurns: 5,
      background: true,
      memory: "project",
      effort: "high",
      permissionMode: "plan",
    });
    expect(def).toMatchObject({
      tools: ["Read", "Grep"],
      disallowedTools: ["Bash"],
      skills: ["pdf"],
      model: "sonnet",
      initialPrompt: "go",
      maxTurns: 5,
      background: true,
      memory: "project",
      effort: "high",
      permissionMode: "plan",
    });
  });

  test("drops unknown keys and malformed field types (no smuggling into Options)", () => {
    const def = coerceAgentDefinition({
      description: "d",
      prompt: "p",
      evil: "should not survive",
      tools: ["Read", 42, null, "Glob"], // non-strings filtered out
      maxTurns: "lots", // wrong type → dropped
      memory: "bogus", // not in enum → dropped
      effort: "ultra", // not in enum → dropped
    });
    expect(def).not.toBeNull();
    expect(def as Record<string, unknown>).not.toHaveProperty("evil");
    expect(def!.tools).toEqual(["Read", "Glob"]);
    expect(def!.maxTurns).toBeUndefined();
    expect(def!.memory).toBeUndefined();
    expect(def!.effort).toBeUndefined();
  });

  test("accepts numeric effort", () => {
    expect(coerceAgentDefinition({ description: "d", prompt: "p", effort: 3 })!.effort).toBe(3);
  });
});

describe("assertValidAgentName", () => {
  test("accepts word/dot/dash names", () => {
    expect(() => assertValidAgentName("code-reviewer")).not.toThrow();
    expect(() => assertValidAgentName("my.agent_2")).not.toThrow();
  });

  test("rejects path-traversal and empty/odd names", () => {
    expect(() => assertValidAgentName("../etc/passwd")).toThrow("invalid agent name");
    expect(() => assertValidAgentName("a/b")).toThrow();
    expect(() => assertValidAgentName("")).toThrow();
    expect(() => assertValidAgentName("has space")).toThrow();
    expect(() => assertValidAgentName(42 as unknown)).toThrow();
  });
});
