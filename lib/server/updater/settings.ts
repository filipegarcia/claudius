import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/**
 * Self-update configuration and state.
 *
 * Lives at `~/.claude/.claudius/updater.json` so it's install-wide (one
 * Claudius checkout = one updater config) rather than per-workspace.
 *
 * `mode` controls what auto-update is allowed to do without user input:
 *
 *   - "cc-merge"    Default. Auto-apply fast-forward updates. When the
 *                   working tree is dirty or the upstream branch has
 *                   diverged, spawn a Claude Code session to resolve the
 *                   merge and re-apply customizations. Best for users who
 *                   have published customizations — those edits live in the
 *                   working tree, so a plain `git pull --ff-only` would be
 *                   blocked. Costs API credits each time it triggers.
 *
 *   - "ff-only"     Auto-apply only when the pull is a clean fast-forward.
 *                   Dirty trees and divergent branches are skipped with a
 *                   "manual update needed" notice in the UI.
 *
 *   - "notify-only" Never auto-apply. Background check still runs and
 *                   surfaces a banner; user clicks "Update now" to apply.
 *
 *   - "disabled"    No background checks at all.
 */

export type UpdaterMode = "cc-merge" | "ff-only" | "notify-only" | "disabled";

export type UpdaterSettings = {
  mode: UpdaterMode;
  /** Git remote name. Defaults to "origin". */
  remote: string;
  /**
   * Branch to track. Defaults to "main". If the local checkout is on a
   * different branch, the updater treats it as user-driven and skips
   * (unless mode is "cc-merge", which will still try to reconcile).
   */
  branch: string;
  /** How often to re-check in the background, in hours. Default 24. */
  intervalHours: number;
};

export type UpdaterPending = {
  remoteSha: string;
  /** Commits ahead of remote (local has but remote doesn't). */
  ahead: number;
  /** Commits behind remote (remote has but local doesn't). */
  behind: number;
  dirty: boolean;
  branch: string;
  upstreamBranch: string;
  /** Short subject lines for the incoming commits, newest-first, capped. */
  recentCommits?: string[];
};

export type UpdaterStatus =
  | { kind: "idle" }
  | { kind: "checking"; startedAt: number }
  | { kind: "applying"; startedAt: number; strategy: "ff-only" | "stash-ff" | "cc-merge" }
  | { kind: "restarting"; startedAt: number };

/**
 * Recorded when an apply succeeded at the git level (HEAD is at upstream)
 * but the working tree has been left with merge conflict markers — typically
 * a `git stash pop` collision after the stash-ff strategy. The user must
 * resolve before install/build/restart can finish. Survives restarts so the
 * banner persists and the "Resolve with Claude Code" button stays available
 * until conflicts are cleared (by a subsequent check seeing a clean tree).
 */
export type UpdaterConflicts = {
  /** SHA the tree was advanced to before conflicts blocked the rest of apply. */
  toSha: string;
  /** SHA before the apply started — useful for "show me the diff" hints. */
  fromSha: string;
  detectedAt: number;
  /** Origin of the conflict: which strategy produced it. */
  origin: "stash-ff" | "cc-merge";
  /** One-line human-readable summary (e.g. the conflict marker filenames). */
  detail: string;
};

/**
 * Recorded when an apply got past the git step (HEAD is at upstream) but the
 * dependency install or the Next build failed — e.g. `bun install` couldn't
 * compile a native module, or `bun run build` hit a real build error. Unlike
 * a plain transient error, this is RECOVERABLE: the new code is already in the
 * tree, so we leave it there (no rollback) and surface the same "Resolve with
 * Claude Code" action the conflict flow uses. Survives restarts so the
 * affordance persists until the update actually finishes. Cleared on the next
 * successful apply, or on a successful process boot (a build that boots works).
 */
export type UpdaterRecovery = {
  /** Which phase blew up. */
  phase: "install" | "build";
  /** SHA the tree is sitting at (upstream) — the build target. */
  toSha: string;
  /** SHA before the apply started. */
  fromSha: string;
  detectedAt: number;
  /** Captured failure tail (stderr / message) so Claude has the real error. */
  detail: string;
};

export type UpdaterState = {
  /** Last time we ran a remote check (success or failure). */
  lastCheckAt?: number;
  /** Last time we successfully applied an update. */
  lastUpdateAt?: number;
  /** SHA we were on after the last successful apply. */
  lastUpdateSha?: string;
  /** Last error from check or apply, surfaced in the UI. */
  lastError?: string;
  /** Pending update detected by the most recent successful check. */
  pending?: UpdaterPending;
  /**
   * Working-tree conflicts left over from a partially-applied update. The UI
   * surfaces a "Resolve with Claude Code" action while this is set; cleared
   * once the next check sees a clean tree at or past `toSha`.
   */
  conflicts?: UpdaterConflicts;
  /**
   * Recoverable install/build failure left over from a partially-applied
   * update. The UI surfaces a "Resolve with Claude Code" + "Retry" action
   * while this is set; cleared on the next successful apply or once a check
   * sees the install root up-to-date.
   */
  recovery?: UpdaterRecovery;
  /** Current in-flight operation, if any. */
  status: UpdaterStatus;
};

export type UpdaterFile = UpdaterSettings & {
  state: UpdaterState;
};

const DEFAULT_SETTINGS: UpdaterSettings = {
  mode: "cc-merge",
  remote: "origin",
  branch: "main",
  intervalHours: 24,
};

const SETTINGS_PATH = join(
  homedir(),
  ".claude",
  ".claudius",
  "updater.json",
);

function defaultFile(): UpdaterFile {
  return { ...DEFAULT_SETTINGS, state: { status: { kind: "idle" } } };
}

function isMode(v: unknown): v is UpdaterMode {
  return v === "cc-merge" || v === "ff-only" || v === "notify-only" || v === "disabled";
}

function normalize(parsed: Partial<UpdaterFile> | null | undefined): UpdaterFile {
  const base = defaultFile();
  if (!parsed || typeof parsed !== "object") return base;
  const mode = isMode(parsed.mode) ? parsed.mode : base.mode;
  const remote =
    typeof parsed.remote === "string" && parsed.remote.trim() ? parsed.remote : base.remote;
  const branch =
    typeof parsed.branch === "string" && parsed.branch.trim() ? parsed.branch : base.branch;
  const intervalHours =
    typeof parsed.intervalHours === "number" &&
    Number.isFinite(parsed.intervalHours) &&
    parsed.intervalHours > 0
      ? parsed.intervalHours
      : base.intervalHours;
  const stateIn = (parsed.state ?? {}) as Partial<UpdaterState>;
  const state: UpdaterState = {
    lastCheckAt: typeof stateIn.lastCheckAt === "number" ? stateIn.lastCheckAt : undefined,
    lastUpdateAt: typeof stateIn.lastUpdateAt === "number" ? stateIn.lastUpdateAt : undefined,
    lastUpdateSha: typeof stateIn.lastUpdateSha === "string" ? stateIn.lastUpdateSha : undefined,
    lastError: typeof stateIn.lastError === "string" ? stateIn.lastError : undefined,
    pending: stateIn.pending && typeof stateIn.pending === "object" ? stateIn.pending : undefined,
    conflicts:
      stateIn.conflicts && typeof stateIn.conflicts === "object" ? stateIn.conflicts : undefined,
    recovery:
      stateIn.recovery && typeof stateIn.recovery === "object" ? stateIn.recovery : undefined,
    status:
      stateIn.status && typeof stateIn.status === "object" && "kind" in stateIn.status
        ? (stateIn.status as UpdaterStatus)
        : { kind: "idle" },
  };
  // Don't restore an in-flight status across restarts — if we crashed mid-apply,
  // surface as idle so the next check can re-trigger cleanly.
  if (state.status.kind !== "idle") state.status = { kind: "idle" };
  return { mode, remote, branch, intervalHours, state };
}

export async function readUpdaterFile(): Promise<UpdaterFile> {
  try {
    const raw = await fs.readFile(SETTINGS_PATH, "utf8");
    const parsed = JSON.parse(raw) as Partial<UpdaterFile>;
    return normalize(parsed);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return defaultFile();
    // Bad JSON: don't blow up, just fall back to defaults so the app boots.
    console.warn("[updater] settings file unreadable, using defaults:", err);
    return defaultFile();
  }
}

async function writeUpdaterFile(file: UpdaterFile): Promise<void> {
  await fs.mkdir(dirname(SETTINGS_PATH), { recursive: true });
  await fs.writeFile(SETTINGS_PATH, JSON.stringify(file, null, 2) + "\n", "utf8");
}

export async function getUpdaterSettings(): Promise<UpdaterSettings> {
  const f = await readUpdaterFile();
  return { mode: f.mode, remote: f.remote, branch: f.branch, intervalHours: f.intervalHours };
}

export async function getUpdaterState(): Promise<UpdaterState> {
  const f = await readUpdaterFile();
  return f.state;
}

export async function patchUpdaterSettings(
  patch: Partial<UpdaterSettings>,
): Promise<UpdaterSettings> {
  const cur = await readUpdaterFile();
  const next: UpdaterFile = {
    ...cur,
    ...(patch.mode !== undefined && isMode(patch.mode) ? { mode: patch.mode } : {}),
    ...(typeof patch.remote === "string" && patch.remote.trim() ? { remote: patch.remote } : {}),
    ...(typeof patch.branch === "string" && patch.branch.trim() ? { branch: patch.branch } : {}),
    ...(typeof patch.intervalHours === "number" &&
    Number.isFinite(patch.intervalHours) &&
    patch.intervalHours > 0
      ? { intervalHours: patch.intervalHours }
      : {}),
  };
  await writeUpdaterFile(next);
  return { mode: next.mode, remote: next.remote, branch: next.branch, intervalHours: next.intervalHours };
}

export async function patchUpdaterState(patch: Partial<UpdaterState>): Promise<UpdaterState> {
  const cur = await readUpdaterFile();
  const state: UpdaterState = { ...cur.state, ...patch };
  await writeUpdaterFile({ ...cur, state });
  return state;
}

export async function setUpdaterStatus(status: UpdaterStatus): Promise<void> {
  await patchUpdaterState({ status });
}

export async function clearUpdaterPending(): Promise<void> {
  await patchUpdaterState({ pending: undefined });
}

export async function clearUpdaterConflicts(): Promise<void> {
  await patchUpdaterState({ conflicts: undefined });
}

export const updaterSettingsPath = SETTINGS_PATH;
