import { BareRouteRedirect } from "@/components/nav/WorkspaceRedirects";

/**
 * Bare-path redirect stub for `sessions` and any subroute (e.g.
 * `/sessions/foo/bar`). The workspace-scoped page lives under
 * `app/[workspaceId]/sessions/`; landing here means the cookie was
 * unreadable when the proxy ran. {@link BareRouteRedirect} resolves the
 * active workspace and sends the browser to `/<id>/sessions/foo/bar`, keeping
 * the query. Behind the Rust front door, its rule R2 answers with a 307
 * instead.
 */
export default function Page() {
  return <BareRouteRedirect />;
}
