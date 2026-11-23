import { RootRedirect } from "@/components/nav/WorkspaceRedirects";

/**
 * Bare chat root. Workspace-scoped chat lives at `/<wks_id>` (see
 * `app/[workspaceId]/page.tsx`); this page sends the browser there: to the
 * active workspace (cookie → store hint), else the first one, keeping the
 * query (notably `?session=X`, which the chat bootstrap reads to resume a
 * specific session).
 *
 * Falls back to `/welcome` when the install has zero workspaces (the
 * fresh-install state — we no longer auto-seed a "claudius" workspace).
 * The welcome splash walks the user through creating their first
 * workspace and saying hello in the community channel.
 *
 * The redirect runs in the browser ({@link RootRedirect}); behind the Rust
 * front door, its rule R1 answers `/` with a 307 instead.
 */
export default function RootPage() {
  return <RootRedirect />;
}
