"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useNotificationsContext } from "@/components/notifications/NotificationsProvider";
import type { NotificationRow } from "@/lib/shared/notifications";

/**
 * Hook for the Notification Center drawer. The drawer used to be
 * per-workspace (one inbox per active workspace), which created a
 * structural gap: the favicon/title count across all workspaces, so a
 * notification fired in workspace B while the user was in workspace A
 * showed `(1)` in the title but `"You're all caught up"` in the drawer.
 *
 * The cross-workspace mode flips that: the drawer lists EVERY workspace's
 * unread, sorted newest first. The favicon, the drawer header badge, the
 * drawer item count, and (for the user's active workspace) the per-tab
 * badges all derive from the same per-workspace state map, so they agree.
 *
 * The hook still takes `workspaceId` to identify the "current focus"
 * workspace — used by the drawer's `markAllRead` action and to bias the
 * `unread` count returned, but no longer constrains which rows appear.
 */
export function useNotificationCenter(workspaceId: string | null) {
  const {
    recent,
    counts,
    totalUnread,
    stateVersion,
    markRead,
    markAllRead,
    jumpTo,
  } = useNotificationsContext();
  const [items, setItems] = useState<NotificationRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /**
   * Cross-workspace unread fetch. Always pulls `workspace=all` because
   * the drawer is the single global inbox — the favicon's total has to
   * match the visible-rows count or the user sees inexplicable mismatches.
   */
  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/notifications?workspace=all&limit=50&unreadOnly=1`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as { items?: NotificationRow[] };
      setItems(data.items ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  // Refetch on every state-event tick. That's how mark-reads done from
  // other browser tabs (or the OS-toast click path) surface here without
  // a separate subscription. workspaceId no longer triggers a refetch
  // because the list is cross-workspace.
  useEffect(() => {
    void refresh();
  }, [refresh, stateVersion]);

  // Use the server's `unreadOnly=1` fetch as the single source of truth for
  // what shows in the drawer. The prior implementation merged in `recent`
  // (the OS-toast / SSE buffer) to cover the ~100ms gap between a new
  // notification arriving on SSE and the next /api/notifications refetch,
  // but it had a pernicious failure mode: when something marked a row read
  // *outside* the client's own markRead path (e.g. mark-read via direct
  // POST, mark-read from another tab, the server's own markReadByRequestId
  // resolve flow), `recent` still held that row with readAt=null and the
  // merge resurrected it in the drawer. Drawer would say "2 unread" while
  // rendering 3 rows. Refresh-on-stateVersion runs in well under the
  // perceptible-latency threshold, so server-authoritative items alone are
  // good enough. `recent` is still consumed by NotificationsProvider for
  // the OS-toast feed; the drawer just doesn't read from it.
  const merged = useMemo<NotificationRow[]>(() => items, [items]);
  // Silence the unused-but-destructured warning for `recent` — it stays in
  // the context destructure above so removing/restoring it is a one-line
  // change if we ever want to re-add the merge.
  void recent;

  // The drawer's header badge counts EVERY unread, not just the active
  // workspace's. That matches the favicon and the item count below.
  const unread = totalUnread;

  const markRowRead = useCallback(
    async (id: string) => {
      // Each row carries its own workspaceId — find it before delegating.
      const row = merged.find((r) => r.id === id);
      if (!row) return;
      await markRead(id, row.workspaceId);
      setItems((prev) => prev.filter((r) => r.id !== id));
    },
    [merged, markRead],
  );

  /**
   * "Mark all read" used to be scoped to the active workspace. With the
   * drawer cross-workspace, it iterates every workspace that has at
   * least one unread and marks them all read — what the user sees on the
   * screen is what gets cleared.
   */
  const markAll = useCallback(async () => {
    const workspaceIds = Object.keys(counts).filter((id) => (counts[id] ?? 0) > 0);
    await Promise.all(workspaceIds.map((id) => markAllRead(id)));
    setItems([]);
  }, [counts, markAllRead]);

  return {
    items: merged,
    unread,
    loading,
    error,
    refresh,
    markRead: markRowRead,
    markAllRead: markAll,
    jumpTo,
    /** Kept for callers that still want the active-workspace-only count. */
    workspaceUnread: workspaceId ? counts[workspaceId] ?? 0 : 0,
  };
}
