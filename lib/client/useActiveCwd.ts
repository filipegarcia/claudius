"use client";

import { useWorkspaces } from "./useWorkspaces";

/**
 * Single source of truth for "which cwd does this workspace-scoped page
 * read from?".
 *
 * Returns:
 *   - `null`   while the workspaces list is still loading. Pages should
 *              treat this as "wait" and not kick off any cwd-dependent
 *              fetches yet.
 *   - `""`     if there's no active workspace at all. Server endpoints
 *              already interpret an empty cwd as "fall back to
 *              process.cwd()", which preserves single-workspace and
 *              headless-CLI flows.
 *   - the active workspace's `rootPath` otherwise.
 *
 * The value is reactive — switching workspaces flips `activeId`, the
 * lookup recomputes, and any `useEffect` that has `[cwd]` in its deps
 * re-runs. That's what makes the pages (Agents, Skills, Memory, MCP,
 * Hooks, Cost, Assets, Schedule, Plugins, Settings, Usage) actually
 * follow the workspace pill on the leftmost rail.
 *
 * Replaces the older pattern that pulled cwd from the first row of
 * /api/sessions — that was wrong because the first session in memory
 * isn't necessarily in the active workspace, and because the value never
 * refreshed on workspace switch.
 */
export function useActiveCwd(): string | null {
  const { items, activeId, loading } = useWorkspaces();
  if (loading) return null;
  const ws = items.find((w) => w.id === activeId);
  return ws?.rootPath ?? "";
}
