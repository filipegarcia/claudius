import { describe, expect, test } from "vitest";
import {
  DEFAULT_VERBOSE,
  VERBOSE_LEVELS,
  filterAssistantBlocks,
  filterMessagesByVerbose,
  isMessageHiddenAtLevel,
  isSystemEntryHiddenAtLevel,
  isVerboseLevel,
  shouldExpandAllBlocks,
  verboseDescription,
  verboseLabel,
  type VerboseLevel,
} from "@/lib/shared/verbose";
import type { DisplayBlock, DisplayMessage, SystemEntry } from "@/lib/client/types";

/**
 * Pin down the chat-verbosity filter behaviour. The chat surface and the
 * right-side activity rail are the two consumers of an assistant turn —
 * this module owns ONLY the chat side. The right rail derives from
 * `toolHistory` and is intentionally untouched by these filters, so the
 * spec asserts what's dropped (chat) without asserting the rail at all.
 */

function block(kind: DisplayBlock["kind"], extra: Partial<DisplayBlock> = {}): DisplayBlock {
  if (kind === "text") return { kind: "text", text: (extra as { text?: string }).text ?? "hello" };
  if (kind === "thinking") return { kind: "thinking", text: (extra as { text?: string }).text ?? "reasoning" };
  return {
    kind: "tool_use",
    id: (extra as { id?: string }).id ?? "toolu_1",
    name: (extra as { name?: string }).name ?? "Bash",
    input: (extra as { input?: Record<string, unknown> }).input ?? {},
  };
}

function msg(
  role: "user" | "assistant",
  blocks: DisplayBlock[],
  opts: { streaming?: boolean } = {},
): DisplayMessage {
  return {
    uuid: `m_${role}_${Math.random().toString(36).slice(2, 7)}`,
    role,
    blocks,
    ...(opts.streaming ? { streaming: true } : {}),
  };
}

describe("isVerboseLevel", () => {
  test("accepts the five published levels", () => {
    expect(isVerboseLevel("ultra-compact")).toBe(true);
    expect(isVerboseLevel("compact")).toBe(true);
    expect(isVerboseLevel("normal")).toBe(true);
    expect(isVerboseLevel("verbose")).toBe(true);
    expect(isVerboseLevel("ultra-verbose")).toBe(true);
  });

  test("rejects unknown strings and non-strings", () => {
    expect(isVerboseLevel("loud")).toBe(false);
    expect(isVerboseLevel("")).toBe(false);
    expect(isVerboseLevel(null)).toBe(false);
    expect(isVerboseLevel(undefined)).toBe(false);
    expect(isVerboseLevel(0)).toBe(false);
    expect(isVerboseLevel({ verbose: "verbose" })).toBe(false);
  });

  test("DEFAULT_VERBOSE is one of the published levels", () => {
    expect(isVerboseLevel(DEFAULT_VERBOSE)).toBe(true);
  });

  test("verboseLabel / verboseDescription cover every level (exhaustiveness)", () => {
    for (const l of VERBOSE_LEVELS) {
      const label = verboseLabel(l);
      const desc = verboseDescription(l);
      expect(label).toBeTruthy();
      expect(desc).toBeTruthy();
      // No accidental "TODO"/"???" sentinels left in human-facing copy.
      expect(label).not.toMatch(/TODO|\?\?\?/);
      expect(desc).not.toMatch(/TODO|\?\?\?/);
    }
  });
});

describe("filterAssistantBlocks", () => {
  const all: DisplayBlock[] = [
    block("text", { text: "first line" }),
    block("thinking", { text: "weighing options" }),
    block("tool_use", { name: "Bash" }),
    block("text", { text: "second line" }),
    block("tool_use", { name: "Task" }),
  ];

  test("verbose returns the input unchanged (referential identity)", () => {
    const out = filterAssistantBlocks(all, "verbose");
    expect(out).toBe(all);
    expect(out).toHaveLength(5);
  });

  test("normal drops thinking, keeps text + tool_use (including subagent Task/Agent)", () => {
    const out = filterAssistantBlocks(all, "normal");
    expect(out.map((b) => b.kind)).toEqual(["text", "tool_use", "text", "tool_use"]);
    // Task is a tool_use — verify it's kept by name as well, since the
    // contract is "tool calls including subagent blocks". The SDK now emits
    // these as `Agent` (see lib/shared/subagent-tool.ts); the filter doesn't
    // care about the wire name, but this assertion documents that the data
    // survives regardless of which legacy/current name appears.
    const taskKept = out.some((b) => b.kind === "tool_use" && b.name === "Task");
    expect(taskKept).toBe(true);
  });

  test("compact drops everything except text", () => {
    const out = filterAssistantBlocks(all, "compact");
    expect(out.every((b) => b.kind === "text")).toBe(true);
    expect(out.map((b) => (b.kind === "text" ? b.text : ""))).toEqual([
      "first line",
      "second line",
    ]);
  });

  test("returns an empty array (not null/undefined) when nothing survives", () => {
    const toolOnly = [block("tool_use"), block("thinking")];
    const compact = filterAssistantBlocks(toolOnly, "compact");
    expect(Array.isArray(compact)).toBe(true);
    expect(compact).toHaveLength(0);

    const thinkingOnly = [block("thinking")];
    const normal = filterAssistantBlocks(thinkingOnly, "normal");
    expect(normal).toEqual([]);
  });

  test("does not mutate the input array", () => {
    const input = [...all];
    const snapshot = [...input];
    filterAssistantBlocks(input, "compact");
    expect(input).toEqual(snapshot);
  });

  test("verbose keeps empty thinking envelopes — they're the signal the model entered thinking mode", () => {
    // Earlier the filter tried to drop these post-stream as "noise", but
    // hiding them erased the only cue users had that Claude had attempted
    // to think. ThinkingBlock now shows an honest "no trace" copy
    // instead. The filter just keeps everything at verbose.
    const withEmptyThink: DisplayBlock[] = [
      block("text", { text: "hi" }),
      block("thinking", { text: "" }),
      block("text", { text: "bye" }),
    ];
    const out = filterAssistantBlocks(withEmptyThink, "verbose");
    expect(out.map((b) => b.kind)).toEqual(["text", "thinking", "text"]);
  });

  test("normal still drops thinking (including empty thinking) — that level is the 'quiet' default", () => {
    const blocks: DisplayBlock[] = [
      block("text", { text: "hi" }),
      block("thinking", { text: "" }),
      block("thinking", { text: "with body" }),
    ];
    const out = filterAssistantBlocks(blocks, "normal");
    expect(out.map((b) => b.kind)).toEqual(["text"]);
  });
});

describe("isMessageHiddenAtLevel", () => {
  test("user messages never hide", () => {
    for (const l of VERBOSE_LEVELS) {
      expect(isMessageHiddenAtLevel(msg("user", []), l)).toBe(false);
      expect(isMessageHiddenAtLevel(msg("user", [block("text")]), l)).toBe(false);
    }
  });

  test("verbose never hides an assistant message", () => {
    // Verbose is the "show everything" floor: even an empty assistant
    // payload surfaces (helps debuggers spot a malformed turn). The
    // earlier streaming-aware drop was reverted because it also hid the
    // user-visible "Claude entered thinking mode" cue.
    expect(isMessageHiddenAtLevel(msg("assistant", []), "verbose")).toBe(false);
    expect(
      isMessageHiddenAtLevel(msg("assistant", [block("thinking", { text: "" })]), "verbose"),
    ).toBe(false);
  });

  test("compact hides a tool-only assistant message", () => {
    const m = msg("assistant", [block("tool_use"), block("thinking")]);
    expect(isMessageHiddenAtLevel(m, "compact")).toBe(true);
    expect(isMessageHiddenAtLevel(m, "normal")).toBe(false); // tool_use survives
    expect(isMessageHiddenAtLevel(m, "verbose")).toBe(false);
  });

  test("normal hides a thinking-only assistant message", () => {
    const m = msg("assistant", [block("thinking")]);
    expect(isMessageHiddenAtLevel(m, "compact")).toBe(true);
    expect(isMessageHiddenAtLevel(m, "normal")).toBe(true);
    expect(isMessageHiddenAtLevel(m, "verbose")).toBe(false);
  });

  test("any level keeps a message that has at least one surviving block", () => {
    const m = msg("assistant", [block("text"), block("thinking")]);
    for (const l of VERBOSE_LEVELS) {
      expect(isMessageHiddenAtLevel(m, l)).toBe(false);
    }
  });
});

describe("filterMessagesByVerbose", () => {
  const u1 = msg("user", [block("text", { text: "what time is it?" })]);
  const a1 = msg("assistant", [
    block("text", { text: "Let me check." }),
    block("thinking", { text: "should I run date?" }),
    block("tool_use", { name: "Bash" }),
    block("text", { text: "It's 3pm." }),
  ]);
  const a2_toolOnly = msg("assistant", [block("tool_use", { name: "Read" })]);
  const a3_thinkingOnly = msg("assistant", [block("thinking", { text: "..." })]);
  const u2 = msg("user", [block("text", { text: "thanks" })]);

  const corpus = [u1, a1, a2_toolOnly, a3_thinkingOnly, u2];

  test("verbose returns the input reference unchanged", () => {
    const out = filterMessagesByVerbose(corpus, "verbose");
    expect(out).toBe(corpus);
  });

  test("normal drops thinking inside surviving messages and removes thinking-only ones", () => {
    const out = filterMessagesByVerbose(corpus, "normal");
    // The thinking-only message is gone; everything else survives.
    expect(out.map((m) => m.uuid)).toEqual([u1.uuid, a1.uuid, a2_toolOnly.uuid, u2.uuid]);
    // a1's thinking block is removed; text + tool_use survive.
    const a1Out = out.find((m) => m.uuid === a1.uuid)!;
    expect(a1Out.blocks.map((b) => b.kind)).toEqual(["text", "tool_use", "text"]);
  });

  test("compact keeps users and text-only assistants", () => {
    const out = filterMessagesByVerbose(corpus, "compact");
    // u1, a1 (after filter — has text), u2.  a2/a3 disappear.
    expect(out.map((m) => m.uuid)).toEqual([u1.uuid, a1.uuid, u2.uuid]);
    const a1Out = out.find((m) => m.uuid === a1.uuid)!;
    expect(a1Out.blocks.every((b) => b.kind === "text")).toBe(true);
    expect(a1Out.blocks).toHaveLength(2);
  });

  test("preserves referential identity when no filtering removes anything", () => {
    // An all-text corpus shouldn't allocate new message objects at any
    // level — important because MessageList's `useMemo(turns, [visible])`
    // re-computes when the array identity flips.
    const textOnly: DisplayMessage[] = [
      msg("user", [block("text")]),
      msg("assistant", [block("text"), block("text")]),
    ];
    const compact = filterMessagesByVerbose(textOnly, "compact");
    expect(compact).toHaveLength(2);
    // Each surviving message kept its block-array identity (nothing was
    // filtered out of the blocks), so the message itself wasn't cloned.
    expect(compact[0]).toBe(textOnly[0]);
    expect(compact[1]).toBe(textOnly[1]);
  });

  test("an empty input list returns an empty list at every level", () => {
    for (const l of VERBOSE_LEVELS) {
      expect(filterMessagesByVerbose([], l)).toEqual([]);
    }
  });

  test("never mutates the input", () => {
    const snapshot = JSON.parse(JSON.stringify(corpus));
    for (const l of VERBOSE_LEVELS) filterMessagesByVerbose(corpus, l);
    expect(JSON.parse(JSON.stringify(corpus))).toEqual(snapshot);
  });

  test("ordering is stable — survivors keep their relative order", () => {
    const ordered: DisplayMessage[] = [
      msg("user", [block("text", { text: "a" })]),
      msg("assistant", [block("text", { text: "b" })]),
      msg("user", [block("text", { text: "c" })]),
      msg("assistant", [block("thinking")]), // dropped at compact/normal
      msg("assistant", [block("text", { text: "d" })]),
    ];
    for (const l of ["normal", "compact"] as const) {
      const out = filterMessagesByVerbose(ordered, l);
      const labels = out.map((m) =>
        m.blocks.find((b) => b.kind === "text") ? (m.blocks.find((b) => b.kind === "text") as { text: string }).text : "?",
      );
      expect(labels).toEqual(["a", "b", "c", "d"]);
    }
  });

  test("a turn whose assistant content fully drops still keeps the prior user prompt", () => {
    // Regression guard: filtering the assistant out must NOT also remove
    // the user message that opened the turn — the conversation should
    // still show the question even if the answer was all tool_use.
    const turn: DisplayMessage[] = [
      msg("user", [block("text", { text: "run ls" })]),
      msg("assistant", [block("tool_use", { name: "Bash" })]),
    ];
    const out = filterMessagesByVerbose(turn, "compact");
    expect(out).toHaveLength(1);
    expect(out[0].role).toBe("user");
  });
});

describe("ultra-verbose (extra verbose)", () => {
  const all: DisplayBlock[] = [
    block("text", { text: "a" }),
    block("thinking", { text: "t" }),
    block("tool_use", { name: "Bash" }),
  ];

  test("filterAssistantBlocks returns the input unchanged (referential identity)", () => {
    const out = filterAssistantBlocks(all, "ultra-verbose");
    expect(out).toBe(all);
  });

  test("filterMessagesByVerbose returns the input reference unchanged", () => {
    const corpus = [msg("user", [block("text")]), msg("assistant", all)];
    expect(filterMessagesByVerbose(corpus, "ultra-verbose")).toBe(corpus);
  });

  test("never hides an assistant message", () => {
    expect(isMessageHiddenAtLevel(msg("assistant", []), "ultra-verbose")).toBe(false);
    expect(
      isMessageHiddenAtLevel(msg("assistant", [block("tool_use")]), "ultra-verbose"),
    ).toBe(false);
  });

  test("shouldExpandAllBlocks is true ONLY for ultra-verbose", () => {
    expect(shouldExpandAllBlocks("ultra-verbose")).toBe(true);
    for (const l of VERBOSE_LEVELS) {
      if (l !== "ultra-verbose") expect(shouldExpandAllBlocks(l)).toBe(false);
    }
  });
});

describe("ultra-compact (extra compact)", () => {
  test("block filter is text-only, same as compact", () => {
    const blocks = [
      block("text", { text: "keep me" }),
      block("thinking"),
      block("tool_use"),
    ];
    const out = filterAssistantBlocks(blocks, "ultra-compact");
    expect(out.map((b) => b.kind)).toEqual(["text"]);
  });

  test("collapses each turn to the prompt + final assistant message", () => {
    const u1 = msg("user", [block("text", { text: "q1" })]);
    const a1a = msg("assistant", [block("text", { text: "thinking out loud" })]);
    const a1b = msg("assistant", [block("text", { text: "the answer" })]);
    const u2 = msg("user", [block("text", { text: "q2" })]);
    const a2 = msg("assistant", [block("text", { text: "second answer" })]);
    const out = filterMessagesByVerbose([u1, a1a, a1b, u2, a2], "ultra-compact");
    // Turn 1: u1 + only a1b (a1a, the intermediate, is dropped). Turn 2: u2 + a2.
    expect(out.map((m) => m.uuid)).toEqual([u1.uuid, a1b.uuid, u2.uuid, a2.uuid]);
  });

  test("an assistant message that fully filters out doesn't count as the turn's last", () => {
    const u1 = msg("user", [block("text", { text: "q" })]);
    const aText = msg("assistant", [block("text", { text: "real answer" })]);
    const aToolOnly = msg("assistant", [block("tool_use")]); // drops to empty at compact
    const out = filterMessagesByVerbose([u1, aText, aToolOnly], "ultra-compact");
    // aToolOnly is removed by the block pass, so the surviving "last" is aText.
    expect(out.map((m) => m.uuid)).toEqual([u1.uuid, aText.uuid]);
  });

  test("keeps a leading assistant prelude's last message (no opening user)", () => {
    const a1 = msg("assistant", [block("text", { text: "first" })]);
    const a2 = msg("assistant", [block("text", { text: "last" })]);
    const u = msg("user", [block("text", { text: "hi" })]);
    const out = filterMessagesByVerbose([a1, a2, u], "ultra-compact");
    expect(out.map((m) => m.uuid)).toEqual([a2.uuid, u.uuid]);
  });

  test("hides the assistant turn entirely when its only message filters out", () => {
    const u = msg("user", [block("text", { text: "run ls" })]);
    const a = msg("assistant", [block("tool_use", { name: "Bash" })]);
    const out = filterMessagesByVerbose([u, a], "ultra-compact");
    expect(out.map((m) => m.uuid)).toEqual([u.uuid]);
  });
});

describe("isSystemEntryHiddenAtLevel", () => {
  function sys(kind: SystemEntry["kind"]): SystemEntry {
    return { uuid: "s1", afterMessageUuid: "", kind, label: `${kind}` };
  }

  test("status pills are hidden at compact and ultra-compact", () => {
    expect(isSystemEntryHiddenAtLevel("status", "compact")).toBe(true);
    expect(isSystemEntryHiddenAtLevel("status", "ultra-compact")).toBe(true);
  });

  test("status pills survive at normal / verbose / ultra-verbose", () => {
    expect(isSystemEntryHiddenAtLevel("status", "normal")).toBe(false);
    expect(isSystemEntryHiddenAtLevel("status", "verbose")).toBe(false);
    expect(isSystemEntryHiddenAtLevel("status", "ultra-verbose")).toBe(false);
  });

  test("system_reminder pills are hidden at compact and ultra-compact", () => {
    expect(isSystemEntryHiddenAtLevel("system_reminder", "compact")).toBe(true);
    expect(isSystemEntryHiddenAtLevel("system_reminder", "ultra-compact")).toBe(true);
  });

  test("system_reminder pills survive at normal / verbose / ultra-verbose", () => {
    expect(isSystemEntryHiddenAtLevel("system_reminder", "normal")).toBe(false);
    expect(isSystemEntryHiddenAtLevel("system_reminder", "verbose")).toBe(false);
    expect(isSystemEntryHiddenAtLevel("system_reminder", "ultra-verbose")).toBe(false);
  });

  test("other pills are never hidden at any level", () => {
    const others: SystemEntry["kind"][] = [
      "init",
      "hook_started",
      "hook_response",
      "compact_boundary",
      "rate_limit",
      "api_retry",
      "permission_denied",
      "info",
    ];
    for (const kind of others) {
      for (const l of VERBOSE_LEVELS) {
        expect(isSystemEntryHiddenAtLevel(sys(kind).kind, l)).toBe(false);
      }
    }
  });
});

describe("level membership", () => {
  test("VERBOSE_LEVELS contains exactly the five documented levels, least→most verbose", () => {
    expect(VERBOSE_LEVELS).toEqual([
      "ultra-compact",
      "compact",
      "normal",
      "verbose",
      "ultra-verbose",
    ]);
  });

  test("exhaustiveness: filterAssistantBlocks handles every published level", () => {
    // Defensive — if someone adds a fourth level without updating the
    // switch, TypeScript would flag it but we also assert at runtime so
    // that a stray cast can't slip past.
    for (const l of VERBOSE_LEVELS) {
      expect(() => filterAssistantBlocks([], l as VerboseLevel)).not.toThrow();
      expect(() => isMessageHiddenAtLevel(msg("assistant", []), l as VerboseLevel)).not.toThrow();
    }
  });
});
