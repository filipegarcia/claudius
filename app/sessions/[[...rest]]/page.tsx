import { redirectToWorkspaceRoute } from "@/lib/server/redirect-to-workspace";

/**
 * Bare-path redirect stub for `sessions` and any subroute (e.g.
 * `/sessions/<id>`). The workspace-scoped page lives under
 * `app/[workspaceId]/sessions/`; landing here means the cookie was
 * unreadable when middleware ran. We forward the path segments
 * verbatim so a bookmark to `/sessions/foo/bar` lands at
 * `/<id>/sessions/foo/bar` after the redirect.
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
  await redirectToWorkspaceRoute(`/sessions${tail}`, sp);
}
