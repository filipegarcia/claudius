import { describe, expect, test } from "vitest";

import { staleTodoReminderBody } from "@/lib/server/session";

/**
 * Stale-TodoWrite gentle nudge (Claude Code TUI parity, feature 31).
 *
 * Pure-helper coverage. The Session-side integration (turn counter,
 * reset on TodoWrite tool_use, queue on threshold crossing) lives in
 * `Session.sendInput` / `captureSnapshotState` and is exercised through
 * the larger session paths; what we pin here is the literal prose the
 * model receives. The CLI's "gentle reminder — ignore if not applicable"
 * wording is load-bearing: a silent reword would tilt the agent toward
 * acting on every nudge rather than treating it as optional advice.
 */
describe("staleTodoReminderBody", () => {
  test("emits the CLI's gentle-reminder prose for an empty todo list", () => {
    const body = staleTodoReminderBody([]);
    expect(body).toContain("The TodoWrite tool hasn't been used recently.");
    expect(body).toContain("consider using the TodoWrite tool to track progress");
    expect(body).toContain("Also consider cleaning up the todo list");
    expect(body).toContain("Only use it if it's relevant to the current work.");
    // The "ignore if not applicable" tail is what keeps the nudge low-pressure;
    // missing it would make the reminder feel mandatory.
    expect(body).toContain(
      "This is just a gentle reminder - ignore if not applicable.",
    );
    // No "Current todos" dump when the list is empty — the prose alone covers
    // the "consider starting to track" half.
    expect(body).not.toContain("Current todos");
  });

  test("appends a JSON dump of the current todos when the list is non-empty", () => {
    const todos = [
      { id: "1", content: "Refactor session.ts", status: "in_progress" },
      { id: "2", content: "Write tests", status: "pending" },
    ];
    const body = staleTodoReminderBody(todos);
    expect(body).toContain("This is just a gentle reminder - ignore if not applicable.");
    // The dump is what lets the model prune *specific* stale entries — the
    // prose alone gives no handle on individual items.
    expect(body).toContain("Current todos:");
    expect(body).toContain("Refactor session.ts");
    expect(body).toContain("Write tests");
    // JSON shape is the stable wire format for any follow-up TodoWrite call.
    expect(body).toContain('"id": "1"');
    expect(body).toContain('"status": "in_progress"');
  });

  test("never returns null — the firing decision belongs to the caller", () => {
    // The body is always advisory; whether to *queue* it is a Session-level
    // policy decision (the turn counter). Returning null here would force
    // the caller to re-decide and would diverge from the linter-modified
    // helper's null-on-no-paths shape without good reason.
    expect(typeof staleTodoReminderBody([])).toBe("string");
    expect(typeof staleTodoReminderBody([{ id: "x", content: "y", status: "pending" }])).toBe(
      "string",
    );
  });
});
