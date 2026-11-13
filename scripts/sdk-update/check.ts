/**
 * scripts/sdk-update/check.ts
 *
 * Decide, in isolation, whether a new claude-agent-sdk release is out
 * and whether we should kick off an upgrade run for it. This module
 * does no network beyond one npm registry GET and one `git fetch` of
 * origin/main (to read the SDK range main actually ships), no Claude API
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

import { spawnSync } from "node:child_process";
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
  // Trim BEFORE stripping prefix chars: the `^` anchor in the next
  // regex requires the prefix to be the very first character. Without
  // this, a stray space turns "^0.3.0" → "^0.3.0" (no-op) instead of
  // the expected "0.3.0".
  return range.trim().replace(/^[\^~=v]+/, "").trim();
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

// ── Combined SDK+CC PR title (shared producer/parser) ─────────────────
//
// The title of a combined-mode PR is BUILT here by the SDK orchestrator
// (when an SDK bump ships with a cc-parity tag-along) and PARSED back
// here by the cc-parity checker (to notice an open PR already carrying a
// claude-code version, so it defers instead of opening a second PR).
// Producer and parser live in different files; routing BOTH through this
// round-trip-tested pair is what stops them drifting apart silently — a
// hand-formatted title at either site would break the defer with no
// error and no failing test. Never format this string by hand.

/** Marker separating the SDK half of a combined title from the CC half. */
const COMBINED_CC_MARKER = " + claude-code ";

export function buildCombinedPrTitle(args: {
  prevSdkVersion: string;
  newSdkVersion: string;
  prevCcVersion: string;
  newCcVersion: string;
}): string {
  return (
    `chore(deps): bump claude-agent-sdk ${args.prevSdkVersion} → ${args.newSdkVersion}` +
    `${COMBINED_CC_MARKER}${args.prevCcVersion} → ${args.newCcVersion}`
  );
}

/**
 * Inverse of `buildCombinedPrTitle`: pull the shipped claude-code (newCc)
 * version out of a combined PR title, or null if `title` isn't a combined
 * one (an SDK-only title has no marker). Plain string ops (no RegExp)
 * keep this off CodeQL's regex-injection radar.
 */
export function parseCcVersionFromCombinedTitle(title: string): string | null {
  const idx = title.indexOf(COMBINED_CC_MARKER);
  if (idx === -1) return null;
  const seg = title.slice(idx + COMBINED_CC_MARKER.length);
  const parts = seg.split("→");
  if (parts.length < 2) return null;
  const last = parts[parts.length - 1]!.trim();
  return last.length > 0 ? last : null;
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

/**
 * The SDK range `origin/main` depends on (what has actually shipped), not
 * the working tree's. The hourly job runs in the operator's checkout, which
 * can sit on a stale local `main` or a feature branch: on 2026-11-13 it still
 * read `^0.3.322` an hour after #362 merged 0.3.323, so the SDK pipeline
 * "upgraded" to 0.3.323 a second time and opened the junk PR #364. Falls back
 * to the working tree, loudly, when git can't answer (offline, no remote).
 */
export function readMainInstalledRange(
  root = repoRoot(),
  warn: (msg: string) => void = (msg) => console.error(msg),
): string {
  // Best-effort refresh; a failed fetch still leaves the last-known
  // origin/main, which is no staler than the working tree.
  spawnSync("git", ["fetch", "origin", "main", "--quiet"], {
    cwd: root,
    encoding: "utf8",
    timeout: 120_000,
  });
  const show = spawnSync("git", ["show", "origin/main:package.json"], {
    cwd: root,
    encoding: "utf8",
  });
  let why = (show.stderr ?? "").trim() || `git show exited ${show.status}`;
  if (show.status === 0) {
    try {
      const pkg = JSON.parse(show.stdout) as { dependencies?: Record<string, string> };
      const range = pkg.dependencies?.[SDK_NAME];
      if (range) return range;
      why = `no dependencies["${SDK_NAME}"]`;
    } catch (err) {
      why = `unparseable JSON: ${err instanceof Error ? err.message : String(err)}`;
    }
  }
  warn(
    `WARN could not read ${SDK_NAME} from origin/main:package.json (${why}) — ` +
      `falling back to the working tree, which may be stale`,
  );
  return readInstalledRange(root);
}

// ── Claudius's own version ────────────────────────────────────────────

/**
 * The version Claudius should carry once it depends on SDK `sdkVersion`.
 *
 * Claudius's `version` follows the Claude Code release it ships with: SDK
 * 0.3.N goes out alongside Claude Code 2.1.N, and Claudius 0.3.N is built on
 * them. Two rules:
 *   - Never invent a version. It only ever becomes a real SDK version.
 *     cc-parity used to add one to the patch, minting 0.3.320 and 0.3.324,
 *     which no Claude Code release has. The next real SDK release then
 *     reused an already-published version, so installed apps never saw it
 *     as an update.
 *   - Never lower it. A published release can't be taken back, and
 *     electron-updater refuses a lower version, so going down cuts every
 *     install off from updates (PR #364 tried 0.3.324 → 0.3.323).
 * So it's the SDK version when that's newer, otherwise unchanged.
 */
export function syncedClaudiusVersion(current: string, sdkVersion: string): string {
  return isNewer(sdkVersion, current) ? cleanRange(sdkVersion) : current;
}

// First match is the top-level key: it precedes `dependencies`, whose keys
// are package names, never the literal "version".
const TOP_LEVEL_VERSION_RE = /("version"\s*:\s*")([^"]+)(")/;

/**
 * Apply `syncedClaudiusVersion` to `<root>/package.json`. This is the only
 * place either pipeline writes Claudius's version. It's a surgical replace,
 * so the file's formatting is untouched. Reports what it did so callers can
 * skip the release commit when nothing changed.
 */
export function syncClaudiusVersionToSdk(
  sdkVersion: string,
  root = repoRoot(),
): { from: string; to: string; changed: boolean } {
  const pkgPath = resolve(root, "package.json");
  const raw = readFileSync(pkgPath, "utf8");
  const m = raw.match(TOP_LEVEL_VERSION_RE);
  if (!m) {
    throw new Error("failed to read top-level version in package.json — pattern miss");
  }
  const from = m[2]!;
  const to = syncedClaudiusVersion(from, sdkVersion);
  if (to === from) return { from, to, changed: false };
  writeFileSync(pkgPath, raw.replace(TOP_LEVEL_VERSION_RE, `$1${to}$3`), "utf8");
  return { from, to, changed: true };
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
  opts: { maxMinorJump: number; staleInFlightMs?: number; now?: number },
): CheckDecision {
  const current = cleanRange(installedRange);

  if (state.inFlight) {
    // Self-heal stale inFlight markers. Normal failures (commit fails,
    // push fails, gate red) hit the orchestrator's `finally` block and
    // clear inFlight before exit. The only paths that leave it set are
    // SIGKILL, OOM, host reboot, or a terminal-kill of an interactive
    // `make sdk-update-run`. Without self-heal, one such crash would
    // brick the cron forever — every subsequent firing would return
    // `in-flight` and never make progress.
    //
    // The default threshold (24h) is deliberately MUCH longer than the
    // wall-clock budget (default 6h). Within the budget window we
    // genuinely want a second cron firing to back off and let the first
    // finish; beyond 2-4x the budget the original process is dead.
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
  // origin/main, not the working tree: see readMainInstalledRange.
  const installed = readMainInstalledRange(root);

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
  // SDK_UPDATE_LOCK_HELD=1 is set by run.sh, which only reaches this
  // check after acquiring the exclusive flock. Holding that lock proves
  // no orchestrate is alive (a live one would still hold it), so any
  // inFlight marker is stale by construction — reclaim it now
  // (staleInFlightMs=0 makes decide() fall through immediately) rather
  // than wait out the self-heal timer. This deliberately wins over an
  // operator-set SDK_UPDATE_STALE_INFLIGHT_HOURS.
  //
  // SDK_UPDATE_STALE_INFLIGHT_HOURS lets an operator override the
  // self-heal threshold for inFlight markers when the lock is NOT held
  // (e.g. calling check.ts directly). Most won't need to; the 24h
  // default is wide enough for any normal run and short enough that a
  // hard-crashed orchestrator doesn't permanently brick the cron.
  const lockHeld = process.env.SDK_UPDATE_LOCK_HELD === "1";
  const staleHoursRaw = process.env.SDK_UPDATE_STALE_INFLIGHT_HOURS;
  const staleInFlightMs = lockHeld
    ? 0
    : staleHoursRaw
      ? Number(staleHoursRaw) * 60 * 60 * 1000
      : undefined;
  const state = readState(root);
  // Surface self-heal events to the cron log so the operator can see
  // (a) that a crashed run was reclaimed and (b) which version/branch
  // is being abandoned.
  if (state.inFlight) {
    const ageMs = Date.now() - state.inFlight.startedAt;
    const limitMs = staleInFlightMs ?? 24 * 60 * 60 * 1000;
    if (ageMs > limitMs) {
      const why = lockHeld
        ? "lock held, so the prior run is dead"
        : `age ${Math.round(ageMs / 60_000)}min > ${Math.round(limitMs / 60_000)}min`;
      console.error(
        `[sdk-update/check] WARN reclaiming stale inFlight marker ` +
          `(version=${state.inFlight.version} branch=${state.inFlight.branch}; ${why})`,
      );
    }
  }
  const decision = decide(state, installed, latest, { maxMinorJump, staleInFlightMs });

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
