import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { SessionManager } from "@/lib/server/session-manager";
import type { Session } from "@/lib/server/session";

/**
 * Regression coverage for the idle-reap policy that decides when an
 * unattended Session gets killed.
 *
 * Bug we're guarding against (2026-05-12): if a user opens a chat,
 * triggers an AskUserQuestion, then walks away, the session would be
 * reaped past the idle window. The reap path calls `session.end()` →
 * `abortController.abort()`, which resolves the SDK's `canUseTool`
 * promise with `{ behavior: "deny", message: "Aborted" }`. The SDK
 * persists that as an errored tool_result, and the question is no
 * longer answerable when the user returns — the "Answer" pill on the
 * `ToolCall` row is gated on `!result`, so once the errored result is
 * on disk it's permanently hidden.
 *
 * The fix in `scheduleReap` consults `Session.hasPendingUserPrompts()`
 * and re-arms the timer instead of reaping when a prompt is open. The
 * SessionManager class is exported (not just the singleton) so these
 * tests can wire up stub sessions and assert the policy directly,
 * without spawning a real SDK process.
 */

type StubSession = {
  id: string;
  endCalls: number;
  subscribers: number;
  pendingPrompts: boolean;
  subscriberListeners: Set<(count: number) => void>;
};

function makeStub(id: string): StubSession {
  return {
    id,
    endCalls: 0,
    subscribers: 0,
    pendingPrompts: false,
    subscriberListeners: new Set(),
  };
}

/**
 * Coerce a stub into the Session shape the manager actually consumes —
 * `subscriberCount`, `hasPendingUserPrompts`, `onSubscriberCountChange`,
 * `end`. The rest of the Session class is irrelevant to the reap policy
 * and we deliberately don't fake any of it.
 */
function asSession(stub: StubSession): Session {
  return {
    id: stub.id,
    subscriberCount: () => stub.subscribers,
    hasPendingUserPrompts: () => stub.pendingPrompts,
    end: vi.fn(async () => {
      stub.endCalls += 1;
    }),
    onSubscriberCountChange: (cb: (count: number) => void) => {
      stub.subscriberListeners.add(cb);
      return () => stub.subscriberListeners.delete(cb);
    },
  } as unknown as Session;
}

/**
 * Reach past the SessionManager's `private` field modifiers to plant a
 * stub session and trigger the same subscriber-count path the real
 * `create()` wires up via `session.onSubscriberCountChange`. We can't
 * use `create()` itself because it calls `new Session()` and
 * `session.start()`, both of which try to spawn the SDK.
 */
function inject(manager: SessionManager, stub: StubSession): void {
  const internals = manager as unknown as {
    sessions: Map<string, Session>;
    handleSubscriberCount: (id: string, count: number) => void;
  };
  internals.sessions.set(stub.id, asSession(stub));
  // Mirror the real wiring: tell the manager subscribers dropped to 0,
  // which is what arms the reap timer.
  internals.handleSubscriberCount(stub.id, 0);
}

describe("SessionManager idle-reap policy", () => {
  beforeEach(() => {
    // Tight window for fast tests. The manager's `reapMs()` enforces a
    // 5000ms minimum, so don't go lower than that.
    process.env.CLAUDIUS_SESSION_IDLE_REAP_MS = "5000";
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    delete process.env.CLAUDIUS_SESSION_IDLE_REAP_MS;
  });

  test("idle session with no pending prompts is reaped after the window", async () => {
    const manager = new SessionManager();
    const stub = makeStub("idle-session");
    stub.pendingPrompts = false;
    inject(manager, stub);

    // Just before the window: still alive.
    await vi.advanceTimersByTimeAsync(4_999);
    expect(stub.endCalls).toBe(0);

    // Cross the window: timer fires, hasPendingUserPrompts() returns
    // false, so manager calls `end()`.
    await vi.advanceTimersByTimeAsync(2);
    expect(stub.endCalls).toBe(1);
  });

  test("session blocked on a user prompt is NOT reaped — timer re-arms", async () => {
    const manager = new SessionManager();
    const stub = makeStub("question-pending");
    stub.pendingPrompts = true;
    inject(manager, stub);

    // Cross the first reap window: the policy sees the pending prompt
    // and re-arms instead of calling end().
    await vi.advanceTimersByTimeAsync(5_001);
    expect(stub.endCalls).toBe(0);

    // Cross several more windows. The session must keep surviving as
    // long as the prompt is pending — that's the whole point of the
    // fix.
    for (let i = 0; i < 3; i++) {
      await vi.advanceTimersByTimeAsync(5_001);
      expect(stub.endCalls).toBe(0);
    }
  });

  test("user answers the prompt → next window reaps the session", async () => {
    const manager = new SessionManager();
    const stub = makeStub("answered");
    stub.pendingPrompts = true;
    inject(manager, stub);

    // First window: skipped because pending.
    await vi.advanceTimersByTimeAsync(5_001);
    expect(stub.endCalls).toBe(0);

    // User answers — the predicate flips. Note we don't reset the
    // timer manually; the re-armed timer is still ticking.
    stub.pendingPrompts = false;

    // Next window fires, no pending prompt, reap proceeds.
    await vi.advanceTimersByTimeAsync(5_001);
    expect(stub.endCalls).toBe(1);
  });

  test("subscriber returns mid-window → reap cancelled, no end()", async () => {
    const manager = new SessionManager();
    const stub = makeStub("returned");
    stub.pendingPrompts = false;
    inject(manager, stub);

    // Halfway through the window the user reconnects.
    await vi.advanceTimersByTimeAsync(2_500);
    stub.subscribers = 1;
    const internals = manager as unknown as {
      handleSubscriberCount: (id: string, count: number) => void;
    };
    internals.handleSubscriberCount(stub.id, 1);

    // Push well past the original window — the cancelled timer must
    // not fire.
    await vi.advanceTimersByTimeAsync(10_000);
    expect(stub.endCalls).toBe(0);
  });
});
