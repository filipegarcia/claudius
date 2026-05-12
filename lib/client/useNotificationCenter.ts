"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useNotificationsContext } from "@/components/notifications/NotificationsProvider";
import type { NotificationRow } from "@/lib/shared/notifications";

/**
 * Hook for the Notification Center drawer. The drawer shows the unread
 * inbox for the active workspace — read rows are hidden by construction
 * (the API filters with `unreadOnly=1`).
 *
 * The list refetches whenever the provider's `stateVersion` ticks — that's
 * the server-emitted monotonic counter on every state change, so a single
 * dependency catches inserts, mark-reads, and mark-all-reads without any
 * separate notification subscription.
 */
export function useNotificationCenter(workspaceId: string | null) {
  const {
    recent,
    counts,
    stateVersion,
    markRead,
    markAllRead,
    jumpTo,
  } = useNotificationsContext();
  const [items, setItems] = useState<NotificationRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!workspaceId) {
      setItems([]);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const url = `/api/notifications?workspace=${encodeURIComponent(workspaceId)}&limit=50&unreadOnly=1`;
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as { items?: NotificationRow[] };
      setItems(data.items ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [workspaceId]);

  // Refetch on workspace switch AND on every state-event tick — that's how
  // mark-reads done from other browser tabs (or the OS-toast click path)
  // surface here without a separate subscription. The refetch IS the
  // external-system sync (HTTP GET against /api/notifications); the lint
  // rule's "no setState in effects" warning applies to derived state, not
  // to a fetch-then-store pattern like this one.
  useEffect(() => {
    void refresh();
  }, [refresh, stateVersion]);

  // Merge live additions for this workspace from the provider's `recent`
  // buffer. The server-side list is the authoritative paginated view; the
  // recent buffer covers the gap between an insert landing on the SSE
  // stream and the next `refresh()` completing. Filter unread-only on the
  // recent rows too — a row we already marked read shouldn't reappear.
  const merged = useMemo<NotificationRow[]>(() => {
    if (!workspaceId) return [];
    const seen = new Set(items.map((r) => r.id));
    const live = recent.filter(
      (r) => r.workspaceId === workspaceId && r.readAt == null && !seen.has(r.id),
    );
    if (live.length === 0) return items;
    return [...live, ...items];
  }, [workspaceId, items, recent]);

  const unread = workspaceId ? counts[workspaceId] ?? 0 : 0;

  const markRowRead = useCallback(
    async (id: string) => {
      if (!workspaceId) return;
      await markRead(id, workspaceId);
      setItems((prev) => prev.filter((r) => r.id !== id));
    },
    [workspaceId, markRead],
  );

  const markAll = useCallback(async () => {
    if (!workspaceId) return;
    await markAllRead(workspaceId);
    setItems([]);
  }, [workspaceId, markAllRead]);

  return {
    items: merged,
    unread,
    loading,
    error,
    refresh,
    markRead: markRowRead,
    markAllRead: markAll,
    jumpTo,
  };
}
