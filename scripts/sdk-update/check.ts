/**
 * scripts/sdk-update/check.ts
 *
 * Decide, in isolation, whether a new claude-agent-sdk release is out
 * and whether we should kick off an upgrade run for it. This module
 * does no git, no network beyond one npm registry GET, no Claude API
 * calls — it just answers "yes/no, and at what version".
 *
 * It's used in two places:
 *   - as a CLI (`bun scripts/sdk-update/check.ts`), invoked by run.sh
 *     before the heavy orchestration kicks in. Exits 0 if there's
 *     nothing to do, 0 + prints JSON plan if there is, non-zero on
 *     hard errors (network down, malformed package.json).
 *   - imported by orchestrate.ts to read/update the state file
 *     atomically as it walks through the pipeline.
 *
 * State lives in `<repoRoot>/.claudius/sdk-updater/state.json`. The
 * `.claudius/` prefix is already used by claudiusd and is gitignored
 * via .gitignore (the `.claudius/` line) — we piggy-back on that.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync, renameSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// ── Paths ─────────────────────────────────────────────────────────────

/** Repo root — `scripts/sdk-update/check.ts` lives two levels deep. */
export function repoRoot(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return resolve(here, "..", "..");
}

export function stateFilePath(root = repoRoot()): string {
  return resolve(root, ".claudius", "sdk-updater", "state.json");
}

// ── State ─────────────────────────────────────────────────────────────

/**
 * Persistent state across cron firings. Kept deliberately small so a
 * corrupt file is cheap to throw away and rebuild.
 *
 *   lastCheckedAt        UNIX ms of the most recent npm probe.
 *   lastSeenVersion      Newest version we've observed on npm (used to
 *                        debounce duplicate notifications when the
 *                        registry briefly flaps).
 *   lastCompletedVersion The version most recently merged to main /
 *                        announced to the community channel. Empty
 *                        before the first successful run.
 *   inFlight             If non-null, an upgrade is currently being
 *                        worked on by a (possibly already-dead)
 *                        orchestrate.ts. The pidfile + flock in run.sh
 *                        is the real concurrency guard; this field is
 *                        only the human-readable "what's in motion"
 *                        signal.
 *   skipped              Versions we've explicitly decided not to
 *                        attempt (e.g. a > MAX_MINOR_JUMP gap). Avoids
 *                        the runner spamming alerts every hour for
 *                        the same skipped version.
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
  // Write to a sibling tempfile + rename so a crash mid-write can't
  // leave us with a half-JSON state file the next firing has to repair.
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(next, null, 2), "utf8");
  // fs.renameSync is atomic on the same filesystem on POSIX.
  // We don't need the async overhead here — the file is < 1KB.
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

const SDK_NAME = "@anthropic-ai/claude-agent-sdk";
const REGISTRY = "https://registry.npmjs.org";

/** Strip a leading caret/tilde/equals so we can compare numerically. */
export function cleanRange(range: string): string {
  return range.replace(/^[\^~=v]+/, "").trim();
}

export function parseSemver(v: string): [number, number, number] | null {
  const m = cleanRange(v).match(/^(\d+)\.(\d+)\.(\d+)/);
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

export function isNewer(candidate: string, baseline: string): boolean {
  const a = parseSemver(candidate);
  const b = parseSemver(baseline);
  if (!a || !b) return false;
  if (a[0] !== b[0]) return a[0] > b[0];
  if (a[1] !== b[1]) return a[1] > b[1];
  return a[2] > b[2];
}

/**
 * Distance between two versions expressed as the maximum step on
 * the more-significant axis. Used to gate "first cron firing absorbs a
 * year of changes" — operators can set MAX_MINOR_JUMP to skip such
 * mass jumps and ping a human instead.
 */
export function minorJumpDistance(from: string, to: string): number | null {
  const a = parseSemver(from);
  const b = parseSemver(to);
  if (!a || !b) return null;
  if (b[0] > a[0]) return Number.POSITIVE_INFINITY; // any major jump
  return b[1] - a[1];
}

export function readInstalledRange(root = repoRoot()): string {
  const pkg = JSON.parse(
    readFileSync(resolve(root, "package.json"), "utf8"),
  ) as { dependencies?: Record<string, string> };
  const range = pkg.dependencies?.[SDK_NAME];
  if (!range) {
    throw new Error(
      `package.json has no dependencies["${SDK_NAME}"] — refusing to run`,
    );
  }
  return range;
}

export async function fetchLatestVersion(
  signal?: AbortSignal,
): Promise<string> {
  const url = `${REGISTRY}/${encodeURIComponent(SDK_NAME)}/latest`;
  const res = await fetch(url, {
    signal,
    headers: { Accept: "application/json" },
  });
  if (!res.ok) {
    throw new Error(`npm registry returned HTTP ${res.status} for ${url}`);
  }
  const body = (await res.json()) as { version?: string };
  if (typeof body.version !== "string") {
    throw new Error(`npm registry payload missing .version (got ${JSON.stringify(body).slice(0, 200)})`);
  }
  return body.version;
}

// ── Decision ──────────────────────────────────────────────────────────

export type CheckDecision =
  | { kind: "noop"; reason: string; current: string; latest: string }
  | { kind: "in-flight"; version: string; branch: string }
  | { kind: "skip"; reason: string; current: string; latest: string }
  | { kind: "run"; previousVersion: string; newVersion: string };

/**
 * Pure decision logic — given a state snapshot and current/latest
 * versions, return what the runner should do. Doesn't mutate state.
 * Split out so unit tests can drive every branch deterministically.
 */
export function decide(
  state: UpdaterState,
  installedRange: string,
  latest: string,
  opts: { maxMinorJump: number },
): CheckDecision {
  const current = cleanRange(installedRange);

  if (state.inFlight) {
    return {
      kind: "in-flight",
      version: state.inFlight.version,
      branch: state.inFlight.branch,
    };
  }

  if (!isNewer(latest, current)) {
    return {
      kind: "noop",
      reason: "installed range is already at or ahead of latest",
      current,
      latest,
    };
  }

  if (state.lastCompletedVersion && !isNewer(latest, state.lastCompletedVersion)) {
    // We already shipped this version; the human hasn't merged the PR
    // yet so package.json still pins the old range. Don't re-run.
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

  const jump = minorJumpDistance(current, latest);
  if (jump !== null && jump > opts.maxMinorJump) {
    return {
      kind: "skip",
      reason:
        `jump ${current} → ${latest} exceeds MAX_MINOR_JUMP=${opts.maxMinorJump}` +
        ` — pre-bump manually then re-run`,
      current,
      latest,
    };
  }

  return { kind: "run", previousVersion: current, newVersion: latest };
}

// ── CLI ───────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const root = repoRoot();
  const installed = readInstalledRange(root);

  let latest: string;
  try {
    latest = await fetchLatestVersion();
  } catch (err) {
    // Network blip — write the timestamp anyway so the operator can
    // see we tried, but exit non-zero so cron logs the failure.
    patchState({ lastCheckedAt: Date.now() }, root);
    console.error(
      `[sdk-update/check] registry probe failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    process.exit(2);
  }

  const maxMinorJump = Number(process.env.SDK_UPDATE_MAX_MINOR_JUMP ?? "1");
  const state = readState(root);
  const decision = decide(state, installed, latest, { maxMinorJump });

  // Persist what we observed, regardless of action.
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

  // Single JSON line on stdout for run.sh to parse. Human-readable
  // notes go to stderr so they end up in cron logs without polluting
  // the structured channel.
  //
  // Wire format is intentionally FLAT — run.sh's portable sed-based
  // parser (used when `jq` isn't installed on the host) can't walk
  // nested objects. Keep `decision` nested too for any non-shell
  // consumer that wants the full structured form.
  console.error(`[sdk-update/check] installed=${installed} latest=${latest} → ${decision.kind}`);
  if (decision.kind !== "run") {
    console.error(
      `[sdk-update/check] ${"reason" in decision ? decision.reason : ""}`,
    );
  }
  const flat: Record<string, string> = {
    kind: decision.kind,
    installed,
    latest,
  };
  if (decision.kind === "run") {
    flat.previousVersion = decision.previousVersion;
    flat.newVersion = decision.newVersion;
  }
  process.stdout.write(JSON.stringify({ ...flat, decision }) + "\n");
}

// Only run main() when executed directly (not when imported).
// `import.meta.main` is bun-specific; the `process.argv[1]` check is
// the portable fallback so this module is `tsx`/`bun`/`node`-able.
const invokedAsScript =
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (import.meta as any).main === true ||
  (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]));

if (invokedAsScript) {
  main().catch((err) => {
    console.error(`[sdk-update/check] fatal: ${err instanceof Error ? err.stack : String(err)}`);
    process.exit(1);
  });
}
