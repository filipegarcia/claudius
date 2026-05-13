import { describe, expect, test } from "vitest";

import {
  isKindEnabled,
  mapEventToKind,
} from "@/lib/server/notification-bus";
import { DEFAULT_ENABLED_KINDS } from "@/lib/shared/notifications";

/**
 * Pure-logic coverage for the bus's filter and mapping functions. These run
 * in milliseconds because nothing here touches SQLite, the workspace store,
 * or the bus singleton — every assertion is a function call with mocked
 * input.
 *
 * If you're tempted to write a new test that needs `notificationBus`, it
 * doesn't belong here — put it in `notification-bus.integration.test.ts`.
 */

const SESSION_CTX = { cwd: "/tmp/proj", sessionId: "sess-1" } as const;
const SCHED_CTX = { cwd: "/tmp/proj", runId: "run-1", jobId: "job-1" } as const;

function emptyIdleMap(): Map<string, number> {
  return new Map<string, number>();
}

describe("isKindEnabled", () => {
  test("permission_request is in the default-enabled set", () => {
    expect(isKindEnabled("permission_request", undefined)).toBe(true);
  });

  test("master `enabled: false` blocks every kind", () => {
    for (const k of DEFAULT_ENABLED_KINDS) {
      expect(isKindEnabled(k, { enabled: false })).toBe(false);
    }
  });

  test("undefined `enabledKinds` falls back to defaults", () => {
    // enabled-but-no-list should NOT silently block everything — that
    // would break workspaces that have toggled enabled without curating
    // a kind list. Pick a kind that's IN the defaults (session_error is
    // intentionally opt-in, so it doesn't qualify).
    expect(isKindEnabled("permission_request", { enabled: true })).toBe(true);
  });

  test("opt-in kinds are NOT in the implicit default set", () => {
    // `session_error` ships off so users don't get a notification for
    // every user-abort / reaper kill / "No conversation found" — those
    // are noise and the chat transcript already shows real errors.
    expect(isKindEnabled("session_error", { enabled: true })).toBe(false);
    expect(isKindEnabled("session_error", undefined)).toBe(false);
  });

  test("explicit empty array blocks everything", () => {
    expect(isKindEnabled("session_error", { enabledKinds: [] })).toBe(false);
    expect(isKindEnabled("permission_request", { enabledKinds: [] })).toBe(false);
  });

  test("partial allow-list lets matching kinds through and blocks others", () => {
    const prefs = { enabledKinds: ["permission_request" as const] };
    expect(isKindEnabled("permission_request", prefs)).toBe(true);
    expect(isKindEnabled("session_error", prefs)).toBe(false);
  });

  test("opt-in kinds can be explicitly enabled in enabledKinds", () => {
    // The whole point of moving `session_error` to opt-in is to let users
    // turn it on when they want it — this pins that path.
    expect(isKindEnabled("session_error", { enabledKinds: ["session_error"] })).toBe(true);
  });
});

describe("mapEventToKind", () => {
  test("permission_request roundtrips title/body/payload/requestId", () => {
    const out = mapEventToKind(
      {
        type: "permission_request",
        requestId: "req-1",
        toolName: "Bash",
        toolUseId: "tu-1",
        input: { command: "ls" },
        title: "Run a shell command",
      },
      SESSION_CTX,
      emptyIdleMap(),
    );
    expect(out).toEqual({
      kind: "permission_request",
      title: "Claude needs permission",
      body: "Run a shell command",
      payload: { toolName: "Bash", toolUseId: "tu-1" },
      requestId: "req-1",
    });
  });

  test("permission_request body falls back to toolName when title is absent", () => {
    const out = mapEventToKind(
      {
        type: "permission_request",
        requestId: "req-2",
        toolName: "WebFetch",
        toolUseId: "tu-2",
        input: {},
      },
      SESSION_CTX,
      emptyIdleMap(),
    );
    expect(out?.body).toBe("WebFetch");
  });

  test("ask_user_question picks the first question for body + header in payload", () => {
    const out = mapEventToKind(
      {
        type: "ask_user_question",
        requestId: "req-3",
        toolUseId: "tu-3",
        questions: [
          {
            question: "Pick a colour",
            header: "Colour",
            options: [],
            multiSelect: false,
          },
          {
            question: "Pick a fruit",
            header: "Fruit",
            options: [],
            multiSelect: false,
          },
        ],
      },
      SESSION_CTX,
      emptyIdleMap(),
    );
    expect(out?.kind).toBe("ask_user_question");
    expect(out?.body).toBe("Pick a colour");
    expect(out?.payload).toEqual({ toolUseId: "tu-3", header: "Colour" });
  });

  test("plan_approval_request body is the first line of the plan", () => {
    const out = mapEventToKind(
      {
        type: "plan_approval_request",
        requestId: "req-4",
        toolUseId: "tu-4",
        plan: "Step 1: do thing\nStep 2: do other thing",
      },
      SESSION_CTX,
      emptyIdleMap(),
    );
    expect(out?.body).toBe("Step 1: do thing");
  });

  test("plan_approval_request truncates very long first lines", () => {
    const longLine = "x".repeat(250);
    const out = mapEventToKind(
      {
        type: "plan_approval_request",
        requestId: "req-5",
        toolUseId: "tu-5",
        plan: longLine,
      },
      SESSION_CTX,
      emptyIdleMap(),
    );
    // 200-char cap, ellipsis suffix means total length 200 (197 + 3-byte
    // ellipsis encoded as one char). Verify with the public contract: it
    // ends with the single-char ellipsis and is much shorter than 250.
    expect(out?.body?.endsWith("…")).toBe(true);
    expect((out?.body ?? "").length).toBeLessThan(longLine.length);
  });

  test("error event with sessionId → session_error", () => {
    const out = mapEventToKind(
      { type: "error", message: "boom" },
      SESSION_CTX,
      emptyIdleMap(),
    );
    expect(out?.kind).toBe("session_error");
    expect(out?.title).toBe("Session error");
    expect(out?.body).toBe("boom");
  });

  test("error event in scheduler context → scheduled_run_finished", () => {
    const out = mapEventToKind(
      { type: "error", message: "boom" },
      SCHED_CTX,
      emptyIdleMap(),
    );
    expect(out?.kind).toBe("scheduled_run_finished");
    expect(out?.title).toBe("Scheduled run errored");
  });

  test("session-context abort sentinel is dropped (no notification)", () => {
    // The SDK throws "Claude Code process aborted by user" for both the
    // reaper's `abortController.abort()` and the user-initiated
    // `query.interrupt()` paths. Neither is a real error worth surfacing
    // as a notification. The bus is the belt to the source-side guard's
    // suspenders — see the comment in `mapEventToKind`'s error case.
    const out = mapEventToKind(
      { type: "error", message: "Claude Code process aborted by user" },
      SESSION_CTX,
      emptyIdleMap(),
    );
    expect(out).toBeNull();
  });

  test("scheduler-context abort sentinel still surfaces (real run failure)", () => {
    // The suppression is intentionally session-only. A scheduled run that
    // exited with the same string is a genuine failure mode we want to
    // surface — the scheduler doesn't use the same abort path.
    const out = mapEventToKind(
      { type: "error", message: "Claude Code process aborted by user" },
      SCHED_CTX,
      emptyIdleMap(),
    );
    expect(out?.kind).toBe("scheduled_run_finished");
  });

  test("non-abort session_error still surfaces", () => {
    // Make sure the abort filter isn't accidentally over-broad.
    const out = mapEventToKind(
      { type: "error", message: "ENOENT: no such file" },
      SESSION_CTX,
      emptyIdleMap(),
    );
    expect(out?.kind).toBe("session_error");
    expect(out?.body).toBe("ENOENT: no such file");
  });

  test("sdk: non-result message is dropped", () => {
    const out = mapEventToKind(
      // Cast: SDKMessage has many discriminants, we only care that `type`
      // isn't "result".
      { type: "sdk", message: { type: "assistant" } as never },
      SESSION_CTX,
      emptyIdleMap(),
    );
    expect(out).toBeNull();
  });

  test("sdk: result with no prior markUserInput → suppressed", () => {
    const out = mapEventToKind(
      { type: "sdk", message: { type: "result" } as never },
      SESSION_CTX,
      emptyIdleMap(),
    );
    expect(out).toBeNull();
  });

  test("sdk: result with markUserInput → session_idle (no time gate)", () => {
    // The time-based IDLE_NOTIFY_MIN_MS window was removed because it
    // suppressed quick turns on backgrounded sessions (the
    // `wait 1 seconds and ack` user-bug). The client's auto-read gate
    // in NotificationsProvider handles the "user is still on this
    // session" case by marking the row read on arrival; the server
    // shouldn't gate on a race-y timer.
    const idle = new Map<string, number>();
    idle.set(SESSION_CTX.sessionId, Date.now() - 2_000); // 2s ago — would have been suppressed pre-fix
    const out = mapEventToKind(
      { type: "sdk", message: { type: "result" } as never },
      SESSION_CTX,
      idle,
    );
    expect(out?.kind).toBe("session_idle");
    expect(out?.body).toBe(SESSION_CTX.cwd);
  });

  test("sdk: result with markUserInput recorded long ago → session_idle", () => {
    const idle = new Map<string, number>();
    idle.set(SESSION_CTX.sessionId, Date.now() - 60_000); // 60s ago
    const out = mapEventToKind(
      { type: "sdk", message: { type: "result" } as never },
      SESSION_CTX,
      idle,
    );
    expect(out?.kind).toBe("session_idle");
    expect(out?.body).toBe(SESSION_CTX.cwd);
  });

  test("sdk: result in scheduler context (no sessionId) → suppressed", () => {
    // Idle heuristic is session-only — a scheduled run completing should
    // surface as `run_finished` from the scheduler, not as session_idle.
    const out = mapEventToKind(
      { type: "sdk", message: { type: "result" } as never },
      SCHED_CTX,
      emptyIdleMap(),
    );
    expect(out).toBeNull();
  });

  test("run_finished success branch", () => {
    const out = mapEventToKind(
      { type: "run_finished", status: "success", costUsd: 0.42 },
      SCHED_CTX,
      emptyIdleMap(),
    );
    expect(out?.kind).toBe("scheduled_run_finished");
    expect(out?.title).toBe("Scheduled run finished");
    expect(out?.payload).toEqual({ status: "success", costUsd: 0.42 });
  });

  test("run_finished non-success branch surfaces status in the title", () => {
    const out = mapEventToKind(
      { type: "run_finished", status: "errored", note: "exit 1" },
      SCHED_CTX,
      emptyIdleMap(),
    );
    expect(out?.title).toBe("Scheduled run errored");
    expect(out?.body).toBe("exit 1");
    expect(out?.payload).toEqual({ status: "errored" });
  });

  test("unknown event types return null", () => {
    // mode_changed, model_changed, ready, replay_done etc. all flow through
    // the same switch — none should produce a notification row.
    const out = mapEventToKind(
      { type: "ready", sessionId: "x" },
      SESSION_CTX,
      emptyIdleMap(),
    );
    expect(out).toBeNull();
  });
});
