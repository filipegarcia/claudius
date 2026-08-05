import { promises as fs } from "node:fs";
import { resolve } from "node:path";

import { listCustomizations, customizationSrcDir } from "./customizations-store";
import { listWorkspaces } from "./workspaces-store";
import { listWorktrees } from "./worktrees";

/**
 * Trust barrier for the `?cwd=` / `body.cwd` parameter that ~27 route
 * handlers accept.
 *
 * ## Why this exists
 *
 * Those routes took the caller's path at face value and handed it straight to
 * `fs.*` — `readSettings`/`writeSettings`, the agents/skills/MCP file stores,
 * CLAUDE.md, auto-memory, and so on. Claudius has no auth and no CSRF
 * defence (Next.js doesn't gate request *processing* on origin), so **any web
 * page the user visits could drive them cross-origin**. A single
 * `POST /api/settings/permissions` with `{scope:"project", cwd:"/anywhere"}`
 * wrote `/anywhere/.claude/settings.json` — and settings.json carries
 * `permissions.allow`, `hooks`, `env` and `apiKeyHelper`, so that is an
 * arbitrary-directory write that turns into code execution the moment the
 * user opens that directory as a workspace.
 *
 * ## The rule
 *
 * A cwd is trusted only if it is *exactly* one of the directories the user
 * has already registered with Claudius. That set is small and enumerable:
 *
 *   1. `process.cwd()` — the historical default when no cwd is supplied.
 *   2. Every workspace `rootPath`.
 *   3. Every workspace's `additionalDirectories` (the dirs `/add-dir` and the
 *      new-workspace form grant the agent).
 *   4. Every customization's editable `src/` mirror.
 *   5. Worktrees of any of the above — the SDK's EnterWorktree picks the
 *      location, so we ask git rather than guessing. Only consulted when the
 *      cheap checks miss, so the common path costs one JSON read.
 *
 * Exact match (not "is a descendant of") is deliberate and load-bearing:
 * every legitimate caller passes a workspace root, a customization mirror, or
 * a session cwd, and all three are members of this set. Requiring exactness
 * lets us return **the store's own string** rather than the caller's, which
 * means the value reaching `fs.*` no longer originates from the request at
 * all. That is what actually closes CodeQL's `js/path-injection` on these
 * flows — a validation check alone would not, and more importantly a
 * containment check against a base the caller also controls would be
 * security theatre.
 *
 * ## Scope
 *
 * This closes the arbitrary-path write. It does **not** make the routes
 * CSRF-safe: a foreign page can still drive them against the user's *real*
 * workspaces. An `Origin`/`Sec-Fetch-Site` check in middleware is the fix for
 * that class and is tracked separately — it belongs in one place, not in 27.
 */

/**
 * Every directory the user has registered, resolved and de-duplicated.
 *
 * Each entry is included both as stored and as its `realpath`. A stored root
 * and a git-reported worktree can spell the same directory differently when a
 * symlink sits in the middle (`/var` → `/private/var` on macOS is the common
 * one), and a mismatch here reads to the caller as "unknown cwd". Note the
 * realpath is only ever taken of a *store-derived* path — never of the
 * caller's input, which must not reach an `fs.*` call before it's trusted.
 */
async function computeTrustedRoots(): Promise<string[]> {
  const stored = new Set<string>([resolve(process.cwd())]);

  const workspaces = await listWorkspaces().catch(() => []);
  for (const ws of workspaces) {
    if (typeof ws.rootPath === "string" && ws.rootPath.trim()) {
      stored.add(resolve(ws.rootPath));
    }
    for (const dir of ws.defaults?.additionalDirectories ?? []) {
      if (typeof dir === "string" && dir.trim()) stored.add(resolve(dir));
    }
  }

  const customizations = await listCustomizations().catch(() => []);
  for (const c of customizations) stored.add(resolve(customizationSrcDir(c.id)));

  const out = new Set<string>(stored);
  for (const dir of stored) {
    const real = await fs.realpath(dir).catch(() => null);
    if (real) out.add(real);
  }
  return [...out];
}

/**
 * Short-lived caches.
 *
 * This runs on *every* request to ~27 routes, and a page boot fires dozens of
 * them at once. Uncached, each one re-read workspaces.json + the
 * customizations index and issued a `realpath` per root, which was enough
 * extra latency to measurably slow the app's hydration (it tripled the
 * failure rate of a timing-sensitive e2e that polls for the tab strip to
 * settle). Caching is what keeps this guard cheap enough to sit in a hot path.
 *
 * Two rules keep the cache from causing false rejections:
 *   - Only *successful* resolutions are memoised. A negative result is never
 *     cached, so a directory the user registers a moment later is usable
 *     immediately rather than after a TTL.
 *   - A miss against the cached root list forces one fresh read before the
 *     request is rejected.
 */
const CACHE_TTL_MS = 5_000;
let rootsCache: { roots: string[]; at: number } | null = null;
let inflightRoots: Promise<string[]> | null = null;
const resolvedCache = new Map<string, { value: string; at: number }>();

async function trustedRoots(force = false): Promise<string[]> {
  if (!force) {
    if (rootsCache && Date.now() - rootsCache.at < CACHE_TTL_MS) return rootsCache.roots;
    // A cold page boot fires dozens of these routes at once, and without this
    // every one of them would run its own copy of the store reads. Share the
    // first computation with everyone who arrives while it's still running.
    if (inflightRoots) return inflightRoots;
  }
  const p = computeTrustedRoots().then(
    (roots) => {
      rootsCache = { roots, at: Date.now() };
      if (inflightRoots === p) inflightRoots = null;
      return roots;
    },
    (err) => {
      if (inflightRoots === p) inflightRoots = null;
      throw err;
    },
  );
  if (!force) inflightRoots = p;
  return p;
}

/**
 * Resolve a caller-supplied cwd to a trusted absolute path, or `null` if it
 * isn't one of the user's registered directories.
 *
 * An empty/absent input yields `process.cwd()`, preserving the behaviour every
 * one of these routes had before (`url.searchParams.get("cwd") || process.cwd()`).
 *
 * The returned string always comes from the workspace/customization store or
 * from git — never from the request.
 */
export async function resolveTrustedCwd(input: string | null | undefined): Promise<string | null> {
  if (typeof input !== "string" || !input.trim()) {
    const roots = await trustedRoots();
    return roots[0];
  }

  // Normalise for comparison only. The value we hand back is always the
  // store's own entry, so a caller can't smuggle a path through by dressing
  // it up as an equivalent-but-different string.
  const wanted = resolve(input);

  const memo = resolvedCache.get(wanted);
  if (memo && Date.now() - memo.at < CACHE_TTL_MS) return memo.value;

  const accept = (value: string): string => {
    resolvedCache.set(wanted, { value, at: Date.now() });
    return value;
  };

  const cached = await trustedRoots();
  const direct = cached.find((r) => r === wanted);
  if (direct) return accept(direct);

  // Cached list didn't have it — re-read before doing anything expensive or
  // rejecting, so a just-created workspace isn't refused for up to a TTL.
  const fresh = await trustedRoots(true);
  const freshHit = fresh.find((r) => r === wanted);
  if (freshHit) return accept(freshHit);

  // Still a miss: the cwd may be an SDK-created worktree. Its location is
  // git's choice, not ours, so ask git rather than pattern-matching a path.
  //
  // This spawns a subprocess per root, and it is the path an *unrecognised*
  // cwd takes — i.e. exactly what a hostile caller can trigger at will. The
  // per-root cache keeps that bounded to one `git worktree list` per root per
  // TTL no matter how many bogus requests arrive.
  for (const root of fresh) {
    const worktrees = await cachedWorktrees(root);
    const match = worktrees.find((w) => typeof w === "string" && w === wanted);
    if (match) return accept(match);
  }

  return null;
}

const worktreeCache = new Map<string, { paths: string[]; at: number }>();

async function cachedWorktrees(root: string): Promise<string[]> {
  const hit = worktreeCache.get(root);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.paths;
  const listed = await listWorktrees(root).catch(() => []);
  const paths = listed
    .filter((w): w is typeof w & { path: string } => typeof w.path === "string")
    .map((w) => resolve(w.path));
  worktreeCache.set(root, { paths, at: Date.now() });
  return paths;
}

/** Test seam: drops the memoised roots/resolutions. */
export function __resetTrustedCwdCache(): void {
  rootsCache = null;
  inflightRoots = null;
  resolvedCache.clear();
  worktreeCache.clear();
}
