import { describe, expect, test } from "vitest";

import { ultrathinkReminderBody } from "@/lib/server/session";

/**
 * Boundary behavior for the `\bultrathink\b` prose-keyword detector that
 * triggers the per-turn deeper-reasoning `<system-reminder>` (Claude Code
 * TUI parity, feature 27). The detector must:
 *   - match the bare word in any case;
 *   - reject extensions like `ultrathinking` / `ultrathinker` (those would be
 *     unrelated words containing the substring);
 *   - return a stable body so the wire format stays diffable across edits.
 *
 * The helper is pure — no Session lifecycle involved — so we exercise it
 * directly. The integration with `queueReminder` is covered transitively by
 * the existing `system-reminders.test.ts`.
 */

describe("ultrathinkReminderBody", () => {
  test("returns a stable body when the bare word appears", () => {
    const body = ultrathinkReminderBody("please ultrathink this problem");
    expect(body).not.toBeNull();
    expect(body).toContain("ultrathink");
    expect(body).toContain("deeper reasoning");
  });

  test("matches case-insensitively", () => {
    expect(ultrathinkReminderBody("Ultrathink the design")).not.toBeNull();
    expect(ultrathinkReminderBody("ULTRATHINK this")).not.toBeNull();
  });

  test("matches across word boundaries (start, end, punctuation)", () => {
    expect(ultrathinkReminderBody("ultrathink")).not.toBeNull();
    expect(ultrathinkReminderBody("ok ultrathink.")).not.toBeNull();
    expect(ultrathinkReminderBody("(ultrathink)")).not.toBeNull();
  });

  test("rejects extensions that just contain the substring", () => {
    // `\b` denies these — they're distinct words, not the keyword the TUI
    // grounds the nudge on.
    expect(ultrathinkReminderBody("she is ultrathinking it")).toBeNull();
    expect(ultrathinkReminderBody("the ultrathinker decided")).toBeNull();
    expect(ultrathinkReminderBody("preultrathink mode")).toBeNull();
  });

  test("returns null when the keyword is absent", () => {
    expect(ultrathinkReminderBody("")).toBeNull();
    expect(ultrathinkReminderBody("just a normal prompt")).toBeNull();
    expect(ultrathinkReminderBody("think deeply about this")).toBeNull();
  });
});
