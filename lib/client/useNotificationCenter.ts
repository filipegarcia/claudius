"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useNotificationsContext } from "@/components/notifications/NotificationsProvider";
import type { NotificationRow } from "@/lib/shared/notifications";

/**
 * Hook for the Notification Center drawer. Loads the persisted list for a
 * workspace and merges in live rows from the provider's SSE stream so the
 * drawer stays current without polling.
 *
 * The drawer renders a single workspace's inbox (the active one by default).
 * Cross-workspace counts already live in the workspace switcher; this hook
 * is the detail view.
 */
export function useNotificationCenter(workspaceId: string | null) {
  const { recent, counts, markRead, markAllRead, jumpTo } = useNotificationsContext();
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
      const url = `/api/notifications?workspace=${encodeURIComponent(workspaceId)}&limit=50`;
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

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Merge live additions for this workspace. We rely on the provider's
  // `recent` buffer (newest first) and splice in anything that isn't
  // already in our local list. Dedup by id.
  const merged = useMemo(() => {
    if (!workspaceId) return [] as NotificationRow[];
    const seen = new Set(items.map((r) => r.id));
    const live = recent.filter((r) => r.workspaceId === workspaceId && !seen.has(r.id));
    if (live.length === 0) return items;
    return [...live, ...items];
  }, [workspaceId, items, recent]);

  const unread = workspaceId ? (counts[workspaceId] ?? 0) : 0;

  const markRowRead = useCallback(
    async (id: string) => {
      if (!workspaceId) return;
      await markRead(id, workspaceId);
      setItems((prev) =>
        prev.map((r) => (r.id === id ? { ...r, readAt: r.readAt ?? Date.now() } : r)),
      );
    },
    [workspaceId, markRead],
  );

  const markAll = useCallback(async () => {
    if (!workspaceId) return;
    await markAllRead(workspaceId);
    setItems((prev) =>
      prev.map((r) => (r.readAt == null ? { ...r, readAt: Date.now() } : r)),
    );
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
