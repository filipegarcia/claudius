import { afterEach, beforeEach, describe, expect, test } from "vitest";

import {
  getNotification,
  getSessionPrefs,
  insertNotification,
  isSessionMuted,
  listNotifications,
  markAllRead,
  markRead,
  markReadByRequestId,
  markReadBySession,
  setSessionPrefs,
  unreadCount,
  unreadCountsBySession,
} from "@/lib/server/notifications-db";
import { openDb } from "@/lib/server/db";

import { makeTempHome, type TmpHome } from "./helpers/tmp-home";

/**
 * SQLite-backed coverage for the notifications inbox. Every test gets a
 * fresh tmp HOME so migrations run from scratch and the handle cache stays
 * isolated. `cwd` is the same fixed string throughout each test — the bus's
 * cwd→workspace lookup is exercised in the integration suite, not here.
 */

const CWD = "/tmp/fake-db-cwd";
const WORKSPACE_ID = "wks_test";

let tmp: TmpHome;

beforeEach(async () => {
  tmp = makeTempHome();
  // Force the migrations to run before the first ops call. We pre-open to
  // surface any migration error here rather than as a mysterious failure
  // inside an `insert`.
  await openDb(CWD);
});

afterEach(() => {
  tmp.restore();
});

describe("insert + list roundtrip", () => {
  test("payload object is preserved and hydrated", async () => {
    const inserted = await insertNotification(CWD, WORKSPACE_ID, {
      kind: "permission_request",
      title: "Claude needs permission",
      body: "Bash",
      payload: { toolName: "Bash", toolUseId: "tu-1" },
      requestId: "req-1",
    });
    expect(inserted).not.toBeNull();
    expect(inserted!.workspaceId).toBe(WORKSPACE_ID);
    expect(inserted!.readAt).toBeNull();

    const rows = await listNotifications(CWD, WORKSPACE_ID);
    expect(rows).toHaveLength(1);
    expect(rows[0].payload).toEqual({ toolName: "Bash", toolUseId: "tu-1" });
  });

  test("malformed payload JSON hydrates to null without throwing", async () => {
    // Manually insert a row with garbage in the payload column to simulate
    // either a corrupted write or a schema change that left old rows behind.
    const db = await openDb(CWD);
    db.prepare(
      `INSERT INTO notifications(id, kind, title, body, payload, created_at, read_at)
       VALUES (?, ?, ?, ?, ?, ?, NULL)`,
    ).run("nb1", "session_error", "boom", null, "{not json", Date.now());
    const rows = await listNotifications(CWD, WORKSPACE_ID);
    expect(rows).toHaveLength(1);
    expect(rows[0].payload).toBeNull();
  });

  test("requestId dedup: second insert with same requestId returns null", async () => {
    const first = await insertNotification(CWD, WORKSPACE_ID, {
      kind: "permission_request",
      title: "Claude needs permission",
      requestId: "req-dup",
    });
    const second = await insertNotification(CWD, WORKSPACE_ID, {
      kind: "permission_request",
      title: "Claude needs permission AGAIN",
      requestId: "req-dup",
    });
    expect(first).not.toBeNull();
    expect(second).toBeNull();
    const rows = await listNotifications(CWD, WORKSPACE_ID);
    expect(rows).toHaveLength(1);
    expect(rows[0].title).toBe("Claude needs permission");
  });

  test("two rows without requestId both land (dedup is partial-index scoped)", async () => {
    // The UNIQUE index is partial on `request_id IS NOT NULL` — two NULLs
    // must NOT collide, otherwise the inbox would coalesce every error.
    await insertNotification(CWD, WORKSPACE_ID, {
      kind: "session_error",
      title: "Session error",
      body: "first",
    });
    await insertNotification(CWD, WORKSPACE_ID, {
      kind: "session_error",
      title: "Session error",
      body: "second",
    });
    const rows = await listNotifications(CWD, WORKSPACE_ID);
    expect(rows).toHaveLength(2);
  });
});

describe("unread counts", () => {
  test("unreadCount tracks insert + mark-read", async () => {
    expect(await unreadCount(CWD)).toBe(0);
    const row = await insertNotification(CWD, WORKSPACE_ID, {
      kind: "session_error",
      title: "x",
    });
    expect(await unreadCount(CWD)).toBe(1);
    await markRead(CWD, [row!.id]);
    expect(await unreadCount(CWD)).toBe(0);
  });

  test("unreadCountsBySession skips rows with no session_id", async () => {
    await insertNotification(CWD, WORKSPACE_ID, {
      kind: "scheduled_run_finished",
      title: "scheduler",
      runId: "run-1",
      jobId: "job-1",
    });
    await insertNotification(CWD, WORKSPACE_ID, {
      kind: "session_error",
      title: "session",
      sessionId: "sess-A",
    });
    const counts = await unreadCountsBySession(CWD);
    expect(counts).toEqual({ "sess-A": 1 });
  });
});

describe("unreadOnly pagination", () => {
  // Regression: the drawer used to fetch `/api/notifications?limit=50` and
  // filter `readAt == null` client-side. With many read rows interspersed
  // newest-first, older unread fell off the window — workspace tile said 4,
  // drawer showed 1. The fix moves the filter to SQL so the drawer's
  // bounded window always contains the unread rows it cares about.
  test("listNotifications with unreadOnly returns only unread rows even when ordered by created_at", async () => {
    // Lay out 60 rows: 55 newest are read, 5 oldest are unread. Without the
    // unreadOnly flag the default 50-row window would entirely miss them.
    const ids: string[] = [];
    const baseTs = Date.now();
    for (let i = 0; i < 60; i++) {
      const r = await insertNotification(CWD, WORKSPACE_ID, {
        kind: "session_error",
        title: `n-${i}`,
        sessionId: "sess",
        createdAt: baseTs - (60 - i), // oldest first → newest last
      });
      ids.push(r!.id);
    }
    // Mark every row read EXCEPT the first 5 (the oldest). The default
    // listNotifications by-created_at-DESC will return the 50 newest read
    // rows and never reach the 5 oldest unread.
    await markRead(CWD, ids.slice(5));

    const allDefault = await listNotifications(CWD, WORKSPACE_ID, { limit: 50 });
    expect(allDefault.filter((r) => r.readAt == null)).toHaveLength(0);

    const unread = await listNotifications(CWD, WORKSPACE_ID, {
      limit: 50,
      unreadOnly: true,
    });
    expect(unread).toHaveLength(5);
    for (const row of unread) expect(row.readAt).toBeNull();
  });

  test("unreadOnly combines with before-cursor pagination", async () => {
    // The drawer's "load older" path uses `before`. Make sure the two
    // filters compose at the SQL level (both indexed, both AND'd in).
    const baseTs = Date.now();
    const a = await insertNotification(CWD, WORKSPACE_ID, {
      kind: "session_error",
      title: "old",
      sessionId: "sess",
      createdAt: baseTs - 1000,
    });
    await insertNotification(CWD, WORKSPACE_ID, {
      kind: "session_error",
      title: "new",
      sessionId: "sess",
      createdAt: baseTs,
    });
    // `before` excludes anything at or after the cursor.
    const rows = await listNotifications(CWD, WORKSPACE_ID, {
      limit: 50,
      unreadOnly: true,
      before: baseTs,
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(a!.id);
  });
});

describe("mark-read paths", () => {
  test("markRead with empty id list is a no-op", async () => {
    const changed = await markRead(CWD, []);
    expect(changed).toBe(0);
  });

  test("markAllRead flips every unread, second call is a no-op", async () => {
    await insertNotification(CWD, WORKSPACE_ID, { kind: "session_error", title: "a" });
    await insertNotification(CWD, WORKSPACE_ID, { kind: "session_error", title: "b" });
    expect(await markAllRead(CWD)).toBe(2);
    expect(await markAllRead(CWD)).toBe(0);
  });

  test("markReadBySession only touches the matching session", async () => {
    await insertNotification(CWD, WORKSPACE_ID, {
      kind: "session_error",
      title: "a",
      sessionId: "sess-A",
    });
    await insertNotification(CWD, WORKSPACE_ID, {
      kind: "session_error",
      title: "b",
      sessionId: "sess-B",
    });
    const changed = await markReadBySession(CWD, "sess-A");
    expect(changed).toBe(1);
    const counts = await unreadCountsBySession(CWD);
    expect(counts).toEqual({ "sess-B": 1 });
  });

  test("markReadByRequestId returns the flipped ids so the bus can fan out", async () => {
    const a = await insertNotification(CWD, WORKSPACE_ID, {
      kind: "permission_request",
      title: "p1",
      requestId: "req-shared",
    });
    expect(a).not.toBeNull();
    const flipped = await markReadByRequestId(CWD, "req-shared");
    expect(flipped).toEqual([a!.id]);
    // Second call returns empty — nothing to flip.
    expect(await markReadByRequestId(CWD, "req-shared")).toEqual([]);
  });

  test("markReadByRequestId returns empty for an empty requestId", async () => {
    // Defensive: the resolve paths sometimes pass through an empty string,
    // and we don't want that to flip every NULL requestId row.
    await insertNotification(CWD, WORKSPACE_ID, {
      kind: "session_error",
      title: "x",
    });
    expect(await markReadByRequestId(CWD, "")).toEqual([]);
    expect(await unreadCount(CWD)).toBe(1);
  });
});

describe("getNotification", () => {
  test("returns the row by id with hydrated payload", async () => {
    const inserted = await insertNotification(CWD, WORKSPACE_ID, {
      kind: "ask_user_question",
      title: "ask",
      payload: { toolUseId: "tu-9" },
    });
    const fetched = await getNotification(CWD, WORKSPACE_ID, inserted!.id);
    expect(fetched?.payload).toEqual({ toolUseId: "tu-9" });
  });

  test("returns null for an unknown id", async () => {
    const fetched = await getNotification(CWD, WORKSPACE_ID, "nope");
    expect(fetched).toBeNull();
  });
});

describe("session prefs", () => {
  test("patching blocked preserves snoozeUntil", async () => {
    await setSessionPrefs(CWD, "sess-X", { snoozeUntil: 12_345 });
    await setSessionPrefs(CWD, "sess-X", { blocked: true });
    const prefs = await getSessionPrefs(CWD, "sess-X");
    expect(prefs).toEqual({
      sessionId: "sess-X",
      blocked: true,
      snoozeUntil: 12_345,
    });
  });

  test("snoozeUntil: null explicitly clears an existing snooze", async () => {
    await setSessionPrefs(CWD, "sess-Y", { snoozeUntil: 12_345 });
    await setSessionPrefs(CWD, "sess-Y", { snoozeUntil: null });
    const prefs = await getSessionPrefs(CWD, "sess-Y");
    expect(prefs?.snoozeUntil).toBeNull();
  });

  test("isSessionMuted: blocked true → muted", async () => {
    await setSessionPrefs(CWD, "sess-Z", { blocked: true });
    expect(await isSessionMuted(CWD, "sess-Z")).toBe(true);
  });

  test("isSessionMuted: future snooze → muted, past snooze → not muted", async () => {
    const future = Date.now() + 60_000;
    await setSessionPrefs(CWD, "sess-W", { snoozeUntil: future });
    expect(await isSessionMuted(CWD, "sess-W")).toBe(true);

    await setSessionPrefs(CWD, "sess-W", { snoozeUntil: Date.now() - 1_000 });
    expect(await isSessionMuted(CWD, "sess-W")).toBe(false);
  });

  test("isSessionMuted: no prefs row → not muted", async () => {
    expect(await isSessionMuted(CWD, "sess-never-set")).toBe(false);
  });
});
