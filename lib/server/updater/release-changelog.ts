import {
  RELEASE_TAG_RE,
  buildReleaseChangelog,
  type ReleaseChangelog,
} from "@/lib/shared/release-changelog";

/**
 * Fetch the commit range between two release tags from GitHub and turn it
 * into a changelog for the desktop update modal.
 *
 * Uses the public, unauthenticated compare API (the repo is public). That is
 * capped at 60 requests/hour per IP, so results are memoised per tag pair:
 * a release range never changes once both tags exist. Failures are cached
 * briefly too, so a modal re-opened in a loop can't burn the quota.
 */

const OWNER = "filipegarcia";
const REPO = "claudius";
const FAILURE_TTL_MS = 5 * 60 * 1000;
const FETCH_TIMEOUT_MS = 8_000;

type CacheEntry =
  | { ok: true; value: ReleaseChangelog }
  | { ok: false; at: number; error: string };

const cache = new Map<string, CacheEntry>();

type CompareResponse = {
  html_url?: string;
  commits?: { sha: string; commit: { message: string }; parents?: unknown[] }[];
};

export async function getReleaseChangelog(
  from: string,
  to: string,
): Promise<{ ok: true; changelog: ReleaseChangelog } | { ok: false; error: string }> {
  // Validated by the route too; re-checked here because these go into a URL.
  if (!RELEASE_TAG_RE.test(from) || !RELEASE_TAG_RE.test(to)) {
    return { ok: false, error: "invalid release tag" };
  }
  const key = `${from}...${to}`;
  const hit = cache.get(key);
  if (hit?.ok) return { ok: true, changelog: hit.value };
  if (hit && !hit.ok && Date.now() - hit.at < FAILURE_TTL_MS) {
    return { ok: false, error: hit.error };
  }

  const fallbackUrl = `https://github.com/${OWNER}/${REPO}/compare/${key}`;
  try {
    const res = await fetch(`https://api.github.com/repos/${OWNER}/${REPO}/compare/${key}`, {
      headers: {
        Accept: "application/vnd.github+json",
        "User-Agent": "claudius-updater",
        "X-GitHub-Api-Version": "2022-11-28",
      },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      cache: "no-store",
    });
    if (!res.ok) {
      // 404 = one of the tags doesn't exist (e.g. a dev build ahead of the
      // last release); 403 = rate limited. Either way: no changelog.
      throw new Error(`GitHub compare returned ${res.status}`);
    }
    const body = (await res.json()) as CompareResponse;
    const commits = (body.commits ?? [])
      // Merge commits carry "Merge pull request …" subjects — never news.
      .filter((c) => (c.parents?.length ?? 1) <= 1)
      .map((c) => ({ sha: c.sha, message: c.commit?.message ?? "" }));
    const changelog = buildReleaseChangelog({
      from,
      to,
      commits,
      compareUrl: body.html_url ?? fallbackUrl,
    });
    cache.set(key, { ok: true, value: changelog });
    return { ok: true, changelog };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    cache.set(key, { ok: false, at: Date.now(), error });
    return { ok: false, error };
  }
}
