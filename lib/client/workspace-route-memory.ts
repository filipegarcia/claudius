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
 * (`/community`, `/plugins`, `/settings`, `/usage`, `/customize/*`)
 * aren't meaningfully "in" a workspace, so writing them would clobber
 * the user's actual last project location. We blacklist rather than
 * whitelist — new workspace-scoped pages get added to `app/` regularly
 * (docker, doctor, release-notes, …), and a whitelist would silently
 * miss them.
 */

const STORAGE_KEY = "claudius.workspace.lastPath";

export function isWorkspaceScopedPath(pathname: string): boolean {
  return !(
    pathname.startsWith("/community") ||
    pathname.startsWith("/plugins") ||
    pathname.startsWith("/settings") ||
    pathname.startsWith("/usage") ||
    pathname.startsWith("/customize")
  );
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

/** Look up the last visited workspace-scoped path for a workspace. */
export function getLastPath(workspaceId: string): string | null {
  const map = readMap();
  const v = map[workspaceId];
  return typeof v === "string" && v.startsWith("/") ? v : null;
}

/**
 * Remember a workspace-scoped path for a workspace. No-op for global
 * routes (so a stop on /settings doesn't overwrite the project page the
 * user actually cares about) and silently swallows storage failures
 * (private mode, quota exceeded, disabled storage).
 */
export function setLastPath(workspaceId: string, pathname: string): void {
  if (typeof window === "undefined") return;
  if (!pathname.startsWith("/")) return;
  if (!isWorkspaceScopedPath(pathname)) return;
  const map = readMap();
  if (map[workspaceId] === pathname) return; // already current — skip the write
  map[workspaceId] = pathname;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(map));
  } catch {
    // localStorage can be unavailable; non-fatal.
  }
}
