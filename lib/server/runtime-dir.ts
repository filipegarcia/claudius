/**
 * Resolves the directory the running Claudius is serving from. This is the
 * "live source" — the tree Next.js compiles. Today it's `process.cwd()` (the
 * cloned repo). When Claudius later ships as a packaged binary / Electron app,
 * the install dir may be read-only; the bootstrap will copy sources into
 * `~/.claude/.claudius/runtime/` once and this resolver will return that
 * instead. Every caller goes through `getLiveSourceDir()` so the swap is a
 * one-line change.
 */

let cached: string | null = null;

export function getLiveSourceDir(): string {
  if (cached) return cached;
  const override = process.env.CLAUDIUS_LIVE_SOURCE?.trim();
  cached = override && override.length > 0 ? override : process.cwd();
  return cached;
}

export function resetLiveSourceDirForTests(): void {
  cached = null;
}
