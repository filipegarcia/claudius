import { redirectToWorkspaceRoute } from "@/lib/server/redirect-to-workspace";

/**
 * Bare-path redirect stub for `dev` and any subroute (e.g.
 * `/sessions/<id>`). The workspace-scoped page lives under
 * `app/[workspaceId]/dev/`; landing here means the cookie was
 * unreadable when middleware ran. We forward the path segments
 * verbatim so a bookmark to `/dev/foo/bar` lands at
 * `/<id>/dev/foo/bar` after the redirect.
 */
export default async function Page({
  params,
  searchParams,
}: {
  params: Promise<{ rest?: string[] }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const [{ rest }, sp] = await Promise.all([params, searchParams]);
  const tail = rest && rest.length > 0 ? "/" + rest.join("/") : "";
  await redirectToWorkspaceRoute(`/dev${tail}`, sp);
}
