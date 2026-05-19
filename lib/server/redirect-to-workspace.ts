import { redirect } from "next/navigation";
import { resolveActiveWorkspace } from "./active-workspace";

type SearchParamsRecord = Record<string, string | string[] | undefined>;

/**
 * Server-side helper used by the bare-path redirect stubs under `app/*`
 * (e.g. `app/git/page.tsx`). The user can land on an unprefixed URL via
 * a bookmark or muscle memory; we resolve the cookie / store hint to a
 * workspace id and 307 them to the canonical `/<id>/<route>` URL.
 *
 * When no workspace is resolvable (fresh install before any selection)
 * we fall through to `/` — the root page itself does its own resolution
 * and renders an empty state if no workspaces exist.
 *
 * `routePath` should be the route path without the workspace prefix,
 * with a leading slash (e.g. "/git", "/sessions"). An empty string
 * means the chat root.
 *
 * `searchParams` is forwarded verbatim so e.g. `/?session=X` survives
 * the bounce — boot logic in the chat root depends on it.
 */
export async function redirectToWorkspaceRoute(
  routePath: string,
  searchParams?: SearchParamsRecord,
): Promise<never> {
  const ws = await resolveActiveWorkspace();
  const qs = formatSearch(searchParams);
  if (!ws) {
    // No workspace at all: send the user to `/` which will render the
    // chat root's empty state. Using "/" rather than throwing keeps
    // first-boot navigation forgiving.
    redirect(`/${qs}`);
  }
  redirect(`/${ws.id}${routePath}${qs}`);
}

function formatSearch(sp: SearchParamsRecord | undefined): string {
  if (!sp) return "";
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
