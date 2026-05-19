"use client";

/**
 * Cross-cut Electron event handlers that don't fit in a single page.
 *
 * Phase 8 follow-up of docs/electron-conversion/PLAN.md.
 *
 * Currently handles:
 *   - `app.openWorkspace` menu action → `dialog.openWorkspace()` →
 *     POST /api/workspaces → switch to it.
 *   - `bridge.workspaces.onOpenFolder(path)` (dock drop) → POST
 *     /api/workspaces → switch.
 *
 * Both flows funnel through the same `createWorkspaceFromPath` helper
 * so error/UX is consistent. Renders nothing — exists only to host
 * the subscriptions from `app/layout.tsx`.
 */
import { useRouter } from "next/navigation";
import { useCallback } from "react";

import {
  useClaudius,
  useElectronAction,
  useElectronSubscription,
} from "./useElectron";

function basename(path: string): string {
  // Cross-platform: split on both `/` and `\`, ignore empty trailing.
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? path;
}

async function createWorkspaceFromPath(
  path: string,
): Promise<{ ok: true; id: string } | { ok: false; error: string }> {
  const name = basename(path);
  if (!name) return { ok: false, error: "empty path" };
  try {
    const res = await fetch("/api/workspaces", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, rootPath: path }),
    });
    if (!res.ok) {
      const err = (await res.json().catch(() => ({}))) as { error?: string };
      return { ok: false, error: err.error ?? `HTTP ${res.status}` };
    }
    const ws = (await res.json()) as { id: string };
    // Mark the new workspace as the active selection so the next nav
    // resolves it via the cookie.
    await fetch(`/api/workspaces/${ws.id}/select`, { method: "POST" });
    return { ok: true, id: ws.id };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export function useElectronGlobalActions(): void {
  const bridge = useClaudius();
  const router = useRouter();

  // ── File → Open Workspace… menu action ─────────────────────────────────
  const onOpenWorkspaceMenu = useCallback(async () => {
    if (!bridge) return;
    const path = await bridge.dialog.openWorkspace();
    if (!path) return;
    const result = await createWorkspaceFromPath(path);
    if (!result.ok) {
      // Best-effort surfacing — a dedicated toast lands as a separate
      // followup. console.error keeps the failure inspectable in the
      // dev tools.
      console.error("[electron] open-workspace failed:", result.error);
      return;
    }
    router.push(`/${result.id}`);
  }, [bridge, router]);
  useElectronAction("app.openWorkspace", () => {
    void onOpenWorkspaceMenu();
  });

  // ── OS folder drop on dock icon / file association ─────────────────────
  useElectronSubscription<string>(
    bridge?.workspaces.onOpenFolder,
    useCallback(
      async (path: string) => {
        const result = await createWorkspaceFromPath(path);
        if (!result.ok) {
          console.error("[electron] dock-drop workspace failed:", result.error);
          return;
        }
        router.push(`/${result.id}`);
      },
      [router],
    ),
  );
}
