import { describe, expect, test } from "vitest";
import { LOOP_KEEPALIVE_MAX_MS, LOOP_TICK_GRACE_MS, isLoopArmed } from "@/lib/server/loop-keepalive";
import {
  LOOP_DEFAULT_MAX_AGE_MS,
  LOOP_RECURRING_MAX_AGE_MS,
  loopEndsAt,
  readCronMaxAgeMs,
  readCronRecurring,
  type SessionLoop,
} from "@/lib/shared/session-loops";

/**
 * CC 2.1.330 — "Changed recurring scheduled tasks and `/loop` to run up to 30
 * days instead of 7 while their session keeps running, and say when they end;
 * tasks made before this release still end at 7 days".
 * SDK 0.3.332 — `CronCreateOutput.maxAgeMs`: "Age at which a recurring job
 * ends; 0 = never".
 */
const DAY = 24 * 60 * 60 * 1000;
const T0 = Date.parse("2026-11-01T12:00:00Z");
const NEW_TEXT =
  "Scheduled recurring job 1545ddb6 (Every 30 minutes). Session-only (not written to disk, dies when Claude exits). Auto-expires after 30 days. Use CronDelete to cancel sooner.";
const OLD_TEXT = NEW_TEXT.replace("30 days", "7 days");

function cron(over: Partial<SessionLoop> = {}): SessionLoop {
  return {
    kind: "cron",
    id: "1545ddb6",
    toolUseId: "toolu_1",
    cron: "*/30 * * * *",
    humanSchedule: "Every 30 minutes",
    delaySeconds: null,
    prompt: "/loop check the deploy queue",
    recurring: true,
    durable: false,
    startedAt: T0,
    cancelled: false,
    ...over,
  };
}

describe("readCronMaxAgeMs", () => {
  test("structured maxAgeMs wins over the text", () => {
    expect(readCronMaxAgeMs({ maxAgeMs: 30 * DAY }, OLD_TEXT)).toBe(30 * DAY);
    expect(readCronMaxAgeMs({ maxAgeMs: 3 * DAY }, NEW_TEXT)).toBe(3 * DAY);
  });
  test("0 ('never') is held to the engine's 30-day ceiling", () => {
    expect(readCronMaxAgeMs({ maxAgeMs: 0 }, "")).toBe(LOOP_RECURRING_MAX_AGE_MS);
  });
  test("falls back to the result text when the structured payload is gone", () => {
    expect(readCronMaxAgeMs(undefined, NEW_TEXT)).toBe(30 * DAY);
    expect(readCronMaxAgeMs({ recurring: true }, OLD_TEXT)).toBe(7 * DAY);
  });
  test("undefined when neither says; junk is ignored", () => {
    expect(readCronMaxAgeMs(undefined, "Scheduled recurring job 1 (x).")).toBeUndefined();
    expect(readCronMaxAgeMs({ maxAgeMs: -1 }, "")).toBeUndefined();
    expect(readCronMaxAgeMs({ maxAgeMs: "30" }, "")).toBeUndefined();
  });
});

describe("readCronRecurring", () => {
  test("structured first, then the result text", () => {
    expect(readCronRecurring({ recurring: false }, NEW_TEXT)).toBe(false);
    expect(readCronRecurring(undefined, NEW_TEXT)).toBe(true);
    expect(readCronRecurring(undefined, "Scheduled one-shot task ab12 (Nov 3 at 2:30pm).")).toBe(false);
    expect(readCronRecurring(undefined, "")).toBeUndefined();
  });
});

describe("loopEndsAt", () => {
  test("recurring cron ends at startedAt + maxAgeMs; 7 days without one", () => {
    expect(loopEndsAt(cron({ maxAgeMs: 30 * DAY }))).toBe(T0 + 30 * DAY);
    expect(loopEndsAt(cron())).toBe(T0 + LOOP_DEFAULT_MAX_AGE_MS);
  });
  test("one-shots and wake-ups have no end date", () => {
    expect(loopEndsAt(cron({ recurring: false, maxAgeMs: 30 * DAY }))).toBeNull();
    expect(loopEndsAt(cron({ kind: "wakeup", recurring: false }))).toBeNull();
  });
});

describe("isLoopArmed — the keep-alive follows the loop's own end", () => {
  test("a 30-day loop still pins its session after 7 days", () => {
    const loop = cron({ maxAgeMs: 30 * DAY });
    expect(isLoopArmed(loop, T0 + 8 * DAY)).toBe(true);
    expect(isLoopArmed(loop, T0 + 30 * DAY + LOOP_TICK_GRACE_MS - 1)).toBe(true);
    expect(isLoopArmed(loop, T0 + 30 * DAY + LOOP_TICK_GRACE_MS + 1)).toBe(false);
  });
  test("a job made before 2.1.330 still ends at 7 days", () => {
    expect(isLoopArmed(cron(), T0 + 7 * DAY + LOOP_TICK_GRACE_MS + 1)).toBe(false);
  });
  test("the one-shot ceiling is now the engine's 30 days", () => {
    expect(LOOP_KEEPALIVE_MAX_MS).toBe(30 * DAY);
  });
});
