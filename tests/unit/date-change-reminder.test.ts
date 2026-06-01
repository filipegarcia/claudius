import { describe, expect, test } from "vitest";

import {
  dateChangeReminderBody,
  localDateKey,
} from "@/lib/server/session";

/**
 * Date-change ambient reminder (Claude Code TUI parity, feature 28).
 *
 * Pure-helper coverage. The integration site in `Session.sendInput` is
 * straightforward: baseline on the first real turn, compare-and-queue on
 * subsequent turns. The contracts worth pinning here are:
 *   - the local-calendar key uses LOCAL components (rolling at UTC midnight
 *     would fire the reminder a fixed number of hours off the user's wall
 *     clock and is the failure mode the spec calls out);
 *   - same-day → null (no rollover ⇒ no spurious nudge);
 *   - different-day → a body containing the CLI's literal suppression
 *     clause so the rollover stays model-only, plus a human-readable
 *     today date (mirrors the SDK's system-prompt date rendering).
 */
describe("localDateKey", () => {
  test("emits zero-padded YYYY-MM-DD from local components", () => {
    // January 5 — single-digit month + day exercise the padStart paths.
    const d = new Date(2026, 0, 5, 12, 0, 0);
    expect(localDateKey(d)).toBe("2026-01-05");
  });

  test("uses local calendar fields, not UTC slicing", () => {
    // A Date constructed with local Y/M/D must round-trip to that same
    // key regardless of the host TZ — `toISOString().slice(0,10)` would
    // diverge here for any non-UTC offset.
    const d = new Date(2026, 11, 31, 23, 30, 0);
    expect(localDateKey(d)).toBe("2026-12-31");
  });
});

describe("dateChangeReminderBody", () => {
  test("returns null when the local-date key is unchanged", () => {
    const now = new Date(2026, 5, 1, 9, 0, 0);
    expect(dateChangeReminderBody(localDateKey(now), now)).toBeNull();
  });

  test("returns the literal CLI suppression clause when the date differs", () => {
    const prev = "2026-05-31";
    const now = new Date(2026, 5, 1, 0, 5, 0); // June 1, 12:05am local
    const body = dateChangeReminderBody(prev, now);
    expect(body).not.toBeNull();
    expect(body).toContain("The date has changed.");
    expect(body).toContain("Today's date is now ");
    // The ambient-nudge contract: the model must NOT surface this to the user.
    expect(body).toContain(
      "DO NOT mention this to the user explicitly because they are already aware.",
    );
  });

  test("interpolates today's local date into the body", () => {
    const prev = "2026-05-31";
    const now = new Date(2026, 5, 1, 0, 5, 0);
    const body = dateChangeReminderBody(prev, now);
    // `toDateString()` is the rendering shape we commit to — the test
    // pins it so a future switch (e.g. to ISO) is a deliberate edit.
    expect(body).toContain(now.toDateString());
  });

  test("fires across a year boundary", () => {
    const prev = "2026-12-31";
    const now = new Date(2027, 0, 1, 0, 0, 1);
    const body = dateChangeReminderBody(prev, now);
    expect(body).not.toBeNull();
    expect(body).toContain(now.toDateString());
  });
});
