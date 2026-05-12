import { statSync } from "node:fs";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { ServerEvent } from "@/lib/shared/events";
import {
  DEFAULT_ENABLED_KINDS,
  type NotificationKind,
  type NotificationRow,
  type NotificationStreamEvent,
  type WorkspaceNotificationPrefs,
} from "@/lib/shared/notifications";
import { listWorkspaces, workspacesFile, type Workspace } from "./workspaces-store";
import {
  insertNotification,
  isSessionMuted,
  listNotifications,
  markAllRead,
  markRead,
  markReadByRequestId,
  markReadBySession,
  unreadCount,
  unreadCountsBySession,
} from "./notifications-db";

/**
 * Centralised in-process pub/sub for workspace notifications.
 *
 * Producers:
 *   • {@link Session.broadcast} → recordSessionEvent()
 *   • {@link Scheduler} (broadcastRun + fire's finally) → recordSchedulerEvent()
 *
 * Consumers:
 *   • The /api/notifications/stream SSE route — one fanout subscriber per
 *     open browser tab.
 *
 * The bus is the single place where filtering / dedup / persistence happen.
 * Filters (in order):
 *   1. Skip subagent SDK messages (`parent_tool_use_id != null`).
 *   2. Map the {@link ServerEvent} type to a {@link NotificationKind}; drop
 *      anything that doesn't map.
 *   3. Drop if the per-session prefs row blocks or snoozes this session.
 *   4. Drop if the workspace's `enabledKinds` excludes this kind.
 *
 * Survives HMR via the same `globalThis` pattern as `scheduler.ts`.
 */

type RunFinishedEvent = {
  type: "run_finished";
  status: string;
  costUsd?: number;
  note?: string;
};

type AnyEvent = ServerEvent | RunFinishedEvent;

type RecordContext = {
  cwd: string;
  sessionId?: string;
  runId?: string;
  jobId?: string;
};

type Subscriber = (env: NotificationStreamEvent) => void;

/** Window after the last user input during which a `result` event is NOT a notify trigger. */
const IDLE_NOTIFY_MIN_MS = 5_000;
/** Cache TTL for the cross-workspace counts aggregator. */
const COUNTS_CACHE_TTL_MS = 1_000;

class NotificationBus {
  private subscribers = new Set<Subscriber>();
  /** sessionId → epoch ms of last user input. Drives the idle heuristic. */
  private lastUserInputAt = new Map<string, number>();
  /** cwd → workspaceId cache, invalidated by workspaces.json mtime. */
  private cwdMap: Map<string, string> | null = null;
  private cwdMapMtime = 0;
  /** Snapshot of last-known per-workspace unread counts, for delta detection. */
  private lastCounts = new Map<string, number>();
  /** Memoised aggregated counts (`countsAllWorkspaces`). */
  private countsCache: { at: number; data: Record<string, number> } | null = null;

  // ── cwd → workspaceId mapping ─────────────────────────────────────────

  private async refreshCwdMapIfStale(): Promise<void> {
    let mtime = 0;
    try {
      mtime = statSync(workspacesFile()).mtimeMs;
    } catch {
      mtime = 0;
    }
    if (this.cwdMap && mtime === this.cwdMapMtime) return;
    const all = await listWorkspaces().catch(() => [] as Workspace[]);
    const map = new Map<string, string>();
    for (const w of all) map.set(w.rootPath, w.id);
    this.cwdMap = map;
    this.cwdMapMtime = mtime;
  }

  private async lookupWorkspace(cwd: string): Promise<Workspace | null> {
    await this.refreshCwdMapIfStale();
    const id = this.cwdMap?.get(cwd);
    if (!id) return null;
    const all = await listWorkspaces().catch(() => [] as Workspace[]);
    return all.find((w) => w.id === id) ?? null;
  }

  // ── User-input tracking (idle heuristic) ──────────────────────────────

  /**
   * Record that this session received a user input at `at` (defaults to now).
   * The optional override exists for tests that need to assert the idle
   * heuristic without sleeping `IDLE_NOTIFY_MIN_MS` real-time — no production
   * call site passes the second argument.
   */
  markUserInput(sessionId: string, at: number = Date.now()): void {
    this.lastUserInputAt.set(sessionId, at);
  }

  /**
   * Test-only: drop every in-memory cache so the next call starts from a
   * clean slate. Production code must NOT call this — losing subscribers
   * would silently disable the SSE fanout for every open browser tab.
   */
  resetForTests(): void {
    this.subscribers.clear();
    this.lastUserInputAt.clear();
    this.cwdMap = null;
    this.cwdMapMtime = 0;
    this.lastCounts.clear();
    this.countsCache = null;
  }

  // ── Public producer surface ───────────────────────────────────────────

  async recordSessionEvent(
    cwd: string,
    sessionId: string,
    event: ServerEvent,
  ): Promise<void> {
    await this.record(event, { cwd, sessionId });
  }

  async recordSchedulerEvent(
    cwd: string,
    runId: string,
    jobId: string,
    event: AnyEvent,
  ): Promise<void> {
    await this.record(event, { cwd, runId, jobId });
  }

  // ── Public consumer surface ───────────────────────────────────────────

  subscribe(fn: Subscriber): () => void {
    this.subscribers.add(fn);
    return () => {
      this.subscribers.delete(fn);
    };
  }

  async list(
    workspaceId: string,
    opts: { limit?: number; before?: number } = {},
  ): Promise<NotificationRow[]> {
    const ws = await getWorkspaceById(workspaceId);
    if (!ws) return [];
    return listNotifications(ws.rootPath, workspaceId, opts);
  }

  async markRead(workspaceId: string, ids: string[]): Promise<number> {
    const ws = await getWorkspaceById(workspaceId);
    if (!ws) return 0;
    const changed = await markRead(ws.rootPath, ids);
    if (changed > 0) await this.emitCount(workspaceId, ws.rootPath);
    return changed;
  }

  async markAllRead(workspaceId: string): Promise<number> {
    const ws = await getWorkspaceById(workspaceId);
    if (!ws) return 0;
    const changed = await markAllRead(ws.rootPath);
    if (changed > 0) await this.emitCount(workspaceId, ws.rootPath);
    return changed;
  }

  /**
   * Mark every unread row tied to a single session as read. Fired when the
   * user selects the matching tab — the action is "I'm looking at this
   * session now". Emits a workspace count event when at least one row
   * flipped so the bell-tile total and per-tab badge resync.
   */
  async markReadBySession(workspaceId: string, sessionId: string): Promise<number> {
    if (!sessionId) return 0;
    const ws = await getWorkspaceById(workspaceId);
    if (!ws) return 0;
    const changed = await markReadBySession(ws.rootPath, sessionId);
    if (changed > 0) {
      this.invalidateCountsCache();
      await this.emitCount(workspaceId, ws.rootPath);
    }
    return changed;
  }

  /**
   * Mark every row tied to a SDK request as read. Called from the session
   * resolve paths so answering a question / responding to a permission
   * prompt clears the matching inbox row(s) without the user having to
   * hand-mark them. Best-effort: any failure is swallowed because the
   * notification system must never break the resolve path.
   */
  async markReadByRequestId(cwd: string, requestId: string): Promise<void> {
    if (!requestId) return;
    try {
      const ws = await this.lookupWorkspace(cwd);
      if (!ws) return;
      const changedIds = await markReadByRequestId(cwd, requestId);
      if (changedIds.length === 0) return;
      this.invalidateCountsCache();
      await this.emitCount(ws.id, cwd);
    } catch {
      // best-effort
    }
  }

  /**
   * Per-session unread counts for a single workspace, used by the tab strip
   * to paint a "you have N notifications waiting on this session" badge. Not
   * cached — the table is per-workspace and the query is a single indexed
   * GROUP BY, so the cost is negligible compared to the fanout work the bus
   * is already doing on each notification.
   */
  async countsBySession(workspaceId: string): Promise<Record<string, number>> {
    const ws = await getWorkspaceById(workspaceId);
    if (!ws) return {};
    return unreadCountsBySession(ws.rootPath).catch(() => ({}));
  }

  async countsAllWorkspaces(): Promise<Record<string, number>> {
    const now = Date.now();
    if (this.countsCache && now - this.countsCache.at < COUNTS_CACHE_TTL_MS) {
      return this.countsCache.data;
    }
    const all = await listWorkspaces().catch(() => [] as Workspace[]);
    const out: Record<string, number> = {};
    await Promise.all(
      all.map(async (w) => {
        out[w.id] = await unreadCount(w.rootPath).catch(() => 0);
      }),
    );
    this.countsCache = { at: now, data: out };
    for (const [id, n] of Object.entries(out)) this.lastCounts.set(id, n);
    return out;
  }

  // ── Core record() ─────────────────────────────────────────────────────

  private async record(event: AnyEvent, ctx: RecordContext): Promise<void> {
    try {
      // 1. Subagent skip.
      if (event.type === "sdk") {
        const m = event.message as { parent_tool_use_id?: string | null };
        if (m && m.parent_tool_use_id != null) return;
      }

      // 2. Map event → kind. Drop non-mappable events early.
      const mapped = mapEventToKind(event, ctx, this.lastUserInputAt);
      if (!mapped) return;
      const { kind, title, body, payload, requestId } = mapped;

      // 3. cwd → workspace.
      const ws = await this.lookupWorkspace(ctx.cwd);
      if (!ws) return;

      // 4. Workspace `enabledKinds` filter.
      const prefs = ws.defaults?.notifications;
      if (!isKindEnabled(kind, prefs)) return;

      // 5. Per-session mute (block / snooze). Skip for scheduler-only rows.
      if (ctx.sessionId) {
        const muted = await isSessionMuted(ctx.cwd, ctx.sessionId).catch(() => false);
        if (muted) return;
      }

      // 6. Persist.
      const row = await insertNotification(ctx.cwd, ws.id, {
        sessionId: ctx.sessionId ?? null,
        runId: ctx.runId ?? null,
        jobId: ctx.jobId ?? null,
        kind,
        title,
        body: body ?? null,
        payload: payload ?? null,
        requestId: requestId ?? null,
      });
      if (!row) return; // dedup'd by request_id

      // 7. Fanout.
      this.invalidateCountsCache();
      this.emitNotification(row);
      await this.emitCount(ws.id, ctx.cwd);
    } catch {
      // The bus must never throw into a producer. Notifications are a
      // best-effort surface — losing one shouldn't crash the session.
    }
  }

  // ── Fanout helpers ────────────────────────────────────────────────────

  private emitNotification(row: NotificationRow): void {
    const env: NotificationStreamEvent = { type: "notification", notification: row };
    for (const sub of this.subscribers) {
      try {
        sub(env);
      } catch {
        // a single subscriber's failure shouldn't tank the rest
      }
    }
  }

  private async emitCount(workspaceId: string, cwd: string): Promise<void> {
    const n = await unreadCount(cwd).catch(() => 0);
    const prev = this.lastCounts.get(workspaceId);
    if (prev === n) return;
    this.lastCounts.set(workspaceId, n);
    const env: NotificationStreamEvent = { type: "count", workspaceId, unread: n };
    for (const sub of this.subscribers) {
      try {
        sub(env);
      } catch {
        // ignore
      }
    }
  }

  private invalidateCountsCache(): void {
    this.countsCache = null;
  }
}

/**
 * Returns true when the bus is allowed to write a row of `kind` for a
 * workspace with these prefs. Exported for tests; the bus calls it on every
 * `record()`. Logic:
 *   • Master switch `enabled === false` blocks everything.
 *   • Otherwise consult `enabledKinds`; absent ⇒ {@link DEFAULT_ENABLED_KINDS}.
 *     An explicit empty array (`enabledKinds: []`) blocks every kind — used
 *     by workspaces that want to fully opt out without flipping `enabled`.
 */
export function isKindEnabled(
  kind: NotificationKind,
  prefs: WorkspaceNotificationPrefs | undefined,
): boolean {
  if (prefs?.enabled === false) return false;
  const set = prefs?.enabledKinds ?? DEFAULT_ENABLED_KINDS;
  return set.includes(kind);
}

/**
 * Pure event-shape → notification-row mapping. Returns null when the event
 * doesn't produce a notification (subagent skip handled upstream, non-result
 * SDK messages, idle-window suppression, unknown event types).
 *
 * Extracted from the class so unit tests can exercise every branch without
 * standing up a workspace or touching SQLite. The idle heuristic needs the
 * per-session last-input map; tests inject a `Map` they own.
 */
export function mapEventToKind(
  event: AnyEvent,
  ctx: RecordContext,
  lastUserInputAt: Map<string, number>,
  now: number = Date.now(),
): {
  kind: NotificationKind;
  title: string;
  body?: string;
  payload?: Record<string, unknown>;
  requestId?: string;
} | null {
  switch (event.type) {
    case "permission_request":
      return {
        kind: "permission_request",
        title: "Claude needs permission",
        body: event.title ?? event.toolName,
        payload: {
          toolName: event.toolName,
          toolUseId: event.toolUseId,
        },
        requestId: event.requestId,
      };
    case "ask_user_question": {
      const first = event.questions?.[0];
      return {
        kind: "ask_user_question",
        title: "Claude is asking a question",
        body: first?.question ?? undefined,
        payload: { toolUseId: event.toolUseId, header: first?.header },
        requestId: event.requestId,
      };
    }
    case "plan_approval_request":
      return {
        kind: "plan_approval_request",
        title: "Claude has a plan to review",
        body: firstLine(event.plan),
        payload: { toolUseId: event.toolUseId },
        requestId: event.requestId,
      };
    case "error":
      // Defense in depth for the abort-path notification storm: even when
      // `Session.consume()`'s `signal.aborted` guard already filters reaper
      // aborts at the broadcast, drop anything matching the SDK's abort
      // sentinel here too. Two reasons:
      //   1. Pre-HMR Session instances still running the OLD consume() can
      //      slip past the source-side guard until the dev server restarts.
      //      The bus is a singleton on `globalThis` but its `mapEventToKind`
      //      lookup happens at call time, so a code edit here takes effect
      //      on the next event without needing fresh Sessions.
      //   2. User-initiated stop (`query.interrupt()`) also makes the SDK
      //      throw this string but doesn't set `signal.aborted`; the
      //      auto-read gate in `NotificationsProvider` cleans those up when
      //      the user is on the tab, but suppressing the persistence step
      //      avoids the brief workspace-tile flicker entirely.
      // Scheduler runs that genuinely errored still surface — the suppression
      // is gated on `ctx.runId == null` so scheduler error rows keep working.
      if (!ctx.runId && isAbortSentinel(event.message)) return null;
      return {
        kind: ctx.runId ? "scheduled_run_finished" : "session_error",
        title: ctx.runId ? "Scheduled run errored" : "Session error",
        body: event.message,
      };
    case "sdk": {
      const m = event.message as SDKMessage & { type?: string };
      if (m?.type !== "result") return null;
      // Idle heuristic only applies to live sessions, not scheduler runs.
      if (!ctx.sessionId) return null;
      const last = lastUserInputAt.get(ctx.sessionId) ?? 0;
      if (last === 0) return null; // never saw a user input; suppress
      if (now - last < IDLE_NOTIFY_MIN_MS) return null;
      return {
        kind: "session_idle",
        title: "Claude finished a turn",
        body: ctx.cwd,
      };
    }
    case "run_finished": {
      return {
        kind: "scheduled_run_finished",
        title:
          event.status === "success"
            ? "Scheduled run finished"
            : `Scheduled run ${event.status}`,
        body: event.note ?? undefined,
        payload: {
          status: event.status,
          ...(event.costUsd ? { costUsd: event.costUsd } : {}),
        },
      };
    }
    default:
      return null;
  }
}

async function getWorkspaceById(id: string): Promise<Workspace | null> {
  const all = await listWorkspaces().catch(() => [] as Workspace[]);
  return all.find((w) => w.id === id) ?? null;
}

/**
 * Match the SDK's abort message verbatim — both `Session.end()` →
 * `abortController.abort()` (reaper-initiated, the user was AWAY) and
 * `query.interrupt()` (the user pressed stop) cause the SDK to throw with
 * the literal string `"Claude Code process aborted by user"`. Neither is a
 * real error worth notifying about, so the bus drops them. Anything else
 * still flows through the normal `session_error` path.
 */
function isAbortSentinel(message: string | undefined | null): boolean {
  if (!message) return false;
  return message.trim() === "Claude Code process aborted by user";
}

function firstLine(s: string | undefined | null): string | undefined {
  if (!s) return undefined;
  const line = s.split(/\r?\n/)[0]?.trim();
  if (!line) return undefined;
  return line.length > 200 ? line.slice(0, 197) + "…" : line;
}

// HMR-safe singleton — same pattern as scheduler.ts. The probe checks for a
// method introduced after the cache might have been written, so an old
// instance gets rebuilt on file edit during `bun run dev`.
declare global {
  var __claudiusNotificationBus: NotificationBus | undefined;
}

function pickBus(): NotificationBus {
  const cached = globalThis.__claudiusNotificationBus;
  // Probe checks for the LATEST method on the class so an HMR-cached
  // instance that predates a new bus API gets rebuilt rather than serving
  // stale shape (`notificationBus.<newMethod> is not a function` 500s).
  // Bump this when you add a new method.
  if (cached && typeof (cached as NotificationBus).markReadBySession === "function") {
    return cached;
  }
  const fresh = new NotificationBus();
  globalThis.__claudiusNotificationBus = fresh;
  return fresh;
}

export const notificationBus: NotificationBus = pickBus();
export type { NotificationBus };
