import { describe, expect, test } from "vitest";

import { midturnInjectReminderBody } from "@/lib/server/session";
import {
  pendingReminderCount,
  queueReminder,
  takePendingReminders,
} from "@/lib/server/system-reminders";

/**
 * Prose + queue contract for the mid-turn user inject reminder (Claude Code
 * TUI parity, feature 37). The helper is a frozen-constant body — like
 * `autoModeExitReminderBody` — so the test pins the literal wording and the
 * deviations the doc comment calls out:
 *   - "below" / "that follows" (NOT the CLI's "above") because Claudius
 *     prepends the reminder, so the user's text lands below the wrapper.
 *   - "MUST address" + "Do not ignore it" carry the forceful nudge.
 *   - Explicit "the user has NOT acknowledged" marker so the model doesn't
 *     interpret the late inject as a fresh user ack.
 * Plus a queue smoke through `queueReminder` / `takePendingReminders` so the
 * canonical `<system-reminder>` wrapper still applies — no special-case path
 * for this kind, just the shared channel.
 */

describe("midturnInjectReminderBody", () => {
  test("returns a stable body with the forceful MUST address directive", () => {
    const body = midturnInjectReminderBody();
    expect(body).toContain("MUST");
    expect(body).toContain("address");
    expect(body).toContain("Do not ignore it");
  });

  test("phrases position relative to the user's text as 'follows' (not 'above')", () => {
    // Claudius prepends the reminder, so the CLI's "address the message
    // above" wording would be backwards. The body must point DOWN to the
    // user's text, not up.
    const body = midturnInjectReminderBody();
    expect(body).toContain("follows");
    expect(body).not.toContain("above");
  });

  test("marks itself as automated and explicitly NOT a user acknowledgement", () => {
    // The reminder fires when the user sends a late message — the model
    // could mistake the inject for a fresh ack of completed work. The
    // marker text rules that out.
    const body = midturnInjectReminderBody();
    expect(body).toContain("automated");
    expect(body).toContain("NOT acknowledged");
  });

  test("does NOT use peer/coordinator framing ('not from the user')", () => {
    // The human variant — which is what Claudius implements — is genuinely
    // from the user; only the directive is automated. The peer/coordinator
    // wording would mislabel the source.
    const body = midturnInjectReminderBody();
    expect(body).not.toMatch(/not.*from.*the user/i);
    expect(body).not.toContain("another Claude");
  });
});

describe("midturn-inject queue integration", () => {
  test("rides the shared `<system-reminder>` drain like other reminders", () => {
    const host = { id: "midturn-test" };
    expect(pendingReminderCount(host)).toBe(0);
    queueReminder(host, "midturn-inject", midturnInjectReminderBody());
    expect(pendingReminderCount(host)).toBe(1);
    const xml = takePendingReminders(host);
    expect(xml).not.toBeNull();
    expect(xml).toContain("<system-reminder>");
    expect(xml).toContain("</system-reminder>");
    expect(xml).toContain("MUST");
    // Drained — queue is empty afterwards.
    expect(pendingReminderCount(host)).toBe(0);
    expect(takePendingReminders(host)).toBeNull();
  });
});
