import { promises as fs } from "node:fs";
import { dirname, join } from "node:path";
import { query, type SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import {
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

  // Hold the line while there are unresolved conflicts. Any further apply
  // would stash on top of conflict markers (or pull on top of a dirty merge),
  // both of which compound the mess. The detect path clears `conflicts`
  // automatically once the user lands on a clean tree.
  const file = await readUpdaterFile();
  if (file.state.conflicts) {
    return {
      kind: "skipped",
      reason: "previous update left conflicts — resolve them first",
    };
  }

  // Always re-check first so we're acting on a fresh diff between local and
  // remote — the cached `pending` could be hours old.
  const check = await checkForUpdates();
  if (check.kind === "up-to-date") return { kind: "no-update" };
  if (check.kind === "skipped") return { kind: "skipped", reason: check.reason };
  if (check.kind === "error") return { kind: "error", message: check.message, phase: "detect" };

  const pending = check.pending;
  const fromSha = await headSha(root);
  const strategy = pickStrategy(settings.mode, pending, opts.allowCcMerge ?? false);
  if (strategy.kind === "skip") {
    return { kind: "skipped", reason: strategy.reason };
  }

  await setUpdaterStatus({ kind: "applying", startedAt: Date.now(), strategy: strategy.kind });
  await appendLog(root, `\n=== ${new Date().toISOString()} apply (${strategy.kind}) from ${fromSha.slice(0, 7)} → ${pending.remoteSha.slice(0, 7)} ===\n`);

  try {
    if (strategy.kind === "ff-only") {
      await runFastForward(root, settings.remote, settings.branch);
    } else if (strategy.kind === "stash-ff") {
      const result = await runStashFastForward(root, settings.remote, settings.branch);
      if (result.kind === "conflicts") {
        // HEAD is at upstream, working tree has conflict markers from the
        // stash pop. Record so the UI can surface a "Resolve with Claude
        // Code" action; bypass rollback so we DON'T `git reset --hard`
        // over the user's edits. Skip install/build/restart — the tree
        // is not in a runnable state.
        const toSha = await headSha(root);
        await patchUpdaterState({
          lastError: `merge: ${result.detail}`,
          conflicts: {
            fromSha,
            toSha,
            detectedAt: Date.now(),
            origin: "stash-ff",
            detail: result.detail,
          },
          status: { kind: "idle" },
        });
        await appendLog(root, `stash-ff: pop conflicts — ${result.detail}\n`);
        return {
          kind: "conflicts",
          origin: "stash-ff",
          fromSha,
          toSha,
          detail: result.detail,
        };
      }
    } else {
      // strategy.kind === "cc-merge"
      const ok = await runCcMerge(root, pending, settings.remote);
      if (!ok.ok) {
        // If the agent left the tree dirty after touching HEAD, surface
        // as conflicts (with the resolve button) rather than a plain
        // error — same recovery UX as stash-ff. Otherwise it's just an
        // ordinary merge-phase failure.
        const dirty = await isDirty(root);
        const movedHead = (await headSha(root)) !== fromSha;
        if (dirty && movedHead) {
          const toSha = await headSha(root);
          await patchUpdaterState({
            lastError: `merge: ${ok.error}`,
            conflicts: {
              fromSha,
              toSha,
              detectedAt: Date.now(),
              origin: "cc-merge",
              detail: ok.error,
            },
            status: { kind: "idle" },
          });
          await appendLog(root, `cc-merge: left dirty — ${ok.error}\n`);
          return {
            kind: "conflicts",
            origin: "cc-merge",
            fromSha,
            toSha,
            detail: ok.error,
          };
        }
        await patchUpdaterState({
          lastError: `Claude merge failed: ${ok.error}`,
          status: { kind: "idle" },
        });
        return { kind: "error", message: ok.error, phase: "merge" };
      }
    }

    // For ff-only the upstream lockfile is canonical, so frozen install is
    // correct. For stash-ff / cc-merge the merge may have touched
    // package.json / bun.lockb — frozen would fail, so use the unfrozen
    // path so bun can resolve the merged manifest.
    const installArgs =
      strategy.kind === "ff-only" ? ["install", "--frozen-lockfile"] : ["install"];
    await runStreamed(root, "bun", installArgs, "install", envForBunPhase("install"));
    await runStreamed(root, "bun", ["run", "build"], "build", envForBunPhase("build"));

    const toSha = await headSha(root);
    await patchUpdaterState({
      lastUpdateAt: Date.now(),
      lastUpdateSha: toSha,
      lastError: undefined,
      pending: undefined,
      conflicts: undefined,
      status: { kind: "restarting", startedAt: Date.now() },
    });
    await appendLog(root, `apply ok — restarting (was ${fromSha.slice(0, 7)}, now ${toSha.slice(0, 7)})\n`);

    const restart = await triggerRestart();
    return {
      kind: "applied",
      strategy: strategy.kind,
      fromSha,
      toSha,
      restart,
    };
  } catch (err) {
    const phase = (err as PhaseError).phase ?? "init";
    const msg = err instanceof Error ? err.message : String(err);
    await appendLog(root, `apply failed in ${phase}: ${msg}\n`);
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
    const canRollback =
      strategy.kind !== "stash-ff" &&
      (phase === "install" || phase === "build" || phase === "merge");
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

  let lastText = "";
  try {
    // Note: the SDK's `query()` spawns the `claude` CLI with the parent
    // process env. If the daemon was launched with a stripped PATH (Finder,
    // launchd) the spawn here can also hit ENOENT — same root cause as the
    // bun ENOENT fixed in spawn-env.ts, but a different binary. The
    // ff-only and stash-ff strategies don't shell out to claude so the
    // common-case updater is unaffected; cc-merge users on a stripped-PATH
    // daemon would still see "claude not found" until the SDK gains a
    // PATH-extension equivalent or we set CLAUDE_BIN explicitly.
    const q = query({
      prompt,
      options: {
        cwd: root,
        permissionMode: "bypassPermissions",
        // Bounded toolset: shell for git ops, file IO for conflict markers.
        // No network/MCP/sub-agents.
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
 * Tested in `tests/unit/updater-spawn-env.test.ts`.
 */
export function envForBunPhase(
  phase: "install" | "build",
): { NODE_ENV: "development" | "production" } {
  return phase === "install"
    ? { NODE_ENV: "development" }
    : { NODE_ENV: "production" };
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
