import { GitFileWindow } from "@/components/git/GitFileWindow";
import type { DiffSelection } from "@/components/git/ChangesList";

/**
 * Pop-out window for one changed file — opened from the Git page by
 * double-clicking a row (or its "open in new window" button). Renders the
 * same diff/editor pane as the Git page's right side, full-window, without
 * the side nav. `?path=` is the repo-relative path; `?mode=` the preferred
 * diff base (falls back to the file's natural group when it no longer
 * applies).
 *
 * Workspace-id validation is inherited from `app/[workspaceId]/layout.tsx`.
 */

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

function first(v: string | string[] | undefined): string {
  return (Array.isArray(v) ? v[0] : v) ?? "";
}

function parseMode(v: string): DiffSelection["mode"] | null {
  return v === "staged" || v === "worktree" || v === "untracked" ? v : null;
}

export default async function Page({
  params,
  searchParams,
}: {
  params: Promise<{ workspaceId: string }>;
  searchParams: SearchParams;
}) {
  const { workspaceId } = await params;
  const sp = await searchParams;
  return (
    <GitFileWindow
      wsId={workspaceId}
      path={first(sp.path)}
      initialMode={parseMode(first(sp.mode))}
    />
  );
}
