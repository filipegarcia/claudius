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
      const d = (await res.json()) as { workspaces: Workspace[]; activeId?: string | null };
      // Keep the existing array reference when the payload is byte-identical.
      // Without this guard every poll/refetch returns a brand-new array, which
      // re-fires effects in any consumer that has `workspaces` in its deps —
      // notably NotificationsProvider's "stale id in counts → refresh" effect,
      // which would then refetch in a tight loop (refresh → new ref → effect
      // re-runs → refresh → …). With ~10 workspaces JSON.stringify is
      // microseconds; on a slow client it's still cheaper than the fetch we'd
      // otherwise trigger again.
      setItems((prev) =>
        JSON.stringify(prev) === JSON.stringify(d.workspaces) ? prev : d.workspaces,
      );
      // Resolution order matches the server's `resolveActiveWorkspace`:
      // cookie wins → server's hint (workspaces.json activeId) → first
      // workspace. Falling back to the first item used to disagree with
      // the server whenever there was no cookie (fresh browser, incognito,
      // Playwright), so the workspace switcher highlighted one tile while
      // the chat ran in another workspace's cwd.
      const cookie = readCookie();
      const cookieMatch =
        cookie && d.workspaces.some((w) => w.id === cookie) ? cookie : null;
      const serverHint =
        d.activeId && d.workspaces.some((w) => w.id === d.activeId) ? d.activeId : null;
      const fallback = d.workspaces[0]?.id ?? null;
      setActiveId(cookieMatch ?? serverHint ?? fallback);
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
        if (typeof window !== "undefined") {
          // Reload to pick up the new default cwd everywhere on the page.
          // Two URL patterns leak workspace-A state into workspace B if we
          // just reload the current href:
          //   - `/customize` / `/customize/<id>` are tied to a specific
          //     customization record, not a workspace-relative path —
          //     staying here leaves the user on a page that has nothing
          //     to do with the workspace they just switched to.
          //   - `/?session=X` (set by use-session.bindToSession via
          //     replaceState) carries a session id from the previous
          //     workspace. Boot would call createSession({ resume: X })
          //     under B's cwd and silently re-bind to A's session in the
          //     wrong workspace context.
          // In both cases, send the user to `/` with a clean query string.
          // Boot will resolve the new workspace's last-active tab from its
          // per-cwd `.claudius.db` (or spawn a fresh session if none).
          // Other routes (/files, /sessions, /git, …) are workspace-scoped
          // and reload cleanly under the new cwd.
          const path = window.location.pathname;
          if (path === "/" || /^\/customize($|\/)/.test(path)) {
            window.location.href = "/";
          } else {
            window.location.reload();
          }
        }
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
