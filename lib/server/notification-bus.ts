import { statSync } from "node:fs";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { ServerEvent } from "@/lib/shared/events";
import {
  DEFAULT_ENABLED_KINDS,
  type NotificationKind,
  type NotificationRow,
  type NotificationStreamEvent,
  type WorkspaceNotificationPrefs,
  type WorkspaceUnreadState,
} from "@/lib/shared/notifications";
import { listWorkspaces, workspacesFile, type Workspace } from "./workspaces-store";
import { getCachedDb, openDb } from "./db";
import {
  insertNotification,
  isSessionMuted,
  listNotifications,
  markAllRead,
  markRead,
  markReadByKind,
  markReadByRequestId,
  markReadBySession,
  unreadCount,
  unreadCountOn,
  unreadCountsBySession,
  unreadCountsBySessionOn,
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
  /**
   * Whether the originating session currently has at least one SSE
   * subscriber. Used to suppress *background* notifications whose only
   * value is "Claude finished a turn over there" or "Session over there
   * errored" — when the user has switched to another session tab they
   * don't want either kind interrupting them. Actionable kinds
   * (permission_request, ask_user_question, plan_approval_request) ignore
   * this flag and notify regardless, because they require the user's
   * attention to make progress. Defaults to `true` so scheduler events
   * (which carry no sessionId) are unaffected.
   */
  hasSubscribers?: boolean;
};

type Subscriber = (env: NotificationStreamEvent) => void;

class NotificationBus {
  private subscribers = new Set<Subscriber>();
  /** sessionId → epoch ms of last user input. Drives the idle heuristic. */
  private lastUserInputAt = new Map<string, number>();
  /** cwd → workspaceId cache, invalidated by workspaces.json mtime. */
  private cwdMap: Map<string, string> | null = null;
  private cwdMapMtime = 0;
  /**
   * Last emitted unread state per workspace. New emissions bump `version` so
   * out-of-order clients can drop stale updates. This is the SINGLE source
   * of truth for what counts the SSE subscribers have seen — the prior
   * `lastCounts: Map<string,number>` mixed "what's in the DB" with "what we
   * told the client" and short-circuited on equality, which lost legitimate
   * count updates under concurrent mark-reads. `version` decouples them.
   */
  private perWorkspace = new Map<string, WorkspaceUnreadState>();
  /**
   * Coalesce in-tick state emissions per workspace. When `record()` inserts a
   * row and a follow-up `markReadByRequestId` fires in the same tick (the
   * resolve path of permission/ask/plan flows), we want ONE state event
   * carrying the final values — not "+1 then −1" flicker. Tracks the
   * pending `setTimeout` handle so `resetForTests` can clear it; otherwise
   * a leftover timer from one test fires into the next and pollutes its
   * `envs` capture.
   */
  private pendingFlush = new Map<string, ReturnType<typeof setTimeout>>();

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
    if (!id) {
      // [dbg-notif] CI-only diagnostic — see why notification tests fail on
      // Linux runners but pass on macOS. Remove once the cwd→workspaceId
      // mismatch is identified and fixed. Logs full keys so we can spot
      // realpath/normalization differences between the test caller and
      // the workspaces store.
      const keys = Array.from(this.cwdMap?.keys() ?? []);
      console.log(
        "[dbg-notif] lookupWorkspace MISS",
        JSON.stringify({ cwd, mapSize: keys.length, keys }),
      );
      return null;
    }
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
    this.perWorkspace.clear();
    // Clear pending timers so an in-flight setTimeout from one test can't
    // fire inside the next test and pollute its `envs` capture.
    for (const handle of this.pendingFlush.values()) {
      clearTimeout(handle);
    }
    this.pendingFlush.clear();
  }

  // ── Public producer surface ───────────────────────────────────────────

  async recordSessionEvent(
    cwd: string,
    sessionId: string,
    event: ServerEvent,
    opts: { hasSubscribers?: boolean } = {},
  ): Promise<void> {
    await this.record(event, {
      cwd,
      sessionId,
      hasSubscribers: opts.hasSubscribers,
    });
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
    opts: { limit?: number; before?: number; unreadOnly?: boolean } = {},
  ): Promise<NotificationRow[]> {
    const ws = await getWorkspaceById(workspaceId);
    if (!ws) return [];
    return listNotifications(ws.rootPath, workspaceId, opts);
  }

  /**
   * Cross-workspace listing for the notification drawer. The drawer used to
   * be per-workspace, which meant a notification fired in a workspace the
   * user wasn't currently in was invisible — favicon/title counted it
   * because they aggregate, but the drawer showed "You're all caught up"
   * for the active workspace. Aggregating here closes that gap.
   *
   * Fetches `limit` per workspace (cheap with the new `unreadOnly` index)
   * and merges in created_at DESC order, then truncates to `limit`.
   */
  async listAcrossWorkspaces(opts: {
    limit?: number;
    unreadOnly?: boolean;
  } = {}): Promise<NotificationRow[]> {
    const limit = Math.max(1, Math.min(200, opts.limit ?? 50));
    const all = await listWorkspaces().catch(() => [] as Workspace[]);
    const perWs = await Promise.all(
      all.map((w) =>
        listNotifications(w.rootPath, w.id, {
          limit,
          ...(opts.unreadOnly ? { unreadOnly: true } : {}),
        }).catch(() => [] as NotificationRow[]),
      ),
    );
    const merged = perWs.flat();
    merged.sort((a, b) => b.createdAt - a.createdAt);
    return merged.slice(0, limit);
  }

  async markRead(workspaceId: string, ids: string[]): Promise<number> {
    const ws = await getWorkspaceById(workspaceId);
    if (!ws) return 0;
    const changed = await markRead(ws.rootPath, ids);
    if (changed > 0) this.scheduleStateEmit(workspaceId, ws.rootPath);
    return changed;
  }

  async markAllRead(workspaceId: string): Promise<number> {
    const ws = await getWorkspaceById(workspaceId);
    if (!ws) return 0;
    const changed = await markAllRead(ws.rootPath);
    if (changed > 0) this.scheduleStateEmit(workspaceId, ws.rootPath);
    return changed;
  }

  /**
   * Mark every unread row tied to a single session as read. Fired when the
   * user selects the matching tab — the action is "I'm looking at this
   * session now". Emits a state event when at least one row flipped so
   * subscribers resync.
   */
  async markReadBySession(workspaceId: string, sessionId: string): Promise<number> {
    if (!sessionId) return 0;
    const ws = await getWorkspaceById(workspaceId);
    if (!ws) return 0;
    const changed = await markReadBySession(ws.rootPath, sessionId);
    if (changed > 0) this.scheduleStateEmit(workspaceId, ws.rootPath);
    return changed;
  }

  /**
   * Mark every unread row of one kind in a workspace as read. Fires when
   * the user disables a notification kind from the workspace settings —
   * the backlog of that kind should clear so it doesn't haunt the badge
   * after the user has said "stop showing me X".
   */
  async markReadByKind(
    workspaceId: string,
    kind: NotificationKind,
  ): Promise<number> {
    if (!kind) return 0;
    const ws = await getWorkspaceById(workspaceId);
    if (!ws) return 0;
    const changed = await markReadByKind(ws.rootPath, kind);
    if (changed > 0) this.scheduleStateEmit(workspaceId, ws.rootPath);
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
      this.scheduleStateEmit(ws.id, cwd);
    } catch {
      // best-effort
    }
  }

  /**
   * Snapshot the unread state for one workspace. Fresh DB read; not cached.
   * Returns the bus's last-emitted version when the snapshot matches it (so
   * callers that pair the snapshot with the SSE stream can drop stale
   * events without a +1 race); otherwise bumps `version` and stores the
   * fresh state so the next emit starts from a known monotonic point.
   *
   * Used by:
   *   • `/api/notifications/counts` (boot + reconnect repair)
   *   • the SSE stream's connect-seed loop in `/api/notifications/stream`
   */
  async getWorkspaceState(workspaceId: string): Promise<WorkspaceUnreadState | null> {
    const ws = await getWorkspaceById(workspaceId);
    if (!ws) return null;
    return this.computeAndStoreState(workspaceId, ws.rootPath);
  }

  /** Snapshot every workspace. Map keyed by workspaceId. */
  async getAllWorkspaceStates(): Promise<Record<string, WorkspaceUnreadState>> {
    const all = await listWorkspaces().catch(() => [] as Workspace[]);
    const out: Record<string, WorkspaceUnreadState> = {};
    await Promise.all(
      all.map(async (w) => {
        const s = await this.computeAndStoreState(w.id, w.rootPath).catch(() => null);
        if (s) out[w.id] = s;
      }),
    );
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

      // 2. cwd → workspace.
      const ws = await this.lookupWorkspace(ctx.cwd);
      if (!ws) return;

      // The `state` SSE event is the only signal that bumps `stateVersion`
      // in every browser tab, which is what `app/page.tsx` ties to
      // `refreshSessions()` so inactive tabs can re-read `/api/sessions`
      // and repaint their status dot. We must emit it for any session
      // event that changes `Session.getStatus()` — even when downstream
      // filters (kind mapping, enabledKinds, per-session mute) reject the
      // event for notification purposes. Without this, a backgrounded
      // session that finishes its turn would stay "running" on every
      // other tab forever. Computed once here; called at every exit point
      // below so the emit happens after any awaits have settled (the
      // pendingFlush guard collapses sibling emits into one fanout, but
      // can't help if we fire BEFORE the relevant insert lands).
      //
      // Respects the workspace master switch (`notifications.enabled =
      // false`) — that toggle means "make this workspace completely
      // silent" and we honour it across both channels (rows + status
      // sync). The kind-level filter and per-session mute are NOT gates
      // for status sync: a user who turned off `session_idle` toasts
      // still wants their tab dot to reflect that the session went idle.
      const masterEnabled = ws.defaults?.notifications?.enabled !== false;
      const statusSync =
        masterEnabled && !!ctx.sessionId && isStatusSyncRelevant(event);
      if (statusSync && !getCachedDb(ctx.cwd)) {
        // Cold-cache prime: when the first event for a workspace is a
        // non-mapping one (e.g. an HMR-rebuilt server seeing a backgrounded
        // session's first `turn_status` after restart), nothing has called
        // `insertNotification` yet — `emitStateSync` would find no cached
        // handle and silently drop the emit. Open the DB once now so the
        // timer callback's sync read finds it. Scoped to the cold-cache
        // case (via `!getCachedDb(...)`) so the bus's hot path pays
        // nothing on every subsequent status-sync event in the session's
        // lifetime — only the very first event per workspace per server
        // boot eats the open/migrate cost, which it would have paid on
        // its first row insert anyway.
        await openDb(ctx.cwd, "readwrite").catch(() => null);
      }
      const emitStatusSync = () => {
        if (statusSync) this.scheduleStateEmit(ws.id, ctx.cwd);
      };

      // 3. Map event → kind.
      const mapped = mapEventToKind(event, ctx, this.lastUserInputAt);
      if (!mapped) {
        // No row to persist (turn_status, ready, sdk non-result, sdk
        // result outside the idle window, …). Status-sync still needs to
        // fire so inactive tabs refresh.
        emitStatusSync();
        return;
      }
      const { kind, title, body, payload, requestId } = mapped;

      // 3.5 Background-session OS-toast suppression. Sessions the user has
      // switched away from (no active SSE subscriber) shouldn't *pop a toast*
      // for idle "Claude finished a turn" or "Session error" — the user gets
      // that feedback in the chat itself when they come back, AND the per-tab
      // badge / workspace tile / drawer still tick (because we persist the
      // row below). Actionable kinds (permission/ask/plan) override this gate
      // because they're requests the agent is *blocked on*; the user has to
      // come look at them regardless of which tab they're on.
      //
      // Earlier rounds dropped the row entirely here, which was wrong: it
      // killed the badge AND the toast, so a session finishing in the
      // background was completely invisible. We now compute the toast gate
      // once and skip ONLY the per-row `notification` event emission, not
      // the persistence or the `state` event. `hasSubscribers === undefined`
      // means the caller didn't tell us (e.g. dev-emit), so we err toward
      // notifying.
      const suppressOsToast =
        !!ctx.sessionId &&
        ctx.hasSubscribers === false &&
        isBackgroundSuppressible(kind);

      // 4. Workspace `enabledKinds` filter.
      const prefs = ws.defaults?.notifications;
      if (!isKindEnabled(kind, prefs)) {
        emitStatusSync();
        return;
      }

      // 5. Per-session mute (block / snooze). Skip for scheduler-only rows.
      if (ctx.sessionId) {
        const muted = await isSessionMuted(ctx.cwd, ctx.sessionId).catch(() => false);
        if (muted) {
          emitStatusSync();
          return;
        }
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
      if (!row) {
        // Dedup'd by request_id. No row, but status may still have moved.
        emitStatusSync();
        return;
      }

      // 7. Fanout. The `notification` event drives OS toasts and the inbox
      // `recent` buffer — skip it for background-suppressible kinds on
      // unsubscribed sessions (see `suppressOsToast` above) so a session the
      // user has switched away from doesn't pop a toast for "finished a
      // turn" / "errored". The `state` event always fires: that's what
      // bumps the per-tab badge, the workspace tile, and the drawer's
      // unread count, so the user can still SEE that something happened on
      // the backgrounded session when they look at the tab strip. The
      // state emission is coalesced: if a sibling `markReadByRequestId`
      // fires in the same tick (the resolve flow), both writes collapse
      // into one state event with the final values — no transient +1/-1
      // flicker on the workspace tile.
      if (!suppressOsToast) this.emitNotification(row);
      this.scheduleStateEmit(ws.id, ctx.cwd);
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

  /**
   * Schedule (and coalesce) a state-event flush for one workspace. Multiple
   * calls in the same JS task collapse into a single emit at the end of the
   * task — so a server-side resolve flow that inserts a row and then marks
   * it read (record() → markReadByRequestId() in the same handler) produces
   * one event carrying the final values, not two events that briefly
   * disagree.
   *
   * Uses `setTimeout(..., 0)` rather than `queueMicrotask`: the latter
   * fails to coalesce across `await` boundaries within a single task,
   * because each await drains the microtask queue. The timer-queue
   * macrotask waits until ALL currently-pending microtasks (including
   * cascades of awaits) have settled, so concurrent `Promise.all([record,
   * record, record])` plus the typical resolve-flow patterns both
   * coalesce to one emit.
   *
   * The flush itself awaits a fresh DB read + fans out to subscribers.
   * Callers do NOT await it — `record()` / `mark*Read()` return the row
   * count and shouldn't pay the round-trip latency.
   */
  private scheduleStateEmit(workspaceId: string, cwd: string): void {
    if (this.pendingFlush.has(workspaceId)) return;
    const handle = setTimeout(() => {
      // Clear the flag BEFORE the emit so any further writes that come in
      // while we're computing schedule a fresh flush, rather than being
      // swallowed.
      this.pendingFlush.delete(workspaceId);
      this.emitStateSync(workspaceId, cwd);
    }, 0);
    this.pendingFlush.set(workspaceId, handle);
  }

  /**
   * Read fresh state from the DB, bump `version`, store it, and fan out a
   * `state` event. No equality short-circuit — the prior `emitCount` used
   * `if (prev === n) return;` to suppress no-op emissions, but that lost
   * legitimate per-session updates (e.g. a row moved from session A to
   * session B leaves the workspace total unchanged but the per-session
   * map changed). With version gating client-side, redundant emissions
   * are cheap; missed emissions are expensive.
   */
  /**
   * Synchronous emit path. Reads the cached DB handle (always populated by
   * the time `record()` / `mark*Read` calls us, since the insert/mark op
   * just used it) and emits a state event without any internal awaits.
   * Synchronous emission is the contract that lets `setTimeout(0)`-based
   * coalescing actually work: a subsequent `await Promise(setTimeout 0)` in
   * a test or upstream caller is guaranteed to see the state event in the
   * subscriber's buffer, because the for-loop fanout completes before the
   * timer callback returns control.
   *
   * Falls back to no-op if the handle isn't cached (extremely unlikely:
   * means we got here without anyone having ever called openDb for this
   * cwd, e.g. an isolated `markRead` against a workspace with no inserts
   * yet — in which case there's nothing to read anyway).
   */
  private emitStateSync(workspaceId: string, cwd: string): void {
    const db = getCachedDb(cwd, "readwrite") ?? getCachedDb(cwd, "readonly");
    if (!db) return;
    const totalUnread = unreadCountOn(db);
    const perSession = unreadCountsBySessionOn(db);
    const prev = this.perWorkspace.get(workspaceId);
    const version = (prev?.version ?? 0) + 1;
    const state: WorkspaceUnreadState = { workspaceId, version, totalUnread, perSession };
    this.perWorkspace.set(workspaceId, state);
    const env: NotificationStreamEvent = { type: "state", ...state };
    for (const sub of this.subscribers) {
      try {
        sub(env);
      } catch {
        // a single subscriber's failure shouldn't tank the rest
      }
    }
  }

  /**
   * Async snapshot used by the HTTP /counts route and the SSE stream's
   * connect-seed loop. Opens the DB (which may be the first open if the
   * workspace has no in-flight session) and returns the state, bumping
   * `version` so the client's version gate stays consistent across the
   * HTTP and SSE paths.
   */
  private async computeAndStoreState(
    workspaceId: string,
    cwd: string,
  ): Promise<WorkspaceUnreadState> {
    const [totalUnread, perSession] = await Promise.all([
      unreadCount(cwd).catch(() => 0),
      unreadCountsBySession(cwd).catch(() => ({} as Record<string, number>)),
    ]);
    const prev = this.perWorkspace.get(workspaceId);
    const version = (prev?.version ?? 0) + 1;
    const next: WorkspaceUnreadState = {
      workspaceId,
      version,
      totalUnread,
      perSession,
    };
    this.perWorkspace.set(workspaceId, next);
    return next;
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
      // We used to gate this on `now - last >= IDLE_NOTIFY_MIN_MS` (a 5s
      // window after the user typed). The intent was "don't ding the
      // user for the response they're already watching" — but the race
      // between `hasSubscribers` flipping false (when the user clicks a
      // new tab) and the server-side `result` event meant that a quick
      // turn on a backgrounded session (the `wait 1 seconds and ack`
      // case from the bug report) almost always landed inside the
      // window, was suppressed, and never surfaced anywhere. The
      // NotificationsProvider auto-read gate
      // (`sameSessionVisible → POST /:id/read`) is the right place to
      // suppress the ding for sessions the user is actively looking at;
      // it's client-side, runs after the row arrives, and doesn't
      // depend on a race-y subscriber-count read.
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

/**
 * True for notification kinds we suppress when the originating session has
 * no live SSE subscriber. These are the "FYI, something happened in the
 * background" categories — when the user has switched to another tab the
 * feedback is redundant noise.
 *
 * Actionable kinds — permission_request, ask_user_question,
 * plan_approval_request — are excluded: the agent is blocked on them and
 * the user needs to come look. Scheduler runs aren't session-bound, so
 * `scheduled_run_finished` is also excluded (the guard upstream checks
 * `ctx.sessionId` anyway).
 */
function isBackgroundSuppressible(kind: NotificationKind): boolean {
  return kind === "session_idle" || kind === "session_error";
}

/**
 * True for events that move `Session.getStatus()` (running ↔ idle) or
 * otherwise tell inactive tabs they need to re-pull `/api/sessions`. The bus
 * fires a `state` SSE event for these regardless of whether the event also
 * produces a notification row — that's the only signal that drives
 * `stateVersion → refreshSessions()` on tabs that aren't actively subscribed
 * to this session's stream.
 *
 *   • `turn_status` — definitive running↔idle flip from `broadcastTurnStatusIfChanged`.
 *   • `ready` — session attached (initial state needs a refresh).
 *   • `error` — session errored, may end. Inactive tabs need to repaint.
 *   • `permission_request` / `ask_user_question` / `plan_approval_request`
 *     — agent is now blocked; getStatus → "running". (These already map to
 *     a kind and would emit via the post-persist path, but firing here too
 *     is harmless — the pendingFlush guard collapses the duplicate.)
 *   • `sdk` `result` — turn finished, `turnInFlight=false`. Mapping to
 *     `session_idle` requires the IDLE_NOTIFY_MIN_MS window AND a recorded
 *     `markUserInput`; both fail in plenty of real scenarios (HMR cleared
 *     the lastUserInputAt map, quick sub-5s turn, a resumed session that
 *     never saw the user-input call). We still need to refresh inactive
 *     tabs in those cases — hence the explicit status-sync emit.
 *
 * Excludes streaming chunks (sdk non-result messages, session_title,
 * mode_changed, model_changed, replay_done): these fire many times per turn
 * and don't change the coarse `getStatus()` answer.
 */
function isStatusSyncRelevant(event: AnyEvent): boolean {
  switch (event.type) {
    case "turn_status":
    case "ready":
    case "error":
    case "permission_request":
    case "ask_user_question":
    case "plan_approval_request":
      return true;
    case "sdk": {
      const m = event.message as { type?: string };
      return m?.type === "result";
    }
    default:
      return false;
  }
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

/**
 * Marker bumped every time the bus's record() / emit logic changes shape.
 * The HMR probe below compares a static value rather than a method name,
 * so we don't have to invent a new no-op method on every behavioural fix.
 * Tied to the suppression rewrite: prior cached instances still DROP
 * background-suppressible rows; the new instance PERSISTS them and only
 * suppresses the per-row notification SSE event.
 */
const BUS_BUILD_TAG = "bus-build:2026-05-13:preserve-lastUserInputAt-across-hmr";

function pickBus(): NotificationBus {
  const cached = globalThis.__claudiusNotificationBus as
    | (NotificationBus & { __buildTag?: string; __subscribers?: Set<Subscriber> })
    | undefined;
  // Probe a build tag rather than a method name. Method-name probes worked
  // when every behaviour change came with a new API, but most fixes are
  // behavioural (record() now persists + state-emits for backgrounded rows
  // instead of dropping them) and don't add a new public method. The tag
  // is the only signal that survives HMR reliably; bump the string above
  // whenever record() / emitState* / scheduleStateEmit logic changes.
  if (cached && cached.__buildTag === BUS_BUILD_TAG) {
    return cached;
  }
  const fresh = new NotificationBus() as NotificationBus & {
    __buildTag: string;
    __subscribers?: Set<Subscriber>;
  };
  fresh.__buildTag = BUS_BUILD_TAG;
  // HMR migration. Three pieces of state cross the rebuild boundary because
  // the client (or in-flight session) has expectations the fresh instance
  // would otherwise violate:
  //
  //   1. Subscribers — SSE connections held by browser tabs subscribed to
  //      the OLD bus instance via `notificationBus.subscribe(fn)`. Their
  //      `controller.enqueue` closure is attached to the OLD subscribers
  //      Set; the fresh instance's Set is empty, so events fired on
  //      `fresh` would reach nobody. Copy them over so existing tabs keep
  //      receiving updates.
  //
  //   2. `perWorkspace` (workspace → { version, ... }) — the client's
  //      version gate (in NotificationsProvider.applyState) drops state
  //      events whose `version` is ≤ the last one it saw. If the bus
  //      rebuilds at the bottom of the stack, every workspace's version
  //      resets to 0 — but the client remembers e.g. version=480 from
  //      before HMR, so every fresh state event arrives "stale" and gets
  //      ignored. The badges then look frozen until a hard reload.
  //      Preserve the prior version map (and bump every entry by 1, so the
  //      very next emit produces a monotonically NEW version) so the gate
  //      keeps working across rebuilds.
  //
  //   3. `lastUserInputAt` — `mapEventToKind` for SDK results returns null
  //      when `last === 0`, treating that as "never saw user input → this
  //      is replay/sync, suppress." After HMR, the fresh instance's map
  //      is empty, so a result arriving for a session whose user input
  //      was recorded against the OLD instance gets suppressed (no
  //      session_idle row, no notification, the user's screenshot bug
  //      returns). Carry the map forward.
  if (cached) {
    const oldSubs = (cached as unknown as { subscribers?: Set<Subscriber> }).subscribers;
    if (oldSubs && oldSubs.size > 0) {
      const newSubs = (fresh as unknown as { subscribers: Set<Subscriber> }).subscribers;
      for (const fn of oldSubs) newSubs.add(fn);
    }
    const oldPerWs = (cached as unknown as { perWorkspace?: Map<string, WorkspaceUnreadState> })
      .perWorkspace;
    if (oldPerWs && oldPerWs.size > 0) {
      const newPerWs = (fresh as unknown as { perWorkspace: Map<string, WorkspaceUnreadState> })
        .perWorkspace;
      for (const [wsId, state] of oldPerWs) {
        // Copy verbatim; the NEXT emitStateSync will bump version by 1.
        newPerWs.set(wsId, state);
      }
    }
    const oldInputAt = (cached as unknown as { lastUserInputAt?: Map<string, number> })
      .lastUserInputAt;
    if (oldInputAt && oldInputAt.size > 0) {
      const newInputAt = (fresh as unknown as { lastUserInputAt: Map<string, number> })
        .lastUserInputAt;
      for (const [sid, at] of oldInputAt) newInputAt.set(sid, at);
    }
  }
  globalThis.__claudiusNotificationBus = fresh;
  return fresh;
}

/**
 * Exported via a Proxy that re-evaluates the singleton on every method
 * lookup. Without this, modules that imported `notificationBus` before an
 * HMR-triggered rebuild keep their original reference and silently call into
 * the dead instance — its `record()` runs the OLD logic, and clients on the
 * new bus's subscriber list never hear the resulting state events. The
 * Proxy keeps the import-time `notificationBus` symbol valid; every actual
 * call goes through `pickBus()` so a build-tag bump migrates callers
 * automatically.
 */
export const notificationBus: NotificationBus = new Proxy({} as NotificationBus, {
  get(_target, prop) {
    const bus = pickBus();
    const value = Reflect.get(bus, prop, bus);
    return typeof value === "function" ? value.bind(bus) : value;
  },
}) as NotificationBus;
export type { NotificationBus };
