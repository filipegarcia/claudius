import { describe, expect, test, vi } from "vitest";
import {
  DEAD_RESTART_COOLDOWN_MS,
  MAX_DEAD_RESTARTS,
  SessionManager,
  deadSessionResponse,
} from "@/lib/server/session-manager";
import { Session } from "@/lib/server/session";

/**
 * CC 2.1.311 parity — "Fixed a background session that crashed between turns
 * not being restarted while it was attached, pinned, or had a scheduled task
 * or wake-up set".
 *
 * When a Session's SDK process ends on its own, `done` is set but the Session
 * stays in the manager map, and `sendInput` drops every message. These tests
 * pin `SessionManager.restartIfDead` (rebuild under the same id, close the old
 * instance's streams so tabs reconnect, share concurrent rebuilds, cap a
 * crash loop) and the Session-side predicates it relies on.
 */

type Stub = {
  id: string;
  dead: boolean;
  endCalls: number;
  closeStreamsCalls: number;
};

function stubSession(id: string, dead: boolean): { stub: Stub; session: Session } {
  const stub: Stub = { id, dead, endCalls: 0, closeStreamsCalls: 0 };
  const session = {
    id,
    isDead: () => stub.dead,
    getRebuildOpts: () => ({ cwd: "/tmp/project", model: "claude-sonnet-4-6" }),
    end: vi.fn(async () => {
      stub.endCalls += 1;
    }),
    closeStreams: () => {
      stub.closeStreamsCalls += 1;
    },
    onSubscriberCountChange: () => () => {},
  } as unknown as Session;
  return { stub, session };
}

function internals(manager: SessionManager) {
  return manager as unknown as { sessions: Map<string, Session> };
}

/** Replace `create` with a stub that publishes a fresh live session. */
function stubCreate(manager: SessionManager, opts: { fail?: boolean; delayMs?: number } = {}) {
  return vi.spyOn(manager, "create").mockImplementation(async (req) => {
    if (opts.delayMs) await new Promise((r) => setTimeout(r, opts.delayMs));
    if (opts.fail) throw new Error("spawn failed: claude exited with code 1");
    const { session } = stubSession(req?.resume ?? "new", false);
    internals(manager).sessions.set(session.id, session);
    return session;
  });
}

describe("SessionManager.restartIfDead", () => {
  test("a live session is returned unchanged", async () => {
    const manager = new SessionManager();
    const { session } = stubSession("live", false);
    internals(manager).sessions.set("live", session);
    const create = stubCreate(manager);

    const res = await manager.restartIfDead("live");
    expect(res).toEqual({ ok: true, session, restarted: false });
    expect(create).not.toHaveBeenCalled();
  });

  test("an unknown id is gone", async () => {
    const manager = new SessionManager();
    expect(await manager.restartIfDead("nope")).toEqual({ ok: false, reason: "gone" });
  });

  test("a dead session is rebuilt under the same id and its tabs are told to reconnect", async () => {
    const manager = new SessionManager();
    const { stub, session } = stubSession("crashed", true);
    internals(manager).sessions.set("crashed", session);
    const create = stubCreate(manager);

    const res = await manager.restartIfDead("crashed");
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.restarted).toBe(true);
    expect(res.session).not.toBe(session);
    expect(manager.get("crashed")).toBe(res.session);
    // Old instance torn down, rebuilt resumed from its transcript with the
    // same create options, and its SSE streams closed so tabs rebind.
    expect(stub.endCalls).toBe(1);
    expect(create).toHaveBeenCalledWith({ cwd: "/tmp/project", model: "claude-sonnet-4-6", resume: "crashed" });
    expect(stub.closeStreamsCalls).toBe(1);
  });

  test("concurrent sends share one rebuild", async () => {
    const manager = new SessionManager();
    const { session } = stubSession("crashed", true);
    internals(manager).sessions.set("crashed", session);
    const create = stubCreate(manager, { delayMs: 10 });

    const [a, b] = await Promise.all([manager.restartIfDead("crashed"), manager.restartIfDead("crashed")]);
    expect(create).toHaveBeenCalledTimes(1);
    expect(a).toBe(b);
  });

  test("a process that keeps dying is not restarted forever; a successful turn resets the budget", async () => {
    const manager = new SessionManager();
    // Every rebuilt session is dead again (dies on boot).
    vi.spyOn(manager, "create").mockImplementation(async (req) => {
      const { session } = stubSession(req?.resume ?? "x", true);
      internals(manager).sessions.set(session.id, session);
      return session;
    });
    internals(manager).sessions.set("boot-loop", stubSession("boot-loop", true).session);

    for (let i = 0; i < MAX_DEAD_RESTARTS; i++) {
      expect((await manager.restartIfDead("boot-loop")).ok).toBe(true);
    }
    expect(await manager.restartIfDead("boot-loop")).toEqual({ ok: false, reason: "max_attempts" });

    manager.noteThinkingRecoverySuccess("boot-loop");
    expect((await manager.restartIfDead("boot-loop")).ok).toBe(true);
  });

  test("the budget refills after the cooldown, without a successful turn", async () => {
    vi.useFakeTimers();
    try {
      const manager = new SessionManager();
      vi.spyOn(manager, "create").mockImplementation(async (req) => {
        const { session } = stubSession(req?.resume ?? "x", true);
        internals(manager).sessions.set(session.id, session);
        return session;
      });
      internals(manager).sessions.set("boot-loop", stubSession("boot-loop", true).session);
      for (let i = 0; i < MAX_DEAD_RESTARTS; i++) await manager.restartIfDead("boot-loop");
      expect((await manager.restartIfDead("boot-loop")).ok).toBe(false);

      vi.advanceTimersByTime(DEAD_RESTART_COOLDOWN_MS + 1);
      expect((await manager.restartIfDead("boot-loop")).ok).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  test("passive callers (pollers, stream connect) get only the first attempt", async () => {
    const manager = new SessionManager();
    vi.spyOn(manager, "create").mockImplementation(async (req) => {
      const { session } = stubSession(req?.resume ?? "x", true);
      internals(manager).sessions.set(session.id, session);
      return session;
    });
    internals(manager).sessions.set("boot-loop", stubSession("boot-loop", true).session);

    expect((await manager.restartIfDead("boot-loop", { passive: true })).ok).toBe(true);
    // A poll every few seconds must not use up the user's restarts.
    expect(await manager.restartIfDead("boot-loop", { passive: true })).toEqual({ ok: false, reason: "skipped" });
    expect(await manager.restartIfDead("boot-loop", { passive: true })).toEqual({ ok: false, reason: "skipped" });
    // The user's send still gets the remaining budget.
    expect((await manager.restartIfDead("boot-loop")).ok).toBe(true);
  });

  test("a send that arrives while a rebuild is unbinding the id joins it instead of 404ing", async () => {
    const manager = new SessionManager();
    const { session } = stubSession("crashed", true);
    internals(manager).sessions.set("crashed", session);
    const create = stubCreate(manager, { delayMs: 10 });

    const first = manager.restartIfDead("crashed");
    // The first rebuild has removed the dead instance; `get` alone would 404.
    await Promise.resolve();
    await Promise.resolve();
    expect(manager.get("crashed")).toBeUndefined();
    const second = await manager.restartIfDead("crashed");
    expect(second.ok).toBe(true);
    expect(await first).toBe(second);
    expect(create).toHaveBeenCalledTimes(1);
  });

  test("deadSessionResponse maps each failure to the route's error and status", () => {
    expect(deadSessionResponse({ ok: false, reason: "gone" })).toEqual({ error: "session not found", status: 404 });
    expect(deadSessionResponse({ ok: false, reason: "max_attempts" }).status).toBe(503);
    expect(deadSessionResponse({ ok: false, reason: "failed", error: "boom" })).toEqual({
      error: "Couldn't restart the session: boom",
      status: 503,
    });
  });

  test("a failed rebuild reports why and keeps the dead session bound, with its tabs attached", async () => {
    const manager = new SessionManager();
    const { stub, session } = stubSession("crashed", true);
    internals(manager).sessions.set("crashed", session);
    stubCreate(manager, { fail: true });

    const res = await manager.restartIfDead("crashed");
    expect(res).toEqual({ ok: false, reason: "failed", error: "spawn failed: claude exited with code 1" });
    // Regression: a process that dies on boot (CI runs as root, so the CLI
    // refuses --dangerously-skip-permissions) used to leave the id unbound
    // after the failed rebuild, 404ing every later route for that session.
    expect(manager.get("crashed")).toBe(session);
    // Streams stay on the restored instance; closing them would just
    // reconnect into another doomed restart.
    expect(stub.closeStreamsCalls).toBe(0);
  });
});

describe("Session dead-process predicates", () => {
  const isDead = (done: boolean, aborted: boolean) => {
    const abortController = new AbortController();
    if (aborted) abortController.abort();
    return Session.prototype.isDead.call({ done, abortController } as unknown as Session);
  };

  test("isDead: ended on its own, not through end()", () => {
    expect(isDead(true, false)).toBe(true);
    // end() (reaper, restart, delete) aborts first — not a crash.
    expect(isDead(true, true)).toBe(false);
    expect(isDead(false, false)).toBe(false);
  });

  test("isDead stays true after end() when the process had already died on its own", async () => {
    const abortController = new AbortController();
    const fake = {
      done: true,
      abortController,
      diedOnItsOwn: false,
      inputQueue: { close: () => {} },
      stopJsonlWatcher: () => {},
      drainPendingDecisions: () => {},
      scheduledLoops: new Map(),
      pendingScheduledLoops: new Map(),
      appliedWakeupStops: new Set(),
      pendingLoopTickAttribution: [],
      id: "dead-then-ended",
    } as unknown as Session;
    expect(Session.prototype.isDead.call(fake)).toBe(true);
    await Session.prototype.end.call(fake);
    expect(abortController.signal.aborted).toBe(true);
    expect(Session.prototype.isDead.call(fake)).toBe(true);
  });

  test("hasArmedLoops is false once the process is gone (the timers died with it)", () => {
    const armed = new Map([["loop-1", { kind: "wakeup", nextFireAt: Date.now() + 60_000 }]]);
    const call = (done: boolean) =>
      Session.prototype.hasArmedLoops.call({ done, scheduledLoops: armed } as unknown as Session);
    expect(call(true)).toBe(false);
  });

  test("closeStreams runs every registered closer once, even if one throws", () => {
    const closed: string[] = [];
    const streamClosers = new Set<() => void>([
      () => closed.push("a"),
      () => {
        throw new Error("already closed");
      },
      () => closed.push("c"),
    ]);
    const fake = { streamClosers } as unknown as Session;
    Session.prototype.closeStreams.call(fake);
    expect(closed).toEqual(["a", "c"]);
    expect(streamClosers.size).toBe(0);
    Session.prototype.closeStreams.call(fake);
    expect(closed).toEqual(["a", "c"]);
  });
});
