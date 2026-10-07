import { describe, expect, test } from "vitest";
import {
  LOOP_KEEPALIVE_MAX_MS,
  LOOP_TICK_GRACE_MS,
  hasArmedLoop,
  isLoopArmed,
} from "@/lib/server/loop-keepalive";
import type { SessionLoop } from "@/lib/shared/session-loops";

/**
 * CC 2.1.292 — a `/loop` must not silently stop because the process holding
 * its pending wake-up went away. The idle reaper consults these predicates;
 * the trap is that `scheduledLoops` entries linger after they fire, so only a
 * loop that will still fire may keep a session alive.
 */

const T0 = Date.parse("2026-10-07T12:00:00Z");

function wakeup(over: Partial<SessionLoop> = {}): SessionLoop {
  return {
    kind: "wakeup",
    id: "tu_1",
    toolUseId: "tu_1",
    cron: null,
    humanSchedule: null,
    delaySeconds: 1200,
    prompt: "/loop check CI",
    recurring: false,
    durable: false,
    startedAt: T0,
    cancelled: false,
    ...over,
  };
}

function cron(over: Partial<SessionLoop> = {}): SessionLoop {
  return {
    ...wakeup(),
    kind: "cron",
    id: "abc123",
    cron: "*/10 * * * *",
    delaySeconds: null,
    recurring: true,
    ...over,
  };
}

describe("isLoopArmed — wake-ups", () => {
  test("armed until its fire time", () => {
    expect(isLoopArmed(wakeup(), T0 + 1_199_000, false)).toBe(true);
    expect(isLoopArmed(wakeup(), T0 + 1_200_001, false)).toBe(false);
  });

  test("a fired wake-up whose turn is still running stays armed, within the grace", () => {
    const fired = T0 + 1_200_000;
    expect(isLoopArmed(wakeup(), fired + 60_000, true)).toBe(true);
    expect(isLoopArmed(wakeup(), fired + LOOP_TICK_GRACE_MS + 1, true)).toBe(false);
  });

  test("cancelled or stop (no delay) never pins the session", () => {
    expect(isLoopArmed(wakeup({ cancelled: true }), T0, false)).toBe(false);
    expect(isLoopArmed(wakeup({ delaySeconds: null }), T0, false)).toBe(false);
  });
});

describe("isLoopArmed — crons", () => {
  test("a recurring cron is armed, bounded by the keep-alive cap", () => {
    expect(isLoopArmed(cron(), T0 + 3_600_000, false)).toBe(true);
    expect(isLoopArmed(cron(), T0 + LOOP_KEEPALIVE_MAX_MS + 1, false)).toBe(false);
    expect(isLoopArmed(cron({ cancelled: true }), T0, false)).toBe(false);
  });

  test("a one-shot cron is armed until its first fire", () => {
    const once = cron({ recurring: false }); // next */10 after 12:00:00 is 12:10
    expect(isLoopArmed(once, T0 + 9 * 60_000, false)).toBe(true);
    expect(isLoopArmed(once, T0 + 11 * 60_000, false)).toBe(false);
  });
});

describe("hasArmedLoop", () => {
  test("a stale fired wake-up alone does not keep the session", () => {
    expect(hasArmedLoop([wakeup()], T0 + 2 * 3_600_000, false)).toBe(false);
    expect(hasArmedLoop([wakeup(), cron()], T0 + 2 * 3_600_000, false)).toBe(true);
    expect(hasArmedLoop([], T0, true)).toBe(false);
  });
});
