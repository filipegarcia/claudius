import { promises as fs } from "node:fs";
import { dirname, join } from "node:path";
import { query, type SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import {
  headSha,
  isDirty,
  pullFastForward,
  spawnStreamed,
  UpdaterGitError,
} from "./git";
import { checkForUpdates } from "./detect";
import { installRoot } from "./root";
import {
  getUpdaterSettings,
  patchUpdaterState,
  setUpdaterStatus,
  type UpdaterMode,
  type UpdaterPending,
} from "./settings";
import { triggerRestart, type RestartResult } from "./restart";

export type ApplyOutcome =
  | {
      kind: "applied";
      strategy: "ff-only" | "cc-merge";
      fromSha: string;
      toSha: string;
      restart: RestartResult;
    }
  | { kind: "no-update" }
  | { kind: "skipped"; reason: string }
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
    } else {
      // strategy.kind === "cc-merge"
      const ok = await runCcMerge(root, pending, settings.remote);
      if (!ok.ok) {
        await patchUpdaterState({
          lastError: `Claude merge failed: ${ok.error}`,
          status: { kind: "idle" },
        });
        return { kind: "error", message: ok.error, phase: "merge" };
      }
    }

    // For ff-only the upstream lockfile is canonical, so frozen install is
    // correct. For cc-merge the merge may have touched package.json /
    // bun.lockb — frozen would fail, so use the unfrozen path so bun can
    // resolve the merged manifest.
    const installArgs =
      strategy.kind === "ff-only" ? ["install", "--frozen-lockfile"] : ["install"];
    await runStreamed(root, "bun", installArgs, "install");
    await runStreamed(root, "bun", ["run", "build"], "build");

    const toSha = await headSha(root);
    await patchUpdaterState({
      lastUpdateAt: Date.now(),
      lastUpdateSha: toSha,
      lastError: undefined,
      pending: undefined,
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
    let rolledBack = false;
    let attemptedRollback = false;
    if (phase === "install" || phase === "build" || phase === "merge") {
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
  | { kind: "cc-merge" }
  | { kind: "skip"; reason: string };

function pickStrategy(
  mode: UpdaterMode,
  pending: UpdaterPending,
  allowCcMergeOverride: boolean,
): Strategy {
  // Manual click (allowCcMergeOverride=true) lets the user opt into Claude
  // merge even if their settings are notify-only.
  const wantsCcMerge = mode === "cc-merge" || allowCcMergeOverride;

  const cleanFastForward = !pending.dirty && pending.ahead === 0 && pending.behind > 0;

  if (cleanFastForward) return { kind: "ff-only" };

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

const CC_MERGE_PROMPT = `You are reconciling this Claudius checkout with upstream.

Goal: bring the local working tree to a state where:
  1. The latest upstream changes from \`{{remote}}/{{branch}}\` are applied.
  2. Any local edits (published customizations, manual tweaks) that DON'T conflict are preserved.
  3. For real conflicts, prefer the customization intent for visible UI/behavior changes; prefer upstream for bug fixes and dependency bumps. When in doubt, keep both behaviors and resolve sensibly.
  4. \`bun run lint\` (best effort) and \`bun run build\` will be run AFTER you finish — your job is just to leave a clean, building tree.

Current state (already verified before invoking you):
  - HEAD is at: {{localSha}}
  - Upstream is at: {{remoteSha}}
  - Working tree dirty: {{dirty}}
  - Local branch: {{branch}}
  - Tracking: {{upstreamRef}}

Approach:
  1. Run \`git status\` and \`git log --oneline HEAD..{{upstreamRef}} | head -30\` to see what you're working with.
  2. If the tree is dirty, decide whether to commit, stash, or merge as-is. For Claudius the right default is: \`git stash push -u -m claudius-updater-stash\`, then merge, then \`git stash pop\` and resolve conflicts.
  3. If the tree is clean: \`git merge --no-edit {{upstreamRef}}\`. Resolve any conflict markers using your judgment (see goals above).
  4. Once HEAD is at or ahead of {{upstreamRef}} and the tree has no conflict markers, you're done.

Hard rules:
  - DO NOT \`git push\` anywhere.
  - DO NOT delete the .claudius/ directory or .next/ directory.
  - DO NOT modify .git/config or remotes.
  - If you can't safely resolve, leave the tree as-is, run \`git merge --abort\` (or \`git stash pop\` to restore), and report failure in your final message.
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

async function runStreamed(
  root: string,
  cmd: string,
  args: string[],
  phase: ApplyPhase,
): Promise<void> {
  // Ring buffer of recent stderr lines so we can include them in the error
  // message. Stdout typically just contains progress noise we don't want in
  // the UI, but stderr is where bun / tsc / git put the actual diagnostic.
  const errTail: string[] = [];
  const code = await spawnStreamed(cmd, args, root, (line, stream) => {
    void appendLog(root, `[${phase}/${stream}] ${line}\n`);
    if (stream === "err" && line.trim().length > 0) {
      const trimmed =
        line.length > ERR_TAIL_MAX_LINE ? line.slice(0, ERR_TAIL_MAX_LINE) + "…" : line;
      errTail.push(trimmed);
      if (errTail.length > ERR_TAIL_LINES) errTail.shift();
    }
  });
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
