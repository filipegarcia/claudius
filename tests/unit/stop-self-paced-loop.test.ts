import { describe, expect, test } from "vitest";
import {
  isScheduleWakeupStop,
  markWakeupsStopped,
  scheduledLoopCancelPrompt,
} from "@/lib/shared/stop-self-paced-loop";

/**
 * CC 2.1.295 parity — a self-paced (`ScheduleWakeup`) `/loop` must be
 * stoppable, and stopping it must leave a visible "cancelled" chip rather
 * than silently dropping the pending wake-up.
 */

type Loop = { kind: "cron" | "wakeup"; cancelled: boolean; prompt: string; startedAt?: number };

describe("scheduledLoopCancelPrompt", () => {
  test("cron loops are cancelled by id via CronDelete", () => {
    const p = scheduledLoopCancelPrompt({ id: "abc123", kind: "cron" });
    expect(p).toContain("`abc123`");
    expect(p).toContain("CronDelete");
    expect(p).not.toContain("ScheduleWakeup");
  });

  test("self-paced loops are stopped via ScheduleWakeup stop: true", () => {
    const p = scheduledLoopCancelPrompt({ id: "toolu_1", kind: "wakeup" });
    expect(p).toContain("`ScheduleWakeup`");
    expect(p).toContain("`stop: true`");
    expect(p).not.toContain("CronDelete");
    // The wake-up id is a tool_use id the agent never sees as a loop id —
    // don't make it guess with it.
    expect(p).not.toContain("toolu_1");
  });
});

describe("isScheduleWakeupStop", () => {
  test("only a literal boolean true is a stop", () => {
    expect(isScheduleWakeupStop({ stop: true })).toBe(true);
    expect(isScheduleWakeupStop({ stop: "true" })).toBe(false);
    expect(isScheduleWakeupStop({ stop: 1 })).toBe(false);
    expect(isScheduleWakeupStop({ stop: false, delaySeconds: 60 })).toBe(false);
    expect(isScheduleWakeupStop({ delaySeconds: 60 })).toBe(false);
  });

  test("non-object inputs are not stops", () => {
    expect(isScheduleWakeupStop(null)).toBe(false);
    expect(isScheduleWakeupStop(undefined)).toBe(false);
    expect(isScheduleWakeupStop("stop")).toBe(false);
  });
});

describe("markWakeupsStopped", () => {
  test("flags live wake-ups cancelled and keeps them in the record", () => {
    const prev: Record<string, Loop> = {
      w1: { kind: "wakeup", cancelled: false, prompt: "/loop check CI" },
    };
    const next = markWakeupsStopped(prev);
    expect(next).not.toBe(prev);
    expect(next.w1).toEqual({ kind: "wakeup", cancelled: true, prompt: "/loop check CI" });
    // Input is not mutated.
    expect(prev.w1.cancelled).toBe(false);
  });

  test("leaves crons alone, live or cancelled", () => {
    const prev: Record<string, Loop> = {
      c1: { kind: "cron", cancelled: false, prompt: "a" },
      c2: { kind: "cron", cancelled: true, prompt: "b" },
      w1: { kind: "wakeup", cancelled: false, prompt: "c" },
    };
    const next = markWakeupsStopped(prev);
    expect(next.c1).toBe(prev.c1);
    expect(next.c2).toBe(prev.c2);
    expect(next.w1.cancelled).toBe(true);
  });

  test("returns the same record when no wake-up is live (idempotent replay)", () => {
    const prev: Record<string, Loop> = {
      c1: { kind: "cron", cancelled: false, prompt: "a" },
      w1: { kind: "wakeup", cancelled: true, prompt: "b" },
    };
    expect(markWakeupsStopped(prev)).toBe(prev);
    expect(markWakeupsStopped({})).toEqual({});
  });

  test("only cancels wake-ups armed at or before the stop", () => {
    const prev: Record<string, Loop> = {
      w1: { kind: "wakeup", cancelled: false, prompt: "a", startedAt: 1000 },
      w2: { kind: "wakeup", cancelled: false, prompt: "b", startedAt: 3000 },
    };
    const next = markWakeupsStopped(prev, 2000);
    expect(next.w1.cancelled).toBe(true);
    expect(next.w2).toBe(prev.w2);
  });

  test("[w1, stop, w2, replayed stop] leaves w2 live", () => {
    const stopAt = 2000;
    let loops: Record<string, Loop> = {
      w1: { kind: "wakeup", cancelled: false, prompt: "tick 1", startedAt: 1000 },
    };
    loops = markWakeupsStopped(loops, stopAt);
    expect(loops.w1.cancelled).toBe(true);
    // The agent re-arms after the stop (w1 is kept as the cancelled notice).
    loops = { ...loops, w2: { kind: "wakeup", cancelled: false, prompt: "tick 2", startedAt: 3000 } };
    // The SSE reconnect tail replays the stop with its original timestamp.
    const replayed = markWakeupsStopped(loops, stopAt);
    expect(replayed).toBe(loops);
    expect(replayed.w2.cancelled).toBe(false);
  });
});
