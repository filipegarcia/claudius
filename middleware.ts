import { NextResponse, type NextRequest } from "next/server";

/**
 * URL ↔ workspace cookie plumbing.
 *
 * Workspace-scoped routes live under `/<wks_xxxxxxxxxxxx>/...` (see
 * `app/[workspaceId]/`). The cookie is the server's source of truth for
 * "which workspace is active" — read by `resolveActiveWorkspace` in
 * route handlers and server components. Two jobs run here:
 *
 *  1. **Cookie sync.** When the request path starts with a workspace
 *     id, write that id back to the `claudius.workspace` cookie so the
 *     cookie can never lag behind the URL (e.g. a bookmark to
 *     `/wks_aaa/git` arriving while the cookie still says `wks_bbb`).
 *     Server components can't mutate cookies, so this has to live in
 *     middleware.
 *
 *  2. **Bare-path redirect.** When the path is a bare workspace-scoped
 *     route (e.g. `/git`) and the cookie identifies an active workspace,
 *     307 the browser to `/<id>/git`. Keeps old bookmarks / muscle
 *     memory working and standardises the canonical URL shape.
 *
 * IDs are minted as `wks_<12 hex>` (see `lib/server/workspaces-store.ts`).
 * We match that exact shape so a literal page named e.g. `wkstest` can't
 * be mistaken for an id.
 */
const WORKSPACE_COOKIE = "claudius.workspace";
const WORKSPACE_ID_RE = /^wks_[a-f0-9]{12}$/;

/**
 * Top-level segments that live under `app/[workspaceId]/`. Kept in sync
 * with the actual app router layout — adding a new workspace-scoped
 * route means a new entry here AND a new redirect stub in `app/<name>/`.
 * Static routes that aren't workspace-scoped (settings, plugins,
 * customize, community, usage, doctor, release-notes, updater) are NOT
 * listed and pass through.
 */
const SCOPED_ROUTES = new Set<string>([
  "agents",
  "assets",
  "cost",
  "database",
  "dev",
  "docker",
  "files",
  "git",
  "hooks",
  "keybindings",
  "mcp",
  "memory",
  "notebooks",
  "permissions",
  "pipeline",
  "schedule",
  "sessions",
  "skills",
  "tracker",
  "workspace",
]);

export function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;
  const first = pathname.split("/")[1] ?? "";

  // Job 1: cookie sync when the URL already carries a workspace id.
  if (WORKSPACE_ID_RE.test(first)) {
    const existing = req.cookies.get(WORKSPACE_COOKIE)?.value;
    if (existing === first) return NextResponse.next();
    const res = NextResponse.next();
    res.cookies.set(WORKSPACE_COOKIE, first, {
      httpOnly: false,
      sameSite: "lax",
      path: "/",
      maxAge: 60 * 60 * 24 * 365,
    });
    return res;
  }

  // Job 2: bare workspace-scoped path → prefix with the cookie's id.
  //
  // The literal "/" (chat root) is intentionally NOT handled here —
  // it's routed to `app/page.tsx`, a server component that validates
  // the cookie against the workspace store *and* falls back to the
  // store's `activeId` hint when the cookie points at a deleted
  // workspace. Letting middleware redirect "/" cookie-blindly would
  // produce a loop: an invalid cookie sends the user to `/<bad-id>`,
  // the workspace layout redirects back to `/`, middleware re-reads
  // the same bad cookie, ... With "/" off the table the loop can't
  // form: invalid `/<bad-id>` paths redirect to `/`, which then
  // resolves via the store hint and 307s onward.
  if (SCOPED_ROUTES.has(first)) {
    const cookieId = req.cookies.get(WORKSPACE_COOKIE)?.value;
    if (cookieId && WORKSPACE_ID_RE.test(cookieId)) {
      const url = req.nextUrl.clone();
      url.pathname = `/${cookieId}${pathname}`;
      return NextResponse.redirect(url, 307);
    }
    // No cookie — fall through to the route's redirect stub, which
    // resolves the active workspace from the store hint and 307s. That
    // gives bare paths a path forward on first boot before any cookie
    // has been written.
  }

  return NextResponse.next();
}

export const config = {
  // Skip the API surface, Next's internals, and static asset fetches —
  // none of them need the URL ↔ cookie logic, and matching everything
  // would put the middleware on every image/script request.
  matcher: ["/((?!api/|_next/|.*\\.).*)"],
};
