import { describe, expect, test } from "vitest";

import { verifyPlanReminderBody } from "@/lib/server/session";

/**
 * Verify-plan reminder (Claude Code TUI parity, feature 39).
 *
 * Pure-helper coverage. The Session-side integration (set the
 * `planAwaitingVerify` flag in `resolvePlan`'s accept branch, drain it in
 * `consume()` at the first `result` boundary after execution) lives in
 * `lib/server/session.ts` and rides the wider Session lifecycle; what we
 * pin here is the literal prose the model receives. The CLI's
 * "You have completed implementing the plan." opener and the
 * "NOT…Task tool or…subagent" delegate-ban clause are load-bearing —
 * a silent reword would either drop the parity surface (verify-step
 * directive) or quietly re-enable sub-agent delegation, which is exactly
 * what this reminder exists to prevent.
 */
describe("verifyPlanReminderBody", () => {
  test("emits the CLI's verbatim plan-completion opener", () => {
    const body = verifyPlanReminderBody();
    expect(body).toContain("You have completed implementing the plan.");
    // The verify-correctly clause survives the binary-string adaptation
    // intact — it's the actual action the reminder asks for.
    expect(body).toMatch(/verify that all plan items were completed correctly/i);
  });

  test("forbids handing verification off to the Task tool or a subagent", () => {
    // The whole point of the reminder is keeping verification in the parent
    // context. If this clause ever quietly disappears, the model will start
    // spawning fresh sub-agents that lose the plan's grounding — exactly
    // the failure mode the CLI's reminder was written to prevent.
    const body = verifyPlanReminderBody();
    expect(body).toMatch(/NOT via the Task tool or a subagent/);
  });
});
