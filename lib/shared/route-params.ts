/**
 * Route params read from the URL path (`usePathname()`) instead of
 * `useParams()` or a page's `params` prop.
 *
 * Under `output: "export"` (rust/TODO.md N04) each dynamic segment is
 * prerendered once with a placeholder param (`__ws__`, `__sid__`,
 * `__cust__`), and Next 16 hydrates `useParams()` and page `params` from
 * that prerendered tree, so they would report the placeholder. The pathname
 * comes from `location.href` and stays right. See
 * rust/parity/server-components.md § 2, caveat 1.
 */

/**
 * Segment `index` (0 = the first) of `pathname`, in the form `useParams()`
 * reports a dynamic param: Next puts `encodeURIComponent` of the server's
 * decoded value in the router tree (`getDynamicParam`), so this is
 * `encodeURIComponent(decodeURIComponent(raw))`, or the raw text when it
 * doesn't decode (Next's own `canonicalizeURLPart`). `null` when the path
 * has no such segment.
 *
 * Only for a component that renders on one route shape (a page), where the
 * position is the param: `/<workspaceId>/sessions/<id>` → index 2 is `id`.
 */
export function pathSegment(pathname: string | null | undefined, index: number): string | null {
  if (!pathname) return null;
  const raw = pathname.split("/")[index + 1];
  if (!raw) return null;
  try {
    return encodeURIComponent(decodeURIComponent(raw));
  } catch {
    return raw;
  }
}

const WORKSPACE_PATH_RE = /^\/(wks_[a-f0-9]{12})(\/|$)/;

/**
 * The workspace a `/<wks_id>/…` path is scoped to, for components that
 * render on more than one route (the command palette, the chat's system
 * pills, which the customization chat renders too). Matches the
 * `wks_` + 12 hex ids `createWorkspace` mints, the shape `proxy.ts` syncs
 * into the cookie. `null` anywhere else (`/customize/<id>/chat`,
 * `/settings`, …).
 */
export function workspaceIdFromPathname(pathname: string | null | undefined): string | null {
  const m = WORKSPACE_PATH_RE.exec(pathname ?? "");
  return m ? m[1] : null;
}

const CUSTOMIZATION_PATH_RE = /^\/customize\/(cust_[a-z0-9]+)/i;

/**
 * The customization a `/customize/<cust_id>…` path names (the detail page,
 * its chat), for components outside those pages (`CustomizationBanner`).
 * `null` anywhere else, `/customize/settings` included.
 */
export function customizationIdFromPathname(pathname: string | null | undefined): string | null {
  const m = CUSTOMIZATION_PATH_RE.exec(pathname ?? "");
  return m ? m[1] : null;
}
