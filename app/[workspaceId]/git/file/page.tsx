"use client";

import { usePathname, useSearchParams } from "next/navigation";
import { GitFileWindow } from "@/components/git/GitFileWindow";
import type { DiffSelection } from "@/components/git/ChangesList";
import { pathSegment } from "@/lib/shared/route-params";

/**
 * Pop-out window for one changed file — opened from the Git page by
 * double-clicking a row (or its "open in new window" button). Renders the
 * same diff/editor pane as the Git page's right side, full-window, without
 * the side nav. `?path=` is the repo-relative path; `?mode=` the preferred
 * diff base (falls back to the file's natural group when it no longer
 * applies).
 *
 * A client page: the workspace id comes from the pathname (not `params`,
 * see lib/shared/route-params.ts) and the query from `useSearchParams()`,
 * which the root layout's `<Suspense>` covers. Workspace-id validation is
 * inherited from `app/[workspaceId]/layout.tsx`.
 */

function parseMode(v: string): DiffSelection["mode"] | null {
  return v === "staged" || v === "worktree" || v === "untracked" ? v : null;
}

export default function Page() {
  const workspaceId = pathSegment(usePathname(), 0) ?? "";
  const search = useSearchParams();
  return (
    <GitFileWindow
      wsId={workspaceId}
      path={search.get("path") ?? ""}
      initialMode={parseMode(search.get("mode") ?? "")}
    />
  );
}
