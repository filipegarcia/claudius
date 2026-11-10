/**
 * Turn the commits between two release tags into a user-facing changelog.
 *
 * Claudius' GitHub Releases are published with an empty body — the release
 * pipeline attaches artifacts but never writes notes — so the update modal
 * builds its "What's new" list from the commit range instead
 * (`GET /repos/:owner/:repo/compare/:from...:to`). The history follows
 * Conventional Commits, which gives us enough structure to keep only the
 * changes a user would notice:
 *
 *   feat            → "New"
 *   fix             → "Fixes"
 *   perf / refactor → "Improvements"
 *
 * Everything else (docs, test, chore, ci, build, wip, merges, release bumps)
 * is internal and dropped — and so is a feat/fix whose SCOPE is the release
 * machinery itself (`fix(release): …`, `feat(update-pipeline): …`): real
 * commits, but nothing a user of the app would notice. `total` still counts
 * every commit so the UI can say "and N internal changes" / link to the full
 * compare view.
 *
 * Pure and dependency-free so it runs in both the route handler and unit tests.
 */

export type ChangelogGroupKey = "feat" | "fix" | "improve";

export type ChangelogEntry = {
  /** Conventional-commit scope, e.g. `composer` in `fix(composer): …`. */
  scope: string | null;
  /** The subject with the type/scope prefix and parity suffix stripped. */
  text: string;
  /** Short SHA, for linking/keys. */
  sha: string;
};

export type ChangelogGroup = {
  key: ChangelogGroupKey;
  title: string;
  entries: ChangelogEntry[];
};

export type ReleaseChangelog = {
  from: string;
  to: string;
  /** Commits in the range, including the internal ones we hide. */
  total: number;
  groups: ChangelogGroup[];
  /** GitHub compare page for the full, unfiltered range. */
  compareUrl: string;
};

const GROUP_TITLES: Record<ChangelogGroupKey, string> = {
  feat: "New",
  fix: "Fixes",
  improve: "Improvements",
};
const GROUP_ORDER: ChangelogGroupKey[] = ["feat", "fix", "improve"];

const TYPE_TO_GROUP: Record<string, ChangelogGroupKey> = {
  feat: "feat",
  fix: "fix",
  perf: "improve",
  refactor: "improve",
};

/**
 * Scopes that name the build / release / test pipeline rather than the app.
 * Matched case-insensitively against the whole scope. `sdk-update` and
 * `security` are deliberately NOT here: SDK-bump commits usually ship new
 * settings or UI, and security fixes are worth telling users about.
 */
const INTERNAL_SCOPES = new Set([
  "ci",
  "e2e",
  "release",
  "releases",
  "test",
  "tests",
  "update-pipeline",
]);

/** `type(scope)!: subject` — scope and `!` optional. */
const CONVENTIONAL_RE = /^(\w+)(?:\(([^)]*)\))?!?:\s*(.+)$/;
/**
 * Trailing Claude Code parity markers, e.g. `(CC 2.1.300)`,
 * `(CC 2.1.299 parity)`, `(CC 2.1.300 review)`. Useful to us, noise to a user.
 */
const PARITY_SUFFIX_RE = /\s*\(CC \d+(?:\.\d+)*(?: [a-z ]+)?\)\s*$/i;

/** Release tags look like `v0.3.298.0` (SDK semver + per-release counter). */
export const RELEASE_TAG_RE = /^v\d{1,4}\.\d{1,4}\.\d{1,4}(?:\.\d{1,4})?$/;

export function toReleaseTag(version: string): string | null {
  const tag = version.startsWith("v") ? version : `v${version}`;
  return RELEASE_TAG_RE.test(tag) ? tag : null;
}

/**
 * Classify one commit message. Returns `null` for internal changes that the
 * changelog hides.
 */
export function classifyCommit(
  message: string,
  sha: string,
): { group: ChangelogGroupKey; entry: ChangelogEntry } | null {
  const subject = message.split("\n", 1)[0].trim();
  const m = CONVENTIONAL_RE.exec(subject);
  if (!m) return null;
  const group = TYPE_TO_GROUP[m[1].toLowerCase()];
  if (!group) return null;
  const scope = m[2]?.trim() || null;
  if (scope && INTERNAL_SCOPES.has(scope.toLowerCase())) return null;
  let text = m[3].replace(PARITY_SUFFIX_RE, "").trim();
  if (!text) return null;
  text = text[0].toUpperCase() + text.slice(1);
  return { group, entry: { scope, text, sha: sha.slice(0, 8) } };
}

export function buildReleaseChangelog(input: {
  from: string;
  to: string;
  commits: { sha: string; message: string }[];
  compareUrl: string;
}): ReleaseChangelog {
  const buckets = new Map<ChangelogGroupKey, ChangelogEntry[]>();
  const seen = new Set<string>();
  // GitHub returns oldest → newest; show newest first, like a changelog.
  for (const c of [...input.commits].reverse()) {
    const hit = classifyCommit(c.message, c.sha);
    if (!hit) continue;
    // Review passes sometimes land the same subject twice — show it once.
    const dedupeKey = `${hit.group}:${hit.entry.scope ?? ""}:${hit.entry.text.toLowerCase()}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    const list = buckets.get(hit.group) ?? [];
    list.push(hit.entry);
    buckets.set(hit.group, list);
  }
  return {
    from: input.from,
    to: input.to,
    total: input.commits.length,
    groups: GROUP_ORDER.filter((k) => buckets.has(k)).map((key) => ({
      key,
      title: GROUP_TITLES[key],
      entries: buckets.get(key)!,
    })),
    compareUrl: input.compareUrl,
  };
}
