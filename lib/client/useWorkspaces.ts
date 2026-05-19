"use client";

import { useCallback, useEffect, useState } from "react";
import type { Icon, Workspace } from "@/lib/server/workspaces-store";

const COOKIE = "claudius.workspace";

function readCookie(): string | null {
  if (typeof document === "undefined") return null;
  const m = document.cookie.match(new RegExp("(?:^|; )" + COOKIE + "=([^;]+)"));
  return m ? decodeURIComponent(m[1]) : null;
}

/**
 * Load the workspace list with the active selection resolved. Pattern
 * matches `useCost` (refetchTrigger + AbortController +
 * setState-in-callback). `create` auto-selects the new workspace; `select`
 * navigates the browser to a per-workspace route after the server confirms
 * the switch.
 */
export function useWorkspaces() {
  const [items, setItems] = useState<Workspace[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refetchTrigger, setRefetchTrigger] = useState(0);

  useEffect(() => {
    const controller = new AbortController();

    fetch("/api/workspaces", { signal: controller.signal })
      .then(async (res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return (await res.json()) as { workspaces: Workspace[]; activeId?: string | null };
      })
      .then((d) => {
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
  }, [refetchTrigger]);

  const refresh = useCallback(() => {
    setLoading(true);
    setRefetchTrigger((n) => n + 1);
  }, []);

  const select = useCallback(
    async (id: string, route?: string) => {
      const res = await fetch(`/api/workspaces/${id}/select`, { method: "POST" });
      if (res.ok) {
        setActiveId(id);
        if (typeof window !== "undefined") {
          // Caller supplied a target URL. Two shapes flow in:
          //   - A fully-prefixed URL for `id` (`/<id>/git`) — comes
          //     from `workspace-route-memory.getLastPath`, which now
          //     returns the prefix-included form.
          //   - A workspace-relative *inner* path (`"/workspace"`,
          //     `"/"`) — used by callers that haven't been migrated to
          //     prefixed URLs (WorkspaceContextMenu, the cycle-prev/next
          //     fallback). We detect this and prepend `/${id}`.
          // The full-document load is intentional: the new workspace's
          // cwd is server-side state, so a router.push wouldn't reset
          // the SDK's child process. Same reason `/customize` and
          // `/?session=X` get redirected to the workspace root instead
          // of being preserved across the switch.
          if (typeof route === "string" && route.startsWith("/")) {
            const target = route.startsWith(`/${id}`) ? route : `/${id}${route === "/" ? "" : route}`;
            window.location.href = target;
            return;
          }
          // Legacy fallback when no route is supplied (e.g.
          // CustomizationsDrawer). The current pathname categorises:
          //   - `/<oldWorkspaceId>/...` — swap the workspace id and
          //     keep the inner path. Same-tile-different-cwd is the
          //     most common case.
          //   - `/customize/...` — tied to a specific customization,
          //     not the workspace; reset to the new workspace's root.
          //   - everything else (global routes like /settings) —
          //     plain reload; the page is workspace-agnostic.
          const path = window.location.pathname;
          const m = path.match(/^\/wks_[a-f0-9]+(\/.*)?$/);
          if (m) {
            const inner = m[1] ?? "";
            window.location.href = `/${id}${inner}`;
            return;
          }
          if (path === "/" || /^\/customize($|\/)/.test(path)) {
            window.location.href = `/${id}`;
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
      // Trigger a background re-pull so the new workspace shows up in the
      // list. The auto-select happens immediately on the optimistic id —
      // callers that route off `activeId` don't have to wait for the GET.
      refresh();
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
      if (res.ok) refresh();
      return res.ok;
    },
    [refresh],
  );

  const remove = useCallback(
    async (id: string) => {
      const res = await fetch(`/api/workspaces/${id}`, { method: "DELETE" });
      if (res.ok) refresh();
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
      if (!res.ok) refresh();
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
