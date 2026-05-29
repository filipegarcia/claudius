import { redirect } from "next/navigation";

import { resolveActiveWorkspace } from "@/lib/server/active-workspace";
import { listWorkspaces } from "@/lib/server/workspaces-store";

/**
 * Bare chat root. Workspace-scoped chat lives at `/<wks_id>` (see
 * `app/[workspaceId]/page.tsx`); this stub resolves the active workspace
 * (cookie → store hint → first workspace) and 307s the browser there,
 * preserving any search params (notably `?session=X`, which the chat
 * bootstrap reads to resume a specific session).
 *
 * Falls back to `/settings` when the install genuinely has zero
 * workspaces — `ensureBootstrap` normally seeds at least one, so this
 * branch is essentially unreachable; landing on /settings is preferred
 * over a redirect loop into another stub (which would also resolve to
 * "no workspace" and bounce back here).
 */
export default async function RootPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const qs = formatSearch(sp);

  const active = await resolveActiveWorkspace();
  if (active) redirect(`/${active.id}${qs}`);

  const all = await listWorkspaces();
  if (all.length > 0) redirect(`/${all[0]!.id}${qs}`);

  redirect("/settings");
}

function formatSearch(sp: Record<string, string | string[] | undefined>): string {
  const usp = new URLSearchParams();
  for (const [k, v] of Object.entries(sp)) {
    if (v == null) continue;
    if (Array.isArray(v)) {
      for (const x of v) usp.append(k, x);
    } else {
      usp.append(k, v);
    }
  }
  const s = usp.toString();
  return s ? `?${s}` : "";
}
