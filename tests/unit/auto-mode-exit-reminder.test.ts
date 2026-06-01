import { describe, expect, test } from "vitest";

import { autoModeExitReminderBody } from "@/lib/server/session";

/**
 * Auto-mode exit reminder (Claude Code TUI parity, feature 34).
 *
 * Pure-helper coverage. The Session-side integration (gate the queueReminder
 * call in `setPermissionMode` on an `auto -> non-auto` transition) lives in
 * `lib/server/session.ts` and exercises the wider Session lifecycle; what
 * we pin here is the literal prose the model receives. The CLI's
 * "## Exited Auto Mode" header and "ask clarifying questions when the
 * approach is ambiguous" wording are load-bearing — a silent reword would
 * diverge from the parity surface the spec documents.
 */
describe("autoModeExitReminderBody", () => {
  test("emits the CLI's verbatim exit header", () => {
    const body = autoModeExitReminderBody();
    expect(body).toContain("## Exited Auto Mode");
    expect(body).toContain("You have exited auto mode.");
  });

  test("steers the model back toward asking clarifying questions", () => {
    // The whole point of the reminder is loosening the assumption-making
    // posture auto-accept encourages. If we ever quietly drop this clause
    // the model will keep barreling ahead after the user pulls back.
    const body = autoModeExitReminderBody();
    expect(body).toMatch(/clarifying questions/i);
    expect(body).toMatch(/rather than making assumptions/i);
  });
});
