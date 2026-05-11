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
import { useSearchParams } from "next/navigation";
import { useNotifications, type NotifyState } from "@/lib/client/useNotifications";
import { useFaviconBadge } from "@/lib/client/useFaviconBadge";
import { useWorkspaces } from "@/lib/client/useWorkspaces";
import type {
  NotificationRow,
  NotificationStreamEvent,
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
 * Reconnects on EventSource error after a small backoff and refetches the
 * `/counts` endpoint so badges self-heal on transient drops.
 */

type ContextValue = {
  /** Per-workspace unread counts; missing entries mean zero. */
  counts: Record<string, number>;
  /** Sum across all workspaces. Drives favicon + title. */
  totalUnread: number;
  /**
   * Unread counts for the **active workspace** grouped by `sessionId`. Used by
   * the SessionTabs strip to paint a per-tab badge. Missing entries mean zero;
   * the object is empty when there is no active workspace.
   */
  unreadBySession: Record<string, number>;
  /** Last ~50 live rows that arrived in this tab, newest first. */
  recent: NotificationRow[];
  /** Mark a single notification as read. Workspace defaults to the row's. */
  markRead: (id: string, workspaceId: string) => Promise<void>;
  /** Mark every unread row in a workspace as read. */
  markAllRead: (workspaceId: string) => Promise<void>;
  /**
   * Mark every unread row for a single session as read. Used by the chat
   * page when the user selects a tab — "I'm looking at this session now".
   * Scoped to the provider's active workspace (the only one the tab strip
   * can show), so callers don't pass a workspaceId.
   */
  markSessionRead: (sessionId: string) => Promise<void>;
  /** Refetch counts from the server. */
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
  const searchParams = useSearchParams();
  const activeSessionId = searchParams?.get("session") ?? null;
  const { items: workspaces, activeId, refresh: refreshWorkspaces } = useWorkspaces();
  const activeWorkspace = useMemo(
    () => workspaces.find((w) => w.id === activeId) ?? null,
    [workspaces, activeId],
  );

  const [counts, setCounts] = useState<Record<string, number>>({});
  const [unreadBySession, setUnreadBySession] = useState<Record<string, number>>({});
  const [recent, setRecent] = useState<NotificationRow[]>([]);

  // Reconcile `unreadBySession` from the server. The optimistic decrements
  // below cover the happy path, but server-side bus filtering or out-of-band
  // mark-read writes can drift the in-memory map — so we re-pull on every
  // workspace-level `count` event and on visibility recovery.
  const refreshUnreadBySession = useCallback(async () => {
    if (!activeId) {
      setUnreadBySession((prev) => (Object.keys(prev).length === 0 ? prev : {}));
      return;
    }
    try {
      const res = await fetch(
        `/api/notifications/counts-by-session?workspace=${encodeURIComponent(activeId)}`,
      );
      if (!res.ok) return;
      const data = (await res.json()) as { counts?: Record<string, number> };
      setUnreadBySession(data.counts ?? {});
    } catch {
      // best-effort
    }
  }, [activeId]);

  const markRead = useCallback(
    async (id: string, workspaceId: string) => {
      // Optimistic — drop from `recent` and decrement the counts immediately.
      // The next SSE `count` event reconciles the workspace total, and
      // `refreshUnreadBySession` reconciles the per-tab badges.
      let optimisticSessionId: string | null = null;
      setRecent((prev) =>
        prev.map((r) => {
          if (r.id !== id) return r;
          if (r.readAt == null) optimisticSessionId = r.sessionId;
          return { ...r, readAt: r.readAt ?? Date.now() };
        }),
      );
      setCounts((prev) => {
        const cur = prev[workspaceId] ?? 0;
        if (cur === 0) return prev;
        return { ...prev, [workspaceId]: cur - 1 };
      });
      if (optimisticSessionId) {
        setUnreadBySession((prev) => {
          const sid = optimisticSessionId as string;
          const cur = prev[sid] ?? 0;
          if (cur <= 1) {
            if (cur === 0) return prev;
            const { [sid]: _drop, ...rest } = prev;
            void _drop; // satisfy no-unused-vars on the destructured key
            return rest;
          }
          return { ...prev, [sid]: cur - 1 };
        });
      }
      try {
        await fetch(`/api/notifications/${id}/read`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ workspaceId }),
        });
      } catch {
        // The SSE `count` event will reconcile on the next server tick.
      }
    },
    [],
  );

  // Cross-workspace jump → cookie POST + hard reload (need to swap cwd).
  // Same-workspace jump → dispatch a CustomEvent the chat page listens
  // for, which calls `session.switchSession` directly. We deliberately
  // do NOT use Next.js's `router.push` for same-workspace nav because
  // it's a same-pathname soft navigation when only the query changes
  // and `useSearchParams` was not reliably re-rendering the page-level
  // `?session=` watcher — the URL bar showed the new id, the session
  // never switched. The event path bypasses that entirely.
  //
  // Clicking a notification (whether via the drawer or the OS toast
  // that useNotifications wires up) implies "I've seen this" — mark
  // the row read here so the OS-click path doesn't bypass the drawer's
  // own markRead call. Idempotent: a row that's already read just no-ops.
  const jumpTo = useCallback(
    async (row: NotificationRow) => {
      if (row.readAt == null) {
        void markRead(row.id, row.workspaceId);
      }
      const targetPath = pickPath(row);
      if (row.workspaceId !== activeId) {
        try {
          await fetch(`/api/workspaces/${row.workspaceId}/select`, { method: "POST" });
        } catch {
          // proceed with reload anyway — worst case the user lands on the
          // wrong workspace and the cookie write retries
        }
        if (typeof window !== "undefined") window.location.assign(targetPath);
        return;
      }
      // Scheduler runs live on their own page — no in-app switch handler.
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

  // Boot: fetch initial counts. The SSE stream also emits seed counts on
  // connect, but the HTTP fetch races ahead and avoids a brief "everything
  // is zero" flash if the stream connects slowly.
  const refreshCounts = useCallback(async () => {
    try {
      const res = await fetch("/api/notifications/counts");
      if (!res.ok) return;
      const data = (await res.json()) as { counts?: Record<string, number> };
      if (data.counts) setCounts(data.counts);
    } catch {
      // best-effort
    }
  }, []);

  useEffect(() => {
    void refreshCounts();
  }, [refreshCounts]);

  // Seed per-session counts on mount AND on every active-workspace switch.
  // refreshUnreadBySession itself depends on `activeId`, so re-running this
  // effect when the workspace changes pulls a fresh map for the new DB.
  useEffect(() => {
    void refreshUnreadBySession();
  }, [refreshUnreadBySession]);

  // Live stream. Reconnect with backoff on error so a server bounce doesn't
  // leave the badges frozen until reload.
  const notifyRef = useRef(notif.notify);
  notifyRef.current = notif.notify;
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
          if (data.type === "count") {
            setCounts((prev) => ({ ...prev, [data.workspaceId]: data.unread }));
            // Workspace-level deltas don't tell us *which* session lost a
            // count, so re-pull the per-session map. Cheap (single indexed
            // GROUP BY) and only fires for the active workspace.
            if (data.workspaceId === activeId) void refreshUnreadBySession();
            return;
          }
          if (data.type === "notification") {
            setRecent((prev) => {
              if (prev.some((r) => r.id === data.notification.id)) return prev;
              const next = [data.notification, ...prev];
              return next.length > RECENT_CAP ? next.slice(0, RECENT_CAP) : next;
            });
            // Optimistic per-session bump so the tab badge ticks up the
            // instant a notification arrives, before the count event lands.
            const row = data.notification;
            if (
              row.readAt == null &&
              row.sessionId &&
              row.workspaceId === activeId
            ) {
              setUnreadBySession((prev) => ({
                ...prev,
                [row.sessionId as string]: (prev[row.sessionId as string] ?? 0) + 1,
              }));
            }
            // Fire OS notification — visibility gate lives inside useNotifications.
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
        // Refetch authoritative counts on every reconnect attempt — if the
        // server bounced we don't want stale badges while we wait for the
        // first live event. Per-session map gets the same treatment so the
        // tab badges don't drift after a transient drop.
        void refreshCounts();
        void refreshUnreadBySession();
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
  }, [refreshCounts, refreshUnreadBySession, activeId]);

  // Visibility / online recovery — pull fresh counts when the tab becomes
  // visible after a long sleep, in case the SSE silently dropped.
  useEffect(() => {
    function onVis() {
      if (!document.hidden) {
        void refreshCounts();
        void refreshUnreadBySession();
      }
    }
    function onOnline() {
      void refreshCounts();
      void refreshUnreadBySession();
    }
    document.addEventListener("visibilitychange", onVis);
    window.addEventListener("online", onOnline);
    return () => {
      document.removeEventListener("visibilitychange", onVis);
      window.removeEventListener("online", onOnline);
    };
  }, [refreshCounts, refreshUnreadBySession]);

  const totalUnread = useMemo(
    () => Object.values(counts).reduce((a, b) => a + b, 0),
    [counts],
  );
  useFaviconBadge(totalUnread);

  // Refetch workspaces when a new one shows up in the counts map — guards
  // against a workspace being created in another tab while this one is open.
  useEffect(() => {
    const ids = new Set(workspaces.map((w) => w.id));
    for (const id of Object.keys(counts)) {
      if (!ids.has(id)) {
        void refreshWorkspaces();
        return;
      }
    }
  }, [counts, workspaces, refreshWorkspaces]);

  const markAllRead = useCallback(
    async (workspaceId: string) => {
      setRecent((prev) =>
        prev.map((r) =>
          r.workspaceId === workspaceId && r.readAt == null
            ? { ...r, readAt: Date.now() }
            : r,
        ),
      );
      setCounts((prev) => ({ ...prev, [workspaceId]: 0 }));
      // The per-session map is scoped to the active workspace — only zero
      // it when the caller is targeting that one. Otherwise leave the map
      // alone (a different workspace's counts aren't in there to begin with).
      if (workspaceId === activeId) {
        setUnreadBySession((prev) => (Object.keys(prev).length === 0 ? prev : {}));
      }
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
    [activeId],
  );

  // Refs so `markSessionRead` can read the latest `unreadBySession` /
  // `recent` without listing them as deps — otherwise the callback's
  // identity would churn on every notification/count tick and any
  // consumer effect keyed on it (e.g. the chat page's "auto-clear on
  // session change") would re-fire constantly, wiping fresh badges.
  const unreadBySessionRef = useRef(unreadBySession);
  unreadBySessionRef.current = unreadBySession;
  const recentRef = useRef(recent);
  recentRef.current = recent;
  const markSessionRead = useCallback(
    async (sessionId: string) => {
      const workspaceId = activeId;
      if (!sessionId || !workspaceId) return;
      // Cheap exit: if the per-session map and `recent` both agree there's
      // nothing unread for this session, skip the round-trip.
      const knownUnread = unreadBySessionRef.current[sessionId] ?? 0;
      const recentUnread = recentRef.current.some(
        (r) =>
          r.sessionId === sessionId &&
          r.workspaceId === workspaceId &&
          r.readAt == null,
      );
      if (knownUnread === 0 && !recentUnread) return;

      // Optimistic: flip every matching `recent` row, drop the per-session
      // entry, decrement the workspace total by however many we just flipped.
      let flippedCount = 0;
      setRecent((prev) =>
        prev.map((r) => {
          if (
            r.sessionId === sessionId &&
            r.workspaceId === workspaceId &&
            r.readAt == null
          ) {
            flippedCount += 1;
            return { ...r, readAt: Date.now() };
          }
          return r;
        }),
      );
      // The authoritative count comes from `unreadBySession[sessionId]`
      // (server-reconciled). Prefer that over `flippedCount` so we don't
      // under-decrement when the row hasn't landed in `recent` yet.
      const decrementBy = Math.max(flippedCount, knownUnread);
      if (decrementBy > 0) {
        setCounts((prev) => {
          const cur = prev[workspaceId] ?? 0;
          if (cur === 0) return prev;
          return { ...prev, [workspaceId]: Math.max(0, cur - decrementBy) };
        });
      }
      setUnreadBySession((prev) => {
        if (!(sessionId in prev)) return prev;
        const { [sessionId]: _drop, ...rest } = prev;
        void _drop;
        return rest;
      });
      try {
        await fetch("/api/notifications/read-by-session", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ workspaceId, sessionId }),
        });
      } catch {
        // SSE will reconcile on the next count event.
      }
    },
    [activeId],
  );

  const toggleWorkspaceEnabled = useCallback(async () => {
    await notif.setEnabled(!notif.enabled);
    // useWorkspaces.refresh fires inside the hook after PATCH succeeds via
    // the legacy migration path, but the toggle path doesn't — pull a
    // fresh list so the workspace-page Save dirty-check (and any future
    // consumer keyed on workspace.defaults.notifications.enabled) sees
    // the new value immediately.
    await refreshWorkspaces();
  }, [notif, refreshWorkspaces]);

  const value: ContextValue = useMemo(
    () => ({
      counts,
      totalUnread,
      unreadBySession,
      recent,
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
