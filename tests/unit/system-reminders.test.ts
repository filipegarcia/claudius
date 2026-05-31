import { describe, expect, it } from "vitest";

import {
  buildNextTurnReminder,
  pendingReminderCount,
  queueReminder,
  takePendingReminders,
  wrapReminder,
} from "@/lib/server/system-reminders";

// The exact regex `cleanReminders` (in customization-description.ts) uses to
// strip these blocks downstream. Replicated here — same trick as
// strip-goal-reminder.test.ts — so the cross-module contract is pinned: an
// attribute on the opening tag would silently leak through.
const CLEAN_REMINDERS = /<system-reminder>[\s\S]*?<\/system-reminder>/g;

describe("wrapReminder", () => {
  it("wraps text in the canonical bare-tag block (matches cleanReminders)", () => {
    const out = wrapReminder("hello body");
    expect(out.startsWith("<system-reminder>\n")).toBe(true);
    expect(out).toContain("\nhello body\n");
    expect(out).toContain("</system-reminder>\n\n");
    // The whole block must be strippable by the downstream regex — if a
    // future change adds an attribute to the opening tag, this fails.
    expect(out.replace(CLEAN_REMINDERS, "").trim()).toBe("");
  });

  it("ends with a separator so concatenating blocks doesn't fuse", () => {
    const a = wrapReminder("A");
    const b = wrapReminder("B");
    const joined = a + b + "user text";
    // The closing tag of A is never adjacent to the opening tag of B, and
    // the last block is never adjacent to the user text.
    expect(joined).toContain("</system-reminder>\n\n<system-reminder>");
    expect(joined.endsWith("\n\nuser text")).toBe(true);
  });
});

describe("buildNextTurnReminder", () => {
  it("does NOT put the kind on the tag (would break cleanReminders)", () => {
    const out = buildNextTurnReminder("date-change", "today is …");
    expect(out).not.toMatch(/<system-reminder[^>]+>/);
    expect(out.startsWith("<system-reminder>\n")).toBe(true);
    expect(out.replace(CLEAN_REMINDERS, "").trim()).toBe("");
  });
});

describe("queue / drain", () => {
  it("drain returns null when nothing has been queued", () => {
    const host = { id: "s1" };
    expect(pendingReminderCount(host)).toBe(0);
    expect(takePendingReminders(host)).toBeNull();
  });

  it("drain returns every queued block concatenated, in insertion order", () => {
    const host = { id: "s2" };
    queueReminder(host, "date-change", "first");
    queueReminder(host, "stale-todowrite", "second");
    expect(pendingReminderCount(host)).toBe(2);

    const drained = takePendingReminders(host);
    expect(drained).not.toBeNull();
    const text = drained as string;
    // Both bodies present, first-queued first.
    const firstIdx = text.indexOf("first");
    const secondIdx = text.indexOf("second");
    expect(firstIdx).toBeGreaterThan(-1);
    expect(secondIdx).toBeGreaterThan(firstIdx);
    // Two wrapper blocks, clean separator between.
    const matches = text.match(CLEAN_REMINDERS) ?? [];
    expect(matches.length).toBe(2);
    // The whole drain output is strippable by cleanReminders.
    expect(text.replace(CLEAN_REMINDERS, "").trim()).toBe("");
  });

  it("drain is one-shot — second call returns null", () => {
    const host = { id: "s3" };
    queueReminder(host, "plan-mode-reentry", "x");
    expect(takePendingReminders(host)).not.toBeNull();
    expect(takePendingReminders(host)).toBeNull();
    expect(pendingReminderCount(host)).toBe(0);
  });

  it("queues are isolated per host instance", () => {
    const a = { id: "shared" };
    const b = { id: "shared" }; // same id, different object — must not cross-leak
    queueReminder(a, "memory-update", "for A");
    expect(pendingReminderCount(b)).toBe(0);
    expect(takePendingReminders(b)).toBeNull();
    expect(takePendingReminders(a)).toContain("for A");
  });
});
