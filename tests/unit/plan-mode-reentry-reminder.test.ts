import { describe, expect, test } from "vitest";

import { planModeReentryReminderBody } from "@/lib/server/session";

/**
 * Plan-mode re-entry reminder (Claude Code TUI parity, feature 33).
 *
 * Pure-helper coverage. The Session-side integration (persist the resolved
 * plan via `mergeSessionState` in `resolvePlan`, trigger in
 * `setPermissionMode` on a non-plan -> plan transition) lives in
 * `lib/server/session.ts` and exercises the wider Session lifecycle; what
 * we pin here is the literal prose the model receives. The CLI's
 * "## Re-entering Plan Mode" header and "You are returning to plan mode
 * after having previously exited it" wording are load-bearing — a silent
 * reword would diverge from the parity surface the spec documents.
 */
describe("planModeReentryReminderBody", () => {
  test("emits the CLI's verbatim re-entry header + plan inline", () => {
    const prior = "1. Refactor session.ts\n2. Add tests";
    const body = planModeReentryReminderBody(prior);
    expect(body).toContain("## Re-entering Plan Mode");
    expect(body).toContain(
      "You are returning to plan mode after having previously exited it.",
    );
    // The body inlines the prior plan instead of pointing at an on-disk
    // path — Claudius has no `H.planFilePath`, so we hand the model the
    // text directly.
    expect(body).toContain("Previous plan:");
    expect(body).toContain("1. Refactor session.ts");
    expect(body).toContain("2. Add tests");
  });

  test("steers the model to treat the new round as a fresh planning session", () => {
    // The CLI's reminder discourages assuming the old plan still holds —
    // dropping that framing would make the agent quietly resume the prior
    // plan even when the user explicitly re-entered to start over.
    const body = planModeReentryReminderBody("…");
    expect(body).toMatch(/fresh planning round/i);
  });
});
