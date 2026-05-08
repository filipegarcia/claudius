"use client";

import { useCallback, useEffect, useState } from "react";
import type { AssetRow, Scope, TypeFilter } from "@/lib/server/asset-list";

export type UseRow = {
  sessionId: string;
  messageUuid: string;
  ordinal: number;
  occurredMs: number;
};

export function useAssets(opts: { cwd: string | null; scope: Scope; type: TypeFilter; q: string }) {
  const [items, setItems] = useState<AssetRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [nextCursor, setNextCursor] = useState<number | undefined>(undefined);

  const refresh = useCallback(
    async (backfill = false) => {
      if (opts.cwd == null) return;
      setLoading(true);
      setError(null);
      try {
        const params = new URLSearchParams({
          scope: opts.scope,
          type: opts.type,
          q: opts.q,
          limit: "60",
        });
        if (opts.cwd) params.set("cwd", opts.cwd);
        if (backfill) params.set("backfill", "1");
        const res = await fetch(`/api/assets?${params}`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const d = (await res.json()) as { items: AssetRow[]; nextCursor?: number };
        setItems(d.items);
        setNextCursor(d.nextCursor);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setLoading(false);
      }
    },
    [opts.cwd, opts.scope, opts.type, opts.q],
  );

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const loadMore = useCallback(async () => {
    if (nextCursor == null || opts.cwd == null) return;
    const params = new URLSearchParams({
      scope: opts.scope,
      type: opts.type,
      q: opts.q,
      limit: "60",
      cursor: String(nextCursor),
    });
    if (opts.cwd) params.set("cwd", opts.cwd);
    const res = await fetch(`/api/assets?${params}`);
    if (!res.ok) return;
    const d = (await res.json()) as { items: AssetRow[]; nextCursor?: number };
    setItems((prev) => [...prev, ...d.items]);
    setNextCursor(d.nextCursor);
  }, [nextCursor, opts.cwd, opts.scope, opts.type, opts.q]);

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
