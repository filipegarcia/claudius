import { describe, expect, test } from "vitest";
import {
  extractReferencedPaths,
  extractReferencedCommands,
  findInstructionContradictions,
  findStalePromptPatterns,
} from "@/lib/shared/prompt-audit";

/**
 * Coverage for CC 2.1.283 parity ("Added `/doctor prompt-audit` ... to
 * audit your CLAUDE.md files, skills, agents and commands for prompting
 * patterns written for older models" + "Improved `prompt-audit` on Claude
 * Code configuration: ... thinking keywords that Claude Code documents are
 * kept"). Pure, fs-free heuristics — `lib/server/prompt-audit.ts` (covered
 * by `tests/unit/doctor-prompt-audit.test.ts`) does the file discovery.
 */

describe("findStalePromptPatterns", () => {
  test("flags explicit chain-of-thought scaffolding", () => {
    const matches = findStalePromptPatterns("Please think step by step before answering.");
    expect(matches).toHaveLength(1);
    expect(matches[0].pattern).toBe("cot-scaffolding");
    expect(matches[0].snippet).toContain("step by step");
  });

  test("flags 'let's think this through carefully' scaffolding", () => {
    const matches = findStalePromptPatterns("Let's think this through carefully, one step at a time.");
    expect(matches.some((m) => m.pattern === "cot-scaffolding")).toBe(true);
  });

  test("does NOT flag bare 'think' / documented thinking keywords", () => {
    // CC 2.1.283: "thinking keywords that Claude Code documents are kept" —
    // these are extended-thinking budget triggers, not stale prompting.
    const text = "Think about the tradeoffs. Think hard about edge cases. Ultrathink this refactor. Megathink it. Keep thinking.";
    expect(findStalePromptPatterns(text)).toHaveLength(0);
  });

  test("flags pre-Claude assistant-persona boilerplate", () => {
    const matches = findStalePromptPatterns("You are a helpful AI assistant that answers questions.");
    expect(matches.some((m) => m.pattern === "legacy-persona")).toBe(true);
  });

  test("flags 'as an AI language model' boilerplate", () => {
    const matches = findStalePromptPatterns("As an AI language model, you should always be polite.");
    expect(matches.some((m) => m.pattern === "legacy-persona")).toBe(true);
  });

  test("does NOT false-positive on 'as an aid' (word-boundary check)", () => {
    expect(findStalePromptPatterns("Use this table as an aid to navigation.")).toEqual([]);
  });

  test("does NOT false-positive on 'you are a helpful aide' (word-boundary check)", () => {
    expect(findStalePromptPatterns("You are a helpful aide during incidents.")).toEqual([]);
  });

  test("flags references to retired Claude generations", () => {
    const matches = findStalePromptPatterns("This was tuned for claude-2 and claude-instant.");
    const deprecated = matches.filter((m) => m.pattern === "deprecated-model-ref");
    expect(deprecated).toHaveLength(2);
  });

  test("does not flag current-generation model names", () => {
    const matches = findStalePromptPatterns("Use Claude Sonnet 5 or Claude Opus 5.5 for this task.");
    expect(matches.filter((m) => m.pattern === "deprecated-model-ref")).toHaveLength(0);
  });

  test("returns [] for clean, modern prompting text", () => {
    const text = "Read the relevant files first, then make the change. Keep edits scoped to what was asked.";
    expect(findStalePromptPatterns(text)).toEqual([]);
  });

  test("returns [] for empty input", () => {
    expect(findStalePromptPatterns("")).toEqual([]);
  });

  test("finds multiple matches across a longer document without infinite-looping", () => {
    const text = "Think step by step. Later on, think step by step again. As an AI language model, be careful.";
    const matches = findStalePromptPatterns(text);
    expect(matches.filter((m) => m.pattern === "cot-scaffolding")).toHaveLength(2);
    expect(matches.filter((m) => m.pattern === "legacy-persona")).toHaveLength(1);
  });
});

describe("extractReferencedPaths", () => {
  test("extracts backtick-quoted path-shaped tokens", () => {
    expect(extractReferencedPaths("See `lib/server/session.ts` for details.")).toEqual(["lib/server/session.ts"]);
  });

  test("extracts multiple distinct paths, deduped", () => {
    const text = "Check `app/api/doctor/route.ts` and `lib/shared/prompt-audit.ts`, then `app/api/doctor/route.ts` again.";
    expect(extractReferencedPaths(text)).toEqual(["app/api/doctor/route.ts", "lib/shared/prompt-audit.ts"]);
  });

  test("ignores backtick-quoted tokens without a path separator", () => {
    expect(extractReferencedPaths("Run `bun run lint` or check `README.md`.")).toEqual([]);
  });

  test("ignores backtick-quoted flags and bare identifiers", () => {
    expect(extractReferencedPaths("Set `--foo` or reference `session.permissionMode`.")).toEqual([]);
  });

  test("returns [] for empty input", () => {
    expect(extractReferencedPaths("")).toEqual([]);
  });
});

// CC 2.1.283 (H3) — stale `/command` references.
describe("extractReferencedCommands", () => {
  test("matches a backtick `/command` and one with args, de-duped", () => {
    expect(
      extractReferencedCommands("Run `/deploy` then `/deploy now` and `/review`."),
    ).toEqual(["deploy", "review"]);
  });

  test("does not match a path, URL, namespaced, or mcp__ ref", () => {
    expect(extractReferencedCommands("see `/api/sessions` and `/usr/bin/x`")).toEqual([]);
    expect(extractReferencedCommands("visit https://x/deploy now")).toEqual([]);
    expect(extractReferencedCommands("run `/dir:sub` please")).toEqual([]);
    expect(extractReferencedCommands("call `/mcp__server__tool`")).toEqual([]);
  });

  test("ignores unquoted slash words (prose)", () => {
    expect(extractReferencedCommands("use the /deploy command")).toEqual([]);
  });
});

// CC 2.1.283 (H3) — contradicting instruction files.
describe("findInstructionContradictions", () => {
  test("flags a cross-source polarity conflict on the same token", () => {
    const out = findInstructionContradictions([
      { id: "claude-md:user", text: "Always use `npm` for installs." },
      { id: "claude-md:project", text: "Never use `npm`; use bun." },
    ]);
    expect(out).toEqual([{ token: "npm", sources: ["claude-md:project", "claude-md:user"] }]);
  });

  test("does not flag a same-source conflict", () => {
    const out = findInstructionContradictions([
      { id: "a", text: "Always use `npm`.\nNever use `npm`." },
    ]);
    expect(out).toEqual([]);
  });

  test("skips a sentence with mixed polarity (ambiguous)", () => {
    const out = findInstructionContradictions([
      { id: "a", text: "Always prefer bun but never `npm`." },
      { id: "b", text: "Always use `npm`." },
    ]);
    // Source a's sentence has both always+never → ambiguous → skipped; so only
    // one source carries a `npm` polarity → no cross-source conflict.
    expect(out).toEqual([]);
  });

  test("ignores unquoted prose directives", () => {
    const out = findInstructionContradictions([
      { id: "a", text: "Always use npm." },
      { id: "b", text: "Never use npm." },
    ]);
    expect(out).toEqual([]);
  });
});
