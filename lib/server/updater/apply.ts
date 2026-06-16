import { promises as fs } from "node:fs";
import { dirname, join } from "node:path";
import { query, type SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import {
  conflictedFiles,
  hasConflicts,
  hasUnmergedFiles,
  headSha,
  isDirty,
  pullFastForward,
  spawnStreamed,
  stashPop,
  stashPushIncludeUntracked,
  UpdaterGitError,
} from "./git";
import { checkForUpdates } from "./detect";
import { installRoot } from "./root";
import {
  getUpdaterSettings,
  patchUpdaterState,
  readUpdaterFile,
  setUpdaterStatus,
  type UpdaterMode,
  type UpdaterPending,
} from "./settings";
import { triggerRestart, type RestartResult } from "./restart";

export type ApplyOutcome =
  | {
      kind: "applied";
      strategy: "ff-only" | "stash-ff" | "cc-merge";
      fromSha: string;
      toSha: string;
      restart: RestartResult;
    }
  | { kind: "no-update" }
  | { kind: "skipped"; reason: string }
  | {
      kind: "conflicts";
      origin: "stash-ff" | "cc-merge";
      fromSha: string;
      toSha: string;
      detail: string;
    }
  | { kind: "error"; message: string; phase: ApplyPhase };

type ApplyPhase = "detect" | "pull" | "merge" | "install" | "build" | "restart" | "init";

const APPLY_LOG = (root: string) => join(root, ".claudius", "logs", "updater.log");

let applying: Promise<ApplyOutcome> | null = null;

/**
 * Single-flight: applying must never overlap. The boot path, the daily
 * timer, and the manual UI button can all call this; only one runs.
 */
export function applyUpdate(opts: { allowCcMerge?: boolean } = {}): Promise<ApplyOutcome> {
  if (applying) return applying;
  applying = runApply(opts).finally(() => {
    applying = null;
  });
  return applying;
}

async function runApply(opts: { allowCcMerge?: boolean }): Promise<ApplyOutcome> {
  const root = installRoot();
  const settings = await getUpdaterSettings();
  if (settings.mode === "disabled") {
    return { kind: "skipped", reason: "updater disabled" };
  }

  const file = await readUpdaterFile();
  // Whether we're allowed to spawn Claude to resolve conflicts unattended:
  // the cc-merge mode, or a manual "Update now" / "Let Claude resolve" click
  // (which sets allowCcMerge). The override is named historically but in
  // practice means "the user explicitly asked to apply".
  const allow = settings.mode === "cc-merge" || (opts.allowCcMerge ?? false);

  // Is there an UNFINISHED update to resume? A prior run can advance HEAD to
  // upstream but fail to complete — leaving conflict markers in the tree, an
  // unmerged index, or a failed install/build (recorded as `recovery`). The
  // recorded flags can also be wiped out from under us: `recovery` is cleared
  // on every clean boot (the live build serves) even though the install never
  // actually finished, so the only durable evidence is the tree itself. We
  // therefore treat a tree that physically carries conflict markers as
  // unfinished regardless of the recorded flags. In every one of these cases
  // the fix is identical and MUST be automatic — heal markers inline (no new
  // workspace) and finish install/build/restart. Never strand the user at a
  // half-applied update, and never hand a conflicted tree to `bun install`.
  const treeConflicted = await hasConflicts(root);
  const recordedUnfinished = !!file.state.conflicts || !!file.state.recovery;
  const resumeOrigin: "stash-ff" | "cc-merge" = file.state.conflicts?.origin ?? "cc-merge";
  const recordedFromSha = file.state.conflicts?.fromSha ?? file.state.recovery?.fromSha;

  // Strategy for a FRESH pull, decided below. Stays `skip` for a pure resume
  // (HEAD already at upstream — nothing to pull). The catch block reads
  // `strategy.kind`, so it must stay in scope.
  let strategy: Strategy = { kind: "skip", reason: "resume" };
  let fromSha = recordedFromSha ?? (await headSha(root));
  // Reported in the "applied" outcome + the native-rebuild diff base.
  let appliedStrategy: "ff-only" | "stash-ff" | "cc-merge" = resumeOrigin;
  // ff-only is the only path where the upstream lockfile is canonical and a
  // frozen install is correct; every other path (merge/resume) may have a
  // touched manifest, so install unfrozen.
  let installFrozen = false;

  try {
    // 1) HEAL FIRST. Clear any conflict markers already in the tree before we
    //    touch git or bun. If we can't (mode disallows Claude, or resolution
    //    failed), surface the resolve action instead of proceeding.
    if (treeConflicted) {
      const healed = await healConflicts(root, fromSha, resumeOrigin, allow);
      if (healed.kind === "conflicts") {
        return allow
          ? healed.outcome
          : { kind: "skipped", reason: "previous update left conflicts — resolve them first" };
      }
    } else if (file.state.conflicts) {
      // Recorded conflicts but the tree is actually clean (resolved externally,
      // or a stale "file already exists" false positive). Clear the record.
      await patchUpdaterState({ conflicts: undefined });
    }

    // 2) PULL fresh upstream commits, if any. We always re-check so we act on a
    //    current diff, not the hours-old cached `pending`.
    const check = await checkForUpdates();
    const canFinishLocally = treeConflicted || recordedUnfinished;
    if (check.kind === "error") {
      // A network/check failure is only fatal when there's nothing to finish
      // locally. If we have unfinished work at HEAD, proceed to finish it —
      // install/build/restart need no network.
      if (!canFinishLocally) return { kind: "error", message: check.message, phase: "detect" };
    } else if (check.kind === "skipped") {
      if (!canFinishLocally) return { kind: "skipped", reason: check.reason };
    } else if (check.kind === "up-to-date") {
      if (!canFinishLocally) return { kind: "no-update" };
      // HEAD already at upstream but unfinished — fall through to finish it.
    } else {
      // update-available — choose and run a pull/merge strategy.
      const pending = check.pending;
      fromSha = await headSha(root);
      strategy = pickStrategy(settings.mode, pending, opts.allowCcMerge ?? false);
      if (strategy.kind === "skip") {
        // Can't pull (diverged in ff-only, notify-only without override, …).
        // If there's unfinished local work, still finish the current HEAD;
        // otherwise skip cleanly.
        if (!canFinishLocally) return { kind: "skipped", reason: strategy.reason };
      } else {
        appliedStrategy = strategy.kind;
        installFrozen = strategy.kind === "ff-only";
        await setUpdaterStatus({ kind: "applying", startedAt: Date.now(), strategy: strategy.kind });
        await appendLog(
          root,
          `\n=== ${new Date().toISOString()} apply (${strategy.kind}) from ${fromSha.slice(0, 7)} → ${pending.remoteSha.slice(0, 7)} ===\n`,
        );

        if (strategy.kind === "ff-only") {
          await runFastForward(root, settings.remote, settings.branch);
        } else if (strategy.kind === "stash-ff") {
          const result = await runStashFastForward(root, settings.remote, settings.branch);
          if (result.kind === "conflicts") {
            // HEAD is at upstream; the pop left markers. Don't dead-end — the
            // shared safety net below heals them inline (no new workspace) or
            // surfaces the resolve action. We never `git reset --hard` over the
            // user's popped-back edits; install/build only run on a clean tree.
            await appendLog(root, `stash-ff: pop conflicts — ${result.detail}\n`);
          }
        } else {
          // strategy.kind === "cc-merge"
          const ok = await runCcMerge(root, pending, settings.remote);
          if (!ok.ok) {
            // If the agent left the tree dirty after touching HEAD, surface as
            // conflicts (resolve button) rather than a plain error. Otherwise
            // it's an ordinary merge-phase failure.
            const dirty = await isDirty(root);
            const movedHead = (await headSha(root)) !== fromSha;
            if (dirty && movedHead) {
              await appendLog(root, `cc-merge: left dirty — ${ok.error}\n`);
              return (await recordConflicts(root, fromSha, "cc-merge", ok.error)).outcome;
            }
            await patchUpdaterState({
              lastError: `Claude merge failed: ${ok.error}`,
              status: { kind: "idle" },
            });
            return { kind: "error", message: ok.error, phase: "merge" };
          }
        }
      }
    }

    // 3) Ensure we're flagged as applying (the resume path may not have set it).
    await setUpdaterStatus({ kind: "applying", startedAt: Date.now(), strategy: appliedStrategy });

    // 4) SAFETY NET — the single chokepoint that guarantees we never hand a
    //    conflicted tree to `bun install`. Markers can reach here from a stash
    //    pop that wrote them, a pop that round-tripped pre-existing markers back
    //    into the tree (clean pop, poisoned content), or a cc-merge that left
    //    residue. A marker-laden package.json makes `bun install` die with
    //    "Operators are not allowed in JSON" — the exact bug we're killing, and
    //    one the catch below would misfile as a generic install failure. Heal
    //    inline with Claude when allowed; otherwise surface the resolve action.
    //    A clean ff hits this, finds nothing (two cheap git calls), and falls
    //    straight through.
    {
      // `conflicts.origin` only models the two strategies that can produce
      // markers; a clean ff-only never does, so fold it into "stash-ff".
      const origin = appliedStrategy === "cc-merge" ? "cc-merge" : "stash-ff";
      const guard = await healConflicts(root, fromSha, origin, allow);
      if (guard.kind === "conflicts") return guard.outcome;
    }

    // 5) INSTALL + BUILD + RESTART.
    const installArgs = installFrozen ? ["install", "--frozen-lockfile"] : ["install"];
    // Skip lifecycle scripts (notably better-sqlite3's `node-gyp rebuild`)
    // unless this pull actually changed a native dependency. better-sqlite3
    // is *patched* (patches/better-sqlite3@*.patch edits the C++), so every
    // install with scripts forces a from-source compile — and on the
    // unattended daemon's stripped PATH that node-gyp build is exactly what
    // was failing with `exited with code 7`, dead-ending the whole update.
    // When neither bun.lock nor patches/ moved, the binary already on disk
    // is still valid for the runtime, so the rebuild is pointless; skip it.
    if (!(await nativeBuildAffected(root, fromSha))) {
      installArgs.push("--ignore-scripts");
      await appendLog(root, `install: no native dep change since ${fromSha.slice(0, 7)} — skipping rebuild scripts\n`);
    }
    await runStreamed(root, "bun", installArgs, "install", envForBunPhase("install"));
    await runStreamed(root, "bun", ["run", "build"], "build", envForBunPhase("build"));

    const toSha = await headSha(root);
    await patchUpdaterState({
      lastUpdateAt: Date.now(),
      lastUpdateSha: toSha,
      lastError: undefined,
      pending: undefined,
      conflicts: undefined,
      recovery: undefined,
      status: { kind: "restarting", startedAt: Date.now() },
    });
    await appendLog(root, `apply ok — restarting (was ${fromSha.slice(0, 7)}, now ${toSha.slice(0, 7)})\n`);

    const restart = await triggerRestart();
    return {
      kind: "applied",
      strategy: appliedStrategy,
      fromSha,
      toSha,
      restart,
    };
  } catch (err) {
    const phase = (err as PhaseError).phase ?? "init";
    const msg = err instanceof Error ? err.message : String(err);
    await appendLog(root, `apply failed in ${phase}: ${msg}\n`);

    // Install/build failures are RECOVERABLE, not dead ends. The git step
    // already succeeded (HEAD is at upstream); only `bun install` or
    // `bun run build` failed. Rolling back here would discard the pulled
    // commits and strand the user facing the identical failure on the next
    // attempt with no way forward — which is the exact "this should never
    // happen, ever" trap. Instead, leave the tree advanced, record a
    // recovery entry (the banner then offers "Resolve with Claude Code"),
    // and skip the restart so the currently-running build keeps serving
    // until the user finishes the update. Same recovery UX as a stash-pop
    // conflict.
    if (phase === "install" || phase === "build") {
      const toSha = await headSha(root).catch(() => fromSha);
      await patchUpdaterState({
        lastError: `${phase}: ${msg}`,
        recovery: { phase, fromSha, toSha, detail: msg, detectedAt: Date.now() },
        status: { kind: "idle" },
      });
      await appendLog(root, `${phase} failed — recoverable, tree left at ${toSha.slice(0, 7)}\n`);
      return { kind: "error", message: msg, phase };
    }

    // Roll back the source tree so the install isn't wedged. If we got past
    // the pull/merge, the working tree is now upstream (and possibly with
    // partial install/build artifacts) — the next restart would refuse to
    // start with a half-broken build, leaving the user worse off than
    // before. `git reset --hard $fromSha` restores the exact pre-apply
    // commit; the served `.next/` build is still the old one and keeps
    // working until the user fixes the underlying issue.
    //
    // Stash-ff exception: after a successful pop, the user's edits are
    // back in the working tree as uncommitted changes. A `git reset --hard`
    // would discard them. Skip rollback for that strategy — node_modules
    // might be in a transient state but the running .next/ build keeps
    // serving until the user re-runs install/build manually.
    let rolledBack = false;
    let attemptedRollback = false;
    // install/build failures returned early above (recoverable). What's left
    // here is a merge-phase failure that didn't surface as conflicts — roll
    // that back to the pre-apply commit. stash-ff is never rolled back (it
    // would discard the user's popped-back edits).
    const canRollback = strategy.kind !== "stash-ff" && phase === "merge";
    if (canRollback) {
      attemptedRollback = true;
      try {
        await rollbackTo(root, fromSha);
        rolledBack = true;
        await appendLog(root, `rolled back to ${fromSha.slice(0, 7)}\n`);
      } catch (rbErr) {
        const rbMsg = rbErr instanceof Error ? rbErr.message : String(rbErr);
        await appendLog(root, `rollback failed: ${rbMsg}\n`);
      }
    }
    // If we tried to roll back but couldn't, HEAD may now be at upstream
    // while the cached `pending` still says "N commits behind" — that's a
    // lie. Clear pending so the banner stops showing a misleading diff;
    // the next check will repopulate it accurately.
    const pendingPatch = attemptedRollback && !rolledBack ? { pending: undefined } : {};
    await patchUpdaterState({
      lastError: rolledBack
        ? `${phase}: ${msg} (rolled back to ${fromSha.slice(0, 7)})`
        : `${phase}: ${msg}`,
      status: { kind: "idle" },
      ...pendingPatch,
    });
    return { kind: "error", message: msg, phase };
  }
}

/**
 * Did this pull change anything that requires a native module rebuild? A
 * native addon (better-sqlite3) only needs to be recompiled when its package
 * version moved (captured by `bun.lock`) or its applied patch changed
 * (captured by `patches/`). When neither moved, the compiled binary already on
 * disk is still valid for the runtime and re-running the fragile, toolchain-
 * dependent `node-gyp` build is pointless — so we skip lifecycle scripts.
 *
 * Fail-safe: if we can't compute the diff, assume it changed and run the full
 * install (correctness over speed). A rebuild that then fails routes to the
 * recoverable install-failure path, not a silent stale binary.
 */
async function nativeBuildAffected(root: string, fromSha: string): Promise<boolean> {
  const changed: string[] = [];
  try {
    const code = await spawnStreamed(
      "git",
      // bun.lock (text) is the current format; bun.lockb (binary) is passed
      // too for robustness across bun versions — git ignores a pathspec that
      // matches nothing here.
      ["diff", "--name-only", fromSha, "HEAD", "--", "bun.lock", "bun.lockb", "patches"],
      root,
      (line) => {
        const t = line.trim();
        if (t) changed.push(t);
      },
    );
    if (code !== 0) return true;
  } catch {
    return true;
  }
  return changed.length > 0;
}

async function rollbackTo(root: string, sha: string): Promise<void> {
  // Hard reset is the right call here: anything in the working tree was
  // either upstream-from-pull or merge-resolution from cc-merge. We've
  // already decided this attempt failed, and the user's pre-apply state
  // (whatever customizations they had, etc.) was committed because either
  // (a) they were already in their working tree pre-apply [ff-only path
  // had clean tree, so nothing to lose] or (b) the cc-merge committed them
  // as part of resolving. Either way, fromSha is the safe restore point.
  const { spawnStreamed } = await import("./git");
  const code = await spawnStreamed(
    "git",
    ["reset", "--hard", sha],
    root,
    () => {},
  );
  if (code !== 0) throw new Error(`git reset --hard ${sha} exited ${code}`);
}

type PhaseError = Error & { phase?: ApplyPhase };

function phaseError(phase: ApplyPhase, message: string): PhaseError {
  const e = new Error(message) as PhaseError;
  e.phase = phase;
  return e;
}

type Strategy =
  | { kind: "ff-only" }
  | { kind: "stash-ff" }
  | { kind: "cc-merge" }
  | { kind: "skip"; reason: string };

/** Exported for unit tests — keep in sync with the production caller in `runApply`. */
export function pickStrategy(
  mode: UpdaterMode,
  pending: UpdaterPending,
  allowCcMergeOverride: boolean,
): Strategy {
  // Manual click (allowCcMergeOverride=true) lets the user opt into Claude
  // merge even if their settings are notify-only.
  const wantsCcMerge = mode === "cc-merge" || allowCcMergeOverride;

  const cleanFastForward = !pending.dirty && pending.ahead === 0 && pending.behind > 0;
  if (cleanFastForward) return { kind: "ff-only" };

  // Dirty tree but no local commits ahead → stash, pull --ff-only, pop.
  // The common case for users with published customizations: their edits
  // are uncommitted, but the branch hasn't diverged at the commit level.
  // Deterministic, fast, no LLM spend — and any pop conflicts surface a
  // "Resolve with Claude Code" button. Available in every auto-apply mode
  // (including ff-only) because it's strictly safer than the old "skip
  // when dirty" behavior: a stash pop conflict leaves the user with the
  // exact same files they had before, just in conflicted form.
  const dirtyOnly = pending.dirty && pending.ahead === 0 && pending.behind > 0;
  if (dirtyOnly && (mode === "cc-merge" || mode === "ff-only" || allowCcMergeOverride)) {
    return { kind: "stash-ff" };
  }

  // Diverged at the commit level — stash won't help, and only the LLM path
  // (or a manual `git pull --rebase`) can reconcile.
  if (wantsCcMerge) return { kind: "cc-merge" };

  if (mode === "ff-only") {
    return {
      kind: "skip",
      reason: pending.dirty
        ? "working tree has uncommitted changes — switch to cc-merge mode or apply manually"
        : "branch has diverged from upstream — switch to cc-merge mode or apply manually",
    };
  }

  // notify-only — never auto-apply, never CC-merge unless user clicked.
  return { kind: "skip", reason: "auto-update disabled (notify-only); click 'Update now'" };
}

async function runFastForward(root: string, remote: string, branch: string): Promise<void> {
  try {
    await pullFastForward(root, remote, branch);
  } catch (err) {
    const msg =
      err instanceof UpdaterGitError ? err.stderr.trim() || err.message : String(err);
    throw phaseError("pull", msg);
  }
}

/**
 * Dirty-but-non-diverged fast path. Stash the local edits, fast-forward
 * pull, then pop. Three outcomes:
 *
 *   - applied   — pop succeeded, tree is clean past upstream. Install/build
 *                 proceeds.
 *   - conflicts — pop hit conflict markers. Returned as a structured outcome
 *                 (NOT thrown) so the caller bypasses the install/build/rollback
 *                 path and surfaces the resolve-with-Claude action instead.
 *   - throw     — fetch/pull itself failed (network, FF-refused). The caller's
 *                 standard rollback path handles it; we unstash first so the
 *                 user's edits aren't trapped in the stash list.
 */
async function runStashFastForward(
  root: string,
  remote: string,
  branch: string,
): Promise<{ kind: "applied" } | { kind: "conflicts"; detail: string }> {
  const { stashed } = await stashPushIncludeUntracked(root, "claudius-updater-stash");
  try {
    await pullFastForward(root, remote, branch);
  } catch (err) {
    if (stashed) {
      // Best-effort restore so the user's edits are back in the tree if the
      // pull fails. If the pop itself conflicts here it's surprising (tree
      // was clean), but treat it the same way — leave conflicts in place
      // for the user to inspect.
      try {
        await stashPop(root);
      } catch {
        // Swallow — outer catch in runApply will surface the pull error,
        // and the stash entry is still in the list for manual recovery.
      }
    }
    const msg =
      err instanceof UpdaterGitError ? err.stderr.trim() || err.message : String(err);
    throw phaseError("pull", msg);
  }
  if (!stashed) return { kind: "applied" };
  const pop = await stashPop(root);
  if (pop.ok) return { kind: "applied" };
  return { kind: "conflicts", detail: pop.output };
}

const CC_MERGE_PROMPT = `You are reconciling this Claudius checkout with upstream after the local branch has DIVERGED — there are commits both upstream and locally.

Context: the updater only spawns you for true commit-level divergence. The dirty-working-tree case is handled deterministically (stash → ff pull → pop) elsewhere; if the pop conflicts, the user gets an interactive resolution session, not you. So you should NOT see a "dirty tree, no local commits" state.

Goal: bring the local working tree to a state where:
  1. The latest upstream changes from \`{{remote}}/{{branch}}\` are applied.
  2. Any local edits (published customizations, manual tweaks) that DON'T conflict are preserved.
  3. For real conflicts, prefer the customization intent for visible UI/behavior changes; prefer upstream for bug fixes and dependency bumps. When in doubt, keep both behaviors and resolve sensibly.
  4. \`bun install\` and \`bun run build\` will be run AFTER you finish — your job is to leave a clean, committable tree.

Current state (already verified before invoking you):
  - HEAD is at: {{localSha}}
  - Upstream is at: {{remoteSha}}
  - Working tree dirty: {{dirty}}
  - Local branch: {{branch}}
  - Tracking: {{upstreamRef}}

Approach:
  1. Run \`git status\` and \`git log --oneline HEAD..{{upstreamRef}} | head -30\` plus \`git log --oneline {{upstreamRef}}..HEAD | head -30\` to see both sides of the divergence.
  2. If the tree happens to be dirty, \`git stash push -u -m claudius-updater-stash\` first so the merge starts clean.
  3. \`git merge --no-edit {{upstreamRef}}\`. Resolve any conflict markers using the goals above, \`git add\` resolved files, and complete the merge commit.
  4. If you stashed, \`git stash pop\` and resolve any remaining conflicts.
  5. End with a clean working tree at or ahead of {{upstreamRef}}.

Hard rules:
  - DO NOT \`git push\` anywhere.
  - DO NOT delete \`.claudius/\` or \`.next/\`.
  - DO NOT modify \`.git/config\` or remotes.
  - DO NOT \`git reset --hard\` over uncommitted local work without good reason — leaving the dirty tree is preferable to discarding it silently.
  - If you can't safely resolve, leave the tree as-is, run \`git merge --abort\` (or \`git stash pop\` to restore), and report failure. The user will get an interactive resolution session as the fallback.
  - Bound yourself to ~10 minutes. If you can't converge, abort and report.

Report your final status as one line: either "MERGE_OK" if the tree is clean and HEAD includes upstream, or "MERGE_FAIL: <one-line reason>" if you had to abort.`;

async function runCcMerge(
  root: string,
  pending: UpdaterPending,
  remote: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const localSha = await headSha(root);
  const prompt = CC_MERGE_PROMPT.replaceAll("{{localSha}}", localSha)
    .replaceAll("{{remoteSha}}", pending.remoteSha)
    .replaceAll("{{dirty}}", String(pending.dirty))
    .replaceAll("{{branch}}", pending.branch)
    .replaceAll("{{remote}}", remote)
    .replaceAll("{{upstreamRef}}", pending.upstreamBranch);

  const session = await runClaudeAgent(root, prompt);
  if (!session.ok) return { ok: false, error: session.error };
  const lastText = session.text;

  // Independently verify the merge actually worked — don't trust the model's
  // self-report. The agent is supposed to print MERGE_OK but we check git too.
  if (await isDirty(root)) {
    return { ok: false, error: "working tree still dirty after merge attempt" };
  }
  const newHead = await headSha(root);
  if (newHead === localSha) {
    return { ok: false, error: "HEAD didn't move; merge aborted or made no progress" };
  }
  if (lastText.includes("MERGE_FAIL")) {
    return { ok: false, error: lastText.split("\n")[0] };
  }
  return { ok: true };
}

const CC_RESOLVE_PROMPT = `You are resolving leftover Git conflict markers in a Claudius checkout so an in-progress self-update can finish. HEAD is ALREADY at the upstream commit — do NOT pull, fetch, merge, or reset. Your ONLY job is to clear the conflict markers that are currently sitting in the working tree.

Conflicted files (tracked files that still contain \`<<<<<<<\` / \`=======\` / \`>>>>>>>\` markers):
{{files}}

These markers came from a \`git stash pop\` (or merge) during an automatic update. The "Updated upstream" / "ours" side is upstream; the "Stashed changes" / "theirs" side is the user's local customizations.

Goal: produce a clean, buildable tree with ZERO conflict markers.
  1. Open each conflicted file and resolve EVERY conflict region by hand.
  2. Prefer the customization intent for visible UI/behaviour changes; prefer upstream for bug fixes and dependency bumps. When unsure, keep both behaviours sensibly.
  3. For \`package.json\`: keep upstream's structure and version, but preserve any extra dependencies or scripts the user added. The result MUST be valid JSON (no markers, no trailing commas). For lockfiles (\`bun.lock\`/\`bun.lockb\`), prefer the upstream version wholesale — they are regenerated by \`bun install\` anyway.
  4. After resolving, run \`git diff --check\` — it must report NOTHING. Run \`git status\` to confirm there are no unmerged paths.
  5. \`git add\` the files you resolved so the index has no unmerged entries.

Hard rules:
  - DO NOT \`git push\`, \`git pull\`, \`git fetch\`, \`git merge\`, or \`git reset --hard\`.
  - DO NOT delete \`.claudius/\` or \`.next/\`.
  - DO NOT commit — leaving the resolved customizations as uncommitted changes is correct.
  - \`bun install\` and \`bun run build\` run automatically AFTER you finish; do not run them yourself.

Report one line: "RESOLVE_OK" when every marker is gone and \`git diff --check\` is clean, or "RESOLVE_FAIL: <one-line reason>" if you could not.`;

/**
 * Resolve conflict markers already present in the working tree, inline, via the
 * SDK — NOT a chat workspace. This is the "worst case, a Claude merge happens"
 * path the product promises: rather than dead-ending an update at a marker-laden
 * tree, we hand the existing markers to a bounded Claude session that edits them
 * to a clean state. HEAD is untouched (already at upstream); only file content
 * is resolved. The caller re-verifies with `conflictedFiles` afterwards.
 */
async function runCcConflictResolve(
  root: string,
  files: string[],
): Promise<{ ok: true } | { ok: false; error: string }> {
  const list = files.length > 0 ? files.map((f) => `  - ${f}`).join("\n") : "  (see `git status`)";
  const prompt = CC_RESOLVE_PROMPT.replaceAll("{{files}}", list);
  const session = await runClaudeAgent(root, prompt);
  if (!session.ok) return { ok: false, error: session.error };
  if (session.text.includes("RESOLVE_FAIL")) {
    return { ok: false, error: session.text.split("\n").find((l) => l.includes("RESOLVE_FAIL")) ?? "resolve failed" };
  }
  return { ok: true };
}

/**
 * Shared SDK-session plumbing for the updater's two Claude paths (divergence
 * merge + in-tree conflict resolution). Bounded toolset (shell for git, file IO
 * for markers), no network/MCP/sub-agents. Returns the final assistant/result
 * text so callers can scan for their sentinel; verification of the actual git
 * state is always the caller's job — never trust the model's self-report.
 *
 * Note: the SDK's `query()` spawns the `claude` CLI with the parent process
 * env. On a daemon launched with a stripped PATH (Finder, launchd) this can hit
 * ENOENT — same root cause as the bun ENOENT handled in spawn-env.ts, a
 * different binary. The ff-only and stash-ff strategies don't shell out to
 * claude, so the common-case updater is unaffected.
 */
async function runClaudeAgent(
  root: string,
  prompt: string,
): Promise<{ ok: true; text: string } | { ok: false; error: string }> {
  let lastText = "";
  try {
    const q = query({
      prompt,
      options: {
        cwd: root,
        permissionMode: "bypassPermissions",
        allowedTools: ["Bash", "Read", "Edit", "Write", "Grep", "Glob"],
        maxTurns: 40,
      },
    });
    for await (const msg of q as AsyncIterable<SDKMessage>) {
      if (msg.type === "assistant") {
        const blocks = (msg as { message?: { content?: Array<{ type?: string; text?: string }> } })
          .message?.content;
        if (Array.isArray(blocks)) {
          for (const b of blocks) {
            if (b.type === "text" && typeof b.text === "string") lastText = b.text;
          }
        }
      }
      if (msg.type === "result") {
        const r = msg as { subtype?: string; result?: string };
        if (r.subtype !== "success") {
          return { ok: false, error: `claude returned ${r.subtype ?? "unknown"}` };
        }
        if (typeof r.result === "string") lastText = r.result;
      }
    }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
  return { ok: true, text: lastText };
}

/**
 * The single guard that stands between any merge strategy and `bun install`.
 *
 * If the working tree is free of conflict markers AND the index has no unmerged
 * entries, returns `clean` — the update proceeds. Otherwise:
 *
 *   - when Claude is allowed (cc-merge mode or a manual "Update now" override),
 *     resolve the markers inline via `runCcConflictResolve` (no new workspace),
 *     re-verify, and return `clean` if the tree is now spotless;
 *   - otherwise (or if the inline resolve fails / leaves residue), record a
 *     `conflicts` state entry and return the `conflicts` outcome so the UI shows
 *     the "Resolve with Claude Code" action. We never roll back here — HEAD is
 *     at upstream and the user's edits stay in the tree.
 *
 * Idempotent and cheap on the happy path: two git calls (`git grep`,
 * `git ls-files -u`) when there's nothing to resolve.
 */
async function healConflicts(
  root: string,
  fromSha: string,
  origin: "stash-ff" | "cc-merge",
  allow: boolean,
): Promise<{ kind: "clean" } | { kind: "conflicts"; outcome: ApplyOutcome }> {
  let conflicted = await conflictedFiles(root).catch(() => [] as string[]);
  let unmerged = await hasUnmergedFiles(root).catch(() => false);
  if (conflicted.length === 0 && !unmerged) return { kind: "clean" };

  if (allow) {
    await appendLog(
      root,
      `conflict markers in [${conflicted.join(", ") || "index"}] — resolving with Claude inline\n`,
    );
    const res = await runCcConflictResolve(root, conflicted);
    conflicted = await conflictedFiles(root).catch(() => [] as string[]);
    unmerged = await hasUnmergedFiles(root).catch(() => true);
    if (res.ok && conflicted.length === 0 && !unmerged) {
      await appendLog(root, `inline conflict resolution succeeded — tree clean\n`);
      return { kind: "clean" };
    }
    const detail = res.ok
      ? `conflict markers still present after resolution in ${conflicted.join(", ") || "the index"}`
      : res.error;
    return await recordConflicts(root, fromSha, origin, detail);
  }

  const detail =
    conflicted.length > 0
      ? `unresolved conflict markers in ${conflicted.join(", ")}`
      : "unmerged files in index";
  return await recordConflicts(root, fromSha, origin, detail);
}

async function recordConflicts(
  root: string,
  fromSha: string,
  origin: "stash-ff" | "cc-merge",
  detail: string,
): Promise<{ kind: "conflicts"; outcome: ApplyOutcome }> {
  const toSha = await headSha(root).catch(() => fromSha);
  await patchUpdaterState({
    lastError: `merge: ${detail}`,
    conflicts: { fromSha, toSha, detectedAt: Date.now(), origin, detail },
    status: { kind: "idle" },
  });
  await appendLog(root, `conflicts recorded (${origin}) — ${detail}\n`);
  return { kind: "conflicts", outcome: { kind: "conflicts", origin, fromSha, toSha, detail } };
}

/**
 * Cap on how much error output we surface back to the UI. Bun's failure
 * output is usually a handful of lines (resolver complaint, type error,
 * tsc diagnostic) — 15 lines is enough to identify the root cause without
 * blowing up the JSON state file. Full output stays in the updater log.
 */
const ERR_TAIL_LINES = 15;
const ERR_TAIL_MAX_LINE = 400;

/**
 * Env overrides for the bun subprocesses the updater spawns during apply.
 * Exported so the unit suite can pin the rule — if either of these flips,
 * an install of Claudius will silently fail to update in a way that's
 * extremely hard to diagnose from the field.
 *
 *   - install → NODE_ENV=development
 *     bun (and npm-compatible installers) skip devDependencies under
 *     NODE_ENV=production. If the parent is the daemon running production
 *     (`bun start`), inheriting that env would drop typescript/eslint/etc.
 *     and the build phase would then fail with cryptic "command not found"
 *     errors. Forcing "development" keeps all deps installable.
 *
 *   - build → NODE_ENV=production
 *     If the parent is `bun run dev` (the "dev" runtimeMode), NODE_ENV
 *     leaks in as "development". Next 16's static-export pass then dies
 *     during the `/_global-error` prerender with:
 *       TypeError: Cannot read properties of null (reading 'useContext')
 *     because React's dispatcher ends up wedged between dev and prod
 *     modes. Forcing "production" is what `next build` expects and is the
 *     only configuration we actually ship.
 *
 * Scrubbed in BOTH phases (passed as `undefined`, which spawnStreamed deletes):
 *
 *   - __NEXT_PRIVATE_STANDALONE_CONFIG / __NEXT_PRIVATE_ORIGIN
 *     The running daemon IS a Next standalone server, and Next injects these
 *     into every child process. They pin a frozen, serialized config (with an
 *     `outputFileTracingRoot` / `turbopack.root` baked at the ORIGINAL build
 *     time) that overrides the project's own `next.config.ts`. A self-update's
 *     `next build` inheriting them rebuilds against a stale/foreign root and
 *     dies with Turbopack `Invalid distDirRoot` or emits the standalone tree
 *     under the wrong directory. The build must read next.config.ts fresh.
 *   - TURBOPACK / NEXT_DEPLOYMENT_ID
 *     Bundler-selection / deployment leakage from the parent; harmless to drop
 *     and avoids forcing a bundler the build didn't choose.
 *
 * Tested in `tests/unit/updater-spawn-env.test.ts`.
 */
const SCRUBBED_NEXT_BUILD_ENV = [
  "__NEXT_PRIVATE_STANDALONE_CONFIG",
  "__NEXT_PRIVATE_ORIGIN",
  "TURBOPACK",
  "NEXT_DEPLOYMENT_ID",
] as const;

export function envForBunPhase(phase: "install" | "build"): Partial<NodeJS.ProcessEnv> {
  const scrub: Partial<NodeJS.ProcessEnv> = {};
  for (const key of SCRUBBED_NEXT_BUILD_ENV) scrub[key] = undefined;
  return {
    NODE_ENV: phase === "install" ? "development" : "production",
    ...scrub,
  };
}

async function runStreamed(
  root: string,
  cmd: string,
  args: string[],
  phase: ApplyPhase,
  // Forwarded to `spawnStreamed` and spread over `process.env` there; treat
  // it as a partial override so the default `{}` and one-key overrides like
  // `{ NODE_ENV: "production" }` both type-check against Next.js's ambient
  // `ProcessEnv` (which marks NODE_ENV as required).
  env: Partial<NodeJS.ProcessEnv> = {},
): Promise<void> {
  // Ring buffer of recent stderr lines so we can include them in the error
  // message. Stdout typically just contains progress noise we don't want in
  // the UI, but stderr is where bun / tsc / git put the actual diagnostic.
  const errTail: string[] = [];
  let code: number;
  try {
    code = await spawnStreamed(
      cmd,
      args,
      root,
      (line, stream) => {
        void appendLog(root, `[${phase}/${stream}] ${line}\n`);
        if (stream === "err" && line.trim().length > 0) {
          const trimmed =
            line.length > ERR_TAIL_MAX_LINE ? line.slice(0, ERR_TAIL_MAX_LINE) + "…" : line;
          errTail.push(trimmed);
          if (errTail.length > ERR_TAIL_LINES) errTail.shift();
        }
      },
      env,
    );
  } catch (err) {
    // The child failed to spawn at all (the most common case: ENOENT
    // because `bun` isn't on the inherited PATH — see spawn-env.ts for the
    // PATH-extension fix). Re-throw tagged with the actual phase so the UI
    // banner reads "install: spawn bun ENOENT" instead of the misleading
    // "init: spawn bun ENOENT" that a default-phase fallback produced.
    const raw = err instanceof Error ? err.message : String(err);
    const hint =
      /ENOENT/.test(raw) && cmd === "bun"
        ? " — bun was not found on PATH. Install bun (https://bun.com) or symlink it into /usr/local/bin so the daemon process can find it."
        : "";
    throw phaseError(phase, `${raw}${hint}`);
  }
  if (code !== 0) {
    const head = `${cmd} ${args.join(" ")} exited with code ${code}`;
    // Keep the head as the first line so the banner (which truncates) still
    // shows something useful; the tail gives /updater room to render detail.
    const detail = errTail.length > 0 ? `\n${errTail.join("\n")}` : "";
    throw phaseError(phase, `${head}${detail}`);
  }
}

async function appendLog(root: string, line: string): Promise<void> {
  const path = APPLY_LOG(root);
  try {
    await fs.mkdir(dirname(path), { recursive: true });
    await fs.appendFile(path, line, "utf8");
  } catch {
    // logging is best-effort
  }
}
