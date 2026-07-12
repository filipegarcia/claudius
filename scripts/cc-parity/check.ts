/**
 * scripts/cc-parity/check.ts
 *
 * Decide, in isolation, whether a new `@anthropic-ai/claude-code` release
 * is out and whether the cc-parity pipeline should kick off a review run
 * for it. The cc-parity pipeline watches Claude Code (the CLI npm
 * package) for features that DON'T flow through the Agent SDK — see the
 * sibling sdk-update pipeline for the things that do.
 *
 * Like its sibling, this module does no git, no Claude API calls, and
 * only one network call (the npm registry GET for the latest version,
 * plus an optional CHANGELOG fetch used to filter pure bug-fix releases).
 *
 * It's used in two places:
 *   - as a CLI (`bun scripts/cc-parity/check.ts`), invoked by run.sh
 *     before the heavy orchestration kicks in. Exits 0 if there's
 *     nothing to do, 0 + prints JSON plan if there is, non-zero on
 *     hard errors (network down, malformed package.json).
 *   - imported by orchestrate.ts to read/update the state file
 *     atomically as it walks through the pipeline.
 *
 * State lives in `<repoRoot>/.claudius/cc-parity/state.json`. The
 * `.claudius/` prefix is gitignored.
 *
 * KEY DIFFERENCE from sdk-update/check.ts:
 *
 *   Claudius does NOT depend on `@anthropic-ai/claude-code`, so there is
 *   no `package.json` range to compare against. The "current version" is
 *   `state.lastCompletedVersion` (or `state.lastSeenVersion` after the
 *   first probe), seeded on the first ever run with a "no baseline yet"
 *   noop so we don't start a giant catch-up review the first time the
 *   cron fires on a fresh deploy.
 */

import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Reuse the pure semver helpers + repoRoot from the SDK updater so the
// two pipelines can't drift on version comparisons. Everything imported
// here is path-agnostic; the SDK updater's state-file helpers, by
// contrast, point at `.claudius/sdk-updater/` and would clobber our
// state file if we used them — so those are reimplemented below.
import {
  cleanRange,
  isNewer,
  minorJumpDistance,
  parseCcVersionFromCombinedTitle,
  parseSemver,
  repoRoot,
} from "../sdk-update/check";

// Re-export the pure helpers so unit tests can pin them through the
// cc-parity surface without importing the SDK-update module too.
export { cleanRange, isNewer, minorJumpDistance, parseSemver, repoRoot };

// ── Paths ─────────────────────────────────────────────────────────────

export function stateFilePath(root = repoRoot()): string {
  return resolve(root, ".claudius", "cc-parity", "state.json");
}

// ── State ─────────────────────────────────────────────────────────────

/**
 * Persistent state across cron firings. Mirrors the SDK updater's shape
 * but uses `lastCompletedVersion` / `lastSeenVersion` as the version
 * baseline directly — there's no package.json range to fall back on.
 */
export type UpdaterState = {
  lastCheckedAt: number;
  lastSeenVersion: string | null;
  lastCompletedVersion: string | null;
  inFlight: {
    version: string;
    branch: string;
    startedAt: number;
  } | null;
  skipped: Array<{ version: string; reason: string; at: number }>;
};

function defaultState(): UpdaterState {
  return {
    lastCheckedAt: 0,
    lastSeenVersion: null,
    lastCompletedVersion: null,
    inFlight: null,
    skipped: [],
  };
}

export function readState(root = repoRoot()): UpdaterState {
  const path = stateFilePath(root);
  if (!existsSync(path)) return defaultState();
  try {
    const raw = readFileSync(path, "utf8");
    const parsed = JSON.parse(raw) as Partial<UpdaterState>;
    return { ...defaultState(), ...parsed };
  } catch {
    // Corrupt state file — better to start fresh than to crash the
    // cron. The orchestrator will re-detect anything important.
    return defaultState();
  }
}

export function writeState(next: UpdaterState, root = repoRoot()): void {
  const path = stateFilePath(root);
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(next, null, 2), "utf8");
  renameSync(tmp, path);
}

export function patchState(
  patch: Partial<UpdaterState>,
  root = repoRoot(),
): UpdaterState {
  const merged: UpdaterState = { ...readState(root), ...patch };
  writeState(merged, root);
  return merged;
}

// ── Version probing ───────────────────────────────────────────────────

const CC_PKG_NAME = "@anthropic-ai/claude-code";
const REGISTRY = "https://registry.npmjs.org";

export async function fetchLatestVersion(
  signal?: AbortSignal,
): Promise<string> {
  const url = `${REGISTRY}/${encodeURIComponent(CC_PKG_NAME)}/latest`;
  const res = await fetch(url, {
    signal,
    headers: { Accept: "application/json" },
  });
  if (!res.ok) {
    throw new Error(`npm registry returned HTTP ${res.status} for ${url}`);
  }
  const body = (await res.json()) as { version?: string };
  if (typeof body.version !== "string") {
    throw new Error(
      `npm registry payload missing .version (got ${JSON.stringify(body).slice(0, 200)})`,
    );
  }
  return body.version;
}

// ── Changelog fetch (for the bug-fix-only filter) ─────────────────────

const CC_UPSTREAM_GH = "anthropics/claude-code";

/**
 * Best-effort fetch of the upstream CHANGELOG.md slice between the two
 * versions. Returns null on any failure — `decide()` treats null as "no
 * signal" and does NOT apply the bug-fix-only filter, so a missing
 * changelog never silently skips a real release.
 *
 * Goes straight to raw.githubusercontent.com so this module has no `gh`
 * dependency (the orchestrator already has one; check.ts may be invoked
 * stand-alone for smoke-testing).
 */
export async function fetchChangelogSlice(
  prevVersion: string,
  newVersion: string,
  signal?: AbortSignal,
): Promise<string | null> {
  const url = `https://raw.githubusercontent.com/${CC_UPSTREAM_GH}/main/CHANGELOG.md`;
  try {
    const res = await fetch(url, { signal, headers: { Accept: "text/plain" } });
    if (!res.ok) return null;
    const text = await res.text();
    // Lazy import so this module stays useful in environments without the
    // SDK updater present (it shouldn't happen, but the loose coupling is
    // cheap insurance).
    const { sliceChangelog } = await import("../sdk-update/orchestrate");
    return sliceChangelog(text, prevVersion, newVersion);
  } catch {
    return null;
  }
}

// ── Bug-fix-only filter ───────────────────────────────────────────────

/**
 * Return true when every meaningful line in `slice` looks like a bug-fix
 * entry (so the cc-parity reviewer can noop the release). "Meaningful"
 * excludes blank lines and markdown headings (`#`, `##`, etc.).
 *
 * Critical contract for safety: we return true ONLY when there is at
 * least one matched bullet AND every meaningful line matches. An empty
 * slice or a slice with no bullet lines returns false, which falls
 * through to "substantive — run the pipeline". The principle is "don't
 * filter on signal we don't have": if the slice is empty (network blip
 * upstream, slicing miss, etc.), we'd rather burn one review run than
 * silently miss a real release.
 *
 * Exported for unit tests.
 */
export function containsOnlyBugFixEntries(slice: string): boolean {
  const lines = slice.split(/\r?\n/);
  let matchedAny = false;
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    // Skip markdown headings (`# foo`, `## 1.2.3`, etc.).
    if (line.startsWith("#")) continue;
    if (isBugFixLine(line)) {
      matchedAny = true;
      continue;
    }
    return false;
  }
  return matchedAny;
}

function isBugFixLine(line: string): boolean {
  const lc = line.toLowerCase();
  // "Bug fixes and reliability improvements" — the catch-all Anthropic
  // uses for releases with no listable items. Match it anywhere in the
  // line (lists often wrap it in punctuation: `- Bug fixes ...`).
  if (lc.includes("bug fixes and reliability improvements")) return true;
  // Match bullets only: `- bug fix …`, `- bugfix …`, `- fixes …`,
  // `* bug fix …`. The leading bullet keeps us from false-positive
  // matching "fixes" inside an otherwise substantive prose paragraph.
  if (/^[-*]\s*(bug\s*fix|bugfix|fixes\b)/i.test(line)) return true;
  return false;
}

// ── Decision ──────────────────────────────────────────────────────────

export type CheckDecision =
  | { kind: "noop"; reason: string; current: string | null; latest: string }
  | { kind: "in-flight"; version: string; branch: string }
  | { kind: "skip"; reason: string; current: string | null; latest: string }
  | { kind: "run"; previousVersion: string; newVersion: string };

/**
 * Pure decision logic — given a state snapshot and the latest published
 * version, return what the runner should do. Doesn't mutate state.
 *
 * Baseline resolution:
 *   - If `state.lastCompletedVersion` is set, use it (most-recent shipped).
 *   - Else, fall back to `state.lastSeenVersion` (record of the previous
 *     probe).
 *   - If both are null, we're on a fresh deploy: noop with reason
 *     "no baseline yet" and let `main()` patch lastSeenVersion so the
 *     next firing has a starting point.
 *
 * Order matters: the no-baseline noop fires BEFORE the bug-fix-only
 * filter (the filter needs a baseline to compute a slice between).
 */
export function decide(
  state: UpdaterState,
  latest: string,
  opts: {
    maxMinorJump: number;
    staleInFlightMs?: number;
    now?: number;
    /** Pre-fetched CHANGELOG slice between baseline and `latest`. */
    changelogSlice?: string | null;
  },
): CheckDecision {
  // In-flight check fires first regardless of baseline — a half-finished
  // run is the same problem whether or not the baseline is set.
  if (state.inFlight) {
    const staleAfterMs = opts.staleInFlightMs ?? 24 * 60 * 60 * 1000;
    const now = opts.now ?? Date.now();
    const age = now - state.inFlight.startedAt;
    if (age <= staleAfterMs) {
      return {
        kind: "in-flight",
        version: state.inFlight.version,
        branch: state.inFlight.branch,
      };
    }
    // Fall through — caller will overwrite state.inFlight when it
    // starts the new run.
  }

  const baseline = state.lastCompletedVersion ?? state.lastSeenVersion;

  if (!baseline) {
    return {
      kind: "noop",
      reason: "no baseline yet — recording lastSeenVersion",
      current: null,
      latest,
    };
  }

  const current = cleanRange(baseline);

  if (!isNewer(latest, current)) {
    return {
      kind: "noop",
      reason: "baseline is already at or ahead of latest",
      current,
      latest,
    };
  }

  if (
    state.lastCompletedVersion &&
    !isNewer(latest, state.lastCompletedVersion)
  ) {
    return {
      kind: "noop",
      reason: `already completed ${state.lastCompletedVersion} — waiting on merge`,
      current,
      latest,
    };
  }

  if (state.skipped.some((s) => s.version === latest)) {
    return {
      kind: "noop",
      reason: `version ${latest} previously skipped — see state.skipped`,
      current,
      latest,
    };
  }

  // Bug-fix-only filter. Applied AFTER the baseline / completed / skipped
  // checks so it only runs when we actually have a substantive release
  // candidate. The slice is optional — null means "no signal" and we
  // don't filter; see the safety contract in `containsOnlyBugFixEntries`.
  if (
    opts.changelogSlice != null &&
    containsOnlyBugFixEntries(opts.changelogSlice)
  ) {
    return {
      kind: "noop",
      reason: `release ${latest} contains only bug-fix entries — no parity work to do`,
      current,
      latest,
    };
  }

  const jump = minorJumpDistance(current, latest);
  if (jump !== null && jump > opts.maxMinorJump) {
    return {
      kind: "skip",
      reason:
        `jump ${current} → ${latest} exceeds MAX_MINOR_JUMP=${opts.maxMinorJump}` +
        ` — pre-bump baseline manually then re-run`,
      current,
      latest,
    };
  }

  return { kind: "run", previousVersion: current, newVersion: latest };
}

// ── Combined-mode decision (called from the SDK orchestrator) ─────────

/**
 * Opportunistic "should we also run CC parity on this SDK branch?" check.
 *
 * Mirrors `decide()` but trimmed to what the SDK orchestrator actually
 * needs in combined mode:
 *   - no in-flight handling — the SDK orchestrator's own lock + state
 *     guard concurrency; an inFlight CC marker is irrelevant to the
 *     combined path (the SDK pipeline isn't gated on CC's lock and we
 *     deliberately don't write CC's inFlight in combined mode).
 *   - no "skipped" bookkeeping — combined runs don't write CC's
 *     skipped list. A real cc-parity standalone firing will handle
 *     skip semantics on its own next cron tick.
 *   - the bug-fix-only filter reuses `containsOnlyBugFixEntries`.
 *
 * Returns a "noop" decision whenever the SDK orchestrator should ship
 * a SDK-only PR (current behavior); returns "run" with the version
 * pair the SDK orchestrator should hand to `runCcParityOnExistingBranch`.
 */
export function decideCcCombinedRun(args: {
  ccState: UpdaterState;
  ccLatest: string;
  ccChangelogSlice: string | null;
  maxMinorJump: number;
}): { kind: "noop"; reason: string } | { kind: "run"; prevCcVersion: string; newCcVersion: string } {
  const baseline = args.ccState.lastCompletedVersion ?? args.ccState.lastSeenVersion;
  if (!baseline) {
    return { kind: "noop", reason: "cc-parity has no baseline yet — skipping combined run" };
  }
  const current = cleanRange(baseline);

  if (!isNewer(args.ccLatest, current)) {
    return { kind: "noop", reason: "cc-parity baseline is already at or ahead of latest" };
  }

  if (
    args.ccState.lastCompletedVersion &&
    !isNewer(args.ccLatest, args.ccState.lastCompletedVersion)
  ) {
    return {
      kind: "noop",
      reason: `cc-parity already completed ${args.ccState.lastCompletedVersion} — waiting on merge`,
    };
  }

  if (
    args.ccChangelogSlice != null &&
    containsOnlyBugFixEntries(args.ccChangelogSlice)
  ) {
    return {
      kind: "noop",
      reason: `cc-parity release ${args.ccLatest} contains only bug-fix entries — no combined work to do`,
    };
  }

  const jump = minorJumpDistance(current, args.ccLatest);
  if (jump !== null && jump > args.maxMinorJump) {
    return {
      kind: "noop",
      reason:
        `cc-parity jump ${current} → ${args.ccLatest} exceeds maxMinorJump=${args.maxMinorJump} — ` +
        `skipping combined run (standalone cc-parity will surface this on its next tick)`,
    };
  }

  return { kind: "run", prevCcVersion: current, newCcVersion: args.ccLatest };
}

// ── Defer-to-open-combined-PR (standalone path only) ──────────────────

/** One open PR as returned by `gh pr list --json number,headRefName,url,title`. */
export type OpenPrSummary = {
  number: number;
  headRefName: string;
  url: string;
  title: string;
};

/**
 * Pure matcher: find an open COMBINED sdk-update PR whose title already
 * carries this exact claude-code version.
 *
 * Combined PRs are opened by the SDK orchestrator on `sdk-update/<sdk-v>`
 * branches with a title of the form
 *   `chore(deps): bump claude-agent-sdk A → B + claude-code P → <ccVersion>`
 * When such a PR is open, the standalone cc-parity pipeline must NOT open
 * a second PR for the same parity work — the combined PR IS the one PR,
 * and the SDK half re-drives it on each firing until it merges. This is
 * the discovery half of that "defer, don't duplicate" rule.
 *
 * A standalone cc-parity PR (`cc-parity/<v>`) is deliberately NOT matched:
 * that one is this pipeline's OWN branch, reused in place via `gh`'s
 * `--head` idempotency — deferring to it would deadlock the pipeline
 * against itself.
 */
export function pickCombinedPrCarryingCc(
  prs: OpenPrSummary[],
  ccVersion: string,
): OpenPrSummary | null {
  for (const p of prs) {
    if (!p.headRefName.startsWith("sdk-update/")) continue;
    // Parse via the shared inverse of buildCombinedPrTitle so producer and
    // parser can't drift — a title format change breaks the round-trip
    // test in sdk-update, not silently in production.
    if (parseCcVersionFromCombinedTitle(p.title) === ccVersion) return p;
  }
  return null;
}

/**
 * Impure wrapper around `pickCombinedPrCarryingCc`: list open PRs via
 * `gh` and return the combined PR carrying `ccVersion`, if any.
 *
 * Fail-open: if `gh` errors or returns junk we return null ("no combined
 * PR"), matching how the SDK updater's `findOpenSdkUpdatePr` degrades. A
 * flaky `gh` then just falls back to today's behavior rather than
 * stranding real parity work.
 */
function findOpenCombinedPrForCc(ccVersion: string, root: string): OpenPrSummary | null {
  const res = spawnSync(
    "gh",
    ["pr", "list", "--state", "open", "--json", "number,headRefName,url,title", "--limit", "100"],
    { cwd: root, encoding: "utf8" },
  );
  if (res.status !== 0) {
    console.error(
      `[cc-parity/check] findOpenCombinedPrForCc: gh pr list failed (status=${res.status}): ` +
        `${(res.stderr ?? "").trim() || "(no stderr)"} — not deferring`,
    );
    return null;
  }
  let all: OpenPrSummary[];
  try {
    all = JSON.parse(res.stdout || "[]") as OpenPrSummary[];
  } catch (err) {
    console.error(
      `[cc-parity/check] findOpenCombinedPrForCc: could not parse gh output ` +
        `(${err instanceof Error ? err.message : String(err)}) — not deferring`,
    );
    return null;
  }
  return pickCombinedPrCarryingCc(all, ccVersion);
}

// ── CLI ───────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const root = repoRoot();

  let latest: string;
  try {
    latest = await fetchLatestVersion();
  } catch (err) {
    patchState({ lastCheckedAt: Date.now() }, root);
    console.error(
      `[cc-parity/check] registry probe failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    process.exit(2);
  }

  const maxMinorJump = Number(process.env.CC_PARITY_MAX_MINOR_JUMP ?? "1");
  // CC_PARITY_LOCK_HELD=1 is set by run.sh, which only reaches this
  // check after acquiring the exclusive flock. Holding that lock proves
  // no orchestrate is alive, so any inFlight marker is stale by
  // construction — reclaim it now (staleInFlightMs=0 makes decide() fall
  // through immediately) rather than wait out the self-heal timer.
  const lockHeld = process.env.CC_PARITY_LOCK_HELD === "1";
  const staleHoursRaw = process.env.CC_PARITY_STALE_INFLIGHT_HOURS;
  const staleInFlightMs = lockHeld
    ? 0
    : staleHoursRaw
      ? Number(staleHoursRaw) * 60 * 60 * 1000
      : undefined;

  const state = readState(root);

  if (state.inFlight) {
    const ageMs = Date.now() - state.inFlight.startedAt;
    const limitMs = staleInFlightMs ?? 24 * 60 * 60 * 1000;
    if (ageMs > limitMs) {
      const why = lockHeld
        ? "lock held, so the prior run is dead"
        : `age ${Math.round(ageMs / 60_000)}min > ${Math.round(limitMs / 60_000)}min`;
      console.error(
        `[cc-parity/check] WARN reclaiming stale inFlight marker ` +
          `(version=${state.inFlight.version} branch=${state.inFlight.branch}; ${why})`,
      );
    }
  }

  // Fetch the changelog slice up-front so the bug-fix-only filter has
  // something to look at. Only relevant when we actually have a
  // baseline; on a fresh deploy decide() will short-circuit anyway.
  let changelogSlice: string | null = null;
  const baseline = state.lastCompletedVersion ?? state.lastSeenVersion;
  if (baseline) {
    const prev = cleanRange(baseline);
    if (isNewer(latest, prev)) {
      changelogSlice = await fetchChangelogSlice(prev, latest);
      if (changelogSlice === null) {
        console.error(
          `[cc-parity/check] WARN could not fetch CHANGELOG slice for ` +
            `${prev}…${latest} — falling through without the bug-fix filter`,
        );
      }
    }
  }

  const decision = decide(state, latest, {
    maxMinorJump,
    staleInFlightMs,
    changelogSlice,
  });

  // Persist what we observed, regardless of action. The first-run noop
  // path records lastSeenVersion = latest here so the NEXT firing has
  // a baseline; otherwise we'd stay in the no-baseline branch forever.
  const nextSkipped =
    decision.kind === "skip"
      ? [
          ...state.skipped.filter((s) => s.version !== latest),
          { version: latest, reason: decision.reason, at: Date.now() },
        ]
      : state.skipped;
  patchState(
    {
      lastCheckedAt: Date.now(),
      lastSeenVersion: latest,
      skipped: nextSkipped,
    },
    root,
  );

  // Defer to an already-open COMBINED PR. When a combined SDK+CC PR is
  // still open carrying this exact claude-code version — e.g. the combined
  // run shipped locally but its CI stayed red, leaving cc-parity state
  // un-advanced (the orchestrator's "failure" mode writes no ccPatch) —
  // opening a standalone cc-parity PR here would create a SECOND PR for the
  // same parity work. Instead noop: the SDK half re-drives the combined PR
  // on every firing (its decide() keeps returning "run" until the PR
  // merges), so the same PR is updated in place rather than duplicated.
  // Only relevant on a "run" decision; the probe is skipped otherwise.
  let emitted: CheckDecision = decision;
  if (decision.kind === "run") {
    const combinedPr = findOpenCombinedPrForCc(decision.newVersion, root);
    if (combinedPr) {
      emitted = {
        kind: "noop",
        reason:
          `claude-code ${decision.newVersion} is already carried by open combined PR ` +
          `#${combinedPr.number} (${combinedPr.headRefName}) — deferring so the combined ` +
          `PR is updated in place instead of opening a second cc-parity PR`,
        current: baseline ? cleanRange(baseline) : null,
        latest,
      };
    }
  }

  console.error(
    `[cc-parity/check] baseline=${baseline ?? "(none)"} latest=${latest} → ${emitted.kind}`,
  );
  if (emitted.kind !== "run") {
    console.error(
      `[cc-parity/check] ${"reason" in emitted ? emitted.reason : ""}`,
    );
  }
  const flat: Record<string, string> = {
    kind: emitted.kind,
    latest,
  };
  if (baseline) flat.baseline = cleanRange(baseline);
  if (emitted.kind === "run") {
    flat.previousVersion = emitted.previousVersion;
    flat.newVersion = emitted.newVersion;
  }
  process.stdout.write(JSON.stringify({ ...flat, decision: emitted }) + "\n");
}

// Only run main() when executed directly (not when imported).
const invokedAsScript =
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (import.meta as any).main === true ||
  (process.argv[1] &&
    fileURLToPath(import.meta.url) === resolve(process.argv[1]));

if (invokedAsScript) {
  main().catch((err) => {
    console.error(
      `[cc-parity/check] fatal: ${err instanceof Error ? err.stack : String(err)}`,
    );
    process.exit(1);
  });
}
