import { describe, expect, test } from "vitest";

import {
  DEFAULT_TIPS,
  DISMISSED_TIP_SHOW_PROBABILITY,
  nextTipIndex,
  nextTipIndexWithDismissals,
  selectClientTips,
  selectTips,
} from "@/lib/shared/tips";
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

describe("nextTipIndexWithDismissals", () => {
  const tips = [
    { id: "a" },
    { id: "b" },
    { id: "c" },
    { id: "d" },
  ];

  test("behaves like nextTipIndex when nothing is dismissed", () => {
    const rng = () => 0; // would let any dismissed tip through
    expect(nextTipIndexWithDismissals(0, tips, new Set(), rng)).toBe(1);
    expect(nextTipIndexWithDismissals(3, tips, new Set(), rng)).toBe(0);
  });

  test("skips a dismissed tip when rng says skip", () => {
    // Show probability is 0.2, so a roll of 0.5 means "skip past this one".
    const rng = () => 0.5;
    // Starting at index 0 → next would be 1; "b" is dismissed, so skip to 2.
    expect(nextTipIndexWithDismissals(0, tips, new Set(["b"]), rng)).toBe(2);
    // Two dismissed in a row: rotation lands on b, skips, lands on c, skips,
    // lands on d (not dismissed) → returns 3.
    expect(nextTipIndexWithDismissals(0, tips, new Set(["b", "c"]), rng)).toBe(3);
  });

  test("lets a dismissed tip through with probability ~0.2", () => {
    // A roll below the show threshold means "show this dismissed tip anyway".
    const rng = () => DISMISSED_TIP_SHOW_PROBABILITY / 2; // 0.1
    expect(nextTipIndexWithDismissals(0, tips, new Set(["b"]), rng)).toBe(1);
  });

  test("when every tip is dismissed, falls back to the next index instead of looping forever", () => {
    const rng = () => 0.5; // would always skip
    const all = new Set(tips.map((t) => t.id));
    const result = nextTipIndexWithDismissals(0, tips, all, rng);
    // After lapping without finding a non-dismissed tip, returns wherever the
    // walk ended — still a valid index, just to keep the rotation moving.
    expect(result).toBeGreaterThanOrEqual(0);
    expect(result).toBeLessThan(tips.length);
  });

  test("survives empty list", () => {
    expect(nextTipIndexWithDismissals(0, [], new Set(["b"]))).toBe(0);
  });
});

describe("selectClientTips", () => {
  const tips = [
    { id: "always", text: "always shown" },
    { id: "two-plus", text: "needs two sessions", minSessions: 2 },
    { id: "five-plus", text: "needs five sessions", minSessions: 5 },
  ];

  test("keeps unconditional tips at every session count", () => {
    for (const n of [0, 1, 2, 99]) {
      expect(selectClientTips(tips, n).some((t) => t.id === "always")).toBe(true);
    }
  });

  test("drops the multi-session tip below the threshold and surfaces it above", () => {
    const oneSession = selectClientTips(tips, 1);
    expect(oneSession.map((t) => t.id)).not.toContain("two-plus");
    const twoSessions = selectClientTips(tips, 2);
    expect(twoSessions.map((t) => t.id)).toContain("two-plus");
    expect(twoSessions.map((t) => t.id)).not.toContain("five-plus");
  });

  test("the bundled multi-claude tip is gated at 2+ sessions", () => {
    const tip = DEFAULT_TIPS.find((t) => t.id === "multi-claude-color-rename");
    expect(tip).toBeTruthy();
    expect(tip?.minSessions).toBe(2);
    expect(selectClientTips(DEFAULT_TIPS, 1).find((t) => t.id === tip!.id)).toBeUndefined();
    expect(selectClientTips(DEFAULT_TIPS, 2).find((t) => t.id === tip!.id)).toBeTruthy();
  });

  test("drops the plan-mode nudge tip by default", () => {
    const planTip = { id: "plan", text: "make it sticky", requiresPlanModeNudge: true };
    expect(selectClientTips([planTip], 1).map((t) => t.id)).not.toContain("plan");
    expect(
      selectClientTips([planTip], 1, { planModeNudgeEligible: false }).map((t) => t.id),
    ).not.toContain("plan");
  });

  test("surfaces the plan-mode nudge tip only when eligible", () => {
    const planTip = { id: "plan", text: "make it sticky", requiresPlanModeNudge: true };
    expect(
      selectClientTips([planTip], 1, { planModeNudgeEligible: true }).map((t) => t.id),
    ).toContain("plan");
  });

  test("the bundled default-permission-mode-config tip is gated on planModeNudgeEligible", () => {
    const tip = DEFAULT_TIPS.find((t) => t.id === "default-permission-mode-config");
    expect(tip).toBeTruthy();
    expect(tip?.requiresPlanModeNudge).toBe(true);
    // Hidden by default and when explicitly ineligible.
    expect(
      selectClientTips(DEFAULT_TIPS, 1).find((t) => t.id === tip!.id),
    ).toBeUndefined();
    expect(
      selectClientTips(DEFAULT_TIPS, 1, { planModeNudgeEligible: false }).find(
        (t) => t.id === tip!.id,
      ),
    ).toBeUndefined();
    // Surfaces once the caller flags the user as eligible.
    expect(
      selectClientTips(DEFAULT_TIPS, 1, { planModeNudgeEligible: true }).find(
        (t) => t.id === tip!.id,
      ),
    ).toBeTruthy();
  });

  test("drops the new-user tip by default", () => {
    const onboardingTip = { id: "powerup", text: "run /powerup", requiresNewUser: true };
    expect(selectClientTips([onboardingTip], 1).map((t) => t.id)).not.toContain("powerup");
    expect(
      selectClientTips([onboardingTip], 1, { newUser: false }).map((t) => t.id),
    ).not.toContain("powerup");
  });

  test("surfaces the new-user tip only when newUser is true", () => {
    const onboardingTip = { id: "powerup", text: "run /powerup", requiresNewUser: true };
    expect(
      selectClientTips([onboardingTip], 1, { newUser: true }).map((t) => t.id),
    ).toContain("powerup");
  });

  test("the bundled powerup-onboarding tip is gated on newUser", () => {
    const tip = DEFAULT_TIPS.find((t) => t.id === "powerup-onboarding");
    expect(tip).toBeTruthy();
    expect(tip?.requiresNewUser).toBe(true);
    // Hidden by default and when explicitly ineligible.
    expect(
      selectClientTips(DEFAULT_TIPS, 1).find((t) => t.id === tip!.id),
    ).toBeUndefined();
    expect(
      selectClientTips(DEFAULT_TIPS, 1, { newUser: false }).find((t) => t.id === tip!.id),
    ).toBeUndefined();
    // Surfaces once the caller flags the user as new.
    expect(
      selectClientTips(DEFAULT_TIPS, 1, { newUser: true }).find((t) => t.id === tip!.id),
    ).toBeTruthy();
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

  test("spinnerTipsEnabled:false disables the rotation entirely", () => {
    expect(selectTips({ spinnerTipsEnabled: false })).toEqual([]);
    // Still empty even with an override supplied — disabled wins.
    expect(
      selectTips({
        spinnerTipsEnabled: false,
        spinnerTipsOverride: { tips: ["custom"] },
      }),
    ).toEqual([]);
  });

  test("spinnerTipsOverride appends custom tips by default", () => {
    const result = selectTips({
      spinnerTipsOverride: { tips: ["First custom", "Second custom"] },
    });
    expect(result).not.toBe(DEFAULT_TIPS);
    // Defaults are preserved at the head, custom tips appended at the tail.
    expect(result.slice(0, DEFAULT_TIPS.length)).toEqual(DEFAULT_TIPS);
    expect(result[DEFAULT_TIPS.length]).toEqual({
      id: "custom-tip-0",
      text: "First custom",
    });
    expect(result[DEFAULT_TIPS.length + 1]).toEqual({
      id: "custom-tip-1",
      text: "Second custom",
    });
  });

  test("spinnerTipsOverride with excludeDefault:true replaces the catalog", () => {
    const result = selectTips({
      spinnerTipsOverride: { excludeDefault: true, tips: ["Only this"] },
    });
    expect(result).toEqual([{ id: "custom-tip-0", text: "Only this" }]);
  });

  test("spinnerTipsOverride with excludeDefault:true and no tips opts out of every built-in", () => {
    // Mirrors the CLI shape: the user has deliberately silenced the default
    // rotation without supplying replacements.
    expect(
      selectTips({ spinnerTipsOverride: { excludeDefault: true } }),
    ).toEqual([]);
    expect(
      selectTips({ spinnerTipsOverride: { excludeDefault: true, tips: [] } }),
    ).toEqual([]);
  });

  test("spinnerTipsOverride trims and drops empty entries", () => {
    const result = selectTips({
      spinnerTipsOverride: { excludeDefault: true, tips: ["  padded  ", "", "   "] },
    });
    expect(result).toEqual([{ id: "custom-tip-0", text: "padded" }]);
  });

  test("availableCommands gating composes with override append", () => {
    const result = selectTips({
      availableCommands: ["agents"],
      spinnerTipsOverride: { tips: ["Custom"] },
    });
    // No /mcp tip (gated), /agents tip present, custom tip at the tail.
    expect(result.some((t) => t.command === "mcp")).toBe(false);
    expect(result.some((t) => t.command === "agents")).toBe(true);
    expect(result[result.length - 1]).toEqual({ id: "custom-tip-0", text: "Custom" });
  });
});
