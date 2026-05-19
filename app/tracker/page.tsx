import { redirectToWorkspaceRoute } from "@/lib/server/redirect-to-workspace";

/**
 * Bare-path redirect stub. The workspace-scoped page lives under
 * `app/[workspaceId]/tracker/`; landing here means the cookie was
 * unreadable when middleware ran (first boot, cleared cookies). The
 * helper resolves the active workspace via the store hint and
 * 307s the browser to the canonical `/<id>/tracker` URL, preserving any
 * search params on the way through.
 */
export default async function Page({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  await redirectToWorkspaceRoute("/tracker", sp);
}
