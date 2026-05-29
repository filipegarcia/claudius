import { describe, expect, test } from "vitest";

import { DEFAULT_TIPS, nextTipIndex, selectTips } from "@/lib/shared/tips";
import { findSlashCommand } from "@/lib/shared/slash-commands";

describe("nextTipIndex", () => {
  test("advances and wraps", () => {
    expect(nextTipIndex(0, 3)).toBe(1);
    expect(nextTipIndex(1, 3)).toBe(2);
    expect(nextTipIndex(2, 3)).toBe(0);
  });

  test("cycles through every index exactly once before repeating", () => {
    const count = 5;
    const seen = new Set<number>();
    let i = 0;
    for (let n = 0; n < count; n++) {
      seen.add(i);
      i = nextTipIndex(i, count);
    }
    expect(seen.size).toBe(count);
    expect(i).toBe(0); // back to start
  });

  test("survives garbage input from a bad feed", () => {
    expect(nextTipIndex(0, 0)).toBe(0);
    expect(nextTipIndex(NaN, 3)).toBe(1);
    expect(nextTipIndex(-1, 3)).toBe(0);
    expect(nextTipIndex(99, 3)).toBe(1); // 99 % 3 === 0 → next is 1
  });
});

describe("DEFAULT_TIPS", () => {
  test("ids are unique", () => {
    const ids = DEFAULT_TIPS.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test("every command resolves to a real, non-destructive slash command", () => {
    // Tips can be clicked mid-turn, so their commands must not mutate or
    // destroy the session (no clear/compact/fork/rename/etc.).
    const destructive = new Set(["clear", "compact", "fork", "rename", "exit", "rewind"]);
    for (const tip of DEFAULT_TIPS) {
      if (!tip.command) continue;
      const cmd = findSlashCommand(tip.command);
      expect(cmd, `tip "${tip.id}" → /${tip.command}`).toBeTruthy();
      expect(destructive.has(tip.command), `tip "${tip.id}" is destructive`).toBe(false);
    }
  });
});

describe("selectTips", () => {
  test("returns the full catalog when no availability list is given", () => {
    expect(selectTips()).toBe(DEFAULT_TIPS);
    expect(selectTips({})).toBe(DEFAULT_TIPS);
  });

  test("drops command tips whose command isn't available, keeps command-less ones", () => {
    const onlyAgents = selectTips({ availableCommands: ["agents"] });
    // Every surviving tip either has no command or a command in the list.
    for (const tip of onlyAgents) {
      if (tip.command) expect(tip.command).toBe("agents");
    }
    // The /mcp tip is gated out; the /agents tip stays.
    expect(onlyAgents.some((t) => t.command === "agents")).toBe(true);
    expect(onlyAgents.some((t) => t.command === "mcp")).toBe(false);
  });

  test("empty availability list gates out all command tips", () => {
    const none = selectTips({ availableCommands: [] });
    expect(none.every((t) => !t.command)).toBe(true);
  });
});
