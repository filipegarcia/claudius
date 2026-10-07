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
  const fired = T0 + 1_200_000;

  test("armed until its fire time", () => {
    expect(isLoopArmed(wakeup(), fired - 1_000)).toBe(true);
  });

  test("stays armed through the tick's turn — no turnInFlight needed", () => {
    // The engine starts a wake-up's turn itself; Claudius's turnInFlight
    // never sees it, so a reaper check mid-tick must still keep the session.
    expect(isLoopArmed(wakeup(), fired + 60_000)).toBe(true);
    expect(isLoopArmed(wakeup(), fired + LOOP_TICK_GRACE_MS - 1)).toBe(true);
    expect(isLoopArmed(wakeup(), fired + LOOP_TICK_GRACE_MS + 1)).toBe(false);
  });

  test("cancelled or stop (no delay) never pins the session", () => {
    expect(isLoopArmed(wakeup({ cancelled: true }), T0)).toBe(false);
    expect(isLoopArmed(wakeup({ delaySeconds: null }), T0)).toBe(false);
  });
});

describe("isLoopArmed — crons", () => {
  test("a recurring cron is armed, bounded by the keep-alive cap", () => {
    expect(isLoopArmed(cron(), T0 + 3_600_000)).toBe(true);
    expect(isLoopArmed(cron(), T0 + LOOP_KEEPALIVE_MAX_MS + 1)).toBe(false);
    expect(isLoopArmed(cron({ cancelled: true }), T0)).toBe(false);
  });

  test("a one-shot cron is armed until its first fire, plus the tick's grace", () => {
    const once = cron({ recurring: false }); // next */10 after 12:00:00 is 12:10
    const fires = T0 + 10 * 60_000;
    expect(isLoopArmed(once, fires + 60_000)).toBe(true);
    expect(isLoopArmed(once, fires + LOOP_TICK_GRACE_MS + 1)).toBe(false);
  });
});

describe("hasArmedLoop", () => {
  test("a stale fired wake-up alone does not keep the session", () => {
    expect(hasArmedLoop([wakeup()], T0 + 2 * 3_600_000)).toBe(false);
    expect(hasArmedLoop([wakeup(), cron()], T0 + 2 * 3_600_000)).toBe(true);
    expect(hasArmedLoop([], T0)).toBe(false);
  });
});
