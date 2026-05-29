import { describe, expect, test } from "vitest";
import { activeTabStatus } from "@/components/chat/SessionTabs";
import type { ServerEvent, TurnStatusEvent } from "@/lib/shared/events";

/**
 * Locks in the contract that `activeTabStatus` translates from `useSession`
 * state into the visual `TabStatus` correctly. This is the function that the
 * `turn_status` SSE event ultimately drives — the event flips `pending`,
 * `activeTabStatus(pending)` decides the dot color.
 *
 * Why this matters: the regression we're guarding against ("session looks Idle
 * mid-turn") would also slip through if someone refactored `activeTabStatus`
 * to ignore `pending`. The e2e spec (`tests/e2e/turn-status.spec.ts`) covers
 * the full SSE path; this unit test is the fast-feedback fence around the
 * pure mapping.
 */

describe("activeTabStatus", () => {
  test("ready + pending → 'running'", () => {
    expect(activeTabStatus({ ready: true, pending: true, hasError: false })).toBe("running");
  });

  test("ready + idle → 'idle'", () => {
    expect(activeTabStatus({ ready: true, pending: false, hasError: false })).toBe("idle");
  });

  test("not ready → 'starting' (overrides idle)", () => {
    expect(activeTabStatus({ ready: false, pending: false, hasError: false })).toBe("starting");
  });

  test("hasError → 'error' (overrides everything)", () => {
    // Even with a turn in flight, an error wins — matches the UI's
    // red-trumps-all priority.
    expect(activeTabStatus({ ready: true, pending: true, hasError: true })).toBe("error");
    expect(activeTabStatus({ ready: false, pending: false, hasError: true })).toBe("error");
  });
});

describe("TurnStatusEvent discriminated-union", () => {
  test("'turn_status' narrows in a switch (regression: don't drop the variant from ServerEvent)", () => {
    // If a future refactor accidentally removes TurnStatusEvent from the
    // ServerEvent union, the `case "turn_status"` arm below stops compiling
    // (the `ev.status` access on the narrowed type fails). Runtime check
    // doubles as documentation of the wire shape.
    const running: TurnStatusEvent = { type: "turn_status", status: "running" };
    const idle: TurnStatusEvent = { type: "turn_status", status: "idle" };

    function pendingFromEvent(ev: ServerEvent): boolean | null {
      switch (ev.type) {
        case "turn_status":
          return ev.status === "running";
        default:
          return null;
      }
    }

    expect(pendingFromEvent(running)).toBe(true);
    expect(pendingFromEvent(idle)).toBe(false);
    // A non-turn_status event leaves `pending` untouched (helper returns null).
    expect(pendingFromEvent({ type: "ready", sessionId: "x" })).toBeNull();
  });
});
