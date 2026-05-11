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
import { useRouter, useSearchParams } from "next/navigation";
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
  /** Last ~50 live rows that arrived in this tab, newest first. */
  recent: NotificationRow[];
  /** Mark a single notification as read. Workspace defaults to the row's. */
  markRead: (id: string, workspaceId: string) => Promise<void>;
  /** Mark every unread row in a workspace as read. */
  markAllRead: (workspaceId: string) => Promise<void>;
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
  const router = useRouter();
  const searchParams = useSearchParams();
  const activeSessionId = searchParams?.get("session") ?? null;
  const { items: workspaces, activeId, refresh: refreshWorkspaces } = useWorkspaces();
  const activeWorkspace = useMemo(
    () => workspaces.find((w) => w.id === activeId) ?? null,
    [workspaces, activeId],
  );

  const [counts, setCounts] = useState<Record<string, number>>({});
  const [recent, setRecent] = useState<NotificationRow[]>([]);

  const markRead = useCallback(
    async (id: string, workspaceId: string) => {
      // Optimistic — drop from `recent` and decrement the count immediately.
      setRecent((prev) =>
        prev.map((r) =>
          r.id === id ? { ...r, readAt: r.readAt ?? Date.now() } : r,
        ),
      );
      setCounts((prev) => {
        const cur = prev[workspaceId] ?? 0;
        if (cur === 0) return prev;
        return { ...prev, [workspaceId]: cur - 1 };
      });
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

  // Cross-workspace jump. Same workspace → in-app router push; different
  // workspace → cookie POST + hard reload (mirrors useWorkspaces.select).
  //
  // Clicking a notification (whether via the drawer or the OS toast that
  // useNotifications wires up) implies "I've seen this" — mark the row
  // read here so the OS-click path doesn't bypass the drawer's own
  // markRead call. Idempotent: a row that's already read just no-ops.
  const jumpTo = useCallback(
    async (row: NotificationRow) => {
      if (row.readAt == null) {
        void markRead(row.id, row.workspaceId);
      }
      const targetPath = pickPath(row);
      if (row.workspaceId === activeId) {
        router.push(targetPath);
      } else {
        try {
          await fetch(`/api/workspaces/${row.workspaceId}/select`, { method: "POST" });
        } catch {
          // proceed with reload anyway — worst case the user lands on the
          // wrong workspace and the cookie write retries
        }
        if (typeof window !== "undefined") window.location.href = targetPath;
      }
    },
    [router, activeId, markRead],
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
            return;
          }
          if (data.type === "notification") {
            setRecent((prev) => {
              if (prev.some((r) => r.id === data.notification.id)) return prev;
              const next = [data.notification, ...prev];
              return next.length > RECENT_CAP ? next.slice(0, RECENT_CAP) : next;
            });
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
        // first live event.
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
  }, [refreshCounts]);

  // Visibility / online recovery — pull fresh counts when the tab becomes
  // visible after a long sleep, in case the SSE silently dropped.
  useEffect(() => {
    function onVis() {
      if (!document.hidden) void refreshCounts();
    }
    document.addEventListener("visibilitychange", onVis);
    window.addEventListener("online", refreshCounts);
    return () => {
      document.removeEventListener("visibilitychange", onVis);
      window.removeEventListener("online", refreshCounts);
    };
  }, [refreshCounts]);

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

  const markAllRead = useCallback(async (workspaceId: string) => {
    setRecent((prev) =>
      prev.map((r) =>
        r.workspaceId === workspaceId && r.readAt == null
          ? { ...r, readAt: Date.now() }
          : r,
      ),
    );
    setCounts((prev) => ({ ...prev, [workspaceId]: 0 }));
    try {
      await fetch("/api/notifications/read-all", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ workspaceId }),
      });
    } catch {
      // SSE will reconcile
    }
  }, []);

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
      recent,
      markRead,
      markAllRead,
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
      recent,
      markRead,
      markAllRead,
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
  recent: [],
  markRead: async () => {},
  markAllRead: async () => {},
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
