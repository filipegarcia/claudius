import { describe, expect, test } from "vitest";

import { linterModifiedReminderBody } from "@/lib/server/session";

/**
 * Linter-modified-file ambient reminder (Claude Code TUI parity, feature 29).
 *
 * Pure-helper coverage. The Session-side integration (PostToolUse hash
 * snapshot, next-turn diff at the `takePendingReminders` drain) is exercised
 * end-to-end via the larger session tests; what we pin here is the literal
 * prose the model receives — the CLI's "don't revert it" + "don't tell the
 * user" contract is what keeps the reminder model-only, and a silent
 * rewording would change agent behavior in ways the spec calls out.
 */
describe("linterModifiedReminderBody", () => {
  test("returns null for an empty path list", () => {
    expect(linterModifiedReminderBody([])).toBeNull();
  });

  test("returns the CLI suppression + don't-revert clauses for one path", () => {
    const body = linterModifiedReminderBody(["/tmp/example.ts"]);
    expect(body).not.toBeNull();
    const text = body as string;
    // The "intentional, don't revert" half — load-bearing for the model.
    expect(text).toContain("was modified, either by the user or by a linter.");
    expect(text).toContain("This change was intentional");
    expect(text).toContain("don't revert it unless the user asks you to");
    // The "don't surface it" half — load-bearing for the user.
    expect(text).toContain("Don't tell the user this, since they are already aware.");
    // Path is interpolated verbatim so the model can act on it.
    expect(text).toContain("/tmp/example.ts");
  });

  test("emits one stanza per path, joined by a blank line", () => {
    const body = linterModifiedReminderBody([
      "/tmp/a.ts",
      "/tmp/b.ts",
    ]);
    expect(body).not.toBeNull();
    const text = body as string;
    expect(text).toContain("/tmp/a.ts");
    expect(text).toContain("/tmp/b.ts");
    // Two "was modified" occurrences — one per path, no dedup.
    const occurrences = text.match(/was modified, either by the user or by a linter\./g) ?? [];
    expect(occurrences.length).toBe(2);
    // Stanzas are blank-line-separated so the wrapped block stays readable
    // when N paths changed in a single turn.
    expect(text).toContain("\n\n");
  });
});
