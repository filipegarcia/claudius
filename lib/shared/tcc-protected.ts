/**
 * macOS TCC ("Transparency, Consent, and Control") protected-folder
 * categories.
 *
 * On macOS 13+, the first time any process inside a sandboxed/signed app
 * stats or reads `~/Desktop`, `~/Documents`, `~/Downloads`, `~/Movies`,
 * `~/Music`, `~/Pictures`, or `~/Library/Containers/*`, the OS pops a
 * modal asking the user to grant access. The dialog is the OS's own UI —
 * we cannot suppress it once the syscall has happened; the only lever
 * we have is to not make the syscall until we've shown our own
 * heads-up first.
 *
 * Use this module from two seams:
 *
 *   1. `app/api/fs/dirs/route.ts` — the directory picker's read endpoint
 *      decorates entries with `protected: true` and refuses to call
 *      `fs.stat`/`fs.readdir` against a protected path unless the
 *      client explicitly passes `?ack=1`.
 *
 *   2. `components/workspaces/DirectoryPicker.tsx` — intercepts clicks
 *      on protected entries, shows our own explanatory modal, and only
 *      then issues the `?ack=1` request that will (possibly) trigger
 *      the OS-level dialog the user now has context for.
 *
 * Categories the picker should HIDE entirely (rather than gate):
 *
 *   - `~/Library/Containers/*`        (other apps' sandbox containers)
 *   - `~/Library/Group Containers/*`  (shared sandbox group containers)
 *
 * Descending into these fires the macOS "Claudius would like to access
 * data from other apps" prompt, and a workspace never legitimately
 * lives there. Hiding them at the listing level kills that prompt
 * entirely.
 *
 * Non-macOS platforms get a no-op — the helpers below return
 * `null`/`false` so the picker behaves exactly as before on Linux/Win.
 */

/** Display label paired with each protected category. */
export type TccCategory =
  | "Desktop"
  | "Documents"
  | "Downloads"
  | "Movies"
  | "Music"
  | "Pictures";

/** Categories that, when first read, surface a TCC consent dialog. */
const CATEGORY_DIRS: readonly TccCategory[] = [
  "Desktop",
  "Documents",
  "Downloads",
  "Movies",
  "Music",
  "Pictures",
] as const;

/**
 * Subpaths (relative to `$HOME`) we hide outright from the picker.
 * Descending here triggers the "data from other apps" prompt and no
 * legitimate workspace lives under them. Kept as forward-slash strings
 * so callers compare against `relative(home, path).split(sep).join("/")`.
 */
export const HIDDEN_HOME_SUBPATHS = [
  "Library/Containers",
  "Library/Group Containers",
] as const;

/**
 * Identify the TCC category a path falls under, if any. Returns `null`
 * when the path is outside `$HOME`, when it's `$HOME` itself, or when
 * the runtime isn't macOS — none of those need gating.
 *
 * Pure function, takes both inputs explicitly so server and client code
 * can call it without dragging in `os.homedir()`. The server passes
 * `homedir()`; the client passes the `home` field the picker endpoint
 * already returns in its listing payload.
 *
 *   categorizeTccPath("/Users/me/Desktop", "/Users/me", "darwin")
 *     → "Desktop"
 *   categorizeTccPath("/Users/me/Desktop/foo/bar", "/Users/me", "darwin")
 *     → "Desktop"   ← any descendant counts too, since TCC fires there
 *   categorizeTccPath("/Users/me/Projects/x", "/Users/me", "darwin")
 *     → null
 */
export function categorizeTccPath(
  absPath: string,
  home: string,
  platform: NodeJS.Platform | string,
): TccCategory | null {
  if (platform !== "darwin") return null;
  if (!absPath || !home) return null;
  const normHome = home.endsWith("/") ? home.slice(0, -1) : home;
  // Must be strictly below $HOME — $HOME itself is not protected.
  const prefix = normHome + "/";
  if (!absPath.startsWith(prefix)) return null;
  const tail = absPath.slice(prefix.length);
  // The category is the first path segment; `Desktop` matches both
  // `~/Desktop` and `~/Desktop/foo/bar`.
  const firstSeg = tail.split("/")[0];
  if (!firstSeg) return null;
  return (CATEGORY_DIRS as readonly string[]).includes(firstSeg)
    ? (firstSeg as TccCategory)
    : null;
}

/**
 * Should this child of `$HOME` be filtered out of picker listings
 * entirely (rather than shown with a lock badge)? True for
 * `Library/Containers` and `Library/Group Containers` on macOS.
 *
 * `relFromHome` is the slash-joined relative path from `$HOME` (e.g.
 * `"Library/Containers"` or `"Library"`); compare with that exact
 * shape — the server's directory walk produces it via `path.relative`.
 */
export function isHiddenHomeSubpath(
  relFromHome: string,
  platform: NodeJS.Platform | string,
): boolean {
  if (platform !== "darwin") return false;
  if (!relFromHome) return false;
  const norm = relFromHome.replaceAll("\\", "/");
  for (const hidden of HIDDEN_HOME_SUBPATHS) {
    if (norm === hidden || norm.startsWith(hidden + "/")) return true;
  }
  return false;
}

/**
 * Short human-readable copy for the in-app heads-up modal and the OS
 * notification body. Returned as `{ title, body }` so the picker can
 * forward it to both surfaces without re-deriving strings.
 *
 *   tccHeadsUpCopy("Desktop")
 *     → { title: "Allow Claudius to access Desktop?",
 *         body:  "macOS will ask for permission to read files in your
 *                 Desktop folder. We need this so you can pick a project
 *                 from there." }
 *
 * The wording mirrors the categories Apple's TCC engine uses so the
 * user can connect our modal to the OS dialog that follows.
 */
export function tccHeadsUpCopy(category: TccCategory): {
  title: string;
  body: string;
} {
  const folderLabel: Record<TccCategory, string> = {
    Desktop: "Desktop",
    Documents: "Documents",
    Downloads: "Downloads",
    Movies: "Movies",
    Music: "Music",
    Pictures: "Pictures",
  };
  const label = folderLabel[category];
  return {
    title: `Allow Claudius to access ${label}?`,
    body: `macOS will ask permission next so Claudius can read files in your ${label} folder. We need this only to let you pick a project from there.`,
  };
}
