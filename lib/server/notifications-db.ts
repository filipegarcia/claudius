import { randomUUID } from "node:crypto";
import { openDb, type DB } from "./db";
import {
  ACTIONABLE_KINDS,
  type NotificationKind,
  type NotificationRow,
  type SessionNotificationPrefs,
} from "@/lib/shared/notifications";

/**
 * Per-workspace SQLite ops for the notifications inbox. The notifications
 * table lives in each workspace's `.claudius.db` (migration 005); this module
 * keeps every read/write keyed by the workspace's `cwd` so the bus stays
 * decoupled from the workspace registry.
 */

type RawRow = {
  id: string;
  session_id: string | null;
  run_id: string | null;
  job_id: string | null;
  kind: string;
  title: string;
  body: string | null;
  payload: string | null;
  request_id: string | null;
  created_at: number;
  read_at: number | null;
};

function hydrate(row: RawRow, workspaceId: string): NotificationRow {
  let payload: Record<string, unknown> | null = null;
  if (row.payload) {
    try {
      const parsed = JSON.parse(row.payload) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        payload = parsed as Record<string, unknown>;
      }
    } catch {
      // malformed JSON — surface as null rather than crash the list view
    }
  }
  return {
    id: row.id,
    workspaceId,
    sessionId: row.session_id,
    runId: row.run_id,
    jobId: row.job_id,
    kind: row.kind as NotificationKind,
    title: row.title,
    body: row.body,
    payload,
    createdAt: row.created_at,
    readAt: row.read_at,
  };
}

/**
 * Insert a notification row. Returns the persisted row, or `null` if a row
 * with the same `requestId` already existed (the partial UNIQUE index on
 * `request_id` makes `INSERT OR IGNORE` a clean dedup for the resubscribe
 * replay path). Caller picks the workspaceId because the bus knows it from
 * its cwd cache and we don't want to recompute it for every row.
 */
export async function insertNotification(
  cwd: string,
  workspaceId: string,
  input: {
    id?: string;
    sessionId?: string | null;
    runId?: string | null;
    jobId?: string | null;
    kind: NotificationKind;
    title: string;
    body?: string | null;
    payload?: Record<string, unknown> | null;
    requestId?: string | null;
    createdAt?: number;
  },
): Promise<NotificationRow | null> {
  const db = await openDb(cwd);
  const id = input.id ?? randomUUID();
  const createdAt = input.createdAt ?? Date.now();
  const payload = input.payload ? JSON.stringify(input.payload) : null;
  const res = db
    .prepare(
      `INSERT OR IGNORE INTO notifications
         (id, session_id, run_id, job_id, kind, title, body, payload, request_id, created_at, read_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
    )
    .run(
      id,
      input.sessionId ?? null,
      input.runId ?? null,
      input.jobId ?? null,
      input.kind,
      input.title,
      input.body ?? null,
      payload,
      input.requestId ?? null,
      createdAt,
    );
  if (res.changes === 0) return null;
  return {
    id,
    workspaceId,
    sessionId: input.sessionId ?? null,
    runId: input.runId ?? null,
    jobId: input.jobId ?? null,
    kind: input.kind,
    title: input.title,
    body: input.body ?? null,
    payload: input.payload ?? null,
    createdAt,
    readAt: null,
  };
}

/**
 * Paginated list, newest first.
 *
 * `before` is a `created_at` cursor for pulling older pages.
 *
 * `unreadOnly` restricts the query at the SQL level so the drawer always sees
 * every unread row in its window — without this flag, the drawer's 50-row
 * cap was filling with read rows above the unread ones, leaving older unread
 * invisible while the workspace badge still counted them (the "tile = 4,
 * drawer = 1" symptom that motivated the redesign).
 */
export async function listNotifications(
  cwd: string,
  workspaceId: string,
  opts: { limit?: number; before?: number; unreadOnly?: boolean } = {},
): Promise<NotificationRow[]> {
  const db = await openDb(cwd, "readonly").catch(() => null);
  if (!db) return [];
  const limit = Math.max(1, Math.min(200, opts.limit ?? 50));
  // Build the WHERE clause dynamically. Both filters are indexed
  // (`idx_notif_unread` on `(read_at, created_at)`), so adding the
  // `read_at IS NULL` predicate is a pure win — fewer rows scanned, no
  // additional client-side filtering pass.
  const where: string[] = [];
  const args: unknown[] = [];
  if (opts.unreadOnly) where.push("read_at IS NULL");
  if (opts.before) {
    where.push("created_at < ?");
    args.push(opts.before);
  }
  const whereClause = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";
  args.push(limit);
  const rows = db
    .prepare(
      `SELECT id, session_id, run_id, job_id, kind, title, body, payload, request_id, created_at, read_at
       FROM notifications ${whereClause}
       ORDER BY created_at DESC LIMIT ?`,
    )
    .all(...args) as RawRow[];
  return rows.map((r) => hydrate(r, workspaceId));
}

/** Count of unread rows for this workspace's DB. */
export async function unreadCount(cwd: string): Promise<number> {
  const db = await openDb(cwd, "readonly").catch(() => null);
  if (!db) return 0;
  return unreadCountOn(db);
}

/**
 * Synchronous variant for the bus's hot path. better-sqlite3 is itself sync;
 * the async wrapper only exists so callers don't have to think about handle
 * caching. Once the bus has obtained the DB handle via `openDb` (which the
 * insert path always does first), it can re-use it through this helper to
 * compute counts without a microtask-yielding `await`. That matters because
 * the bus's coalesced state emit runs inside a `setTimeout(0)` callback that
 * needs to complete the fanout SYNCHRONOUSLY — otherwise downstream
 * `await new Promise(r => setTimeout(r, 0))` test helpers and real
 * subscribers race the internal awaits and see stale state.
 */
export function unreadCountOn(db: DB): number {
  const row = db
    .prepare<[], { n: number } | undefined>(
      `SELECT COUNT(*) AS n FROM notifications WHERE read_at IS NULL`,
    )
    .get();
  return row?.n ?? 0;
}

/**
 * Unread row counts grouped by `session_id`. Returned as a plain object keyed
 * by session id — rows without a `session_id` (scheduler-only notifications)
 * are skipped because the tabs strip can't surface them anyway. Used by the
 * tabs strip to paint a per-tab unread badge.
 */
export async function unreadCountsBySession(
  cwd: string,
): Promise<Record<string, number>> {
  const db = await openDb(cwd, "readonly").catch(() => null);
  if (!db) return {};
  return unreadCountsBySessionOn(db);
}

/** Synchronous variant — see {@link unreadCountOn} for the rationale. */
export function unreadCountsBySessionOn(db: DB): Record<string, number> {
  const rows = db
    .prepare<[], { session_id: string; n: number }>(
      `SELECT session_id, COUNT(*) AS n
         FROM notifications
        WHERE read_at IS NULL AND session_id IS NOT NULL
        GROUP BY session_id`,
    )
    .all();
  const out: Record<string, number> = {};
  for (const r of rows) out[r.session_id] = r.n;
  return out;
}

export async function markRead(cwd: string, ids: string[]): Promise<number> {
  if (ids.length === 0) return 0;
  const db = await openDb(cwd);
  const now = Date.now();
  const placeholders = ids.map(() => "?").join(",");
  const res = db
    .prepare(
      `UPDATE notifications SET read_at = ? WHERE read_at IS NULL AND id IN (${placeholders})`,
    )
    .run(now, ...ids);
  return res.changes;
}

export async function markAllRead(cwd: string): Promise<number> {
  const db = await openDb(cwd);
  const now = Date.now();
  const res = db
    .prepare(`UPDATE notifications SET read_at = ? WHERE read_at IS NULL`)
    .run(now);
  return res.changes;
}

/**
 * Mark every unread row of a single kind as read. Used when the user
 * disables a kind from the workspace settings — once they've said "stop
 * notifying me about X", we shouldn't leave a backlog of X rows haunting
 * the workspace badge. Returns the number of rows that flipped so the bus
 * can decide whether to emit a state event.
 */
export async function markReadByKind(
  cwd: string,
  kind: NotificationKind,
): Promise<number> {
  if (!kind) return 0;
  const db = await openDb(cwd);
  const now = Date.now();
  const res = db
    .prepare(
      `UPDATE notifications SET read_at = ? WHERE read_at IS NULL AND kind = ?`,
    )
    .run(now, kind);
  return res.changes;
}

/**
 * Mark every unread row for a single session as read. Used by the chat page
 * when the user selects (or re-selects) a tab — the implicit contract is
 * "I'm looking at this session now, the inbox can clear it." Returns the
 * number of rows that flipped so the bus can decide whether to emit a count
 * event.
 *
 * **Actionable kinds are preserved.** `permission_request` /
 * `ask_user_question` / `plan_approval_request` rows survive this sweep
 * because the agent is still blocked on the user. Clearing them on a passive
 * "I switched to this tab" gesture would leave the badge silent for a request
 * that still needs an explicit Allow/Deny / answer / Accept-Reject. Those rows
 * are cleared instead by `markReadByRequestId`, fired from the resolve paths
 * once the user actually answers. The client-side SSE auto-read predicate in
 * `NotificationsProvider` mirrors this filter; see `ACTIONABLE_KINDS`.
 */
export async function markReadBySession(
  cwd: string,
  sessionId: string,
): Promise<number> {
  if (!sessionId) return 0;
  const db = await openDb(cwd);
  const now = Date.now();
  // SQLite has no array-binding for IN(...); build the placeholder list from
  // the shared constant so the two channels (this SQL + client predicate)
  // stay in lockstep when a new actionable kind is added.
  const placeholders = ACTIONABLE_KINDS.map(() => "?").join(", ");
  const res = db
    .prepare(
      `UPDATE notifications SET read_at = ?
        WHERE read_at IS NULL
          AND session_id = ?
          AND kind NOT IN (${placeholders})`,
    )
    .run(now, sessionId, ...ACTIONABLE_KINDS);
  return res.changes;
}

/**
 * Mark every unread *actionable* row (permission/ask/plan) tied to a session
 * as read. The mirror of {@link markReadBySession}: that one preserves
 * actionable rows because the agent is still blocked on the user; this one
 * sweeps them up when we KNOW the request can no longer be answered —
 * typically because the in-memory pending entry has been dropped (server
 * restart, session reaper, SDK abort) and there is no live modal left for
 * the user to act on.
 *
 * Called at `Session.start()` for fresh instances (the pending* maps are
 * empty by construction, so any actionable row in the DB is by definition
 * orphaned), and as a defensive sweep from {@link drainPendingDecisions}
 * for entries that go away mid-session without going through the normal
 * resolve path.
 *
 * Returns the row count for state-emit gating.
 */
export async function markReadActionableBySession(
  cwd: string,
  sessionId: string,
): Promise<number> {
  if (!sessionId) return 0;
  const db = await openDb(cwd);
  const now = Date.now();
  const placeholders = ACTIONABLE_KINDS.map(() => "?").join(", ");
  const res = db
    .prepare(
      `UPDATE notifications SET read_at = ?
        WHERE read_at IS NULL
          AND session_id = ?
          AND kind IN (${placeholders})`,
    )
    .run(now, sessionId, ...ACTIONABLE_KINDS);
  return res.changes;
}

/**
 * Mark every unread row that shares `requestId` as read. Used by the session
 * resolve paths (submitAskAnswer, resolvePermission, resolvePlan) so a
 * question that the user has already answered stops haunting the inbox.
 *
 * Returns the ids of the rows that flipped from unread → read so the bus can
 * fan them out to live subscribers (the drawer/badge update without a
 * round-trip to /api/notifications).
 */
export async function markReadByRequestId(
  cwd: string,
  requestId: string,
): Promise<string[]> {
  if (!requestId) return [];
  const db = await openDb(cwd);
  const rows = db
    .prepare<[string], { id: string }>(
      `SELECT id FROM notifications WHERE read_at IS NULL AND request_id = ?`,
    )
    .all(requestId);
  if (rows.length === 0) return [];
  const now = Date.now();
  db.prepare(
    `UPDATE notifications SET read_at = ? WHERE read_at IS NULL AND request_id = ?`,
  ).run(now, requestId);
  return rows.map((r) => r.id);
}

export async function getNotification(
  cwd: string,
  workspaceId: string,
  id: string,
): Promise<NotificationRow | null> {
  const db = await openDb(cwd, "readonly").catch(() => null);
  if (!db) return null;
  const row = db
    .prepare<[string], RawRow | undefined>(
      `SELECT id, session_id, run_id, job_id, kind, title, body, payload, request_id, created_at, read_at
       FROM notifications WHERE id = ?`,
    )
    .get(id);
  return row ? hydrate(row, workspaceId) : null;
}

// ── Per-session prefs ──────────────────────────────────────────────────

type PrefRow = {
  session_id: string;
  blocked: number;
  snooze_until: number | null;
};

export async function getSessionPrefs(
  cwd: string,
  sessionId: string,
): Promise<SessionNotificationPrefs | null> {
  const db = await openDb(cwd, "readonly").catch(() => null);
  if (!db) return null;
  const row = db
    .prepare<[string], PrefRow | undefined>(
      `SELECT session_id, blocked, snooze_until FROM session_notification_prefs WHERE session_id = ?`,
    )
    .get(sessionId);
  if (!row) return null;
  return {
    sessionId: row.session_id,
    blocked: row.blocked === 1,
    snoozeUntil: row.snooze_until,
  };
}

/**
 * Insert-or-update per-session prefs. The bus consults this on every
 * `record()` call so changes take effect immediately for the next event.
 * Pass `null` for `snoozeUntil` to clear an existing snooze.
 */
export async function setSessionPrefs(
  cwd: string,
  sessionId: string,
  patch: { blocked?: boolean; snoozeUntil?: number | null },
): Promise<SessionNotificationPrefs> {
  const db = await openDb(cwd);
  const existing = db
    .prepare<[string], PrefRow | undefined>(
      `SELECT session_id, blocked, snooze_until FROM session_notification_prefs WHERE session_id = ?`,
    )
    .get(sessionId);
  const blocked = patch.blocked ?? (existing?.blocked === 1);
  const snoozeUntil =
    patch.snoozeUntil === undefined ? existing?.snooze_until ?? null : patch.snoozeUntil;
  db.prepare(
    `INSERT INTO session_notification_prefs(session_id, blocked, snooze_until)
     VALUES (?, ?, ?)
     ON CONFLICT(session_id) DO UPDATE SET
       blocked      = excluded.blocked,
       snooze_until = excluded.snooze_until`,
  ).run(sessionId, blocked ? 1 : 0, snoozeUntil);
  return { sessionId, blocked, snoozeUntil };
}

/**
 * Returns true if the bus should drop events for this session right now.
 * Centralized so the bus doesn't have to know the encoding of the row.
 */
export async function isSessionMuted(cwd: string, sessionId: string): Promise<boolean> {
  const prefs = await getSessionPrefs(cwd, sessionId);
  if (!prefs) return false;
  if (prefs.blocked) return true;
  if (prefs.snoozeUntil != null && prefs.snoozeUntil > Date.now()) return true;
  return false;
}
