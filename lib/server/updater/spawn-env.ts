import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";

/**
 * Standard install locations for bun (and the rest of the toolchain the
 * updater shells out to — git, claude, bash). Same family of solution as
 * `.githooks/_runtime.sh`, which patches PATH for git hooks invoked by GUIs
 * — but the two lists are not enforced to match (the hook also walks
 * nvm/volta/fnm because the hook can fall back to npm; we only need bun,
 * which isn't installed via Node version managers).
 *
 * Order matters: earlier entries win when the same binary is in two places
 * (e.g. user-local bun in `~/.bun/bin` shadowing a brew-installed bun).
 *
 * Why this exists: a Claudius daemon launched from outside a shell — Finder
 * double-click, launchd, an IDE that didn't source `~/.zprofile`, Spotlight —
 * inherits the minimal kernel PATH (`/usr/bin:/bin:/usr/sbin:/sbin`). Bun
 * is installed under the user's home or homebrew prefix and is therefore
 * invisible to a `spawn("bun", …)` call. The updater's `bun install` then
 * dies with the cryptic `spawn bun ENOENT`, which is what the user actually
 * sees in the UI banner.
 *
 * Recovery walks the standard install locations and prepends every directory
 * that exists on disk to the inherited PATH. Idempotent and silent — if PATH
 * already has the location, we don't re-add it.
 */
/** Locations relative to $HOME — joined with `homedir()` before use. */
const HOME_RELATIVE = [
  ".bun/bin", // bun's own installer
] as const;

/**
 * Absolute install prefixes. These also catch homebrew-installed git/node
 * when the parent process didn't have them — strictly additive.
 */
const ABSOLUTE_LOCATIONS = [
  "/opt/homebrew/bin", // homebrew on Apple Silicon
  "/usr/local/bin", // homebrew on Intel macOS, or hand-installed
  "/home/linuxbrew/.linuxbrew/bin", // linuxbrew
] as const;

/** Return the candidate install dirs in priority order, $HOME-expanded. */
export function bunInstallCandidates(home: string = homedir()): string[] {
  return [
    ...HOME_RELATIVE.map((rel) => join(home, rel)),
    ...ABSOLUTE_LOCATIONS,
  ];
}

/**
 * Returns a PATH string that contains every standard bun/homebrew install
 * directory that exists on disk, prepended to whatever the parent process
 * had. Used by the updater's spawn paths (`git`, `bun install`, the
 * detached restarter) so they don't fail with ENOENT when Claudius was
 * launched outside a shell.
 *
 * Pure-ish: takes no input beyond `process.env.PATH` and the filesystem,
 * returns a string. Safe to call repeatedly — the existence check is a
 * single `stat` per known location.
 *
 * The `home` parameter is injectable so tests can point at a tmp dir
 * without having to monkey-patch `node:os.homedir` (which fails under
 * vitest's ESM module namespace).
 */
export function extendedPath(
  currentPath: string | undefined = process.env.PATH,
  home: string = homedir(),
): string {
  const parts = (currentPath ?? "").split(delimiter).filter(Boolean);
  const seen = new Set(parts);
  const prepend: string[] = [];
  for (const dir of bunInstallCandidates(home)) {
    if (seen.has(dir)) continue;
    if (!existsSync(dir)) continue;
    prepend.push(dir);
    seen.add(dir);
  }
  if (prepend.length === 0) return currentPath ?? "";
  return [...prepend, ...parts].join(delimiter);
}

/**
 * Return an env clone with PATH replaced by `extendedPath()`. Convenience
 * wrapper for spawn callers that already build an env object — they can
 * spread `withExtendedPath(env)` and not think about it.
 */
export function withExtendedPath<T extends NodeJS.ProcessEnv>(env: T): T {
  return { ...env, PATH: extendedPath(env.PATH) };
}
