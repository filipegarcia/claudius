import type { ReactNode } from "react";
import { WorkspaceIdGuard } from "@/components/nav/WorkspaceRedirects";

/**
 * Workspace-id validation. The `[workspaceId]` segment exists in the
 * URL but the value could be stale — a bookmark to a deleted
 * workspace, a typo, or a polluted cookie from middleware. The guard
 * ({@link WorkspaceIdGuard}) checks the id against the workspace list
 * and sends the user to `/` when it doesn't match a real workspace;
 * `app/page.tsx` then redirects to the active (cookie or store-hint)
 * workspace. Behind the Rust front door, its rule R4 answers with a
 * 307 instead.
 *
 * Without this guard, middleware would write the polluted id back to
 * the cookie on every request, leaving the UI permanently stuck on
 * "wrong workspace" — UI shows id X but `resolveActiveWorkspace`
 * falls back to a different workspace's data because the cookie's id
 * isn't in the store.
 *
 * A server component that reads nothing, so N04's static build can
 * add `generateStaticParams` here (a `"use client"` file can't export it).
 */
export default function WorkspaceLayout({ children }: { children: ReactNode }) {
  return <WorkspaceIdGuard>{children}</WorkspaceIdGuard>;
}
