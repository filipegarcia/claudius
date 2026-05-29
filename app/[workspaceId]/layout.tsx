import type { ReactNode } from "react";
import { redirect } from "next/navigation";
import { getWorkspace } from "@/lib/server/workspaces-store";

/**
 * Workspace-id validation. The `[workspaceId]` segment exists in the
 * URL but the value could be stale — a bookmark to a deleted
 * workspace, a typo, or a polluted cookie from middleware. We resolve
 * the id against the store and 307 the user to `/` when it doesn't
 * match a real workspace; `app/page.tsx` then redirects to the active
 * (cookie or store-hint) workspace.
 *
 * Without this guard, middleware would write the polluted id back to
 * the cookie on every request, leaving the UI permanently stuck on
 * "wrong workspace" — UI shows id X but `resolveActiveWorkspace`
 * falls back to a different workspace's data because the cookie's id
 * isn't in the store.
 *
 * No-op when the id is valid — layouts pass children through
 * untouched and the workspace-scoped page renders normally.
 *
 * Types are declared inline rather than via Next 16's generated
 * `LayoutProps<'/[workspaceId]'>` helper because that helper only
 * exists after `next dev` / `next build` has run typegen — typechecks
 * from a clean tree would fail otherwise. The inline shape matches
 * what Next's typegen produces (`{ params: Promise<...>; children:
 * ReactNode }`), so the runtime contract is identical.
 */
export default async function WorkspaceLayout({
  params,
  children,
}: {
  params: Promise<{ workspaceId: string }>;
  children: ReactNode;
}) {
  const { workspaceId } = await params;
  const ws = await getWorkspace(workspaceId);
  if (!ws) redirect("/");
  return children;
}
