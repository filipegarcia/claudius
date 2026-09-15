import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

/**
 * Regression coverage for the "I came back to my workspace and my messages
 * were gone" bug.
 *
 * Symptom: after an idle window long enough to trip the reaper, returning to a
 * session showed a transcript that stopped partway — tool rows frozen on their
 * running spinner, the final assistant response missing entirely — while
 * `claude --resume <id>` in a terminal showed the full conversation. The JSONL
 * on disk was always complete; only Claudius's playback was truncated.
 *
 * Root cause: `SessionManager.create()` published the Session into
 * `this.sessions` BEFORE awaiting `session.start()`, which is what reads the
 * JSONL and fills the replay buffer. Returning to a workspace fires several
 * `[id]`-keyed requests at once (the SSE stream plus pollers, all funnelled
 * through `getOrResumeSession`), so a request arriving during that window got
 * a session whose buffer was still filling and replayed the partial buffer.
 * Two simultaneous misses were worse still: each ran `new Session()`, and the
 * second `sessions.set` orphaned the first — leaving the SSE subscriber bound
 * to a Session nothing would ever broadcast to again.
 *
 * The fix publishes an in-flight promise for the duration of `start()` so
 * concurrent callers join it, and only registers the Session once it's fully
 * started. These tests pin all three properties: one construction, one shared
 * instance, and never handing out a session mid-start.
 */

/** Sessions constructed across a test — asserts we never build a duplicate. */
let constructed: StubSession[] = [];
/** Resolved once a test wants the in-flight `start()` to complete. */
let releaseStart: (() => void) | undefined;

class StubSession {
  id: string;
  /** Flips true only when `start()` has run to completion. */
  started = false;
  /** Stands in for the replay buffer built from the JSONL during `start()`. */
  buffer: string[] = [];
  endCalls = 0;

  constructor(opts: { id?: string; resume?: string }) {
    // Mirror the real constructor's id precedence: an explicit id, else the
    // id being resumed (which MUST be stable so the SDK recognises it), else
    // a fresh one.
    this.id = opts.id ?? opts.resume ?? `generated-${constructed.length}`;
    constructed.push(this);
  }

  async start(): Promise<void> {
    // Gate on an external latch so a test can hold the session mid-start and
    // observe what the manager exposes during that window.
    if (releaseStart) {
      await new Promise<void>((resolve) => {
        const prev = releaseStart!;
        releaseStart = () => {
          prev();
          resolve();
        };
      });
    }
    // The transcript only becomes complete at the END of start().
    this.buffer = ["msg-1", "msg-2", "msg-3"];
    this.started = true;
  }

  subscriberCount(): number {
    return 0;
  }
  hasPendingUserPrompts(): boolean {
    return false;
  }
  onSubscriberCountChange(): () => void {
    return () => {};
  }
  async end(): Promise<void> {
    this.endCalls += 1;
  }
}

vi.mock("@/lib/server/session", () => ({ Session: StubSession }));

// Imported after the mock is registered so the manager binds to StubSession.
const { SessionManager } = await import("@/lib/server/session-manager");

let manager: InstanceType<typeof SessionManager>;

beforeEach(() => {
  constructed = [];
  releaseStart = undefined;
  manager = new SessionManager();
});

afterEach(async () => {
  // Cancels the 60-minute reap timers create() arms, so they don't dangle.
  for (const s of constructed) await manager.remove(s.id).catch(() => {});
});

describe("SessionManager.create — concurrent resume of a reaped session", () => {
  test("concurrent creates share one fully-started session", async () => {
    // Snapshot readiness AT THE MOMENT each call resolves. Asserting on the
    // instance after `Promise.all` would pass even on the buggy code, because
    // all five callers share one object that the winning caller finishes
    // filling in later — the bug is precisely that callers 2..5 resolved
    // *early*, and only a resolve-time snapshot can see that.
    // Hold `start()` open so all five calls are genuinely in flight together.
    // Without the latch the stub's `start()` completes synchronously, there is
    // no race window, and the test would pass even on the buggy code.
    releaseStart = () => {};

    const pending = Array.from({ length: 5 }, () =>
      manager.create({ resume: "sess-1" }).then((s) => ({
        session: s,
        startedOnResolve: (s as unknown as StubSession).started,
        bufferOnResolve: [...(s as unknown as StubSession).buffer],
      })),
    );

    releaseStart();
    const results = await Promise.all(pending);

    // Exactly one SDK query against the JSONL — a second would corrupt the
    // transcript on disk and orphan the first session's subscribers.
    expect(constructed).toHaveLength(1);

    // Every caller got the same instance...
    for (const r of results) expect(r.session).toBe(results[0].session);

    // ...and every caller got it with a COMPLETE replay buffer already built.
    for (const r of results) {
      expect(r.startedOnResolve).toBe(true);
      expect(r.bufferOnResolve).toEqual(["msg-1", "msg-2", "msg-3"]);
    }
  });

  test("get() never exposes a session that is still starting", async () => {
    releaseStart = () => {};
    const pending = manager.create({ resume: "sess-2" });

    // Let the microtask queue drain so `start()` is genuinely in flight.
    await Promise.resolve();
    await Promise.resolve();

    // Mid-start the session must be invisible. Handing it out here is exactly
    // what let the SSE route replay a half-filled buffer; a transient
    // undefined (the caller 404s and retries) is the safe failure mode.
    expect(manager.get("sess-2")).toBeUndefined();
    expect(constructed[0].started).toBe(false);

    releaseStart();
    const session = await pending;

    expect(manager.get("sess-2")).toBe(session);
    expect(constructed[0].started).toBe(true);
  });

  test("a create that arrives mid-start joins it instead of building a second", async () => {
    releaseStart = () => {};
    const first = manager.create({ resume: "sess-3" });
    await Promise.resolve();
    await Promise.resolve();

    // Second request lands while the first is still replaying from disk.
    // Snapshot at resolve time (see the note in the first test) — the bug was
    // that this caller resolved immediately with a half-filled buffer.
    const second = manager.create({ resume: "sess-3" }).then((s) => ({
      session: s,
      startedOnResolve: (s as unknown as StubSession).started,
    }));

    releaseStart();
    const [a, b] = await Promise.all([first, second]);

    expect(constructed).toHaveLength(1);
    expect(b.session).toBe(a);
    expect(b.startedOnResolve).toBe(true);
  });

  test("a failed start is torn down and not registered", async () => {
    const boom = new Error("spawn failed");
    vi.spyOn(StubSession.prototype, "start").mockRejectedValueOnce(boom);

    await expect(manager.create({ resume: "sess-4" })).rejects.toThrow("spawn failed");

    // No half-dead session left behind for the next caller to find...
    expect(manager.get("sess-4")).toBeUndefined();
    // ...and whatever the SDK spawned got cleaned up rather than leaked.
    expect(constructed[0].endCalls).toBe(1);

    // The in-flight entry is cleared, so a later retry can build fresh.
    const retry = await manager.create({ resume: "sess-4" });
    expect((retry as unknown as StubSession).started).toBe(true);
    expect(constructed).toHaveLength(2);
  });
});
