/**
 * Per-workspace "last visited URL" memory.
 *
 * Clicking a workspace tile should return the user to where they last
 * were *in that workspace* — not the chat home, and not the path they
 * happen to be on under a different workspace's cwd. We store the
 * mapping in localStorage so it survives reloads and works across tabs
 * (last-write-wins is acceptable).
 *
 * Only workspace-scoped paths are remembered. Global routes
 * (`/community`, `/plugins`, `/settings`, `/usage`, `/customize/*`,
 * `/doctor`, `/release-notes`, `/updater`) aren't meaningfully "in" a
 * workspace, so writing them would clobber the user's actual last
 * project location. We blacklist rather than whitelist — new
 * workspace-scoped pages get added under `app/[workspaceId]/`
 * regularly and a whitelist would silently miss them.
 *
 * **Storage shape:** internally we keep the *inner* path (e.g. `/git`,
 * `/sessions/foo`, or `""` for the workspace root), not the
 * fully-prefixed URL (`/wks_aaa/git`). Storing inner paths means
 * renaming or rotating workspace ids won't strand the saved value —
 * and reading back is one prepend away from a navigable URL. The
 * getter returns the *full* `/<id>/<inner>` form so callers can
 * navigate directly without rebuilding the path.
 */

const STORAGE_KEY = "claudius.workspace.lastPath";
const WORKSPACE_ID_RE = /^\/wks_[a-f0-9]+(\/.*)?$/;

export function isWorkspaceScopedPath(pathname: string): boolean {
  return !(
    pathname.startsWith("/community") ||
    pathname.startsWith("/plugins") ||
    pathname.startsWith("/settings") ||
    pathname.startsWith("/usage") ||
    pathname.startsWith("/customize") ||
    pathname.startsWith("/doctor") ||
    pathname.startsWith("/release-notes") ||
    pathname.startsWith("/updater")
  );
}

/**
 * Strip the leading workspace-id segment from a pathname and return
 * the inner path. Returns `null` when the path doesn't carry a
 * workspace prefix — those paths shouldn't be persisted (we have no
 * way to associate them with a workspace).
 *
 *   "/wks_abc/git"   → "/git"
 *   "/wks_abc"       → ""
 *   "/git"           → null   (bare, pre-redirect)
 *   "/settings"      → null   (global)
 */
function stripPrefix(pathname: string): string | null {
  const m = pathname.match(WORKSPACE_ID_RE);
  if (!m) return null;
  return m[1] ?? "";
}

function readMap(): Record<string, unknown> {
  if (typeof window === "undefined") return {};
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return typeof parsed === "object" && parsed !== null
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

/**
 * Look up the last visited path for a workspace. Returns a fully
 * navigable URL (`/<id>` or `/<id>/<inner>`), or `null` if nothing
 * has been persisted yet.
 */
export function getLastPath(workspaceId: string): string | null {
  const map = readMap();
  const v = map[workspaceId];
  // Tolerate both the legacy storage shape (full prefixed paths from
  // before this refactor) and the new inner-path shape. A stored value
  // that already includes the workspace prefix is returned as-is;
  // anything else is prepended.
  if (typeof v !== "string") return null;
  if (v.startsWith(`/${workspaceId}`)) return v;
  if (!v.startsWith("/") && v !== "") return null;
  return `/${workspaceId}${v}`;
}

/**
 * Remember the current location for a workspace. `pathname` is the
 * full pathname from `usePathname()` (always carries the workspace
 * prefix in the running app). No-op for global routes (so a stop on
 * /settings doesn't overwrite the project page the user actually
 * cares about) and silently swallows storage failures (private mode,
 * quota exceeded, disabled storage).
 */
export function setLastPath(workspaceId: string, pathname: string): void {
  if (typeof window === "undefined") return;
  if (!pathname.startsWith("/")) return;
  if (!isWorkspaceScopedPath(pathname)) return;
  const inner = stripPrefix(pathname);
  if (inner === null) return; // bare pathname; can't attribute to a workspace
  const map = readMap();
  if (map[workspaceId] === inner) return; // already current — skip the write
  map[workspaceId] = inner;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(map));
  } catch {
    // localStorage can be unavailable; non-fatal.
  }
}
