"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useNotifications, type NotifyState } from "@/lib/client/useNotifications";
import { useFaviconBadge } from "@/lib/client/useFaviconBadge";
import { useWorkspaces } from "@/lib/client/useWorkspaces";
import { useActiveSessionId } from "@/lib/client/useActiveSessionId";
import {
  isActionableKind,
  type NotificationRow,
  type NotificationStreamEvent,
  type WorkspaceUnreadState,
} from "@/lib/shared/notifications";

/**
 * App-wide notifications fanout.
 *
 * Mounts at the layout root. Owns the single `EventSource('/api/notifications
 * /stream')` per tab, fans out new rows into:
 *   • a Context that the workspace switcher / drawer consume,
 *   • the OS browser-Notification API (via `useNotifications`),
 *   • the favicon + document.title overlay (via `useFaviconBadge`).
 *
 * Architecture note: the provider keeps ONE canonical state map keyed by
 * workspace id (`byWorkspace`). Every consumer-facing value — workspace
 * tile badge, drawer header, per-tab badges, favicon — is derived from
 * that single map. The map is updated only by server-authored `state`
 * events with a monotonic `version`; any HTTP/SSE response with a
 * `version <= last` is dropped. The four UI surfaces therefore can't
 * drift apart: they read the same number through different selectors.
 *
 * `recent` is a separate concern — it's the OS-toast feed and the
 * append surface for the drawer's live updates. The drawer's authoritative
 * list comes from `/api/notifications?unreadOnly=1`, refetched on each
 * state-event delta (see `useNotificationCenter`).
 */

type ContextValue = {
  /** Per-workspace unread totals; derived from `byWorkspace[id].totalUnread`. */
  counts: Record<string, number>;
  /** Sum across all workspaces. Drives favicon + title. */
  totalUnread: number;
  /**
   * Unread counts for the **active workspace** grouped by `sessionId`. Used by
   * the SessionTabs strip to paint a per-tab badge. Empty when no active
   * workspace.
   */
  unreadBySession: Record<string, number>;
  /** Last ~50 live rows that arrived in this tab, newest first. */
  recent: NotificationRow[];
  /** Bumps whenever any workspace's state changes. Consumers can use this as a refetch trigger. */
  stateVersion: number;
  /** Mark a single notification as read. Workspace defaults to the row's. */
  markRead: (id: string, workspaceId: string) => Promise<void>;
  /** Mark every unread row in a workspace as read. */
  markAllRead: (workspaceId: string) => Promise<void>;
  /**
   * Mark every unread row for a single session as read. Used by the chat
   * page when the user selects a tab — "I'm looking at this session now".
   */
  markSessionRead: (sessionId: string) => Promise<void>;
  /** Refetch authoritative state from the server. */
  refreshCounts: () => Promise<void>;
  /** Navigate to a notification's target session/run. */
  jumpTo: (row: NotificationRow) => Promise<void>;
  /** Browser permission state, useful for inline banners. */
  permissionState: NotifyState;
  /** Request browser-Notification permission. */
  requestPermission: () => Promise<NotificationPermission | "unsupported">;
  /** Whether the active workspace currently has notifications enabled. */
  workspaceEnabled: boolean;
  /** Flip the active workspace's notifications.enabled prefs flag. */
  toggleWorkspaceEnabled: () => Promise<void>;
};

const Ctx = createContext<ContextValue | null>(null);

/** Max in-memory rows. The drawer fetches more from /api/notifications. */
const RECENT_CAP = 50;

export function NotificationsProvider({ children }: { children: React.ReactNode }) {
  const activeSessionId = useActiveSessionId();
  const { items: workspaces, activeId, refresh: refreshWorkspaces } = useWorkspaces();
  const activeWorkspace = useMemo(
    () => workspaces.find((w) => w.id === activeId) ?? null,
    [workspaces, activeId],
  );

  // Single canonical map. Every count consumers see is derived from this.
  // We update it ONLY when an incoming version is strictly greater than the
  // current — drops out-of-order HTTP responses behind fresher SSE events.
  const [byWorkspace, setByWorkspace] = useState<Record<string, WorkspaceUnreadState>>({});
  const [recent, setRecent] = useState<NotificationRow[]>([]);

  /** Replace one workspace's state if and only if the new version is fresher. */
  const applyState = useCallback((s: WorkspaceUnreadState) => {
    setByWorkspace((prev) => {
      const cur = prev[s.workspaceId];
      if (cur && cur.version >= s.version) return prev;
      return { ...prev, [s.workspaceId]: s };
    });
  }, []);

  /** Replace many workspaces' state, each version-gated independently. */
  const applyStates = useCallback((incoming: Record<string, WorkspaceUnreadState>) => {
    setByWorkspace((prev) => {
      let changed = false;
      const next = { ...prev };
      for (const s of Object.values(incoming)) {
        const cur = next[s.workspaceId];
        if (cur && cur.version >= s.version) continue;
        next[s.workspaceId] = s;
        changed = true;
      }
      return changed ? next : prev;
    });
  }, []);

  const markRead = useCallback(
    async (id: string, workspaceId: string) => {
      // Optimistic: flip the row in `recent` so the OS-toast feed (and the
      // drawer's live merge) reflects the read instantly. The workspace
      // total and per-session map update from the server's `state` event
      // — authoritative within the same microtask.
      setRecent((prev) =>
        prev.map((r) => (r.id === id ? { ...r, readAt: r.readAt ?? Date.now() } : r)),
      );
      try {
        await fetch(`/api/notifications/${id}/read`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ workspaceId }),
        });
      } catch {
        // The SSE state event will reconcile on the next server tick.
      }
    },
    [],
  );

  /**
   * Cross-workspace jump → cookie POST + hard reload (need to swap cwd).
   * Same-workspace jump → dispatch a CustomEvent the chat page listens for,
   * which calls `session.switchSession` directly. We deliberately don't use
   * router.push for same-workspace nav because it's a same-pathname soft
   * navigation when only the query changes and Next's `useSearchParams`
   * doesn't always re-render the page-level `?session=` watcher reliably.
   *
   * Clicking a notification (whether via the drawer or the OS toast) implies
   * "I've seen this" — mark the row read here so the OS-click path doesn't
   * bypass the drawer's own markRead call. Idempotent.
   */
  const jumpTo = useCallback(
    async (row: NotificationRow) => {
      if (row.readAt == null) void markRead(row.id, row.workspaceId);
      const targetPath = pickPath(row);
      if (row.workspaceId !== activeId) {
        try {
          await fetch(`/api/workspaces/${row.workspaceId}/select`, { method: "POST" });
        } catch {
          // proceed with reload anyway
        }
        if (typeof window !== "undefined") window.location.assign(targetPath);
        return;
      }
      if (row.kind === "scheduled_run_finished" && row.jobId && row.runId) {
        if (typeof window !== "undefined") window.location.assign(targetPath);
        return;
      }
      if (row.sessionId && typeof window !== "undefined") {
        window.dispatchEvent(
          new CustomEvent<{ sessionId: string }>("claudius:jump-to-session", {
            detail: { sessionId: row.sessionId },
          }),
        );
      }
    },
    [activeId, markRead],
  );

  const notif = useNotifications({
    workspace: activeWorkspace,
    activeSessionId,
    onJump: (row) => {
      void jumpTo(row);
    },
  });

  /**
   * Boot + recovery fetch. Hits `/api/notifications/counts` which returns
   * `{ states: Record<workspaceId, WorkspaceUnreadState> }`. Each entry is
   * version-gated against the current map so a slow response can't overwrite
   * a fresher SSE-delivered state.
   */
  const refreshCounts = useCallback(async () => {
    try {
      const res = await fetch("/api/notifications/counts");
      if (!res.ok) return;
      const data = (await res.json()) as { states?: Record<string, WorkspaceUnreadState> };
      if (data.states) applyStates(data.states);
    } catch {
      // best-effort
    }
  }, [applyStates]);

  useEffect(() => {
    void refreshCounts();
  }, [refreshCounts]);

  // Live stream. Reconnect with backoff on error so a server bounce doesn't
  // leave the badges frozen until reload.
  //
  // Refs let the long-lived EventSource handler read the latest values
  // without re-binding (and re-opening) the SSE connection every time the
  // user clicks a tab. Updates happen in an effect rather than at render
  // time so React's strict-mode passes don't double-write and the
  // `react-hooks/refs` lint rule stays quiet.
  const notifyRef = useRef(notif.notify);
  const activeSessionIdRef = useRef<string | null>(activeSessionId);
  const activeWorkspaceIdRef = useRef<string | null>(activeId);
  useEffect(() => {
    notifyRef.current = notif.notify;
    activeSessionIdRef.current = activeSessionId;
    activeWorkspaceIdRef.current = activeId;
  });

  // Visibility ref feeds the on-arrival auto-read gate. Same predicate the
  // OS-popup path uses: when the user is foregrounded on the session the
  // notification targets, the row is marked read on arrival so the badge
  // doesn't tick. Without this, sessions you sit on accumulate "finished a
  // turn" rows turn after turn.
  const visibleRef = useRef<boolean>(
    typeof document !== "undefined" ? !document.hidden : true,
  );
  useEffect(() => {
    if (typeof document === "undefined") return;
    visibleRef.current = !document.hidden;
    function onVis() {
      visibleRef.current = !document.hidden;
    }
    document.addEventListener("visibilitychange", onVis);
    return () => document.removeEventListener("visibilitychange", onVis);
  }, []);

  useEffect(() => {
    let es: EventSource | null = null;
    let cancelled = false;
    let backoff = 1000;

    const open = () => {
      if (cancelled) return;
      es = new EventSource("/api/notifications/stream");
      es.onmessage = (ev) => {
        try {
          const data = JSON.parse(ev.data) as NotificationStreamEvent;
          if (data.type === "state") {
            // Version-gated apply. The `data` envelope has `type: "state"`
            // plus the WorkspaceUnreadState fields — destructure the type
            // tag off before handing to applyState.
            const { type: _type, ...state } = data;
            void _type;
            applyState(state);
            return;
          }
          if (data.type === "notification") {
            const row = data.notification;
            // Auto-read gate: when the user is foregrounded on the exact
            // session this notification targets, mark it read on arrival
            // so the per-session badge doesn't tick. Same predicate as the
            // OS-popup suppression in `useNotifications.notify`.
            //
            // **Skip actionable kinds.** `permission_request` /
            // `ask_user_question` / `plan_approval_request` rows must
            // survive auto-read even when the user is parked on the
            // session — the agent is blocked on them and the badge is the
            // only cue left if the user minimises the modal. Those rows
            // clear when the request is resolved (`markReadByRequestId`).
            const sameSessionVisible =
              row.readAt == null &&
              row.sessionId != null &&
              row.workspaceId === activeWorkspaceIdRef.current &&
              row.sessionId === activeSessionIdRef.current &&
              visibleRef.current &&
              !isActionableKind(row.kind);
            setRecent((prev) => {
              if (prev.some((r) => r.id === row.id)) return prev;
              const incoming = sameSessionVisible
                ? { ...row, readAt: Date.now() }
                : row;
              const next = [incoming, ...prev];
              return next.length > RECENT_CAP ? next.slice(0, RECENT_CAP) : next;
            });
            if (sameSessionVisible) {
              // Hit the read endpoint directly. The server's microtask-
              // coalesced state emit will reconcile both the workspace
              // total and the per-session map atomically — no transient
              // +1/-1 flicker. Skip the OS notify (same gate suppresses
              // it inside `useNotifications.notify`).
              void fetch(`/api/notifications/${row.id}/read`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ workspaceId: row.workspaceId }),
              }).catch(() => {
                // The next state event reconciles on its own.
              });
              return;
            }
            notifyRef.current(data.notification);
          }
        } catch {
          // ignore malformed payload
        }
      };
      es.onerror = () => {
        es?.close();
        es = null;
        if (cancelled) return;
        // Refetch on every reconnect attempt — if the server bounced we
        // don't want stale badges while we wait for the first live event.
        // The version gate inside `applyStates` makes this safe even if
        // the SSE comes back faster than the HTTP fetch.
        void refreshCounts();
        setTimeout(open, backoff);
        backoff = Math.min(backoff * 2, 15000);
      };
      es.onopen = () => {
        backoff = 1000;
      };
    };

    open();
    return () => {
      cancelled = true;
      es?.close();
    };
  }, [refreshCounts, applyState]);

  // Visibility / online recovery — pull fresh state when the tab becomes
  // visible after a long sleep, in case the SSE silently dropped.
  useEffect(() => {
    function onVis() {
      if (!document.hidden) void refreshCounts();
    }
    function onOnline() {
      void refreshCounts();
    }
    document.addEventListener("visibilitychange", onVis);
    window.addEventListener("online", onOnline);
    return () => {
      document.removeEventListener("visibilitychange", onVis);
      window.removeEventListener("online", onOnline);
    };
  }, [refreshCounts]);

  // Derived selectors. These are pure projections of `byWorkspace` and never
  // diverge from it — that's the whole point of the rewrite.
  const counts = useMemo(() => {
    const out: Record<string, number> = {};
    for (const [id, s] of Object.entries(byWorkspace)) out[id] = s.totalUnread;
    return out;
  }, [byWorkspace]);
  const totalUnread = useMemo(
    () => Object.values(counts).reduce((a, b) => a + b, 0),
    [counts],
  );
  const unreadBySession = useMemo<Record<string, number>>(
    () => (activeId ? byWorkspace[activeId]?.perSession ?? {} : {}),
    [activeId, byWorkspace],
  );
  const stateVersion = useMemo(
    () => Object.values(byWorkspace).reduce((acc, s) => acc + s.version, 0),
    [byWorkspace],
  );
  useFaviconBadge(totalUnread);

  // Refetch workspaces when a new one shows up in the state map — guards
  // against a workspace being created in another tab while this one is open.
  //
  // Loop guard: if the refetched list still doesn't contain the id (notifications
  // outlive their workspace — the SQLite rows aren't cascade-deleted), without
  // this ref the effect would re-fire on every render and fetch in a tight loop.
  const refetchedForStaleRef = useRef<string>("");
  useEffect(() => {
    const ids = new Set(workspaces.map((w) => w.id));
    const stale = Object.keys(byWorkspace)
      .filter((id) => !ids.has(id))
      .sort();
    if (stale.length === 0) return;
    const key = stale.join(",");
    if (refetchedForStaleRef.current === key) return;
    refetchedForStaleRef.current = key;
    void refreshWorkspaces();
  }, [byWorkspace, workspaces, refreshWorkspaces]);

  const markAllRead = useCallback(
    async (workspaceId: string) => {
      // Optimistic recent-buffer flip. The state event reconciles the rest.
      setRecent((prev) =>
        prev.map((r) =>
          r.workspaceId === workspaceId && r.readAt == null
            ? { ...r, readAt: Date.now() }
            : r,
        ),
      );
      try {
        await fetch("/api/notifications/read-all", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ workspaceId }),
        });
      } catch {
        // SSE will reconcile
      }
    },
    [],
  );

  // Refs to the latest byWorkspace / recent so `markSessionRead` can read
  // them without taking them as deps — otherwise the callback identity
  // would churn on every state event and downstream effects (e.g. the
  // chat page's "clear-on-session-change" hook) would re-fire constantly.
  // Updated in an effect so React's strict-mode double-render and the
  // `react-hooks/refs` lint rule are both satisfied.
  const byWorkspaceRef = useRef(byWorkspace);
  const recentRef = useRef(recent);
  useEffect(() => {
    byWorkspaceRef.current = byWorkspace;
    recentRef.current = recent;
  });
  const markSessionRead = useCallback(
    async (sessionId: string) => {
      const workspaceId = activeId;
      if (!sessionId || !workspaceId) return;
      // Cheap exit: state map + recent both agree there's nothing unread
      // that this call would clear. We treat actionable rows as "not
      // clearable here" — they survive the server SQL filter too, so a
      // perSession count made up entirely of actionable rows should be a
      // no-op (skip the optimistic flip AND the fetch).
      const knownUnread =
        byWorkspaceRef.current[workspaceId]?.perSession[sessionId] ?? 0;
      const recentClearableUnread = recentRef.current.some(
        (r) =>
          r.sessionId === sessionId &&
          r.workspaceId === workspaceId &&
          r.readAt == null &&
          !isActionableKind(r.kind),
      );
      if (knownUnread === 0 && !recentClearableUnread) return;

      // Optimistic recent flip; server's state event corrects byWorkspace.
      // Skip actionable rows so the drawer doesn't briefly show a still-
      // pending request as read while the SQL is in flight.
      setRecent((prev) =>
        prev.map((r) =>
          r.sessionId === sessionId &&
          r.workspaceId === workspaceId &&
          r.readAt == null &&
          !isActionableKind(r.kind)
            ? { ...r, readAt: Date.now() }
            : r,
        ),
      );
      try {
        await fetch("/api/notifications/read-by-session", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ workspaceId, sessionId }),
        });
      } catch {
        // SSE will reconcile on the next state event.
      }
    },
    [activeId],
  );

  // Visibility-regain → mark the active session read. Symmetric pair to the
  // SSE-handler auto-read path: the SSE gate requires `visibleRef.current ===
  // true` so a notification arriving while the browser tab is backgrounded
  // (Cmd-Tab away, focus on another tab, DevTools panel docked off-screen)
  // can't auto-clear. Without this handler, the badge would stay stuck on the
  // tab the user is already sitting on — they'd see "1" on the in-app tab
  // that's currently rendered, which reads as a bug. When the document
  // becomes visible again AND we have an active session bound, treat it the
  // same as a tab click: "I'm looking at this session now → clear it."
  //
  // markSessionRead has its own cheap-exit (knownUnread === 0 && !recentUnread)
  // so firing on every visibility regain is harmless when there's nothing to
  // clear. We intentionally DO NOT do the same on `online` reconnect — the
  // user may have been offline and we want them to see what landed in the
  // meantime, not silently clear it.
  useEffect(() => {
    function onVis() {
      if (document.hidden) return;
      const sid = activeSessionIdRef.current;
      if (!sid) return;
      void markSessionRead(sid);
    }
    document.addEventListener("visibilitychange", onVis);
    return () => document.removeEventListener("visibilitychange", onVis);
  }, [markSessionRead]);

  const toggleWorkspaceEnabled = useCallback(async () => {
    await notif.setEnabled(!notif.enabled);
    await refreshWorkspaces();
  }, [notif, refreshWorkspaces]);

  const value: ContextValue = useMemo(
    () => ({
      counts,
      totalUnread,
      unreadBySession,
      recent,
      stateVersion,
      markRead,
      markAllRead,
      markSessionRead,
      refreshCounts,
      jumpTo,
      permissionState: notif.state,
      requestPermission: notif.requestPermission,
      workspaceEnabled: notif.enabled,
      toggleWorkspaceEnabled,
    }),
    [
      counts,
      totalUnread,
      unreadBySession,
      recent,
      stateVersion,
      markRead,
      markAllRead,
      markSessionRead,
      refreshCounts,
      jumpTo,
      notif.state,
      notif.requestPermission,
      notif.enabled,
      toggleWorkspaceEnabled,
    ],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useNotificationsContext(): ContextValue {
  const ctx = useContext(Ctx);
  if (!ctx) {
    // Allow components mounted outside the provider to no-op cleanly — the
    // workspace switcher renders before hydration completes in some edge
    // cases. Returning a frozen empty object means badges just show 0.
    return EMPTY;
  }
  return ctx;
}

const EMPTY: ContextValue = {
  counts: {},
  totalUnread: 0,
  unreadBySession: {},
  recent: [],
  stateVersion: 0,
  markRead: async () => {},
  markAllRead: async () => {},
  markSessionRead: async () => {},
  refreshCounts: async () => {},
  jumpTo: async () => {},
  permissionState: "unsupported",
  requestPermission: async () => "unsupported" as const,
  workspaceEnabled: false,
  toggleWorkspaceEnabled: async () => {},
};

function pickPath(row: NotificationRow): string {
  if (row.kind === "scheduled_run_finished" && row.jobId && row.runId) {
    return `/schedule/${row.jobId}/runs/${row.runId}`;
  }
  if (row.sessionId) return `/?session=${row.sessionId}`;
  return "/";
}
