"use client";

import { useCallback, useEffect, useState } from "react";
import type { AssetRow, Scope, TypeFilter } from "@/lib/server/asset-list";

export type UseRow = {
  sessionId: string;
  messageUuid: string;
  ordinal: number;
  occurredMs: number;
};

/**
 * Paginated asset list for a workspace + filter set. Pattern matches
 * `useCost` (refetchTrigger + AbortController + setState-in-callback),
 * with two extras: a `refresh(backfill = true)` mode that asks the server
 * to re-derive missing rows, and a `loadMore()` that appends the next
 * page to the existing list (no trigger bump; just a one-shot fetch
 * outside the main effect).
 */
export function useAssets(opts: { cwd: string | null; scope: Scope; type: TypeFilter; q: string }) {
  const { cwd, scope, type, q } = opts;
  const [items, setItems] = useState<AssetRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [nextCursor, setNextCursor] = useState<number | undefined>(undefined);
  // Encodes both "user clicked Refresh" (counter ticks) and "should the
  // next pull pass `backfill=1`". Stored as an object so a click on
  // "Refresh + backfill" doesn't collapse with a follow-up plain refresh.
  const [refetchTrigger, setRefetchTrigger] = useState<{ n: number; backfill: boolean }>({
    n: 0,
    backfill: false,
  });

  useEffect(() => {
    if (cwd == null) return;
    const controller = new AbortController();

    const params = new URLSearchParams({ scope, type, q, limit: "60" });
    if (cwd) params.set("cwd", cwd);
    if (refetchTrigger.backfill) params.set("backfill", "1");

    fetch(`/api/assets?${params}`, { signal: controller.signal })
      .then(async (res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return (await res.json()) as { items: AssetRow[]; nextCursor?: number };
      })
      .then((d) => {
        setItems(d.items);
        setNextCursor(d.nextCursor);
        setError(null);
      })
      .catch((err: unknown) => {
        if (err instanceof DOMException && err.name === "AbortError") return;
        setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });

    return () => controller.abort();
  }, [cwd, scope, type, q, refetchTrigger]);

  const refresh = useCallback((backfill = false) => {
    setLoading(true);
    setRefetchTrigger((prev) => ({ n: prev.n + 1, backfill }));
  }, []);

  const loadMore = useCallback(async () => {
    if (nextCursor == null || cwd == null) return;
    const params = new URLSearchParams({
      scope,
      type,
      q,
      limit: "60",
      cursor: String(nextCursor),
    });
    if (cwd) params.set("cwd", cwd);
    const res = await fetch(`/api/assets?${params}`);
    if (!res.ok) return;
    const d = (await res.json()) as { items: AssetRow[]; nextCursor?: number };
    setItems((prev) => [...prev, ...d.items]);
    setNextCursor(d.nextCursor);
  }, [nextCursor, cwd, scope, type, q]);

  return { items, loading, error, refresh, loadMore, hasMore: nextCursor != null };
}

export async function fetchUses(cwd: string, hash: string): Promise<UseRow[]> {
  const res = await fetch(`/api/assets/${encodeURIComponent(hash)}/uses?cwd=${encodeURIComponent(cwd)}`);
  if (!res.ok) return [];
  const d = (await res.json()) as { uses: UseRow[] };
  return d.uses;
}

export async function deleteAssetClient(cwd: string, hash: string): Promise<boolean> {
  const res = await fetch(`/api/assets/${encodeURIComponent(hash)}?cwd=${encodeURIComponent(cwd)}`, {
    method: "DELETE",
  });
  return res.ok;
}
