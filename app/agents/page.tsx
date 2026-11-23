import { BareRouteRedirect } from "@/components/nav/WorkspaceRedirects";

/**
 * Bare-path redirect stub. The workspace-scoped page lives under
 * `app/[workspaceId]/agents/`; landing here means the cookie was
 * unreadable when the proxy ran (first boot, cleared cookies).
 * {@link BareRouteRedirect} resolves the active workspace from the store
 * hint and sends the browser to the canonical `/<id>/agents` URL, keeping
 * the query. Behind the Rust front door, its rule R2 answers with a 307
 * instead.
 */
export default function Page() {
  return <BareRouteRedirect />;
}
