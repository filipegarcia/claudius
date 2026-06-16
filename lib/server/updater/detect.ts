import {
  aheadBehind,
  currentBranch,
  fetch,
  hasConflicts,
  headSha,
  isDirty,
  isGitCheckout,
  recentCommits,
  revParse,
  UpdaterGitError,
} from "./git";
import {
  getUpdaterSettings,
  patchUpdaterState,
  setUpdaterStatus,
  type UpdaterPending,
} from "./settings";
import { installRoot } from "./root";

export type CheckResult =
  | { kind: "up-to-date"; sha: string; branch: string }
  | { kind: "update-available"; pending: UpdaterPending }
  | { kind: "skipped"; reason: string }
  | { kind: "error"; message: string };

/**
 * Single-flight guard. Two callers can race: the boot tick and the daily
 * timer (or a manual UI click). Without this, both might fetch concurrently
 * and clobber each other's state writes.
 */
let inflight: Promise<CheckResult> | null = null;

export function checkForUpdates(): Promise<CheckResult> {
  if (inflight) return inflight;
  inflight = runCheck().finally(() => {
    inflight = null;
  });
  return inflight;
}

async function runCheck(): Promise<CheckResult> {
  const root = installRoot();
  if (!(await isGitCheckout(root))) {
    return { kind: "skipped", reason: "install is not a git checkout" };
  }
  const settings = await getUpdaterSettings();
  if (settings.mode === "disabled") {
    return { kind: "skipped", reason: "updater disabled in settings" };
  }
  await setUpdaterStatus({ kind: "checking", startedAt: Date.now() });
  try {
    const localBranch = await currentBranch(root);
    if (!localBranch) {
      const result: CheckResult = {
        kind: "skipped",
        reason: "HEAD is detached — manual checkout needed",
      };
      await patchUpdaterState({
        lastCheckAt: Date.now(),
        lastError: result.reason,
        status: { kind: "idle" },
      });
      return result;
    }

    try {
      await fetch(root, settings.remote, settings.branch);
    } catch (err) {
      const msg = err instanceof UpdaterGitError ? (err.stderr || err.message) : String(err);
      await patchUpdaterState({
        lastCheckAt: Date.now(),
        lastError: `fetch failed: ${msg.trim()}`,
        status: { kind: "idle" },
      });
      return { kind: "error", message: msg };
    }

    const upstreamRef = `${settings.remote}/${settings.branch}`;
    const localSha = await headSha(root);
    const remoteSha = await revParse(root, upstreamRef);

    const dirty = await isDirty(root);
    // The conflict-clear signal is `hasConflicts` — unmerged index entries OR
    // conflict markers still sitting in tracked file content. We deliberately
    // do NOT use !dirty (a tree dirty with the user's legitimately-restored
    // customizations is the normal post-stash-ff state and must not block).
    // We also do NOT use index-only checks: markers can linger in file content
    // (e.g. round-tripped through a stash pop) while `git ls-files -u` is empty
    // — clearing the conflict flag there would unblock a `bun install` that
    // then dies on the marker-laden JSON. Falls back to true on error so we
    // never clear a genuine conflict by accident.
    const hasConflict = await hasConflicts(root).catch(() => true);

    if (localSha === remoteSha) {
      // Clear conflicts when there are no unmerged index entries — the user
      // resolved them externally (or the conflict was a false positive).
      //
      // NOTE: do NOT clear `recovery` here. After an install/build failure
      // HEAD is already at upstream, so being up-to-date is the *normal*
      // state while the build is still broken — clearing on it would wipe the
      // recovery affordance on the very next routine check. Recovery is
      // cleared only by a successful apply or a successful process boot (the
      // running build provably works), handled elsewhere.
      await patchUpdaterState({
        lastCheckAt: Date.now(),
        lastError: undefined,
        pending: undefined,
        ...(hasConflict ? {} : { conflicts: undefined }),
        status: { kind: "idle" },
      });
      return { kind: "up-to-date", sha: localSha, branch: localBranch };
    }

    const ab = await aheadBehind(root, "HEAD", upstreamRef);
    const commits = await recentCommits(root, "HEAD", upstreamRef);

    const pending: UpdaterPending = {
      remoteSha,
      ahead: ab.ahead,
      behind: ab.behind,
      dirty,
      branch: localBranch,
      upstreamBranch: upstreamRef,
      recentCommits: commits.length > 0 ? commits : undefined,
    };

    await patchUpdaterState({
      lastCheckAt: Date.now(),
      lastError: undefined,
      pending,
      // Clear conflicts when the tree is free of both unmerged index entries
      // and content markers — even if behind > 0, a clean tree means the user
      // committed their resolution (or it was a false positive). The next
      // apply can proceed.
      ...(hasConflict ? {} : { conflicts: undefined }),
      status: { kind: "idle" },
    });

    if (ab.behind === 0) {
      // Ahead-only or diverged-with-no-incoming-commits → nothing to pull.
      return { kind: "up-to-date", sha: localSha, branch: localBranch };
    }

    return { kind: "update-available", pending };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await patchUpdaterState({
      lastCheckAt: Date.now(),
      lastError: msg,
      status: { kind: "idle" },
    });
    return { kind: "error", message: msg };
  }
}
