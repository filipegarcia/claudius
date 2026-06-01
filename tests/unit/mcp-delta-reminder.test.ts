import { describe, expect, test } from "vitest";

import { mcpDeltaReminderBody } from "@/lib/server/session";

/**
 * MCP delta reminder (Claude Code TUI parity, feature 35).
 *
 * Pure-helper coverage. The Session-side integration (queueing the reminder
 * from `Session.reconnectMcp` / `toggleMcp` / `setMcpServers` so the next
 * user turn drains it) lives in `lib/server/session.ts` and exercises the
 * wider Session lifecycle; what we pin here is the literal prose the model
 * receives. The CLI's "wait for connecting servers and search their tools
 * once available; do not report a capability as unavailable without first
 * searching" guidance is load-bearing — it turns the pending-status race
 * after a reconnect into correct behavior. A silent reword would diverge
 * from the parity surface the spec documents.
 */
describe("mcpDeltaReminderBody", () => {
  test("returns null for an empty delta", () => {
    expect(mcpDeltaReminderBody({})).toBeNull();
    expect(
      mcpDeltaReminderBody({ added: [], removed: [], disabled: [], reconnecting: [] }),
    ).toBeNull();
  });

  test("drops empty-string entries that would otherwise fire a no-op clause", () => {
    // A defensive guard — the upstream callers pass through SDK strings and
    // user-supplied names, both of which could be empty in a degenerate
    // case. We don't want a "now available: ." bullet leaking through.
    expect(mcpDeltaReminderBody({ added: [""] })).toBeNull();
  });

  test("names added servers and carries the CLI's wait-and-search guidance", () => {
    const body = mcpDeltaReminderBody({ added: ["linear", "slack"] });
    expect(body).not.toBeNull();
    const text = body as string;
    expect(text).toContain("The following MCP servers are now available: linear, slack.");
    // Load-bearing CLI guidance — present on every non-null body.
    expect(text).toContain(
      "Wait for connecting servers and search their tools once available.",
    );
    expect(text).toContain(
      "Do not report a capability as unavailable without first searching.",
    );
  });

  test("distinguishes disabled (user toggled off) from removed (dropped from session)", () => {
    // The two unavailability flavors carry different remediations — a
    // disabled server can be flipped back on, a removed one needs to be
    // re-added. Surface both reasons explicitly so the model picks the
    // right framing if it has to mention it (the wait-and-search clause
    // tells it not to declare anything unavailable on a stale view).
    const disabledBody = mcpDeltaReminderBody({ disabled: ["postgres"] });
    expect(disabledBody).toContain("disabled by the user");
    expect(disabledBody).toContain("postgres");

    const removedBody = mcpDeltaReminderBody({ removed: ["postgres"] });
    expect(removedBody).toContain("removed from this session");
    expect(removedBody).toContain("postgres");
  });

  test("flags reconnecting servers as may-still-be-connecting", () => {
    // Reconnect kicks the connection but the SDK status can still be
    // `pending` right after — the reminder must NOT assert the server is
    // ready, only that it was reconnected. The wait-and-search clause
    // then turns the race into correct behavior.
    const body = mcpDeltaReminderBody({ reconnecting: ["github"] });
    expect(body).toContain("github");
    expect(body).toContain("may still be connecting");
  });

  test("emits multiple clauses in one block when several deltas apply at once", () => {
    // setMcpServers can add and remove in a single call — the body must
    // surface both halves rather than picking one and dropping the other.
    const body = mcpDeltaReminderBody({
      added: ["linear"],
      removed: ["slack"],
    });
    expect(body).toContain("linear");
    expect(body).toContain("slack");
    expect(body).toContain("now available");
    expect(body).toContain("no longer available");
  });
});
