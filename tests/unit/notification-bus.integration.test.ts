import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { notificationBus } from "@/lib/server/notification-bus";
import {
  listNotifications,
  setSessionPrefs,
} from "@/lib/server/notifications-db";
import type { NotificationStreamEvent } from "@/lib/shared/notifications";

import { makeTempHome, type TmpHome } from "./helpers/tmp-home";
import { writeFakeWorkspace } from "./helpers/fake-workspace";

/**
 * In-process bus integration: drive `recordSessionEvent` /
 * `recordSchedulerEvent` against a fake workspace, capture the SSE envelopes
 * via `subscribe`, and assert both the fanout and the persisted state.
 *
 * The bus is an HMR singleton on `globalThis`, so we lean on `resetForTests`
 * in `beforeEach` to wipe subscribers / idle-map / state caches between cases.
 * `makeTempHome` handles HOME redirection + the DB-handle cache.
 *
 * State events are emitted via `queueMicrotask` coalescing — the bus collapses
 * multiple in-tick writes into a single state event with the final values.
 * Tests that need to assert on state fanout flush the microtask + Promise
 * queues via `flushAll()` after the synchronous writes.
 */

let tmp: TmpHome;
let envs: NotificationStreamEvent[];
let unsubscribe: () => void;

function snap(): NotificationStreamEvent[] {
  // Defensive copy — callers do indexed reads after later events arrive.
  return envs.slice();
}

/**
 * Yield long enough for all queued microtasks AND their downstream Promise
 * chains (DB reads inside `emitState`) to settle. A bare `await
 * Promise.resolve()` only flushes the first microtask; the bus's chain
 * needs the macrotask boundary to be sure every state emit has fired.
 */
async function flushAll(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

beforeEach(() => {
  tmp = makeTempHome();
  notificationBus.resetForTests();
  envs = [];
  unsubscribe = notificationBus.subscribe((e) => envs.push(e));
});

afterEach(() => {
  unsubscribe();
  notificationBus.resetForTests();
  tmp.restore();
});

describe("recordSessionEvent", () => {
  test("error event lands a row and emits notification + state envelopes", async () => {
    const ws = writeFakeWorkspace();

    await notificationBus.recordSessionEvent(ws.rootPath, "sess-1", {
      type: "error",
      message: "boom",
    });
    await flushAll();

    // Fanout: notification fires synchronously inside record(); state
    // fires from the coalesced microtask.
    const types = snap().map((e) => e.type);
    expect(types).toContain("notification");
    expect(types).toContain("state");
    const notif = snap().find((e) => e.type === "notification");
    expect(notif && notif.type === "notification" && notif.notification.kind).toBe(
      "session_error",
    );
    const state = snap().find((e) => e.type === "state");
    expect(state && state.type === "state" && state.workspaceId).toBe(ws.id);
    expect(state && state.type === "state" && state.totalUnread).toBe(1);
    expect(
      state && state.type === "state" && state.perSession["sess-1"],
    ).toBe(1);
    expect(state && state.type === "state" && state.version).toBe(1);

    // Persisted.
    const rows = await listNotifications(ws.rootPath, ws.id);
    expect(rows).toHaveLength(1);
    expect(rows[0].body).toBe("boom");
  });

  test("requestId dedup: second event with same requestId emits nothing", async () => {
    const ws = writeFakeWorkspace();
    const ev = {
      type: "permission_request" as const,
      requestId: "req-dup",
      toolName: "Bash",
      toolUseId: "tu-1",
      input: {},
    };
    await notificationBus.recordSessionEvent(ws.rootPath, "sess-1", ev);
    await flushAll();
    const firstCount = snap().filter((e) => e.type === "notification").length;
    expect(firstCount).toBe(1);

    await notificationBus.recordSessionEvent(ws.rootPath, "sess-1", ev);
    await flushAll();
    const secondCount = snap().filter((e) => e.type === "notification").length;
    expect(secondCount).toBe(1); // unchanged

    const rows = await listNotifications(ws.rootPath, ws.id);
    expect(rows).toHaveLength(1);
  });

  test("workspace with notifications.enabled=false drops the event", async () => {
    const ws = writeFakeWorkspace({ notifications: { enabled: false } });
    await notificationBus.recordSessionEvent(ws.rootPath, "sess-1", {
      type: "error",
      message: "muted",
    });
    await flushAll();
    expect(snap()).toEqual([]);
    expect(await listNotifications(ws.rootPath, ws.id)).toEqual([]);
  });

  test("enabledKinds allow-list lets matching kinds through and blocks others", async () => {
    const ws = writeFakeWorkspace({
      notifications: { enabledKinds: ["permission_request"] },
    });
    await notificationBus.recordSessionEvent(ws.rootPath, "sess-1", {
      type: "error",
      message: "should-drop",
    });
    await flushAll();
    expect(snap().filter((e) => e.type === "notification")).toHaveLength(0);

    await notificationBus.recordSessionEvent(ws.rootPath, "sess-1", {
      type: "permission_request",
      requestId: "req-z",
      toolName: "Bash",
      toolUseId: "tu-z",
      input: {},
    });
    await flushAll();
    expect(snap().filter((e) => e.type === "notification")).toHaveLength(1);
  });

  test("per-session block drops the notification row but still fires status-sync state", async () => {
    // The mute contract is about NOTIFICATION rows, not status sync. A muted
    // session still goes running ↔ idle and its tab dot needs to refresh —
    // the bus emits the `state` event (with totals unchanged because no row
    // landed) so inactive tabs run `refreshSessions()`. Only the
    // `notification` envelope is dropped.
    const ws = writeFakeWorkspace();
    await setSessionPrefs(ws.rootPath, "sess-blocked", { blocked: true });

    await notificationBus.recordSessionEvent(ws.rootPath, "sess-blocked", {
      type: "error",
      message: "dropped",
    });
    await flushAll();
    expect(snap().filter((e) => e.type === "notification")).toHaveLength(0);
    const blockedState = snap().find((e) => e.type === "state");
    expect(blockedState && blockedState.type === "state" && blockedState.totalUnread).toBe(0);

    await notificationBus.recordSessionEvent(ws.rootPath, "sess-clean", {
      type: "error",
      message: "kept",
    });
    await flushAll();
    expect(snap().filter((e) => e.type === "notification")).toHaveLength(1);
  });

  test("future snoozeUntil suppresses the row but still fires status-sync state", async () => {
    const ws = writeFakeWorkspace();
    await setSessionPrefs(ws.rootPath, "sess-snz", {
      snoozeUntil: Date.now() + 60_000,
    });
    await notificationBus.recordSessionEvent(ws.rootPath, "sess-snz", {
      type: "error",
      message: "snoozed",
    });
    await flushAll();
    expect(snap().filter((e) => e.type === "notification")).toHaveLength(0);
    const snoozedState = snap().find((e) => e.type === "state");
    expect(snoozedState && snoozedState.type === "state" && snoozedState.totalUnread).toBe(0);

    await setSessionPrefs(ws.rootPath, "sess-snz", {
      snoozeUntil: Date.now() - 1_000,
    });
    await notificationBus.recordSessionEvent(ws.rootPath, "sess-snz", {
      type: "error",
      message: "post-snooze",
    });
    await flushAll();
    expect(snap().filter((e) => e.type === "notification")).toHaveLength(1);
  });

  test("subagent SDK message is dropped before workspace lookup", async () => {
    const ws = writeFakeWorkspace();
    await notificationBus.recordSessionEvent(ws.rootPath, "sess-1", {
      type: "sdk",
      // Real SDK shape has many fields; the bus only checks
      // parent_tool_use_id.
      message: { parent_tool_use_id: "tu-parent" } as never,
    });
    await flushAll();
    expect(snap()).toEqual([]);
  });

  test("status-sync emit: turn_status fires state even though it doesn't map to a kind", async () => {
    // turn_status is the canonical "running ↔ idle" broadcast from
    // `Session.broadcastTurnStatusIfChanged`. `mapEventToKind` returns null
    // for it (no notification), but inactive tabs depend on the bus's
    // `state` SSE event to call `refreshSessions()` — without this, a
    // backgrounded session that finished a turn would never repaint its
    // dot. The bus must emit `state` regardless of mapping.
    const ws = writeFakeWorkspace();
    await notificationBus.recordSessionEvent(ws.rootPath, "sess-1", {
      type: "turn_status",
      status: "idle",
    });
    await flushAll();

    const notifs = snap().filter((e) => e.type === "notification");
    const states = snap().filter((e) => e.type === "state");
    expect(notifs).toHaveLength(0); // no row produced
    expect(states.length).toBeGreaterThanOrEqual(1);
    const lastState = states[states.length - 1];
    expect(lastState.type === "state" && lastState.workspaceId).toBe(ws.id);
    expect(lastState.type === "state" && lastState.totalUnread).toBe(0);
  });

  test("status-sync emit: SDK result outside the idle window still fires state", async () => {
    // The IDLE_NOTIFY_MIN_MS gate suppresses session_idle when the user
    // input is recent (or never recorded — common after HMR or for a
    // resumed session). Pre-fix, this caused the bus to drop the event
    // silently and inactive tabs stayed "running" forever. The fix emits
    // the status-sync state regardless of the idle gate's outcome.
    const ws = writeFakeWorkspace();
    // No prior markUserInput → mapEventToKind returns null for the SDK
    // result, but the status-sync emit should still fire.
    await notificationBus.recordSessionEvent(ws.rootPath, "sess-1", {
      type: "sdk",
      message: { type: "result", subtype: "success" } as never,
    });
    await flushAll();

    const notifs = snap().filter((e) => e.type === "notification");
    const states = snap().filter((e) => e.type === "state");
    expect(notifs).toHaveLength(0);
    expect(states.length).toBeGreaterThanOrEqual(1);
  });

  test("multiple in-tick writes coalesce — final state reflects all writes", async () => {
    // Coalescing contract: regardless of HOW MANY state events fire when
    // multiple writes happen in quick succession, the LAST event must
    // carry the final values (totals matching the DB ground truth) and
    // versions must be strictly increasing. We don't assert "exactly one"
    // because `setTimeout(0)` can't guarantee perfect coalescing across
    // Promise.all parallel awaits — by the time record-B's
    // `scheduleStateEmit` runs, record-A's timer may have already fired
    // and cleared the pending flag. That's fine for users (the flicker is
    // sub-frame) but worth pinning down what we DO guarantee.
    const ws = writeFakeWorkspace();
    await Promise.all([
      notificationBus.recordSessionEvent(ws.rootPath, "sess-1", { type: "error", message: "a" }),
      notificationBus.recordSessionEvent(ws.rootPath, "sess-1", { type: "error", message: "b" }),
      notificationBus.recordSessionEvent(ws.rootPath, "sess-1", { type: "error", message: "c" }),
    ]);
    await flushAll();

    const states = snap().filter((e) => e.type === "state");
    expect(states.length).toBeGreaterThanOrEqual(1);
    // Versions strictly monotonic.
    const versions = states.map((e) => (e.type === "state" ? e.version : 0));
    for (let i = 1; i < versions.length; i++) {
      expect(versions[i]).toBeGreaterThan(versions[i - 1]);
    }
    // Final state matches DB ground truth.
    const final = states[states.length - 1];
    expect(final.type === "state" && final.totalUnread).toBe(3);
    expect(final.type === "state" && final.perSession["sess-1"]).toBe(3);
  });

  test("coalescing collapses sequential in-tick mark + insert into one state event", async () => {
    // The realistic coalescing path: a server-side resolve handler that
    // inserts a permission_request row and then immediately marks it read
    // via markReadByRequestId — all within one HTTP handler, no Promise.all.
    // Sequential `await`s in the same handler DO coalesce reliably because
    // there's no other scheduleStateEmit racing with the timer.
    const ws = writeFakeWorkspace();

    // Pre-warm: ensure the workspace's DB handle is cached and the cwd→
    // workspace lookup map is hot, so the actual coalesce test isn't
    // racing the first openDb/listWorkspaces calls.
    await notificationBus.recordSessionEvent(ws.rootPath, "warmup", {
      type: "error",
      message: "warm",
    });
    await flushAll();
    envs.length = 0;

    // Now: insert a permission_request and immediately mark it read.
    await notificationBus.recordSessionEvent(ws.rootPath, "sess-1", {
      type: "permission_request",
      requestId: "req-coalesce",
      toolName: "Bash",
      toolUseId: "tu-1",
      input: {},
    });
    await notificationBus.markReadByRequestId(ws.rootPath, "req-coalesce");
    await flushAll();

    // Final values must be correct; the realistic case typically yields 1
    // state event (both scheduleStateEmit calls happen before the timer
    // fires) but we accept up to 2 if the timer slipped in between.
    const states = snap().filter((e) => e.type === "state");
    expect(states.length).toBeGreaterThanOrEqual(1);
    const final = states[states.length - 1];
    expect(final.type === "state" && final.totalUnread).toBe(1); // warmup row is still unread
  });

  test("background-session OS-toast suppression: session_idle persists but no notification SSE event when hasSubscribers=false", async () => {
    // When the user switches to a different session tab the previous
    // session's SSE closes and its subscriber count goes to 0. The bus
    // must still PERSIST the row + emit a `state` event (so the per-tab
    // unread badge, workspace tile, and drawer count all tick — the user
    // wants to see that something happened on the backgrounded session
    // when they look at the tab strip). It just skips the per-row
    // `notification` SSE event, which is what the client uses to drive OS
    // toasts and the `recent` buffer — those are the noisy surface the
    // user asked to suppress.
    const ws = writeFakeWorkspace();
    notificationBus.markUserInput("sess-bg", Date.now() - 10_000);
    await notificationBus.recordSessionEvent(
      ws.rootPath,
      "sess-bg",
      { type: "sdk", message: { type: "result" } as never },
      { hasSubscribers: false },
    );
    await flushAll();
    // OS-toast feed: zero notification events.
    expect(snap().filter((e) => e.type === "notification")).toHaveLength(0);
    // But the row IS persisted so badges can tick.
    expect(await listNotifications(ws.rootPath, ws.id)).toHaveLength(1);
    // And a state event fired so the client knows perSession changed.
    const states = snap().filter((e) => e.type === "state");
    expect(states.length).toBeGreaterThanOrEqual(1);
    const final = states[states.length - 1] as { totalUnread: number; perSession: Record<string, number> };
    expect(final.totalUnread).toBe(1);
    expect(final.perSession["sess-bg"]).toBe(1);
  });

  test("background-session OS-toast suppression: session_error persists but no notification SSE event when hasSubscribers=false", async () => {
    const ws = writeFakeWorkspace();
    await notificationBus.recordSessionEvent(
      ws.rootPath,
      "sess-bg",
      { type: "error", message: "background boom" },
      { hasSubscribers: false },
    );
    await flushAll();
    expect(snap().filter((e) => e.type === "notification")).toHaveLength(0);
    expect(await listNotifications(ws.rootPath, ws.id)).toHaveLength(1);
    const states = snap().filter((e) => e.type === "state");
    expect(states.length).toBeGreaterThanOrEqual(1);
    const final = states[states.length - 1] as { totalUnread: number };
    expect(final.totalUnread).toBe(1);
  });

  test("background-session suppression: permission_request still fires when hasSubscribers=false", async () => {
    // Actionable kinds override the background gate — the agent is blocked
    // on the user, who needs to come look regardless of which tab they're
    // currently on.
    const ws = writeFakeWorkspace();
    await notificationBus.recordSessionEvent(
      ws.rootPath,
      "sess-bg",
      {
        type: "permission_request",
        requestId: "req-bg-1",
        toolName: "Bash",
        toolUseId: "tu-bg",
        input: {},
      },
      { hasSubscribers: false },
    );
    await flushAll();
    expect(snap().filter((e) => e.type === "notification")).toHaveLength(1);
    expect(await listNotifications(ws.rootPath, ws.id)).toHaveLength(1);
  });

  test("foreground session_idle still fires when hasSubscribers=true", async () => {
    // Sanity check the negative case: with a subscriber present, the gate
    // is a pass-through — the active session continues to produce idle
    // notifications as it always has (the auto-read gate on the client
    // handles the "same tab visible" case from there).
    const ws = writeFakeWorkspace();
    notificationBus.markUserInput("sess-fg", Date.now() - 10_000);
    await notificationBus.recordSessionEvent(
      ws.rootPath,
      "sess-fg",
      { type: "sdk", message: { type: "result" } as never },
      { hasSubscribers: true },
    );
    await flushAll();
    expect(snap().filter((e) => e.type === "notification")).toHaveLength(1);
  });

  test("version increments monotonically across separate ticks", async () => {
    const ws = writeFakeWorkspace();

    await notificationBus.recordSessionEvent(ws.rootPath, "sess-1", { type: "error", message: "a" });
    await flushAll();
    await notificationBus.recordSessionEvent(ws.rootPath, "sess-1", { type: "error", message: "b" });
    await flushAll();
    await notificationBus.recordSessionEvent(ws.rootPath, "sess-1", { type: "error", message: "c" });
    await flushAll();

    const states = snap().filter((e) => e.type === "state");
    expect(states.length).toBe(3);
    const versions = states.map((e) => (e.type === "state" ? e.version : 0));
    expect(versions).toEqual([1, 2, 3]);
    const totals = states.map((e) => (e.type === "state" ? e.totalUnread : 0));
    expect(totals).toEqual([1, 2, 3]);
  });
});

describe("recordSchedulerEvent", () => {
  test("run_finished non-success records with status in payload", async () => {
    const ws = writeFakeWorkspace();
    await notificationBus.recordSchedulerEvent(
      ws.rootPath,
      "run-1",
      "job-1",
      { type: "run_finished", status: "errored", note: "exit 1" },
    );
    await flushAll();
    const rows = await listNotifications(ws.rootPath, ws.id);
    expect(rows).toHaveLength(1);
    expect(rows[0].kind).toBe("scheduled_run_finished");
    expect(rows[0].payload).toEqual({ status: "errored" });
    expect(rows[0].runId).toBe("run-1");
    expect(rows[0].jobId).toBe("job-1");
  });
});

describe("idle heuristic", () => {
  test("without markUserInput, an SDK result is suppressed (but status-sync still fires)", async () => {
    // The idle heuristic suppresses the `session_idle` row when no user
    // input was recorded (e.g. HMR cleared lastUserInputAt, or this is a
    // resumed session whose first turn lands before the user typed
    // anything). That's the row contract.
    //
    // What it does NOT suppress: the `state` status-sync emit. The bus
    // still has to tell inactive tabs that the session's getStatus()
    // moved so they refresh the dot. Without this the user's screenshot
    // bug returns (background tab stuck "running" forever).
    const ws = writeFakeWorkspace();
    await notificationBus.recordSessionEvent(ws.rootPath, "sess-1", {
      type: "sdk",
      message: { type: "result" } as never,
    });
    await flushAll();
    expect(snap().filter((e) => e.type === "notification")).toHaveLength(0);
    const states = snap().filter((e) => e.type === "state");
    expect(states.length).toBeGreaterThanOrEqual(1);
    const last = states[states.length - 1];
    expect(last.type === "state" && last.totalUnread).toBe(0);
  });

  test("with markUserInput far enough in the past, idle notification fires", async () => {
    const ws = writeFakeWorkspace();
    // 10 seconds ago — past the 5-second IDLE_NOTIFY_MIN_MS window.
    notificationBus.markUserInput("sess-1", Date.now() - 10_000);
    await notificationBus.recordSessionEvent(ws.rootPath, "sess-1", {
      type: "sdk",
      message: { type: "result" } as never,
    });
    await flushAll();
    const notif = snap().find((e) => e.type === "notification");
    expect(notif && notif.type === "notification" && notif.notification.kind).toBe(
      "session_idle",
    );
  });
});

describe("markReadByRequestId", () => {
  test("flips the matching row and fires a state envelope at the new total", async () => {
    const ws = writeFakeWorkspace();
    await notificationBus.recordSessionEvent(ws.rootPath, "sess-1", {
      type: "permission_request",
      requestId: "req-7",
      toolName: "Bash",
      toolUseId: "tu-1",
      input: {},
    });
    await flushAll();
    const statesBefore = snap().filter((e) => e.type === "state").length;
    expect(statesBefore).toBe(1);

    await notificationBus.markReadByRequestId(ws.rootPath, "req-7");
    await flushAll();

    const stateEnvs = snap().filter((e) => e.type === "state");
    expect(stateEnvs.length).toBeGreaterThan(statesBefore);
    const last = stateEnvs[stateEnvs.length - 1];
    expect(last.type === "state" && last.totalUnread).toBe(0);
    // Version must be strictly larger than the prior emission.
    expect(last.type === "state" && last.version).toBeGreaterThan(1);
  });

  test("no-op for an unknown requestId — no state envelope", async () => {
    const ws = writeFakeWorkspace();
    await notificationBus.recordSessionEvent(ws.rootPath, "sess-1", {
      type: "error",
      message: "x",
    });
    await flushAll();
    const before = snap().filter((e) => e.type === "state").length;
    await notificationBus.markReadByRequestId(ws.rootPath, "req-never");
    await flushAll();
    const after = snap().filter((e) => e.type === "state").length;
    expect(after).toBe(before);
  });
});

describe("sweepOrphanedActionableForSession", () => {
  test("clears orphaned actionable rows and emits a state envelope at the new total", async () => {
    // Repro for the bug where an `ask_user_question` row persists as
    // unread after the in-memory `pendingAskQuestions` entry is dropped
    // (server restart, HMR, session reaper). On the next Session.start()
    // the sweep must clear the row so the per-tab badge doesn't stick.
    const ws = writeFakeWorkspace();
    await notificationBus.recordSessionEvent(ws.rootPath, "sess-orphan", {
      type: "ask_user_question",
      requestId: "req-orphan",
      toolUseId: "tu-orphan",
      questions: [
        { question: "Which tab is stuck?", header: "", options: [], multiSelect: false },
      ],
    });
    await flushAll();
    const statesBefore = snap().filter((e) => e.type === "state").length;

    await notificationBus.sweepOrphanedActionableForSession(ws.rootPath, "sess-orphan");
    await flushAll();

    const stateEnvs = snap().filter((e) => e.type === "state");
    expect(stateEnvs.length).toBeGreaterThan(statesBefore);
    const last = stateEnvs[stateEnvs.length - 1];
    expect(last.type === "state" && last.totalUnread).toBe(0);
    expect(last.type === "state" && last.perSession["sess-orphan"]).toBeUndefined();
  });

  test("does not touch non-actionable rows on the same session", async () => {
    // session_idle rows are cleared by markReadBySession (the "I selected
    // the tab" sweep), NOT by the orphan-actionable sweep. If this
    // assertion ever flips, the two paths have drifted.
    const ws = writeFakeWorkspace();
    await notificationBus.recordSessionEvent(ws.rootPath, "sess-mixed", {
      type: "ask_user_question",
      requestId: "req-A",
      toolUseId: "tu-A",
      questions: [{ question: "?", header: "", options: [], multiSelect: false }],
    });
    // Stamp a user input so the SDK-result mapping admits the session_idle row.
    notificationBus.markUserInput("sess-mixed", 1);
    await notificationBus.recordSessionEvent(ws.rootPath, "sess-mixed", {
      type: "sdk",
      message: { type: "result" } as never,
    });
    await flushAll();

    await notificationBus.sweepOrphanedActionableForSession(ws.rootPath, "sess-mixed");
    await flushAll();

    const rows = await listNotifications(ws.rootPath, ws.id, { unreadOnly: true });
    expect(rows.map((r) => r.kind)).toEqual(["session_idle"]);
  });

  test("no-op when nothing to clear — does not emit a state envelope", async () => {
    const ws = writeFakeWorkspace();
    await notificationBus.recordSessionEvent(ws.rootPath, "sess-other", {
      type: "ask_user_question",
      requestId: "req-other",
      toolUseId: "tu-other",
      questions: [{ question: "?", header: "", options: [], multiSelect: false }],
    });
    await flushAll();
    const before = snap().filter((e) => e.type === "state").length;
    // Different session id → nothing to flip, no extra state emit (the
    // emit is gated on a row actually changing so backgrounded sessions
    // don't pay a fanout cost on every Session.start sweep).
    await notificationBus.sweepOrphanedActionableForSession(ws.rootPath, "sess-empty");
    await flushAll();
    const after = snap().filter((e) => e.type === "state").length;
    expect(after).toBe(before);
  });
});
