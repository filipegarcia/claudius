"use client";

import { useCallback, useEffect, useState } from "react";
import type { Icon, Workspace } from "@/lib/server/workspaces-store";

const COOKIE = "claudius.workspace";

function readCookie(): string | null {
  if (typeof document === "undefined") return null;
  const m = document.cookie.match(new RegExp("(?:^|; )" + COOKIE + "=([^;]+)"));
  return m ? decodeURIComponent(m[1]) : null;
}

export function useWorkspaces() {
  const [items, setItems] = useState<Workspace[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/workspaces");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const d = (await res.json()) as { workspaces: Workspace[] };
      setItems(d.workspaces);
      const cookie = readCookie();
      const fallback = d.workspaces[0]?.id ?? null;
      const active = cookie && d.workspaces.some((w) => w.id === cookie) ? cookie : fallback;
      setActiveId(active);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const select = useCallback(
    async (id: string) => {
      const res = await fetch(`/api/workspaces/${id}/select`, { method: "POST" });
      if (res.ok) {
        setActiveId(id);
        // Reload to pick up new default cwd everywhere on the page.
        if (typeof window !== "undefined") window.location.reload();
      }
    },
    [],
  );

  const create = useCallback(
    async (input: { name: string; rootPath: string; icon?: Icon; defaults?: import("@/lib/server/workspaces-store").WorkspaceDefaults }) => {
      const res = await fetch("/api/workspaces", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
      });
      if (!res.ok) {
        const err = (await res.json().catch(() => ({}))) as { error?: string };
        return { ok: false as const, error: err.error ?? `HTTP ${res.status}` };
      }
      const ws = (await res.json()) as Workspace;
      await refresh();
      // Auto-select the new workspace.
      await fetch(`/api/workspaces/${ws.id}/select`, { method: "POST" });
      setActiveId(ws.id);
      return { ok: true as const, workspace: ws };
    },
    [refresh],
  );

  const update = useCallback(
    async (id: string, patch: Partial<Workspace>) => {
      const res = await fetch(`/api/workspaces/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      });
      if (res.ok) await refresh();
      return res.ok;
    },
    [refresh],
  );

  const remove = useCallback(
    async (id: string) => {
      const res = await fetch(`/api/workspaces/${id}`, { method: "DELETE" });
      if (res.ok) await refresh();
      return res.ok;
    },
    [refresh],
  );

  /**
   * Optimistically reorder + persist. The local list updates immediately; on
   * server failure we re-pull canonical state.
   */
  const reorder = useCallback(
    async (ids: string[]) => {
      setItems((prev) => {
        const byId = new Map(prev.map((w) => [w.id, w]));
        return ids.map((id) => byId.get(id)!).filter(Boolean);
      });
      const res = await fetch("/api/workspaces/reorder", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ids }),
      });
      if (!res.ok) await refresh();
      return res.ok;
    },
    [refresh],
  );

  const uploadIcon = useCallback(
    async (id: string, file: File): Promise<boolean> => {
      const reader = new FileReader();
      const dataUrl = await new Promise<string>((resolve, reject) => {
        reader.onload = () => resolve(String(reader.result ?? ""));
        reader.onerror = () => reject(reader.error);
        reader.readAsDataURL(file);
      });
      const m = /^data:[^;]+;base64,(.+)$/.exec(dataUrl);
      if (!m) return false;
      const res = await fetch(`/api/workspaces/${id}/icon`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ data: m[1] }),
      });
      if (res.ok) {
        const ext = ((await res.json().catch(() => ({}))) as { ext?: string }).ext ?? "png";
        await update(id, { icon: { kind: "image", ext } });
      }
      return res.ok;
    },
    [update],
  );

  return { items, activeId, loading, error, refresh, select, create, update, remove, reorder, uploadIcon };
}
