/**
 * scripts/sdk-update/orchestrate.ts
 *
 * End-to-end SDK upgrade pipeline. Invoked by `run.sh` after `check.ts`
 * decides there's a new version to take. The orchestrator's job is to
 * frame the work and hand off as much as possible to Claude; it does
 * the deterministic parts (git plumbing, PR opening, CI watching,
 * announcement) and lets the model do the open-ended parts (reading
 * the changelog, migrating call sites, writing components, writing
 * tests, debugging failures).
 *
 * Pipeline (top-to-bottom in `main()`):
 *   1. Pre-flight  — sanity-check env, working tree, remote.
 *   2. Branch      — fetch origin. If an SDK-update PR is still open (a
 *                    newer release shipped before the human merged the
 *                    prior one), CONTINUE on that PR's existing branch so
 *                    the bump stacks into one reviewable PR; otherwise
 *                    create `sdk-update/<version>` off main. See
 *                    findOpenSdkUpdatePr.
 *   3. Announce    — "🆕 starting upgrade on branch X" — fires within
 *                    seconds of cron so the channel hears immediately,
 *                    not minutes later when the PR opens.
 *   4. Bump        — edit package.json, `bun install`.
 *   5. Changelog   — extract upstream notes between PREV..NEW.
 *   6. Announce    — POST the changelog body so the channel sees what
 *                    Claude is about to react to. Clipped to fit the
 *                    chat-server's 2000-char message cap.
 *   7. Run Claude  — `query({ prompt, options })` with bypassPermissions,
 *                    streamed under a wall-clock + turn budget.
 *   8. Announce    — "✅ Claude finished — here's the summary" lifted
 *                    from the Summary section of the run-notes file.
 *                    Degrades to a one-liner if the section is still
 *                    the stub placeholder. Prefixed with "⚠️ Claude
 *                    was stopped before completing" when a turn / wall
 *                    / idle budget tripped, so the channel knows the
 *                    summary may reflect partial work.
 *   9. Announce    — "🧪 running local gates" right before the gate.
 *  10. Gate        — run lint/test/build/e2e. If green, full PR.
 *                    If red AND budget exhausted, draft PR with
 *                    `needs-human` label.
 *  11. Announce    — "✅ gates green" / "❌ gates failed: <steps>" the
 *                    moment the gate finishes, so a red test outcome
 *                    reaches the channel immediately instead of
 *                    minutes later via the process-issue post.
 *  12. Push + PR   — `gh pr create` with the templated body.
 *  13. Announce    — POST to chat-server /admin/announce the moment the
 *                    PR exists, for BOTH full and draft PRs (the draft
 *                    message carries the reason). Not pinned.
 *  14. CI watch    — `gh pr checks --watch`.
 *  15. Announce    — second POST on fully-green ship (pinned).
 *  16. State       — update lastCompletedVersion / clear inFlight.
 *
 *   The five progress announces (3, 6, 8, 9, 11) are suppressed under
 *   `--dry-run` so local prompt iteration doesn't spam the channel.
 *
 * Fix mode (`--fix-pr=<n>`, via `make sdk-update-fix-pr PR=<n>`):
 *   a wholly separate entry point that skips the version probe. It
 *   checks out an existing PR's branch, re-runs Claude with the failing
 *   checks + review comments as context, re-gates, pushes, marks the PR
 *   ready / drops `needs-human` if green, and posts start + result
 *   messages to the community channel. See `fixPr()`.
 *
 * Auth (env):
 *   ANTHROPIC_API_KEY          required — passed through to the Agent SDK
 *   GH_TOKEN or gh auth login  required — `gh` CLI must be authed
 *   CHAT_SERVER_URL            required — base URL of the chat-server
 *   CHAT_SERVER_ADMIN_TOKEN    required — matches chat-server admin token
 *   SDK_UPDATE_ROOM_SLUG       optional — default "sdk-update"
 *   SDK_UPDATE_MODEL           optional — Claude model alias, default "sonnet"
 *   SDK_UPDATE_MAX_TURNS       optional — agentic turn budget, default 400
 *   SDK_UPDATE_MAX_WALL_MIN    optional — wall-clock budget in minutes, default 360
 *   SDK_UPDATE_MAX_IDLE_MIN    optional — max silence between SDK messages, default 15
 */

import { spawn, spawnSync, type SpawnOptions } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  cleanRange,
  isNewer,
  patchState,
  readInstalledRange,
  readState,
  repoRoot,
} from "./check";
// CC state helpers — aliased to avoid the name collision with the SDK
// state helpers above. The CC orchestrator itself is imported
// **dynamically** further down (inside the combined branch in main())
// to break the import cycle between the two orchestrators.
import {
  decideCcCombinedRun,
  fetchChangelogSlice as fetchCcChangelogSlice,
  fetchLatestVersion as fetchCcLatestVersion,
  patchState as patchCcState,
  readState as readCcState,
  type UpdaterState as CcUpdaterState,
} from "../cc-parity/check";

// ── Config ────────────────────────────────────────────────────────────

const ROOT = repoRoot();
const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));

const SDK_PKG_NAME = "@anthropic-ai/claude-agent-sdk";
const UPSTREAM_GH = "anthropics/claude-agent-sdk-typescript";

const CHAT_SERVER_URL = process.env.CHAT_SERVER_URL ?? "";
const CHAT_SERVER_ADMIN_TOKEN = process.env.CHAT_SERVER_ADMIN_TOKEN ?? "";
const ROOM_SLUG = process.env.SDK_UPDATE_ROOM_SLUG ?? "sdk-update";

// Never let a git subprocess block on an interactive credential prompt.
// Without this, a missing/expired credential makes `git push` print
// "Username for 'https://github.com':" to the controlling tty and hang
// FOREVER (the run never reaches pushBranch's helpful error) — observed
// on a headless macOS run where gh was authed but git's credential
// helper had no token. With the prompt disabled git fails fast and the
// non-zero exit surfaces our actionable message instead.
process.env.GIT_TERMINAL_PROMPT = "0";

const MODEL = process.env.SDK_UPDATE_MODEL ?? "sonnet";
const MAX_TURNS = Number(process.env.SDK_UPDATE_MAX_TURNS ?? "400");
const MAX_WALL_MS = Number(process.env.SDK_UPDATE_MAX_WALL_MIN ?? "360") * 60_000;
// Idle watchdog: maximum gap between consecutive SDK messages before we
// assume the agent (or a tool subprocess it spawned) is hung. The
// wall-clock budget above is the LAST line of defense; this fires sooner
// so an operator isn't waiting six hours to find out something stalled.
// Default 15 min comfortably exceeds the slowest tool we expect to run
// (Playwright e2e at ~7 min) but catches "Bash hung on stdin" / "network
// blackholed" / "agent deadlock" within a useful window.
const MAX_IDLE_MS = Number(process.env.SDK_UPDATE_MAX_IDLE_MIN ?? "15") * 60_000;
// How many times the upgrade pipeline re-runs Claude to fix a red CI
// before giving up, filing a process issue, and leaving the draft for a
// human. Each attempt is a full Claude run against the same
// MAX_TURNS/wall budget, so keep it small. Default 3; 0 disables the
// loop (one CI check, then ship-or-report).
const MAX_CI_FIX_ATTEMPTS = Number(process.env.SDK_UPDATE_MAX_CI_FIX ?? "3");

// ── Logging ───────────────────────────────────────────────────────────

function log(line: string): void {
  // ISO timestamp keeps cron-log forensics easy.
  console.log(`[sdk-update/orchestrate ${new Date().toISOString()}] ${line}`);
}

function fatal(line: string): never {
  console.error(`[sdk-update/orchestrate FATAL] ${line}`);
  process.exit(1);
}

// ── Regex helpers ─────────────────────────────────────────────────────

/**
 * Escape every regex metacharacter in `s` so the result is safe to
 * embed verbatim inside a `new RegExp(...)` pattern. Covers all 14
 * special chars listed in the ECMAScript spec — including backslash,
 * which is the most commonly-missed one and what tripped CodeQL's
 * `js/incomplete-sanitization` rule on the previous ad-hoc escapes.
 *
 * Use this whenever a value derived from CLI args, env, or even a
 * constant package name flows into `new RegExp(value)`. Without it,
 * a `.` in a version string acts as a wildcard, and a stray `\` in
 * any input can break out of the intended pattern entirely.
 *
 * Mirrors the well-known MDN pattern; kept inline to avoid pulling in
 * `lodash.escaperegexp` just for one function.
 */
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Collapse whitespace to single spaces and clip to `n` chars (with an
 * ellipsis). Used to keep community-channel announcements and prompt
 * context blocks within the chat-server's 2000-char body limit and
 * readable on one line.
 */
function oneLine(s: string, n: number): string {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n)}…` : t;
}

// ── Shell helpers ─────────────────────────────────────────────────────

/**
 * Run a command synchronously, fail loudly on non-zero exit. Used for
 * git and gh — both are short, cheap, and we want the orchestrator to
 * stop the moment the world stops looking like we expect.
 */
function sh(cmd: string, args: string[], opts: SpawnOptions = {}): string {
  const result = spawnSync(cmd, args, {
    cwd: ROOT,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    ...opts,
  });
  if (result.status !== 0) {
    throw new Error(
      `command failed (${result.status}): ${cmd} ${args.join(" ")}\n${result.stderr ?? ""}`,
    );
  }
  return (result.stdout ?? "").toString().trim();
}

/**
 * Run a command, stream stdout+stderr to the cron log in real time AND
 * capture the last `tailLines` lines so the orchestrator can include
 * them in a draft PR body or a GitHub issue body when the command fails.
 *
 * The motivation: when `bun run test:e2e` (or lint/build/unit) failed
 * under the original `shStream`, the failure output went only to cron's
 * inherited stdio — the orchestrator filed a GitHub issue with just
 * "kind=local gates failed" and no tail, so the operator had to ssh
 * onto the cron host and tail `cron.log` to see WHICH tests failed.
 * Capturing the tail here means the issue + the draft PR body carry the
 * actionable detail directly.
 *
 * Why async: `spawnSync` either inherits (loses output) or pipes (no
 * live streaming until exit). `spawn` lets us tee each chunk to
 * console.* AND a ring buffer so the cron tail still feels live during
 * a 5-minute e2e run, AND the captured tail survives for the issue body.
 *
 * The ring buffer is bounded at 4×tailLines so memory stays reasonable
 * even if a runaway test prints megabytes of logs before failing.
 */
// Exported for unit tests (the timeout/kill path is load-bearing).
export async function shStreamCapture(
  cmd: string,
  args: string[],
  opts: SpawnOptions = {},
  tailLines = 80,
  // Hard wall-clock cap on the child. 0 = no timeout. When it trips we
  // kill the child's whole PROCESS GROUP and resolve with exit 124 (the
  // conventional `timeout(1)` code) so the caller treats it as a normal
  // step failure. This is the load-bearing guard against a hung gate step
  // (e.g. Playwright wedged on a webServer that never comes up) running
  // for hours, holding the pipeline lock, and blocking all recovery until
  // an external kill bypasses the orchestrator's `finally` — the exact
  // failure that stranded cc-parity 2.1.197.
  timeoutMs = 0,
): Promise<{ code: number; tail: string; timedOut: boolean }> {
  const { spawn: childSpawn } = await import("node:child_process");
  return new Promise((resolve) => {
    const child = childSpawn(cmd, args, {
      cwd: ROOT,
      stdio: ["ignore", "pipe", "pipe"],
      // `detached: true` puts the child in its own process group (pgid =
      // child.pid) so we can signal the WHOLE tree — bun → bash → node
      // playwright → chromium — with `kill(-pid)`. Without this, killing
      // just the `bun` parent leaves orphan chromium processes that pile
      // up across firings.
      detached: true,
      ...opts,
    });
    const lines: string[] = [];
    let pending = "";
    let settled = false;
    let killTimer: ReturnType<typeof setTimeout> | null = null;
    let hardKillTimer: ReturnType<typeof setTimeout> | null = null;
    let timedOut = false;

    const done = (code: number): void => {
      if (settled) return;
      settled = true;
      if (killTimer) clearTimeout(killTimer);
      if (hardKillTimer) clearTimeout(hardKillTimer);
      if (pending) lines.push(pending);
      resolve({ code, tail: lines.slice(-tailLines).join("\n"), timedOut });
    };

    // Best-effort signal to the child's process group, falling back to the
    // bare pid if the group send fails (ESRCH / not a group leader).
    const signalGroup = (sig: NodeJS.Signals): void => {
      if (child.pid == null) return;
      try {
        process.kill(-child.pid, sig);
      } catch {
        try {
          child.kill(sig);
        } catch {
          // already gone
        }
      }
    };

    if (timeoutMs > 0) {
      killTimer = setTimeout(() => {
        timedOut = true;
        const note = `(shStreamCapture: step exceeded ${Math.round(timeoutMs / 1000)}s wall-clock — killing process group)`;
        lines.push(note);
        process.stderr.write(note + "\n");
        signalGroup("SIGTERM");
        // Escalate to SIGKILL if SIGTERM doesn't land the `close` event
        // within a short grace window (a truly wedged process may ignore
        // TERM). `close` clears this via done().
        hardKillTimer = setTimeout(() => signalGroup("SIGKILL"), 10_000);
      }, timeoutMs);
    }

    const onChunk =
      (stream: NodeJS.WriteStream) =>
      (chunk: Buffer | string): void => {
        const text =
          typeof chunk === "string" ? chunk : chunk.toString("utf8");
        stream.write(text);
        // Reassemble line-wise so a chunk that ends mid-line doesn't
        // create two ring-buffer entries.
        pending += text;
        const split = pending.split(/\r?\n/);
        pending = split.pop() ?? "";
        for (const ln of split) lines.push(ln);
        // Bound memory at 4×tailLines; once we exceed it, trim the head
        // back to 2×tailLines so we're not trimming on every chunk.
        if (lines.length > tailLines * 4) {
          lines.splice(0, lines.length - tailLines * 2);
        }
      };
    child.stdout?.on("data", onChunk(process.stdout));
    child.stderr?.on("data", onChunk(process.stderr));
    child.on("close", (code) => {
      // A timed-out kill surfaces as a null/signal exit; normalize to the
      // conventional 124 so the caller (and the PR/issue tail) reads it as
      // "timed out" rather than an ambiguous -1.
      done(timedOut ? 124 : code ?? -1);
    });
    child.on("error", (err) => {
      // spawn failures (e.g. command not found) get surfaced in-line so
      // the tail explains WHY the step failed even without exec output.
      lines.push(`(shStreamCapture spawn error: ${err.message})`);
      done(-1);
    });
  });
}

/** Same as `sh` but inherits stdio so the user sees streaming output. */
function shStream(cmd: string, args: string[], opts: SpawnOptions = {}): number {
  const result = spawnSync(cmd, args, {
    cwd: ROOT,
    stdio: "inherit",
    ...opts,
  });
  return result.status ?? -1;
}

// ── Pre-flight ────────────────────────────────────────────────────────

export function preflight(): void {
  // Auth resolution mirrors what the bundled `cli.js` does inside
  // @anthropic-ai/claude-agent-sdk: it accepts any of (a) an explicit
  // ANTHROPIC_API_KEY, (b) a CLAUDE_CODE_OAUTH_TOKEN, or (c) a
  // credentials file from `claude /login` at
  // $CLAUDE_CONFIG_DIR/.credentials.json or ~/.claude/.credentials.json
  // (plus the macOS keychain, which we don't inspect from here —
  // headless cron rigs are Linux in practice).
  //
  // We only need to confirm SOMETHING is set; the SDK gives a clearer
  // auth error than we could fabricate if it later can't authenticate.
  // The intent of the soft check is just to fail fast on a host that's
  // never been logged in at all, with a pointer to the fix.
  const configDir = process.env.CLAUDE_CONFIG_DIR ?? resolve(homedir(), ".claude");
  const credsPath = resolve(configDir, ".credentials.json");
  const hasAnyAuth =
    !!process.env.ANTHROPIC_API_KEY ||
    !!process.env.CLAUDE_CODE_OAUTH_TOKEN ||
    existsSync(credsPath);
  if (!hasAnyAuth) {
    fatal(
      `no Claude auth found. Either set ANTHROPIC_API_KEY in ` +
        `.claudius/sdk-updater/env, or run \`claude /login\` once as ` +
        `the cron user (which writes ${credsPath}). The Agent SDK ` +
        `picks up either automatically.`,
    );
  }
  if (!CHAT_SERVER_URL || !CHAT_SERVER_ADMIN_TOKEN) {
    fatal(
      "CHAT_SERVER_URL and CHAT_SERVER_ADMIN_TOKEN must be set — needed for the announce step.",
    );
  }
  // gh CLI is required for PR open + CI watch. We don't shell out to
  // git push directly — gh wraps the auth, so if gh works, push works.
  try {
    sh("gh", ["--version"]);
  } catch {
    fatal("gh CLI is not on PATH. Install from https://cli.github.com/.");
  }
  try {
    sh("gh", ["auth", "status"]);
  } catch {
    fatal(
      "gh CLI is not authenticated. Run `gh auth login` (or set GH_TOKEN).",
    );
  }
  // Git needs an identity to make commits. On a fresh server image
  // neither user.email nor user.name is set, and the failure mode
  // (commit fails AFTER package.json has been edited, leaving the
  // working tree wedged with a staged bump on a half-built branch) is
  // brutal to recover from — see the recovery notes in README.md.
  // Catching it here means the run is a no-op until the operator fixes it.
  try {
    sh("git", ["config", "user.email"]);
    sh("git", ["config", "user.name"]);
  } catch {
    fatal(
      "git user.email / user.name are not configured. Run:\n" +
        "  git config --global user.email \"bot@example.com\"\n" +
        "  git config --global user.name \"SDK Update Bot\"\n" +
        "as the cron user, then re-run.",
    );
  }
  // Dirty tree: we're about to bump deps and let Claude reshape the
  // world on a fresh branch cut from origin/main, so a pre-existing
  // diff would silently ride along into the PR. Rather than hard-refuse
  // (which bricked interactive `make sdk-update-run` on the smallest
  // stray edit — typically a leftover SDK bump from a prior run), stash
  // the changes aside and continue. The stash is branch-independent and
  // recoverable any time via `git stash list` / `git stash pop`.
  const status = sh("git", ["status", "--porcelain"]);
  if (status.trim() !== "") {
    const label = `sdk-update-autostash ${new Date().toISOString()}`;
    log(`working tree is dirty — stashing before we start:\n${status}`);
    // --include-untracked so brand-new files (e.g. a half-written
    // migration) don't block the stash; they come back together on pop.
    sh("git", ["stash", "push", "--include-untracked", "-m", label]);
    log(
      `stashed as "${label}" — recover later with \`git stash list\` then ` +
        `\`git stash pop\`, or \`git stash drop\` to discard.`,
    );
  }
}

// ── Branch management ─────────────────────────────────────────────────

function branchName(version: string): string {
  return `sdk-update/${version}`;
}

/**
 * Parse the SDK version out of a branch this orchestrator created.
 * `sdk-update/0.3.170` → `0.3.170`. Returns "" for anything that doesn't
 * match the prefix (callers guard on that).
 */
function versionFromBranch(branch: string): string {
  return branch.startsWith("sdk-update/") ? branch.slice("sdk-update/".length) : "";
}

/**
 * Find an open SDK-update PR to CONTINUE, so a new upstream release that
 * arrives before the previous PR is merged stacks onto that PR's branch
 * instead of opening a parallel one.
 *
 * The motivating bug: a release ships overnight → PR #A opens. Before the
 * human is awake to merge it, the next release ships → the orchestrator
 * (which derives `prevVersion` from `main`, still on the pre-#A version)
 * computes a *fresh* `sdk-update/<newer>` branch off main and opens PR #B.
 * Now there are two competing PRs for the same dependency. Detecting #A here
 * and reusing its branch keeps everything in one reviewable PR.
 *
 * Matching is by head-branch prefix (`sdk-update/`), which is how every
 * branch this pipeline creates is named (combined SDK+CC runs included).
 * Returns null when nothing is open — the caller then falls back to the
 * usual fresh `sdk-update/<newVersion>` branch off main.
 *
 * If more than one open SDK-update PR exists (e.g. the pre-existing
 * double-PR state this feature prevents going forward), we pick the
 * highest-version one as the continuation target and log the rest loudly so
 * a human can close the dupes. We deliberately do NOT auto-close — a
 * reviewer may have left comments on one of them.
 */
export type OpenPrSummary = {
  number: number;
  headRefName: string;
  url: string;
  title: string;
};

export type ContinuationPr = {
  number: number;
  branch: string;
  url: string;
  title: string;
  /** The other open SDK-update PRs that were NOT chosen, if any. */
  duplicates: OpenPrSummary[];
};

/**
 * Pure selection logic for findOpenSdkUpdatePr — given the list of open PRs,
 * pick the SDK-update PR to continue (highest version wins) and report any
 * duplicates. Extracted so the version filter + tie-break can be unit-tested
 * without stubbing `gh` (the file's convention: side-effectful halves stay
 * untested, the decision logic is pinned down). Returns null when no open PR
 * matches the `sdk-update/` branch prefix.
 */
export function pickContinuationPr(prs: OpenPrSummary[]): ContinuationPr | null {
  const candidates = prs.filter((p) => p.headRefName.startsWith("sdk-update/"));
  if (candidates.length === 0) return null;

  // Highest SDK version wins — that's the most recent prior attempt, the one
  // worth stacking on. `isNewer(a, b)` is the same comparator the npm probe
  // uses, so the ordering here matches "what counts as newer" everywhere else.
  const sorted = [...candidates].sort((a, b) =>
    isNewer(versionFromBranch(b.headRefName), versionFromBranch(a.headRefName)) ? 1 : -1,
  );
  const chosen = sorted[0]!;
  return {
    number: chosen.number,
    branch: chosen.headRefName,
    url: chosen.url,
    title: chosen.title,
    duplicates: sorted.slice(1),
  };
}

export function findOpenSdkUpdatePr(): ContinuationPr | null {
  const res = spawnSync(
    "gh",
    [
      "pr",
      "list",
      "--state",
      "open",
      "--json",
      "number,headRefName,url,title",
      "--limit",
      "100",
    ],
    { cwd: ROOT, encoding: "utf8" },
  );
  if (res.status !== 0) {
    log(
      `findOpenSdkUpdatePr: gh pr list failed (status=${res.status}): ` +
        `${(res.stderr ?? "").trim() || "(no stderr)"} — treating as no open PR`,
    );
    return null;
  }
  let all: OpenPrSummary[];
  try {
    all = JSON.parse(res.stdout || "[]");
  } catch (err) {
    log(`findOpenSdkUpdatePr: could not parse gh output (${String(err)}) — treating as no open PR`);
    return null;
  }
  const chosen = pickContinuationPr(all);
  if (chosen && chosen.duplicates.length > 0) {
    log(
      `findOpenSdkUpdatePr: ${chosen.duplicates.length + 1} open SDK-update PRs found — ` +
        `continuing on the highest, #${chosen.number} (${chosen.branch}). ` +
        `Close the duplicates manually: ` +
        chosen.duplicates.map((c) => `#${c.number} (${c.headRefName})`).join(", "),
    );
  }
  return chosen;
}

/**
 * Check out the upgrade branch, preserving prior work where possible.
 *
 * Three cases, in priority order:
 *
 *  1. **No prior work** (no local branch, no `origin/<branch>`) →
 *     create the branch fresh off `origin/main`. Today's default.
 *
 *  2. **Prior work exists, merge with main is clean** → reset local to
 *     `origin/<branch>` if origin has it (so the cron host's view
 *     matches the reviewer's), then merge `origin/main` into it. This
 *     keeps Claude's previous attempt + picks up any main commits
 *     landed since the prior run started (typically: bug fixes the
 *     reviewer made manually, the SDK-update bot's own recent fixes,
 *     unrelated `main` work). Returns `resumed: true` so the caller
 *     can skip already-applied steps (dep bump, version bump, run-notes
 *     stub, etc.).
 *
 *  3. **Prior work exists but merge with main conflicts** → abandon
 *     the prior work, fall back to case 1's fresh-start behavior. A
 *     conflict here almost always means `bun.lock` diverged in a way
 *     that's not worth picking apart inside a cron run; starting
 *     fresh on current main is the safer recovery. Logged loudly so an
 *     operator can dig the abandoned branch out of the reflog if
 *     genuinely needed.
 *
 * The motivation for this is: failed-but-non-trivial runs used to leave
 * `sdk-update/<v>` on the cron host carrying real work, and the next
 * firing wiped it. With the gate-fail-draft-PR behavior in place, the
 * branch typically also has an open PR; redoing all the work on the
 * next firing throws away whatever signal that PR carried. Case 2 fixes
 * that — Claude resumes on a branch that's already up-to-date with main
 * AND carries his previous attempt.
 */
function checkoutFreshBranch(
  version: string,
  opts: { branchOverride?: string } = {},
): { branch: string; resumed: boolean } {
  // `branchOverride` is set when we're CONTINUING an already-open SDK-update
  // PR (see findOpenSdkUpdatePr): the working branch is that PR's existing
  // head (e.g. `sdk-update/0.3.170`) rather than a fresh `sdk-update/<version>`.
  // Because that branch already exists on origin, case 2 below (reset to
  // origin/<branch> + merge main in) is what actually runs — exactly the
  // resume behavior we want, the new bump stacking on the prior work.
  const branch = opts.branchOverride ?? branchName(version);
  log(`syncing origin/main`);
  sh("git", ["fetch", "origin", "main", "--prune"]);

  // Also fetch origin's copy of the version branch if any. This handles
  // the case where the cron host has no local branch but origin does
  // (e.g. fresh clone, or local branch deleted manually since the prior
  // firing). We swallow the failure because a missing remote branch is
  // exactly the not-prior-work case.
  let remoteExists = false;
  try {
    sh("git", ["fetch", "origin", branch]);
    const rb = sh("git", ["branch", "-r", "--list", `origin/${branch}`]).trim();
    remoteExists = rb !== "";
  } catch {
    remoteExists = false;
  }
  const localExists =
    sh("git", ["branch", "--list", branch]).trim() !== "";

  // Detach so we can manipulate any branch (including the one HEAD is
  // currently on) without confusing git.
  sh("git", ["checkout", "--detach", "origin/main"]);

  // Case 1: nothing to resume.
  if (!localExists && !remoteExists) {
    log(`creating ${branch} off origin/main (no prior work to resume)`);
    sh("git", ["checkout", "-b", branch, "origin/main"]);
    return { branch, resumed: false };
  }

  // Case 2/3 setup: reset local to origin/<branch> if it exists (origin
  // is the source of truth — that's what reviewers see on the PR), then
  // try to merge origin/main into it.
  const source = remoteExists ? `origin/${branch}` : branch;
  log(
    `prior work found on ${branch} (local=${localExists}, remote=${remoteExists}); ` +
      `resuming from ${source} and merging origin/main in`,
  );
  if (localExists) {
    sh("git", ["branch", "-D", branch]);
  }
  sh("git", ["checkout", "-b", branch, source]);

  // The merge: `--no-edit` keeps git's default merge-commit message,
  // `--no-ff` forces a merge commit even when fast-forward is possible
  // so the branch's history clearly shows the resume point.
  const mergeRes = spawnSync(
    "git",
    ["merge", "origin/main", "--no-edit", "--no-ff", "-m", `Merge origin/main into ${branch} (resume)`],
    { cwd: ROOT, encoding: "utf8" },
  );
  if (mergeRes.status === 0) {
    log(`resumed ${branch}: origin/main merged in cleanly`);
    return { branch, resumed: true };
  }

  // Case 3: merge conflict → fall back to fresh start.
  const stderr = (mergeRes.stderr ?? "").trim();
  log(
    `merge of origin/main into ${branch} hit conflicts (status=${mergeRes.status}):\n${stderr || "(no stderr)"}\n` +
      `→ falling back to fresh-start behavior; abandoning prior work on ${branch}`,
  );
  try {
    sh("git", ["merge", "--abort"]);
  } catch {
    // best-effort — if --abort fails (e.g. nothing to abort), keep going
  }
  sh("git", ["checkout", "--detach", "origin/main"]);
  sh("git", ["branch", "-D", branch]);
  sh("git", ["checkout", "-b", branch, "origin/main"]);
  return { branch, resumed: false };
}

// ── package.json bump ─────────────────────────────────────────────────

function bumpSdkDependency(version: string): void {
  const pkgPath = resolve(ROOT, "package.json");
  const raw = readFileSync(pkgPath, "utf8");

  // Idempotency: when resuming a branch (checkoutFreshBranch case 2)
  // the SDK bump is already in place from the prior firing. Detect
  // that case and skip the rewrite + `bun install`. Without this, the
  // regex replace below would be a no-op (`next === raw`) and we'd
  // throw "pattern miss" — losing the resume — AND `bun install`
  // would re-stamp the lockfile timestamp for no diff.
  const currentMatch = raw.match(
    new RegExp(`"${escapeRegExp(SDK_PKG_NAME)}"\\s*:\\s*"([^"]+)"`),
  );
  if (currentMatch && currentMatch[1] === `^${version}`) {
    log(`${SDK_PKG_NAME} already at ^${version} — skipping bump (resumed branch)`);
    return;
  }

  // Keep the file's exact formatting (trailing newline, key order) by
  // doing a surgical regex replace rather than JSON.parse round-trip —
  // package.json is also read by bun's lockfile rebuilder, and a
  // formatting drift would noisify the diff for no reason.
  const next = raw.replace(
    new RegExp(
      `("${escapeRegExp(SDK_PKG_NAME)}"\\s*:\\s*")([^"]+)(")`,
    ),
    `$1^${version}$3`,
  );
  if (next === raw) {
    throw new Error(
      `failed to rewrite ${SDK_PKG_NAME} version in package.json — pattern miss`,
    );
  }
  writeFileSync(pkgPath, next, "utf8");
  log(`bumped ${SDK_PKG_NAME} → ^${version} in package.json`);
  log(`running bun install (this also refreshes the lockfile)`);
  const code = shStream("bun", ["install"]);
  if (code !== 0) {
    throw new Error(`bun install exited ${code}`);
  }
}

/**
 * Sync Claudius's own version to the SDK version we just took. The UI renders
 * `${version}.${release}` where `release` is the number of commits since the
 * `version` field last changed — computed from git at build time (see
 * scripts/claudius-release.mjs + next.config.ts), with no stored counter. So
 * the commit this function produces becomes the new anchor and the trailing
 * component automatically resets to .0, no extra field to touch.
 *
 * `version` stays 3-part semver so electron-builder / macOS notarization
 * don't choke on a 4-component bundle version — the 4th component lives only
 * in the displayed string.
 *
 * Surgical regex replace (no JSON round-trip) to match `bumpSdkDependency`'s
 * formatting-preserving approach. Runs right after the dep bump so the single
 * follow-up commit carries both edits.
 */
function bumpClaudiusVersion(version: string): void {
  const pkgPath = resolve(ROOT, "package.json");
  const raw = readFileSync(pkgPath, "utf8");

  // Idempotency mirror of `bumpSdkDependency` — when resuming an
  // existing branch the top-level version is already at the target,
  // and the regex-replace below would be a no-op that throws "pattern
  // miss". Detect + skip cleanly.
  const currentMatch = raw.match(/"version"\s*:\s*"([^"]+)"/);
  if (currentMatch && currentMatch[1] === version) {
    log(`claudius version already at ${version} — skipping bump (resumed branch)`);
    return;
  }

  // Top-level "version" is the first "version": key in the file (the SDK dep
  // key is "@anthropic-ai/claude-agent-sdk", a different token), so an
  // unanchored first-match replace is safe.
  const next = raw.replace(
    /("version"\s*:\s*")([^"]+)(")/,
    `$1${version}$3`,
  );
  if (next === raw) {
    throw new Error(
      "failed to rewrite top-level version in package.json — pattern miss",
    );
  }

  writeFileSync(pkgPath, next, "utf8");
  log(`set claudius version → ${version} (release counter auto-resets via git)`);
}

// ── Changelog extraction ──────────────────────────────────────────────

/**
 * Try, in order:
 *   1. `node_modules/@anthropic-ai/claude-agent-sdk/CHANGELOG.md` —
 *      sliced between the two version headers. Cheapest, but the
 *      package doesn't always ship the file in the npm tarball.
 *   2. Raw CHANGELOG.md from the UPSTREAM_GH repo at the new
 *      version's tag, via `gh api`. This is the canonical source —
 *      every release commits an update here — so it's the path that
 *      actually works for this SDK.
 *   3. `gh api compare` commit list. Last-resort fallback: low signal
 *      (often dominated by "chore: Update CHANGELOG.md" meta-commits)
 *      but better than nothing if both upstream paths fail.
 *
 * We never want changelog failure to block the run; Claude can still
 * read the upstream repo via the compare URL we bake into the PR body.
 */
function extractChangelog(prevVersion: string, newVersion: string): string {
  const compareUrl = `https://github.com/${UPSTREAM_GH}/compare/v${prevVersion}...v${newVersion}`;

  // 1. Local node_modules CHANGELOG.md, if present.
  const localPath = resolve(
    ROOT,
    "node_modules",
    SDK_PKG_NAME,
    "CHANGELOG.md",
  );
  if (existsSync(localPath)) {
    try {
      const sliced = sliceChangelog(
        readFileSync(localPath, "utf8"),
        prevVersion,
        newVersion,
      );
      if (sliced) {
        log(`changelog source: local node_modules CHANGELOG.md`);
        return sliced;
      }
    } catch (err) {
      log(`local CHANGELOG.md parse failed: ${String(err)} — falling back to upstream`);
    }
  }

  // 2. Upstream CHANGELOG.md at the new tag. `Accept: …raw` returns
  //    the file body instead of the JSON content-API envelope, so we
  //    can hand it straight to sliceChangelog().
  try {
    const raw = sh("gh", [
      "api",
      `repos/${UPSTREAM_GH}/contents/CHANGELOG.md?ref=v${newVersion}`,
      "-H",
      "Accept: application/vnd.github.raw",
    ]);
    if (raw.trim() !== "") {
      const sliced = sliceChangelog(raw, prevVersion, newVersion);
      if (sliced) {
        log(`changelog source: upstream CHANGELOG.md at v${newVersion}`);
        return sliced;
      }
      // The file exists but our slicing heuristic missed the headings
      // (maybe upstream changed the format). Better to give Claude the
      // full file with a note than to fall through to the commit-list
      // fallback whose signal is much worse.
      log(`changelog source: upstream CHANGELOG.md (slice missed — returning full file)`);
      return `_(could not slice upstream CHANGELOG.md between v${prevVersion} and v${newVersion} — returning full file. Section headers may have changed format; see ${compareUrl})_\n\n${raw}`;
    }
  } catch (err) {
    log(`upstream CHANGELOG.md fetch failed: ${String(err)} — falling back to compare`);
  }

  // 3. Commit list — low signal, last resort.
  try {
    const compare = sh("gh", [
      "api",
      `repos/${UPSTREAM_GH}/compare/v${prevVersion}...v${newVersion}`,
      "--jq",
      ".commits[] | \"- \" + (.commit.message | split(\"\\n\")[0]) + \" (\" + .sha[0:7] + \")\"",
    ]);
    if (compare.trim() !== "") {
      log(`changelog source: compare commit list (low signal — upstream CHANGELOG.md unreachable)`);
      return `_(commit list — could not fetch upstream CHANGELOG.md; this output is dominated by "chore: Update CHANGELOG.md" meta-commits and is low signal. Open ${compareUrl} for the real diff.)_\n\n${compare}`;
    }
  } catch (err) {
    log(`gh compare API fallback failed: ${String(err)}`);
  }

  return `_(automatic changelog extraction failed — see ${compareUrl})_`;
}

/**
 * Parse a Keep-a-Changelog-shaped file and return everything between
 * the `## [<newVersion>]` (or `## <newVersion>`) heading and the
 * `## [<prevVersion>]` (or `## <prevVersion>`) heading, exclusive of
 * the older heading. Returns null if either marker is missing.
 *
 * Exported so unit tests can pin the slicing without a network/file
 * dependency.
 */
export function sliceChangelog(
  source: string,
  prevVersion: string,
  newVersion: string,
): string | null {
  const lines = source.split(/\r?\n/);
  const heading = (v: string) =>
    new RegExp(`^##\\s+\\[?v?${escapeRegExp(v)}\\]?`, "i");
  const newIdx = lines.findIndex((l) => heading(newVersion).test(l));
  const prevIdx = lines.findIndex((l) => heading(prevVersion).test(l));
  if (newIdx < 0) return null;
  const end = prevIdx > newIdx ? prevIdx : lines.length;
  return lines.slice(newIdx, end).join("\n").trim();
}

/**
 * Return just the one `## [<version>]` section from a Keep-a-Changelog
 * file — everything from that heading up to (but excluding) the next
 * `## ` heading. Returns null if the version heading is missing.
 *
 * `sliceChangelog(prev, new)` can't do this when `prev === new` (its
 * `end` falls through to EOF and you get the whole tail), so the
 * SDK-PR "Claude Code is already current → show the latest release
 * notes" path needs this dedicated single-section slicer.
 *
 * Exported so unit tests can pin it without a network/file dependency.
 */
export function sliceSingleSection(
  source: string,
  version: string,
): string | null {
  const lines = source.split(/\r?\n/);
  const heading = new RegExp(`^##\\s+\\[?v?${escapeRegExp(version)}\\]?`, "i");
  const start = lines.findIndex((l) => heading.test(l));
  if (start < 0) return null;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^##\s+/.test(lines[i]!)) {
      end = i;
      break;
    }
  }
  return lines.slice(start, end).join("\n").trim();
}

// ── Prompt rendering ──────────────────────────────────────────────────

function renderPrompt(
  prevVersion: string,
  newVersion: string,
  changelog: string,
): string {
  const tpl = readFileSync(resolve(SCRIPT_DIR, "prompt.md"), "utf8");
  return tpl
    .replace(/\{\{PREVIOUS_VERSION\}\}/g, prevVersion)
    .replace(/\{\{NEW_VERSION\}\}/g, newVersion)
    .replace(/\{\{CHANGELOG_BLOCK\}\}/g, changelog);
}

// ── Claude run ────────────────────────────────────────────────────────

/**
 * Build a short, greppable summary of one SDK message for the cron
 * log. We want enough signal to tell "Claude is reading the SDK
 * source" from "Claude is editing run-notes" from "Claude is in a
 * tight retry loop" — without the megabyte of payload that lives in
 * the full transcript JSONL.
 *
 * Shape:
 *   type=assistant tool=Read path=/foo
 *   type=assistant tool=Bash cmd="bun run lint"
 *   type=assistant text="I'll start by reading…"
 *   type=user      tool_result tool=Read 1240 bytes
 *   type=user      tool_result tool=Bash exited 0
 *   type=system    subtype=init
 *   type=result    subtype=success cost=$0.42 duration=37s
 *
 * Best-effort: any field we can't introspect falls back to the bare
 * type/subtype pair (the previous behavior).
 */
export function summarizeSdkMessage(msg: unknown): string {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const m = msg as any;
  const type: string = m?.type ?? "?";
  const subtype: string = m?.subtype ?? "-";

  // The SDK wraps the underlying Anthropic message under `.message` for
  // assistant/user types. Tool blocks live in message.content[*].
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const content: any[] = Array.isArray(m?.message?.content) ? m.message.content : [];

  function clip(s: unknown, n = 80): string {
    const str = typeof s === "string" ? s : JSON.stringify(s ?? "");
    const oneLine = str.replace(/\s+/g, " ").trim();
    return oneLine.length > n ? `${oneLine.slice(0, n)}…` : oneLine;
  }

  if (type === "assistant") {
    // Priority order: tool_use > thinking > text. A single assistant
    // message often pairs a tool call with a one-liner of surrounding
    // text; the tool name is the more useful signal for cron logs.
    // Scan the WHOLE content for each kind in turn instead of returning
    // on the first informative block (which would let an earlier text
    // block hide a later tool_use).
    const toolUse = content.find((b) => b?.type === "tool_use");
    if (toolUse) {
      const name = toolUse.name ?? "?";
      const input = toolUse.input ?? {};
      // Pick the input field that's most diagnostic per tool. These
      // are the standard tools shipped in the bundled CLI; unknown
      // tools fall through to a generic input snippet.
      let detail = "";
      if (name === "Read" || name === "Edit" || name === "Write" || name === "NotebookEdit") {
        detail = input.file_path ? ` path=${input.file_path}` : "";
      } else if (name === "Bash") {
        detail = input.command ? ` cmd=${JSON.stringify(clip(input.command, 60))}` : "";
      } else if (name === "Grep" || name === "Glob") {
        detail = input.pattern ? ` pattern=${JSON.stringify(clip(input.pattern, 40))}` : "";
      } else if (name === "WebFetch" || name === "WebSearch") {
        detail = input.url ? ` url=${input.url}` : input.query ? ` query=${JSON.stringify(clip(input.query, 40))}` : "";
      } else if (Object.keys(input).length > 0) {
        detail = ` input=${JSON.stringify(clip(input, 60))}`;
      }
      return `type=assistant tool=${name}${detail}`;
    }
    const thinking = content.find((b) => b?.type === "thinking");
    if (thinking) {
      return `type=assistant thinking ${JSON.stringify(clip(thinking.thinking, 60))}`;
    }
    const text = content.find((b) => b?.type === "text");
    if (text) {
      return `type=assistant text=${JSON.stringify(clip(text.text, 60))}`;
    }
    return `type=assistant subtype=${subtype}`;
  }

  if (type === "user") {
    // User messages from the agent loop are tool results. Surface the
    // tool the result is for (by id-matching it back to the previous
    // assistant tool_use would require state; instead just show the
    // result size and is-error flag).
    for (const block of content) {
      if (block?.type === "tool_result") {
        const text = typeof block.content === "string"
          ? block.content
          : Array.isArray(block.content)
            ? (block.content.find((c: { type?: string; text?: string }) => c?.type === "text")?.text ?? "")
            : "";
        const size = text.length;
        const flag = block.is_error ? " ERROR" : "";
        return `type=user      tool_result ${size}B${flag}`;
      }
    }
    return `type=user      subtype=${subtype}`;
  }

  if (type === "result") {
    // Final result envelope — has cost + duration in well-known fields.
    const cost = typeof m.total_cost_usd === "number"
      ? ` cost=$${m.total_cost_usd.toFixed(4)}`
      : "";
    const dur = typeof m.duration_ms === "number"
      ? ` duration=${Math.round(m.duration_ms / 1000)}s`
      : "";
    const turns = typeof m.num_turns === "number" ? ` turns=${m.num_turns}` : "";
    return `type=result    subtype=${subtype}${cost}${dur}${turns}`;
  }

  // system, stream_event, etc. — bare type/subtype is enough.
  return `type=${type.padEnd(9)} subtype=${subtype}`;
}

// After this many CUMULATIVE dead-stream tool errors across the run we
// abort. cc-parity 2.1.197 burned an entire firing this way: every
// Write/Edit/Bash-mutation returned "Tool permission request failed:
// Error: Stream closed", so Claude could read but never land an edit,
// spinning uselessly toward the turn budget and producing nothing.
//
// The count is CUMULATIVE, not consecutive-reset-on-success: a dead WRITE
// stream leaves READS working (the incident's own words: "reads still
// work fine"), so the message sequence is Read(ok) → Edit(dead) →
// Read(ok) → Edit(dead)…. A consecutive counter reset by the successful
// reads would never trip. A healthy run produces ~0 dead-stream errors;
// a dead-write run produces dozens — so a cumulative threshold is both
// safe against false positives and reliable against the real failure.
// Overridable via env for debugging.
const DEAD_STREAM_ABORT_THRESHOLD = Math.max(
  1,
  Number(process.env.SDK_UPDATE_DEAD_STREAM_ABORT ?? "15"),
);

/**
 * Scan one SDK message's tool_result blocks and count how many are the
 * "dead tool-execution stream" signature vs how many succeeded. A dead
 * stream means the SDK's tool channel is throwing on every call — the
 * canonical text is "Tool permission request failed: Error: Stream
 * closed" — so reads may work but no mutation ever lands.
 *
 * Exported for unit tests.
 */
export function classifyToolResults(msg: unknown): {
  deadStream: number;
  ok: number;
} {
  const content = (msg as { message?: { content?: unknown } })?.message?.content;
  if (!Array.isArray(content)) return { deadStream: 0, ok: 0 };
  let deadStream = 0;
  let ok = 0;
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    const b = block as { type?: string; is_error?: boolean; content?: unknown };
    if (b.type !== "tool_result") continue;
    if (!b.is_error) {
      ok++;
      continue;
    }
    const text = Array.isArray(b.content)
      ? b.content
          .map((c) =>
            c && typeof c === "object" && "text" in c
              ? String((c as { text?: unknown }).text ?? "")
              : "",
          )
          .join(" ")
      : String(b.content ?? "");
    if (/stream closed|tool permission request failed/i.test(text)) deadStream++;
  }
  return { deadStream, ok };
}

/**
 * Hand the prompt to the Agent SDK. We import `query` dynamically so
 * the orchestrator stays importable in environments without the SDK
 * (e.g. running just `check.ts` from a slimmer container).
 *
 * Returns `{ completed, turnCount, wallMs }`. `completed = true` when
 * the iterator drained naturally; `false` means we hit the budget
 * abort. The caller decides what to do with a budget-aborted run.
 */
export async function runClaude(prompt: string, transcriptFile?: string): Promise<{
  completed: boolean;
  turnCount: number;
  wallMs: number;
  budgetReason: string | null;
  /**
   * The SDK session UUID for this run, captured from the first message
   * that carries one (the `system`/`init` message). Persisted by the
   * SDK under `~/.claude/projects/<cwd-hash>/` so a human can resume the
   * conversation with `claude --resume <sessionId>` from the repo root.
   * `null` if the iterator closed before emitting any message with a
   * `session_id` (e.g. the 0-message auth-failure mode).
   */
  sessionId: string | null;
}> {
  // Importable check ahead of any orchestration. If the freshly-
  // installed SDK fails to load, throw a useful error instead of a
  // silent empty-iterator (the 0-byte-transcript symptom seen on
  // sdk-update/0.3.143 was driven by us not having any visibility
  // into the bundled CLI's auth state at this point).
  let sdk: { query: (args: unknown) => AsyncIterable<unknown> & { interrupt?: () => Promise<void> } };
  let sdkVersion = "unknown";
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    sdk = (await import(SDK_PKG_NAME)) as any;
    try {
      const pkgPath = resolve(ROOT, "node_modules", SDK_PKG_NAME, "package.json");
      const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { version?: string };
      sdkVersion = pkg.version ?? "unknown";
    } catch {
      // best-effort — only used for the log line below
    }
  } catch (err) {
    throw new Error(
      `failed to import @anthropic-ai/claude-agent-sdk after bun install: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  log(`Claude Agent SDK loaded — version=${sdkVersion}`);
  if (typeof sdk.query !== "function") {
    throw new Error(
      `SDK ${sdkVersion} did not export a query() function. The orchestrator's call pattern may need updating for this version.`,
    );
  }
  const query = sdk.query;

  const startedAt = Date.now();
  const deadline = startedAt + MAX_WALL_MS;
  let turnCount = 0;
  let completed = false;
  let budgetReason: string | null = null;
  // First-seen SDK session UUID. Every SDKMessage carries `session_id`;
  // we latch the first one so the PR body can print a `claude --resume`
  // handle for the human who picks the run up.
  let sessionId: string | null = null;

  // Streamed transcript — one JSON object per line so it's trivially
  // greppable (`jq -c '.type' transcript.jsonl | sort | uniq -c` to
  // see which message types showed up). Each append flushes synchronously
  // so even a hard-kill leaves a partial-but-valid file behind.
  let transcriptFd: number | null = null;
  if (transcriptFile) {
    // Truncate any prior transcript for this version so re-runs start
    // fresh. We don't care about preserving the old one — if the
    // operator wants forensics on a previous run they should copy the
    // file aside before retrying.
    writeFileSync(transcriptFile, "");
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const fs = require("node:fs") as typeof import("node:fs");
    transcriptFd = fs.openSync(transcriptFile, "a");
  }
  const appendTranscript = (msg: unknown) => {
    if (transcriptFd === null) return;
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const fs = require("node:fs") as typeof import("node:fs");
      fs.writeSync(transcriptFd, JSON.stringify(msg) + "\n");
    } catch {
      // Best-effort — never let transcript IO crash the upgrade.
    }
  };

  // Capture stderr from the bundled `cli.js` subprocess. This is the
  // only window we have into auth / startup failures that don't
  // surface as iterator errors. We tee to (a) the cron log via our
  // `log()` and (b) the per-version transcript file as a synthetic
  // `{type:"stderr"}` line so post-mortems are self-contained.
  const stderrAppend = (chunk: string) => {
    const trimmed = chunk.replace(/\r?\n$/, "");
    if (!trimmed) return;
    log(`claude stderr: ${trimmed}`);
    appendTranscript({ type: "stderr", data: trimmed });
  };

  // Auto-approve every tool call. We use this instead of
  // `permissionMode: "bypassPermissions"` + `allowDangerouslySkipPermissions`
  // because the bundled CLI explicitly refuses the dangerous flag
  // when the process runs as root (see sdk-update/0.3.143 stderr:
  // "--dangerously-skip-permissions cannot be used with root/sudo
  // privileges for security reasons"). Going through `canUseTool`
  // sidesteps that check while keeping the headless behavior. It's
  // also a single chokepoint where future policy could land (e.g.
  // "refuse writes outside the repo cwd").
  const autoApprove = async (
    _toolName: string,
    input: Record<string, unknown>,
  ): Promise<{ behavior: "allow"; updatedInput: Record<string, unknown> }> => ({
    behavior: "allow",
    updatedInput: input,
  });

  const q = query({
    prompt,
    options: {
      cwd: ROOT,
      model: MODEL,
      // Default permission mode — every tool call routes through
      // canUseTool, which we wire to autoApprove below.
      permissionMode: "default",
      canUseTool: autoApprove,
      // Hard ceiling on agentic round-trips. The SDK enforces this on
      // its side; we *also* watch wall-clock below in case a single
      // turn drags on (long tool call, network hang).
      maxTurns: MAX_TURNS,
      // Enable the dynamic Workflow tool so the agent can fan the
      // migration out across sub-agents (audit → implement → adversarial
      // verify → gate-fix loop), driven by the "Step 0" section of
      // prompt.md. `enableWorkflows` exposes the tool, which is off by
      // plan default when no settings are loaded. We do NOT need to
      // suppress the auto-mode workflow-usage warning: under
      // permissionMode "default" + the autoApprove canUseTool above it
      // never gates execution — verified headless via
      // scripts/sdk-update/verify-workflow.ts, where the tool fires, a
      // background workflow's result round-trips back into this
      // for-await loop, and task_progress messages keep the idle
      // watchdog fed (max gap ~2s « 15min).
      //
      // We deliberately do NOT set `ultracode`: it forces a workflow for
      // *every* step "with token cost not a constraint", which fights
      // MAX_TURNS / wall-clock on a run nobody babysits. enableWorkflows
      // + the prompt gives the same decompose/verify behaviour with the
      // budget caps intact.
      settings: {
        enableWorkflows: true,
      },
      // SDK 0.2.x onwards accepts a `stderr` callback that receives
      // each chunk written by the bundled CLI subprocess. Without
      // this, a fatal "no auth" / "model not found" / etc. message
      // from the CLI is invisible — the iterator just closes silently
      // and you're left with a 0-byte transcript.
      stderr: stderrAppend,
    },
  });

  // The SDK's `query` iterator emits one SDKMessage per agent step.
  // We don't need to inspect bodies here — the model writes its
  // results to the working tree, which we'll gate after the loop.
  // We log a one-liner per message so cron logs stay grep-able.
  //
  // The summarizer inspects message.content for the most informative
  // hint about what Claude is doing (tool name, text preview, etc.)
  // instead of just printing `type=assistant subtype=-` which gives
  // an operator no idea whether a 100-message burst is real progress
  // (reads/edits/greps) or a stuck loop.
  // Idle watchdog. Tracks the timestamp of the most recent SDK message
  // and trips when the gap exceeds MAX_IDLE_MS. The runaway case this
  // catches is a tool subprocess (most often Bash) that hung — the
  // iterator's `next()` just never resolves and `for await` blocks
  // forever, well below the wall-clock ceiling. With this guard the
  // operator gets a clear "stuck on …" log line and the run exits to
  // a draft/needs-human PR within ~MAX_IDLE_MS instead of waiting out
  // the full 6h budget. We also emit a half-way warning at MAX_IDLE_MS/2
  // so the operator has a "this is taking a while" signal before the
  // hard abort.
  let lastMsgAt = Date.now();
  let lastMsgSummary = "(boot)";
  let warnedSlow = false;
  let idleTimedOut = false;
  // Cumulative count of dead-stream tool errors across the whole run —
  // deliberately NOT reset by successful reads (a dead write channel keeps
  // reads alive). Trips DEAD_STREAM_ABORT_THRESHOLD → fast-abort.
  let deadStreamTotal = 0;
  const idleCheck = setInterval(() => {
    const idle = Date.now() - lastMsgAt;
    if (idle > MAX_IDLE_MS && !idleTimedOut) {
      idleTimedOut = true;
      const min = Math.round(MAX_IDLE_MS / 60_000);
      log(`WARN idle ${Math.round(idle / 60_000)}min since last message — aborting (last was: ${lastMsgSummary})`);
      void Promise.resolve(q.interrupt?.()).catch(() => {
        // best-effort — if interrupt is missing, we still set
        // budgetReason below and exit the loop on the next iteration
        // (or stay stuck, in which case the wall-clock cap eventually fires).
      });
      budgetReason = `idle timeout (no SDK message in ${min} min; last was: ${lastMsgSummary})`;
    } else if (idle > MAX_IDLE_MS / 2 && !warnedSlow) {
      warnedSlow = true;
      log(`note: no SDK message in ${Math.round(idle / 60_000)}min (last was: ${lastMsgSummary}); idle timeout at ${Math.round(MAX_IDLE_MS / 60_000)}min`);
    }
  }, 30_000);

  try {
    for await (const msg of q) {
      turnCount += 1;
      lastMsgAt = Date.now();
      warnedSlow = false; // reset half-way warning on each tick of progress
      const m = msg as { type?: string; subtype?: string; session_id?: string };
      if (!sessionId && typeof m.session_id === "string" && m.session_id) {
        sessionId = m.session_id;
        log(`claude session id: ${sessionId}`);
      }
      const summary = summarizeSdkMessage(m);
      lastMsgSummary = summary;
      appendTranscript(msg);
      log(`claude msg #${turnCount} ${summary}`);
      if (idleTimedOut) break;
      // Dead tool-stream fast-abort. Cumulative — reads stay alive when
      // the write channel dies, so we must NOT reset on successful tool
      // calls or the counter never trips (see DEAD_STREAM_ABORT_THRESHOLD).
      const tr = classifyToolResults(msg);
      deadStreamTotal += tr.deadStream;
      if (deadStreamTotal >= DEAD_STREAM_ABORT_THRESHOLD && !budgetReason) {
        budgetReason =
          `dead tool-execution stream — ${deadStreamTotal} "Stream closed" ` +
          `tool errors this run. The SDK's write channel is broken; aborting ` +
          `rather than burning the turn budget on a run that cannot land an edit.`;
        log(`aborting Claude run: ${budgetReason}`);
        try {
          await q.interrupt?.();
        } catch {
          // best-effort; the loop exits on the next iteration regardless.
        }
        break;
      }
      if (Date.now() > deadline) {
        budgetReason = `wall-clock budget exhausted (${Math.round(MAX_WALL_MS / 60_000)} min)`;
        log(`aborting Claude run: ${budgetReason}`);
        try {
          await q.interrupt?.();
        } catch {
          // best-effort; we'll exit the loop on the next iteration anyway.
        }
        break;
      }
    }
    completed = budgetReason === null;
    if (turnCount === 0) {
      // Empty iterator with no thrown error = silent failure mode.
      // Most common causes: bundled CLI couldn't authenticate, the
      // installed SDK version's query() shape changed, or the model
      // refused to start. Surface this as a budget reason so the
      // orchestrator opens a draft + needs-human rather than treating
      // it as a clean "no changes needed" run.
      budgetReason =
        `Claude produced 0 messages — iterator closed without yielding. ` +
        `Check the per-version transcript and the cron log for stderr lines from the bundled CLI ` +
        `(common causes: auth not found, model alias rejected, CLI version mismatch).`;
      log(`WARN ${budgetReason}`);
    }
  } catch (err) {
    log(`claude iterator threw: ${err instanceof Error ? err.message : String(err)}`);
    budgetReason = `iterator error: ${err instanceof Error ? err.message : String(err)}`;
  } finally {
    clearInterval(idleCheck);
    if (transcriptFd !== null) {
      try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const fs = require("node:fs") as typeof import("node:fs");
        fs.closeSync(transcriptFd);
      } catch {
        // ignore
      }
    }
  }

  return {
    completed,
    turnCount,
    wallMs: Date.now() - startedAt,
    budgetReason,
    sessionId,
  };
}

// ── Gate (lint / unit / build / e2e) ──────────────────────────────────

export type GateStep = "lint" | "unit" | "build" | "e2e";
export type GateResult = {
  step: GateStep;
  ok: boolean;
  skipped?: boolean;
  /**
   * Last N lines of stdout+stderr from the command. Populated for every
   * non-skipped step (so a green step can still be read for diagnostic
   * context if a later step's failure references it). Empty on skipped
   * steps. The downstream `buildGateFailureBanner` reads this to render
   * the actionable tail into the PR body / issue extras.
   */
  tailOutput?: string;
};

export const ALL_GATE_STEPS: readonly GateStep[] = ["lint", "unit", "build", "e2e"];

/**
 * Parse a comma-separated list of gate step names into a Set, with
 * permissive handling: unknown names log a warning but don't fatal —
 * easier to evolve the gate without breaking existing env files.
 * Exported for unit tests.
 */
export function parseSkipGates(raw: string | undefined): Set<GateStep> {
  if (!raw) return new Set();
  const out = new Set<GateStep>();
  for (const name of raw.split(",").map((s) => s.trim()).filter(Boolean)) {
    if ((ALL_GATE_STEPS as readonly string[]).includes(name)) {
      out.add(name as GateStep);
    } else {
      log(`WARN: --skip-gates contains unknown step "${name}" — ignoring`);
    }
  }
  return out;
}

// Per-step wall-clock caps for the gate. A gate step that runs longer
// than this is treated as a failure (exit 124) rather than being allowed
// to hang indefinitely — see shStreamCapture's `timeoutMs`. Defaults are
// generous multiples of a healthy run (a green e2e suite is ~15min) so
// only a genuinely wedged step trips them. Overridable per-step via env
// for slow hosts, e.g. GATE_TIMEOUT_E2E_MIN=60.
function gateTimeoutMs(step: GateStep): number {
  const envMin = (name: string, fallback: number): number => {
    const raw = process.env[name];
    const n = raw ? Number(raw) : NaN;
    return (Number.isFinite(n) && n > 0 ? n : fallback) * 60_000;
  };
  switch (step) {
    case "lint":
      return envMin("GATE_TIMEOUT_LINT_MIN", 15);
    case "unit":
      return envMin("GATE_TIMEOUT_UNIT_MIN", 15);
    case "build":
      return envMin("GATE_TIMEOUT_BUILD_MIN", 20);
    case "e2e":
      return envMin("GATE_TIMEOUT_E2E_MIN", 45);
  }
}

export async function runGate(skip: Set<GateStep>): Promise<GateResult[]> {
  const steps: Array<{ step: GateStep; cmd: string; args: string[]; env?: Record<string, string> }> = [
    { step: "lint", cmd: "bun", args: ["run", "lint"] },
    { step: "unit", cmd: "bun", args: ["run", "test"] },
    { step: "build", cmd: "bun", args: ["run", "build"] },
    // Run the e2e step with CI=1 so it mirrors the GitHub Actions gate
    // EXACTLY — which is the real mergeability bar. Two concrete effects
    // (see playwright.config.ts): `retries: CI ? 2 : 0` and
    // `headless: !!CI`.
    //
    // Why this matters: the orchestrator runs as a cron job, NOT inside
    // GitHub Actions, so `CI` was unset → retries=0. A SINGLE flaky e2e
    // (the model-picker panel-open race has musical-chaired across runs:
    // specs 253/276/327/364 on different firings) sank the whole gate,
    // opened a draft + needs-human, and stalled the upgrade — even
    // though the very same suite passes on the PR's GitHub CI with
    // retries=2. Aligning the gate to CI stops the orchestrator from
    // being stricter than the bar the PR actually has to clear. Genuine
    // (deterministic) failures still fail all 3 attempts and trip the
    // gate, so this doesn't mask real regressions.
    { step: "e2e", cmd: "bun", args: ["run", "test:e2e"], env: { CI: "1" } },
  ];
  const out: GateResult[] = [];
  for (const s of steps) {
    if (skip.has(s.step)) {
      log(`gate: ${s.step} SKIPPED (--skip-gates)`);
      // A skipped step is counted as "ok" for the all-green check so
      // that an operator who skips e2e during local iteration can
      // still get a clean PR. The audit trail (the SKIPPED line in
      // cron.log + the rendered banner in the PR body) keeps reviewers
      // honest about what wasn't checked.
      out.push({ step: s.step, ok: true, skipped: true });
      continue;
    }
    log(`gate: ${s.step}${s.env ? ` (env: ${Object.keys(s.env).join(",")})` : ""}`);
    // shStreamCapture streams to the cron log AND retains the last 80
    // lines so a failure can be surfaced in the GitHub issue + draft PR
    // body. e2e is the most useful target — Playwright's tail names the
    // failing tests + file:line, which is exactly what an operator needs
    // to debug without ssh'ing onto the cron host.
    const { code, tail, timedOut } = await shStreamCapture(
      s.cmd,
      s.args,
      s.env ? { env: { ...process.env, ...s.env } } : {},
      80,
      gateTimeoutMs(s.step),
    );
    out.push({ step: s.step, ok: code === 0, tailOutput: tail });
    if (timedOut) {
      log(
        `gate: ${s.step} TIMED OUT (killed after ${Math.round(gateTimeoutMs(s.step) / 60_000)}min) — treating as a failed gate`,
      );
    } else if (code !== 0) {
      log(`gate: ${s.step} FAILED (exit ${code})`);
    }
  }
  return out;
}

/**
 * Format a gate's failed steps into a markdown block suitable for
 * embedding in BOTH a draft PR body (via `{{BUDGET_STATUS}}`) and a
 * GitHub issue body (via the `extras` array on `buildRunIssue`).
 *
 * The motivation: before this, a local-gate failure filed a one-line
 * "kind=local gates failed" issue and left the operator to ssh into the
 * cron host to find out WHICH tests failed. With the tail captured per
 * step in `GateResult.tailOutput`, we can paste the actionable failure
 * detail straight into both surfaces — issue reviewer + PR reviewer see
 * exactly the same content the cron log carried, no separate trip.
 *
 * Output shape: one collapsible `<details>` per failed step, with the
 * tail inside a fenced code block. Collapsing keeps the issue body
 * scannable when multiple gates failed (e.g. lint AND e2e). When no
 * step failed (all green or all skipped), returns "" — callers can
 * pass the result through unconditionally.
 *
 * Exported for unit tests.
 */
export function buildGateFailureBanner(gate: GateResult[]): string {
  const failed = gate.filter((g) => !g.ok && !g.skipped);
  if (failed.length === 0) return "";

  // Map the gate-step enum to the command that produced its output, so
  // the banner names what the reviewer would type to reproduce.
  const cmd = (step: GateStep): string => {
    switch (step) {
      case "lint":
        return "bun run lint";
      case "unit":
        return "bun run test";
      case "build":
        return "bun run build";
      case "e2e":
        return "bun run test:e2e";
    }
  };

  const lines: string[] = [
    "> ⚠️ **Local gate failed — opened as draft with `needs-human`.**",
    ">",
    "> Claude returned cleanly but the post-Claude gate suite found failures. The branch carries Claude's work as-is. Pull the branch locally, fix the failures (often a flaky test or a missed migration), push, and mark ready — or re-run via `make sdk-update-fix-pr PR=<n>` to let Claude iterate.",
    "",
    `**Failed steps:** ${failed.map((f) => `\`${f.step}\``).join(", ")}`,
    "",
  ];
  for (const step of failed) {
    const tail = step.tailOutput?.trim() || "_(no output captured for this step)_";
    lines.push(
      `<details><summary><strong>${step.step}</strong> — <code>${cmd(step.step)}</code> (click to expand tail)</summary>`,
      "",
      "```",
      tail,
      "```",
      "",
      "</details>",
      "",
    );
  }
  return lines.join("\n");
}

// ── Run-notes & PR body ───────────────────────────────────────────────

function runNotesPath(version: string): string {
  return resolve(ROOT, ".claudius", "sdk-updater", "run-notes", `${version}.md`);
}

/**
 * Where we mirror the rendered prompt for post-mortem inspection.
 * Sits next to the run-notes so all the per-version artifacts live in
 * one folder.
 */
function promptArchivePath(version: string): string {
  return resolve(ROOT, ".claudius", "sdk-updater", "run-notes", `${version}.prompt.md`);
}

/**
 * Where we stream Claude's SDK message transcript (one JSON object per
 * line). Lets the operator see what Claude actually did when something
 * looks off — e.g. did it never call Write? did it time out
 * mid-implement? did it produce a session full of read-only tool calls
 * and bail?
 */
function transcriptPath(version: string): string {
  return resolve(
    ROOT,
    ".claudius",
    "sdk-updater",
    "run-notes",
    `${version}.transcript.jsonl`,
  );
}

/**
 * Build the empty run-notes template Claude is expected to fill in.
 * Pre-creating the file (rather than asking Claude to create it from
 * scratch) shifts the failure mode from "file missing" to "sections
 * still have placeholder content" — easier for Claude to see + edit,
 * easier for the orchestrator's validator to give a useful error.
 *
 * The body of each section uses `_(TODO …)_` so validateRunNotesContent
 * flags it as placeholder if Claude doesn't touch it.
 */
function runNotesStub(prevVersion: string, newVersion: string): string {
  return [
    `# SDK update ${prevVersion} → ${newVersion}`,
    ``,
    `<!--`,
    `  This file is the PRIMARY DELIVERABLE for the SDK-update bot.`,
    `  The orchestrator parses each \`## \` section into the PR body.`,
    `  Replace EVERY \`_(TODO …)_\` placeholder with real content before`,
    `  finalizing — the gate fails the run if any section is still empty`,
    `  or placeholder.`,
    `-->`,
    ``,
    `## Summary`,
    ``,
    `_(TODO: one paragraph — what changed in the SDK, what we changed in`,
    `Claudius, the headline risk to flag for review.)_`,
    ``,
    `## SDK changelog highlights`,
    ``,
    `_(TODO: bulleted list of upstream changelog items, each marked`,
    `[shipped] / [type-only] / [skipped — reason]. Cover every item that`,
    `touches a public SDK export.)_`,
    ``,
    `## Code changes`,
    ``,
    `_(TODO: bulleted list of files / subsystems touched, with one-line`,
    `justifications. If no code changes were needed, write a single bullet`,
    `\`- No code changes required.\` and expand the reason in 2–3 sentences.)_`,
    ``,
    `## New UI surfaces`,
    ``,
    `_(TODO: one bullet per new/changed UI element. Each bullet must list`,
    `(a) the screenshot path under docs/sdk-updates/${newVersion}/, (b) the`,
    `Playwright spec under tests/e2e/ that captured it, and (c) a one-line`,
    `note on the context the shot was taken in. The screenshot must show`,
    `the element in real surrounding chrome — see Step 6 of prompt.md. If`,
    `none, write \`- No new UI surfaces this release.\` with a reason.)_`,
    ``,
    `## Tests`,
    ``,
    `_(TODO: vitest count, playwright count, anything explicitly not`,
    `covered with reason.)_`,
    ``,
    `## Risks / follow-ups`,
    ``,
    `_(TODO: what the next human should look at. \`- None identified.\` is`,
    `a valid answer if you're sure.)_`,
    ``,
  ].join("\n");
}

/**
 * Pull a `## Section name` block out of a markdown file, exclusive of
 * the next `## `. Exported for unit tests — the regex shape is the
 * exact thing reviewers will trip on if they rename a heading in the
 * run-notes template.
 */
export function extractSection(md: string, heading: string): string {
  const re = new RegExp(`(^|\\n)## +${heading}[^\\n]*\\n([\\s\\S]*?)(?=\\n## |$)`);
  const m = md.match(re);
  return m ? m[2]!.trim() : `_(run-notes did not include a "${heading}" section)_`;
}

/**
 * Sections that MUST be present in run-notes for the PR body to be
 * meaningful. Names must match the headings in prompt.md exactly.
 */
export const REQUIRED_RUN_NOTE_SECTIONS = [
  "Summary",
  "SDK changelog highlights",
  "Code changes",
  "New UI surfaces",
  "Tests",
  "Risks / follow-ups",
] as const;

/**
 * Pure content validator — given the markdown body of a run-notes
 * file, return null when all six required sections are present with
 * non-trivial content, or a reason string when something's missing.
 *
 * "Non-trivial" is intentionally lax — we just want to catch the
 * empty-PR failure mode where Claude forgot to write the file or
 * wrote it with only the bare headings. Anything more substantive
 * than placeholder text passes; we don't try to grade prose quality
 * here, that's what human review is for.
 *
 * Split out from `validateRunNotes` so unit tests can hit it without
 * a temp file on disk.
 */
export function validateRunNotesContent(md: string): string | null {
  const missing: string[] = [];
  for (const section of REQUIRED_RUN_NOTE_SECTIONS) {
    const re = new RegExp(`(^|\\n)## +${section}[^\\n]*\\n([\\s\\S]*?)(?=\\n## |$)`);
    const m = md.match(re);
    if (!m) {
      missing.push(`"${section}" heading not found`);
      continue;
    }
    const body = m[2]!.trim();
    // Trivial content = empty, single placeholder, or only common
    // skeleton tokens. We don't try to parse meaning; we just refuse
    // to ship a section whose body is < 20 chars or matches obvious
    // boilerplate.
    //
    // The `_(TODO …)_` pattern is the one the orchestrator writes
    // into the stub itself, so it must be detected here — otherwise
    // an unedited stub passes validation (the bug just caught in
    // sdk-update/0.3.143). Match both `_(TODO`-prefixed and bare
    // `TODO`-prefixed bodies, and treat a single italicised
    // placeholder line (any `_(...)_` wrapping) as boilerplate too.
    // Note: no `XXX` here — case-insensitive matching would collide
    // with the `"x".repeat(N)` filler used in the unit-test boundary
    // checks, and FIXME already covers the same intent.
    const placeholderRe =
      /^(_+\(?\s*)?(TODO|TBD|FIXME|\(none\)|N\/A|-\s*$)/i;
    const isItalicisedPlaceholderOnly = /^_+\([^)]*\)_+\s*$/.test(body);
    if (
      body.length < 20 ||
      placeholderRe.test(body) ||
      isItalicisedPlaceholderOnly
    ) {
      missing.push(`"${section}" section is empty or placeholder`);
    }
  }
  if (missing.length > 0) {
    return `run-notes file is incomplete: ${missing.join("; ")}`;
  }
  return null;
}

/**
 * Validate that the run-notes file Claude was told to produce
 * actually exists and is meaningful. Returns null on success, or a
 * human-readable reason string on failure. The caller treats a
 * non-null result the same as a red gate: PR opens as draft +
 * needs-human.
 */
function validateRunNotes(version: string): string | null {
  const path = runNotesPath(version);
  if (!existsSync(path)) {
    return `run-notes file is missing at ${relative(ROOT, path)} — ` +
      `Claude was told to write it as the primary deliverable, see prompt.md`;
  }
  return validateRunNotesContent(readFileSync(path, "utf8"));
}

function listScreenshots(version: string): string[] {
  const dir = resolve(ROOT, "docs", "sdk-updates", version);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => /\.(png|jpg|jpeg|gif|webp)$/i.test(f))
    .sort();
}

function repoSlug(): string {
  // origin URL is the source of truth — works for both SSH and HTTPS
  // remotes. Falls back to `gh repo view` if the regex doesn't match.
  const origin = sh("git", ["remote", "get-url", "origin"]);
  const m = origin.match(/github\.com[:/]+([^/]+)\/([^/]+?)(?:\.git)?$/);
  if (m) return `${m[1]}/${m[2]}`;
  return sh("gh", ["repo", "view", "--json", "nameWithOwner", "--jq", ".nameWithOwner"]);
}

function buildScreenshotsBlock(branch: string, version: string): string {
  const files = listScreenshots(version);
  if (files.length === 0) {
    return "_(no screenshots captured — see run notes for why.)_";
  }
  const slug = repoSlug();
  const lines = files.map((f) => {
    const rel = `docs/sdk-updates/${version}/${f}`;
    const alt = f.replace(/\.[^.]+$/, "").replace(/[-_]+/g, " ");
    return `![${alt}](https://raw.githubusercontent.com/${slug}/${branch}/${rel})`;
  });
  return lines.join("\n\n");
}

/**
 * GitHub's GraphQL API rejects any issue / PR / comment body longer
 * than 65536 **characters** — `createPullRequest`, `createIssue`, and
 * `addComment` all share the cap. Exceeding it on `gh pr create` is
 * exactly what crashed issue #90 (a combined upgrade whose CC changelog
 * fell through `extractChangelog`'s "returning full file" branch and
 * dumped the entire CHANGELOG.md into the PR body).
 */
const GH_BODY_LIMIT = 65536;

/**
 * Per-changelog cap for the PR body. `extractChangelog()` returns the
 * **whole** CHANGELOG.md when its heading-slice misses (the
 * `returning full file` fallback) — for claude-code that's hundreds of
 * versions and easily tens of thousands of chars. Clamp each changelog
 * at the source so the template's run-notes / risks sections (the part
 * a reviewer most needs) survive; `clampGitHubBody` at the `gh` sink
 * stays as a last-resort backstop.
 */
const MAX_PR_CHANGELOG = 20000;
function clampChangelogForPr(changelog: string): string {
  if (changelog.length <= MAX_PR_CHANGELOG) return changelog;
  return (
    changelog.slice(0, MAX_PR_CHANGELOG) +
    "\n\n_(changelog truncated — full text at the compare URL above)_"
  );
}

/**
 * Last-resort clamp applied at every `gh` body sink (PR create/edit,
 * issue create/comment) so a body can never trip GitHub's
 * `GH_BODY_LIMIT`. `.length` counts UTF-16 code units, which is always
 * ≥ the codepoint count GitHub measures, so a body ≤ MAX by `.length`
 * is guaranteed under the real character limit even though this file is
 * full of emoji.
 *
 * `keep: "head"` (default) drops the tail — right for PR bodies, whose
 * template leads with the versions, compare URLs and summary. `keep:
 * "tail"` drops the head — right for crash reports, where the
 * actionable error tail is the whole point.
 */
export function clampGitHubBody(
  body: string,
  keep: "head" | "tail" = "head",
): string {
  // Conservative ceiling under the hard 65536 to leave room for the
  // marker and any code-unit/codepoint slack.
  const MAX = 60000;
  if (body.length <= MAX) return body;
  if (keep === "tail") {
    const marker = `_(…earlier output truncated — exceeded GitHub's ${GH_BODY_LIMIT}-char body limit)_\n\n`;
    return marker + body.slice(body.length - (MAX - marker.length));
  }
  const marker = `\n\n_(truncated — exceeded GitHub's ${GH_BODY_LIMIT}-char body limit; see the compare URLs above for full detail)_`;
  return body.slice(0, MAX - marker.length) + marker;
}

export function renderPrBody(args: {
  branch: string;
  prevVersion: string;
  newVersion: string;
  changelog: string;
  /**
   * Claude Code (NOT SDK) changelog body. Every SDK-bump PR surfaces
   * "what's new in Claude Code" too, so a reader doesn't have to wait
   * for a separate cc-parity PR to see it. Already-rendered markdown
   * (a slice or a graceful "couldn't fetch" string) — never a literal
   * placeholder. Defaults to a neutral note when the caller omits it
   * (e.g. older call sites / tests that don't exercise the CC section).
   */
  ccChangelog?: string;
  /** Compare/release URL for the CC changelog above. */
  ccChangelogUrl?: string;
  budgetWarning: string;
  /** Override for tests; production reads pr-template.md. */
  template?: string;
  /** Override for tests; production reads dirs under docs/. */
  screenshotsBlock?: string;
}): string {
  const notesFile = runNotesPath(args.newVersion);
  const notes = existsSync(notesFile) ? readFileSync(notesFile, "utf8") : "";
  const tpl =
    args.template ?? readFileSync(resolve(SCRIPT_DIR, "pr-template.md"), "utf8");
  const ccChangelog =
    args.ccChangelog ??
    "_(Claude Code changelog not resolved this run — see https://github.com/anthropics/claude-code/releases)_";
  const ccChangelogUrl =
    args.ccChangelogUrl ?? "https://github.com/anthropics/claude-code/releases";

  return tpl
    .replace(/\{\{NEW_VERSION\}\}/g, args.newVersion)
    .replace(/\{\{PREVIOUS_VERSION\}\}/g, args.prevVersion)
    .replace(
      /\{\{CHANGELOG_URL\}\}/g,
      `https://github.com/${UPSTREAM_GH}/compare/v${args.prevVersion}...v${args.newVersion}`,
    )
    .replace(/\{\{CHANGELOG_BODY\}\}/g, clampChangelogForPr(args.changelog))
    .replace(/\{\{CC_CHANGELOG_URL\}\}/g, ccChangelogUrl)
    .replace(/\{\{CC_CHANGELOG_BODY\}\}/g, clampChangelogForPr(ccChangelog))
    .replace(/\{\{NOTES_SUMMARY\}\}/g, extractSection(notes, "Summary"))
    .replace(/\{\{NOTES_SDK\}\}/g, extractSection(notes, "SDK changelog highlights"))
    .replace(/\{\{NOTES_CODE\}\}/g, extractSection(notes, "Code changes"))
    .replace(/\{\{NOTES_UI\}\}/g, extractSection(notes, "New UI surfaces"))
    .replace(/\{\{NOTES_TESTS\}\}/g, extractSection(notes, "Tests"))
    .replace(/\{\{NOTES_RISKS\}\}/g, extractSection(notes, "Risks / follow-ups"))
    .replace(
      /\{\{SCREENSHOTS_BLOCK\}\}/g,
      args.screenshotsBlock ??
        buildScreenshotsBlock(args.branch, args.newVersion),
    )
    .replace(/\{\{BUDGET_STATUS\}\}/g, args.budgetWarning);
}

/**
 * Best-effort Claude Code changelog for the (non-combined) SDK PR.
 *
 * The user wants every SDK-bump PR to surface "what's new in Claude
 * Code", not just the combined-mode PRs. We reuse the cc-parity
 * baseline (last fully-processed CC version) → latest published CC
 * version. When CC is already current (baseline === latest, i.e. the
 * cc-parity pipeline is caught up), we show just the latest section —
 * that IS "the latest Claude Code release notes".
 *
 * gh-independent: fetches the raw CHANGELOG over `curl` (tag-pinned
 * first, then `main`) so a missing/unauth `gh` on the cron host never
 * drops the section. Never throws — the SDK PR must ship regardless.
 */
async function resolveCcChangelogForSdkPr(): Promise<{
  body: string;
  url: string;
}> {
  const releasesUrl = "https://github.com/anthropics/claude-code/releases";
  try {
    const latest = await fetchCcLatestVersion();
    const ccState = readCcState(ROOT);
    const rawBaseline =
      ccState.lastCompletedVersion ?? ccState.lastSeenVersion ?? null;
    const prev = rawBaseline ? cleanRange(rawBaseline) : null;
    const hasRange = prev != null && prev !== latest;
    const url = hasRange
      ? `https://github.com/anthropics/claude-code/compare/v${prev}...v${latest}`
      : `https://github.com/anthropics/claude-code/releases/tag/v${latest}`;

    let raw = "";
    try {
      raw = sh("curl", [
        "-fsSL",
        `https://raw.githubusercontent.com/anthropics/claude-code/v${latest}/CHANGELOG.md`,
      ]);
    } catch {
      raw = sh("curl", [
        "-fsSL",
        "https://raw.githubusercontent.com/anthropics/claude-code/main/CHANGELOG.md",
      ]);
    }
    if (raw.trim() === "") {
      return {
        body: `_(could not fetch the Claude Code changelog this run — see ${url})_`,
        url,
      };
    }

    const body = hasRange
      ? (sliceChangelog(raw, prev!, latest) ?? sliceSingleSection(raw, latest))
      : sliceSingleSection(raw, latest);
    return {
      body:
        body ??
        `_(could not slice the Claude Code changelog at v${latest} — see ${url})_`,
      url,
    };
  } catch (err) {
    log(
      `WARN could not build Claude Code changelog for SDK PR: ${String(err)}`,
    );
    return {
      body: `_(Claude Code changelog unavailable this run — see ${releasesUrl})_`,
      url: releasesUrl,
    };
  }
}

// ── Combined-mode helpers (SDK + CC parity on one branch) ────────────

/**
 * Cc-parity run-notes path on disk. Kept here (rather than reaching
 * into the CC orchestrator module) so the combined-mode helpers can be
 * pure functions of the on-disk state, no cycle with cc-parity/orchestrate.
 */
function ccRunNotesPath(version: string): string {
  return resolve(ROOT, ".claudius", "cc-parity", "run-notes", `${version}.md`);
}

/**
 * Section extractor that handles regex metacharacters in the heading,
 * inlined here to avoid importing `extractCcSection` from
 * cc-parity/orchestrate.ts (that import would create a cycle:
 * cc-parity/orchestrate already imports from sdk-update/orchestrate).
 *
 * Mirrors `extractSection` higher up, but runs the heading through the
 * existing `escapeRegExp` so cc-parity's `Implemented (bucket B)` and
 * `Risks / follow-ups` headings match literally.
 *
 * Exported only for the combined-mode PR body renderer's tests.
 */
export function extractEscapedSection(md: string, heading: string): string {
  const re = new RegExp(
    `(^|\\n)## +${escapeRegExp(heading)}[^\\n]*\\n([\\s\\S]*?)(?=\\n## |$)`,
  );
  const m = md.match(re);
  return m
    ? m[2]!.trim()
    : `_(run-notes did not include a "${heading}" section)_`;
}

/**
 * Build the screenshots block for the combined PR. Walks BOTH
 * `docs/sdk-updates/<sdk-v>/` and `docs/cc-parity/<cc-v>/`, emits one
 * raw.githubusercontent.com URL per image with a `### Source` header
 * separating the two halves so reviewers can see which pipeline
 * produced what.
 *
 * Exported for unit tests.
 */
export function buildCombinedScreenshotsBlock(args: {
  branch: string;
  sdkVersion: string;
  ccVersion: string;
  /** Override file listing for tests; production reads from disk. */
  listSdk?: () => string[];
  listCc?: () => string[];
  repoSlug?: string;
}): string {
  const sdkFiles = args.listSdk?.() ?? listScreenshots(args.sdkVersion);
  const ccFiles = args.listCc?.() ?? listCcScreenshots(args.ccVersion);
  if (sdkFiles.length === 0 && ccFiles.length === 0) {
    return "_(no screenshots captured by either half — see run notes for why.)_";
  }
  const slug = args.repoSlug ?? repoSlug();
  const sdkBlock = sdkFiles.length
    ? [
        "### SDK half — `docs/sdk-updates/" + args.sdkVersion + "/`",
        "",
        ...sdkFiles.map((f) => {
          const rel = `docs/sdk-updates/${args.sdkVersion}/${f}`;
          const alt = f.replace(/\.[^.]+$/, "").replace(/[-_]+/g, " ");
          return `![${alt}](https://raw.githubusercontent.com/${slug}/${args.branch}/${rel})`;
        }),
      ].join("\n\n")
    : "";
  const ccBlock = ccFiles.length
    ? [
        "### CC parity half — `docs/cc-parity/" + args.ccVersion + "/`",
        "",
        ...ccFiles.map((f) => {
          const rel = `docs/cc-parity/${args.ccVersion}/${f}`;
          const alt = f.replace(/\.[^.]+$/, "").replace(/[-_]+/g, " ");
          return `![${alt}](https://raw.githubusercontent.com/${slug}/${args.branch}/${rel})`;
        }),
      ].join("\n\n")
    : "";
  return [sdkBlock, ccBlock].filter(Boolean).join("\n\n");
}

function listCcScreenshots(version: string): string[] {
  const dir = resolve(ROOT, "docs", "cc-parity", version);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => /\.(png|jpg|jpeg|gif|webp)$/i.test(f))
    .sort();
}

/**
 * Render the combined PR body. Pure: takes already-read run-notes
 * markdown strings (rather than reading files), so unit tests can hit
 * it without a filesystem fixture and so this function avoids any
 * dependency on `cc-parity/orchestrate.ts`'s internals (cycle-safe).
 */
export function renderCombinedPrBody(args: {
  branch: string;
  prevSdkVersion: string;
  newSdkVersion: string;
  sdkChangelog: string;
  sdkRunNotes: string;
  prevCcVersion: string;
  newCcVersion: string;
  ccChangelog: string;
  ccRunNotes: string;
  budgetWarning: string;
  /** Override for tests; production reads pr-template-combined.md. */
  template?: string;
  /** Override for tests — production reads dirs under docs/. */
  screenshotsBlock?: string;
}): string {
  const tpl =
    args.template ??
    readFileSync(resolve(SCRIPT_DIR, "pr-template-combined.md"), "utf8");

  // Pull each half's sections.
  const sdkSummary = extractSection(args.sdkRunNotes, "Summary");
  const sdkSdkSection = extractSection(args.sdkRunNotes, "SDK changelog highlights");
  const sdkCode = extractSection(args.sdkRunNotes, "Code changes");
  const sdkUi = extractSection(args.sdkRunNotes, "New UI surfaces");
  const sdkTests = extractSection(args.sdkRunNotes, "Tests");
  const sdkRisks = extractSection(args.sdkRunNotes, "Risks / follow-ups");

  // CC headings include regex metacharacters — use the escaped extractor.
  const ccSummary = extractEscapedSection(args.ccRunNotes, "Summary");
  const ccClassification = extractEscapedSection(args.ccRunNotes, "Changelog classification");
  const ccImplemented = extractEscapedSection(args.ccRunNotes, "Implemented (bucket B)");
  const ccUi = extractEscapedSection(args.ccRunNotes, "New UI surfaces");
  const ccTests = extractEscapedSection(args.ccRunNotes, "Tests");
  const ccRisks = extractEscapedSection(args.ccRunNotes, "Risks / follow-ups");

  const combinedUi = [
    `**From SDK half:**\n\n${sdkUi}`,
    `**From CC parity half:**\n\n${ccUi}`,
  ].join("\n\n");
  const combinedTests = [
    `**From SDK half:**\n\n${sdkTests}`,
    `**From CC parity half:**\n\n${ccTests}`,
  ].join("\n\n");
  const combinedRisks = [
    `**From SDK half:**\n\n${sdkRisks}`,
    `**From CC parity half:**\n\n${ccRisks}`,
  ].join("\n\n");

  const screenshots =
    args.screenshotsBlock ??
    buildCombinedScreenshotsBlock({
      branch: args.branch,
      sdkVersion: args.newSdkVersion,
      ccVersion: args.newCcVersion,
    });

  return tpl
    .replace(/\{\{NEW_SDK_VERSION\}\}/g, args.newSdkVersion)
    .replace(/\{\{PREVIOUS_SDK_VERSION\}\}/g, args.prevSdkVersion)
    .replace(
      /\{\{SDK_CHANGELOG_URL\}\}/g,
      `https://github.com/${UPSTREAM_GH}/compare/v${args.prevSdkVersion}...v${args.newSdkVersion}`,
    )
    .replace(/\{\{SDK_CHANGELOG_BODY\}\}/g, clampChangelogForPr(args.sdkChangelog))
    .replace(/\{\{NEW_CC_VERSION\}\}/g, args.newCcVersion)
    .replace(/\{\{PREVIOUS_CC_VERSION\}\}/g, args.prevCcVersion)
    .replace(
      /\{\{CC_CHANGELOG_URL\}\}/g,
      `https://github.com/anthropics/claude-code/compare/v${args.prevCcVersion}...v${args.newCcVersion}`,
    )
    .replace(/\{\{CC_CHANGELOG_BODY\}\}/g, clampChangelogForPr(args.ccChangelog))
    .replace(/\{\{SDK_NOTES_SUMMARY\}\}/g, sdkSummary)
    .replace(/\{\{SDK_NOTES_SDK\}\}/g, sdkSdkSection)
    .replace(/\{\{SDK_NOTES_CODE\}\}/g, sdkCode)
    .replace(/\{\{CC_NOTES_SUMMARY\}\}/g, ccSummary)
    .replace(/\{\{CC_NOTES_CLASSIFICATION\}\}/g, ccClassification)
    .replace(/\{\{CC_NOTES_IMPLEMENTED\}\}/g, ccImplemented)
    .replace(/\{\{COMBINED_NOTES_UI\}\}/g, combinedUi)
    .replace(/\{\{COMBINED_NOTES_TESTS\}\}/g, combinedTests)
    .replace(/\{\{COMBINED_NOTES_RISKS\}\}/g, combinedRisks)
    .replace(/\{\{COMBINED_SCREENSHOTS_BLOCK\}\}/g, screenshots)
    .replace(/\{\{BUDGET_STATUS\}\}/g, args.budgetWarning);
}

// ── Combined-mode announcement builders ───────────────────────────────

/** Start announcement for a combined run — replaces the SDK-only start. */
export function buildCombinedStartAnnouncement(args: {
  prevSdkVersion: string;
  newSdkVersion: string;
  prevCcVersion: string;
  newCcVersion: string;
  branch: string;
}): string {
  return [
    `🆕 **Combined upgrade — SDK ${args.prevSdkVersion} → ${args.newSdkVersion} + CC parity ${args.prevCcVersion} → ${args.newCcVersion}.**`,
    "",
    `Starting combined upgrade on branch \`${args.branch}\` — SDK migration first, then CC parity on the same branch.`,
    `SDK compare: https://github.com/${UPSTREAM_GH}/compare/v${args.prevSdkVersion}...v${args.newSdkVersion}`,
    `CC compare: https://github.com/anthropics/claude-code/compare/v${args.prevCcVersion}...v${args.newCcVersion}`,
  ].join("\n");
}

/**
 * Combined implementation summary — fires after BOTH the SDK and CC
 * Claude runs finish, lifting the `## Summary` section from each
 * half's run-notes. Used in combined mode in place of the SDK-only
 * implementation-summary announce. Degrades gracefully when one or
 * both summaries are still the stub placeholder.
 *
 * Per spec §6: "Implementation announcement: combined summary lifting
 * both run-notes' `## Summary` sections."
 */
export function buildCombinedImplementationAnnouncement(args: {
  prevSdkVersion: string;
  newSdkVersion: string;
  prevCcVersion: string;
  newCcVersion: string;
  sdkSummary: string;
  ccSummary: string;
}): string {
  const looksPlaceholder = (s: string) => {
    const t = s.trim();
    return !t || /^_+\(/.test(t) || /^TODO/i.test(t) || /^_\(run-notes did not include/.test(t);
  };
  const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s);
  const SDK_MAX = 700;
  const CC_MAX = 700;
  const sdkBody = looksPlaceholder(args.sdkSummary)
    ? "_(SDK run-notes Summary missing — gate may flag.)_"
    : clip(args.sdkSummary.trim(), SDK_MAX);
  const ccBody = looksPlaceholder(args.ccSummary)
    ? "_(CC run-notes Summary missing — gate may flag.)_"
    : clip(args.ccSummary.trim(), CC_MAX);
  return [
    `🛠️ **Claude finished both halves — SDK ${args.prevSdkVersion} → ${args.newSdkVersion} + CC parity ${args.prevCcVersion} → ${args.newCcVersion}.**`,
    "",
    `**SDK summary:**`,
    sdkBody,
    "",
    `**CC parity summary:**`,
    ccBody,
  ].join("\n");
}

/**
 * Combined gate result — mentions both versions when both halves are
 * green. Used in place of the SDK-only gate-result announce on a
 * combined firing.
 */
export function buildCombinedGateResultAnnouncement(args: {
  prevSdkVersion: string;
  newSdkVersion: string;
  prevCcVersion: string;
  newCcVersion: string;
  sdkOk: boolean;
  ccOk: boolean;
}): string {
  if (args.sdkOk && args.ccOk) {
    return (
      `✅ Local gates green for combined **SDK ${args.prevSdkVersion} → ${args.newSdkVersion} + ` +
      `CC parity ${args.prevCcVersion} → ${args.newCcVersion}**. Opening combined PR and watching CI next.`
    );
  }
  const halves: string[] = [];
  if (!args.sdkOk) halves.push("SDK half failed");
  if (!args.ccOk) halves.push("CC parity half failed");
  return (
    `⚠ Local gates partial for combined **SDK ${args.prevSdkVersion} → ${args.newSdkVersion} + ` +
    `CC parity ${args.prevCcVersion} → ${args.newCcVersion}**: ${halves.join("; ")}.`
  );
}

/** Combined PR-opened announcement. */
export function buildCombinedOpenedAnnouncement(args: {
  prUrl: string;
  prevSdkVersion: string;
  newSdkVersion: string;
  prevCcVersion: string;
  newCcVersion: string;
  created: boolean;
}): string {
  const verb = args.created ? "opened" : "updated";
  return [
    `**Combined upgrade — SDK ${args.prevSdkVersion} → ${args.newSdkVersion} + CC parity ${args.prevCcVersion} → ${args.newCcVersion}** — PR ${verb}, watching CI.`,
    "",
    `PR: ${args.prUrl}`,
  ].join("\n");
}

/** Combined shipped milestone. */
export function buildCombinedShippedAnnouncement(args: {
  prUrl: string;
  prevSdkVersion: string;
  newSdkVersion: string;
  prevCcVersion: string;
  newCcVersion: string;
}): string {
  return [
    `**Combined upgrade — SDK ${args.prevSdkVersion} → ${args.newSdkVersion} + CC parity ${args.prevCcVersion} → ${args.newCcVersion}** has shipped to Claudius.`,
    "",
    `PR: ${args.prUrl}`,
  ].join("\n");
}

/**
 * Pure state-coordination helper: given the combined run's outcome,
 * decide which state files to patch. Returns the patches the caller
 * should apply via `patchState` / `patchCcState`. No I/O, no globals —
 * the test asserts on these patches directly.
 *
 * Modes:
 *   - "combined-success":      both halves green → both states get
 *                              `lastCompletedVersion` bumped.
 *   - "combined-draft":        SDK shipped (CI green), CC drafted on its
 *                              own branch → both states get
 *                              `lastCompletedVersion` bumped (so the
 *                              standalone CC cron doesn't refire on the
 *                              same CC version).
 *   - "sdk-failure-cc-draft":  SDK PR is itself still draft+needs-human
 *                              (CI red after fix attempts), AND the CC
 *                              half was peeled to a detached draft
 *                              branch on origin → SDK state stays
 *                              un-bumped (the SDK PR didn't ship), but
 *                              CC state DOES get bumped (the CC version
 *                              is handled this firing as a draft; the
 *                              standalone cron must not refire on it).
 *                              Without this distinction, an SDK CI red
 *                              + CC drafted firing would leave a
 *                              detached branch on origin with no PR
 *                              against it AND the standalone cron would
 *                              re-attempt the same CC version next
 *                              firing — two wasteful drafts for one
 *                              version pair.
 *   - "sdk-only-success":      no combined run took place OR the
 *                              combined attempt was aborted before CC
 *                              work started → only SDK state gets
 *                              `lastCompletedVersion` bumped.
 *   - "failure":               neither half completed → only `inFlight`
 *                              cleared.
 *
 * Exported for unit tests.
 */
export type CombinedStatePatches = {
  sdkPatch: {
    inFlight: null;
    lastCompletedVersion?: string;
  };
  ccPatch:
    | {
        lastCompletedVersion: string;
      }
    | null;
};

export function decideCombinedStateUpdates(args: {
  mode:
    | "combined-success"
    | "combined-draft"
    | "sdk-failure-cc-draft"
    | "sdk-only-success"
    | "failure";
  newSdkVersion: string;
  newCcVersion: string | null;
}): CombinedStatePatches {
  switch (args.mode) {
    case "combined-success":
    case "combined-draft":
      if (!args.newCcVersion) {
        // Caller bug — combined modes require a CC version. Fail
        // closed: don't pretend CC shipped if we have no version to
        // record.
        return {
          sdkPatch: { inFlight: null, lastCompletedVersion: args.newSdkVersion },
          ccPatch: null,
        };
      }
      return {
        sdkPatch: { inFlight: null, lastCompletedVersion: args.newSdkVersion },
        ccPatch: { lastCompletedVersion: args.newCcVersion },
      };
    case "sdk-failure-cc-draft":
      if (!args.newCcVersion) {
        // Caller bug — this mode requires a CC version (otherwise
        // there's no CC draft to record). Fall back to bare failure
        // semantics: don't bump anything.
        return {
          sdkPatch: { inFlight: null },
          ccPatch: null,
        };
      }
      return {
        // SDK did NOT ship — leave `lastCompletedVersion` unchanged so
        // the next firing still sees the new SDK version as the target.
        sdkPatch: { inFlight: null },
        // CC IS handled (as a draft) — bump to prevent the standalone
        // cron from re-firing on the same CC version.
        ccPatch: { lastCompletedVersion: args.newCcVersion },
      };
    case "sdk-only-success":
      return {
        sdkPatch: { inFlight: null, lastCompletedVersion: args.newSdkVersion },
        ccPatch: null,
      };
    case "failure":
      return {
        sdkPatch: { inFlight: null },
        ccPatch: null,
      };
  }
}

/**
 * Probe whether the CC parity pipeline should ride along on this
 * branch, and if so, run the CC parity work.
 *
 * Called by the SDK orchestrator AFTER the SDK gate has gone green and
 * BEFORE the branch is pushed. The CC orchestrator's
 * `runCcParityOnExistingBranch` is imported **dynamically** to break
 * the would-be cycle (cc-parity/orchestrate already statically imports
 * from this module).
 *
 * Returns:
 *   - `{ kind: "noop", reason }` — combined mode declined for `reason`;
 *     caller proceeds with the existing SDK-only flow.
 *   - `{ kind: "ran", ok, ... }` — combined mode attempted. On `ok=true`
 *     the caller renders the combined PR body and pushes both halves
 *     as one PR. On `ok=false` the caller peels CC commits off, ships
 *     SDK full, and cherry-picks CC onto a detached branch as a
 *     draft (see `peelAndShipCcDraft`).
 *
 * Throw-safety: this function CANNOT throw out of the combined branch.
 * If the CC core throws (iterator error, gate spawn crash, anything),
 * we capture the anchor SHA up-front so the caller still has the
 * information needed to peel partial commits via `git reset --hard`.
 */
type CombinedCcOutcome =
  | { kind: "noop"; reason: string }
  | {
      kind: "ran";
      ok: boolean;
      prevCcVersion: string;
      newCcVersion: string;
      changelog: string;
      summary: string;
      budgetReason: string | null;
      failedSteps: GateStep[];
      shaBeforeCcWork: string;
      /** SDK session UUID of the CC run — for the detached PR's resume handle. */
      ccSessionId: string | null;
    };

async function maybeRunCombinedCc(args: {
  prevSdkVersion: string;
  newSdkVersion: string;
  branch: string;
  skipGates: Set<GateStep>;
  announceProgress: (body: string, opts?: { pin?: boolean }) => Promise<void>;
  /**
   * The SDK half's run-notes Summary section, so the combined
   * implementation announce can pair it with the CC Summary. Caller
   * passes whatever it extracted into the SDK-only impl announce —
   * we reuse it here rather than re-reading the file.
   */
  sdkRunNotesSummary: string;
}): Promise<CombinedCcOutcome> {
  const ccState: CcUpdaterState = readCcState(ROOT);

  let ccLatest: string;
  try {
    ccLatest = await fetchCcLatestVersion();
  } catch (err) {
    log(
      `WARN cc-parity latest-version probe failed: ${err instanceof Error ? err.message : String(err)} — falling back to SDK-only`,
    );
    return { kind: "noop", reason: "cc-parity probe failed (network)" };
  }

  // Fetch a slice for the bug-fix-only filter. The decision helper
  // handles `null` as "no signal" — we DO run rather than skip.
  let changelogSlice: string | null = null;
  const baseline = ccState.lastCompletedVersion ?? ccState.lastSeenVersion;
  if (baseline) {
    const prev = cleanRange(baseline);
    try {
      changelogSlice = await fetchCcChangelogSlice(prev, ccLatest);
    } catch {
      changelogSlice = null;
    }
  }

  const maxMinorJump = Number(process.env.CC_PARITY_MAX_MINOR_JUMP ?? "1");
  const decision = decideCcCombinedRun({
    ccState,
    ccLatest,
    ccChangelogSlice: changelogSlice,
    maxMinorJump,
  });

  if (decision.kind === "noop") {
    log(`combined-mode cc-parity noop: ${decision.reason}`);
    return { kind: "noop", reason: decision.reason };
  }

  // Capture the anchor SHA BEFORE any CC work happens. This is the
  // commit the caller will reset to if the CC half fails OR throws —
  // capturing it here (rather than relying on the core's return value)
  // is what makes the throw-safety contract work.
  const shaBeforeCcWork = sh("git", ["rev-parse", "HEAD"]);
  log(`combined-mode anchor sha=${shaBeforeCcWork} (CC work starts after this)`);

  // Combined mode is on. Announce the combined start so the channel
  // hears that the SDK branch is about to absorb a CC parity tag-along
  // (the SDK-only start announce already went out earlier).
  await args.announceProgress(
    buildCombinedStartAnnouncement({
      prevSdkVersion: args.prevSdkVersion,
      newSdkVersion: args.newSdkVersion,
      prevCcVersion: decision.prevCcVersion,
      newCcVersion: decision.newCcVersion,
      branch: args.branch,
    }),
  ).catch(() => {
    // Best-effort — never let an announce failure abort combined mode.
  });

  // Dynamic import to break the cycle. cc-parity/orchestrate.ts
  // statically imports from THIS module; importing it back at the top
  // of this file would TDZ-trip cc-parity/orchestrate's `void
  // ALL_GATE_STEPS` module-level statement during the cycle.
  let ccMod: typeof import("../cc-parity/orchestrate");
  try {
    ccMod = (await import("../cc-parity/orchestrate")) as typeof import("../cc-parity/orchestrate");
  } catch (err) {
    log(`WARN dynamic import of cc-parity/orchestrate failed: ${String(err)} — falling back to SDK-only`);
    return { kind: "noop", reason: "dynamic import of cc-parity/orchestrate failed" };
  }

  // Combined-mode does NOT use the standalone CC announce stream — the
  // combined orchestrator owns the channel for this firing. The CC
  // core function still logs to the cron log as usual.
  //
  // Wrap the core in try/catch so a runtime error (iterator crash,
  // gate spawn failure, anything) ends in a `ran/ok:false` outcome
  // with the anchor SHA we already have. Without this, the throw
  // would propagate up through main()'s catch as "crashed" and the
  // SDK PR would never ship — which is exactly the outcome the spec
  // says we must avoid in the combined-mode failure path.
  //
  // Per spec §6, the CC changelog still fires as its own post (the
  // start + changelog announces stay split between SDK and CC; the
  // SDK side fired earlier in main()). We post the CC changelog
  // **before** handing off to the CC core so the channel has the
  // context Claude has when reasoning about the CC half. The CC core
  // does NOT receive an `announceProgress` callback — that would
  // double-post in combined mode.
  let ccResult: Awaited<ReturnType<typeof ccMod.runCcParityOnExistingBranch>>;
  try {
    // Reuse the slice we fetched earlier for the bug-fix-only filter
    // when present; fall back to a fresh fetch if that came back null
    // (the filter falls through to "run" on no signal, but the
    // changelog announce wants a real body).
    let ccChangelogPreview: string | null = changelogSlice;
    if (!ccChangelogPreview) {
      try {
        ccChangelogPreview = await fetchCcChangelogSlice(decision.prevCcVersion, decision.newCcVersion);
      } catch {
        ccChangelogPreview = null;
      }
    }
    if (ccChangelogPreview) {
      await args.announceProgress(
        ccMod.buildCcChangelogAnnouncement({
          prevVersion: decision.prevCcVersion,
          newVersion: decision.newCcVersion,
          changelog: ccChangelogPreview,
        }),
      ).catch(() => {});
    }
    ccResult = await ccMod.runCcParityOnExistingBranch({
      prevCcVersion: decision.prevCcVersion,
      newCcVersion: decision.newCcVersion,
      branch: args.branch,
      dryRun: false,
      skipGates: args.skipGates,
      combinedWith: { sdkPrev: args.prevSdkVersion, sdkNew: args.newSdkVersion },
    });
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    log(`WARN cc-parity core threw: ${reason} — treating as ran/ok:false so SDK still ships`);
    ccResult = {
      ok: false,
      budgetReason: `cc-parity core threw: ${reason}`,
      failedSteps: [],
      runNotesIssue: null,
      shaBeforeCcWork,
      changelog: "_(cc-parity core threw before changelog fetch)_",
      summary: "",
      sessionId: null,
    };
  }

  // Per spec §6, the combined implementation summary post pairs both
  // halves' `## Summary` sections in a single post. Fires before the
  // gate result so the channel sees what shipped before what passed.
  await args.announceProgress(
    buildCombinedImplementationAnnouncement({
      prevSdkVersion: args.prevSdkVersion,
      newSdkVersion: args.newSdkVersion,
      prevCcVersion: decision.prevCcVersion,
      newCcVersion: decision.newCcVersion,
      sdkSummary: args.sdkRunNotesSummary,
      ccSummary: ccResult.summary,
    }),
  ).catch(() => {});

  await args.announceProgress(
    buildCombinedGateResultAnnouncement({
      prevSdkVersion: args.prevSdkVersion,
      newSdkVersion: args.newSdkVersion,
      prevCcVersion: decision.prevCcVersion,
      newCcVersion: decision.newCcVersion,
      sdkOk: true, // we only got here because SDK gate was green
      ccOk: ccResult.ok,
    }),
  ).catch(() => {});

  return {
    kind: "ran",
    ok: ccResult.ok,
    prevCcVersion: decision.prevCcVersion,
    newCcVersion: decision.newCcVersion,
    changelog: ccResult.changelog,
    summary: ccResult.summary,
    budgetReason: ccResult.budgetReason,
    failedSteps: ccResult.failedSteps,
    ccSessionId: ccResult.sessionId,
    // Use the caller-captured SHA — we trust it more than the core's
    // return value (which may have a stale value if the core threw).
    shaBeforeCcWork,
  };
}

// ── Failure-mode peel + cherry-pick + detached draft ──────────────────

/**
 * A narrow git-runner interface scoped to the peel + cherry-pick path.
 *
 * Production wires this to `sh`/`shStream`. The unit test wires it to
 * a recording mock so it can assert the exact sequence of git calls
 * without ever spawning a subprocess.
 *
 * The interface deliberately covers ONLY the operations the failure
 * path needs — the rest of the orchestrator's git plumbing (the SDK
 * branch's own push, the eventual `pushBranch` on the SDK PR) keeps
 * going through the real subprocess helpers, so the recorded call log
 * in tests stays focused on the failure-mode sequence the spec names.
 */
export type GitRunner = {
  /** `git log <fromSha>..HEAD --format=%H` — returns newest-first SHA list. */
  log(fromSha: string): string[];
  /** `git reset --hard <sha>`. */
  resetHard(sha: string): void;
  /** `git checkout -b <branch> origin/main`. */
  checkoutNewBranchFromOriginMain(branch: string): void;
  /** `git cherry-pick <sha>` — throws on conflict / non-zero exit. */
  cherryPick(sha: string): void;
  /** `git cherry-pick --abort` — best-effort, never throws. */
  cherryPickAbort(): void;
  /**
   * Fetch the branch's tracking ref then push it with an explicit lease
   * (`--force-with-lease=<branch>:<expect>`) — throws on non-zero exit so
   * a push rejection bubbles to the caller, who drops CC and reports. The
   * explicit lease avoids the "(stale info)" reject the bare form throws
   * on a freshly-created tracking ref; see pushBranchWithExplicitLease.
   */
  pushForceWithLease(branch: string): void;
};

/**
 * Push `branch` to origin, overwriting whatever is there, with an
 * EXPLICIT lease — and capture the combined git output so a rejection
 * can be reported with the real cause instead of a guess.
 *
 * Why explicit `--force-with-lease=<branch>:<expect>` and never the bare
 * `--force-with-lease`: the bare form derives the expected pre-push value
 * from the remote-tracking ref's REFLOG. On the cron host the branch is
 * routinely left on origin by a prior firing while the local clone has
 * never fetched it, so the pre-push fetch CREATES the tracking ref
 * (`* [new branch]`). A just-created tracking ref has no reflog entry git
 * trusts, so the bare lease rejects EVERY such push with
 * "! [rejected] … (stale info)" — the exact loop that wedged the updater
 * (GitHub issue #61). Passing the expected sha explicitly makes git
 * compare against the value we just fetched (no reflog), which works on a
 * fresh tracking ref AND still rejects loudly if origin actually moved
 * between our fetch and the push.
 *
 * `expect` is gated on the fetch SUCCEEDING. A non-zero fetch means the
 * branch is absent on origin (deleted between firings, or first push), in
 * which case we lease the empty string — "the ref must not exist yet" —
 * so the push creates it. Reading the local tracking ref unconditionally
 * would lease a STALE sha for a since-deleted branch and re-introduce the
 * very stale-info reject we are fixing here.
 *
 * Single-writer note: run.sh's flock serializes every firing, so there is
 * no concurrent pusher to race; the explicit lease is cheap insurance
 * against an out-of-band manual push, not a load-bearing guard.
 */
function pushBranchWithExplicitLease(branch: string): {
  code: number;
  output: string;
} {
  const trackingRef = `refs/remotes/origin/${branch}`;
  // Refresh our remote-tracking ref so the lease baseline is origin's
  // actual current tip. Capture+tee rather than inherit so the output is
  // available for the failure report. A non-zero exit (branch absent on
  // origin) is fine — handled by the empty-expect create path below.
  const fetch = spawnSync(
    "git",
    ["fetch", "origin", `+refs/heads/${branch}:${trackingRef}`],
    { cwd: ROOT, encoding: "utf8" },
  );
  if (fetch.stdout) process.stdout.write(fetch.stdout);
  if (fetch.stderr) process.stderr.write(fetch.stderr);
  let expect = "";
  if (fetch.status === 0) {
    const rev = spawnSync("git", ["rev-parse", trackingRef], {
      cwd: ROOT,
      encoding: "utf8",
    });
    if (rev.status === 0) expect = (rev.stdout ?? "").trim();
  }
  // Push using gh's token as the credential helper rather than whatever
  // git's global `credential.helper` happens to be. The empty
  // `credential.helper=` first clears any inherited helper (e.g.
  // osxkeychain) so it can't shadow gh with a stale/missing entry; the
  // second installs gh. `-u` sets upstream the first time, harmless after.
  const push = spawnSync(
    "git",
    [
      "-c",
      "credential.helper=",
      "-c",
      "credential.helper=!gh auth git-credential",
      "push",
      "-u",
      `--force-with-lease=${branch}:${expect}`,
      "origin",
      branch,
    ],
    { cwd: ROOT, encoding: "utf8" },
  );
  if (push.stdout) process.stdout.write(push.stdout);
  if (push.stderr) process.stderr.write(push.stderr);
  const output = `${push.stdout ?? ""}${push.stderr ?? ""}`.trim();
  return { code: push.status ?? -1, output };
}

/** Production git runner — wires `sh`/`shStream` to the GitRunner interface. */
export function realGitRunner(): GitRunner {
  return {
    log(fromSha: string): string[] {
      const out = sh("git", ["log", `${fromSha}..HEAD`, "--format=%H"]);
      return out
        .split(/\r?\n/)
        .map((s) => s.trim())
        .filter(Boolean);
    },
    resetHard(sha: string): void {
      sh("git", ["reset", "--hard", sha]);
    },
    checkoutNewBranchFromOriginMain(branch: string): void {
      sh("git", ["checkout", "-b", branch, "origin/main"]);
    },
    cherryPick(sha: string): void {
      const code = shStream("git", ["cherry-pick", sha]);
      if (code !== 0) {
        throw new Error(`git cherry-pick ${sha} exited ${code}`);
      }
    },
    cherryPickAbort(): void {
      try {
        spawnSync("git", ["cherry-pick", "--abort"], { cwd: ROOT });
      } catch {
        // Best-effort — if abort itself fails the operator can resolve
        // by hand. The peel path's primary job is the reset, which
        // already succeeded by the time we'd reach this.
      }
    },
    pushForceWithLease(branch: string): void {
      // Explicit-lease push (see pushBranchWithExplicitLease): the bare
      // `--force-with-lease` rejects with "(stale info)" whenever origin
      // already carries this detached branch from a prior firing the local
      // clone never fetched — the same bug that wedged the SDK branch push.
      const { code, output } = pushBranchWithExplicitLease(branch);
      if (code !== 0) {
        throw new Error(
          `git push exited ${code} on detached cc-parity branch:\n${output}`,
        );
      }
    },
  };
}

/**
 * Detached branch name for the cc-parity draft when the combined run
 * peels CC commits off the SDK branch.
 *
 * The naming records both context pieces a reviewer needs at a glance:
 * which CC version this draft covers AND which SDK firing produced it.
 */
export function detachedCcBranchName(args: {
  newCcVersion: string;
  newSdkVersion: string;
}): string {
  return `cc-parity/${args.newCcVersion}-detached-from-sdk-${args.newSdkVersion}`;
}

/**
 * Peel CC commits off the SDK branch and cherry-pick them onto a
 * fresh `cc-parity/<v>-detached-from-sdk-<sdk-v>` branch off
 * `origin/main`. Returns the outcome the caller uses to decide whether
 * to push + open a draft PR.
 *
 * Semantics (per spec + the failure-mode test):
 *   - Capture the CC commit SHAs FIRST (`git log <shaBeforeCcWork>..HEAD`
 *     before any reset — afterward the range is empty).
 *   - Reverse them so the cherry-pick happens oldest-first
 *     (`git log` is newest-first; cherry-pick wants chronological).
 *   - `git reset --hard <shaBeforeCcWork>` — peels CC commits off the
 *     SDK branch. The SDK working tree returns to the post-SDK-gate
 *     state; SDK ships full from here.
 *   - `git checkout -b cc-parity/<cc-v>-detached-from-sdk-<sdk-v> origin/main`.
 *   - `git cherry-pick` each SHA in order. ANY non-zero exit (conflict
 *     or otherwise) → `cherry-pick --abort` + return "dropped". The
 *     caller drops CC entirely and reports via reportProcessIssueSafe;
 *     CC state stays untouched so the standalone cron picks up next.
 *
 * Exported (and accepts an injectable runner) so the unit test can
 * pin the exact sequence of git calls without spawning subprocesses.
 */
export type PeelOutcome =
  | { kind: "drafted"; detachedBranch: string; ccCommitShas: string[] }
  | { kind: "dropped"; reason: string };

export function peelCcCommitsToDraftBranch(args: {
  shaBeforeCcWork: string;
  newSdkVersion: string;
  newCcVersion: string;
  runner: GitRunner;
}): PeelOutcome {
  // 1. Capture CC commit SHAs BEFORE the reset (range is empty afterward).
  //    git log is newest-first; cherry-pick needs oldest-first.
  let shasNewestFirst: string[];
  try {
    shasNewestFirst = args.runner.log(args.shaBeforeCcWork);
  } catch (err) {
    return {
      kind: "dropped",
      reason: `could not enumerate CC commits to peel: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  const ccCommitShas = [...shasNewestFirst].reverse(); // oldest-first

  if (ccCommitShas.length === 0) {
    return {
      kind: "dropped",
      reason: "no CC commits to peel — the CC half produced no commits",
    };
  }

  // 2. Reset the SDK branch to the anchor — peels CC commits off.
  try {
    args.runner.resetHard(args.shaBeforeCcWork);
  } catch (err) {
    return {
      kind: "dropped",
      reason: `git reset --hard failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  // 3. Create the detached cc-parity branch off origin/main.
  const detachedBranch = detachedCcBranchName({
    newCcVersion: args.newCcVersion,
    newSdkVersion: args.newSdkVersion,
  });
  try {
    args.runner.checkoutNewBranchFromOriginMain(detachedBranch);
  } catch (err) {
    return {
      kind: "dropped",
      reason: `git checkout of ${detachedBranch} failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  // 4. Cherry-pick each SHA in chronological order. Any non-zero exit
  //    → abort + drop. We deliberately don't try to resolve conflicts
  //    here; per the failure-mode test contract, a cherry-pick conflict
  //    is treated identically to any other cherry-pick failure (drop
  //    CC, report). That keeps the failure path single-branch and
  //    matches what the test asserts.
  for (const sha of ccCommitShas) {
    try {
      args.runner.cherryPick(sha);
    } catch (err) {
      args.runner.cherryPickAbort();
      return {
        kind: "dropped",
        reason:
          `cherry-pick of ${sha} onto ${detachedBranch} failed: ` +
          (err instanceof Error ? err.message : String(err)),
      };
    }
  }

  // 5. Push the detached branch. A push rejection is treated as drop
  //    (cherry-picks succeeded but we can't get them to origin — the
  //    operator can recover from the local branch if needed; the SDK
  //    PR ships and the cron channel hears the drop reason).
  try {
    args.runner.pushForceWithLease(detachedBranch);
  } catch (err) {
    return {
      kind: "dropped",
      reason: `push of ${detachedBranch} failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  return { kind: "drafted", detachedBranch, ccCommitShas };
}

/**
 * Render the body of the detached CC draft PR. Tells the reviewer
 * exactly what happened: which SDK firing produced this branch, which
 * commits were cherry-picked, what failed on the original combined
 * branch, and what to look at first.
 */
export function buildDetachedCcPrBody(args: {
  prevCcVersion: string;
  newCcVersion: string;
  prevSdkVersion: string;
  newSdkVersion: string;
  sdkPrUrl: string;
  ccCommitShas: string[];
  ccFailReason: string;
  ccRunNotes: string;
  /**
   * The SDK session UUID of the failed CC run. When present, the body
   * prints a `claude --resume <id>` handle so the human taking this PR
   * over can pick up the exact conversation where the bot left off
   * (at the turn/wall budget). `null`/omitted → a short note explaining
   * no resumable session was captured.
   */
  ccSessionId?: string | null;
  /**
   * The detached branch the CC commits were cherry-picked onto. Used in
   * the resume command so the human lands on the right git state before
   * resuming (the session ran on the combined branch, which no longer
   * exists in that shape).
   */
  detachedBranch?: string;
}): string {
  const shaList = args.ccCommitShas.map((s) => `- ${s}`).join("\n");
  // Pull what we can from the run-notes file the CC core did write —
  // even on failure the classification section is often present.
  const ccClassification = extractEscapedSection(args.ccRunNotes, "Changelog classification");

  // "Continue this run" — the SDK persists the agent conversation under
  // ~/.claude/projects/<cwd-hash>/, so a human on the cron host can
  // resume the exact session (full context, at the turn/wall budget it
  // stopped on) with `claude --resume <id>`. We prefix a checkout of the
  // detached branch because the session ran on the *combined* branch,
  // which was reset to SDK-only and the CC commits cherry-picked here
  // under new SHAs — resuming without checking out first drops the human
  // into the wrong working tree.
  const branchForResume = args.detachedBranch ?? "<this PR's branch>";
  const resumeCmd = args.ccSessionId
    ? [
        "```bash",
        `git fetch origin ${branchForResume} \\`,
        `  && git checkout ${branchForResume} \\`,
        `  && claude --resume ${args.ccSessionId}`,
        "```",
      ].join("\n")
    : null;
  const continueSection = resumeCmd
    ? [
        "## Continue this run",
        "",
        `**Agent session:** \`${args.ccSessionId}\``,
        "",
        "Pick up the exact conversation where the bot stopped (it hit the turn/wall budget). Run from the repo root:",
        "",
        resumeCmd,
        "",
        "> **Notes.** `--resume` restores the *conversation*, not the working tree — that's why the command checks out the branch first. The session is stored on the machine that ran the firing (`~/.claude/projects/<cwd-hash>/`) and `claude --resume` only finds it from this repo's directory or one of its git worktrees; on any other machine this id is forensic metadata, not a runnable command. Resuming drops you back at the failing turn, so steer it (e.g. point it at the diagnosed root cause) rather than letting it re-thrash.",
        "",
      ]
    : [
        "## Continue this run",
        "",
        "_(No resumable agent session was captured for this run — drive the CC commits to green by hand.)_",
        "",
      ];

  return [
    `# CC parity \`${args.prevCcVersion}\` → \`${args.newCcVersion}\` (detached from SDK firing)`,
    "",
    "> ⚠️ **Draft + needs-human.** This PR was peeled off a combined SDK + CC firing whose CC half did not reach green locally. The SDK half shipped on its own PR; this branch carries the CC commits in isolation so a reviewer can take them through to landable state without blocking the SDK ship.",
    "",
    `**SDK PR (already opened, may already be merged):** ${args.sdkPrUrl}`,
    `**Originating SDK upgrade:** \`${args.prevSdkVersion}\` → \`${args.newSdkVersion}\``,
    `**CC version pair:** \`${args.prevCcVersion}\` → \`${args.newCcVersion}\``,
    "",
    "## Why this is detached",
    "",
    `The CC half of the combined firing failed: \`${args.ccFailReason}\``,
    "",
    "Rather than block the SDK ship, the orchestrator peeled the CC commits off and cherry-picked them onto this branch. The combined branch was reset to the SDK-only state and shipped as a normal SDK PR.",
    "",
    "## Cherry-picked commits (oldest-first)",
    "",
    shaList || "_(no commits — this should not happen; see run logs.)_",
    "",
    ...continueSection,
    "## CC changelog classification (from the failed run)",
    "",
    ccClassification,
    "",
    "---",
    "",
    "<sub>Opened automatically by `scripts/sdk-update/orchestrate.ts` in combined-mode failure recovery. See `.claudius/cc-parity/run-notes/" + args.newCcVersion + ".md` for what Claude produced before the half failed.</sub>",
  ].join("\n");
}

/**
 * Announcement for the SDK-shipped + CC-drafted-detached outcome.
 * Posts to the channel so reviewers see BOTH PR URLs and the reason
 * the halves split.
 */
export function buildDraftDetachedAnnouncement(args: {
  sdkPrUrl: string;
  ccPrUrl: string;
  prevSdkVersion: string;
  newSdkVersion: string;
  prevCcVersion: string;
  newCcVersion: string;
  reason: string;
}): string {
  return [
    `⚠ **Combined firing split — SDK ${args.prevSdkVersion} → ${args.newSdkVersion} shipped, CC parity ${args.prevCcVersion} → ${args.newCcVersion} drafted separately.**`,
    "",
    `Reason: ${oneLine(args.reason, 600)}`,
    "",
    `SDK PR (ready): ${args.sdkPrUrl}`,
    `CC draft (needs-human): ${args.ccPrUrl}`,
  ].join("\n");
}

/**
 * Announcement for the SDK-shipped + CC-dropped outcome (the
 * cherry-pick or detached push failed; CC work is lost from this
 * firing, the standalone cron will retry next tick).
 */
export function buildCcDroppedAnnouncement(args: {
  sdkPrUrl: string;
  prevSdkVersion: string;
  newSdkVersion: string;
  prevCcVersion: string;
  newCcVersion: string;
  ccFailReason: string;
  peelFailReason: string;
}): string {
  return [
    `⚠ **Combined firing — SDK ${args.prevSdkVersion} → ${args.newSdkVersion} shipped; CC parity ${args.prevCcVersion} → ${args.newCcVersion} dropped.**`,
    "",
    `CC half failed: ${oneLine(args.ccFailReason, 400)}`,
    `Peel/cherry-pick also failed: ${oneLine(args.peelFailReason, 400)}`,
    "",
    "The standalone cc-parity cron will re-attempt this CC version on its next firing.",
    "",
    `SDK PR: ${args.sdkPrUrl}`,
  ].join("\n");
}

// ── Push & PR ─────────────────────────────────────────────────────────

/**
 * Preflight for the "open a PR" step. Added after PRs #101 and #103 both
 * shipped as junk from the same blind spot — the orchestrator decided to
 * open a PR without first checking there was anything real left to ship:
 *   - #101: `sdk-update/0.3.198` re-fired after its work had already
 *     merged via #98, so `pushBranch` fabricated an empty "so a PR can be
 *     opened" commit and opened a 0-file PR.
 *   - #103: `cc-parity/2.1.198` re-shipped a version bump whose full
 *     feature body described work that had already merged, leaving a
 *     1-line diff under a feature-sized description.
 *
 * Returns a human-readable skip reason when there is nothing new to ship
 * on `branch`, or null when the branch carries real, unmerged work:
 *   #1 already-shipped — a PR for this exact head branch already merged
 *      into main (e.g. the combined SDK PR carried the work).
 *   #2 no real delta   — the branch introduces no file changes vs
 *      origin/main (optionally ignoring release-only paths such as a
 *      package.json version bump), so any PR would be empty/content-free.
 *
 * Callers should skip push + PR (logging the reason), NOT treat a
 * non-null result as an error — "already shipped" is a normal outcome.
 */
export function branchShipBlocker(
  branch: string,
  opts: { ignorePaths?: string[] } = {},
): string | null {
  // #1 — a PR for this head already merged into main.
  const mergedJson = spawnSync(
    "gh",
    [
      "pr",
      "list",
      "--head",
      branch,
      "--state",
      "merged",
      "--json",
      "number,url",
      "--limit",
      "1",
    ],
    { cwd: ROOT, encoding: "utf8" },
  );
  if (mergedJson.status === 0) {
    const merged = JSON.parse(mergedJson.stdout || "[]") as Array<{
      number: number;
      url: string;
    }>;
    if (merged.length > 0) {
      return `already shipped — PR #${merged[0]!.number} for '${branch}' already merged into main (${merged[0]!.url})`;
    }
  }

  // #2 — no real file delta vs origin/main. Three-dot diff is "what this
  // branch introduces since it forked from main", i.e. exactly the PR's
  // content; two-dot would also flag main's own newer commits. HEAD must
  // be on `branch` here (callers guarantee it via checkoutFreshBranch).
  // Best-effort refresh so a stale origin/main ref can't manufacture a
  // phantom diff; ignore fetch failures (offline/transient) and fall back
  // to the ref we have.
  spawnSync("git", ["fetch", "origin", "main", "--quiet"], {
    cwd: ROOT,
    encoding: "utf8",
  });
  const ignore = new Set(opts.ignorePaths ?? []);
  const changed = sh("git", ["diff", "--name-only", "origin/main...HEAD"])
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .filter((p) => !ignore.has(p));
  if (changed.length === 0) {
    const suffix =
      ignore.size > 0 ? ` (ignoring ${[...ignore].join(", ")})` : "";
    return `no real delta vs origin/main${suffix} — nothing to ship`;
  }

  return null;
}

/**
 * Best-effort "return the working tree to `main`" for the end of a
 * SUCCESSFUL run. The pipeline leaves HEAD on its feature branch when it
 * finishes; switching back to main means the local checkout — and any
 * running Claudius dev server reading these files — reflects main again
 * instead of being stranded on a parity/sdk-update branch. The feature
 * branch is already pushed to origin, so nothing is lost.
 *
 * Never throws: a failure (no local `main`, a dirty tree, a detached CI
 * checkout) is logged and swallowed so it can't mask the run's real
 * outcome or wedge the pipeline. Callers MUST only invoke this on success
 * — on failure the run should stay on the branch so a human can debug it.
 */
export function returnToMainBestEffort(): void {
  const res = spawnSync("git", ["checkout", "main"], {
    cwd: ROOT,
    encoding: "utf8",
  });
  if (res.status === 0) {
    log("switched working tree back to main");
  } else {
    log(
      `WARN could not switch back to main (staying on current branch): ` +
        `${(res.stderr ?? "").trim() || `git checkout main exited ${res.status}`}`,
    );
  }
}

export function pushBranch(branch: string): void {
  // Safety gate: pushBranch must run with HEAD on the very branch it is about
  // to push. If HEAD were on `main`, any of Claude's commits (historically
  // also a fabricated `--allow-empty` marker commit, now removed — see the
  // guard below) would land directly on local main — which then can't
  // fast-forward to origin/main and wedges the hourly sync FOREVER. That is
  // exactly how the empty "so a PR can be opened" commit (df385ed) once
  // stalled the whole pipeline. `--abbrev-ref` returns "HEAD" when detached,
  // which also fails this check (we never want to commit/push from detached).
  const head = sh("git", ["rev-parse", "--abbrev-ref", "HEAD"]);
  if (head !== branch) {
    throw new Error(
      `pushBranch: HEAD is on '${head}', expected '${branch}'. Refusing to ` +
        `commit or push — a marker commit here would land on the wrong ` +
        `branch (this is how an empty commit once wedged main).`,
    );
  }
  // Guard (added after PR #101): never fabricate an empty commit just to
  // open a PR. If nothing is committed ahead of origin/main there is
  // genuinely nothing to ship — the old `--allow-empty` "so a PR can be
  // opened" fallback produced a 0-file PR (exactly how #101 happened),
  // NOT the "draft PR pointing at the dependency bump" it claimed (a real
  // bump is itself a commit, so this branch only fires when even that is
  // absent). Refuse loudly so a no-op re-fire surfaces to a human instead
  // of silently opening junk. Callers that can foresee this should gate on
  // `branchShipBlocker(branch)` and skip cleanly before reaching here.
  const commitsAhead = sh("git", ["log", "origin/main..HEAD", "--oneline"]);
  if (commitsAhead.trim() === "") {
    throw new Error(
      `pushBranch: '${branch}' has no commits ahead of origin/main — ` +
        `nothing to ship. Refusing to fabricate an empty commit to open a ` +
        `PR (this is how PR #101 shipped an empty "so a PR can be opened" ` +
        `commit). If the work already merged, this re-fire is a no-op — see ` +
        `branchShipBlocker().`,
    );
  }
  // Idempotency on re-run: a previous firing may have left the branch on
  // origin. We already nuked the local copy in checkoutFreshBranch and built
  // fresh on top of origin/main, so our local tree IS the canonical state and
  // we deliberately overwrite whatever is on origin for this branch. The
  // fetch + explicit lease that makes that safe (and dodges the "(stale info)"
  // reject that wedged issue #61) lives in pushBranchWithExplicitLease.
  const { code: pushCode, output: pushOutput } =
    pushBranchWithExplicitLease(branch);
  if (pushCode !== 0) {
    // Earlier this hardcoded "gh credentials don't have write access" — a
    // guess that sent issue #61 chasing gh auth when the real cause was a
    // stale-info lease reject (now fixed). Surface the ACTUAL git output so
    // the next failure is diagnosable instead of misattributed. A genuine
    // auth failure shows up as "403"/"Permission denied" in that output;
    // the fix there is `gh auth login --git-protocol https --web` (or a PAT
    // with `repo` / Contents+PR Write). A "(stale info)" line means origin
    // moved under us — re-run.
    throw new Error(
      `git push exited ${pushCode} — refusing to attempt PR open.\n` +
        `git output:\n${pushOutput || "(no output captured)"}`,
    );
  }
}

export function openPr(args: {
  branch: string;
  newVersion: string;
  prevVersion: string;
  body: string;
  draft: boolean;
}): { url: string; created: boolean } {
  const title = `chore(deps): bump claude-agent-sdk ${args.prevVersion} → ${args.newVersion}`;
  // Backstop: never let a PR body trip GitHub's 65536-char cap (issue #90).
  const body = clampGitHubBody(args.body);

  // Idempotency: if a PR already exists for this branch (previous
  // firing got this far), update its body rather than failing. We
  // still re-write title/body so the latest run's notes win.
  const existingJson = spawnSync(
    "gh",
    ["pr", "list", "--head", args.branch, "--state", "open", "--json", "url,isDraft"],
    { cwd: ROOT, encoding: "utf8" },
  );
  const existing = existingJson.status === 0
    ? (JSON.parse(existingJson.stdout || "[]") as Array<{ url: string; isDraft: boolean }>)
    : [];

  let url: string;
  let created: boolean;
  if (existing.length > 0) {
    url = existing[0]!.url;
    created = false;
    log(`PR already exists for ${args.branch} — updating body in place: ${url}`);
    const edit = spawnSync(
      "gh",
      ["pr", "edit", url, "--title", title, "--body-file", "-"],
      { cwd: ROOT, input: body, encoding: "utf8" },
    );
    if (edit.status !== 0) {
      throw new Error(`gh pr edit failed (${edit.status}): ${edit.stderr ?? ""}`);
    }
    // Draft state can only transition with `gh pr ready` (draft→ready)
    // or `--draft` on create; we don't flip an existing PR draft<->ready
    // on the orchestrator side because the human may have already
    // marked-ready intentionally between firings.
  } else {
    // Pass the body via stdin to avoid argv length limits and escaping headaches.
    const ghArgs = [
      "pr",
      "create",
      "--base",
      "main",
      "--head",
      args.branch,
      "--title",
      title,
      "--body-file",
      "-",
    ];
    if (args.draft) ghArgs.push("--draft");

    const child = spawnSync("gh", ghArgs, {
      cwd: ROOT,
      input: body,
      encoding: "utf8",
    });
    if (child.status !== 0) {
      throw new Error(`gh pr create failed (${child.status}): ${child.stderr ?? ""}`);
    }
    url = (child.stdout ?? "").trim().split("\n").pop() ?? "";
    if (!url.startsWith("https://")) {
      throw new Error(`gh pr create returned unexpected output: ${child.stdout ?? ""}`);
    }
    created = true;
  }

  if (args.draft) {
    try {
      sh("gh", ["pr", "edit", url, "--add-label", "needs-human"]);
    } catch (err) {
      // Don't fail the whole run just because the label doesn't exist
      // yet — the draft status itself is enough of a flag.
      console.warn(`could not add needs-human label: ${String(err)}`);
    }
  }
  return { url, created };
}

/**
 * Combined-mode variant of `openPr`: takes an explicit title (rather
 * than deriving one from prev/new versions). Sharing one implementation
 * via parameterised title means combined-mode and standalone PRs go
 * through identical idempotency + draft-label handling.
 *
 * Kept as a separate exported function rather than a flag on `openPr`
 * so callers can't accidentally pass a stale (prev/new)-derived title
 * to a combined PR.
 */
export function openPrWithTitle(args: {
  branch: string;
  title: string;
  body: string;
  draft: boolean;
}): { url: string; created: boolean } {
  // Backstop: never let a PR body trip GitHub's 65536-char cap (issue #90).
  const body = clampGitHubBody(args.body);
  const existingJson = spawnSync(
    "gh",
    ["pr", "list", "--head", args.branch, "--state", "open", "--json", "url,isDraft"],
    { cwd: ROOT, encoding: "utf8" },
  );
  const existing = existingJson.status === 0
    ? (JSON.parse(existingJson.stdout || "[]") as Array<{ url: string; isDraft: boolean }>)
    : [];

  let url: string;
  let created: boolean;
  if (existing.length > 0) {
    url = existing[0]!.url;
    created = false;
    log(`PR already exists for ${args.branch} — updating body in place: ${url}`);
    const edit = spawnSync(
      "gh",
      ["pr", "edit", url, "--title", args.title, "--body-file", "-"],
      { cwd: ROOT, input: body, encoding: "utf8" },
    );
    if (edit.status !== 0) {
      throw new Error(`gh pr edit failed (${edit.status}): ${edit.stderr ?? ""}`);
    }
  } else {
    const ghArgs = [
      "pr",
      "create",
      "--base",
      "main",
      "--head",
      args.branch,
      "--title",
      args.title,
      "--body-file",
      "-",
    ];
    if (args.draft) ghArgs.push("--draft");

    const child = spawnSync("gh", ghArgs, {
      cwd: ROOT,
      input: body,
      encoding: "utf8",
    });
    if (child.status !== 0) {
      throw new Error(`gh pr create failed (${child.status}): ${child.stderr ?? ""}`);
    }
    url = (child.stdout ?? "").trim().split("\n").pop() ?? "";
    if (!url.startsWith("https://")) {
      throw new Error(`gh pr create returned unexpected output: ${child.stdout ?? ""}`);
    }
    created = true;
  }

  if (args.draft) {
    try {
      sh("gh", ["pr", "edit", url, "--add-label", "needs-human"]);
    } catch (err) {
      console.warn(`could not add needs-human label: ${String(err)}`);
    }
  }
  return { url, created };
}

// ── CI watch ──────────────────────────────────────────────────────────

export function watchCi(prUrl: string): { passed: boolean } {
  log(`watching CI on ${prUrl}`);
  const code = shStream("gh", ["pr", "checks", prUrl, "--watch", "--fail-fast"]);
  return { passed: code === 0 };
}

// ── Announce ──────────────────────────────────────────────────────────

/** Upstream compare URL between two SDK versions. */
export function compareUrl(prevVersion: string, newVersion: string): string {
  return `https://github.com/${UPSTREAM_GH}/compare/v${prevVersion}...v${newVersion}`;
}

/**
 * Message posted the moment a PR exists (open or, on a re-run, updated).
 * Fires for BOTH full and draft PRs: a draft means the automated run
 * didn't reach all-green, and the channel should still hear about it —
 * with the reason — so a human can pick it up. Never pinned; the pin is
 * reserved for the all-green "shipped" milestone below.
 */
export function buildOpenedAnnouncement(args: {
  prUrl: string;
  prevVersion: string;
  newVersion: string;
  created: boolean;
  draft: boolean;
  reason: string | null;
}): string {
  const verb = args.created ? "opened" : "updated";
  const head = args.draft
    ? `**claude-agent-sdk ${args.prevVersion} → ${args.newVersion}** — draft PR ${verb}, needs a human.`
    : `**claude-agent-sdk ${args.prevVersion} → ${args.newVersion}** — PR ${verb}, watching CI.`;
  const lines = [head, ""];
  if (args.draft && args.reason) {
    lines.push(`Reason: ${oneLine(args.reason, 600)}`, "");
  }
  lines.push(
    `PR: ${args.prUrl}`,
    `Upstream changelog: ${compareUrl(args.prevVersion, args.newVersion)}`,
  );
  return lines.join("\n");
}

/** Message posted once CI is green — the shipped milestone (pinned). */
export function buildShippedAnnouncement(args: {
  prUrl: string;
  prevVersion: string;
  newVersion: string;
}): string {
  return [
    `**claude-agent-sdk ${args.prevVersion} → ${args.newVersion}** has shipped to Claudius.`,
    "",
    `PR: ${args.prUrl}`,
    `Upstream changelog: ${compareUrl(args.prevVersion, args.newVersion)}`,
  ].join("\n");
}

// ── Progress announcements (fire BEFORE the PR exists) ────────────────
// These four exist so the community channel hears about the upgrade
// while it is in flight, not just after a PR has been opened. Each is
// short, unpinned, and best-effort — the long-form record is still the
// PR body + run-notes file the later steps produce.

/**
 * First post for a new run: announces that the orchestrator has
 * accepted a new upstream version and started work on it. Fires
 * immediately after the upgrade branch exists, so the channel hears
 * about the run within seconds of cron firing — not minutes later when
 * the draft PR is opened.
 *
 * Deliberately omits the changelog body: that ships in its own message
 * (buildChangelogAnnouncement) so this header line stays scannable.
 */
export function buildStartAnnouncement(args: {
  prevVersion: string;
  newVersion: string;
  branch: string;
  /**
   * When set, this run is STACKING onto an already-open SDK-update PR
   * (a newer release shipped before the prior PR merged) rather than
   * opening a fresh one. Surfaced so the channel knows the work continues
   * in one place.
   */
  continuationPrNumber?: number;
}): string {
  return [
    `🆕 **New claude-agent-sdk release: ${args.prevVersion} → ${args.newVersion}.**`,
    "",
    args.continuationPrNumber
      ? `Continuing in the still-open PR #${args.continuationPrNumber} (branch \`${args.branch}\`) — stacking this bump on the prior work so it all lands in one PR. Fetching changelog, then handing the migration to Claude.`
      : `Starting upgrade on branch \`${args.branch}\` — fetching changelog, then handing the migration to Claude.`,
    `Upstream compare: ${compareUrl(args.prevVersion, args.newVersion)}`,
  ].join("\n");
}

/**
 * Second post: the upstream changelog body, lifted from
 * `extractChangelog()`. The chat-server caps messages at 2000 chars and
 * we want headroom for the header + URL line, so the body itself is
 * clipped to ~1700 chars with a "truncated" marker pointing back at the
 * upstream compare view for the full diff. The placeholder string
 * `extractChangelog` returns on full failure ("_(automatic …)_") flows
 * through untouched — the channel should hear that we couldn't fetch
 * the changelog, not get a silent message.
 */
export function buildChangelogAnnouncement(args: {
  prevVersion: string;
  newVersion: string;
  changelog: string;
}): string {
  // Header + footer + markdown overhead ~= 250 chars. Leave the rest
  // for changelog body to stay under the 2000-char chat-server limit.
  const MAX_CHANGELOG = 1700;
  const trimmed = args.changelog.trim();
  const body =
    trimmed.length > MAX_CHANGELOG
      ? `${trimmed.slice(0, MAX_CHANGELOG)}\n\n_(changelog truncated — full text at the compare URL below)_`
      : trimmed;
  return [
    `📋 **Upstream changelog — ${args.prevVersion} → ${args.newVersion}:**`,
    "",
    body,
    "",
    `Compare: ${compareUrl(args.prevVersion, args.newVersion)}`,
  ].join("\n");
}

/**
 * Third post: the Summary section Claude wrote into the run-notes
 * file, lifted via `extractSection(..., "Summary")`. Fires once
 * `runClaude` returns and BEFORE the local gate starts, so the channel
 * gets a "here's what was changed" preview before tests run.
 *
 * If Claude didn't fill in the section (still the `_(TODO …)_` stub,
 * or the file is missing because the iterator died early) we post a
 * degraded one-liner instead — the channel still hears that Claude
 * finished, and the validation/gate machinery below catches the empty
 * run-notes separately (it surfaces as a draft + needs-human PR).
 */
export function buildImplementationAnnouncement(args: {
  prevVersion: string;
  newVersion: string;
  summary: string;
  /**
   * When set, runClaude was stopped before it returned cleanly (turn /
   * wall / idle budget tripped, or the iterator threw). The channel
   * deserves to hear that the summary may reflect partial work — they
   * shouldn't have to dig through cron logs to find out the agent was
   * killed mid-migration.
   */
  budgetReason?: string | null;
}): string {
  const trimmed = args.summary.trim();
  // Detect the stub placeholder Claude was supposed to replace, the
  // "section missing" sentinel extractSection returns, and obviously-
  // empty bodies. Anything else is treated as a real summary.
  const looksPlaceholder =
    !trimmed ||
    /^_+\(/.test(trimmed) ||
    /^TODO/i.test(trimmed) ||
    /^_\(run-notes did not include/.test(trimmed);
  const budgetLine = args.budgetReason
    ? `⚠️ Claude was stopped before completing: ${oneLine(args.budgetReason, 400)}`
    : null;
  if (looksPlaceholder) {
    const head = budgetLine
      ? `${budgetLine}\n\n🛠️ Migration pass for **${args.prevVersion} → ${args.newVersion}** ended with no Summary section in run-notes.`
      : `🛠️ Claude finished its migration pass for **${args.prevVersion} → ${args.newVersion}** — no Summary section in run-notes (gate may flag it).`;
    return `${head} Tests running next.`;
  }
  // Clip very long summaries to keep the post under the 2000-char chat
  // limit. Reviewers get the full text in the PR body; the channel post
  // is a notification, not a deliverable.
  const MAX = 1500;
  const body = trimmed.length > MAX ? `${trimmed.slice(0, MAX)}…` : trimmed;
  const lines: string[] = [];
  if (budgetLine) {
    lines.push(budgetLine, "");
  }
  lines.push(
    `🛠️ **${budgetLine ? "Partial m" : "Claude finished its m"}igration pass — ${args.prevVersion} → ${args.newVersion}.**`,
    "",
    `Summary:`,
    body,
  );
  return lines.join("\n");
}

/**
 * Fourth post: fires right before the local gate runs (lint / unit /
 * build / e2e). Bookends the "Claude finished" announcement above so
 * the channel sees the handoff from agent work → automated checks.
 * The gate-result outcome reaches the channel later via the draft-PR
 * announce (with the failing-step reason) or the shipped pin.
 */
export function buildTestingAnnouncement(args: {
  prevVersion: string;
  newVersion: string;
}): string {
  return `🧪 Running local gates for **${args.prevVersion} → ${args.newVersion}** (lint, unit, build, e2e). Will open a PR once they pass.`;
}

/**
 * Fifth progress post: the gate verdict. Fires AFTER `runGate` +
 * `validateRunNotes` so it includes the full picture (failed steps +
 * any run-notes problem + any earlier budget reason). Always posts —
 * a clean green run gets a positive ack instead of silence between
 * "🧪 running tests" and the draft-PR announce minutes later.
 *
 * Failure shape names the exact gate steps that failed so a reviewer
 * can decide what to look at without opening the cron log. The
 * `budgetReason` field is only echoed when it carries new info beyond
 * the failed-step list (the orchestrator auto-fills it with the same
 * step list when Claude reported clean-but-red; we don't want to echo
 * that back).
 */
export function buildGateResultAnnouncement(args: {
  prevVersion: string;
  newVersion: string;
  results: Array<{ step: string; ok: boolean; skipped?: boolean }>;
  runNotesIssue: string | null;
  budgetReason: string | null;
}): string {
  const failed = args.results.filter((r) => !r.ok && !r.skipped).map((r) => r.step);
  const passed = args.results.filter((r) => r.ok && !r.skipped).map((r) => r.step);
  const skipped = args.results.filter((r) => r.skipped === true).map((r) => r.step);

  const skipNote = skipped.length ? ` _(skipped: ${skipped.join(", ")})_` : "";

  // All-green path: the PR is about to open. Single short line so the
  // channel doesn't get a wall of ✅ between the test-start and PR-open
  // announces.
  if (failed.length === 0 && !args.runNotesIssue) {
    const passedList = passed.length ? passed.join(", ") : "(everything skipped)";
    return `✅ Local gates green for **${args.prevVersion} → ${args.newVersion}** — ${passedList}${skipNote}. Opening draft PR and watching CI next.`;
  }

  const lines: string[] = [
    `❌ **Local gates failed for ${args.prevVersion} → ${args.newVersion}.**`,
    "",
  ];
  if (failed.length) lines.push(`Failed: ${failed.join(", ")}`);
  if (passed.length) lines.push(`Passed: ${passed.join(", ")}`);
  if (skipped.length) lines.push(`Skipped: ${skipped.join(", ")}`);
  if (args.runNotesIssue) {
    lines.push("", `Run-notes problem: ${oneLine(args.runNotesIssue, 400)}`);
  }
  // The orchestrator auto-sets budgetReason to "Claude reported done
  // but gate failed: …" when Claude returned cleanly but the suite is
  // red. Echoing that back here would just duplicate the failed-list
  // we already printed; skip it. Any other reason (wall-clock, idle,
  // iterator error) is genuinely new info worth surfacing.
  if (
    args.budgetReason &&
    !args.budgetReason.startsWith("Claude reported done but gate failed")
  ) {
    lines.push("", `Cause: ${oneLine(args.budgetReason, 400)}`);
  }
  lines.push("", "Not pushing the branch — a process issue will follow with the next steps.");
  return lines.join("\n");
}

/** Message posted when a `fix-pr` run starts working on an existing PR. */
export function buildFixStartAnnouncement(args: {
  prNumber: string;
  title: string;
  url: string;
  instruction: string;
}): string {
  const lines = [`🔧 Working on PR #${args.prNumber} — ${oneLine(args.title, 200)}.`, ""];
  if (args.instruction.trim()) {
    lines.push(`Instruction: ${oneLine(args.instruction, 400)}`, "");
  }
  lines.push(`PR: ${args.url}`);
  return lines.join("\n");
}

/** Message posted when a `fix-pr` run finishes. */
export function buildFixResultAnnouncement(args: {
  prNumber: string;
  title: string;
  url: string;
  allGreen: boolean;
  failedSteps: string[];
  markedReady: boolean;
}): string {
  const head = args.allGreen
    ? `✅ PR #${args.prNumber} updated — all gates pass${args.markedReady ? " (marked ready for review)" : ""}.`
    : `⚠ PR #${args.prNumber} updated but still red: ${args.failedSteps.join(", ")}. Needs another look.`;
  return [head, "", `PR: ${args.url}`].join("\n");
}

/**
 * POST a message to the chat-server community room. Throwing primitive —
 * callers that don't want a transient chat-server hiccup to abort the
 * run wrap this in `announceSafe`.
 */
export async function postAnnouncement(body: string, opts: { pin?: boolean } = {}): Promise<void> {
  const pin = opts.pin === true;
  const res = await fetch(`${CHAT_SERVER_URL.replace(/\/$/, "")}/admin/announce`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Admin-Token": CHAT_SERVER_ADMIN_TOKEN,
    },
    body: JSON.stringify({
      roomSlug: ROOM_SLUG,
      body,
      pin,
    }),
  });
  if (!res.ok) {
    throw new Error(
      `chat-server announce failed: HTTP ${res.status} ${await res.text()}`,
    );
  }
  log(`announced to ${ROOM_SLUG}${pin ? " (pinned)" : ""}`);
}

/**
 * Pure builder for the per-version "SDK update X → Y error" issue —
 * shared by every bot-filed failure path (local gates failed, CI still
 * red, orchestrator crash, swallowed chat-server announce). Exported
 * only for tests; the side-effectful gh-spawning caller lives below.
 *
 * Title shape `SDK update <prev> → <new> error` is the dedup key: all
 * failure kinds within ONE upgrade collapse onto a single issue — the
 * filer either opens it fresh OR appends a comment if it's already
 * open. The previous design used one issue per (failure-kind ×
 * version-pair) and additionally embedded the CI attempt count into
 * the CI-red title, which scattered a single bad upgrade across three
 * or four tickets and orphaned every previous firing's issue as soon
 * as a new version came along. Collapsing onto one issue per version
 * keeps the open-issue list scannable and lets a human see the full
 * failure history for a given upgrade in one place.
 *
 * The fact that we comment-or-create on each new failure (rather than
 * refile) is the dedup contract the unit test below pins.
 */
export function buildRunIssue(args: {
  prevVersion: string;
  newVersion: string;
  kind: string;
  reason: string;
  branch: string | null;
  prUrl: string | null;
  extras?: string[];
}): { title: string; body: string; commentBody: string } {
  const title = `SDK update ${args.prevVersion} → ${args.newVersion} error`;
  const meta = [
    `**Branch:** \`${args.branch ?? "(none)"}\``,
    `**PR:** ${args.prUrl ?? "(none)"}`,
  ];
  const extras = args.extras && args.extras.length ? ["", ...args.extras] : [];
  const body = [
    `Automated SDK update \`${args.prevVersion} → ${args.newVersion}\` hit a problem the orchestrator could not resolve on its own.`,
    "",
    `**Kind:** ${args.kind}`,
    `**What happened:** ${args.reason}`,
    "",
    ...meta,
    ...extras,
    "",
    "Filed automatically by `scripts/sdk-update/orchestrate.ts`. Subsequent failures on this same upgrade comment here rather than opening duplicates — see the comments below for the full failure history. The orchestrator run logs live in `.claudius/sdk-updater/logs/` on the cron host.",
  ].join("\n");
  const commentBody = [
    `Another failure on this same upgrade.`,
    "",
    `**Kind:** ${args.kind}`,
    `**What happened:** ${args.reason}`,
    "",
    ...meta,
    ...extras,
    "",
    "Posted automatically by `scripts/sdk-update/orchestrate.ts` to avoid opening a duplicate issue.",
  ].join("\n");
  return { title, body, commentBody };
}

/**
 * Per-run upgrade context (prev/new SDK versions). Set once at the
 * top of `main()` so any later announce-failure has the version pair
 * available without threading it through every callsite. Stays null
 * in `fixPr()` — that path doesn't know prev offhand and its rare
 * announce failures just log a WARN.
 */
let currentUpgradeContext: { prevVersion: string; newVersion: string } | null = null;

/**
 * In-process cache of "title → URL we already filed / found this
 * run". Cron firings are minutes apart so cross-run dedup is fine
 * via the gh list call below; this Map exists specifically for the
 * within-run case where multiple announce failures fire seconds
 * apart and GitHub's NOT-realtime issue-list returns "no match"
 * for the issue we just created. This is what produced #32 and #33,
 * filed 4 seconds apart with identical titles — both passed the
 * "no existing issue" check because each one's `gh issue list`
 * snapshot didn't yet see the other's create. The Map closes the
 * race deterministically: the second call within a run sees the
 * first call's URL and comments on it.
 */
const inProcessIssueByTitle = new Map<string, string>();

/**
 * Find an OPEN issue whose title exactly equals `title`. Uses
 * `gh issue list --state open --limit 200 --json url,title` rather
 * than `gh issue list --search`. The search variant routes through
 * GitHub's search index, which is NOT real-time and was the cross-
 * call bug behind #32/#33 — even with the in-process cache, the
 * direct list is the right primitive because it surfaces an issue
 * filed by a previous cron firing (which our cache doesn't carry
 * across processes). The 200-issue limit is well above the
 * practical open-issue count for this repo; raise if that stops
 * being true.
 */
function findOpenIssueByTitle(title: string): string | null {
  const cached = inProcessIssueByTitle.get(title);
  if (cached) return cached;
  try {
    const listed = spawnSync(
      "gh",
      ["issue", "list", "--state", "open", "--limit", "200", "--json", "url,title"],
      { cwd: ROOT, encoding: "utf8" },
    );
    if (listed.status !== 0) return null;
    const all = JSON.parse(listed.stdout || "[]") as Array<{ url: string; title: string }>;
    const hit = all.find((i) => i.title === title);
    if (hit) inProcessIssueByTitle.set(title, hit.url);
    return hit?.url ?? null;
  } catch {
    return null;
  }
}

/**
 * File the per-version run issue OR comment on an existing open one.
 * The single dedup chokepoint for every bot-filed failure kind —
 * `reportProcessIssueSafe` and the inline filer used by `announceSafe`
 * both go through here so there's exactly one place that decides
 * "create vs comment" and exactly one title to keep stable.
 *
 * Best-effort: returns the issue URL on success, null on any gh
 * failure. Never throws — the orchestrator must not crash because
 * the issue-filing step couldn't reach GitHub.
 *
 * Why NOT call `reportProcessIssueSafe` from `announceSafe`'s error
 * handler: that helper ends with `await announceSafe(...)` to ALSO
 * post to the community room. Routing the swallowed-announce path
 * through it would re-throw on the second announce, re-trigger this
 * filer, and loop. Calling this lower-level helper directly breaks
 * the recursion cleanly.
 */
function fileOrCommentRunIssueSafe(args: {
  prevVersion: string;
  newVersion: string;
  kind: string;
  reason: string;
  branch: string | null;
  prUrl: string | null;
  extras?: string[];
}): string | null {
  const { title, body: rawBody, commentBody: rawComment } = buildRunIssue(args);
  // Issues / comments share the PR's 65536-char GraphQL cap, and the
  // captured failure tail (the `extras`) is what would blow it — keep
  // the tail, where the actionable error lives. Pass via stdin so a
  // long body can't trip argv length limits either.
  const body = clampGitHubBody(rawBody, "tail");
  const commentBody = clampGitHubBody(rawComment, "tail");
  try {
    const existing = findOpenIssueByTitle(title);
    if (existing) {
      const comment = spawnSync(
        "gh",
        ["issue", "comment", existing, "--body-file", "-"],
        { cwd: ROOT, input: commentBody, encoding: "utf8" },
      );
      if (comment.status !== 0) {
        throw new Error(
          `gh issue comment exited ${comment.status}: ${comment.stderr ?? ""}`,
        );
      }
      log(`commented on existing run issue (kind=${args.kind}): ${existing}`);
      inProcessIssueByTitle.set(title, existing);
      return existing;
    }
    const created = spawnSync(
      "gh",
      ["issue", "create", "--title", title, "--body-file", "-"],
      { cwd: ROOT, input: body, encoding: "utf8" },
    );
    if (created.status !== 0) {
      throw new Error(
        `gh issue create exited ${created.status}: ${created.stderr ?? ""}`,
      );
    }
    const url = (created.stdout ?? "").trim().split("\n").pop() ?? "";
    inProcessIssueByTitle.set(title, url);
    log(`filed run issue (kind=${args.kind}): ${url}`);
    return url;
  } catch (err) {
    log(
      `WARN could not file/update GitHub issue (non-fatal): ${err instanceof Error ? err.message : String(err)}`,
    );
    return null;
  }
}

/**
 * Best-effort community post. By the time we announce, the PR already
 * exists (and may already be green) — a chat-server outage must not
 * abort the orchestration or leave state inconsistent. We log and move
 * on. The announcement is a notification, not a gate.
 *
 * When the post fails AND we have an upgrade context (i.e. we're
 * inside `main()`, not `fixPr()`), we also file or comment on the
 * per-version run issue so the swallowed failure surfaces without
 * anyone tailing the cron host's logs. The 0.3.160 → 0.3.161
 * announcement was lost this way — PR opened cleanly, room never
 * heard about it, and the only signal was a missing message; the
 * issue-filing path closes that gap. The per-version (vs per-kind)
 * title means a follow-on gate failure on the same upgrade comments
 * on this same issue rather than opening a sibling ticket.
 */
export async function announceSafe(body: string, opts: { pin?: boolean } = {}): Promise<void> {
  try {
    await postAnnouncement(body, opts);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    log(`WARN community announce failed (non-fatal): ${reason}`);
    if (currentUpgradeContext) {
      fileOrCommentRunIssueSafe({
        prevVersion: currentUpgradeContext.prevVersion,
        newVersion: currentUpgradeContext.newVersion,
        kind: "chat-server announce failed",
        reason,
        branch: null,
        prUrl: null,
        extras: [
          `**Chat-server URL:** \`${CHAT_SERVER_URL || "(unset)"}\``,
          `**Room slug:** \`${ROOM_SLUG}\``,
          `**Effect:** the room missed at least one milestone (start / changelog / opened / shipped). Check the orchestrator run logs in \`.claudius/sdk-updater/logs/\` on the cron host to find which.`,
        ],
      });
    } else {
      log(`WARN no upgrade context — skipping run-issue file for swallowed announce (this is normal in fix-pr mode).`);
    }
  }
}

// ── Fix an existing PR ─────────────────────────────────────────────────

export type PrMeta = {
  number: number;
  headRefName: string;
  url: string;
  title: string;
  isDraft: boolean;
  /** gh reports OPEN / CLOSED / MERGED. */
  state: string;
};

export function readPrMeta(prNumber: string): PrMeta {
  const raw = sh("gh", [
    "pr",
    "view",
    prNumber,
    "--json",
    "number,headRefName,url,title,isDraft,state",
  ]);
  return JSON.parse(raw) as PrMeta;
}

/**
 * The current CI check table for the PR, as plain text. We use
 * `spawnSync` directly (not `sh`) because `gh pr checks` exits non-zero
 * whenever checks are failing or pending — exactly the case we care
 * about — and we still want the table either way.
 */
export function collectChecks(prNumber: string): string {
  const res = spawnSync("gh", ["pr", "checks", prNumber], {
    cwd: ROOT,
    encoding: "utf8",
  });
  const out = `${res.stdout ?? ""}${res.stderr ?? ""}`.trim();
  return out || "_(gh reported no CI checks for this PR)_";
}

/**
 * Review verdicts + general comments on the PR, flattened to bullet
 * lines. Parsed in TS (rather than a jq one-liner) so the formatting is
 * obvious and a malformed field degrades to a note instead of breaking
 * the run.
 */
export function collectReviews(prNumber: string): string {
  let parsed: {
    reviews?: Array<{ author?: { login?: string }; state?: string; body?: string }>;
    comments?: Array<{ author?: { login?: string }; body?: string }>;
  };
  try {
    parsed = JSON.parse(sh("gh", ["pr", "view", prNumber, "--json", "reviews,comments"]));
  } catch (err) {
    return `_(could not fetch review comments: ${err instanceof Error ? err.message : String(err)})_`;
  }
  const lines: string[] = [];
  for (const r of parsed.reviews ?? []) {
    const body = (r.body ?? "").trim();
    // Skip bare "COMMENTED" reviews with no text — they're noise.
    if (!body && (!r.state || r.state === "COMMENTED")) continue;
    lines.push(
      `- review by ${r.author?.login ?? "?"} (${r.state ?? "?"}): ${oneLine(body, 600) || "(no text)"}`,
    );
  }
  for (const c of parsed.comments ?? []) {
    const body = (c.body ?? "").trim();
    if (!body) continue;
    lines.push(`- comment by ${c.author?.login ?? "?"}: ${oneLine(body, 600)}`);
  }
  return lines.length ? lines.join("\n") : "_(no review or general comments on the PR)_";
}

function fixTranscriptPath(prNumber: string): string {
  return resolve(
    ROOT,
    ".claudius",
    "sdk-updater",
    "run-notes",
    `fix-pr-${prNumber}.transcript.jsonl`,
  );
}

function fixPromptArchivePath(prNumber: string): string {
  return resolve(
    ROOT,
    ".claudius",
    "sdk-updater",
    "run-notes",
    `fix-pr-${prNumber}.prompt.md`,
  );
}

function renderFixPrompt(args: {
  prNumber: string;
  meta: PrMeta;
  instruction: string;
  checks: string;
  reviews: string;
}): string {
  const tpl = readFileSync(resolve(SCRIPT_DIR, "fix-prompt.md"), "utf8");
  const instructionBlock = args.instruction.trim()
    ? args.instruction.trim()
    : "_(No extra instruction supplied — infer the fix from the failing checks and review comments below.)_";
  return tpl
    .replace(/\{\{PR_NUMBER\}\}/g, args.prNumber)
    .replace(/\{\{PR_TITLE\}\}/g, args.meta.title)
    .replace(/\{\{PR_URL\}\}/g, args.meta.url)
    .replace(/\{\{BRANCH\}\}/g, args.meta.headRefName)
    .replace(/\{\{INSTRUCTION_BLOCK\}\}/g, instructionBlock)
    .replace(/\{\{CI_CHECKS\}\}/g, args.checks)
    .replace(/\{\{REVIEW_COMMENTS\}\}/g, args.reviews);
}

/**
 * One fix pass over an open PR: gather its failing checks + review
 * comments, re-run Claude with the fix prompt, and re-gate locally.
 * Does NOT push, mark ready, or announce — the caller decides what to
 * do with the result. Shared by the standalone `fix-pr` entry and the
 * inline CI-fix loop in the upgrade pipeline so both iterate identically.
 */
async function runFixPass(
  prNumber: string,
  meta: PrMeta,
  instruction: string,
  skipGates: Set<GateStep>,
): Promise<{ allGreen: boolean; failedSteps: GateStep[] }> {
  const checks = collectChecks(prNumber);
  const reviews = collectReviews(prNumber);

  const prompt = renderFixPrompt({ prNumber, meta, instruction, checks, reviews });
  const txPath = fixTranscriptPath(prNumber);
  mkdirSync(dirname(txPath), { recursive: true });
  writeFileSync(fixPromptArchivePath(prNumber), prompt, "utf8");
  log(`fix prompt archived (${prompt.length} bytes)`);

  const claudeResult = await runClaude(prompt, txPath);
  log(
    `Claude (fix) exited: completed=${claudeResult.completed} turns=${claudeResult.turnCount}` +
      ` wall=${Math.round(claudeResult.wallMs / 1000)}s`,
  );

  const gate = await runGate(skipGates);
  const allGreen = gate.every((g) => g.ok);
  const failedSteps = gate.filter((g) => !g.ok).map((g) => g.step);
  log(
    `gate result: ${gate
      .map((g) => `${g.step}=${g.skipped ? "skip" : g.ok ? "ok" : "FAIL"}`)
      .join(" ")}`,
  );
  return { allGreen, failedSteps };
}

/**
 * Surface an orchestrator-level failure out-of-band: file (or comment
 * on) the per-version run issue AND post to the community channel, so
 * a human hears about a problem the bot couldn't resolve on its own.
 * Both halves are best-effort — a failure to file the issue (or a
 * chat outage) must never mask the original problem or abort the run.
 *
 * The issue logic lives in `fileOrCommentRunIssueSafe`: all failure
 * kinds within one upgrade (local gates failed / CI still red /
 * crashed / chat-server announce failed) collapse onto a single
 * `SDK update <prev> → <new> error` ticket. Each new firing comments
 * on it. Previously we used one title per (kind × version-pair) and
 * the CI-red title even baked the attempt count in, scattering a
 * single bad upgrade across three or four open tickets — one per kind
 * the run hit. The per-version title is the smallest dedup key that
 * still lets a reviewer separate "0.3.161 → 0.3.162 was a mess" from
 * "0.3.163 → 0.3.164 was a mess" in the issue list.
 */
async function reportProcessIssueSafe(args: {
  kind: string;
  reason: string;
  prevVersion: string;
  newVersion: string;
  branch: string | null;
  prUrl: string | null;
  /**
   * Additional markdown sections appended to the issue body / comment.
   * The gate-failure path uses this to embed `buildGateFailureBanner`
   * (per-step tail output in `<details>` blocks) so the reviewer can
   * see WHICH tests failed and their assertion messages without ssh'ing
   * onto the cron host. Empty / omitted = today's brief issue shape.
   */
  extras?: string[];
}): Promise<void> {
  const issueUrl = fileOrCommentRunIssueSafe({
    prevVersion: args.prevVersion,
    newVersion: args.newVersion,
    kind: args.kind,
    reason: args.reason,
    branch: args.branch,
    prUrl: args.prUrl,
    extras: args.extras,
  });

  const channelMsg = [
    `🛠️ **SDK update ${args.prevVersion} → ${args.newVersion} hit a problem.**`,
    `Kind: ${args.kind}`,
    oneLine(args.reason, 400),
    issueUrl ? `Issue: ${issueUrl}` : "(issue could not be filed — check run logs)",
    args.prUrl ? `PR: ${args.prUrl}` : "",
  ]
    .filter(Boolean)
    .join("\n");
  await announceSafe(channelMsg, { pin: false });
}

/**
 * Fix an existing PR by number. The companion to the version-upgrade
 * pipeline: where that one creates a PR, this one iterates on one that
 * already exists (typically a draft the upgrade left behind with
 * `needs-human`, or one a reviewer asked for changes on).
 *
 * Flow: read PR meta → announce start → `gh pr checkout` the branch →
 * gather failing checks + review comments → run Claude with a fix
 * prompt → gate → push → mark ready / drop `needs-human` if green →
 * announce result. Every community post is best-effort so a chat
 * outage can't strand the branch.
 */
async function fixPr(
  prRef: string,
  instruction: string,
  skipGates: Set<GateStep>,
): Promise<void> {
  preflight();

  const prNumber = prRef.replace(/^#/, "").trim();
  if (!/^\d+$/.test(prNumber)) {
    fatal(`--fix-pr expects a numeric PR id (got "${prRef}")`);
  }

  let meta: PrMeta;
  try {
    meta = readPrMeta(prNumber);
  } catch (err) {
    fatal(
      `could not read PR #${prNumber} via gh: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (meta.state !== "OPEN") {
    fatal(`PR #${prNumber} is ${meta.state}, not OPEN — refusing to touch a closed/merged PR.`);
  }
  const branch = meta.headRefName;
  log(`fix-pr #${prNumber} "${meta.title}" on branch ${branch} (draft=${meta.isDraft})`);

  // Announce that we've started — this is the PR "interaction" the user
  // asked to be visible on the community channel.
  await announceSafe(
    buildFixStartAnnouncement({
      prNumber,
      title: meta.title,
      url: meta.url,
      instruction,
    }),
    { pin: false },
  );

  // Check out the PR's head branch. `gh pr checkout` fetches + sets up
  // tracking; `--force` resets a stale local branch to the PR head.
  sh("git", ["fetch", "origin", branch, "--prune"]);
  const coCode = shStream("gh", ["pr", "checkout", prNumber, "--force"]);
  if (coCode !== 0) {
    throw new Error(`gh pr checkout ${prNumber} failed (exit ${coCode})`);
  }

  const { allGreen, failedSteps } = await runFixPass(prNumber, meta, instruction, skipGates);

  // Push whatever Claude committed back to the PR's branch. pushBranch
  // makes an empty marker commit only when HEAD == origin/main, which a
  // PR branch never is, so a no-op fix run pushes nothing.
  pushBranch(branch);

  let markedReady = false;
  if (allGreen) {
    if (meta.isDraft) {
      try {
        sh("gh", ["pr", "ready", prNumber]);
        markedReady = true;
        log(`marked PR #${prNumber} ready for review`);
      } catch (err) {
        log(`WARN could not mark PR #${prNumber} ready: ${String(err)}`);
      }
    }
    try {
      sh("gh", ["pr", "edit", prNumber, "--remove-label", "needs-human"]);
    } catch {
      // Label may not be present — fine.
    }
  }

  await announceSafe(
    buildFixResultAnnouncement({
      prNumber,
      title: meta.title,
      url: meta.url,
      allGreen,
      failedSteps,
      markedReady,
    }),
    { pin: false },
  );

  log(`fix-pr #${prNumber} done: green=${allGreen}`);
}

// ── Main ──────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  // Allow run.sh to short-circuit the network probe by passing the
  // already-decided version on the command line.
  const newVersionArg = args.find((a) => a.startsWith("--version="))?.slice("--version=".length);
  const prevVersionArg = args
    .find((a) => a.startsWith("--previous="))
    ?.slice("--previous=".length);
  // Dry-run: do branch + bump + Claude + gate locally, then STOP
  // before push/PR/CI-watch/announce. Useful for iterating on the
  // prompt locally without spamming the remote with branches and
  // draft PRs. Also reachable via SDK_UPDATE_DRY_RUN=1 in run.sh.
  const dryRun = args.includes("--dry-run");
  // Skip selected gate steps. Accepts a comma-separated list of
  // {lint, unit, build, e2e}. Reachable via SDK_UPDATE_SKIP_GATES=…
  // in run.sh. Common usage: `--skip-gates=e2e` for fast iteration
  // (Playwright is the slow one).
  const skipGatesArg = args
    .find((a) => a.startsWith("--skip-gates="))
    ?.slice("--skip-gates=".length);
  const skipGates = parseSkipGates(skipGatesArg);

  // Fix mode: instead of probing npm for a new version, check out an
  // existing PR by number and re-run Claude to fix it (gate failures,
  // review feedback, needs-human). Reachable via `run.sh fix-pr <n>` /
  // `make sdk-update-fix-pr PR=<n>`. This is a wholly separate path
  // from the version upgrade below — it owns its own preflight.
  const fixPrArg = args.find((a) => a.startsWith("--fix-pr="))?.slice("--fix-pr=".length);
  if (fixPrArg) {
    const instruction =
      args.find((a) => a.startsWith("--instruction="))?.slice("--instruction=".length) ??
      process.env.SDK_UPDATE_FIX_INSTRUCTION ??
      "";
    await fixPr(fixPrArg, instruction, skipGates);
    return;
  }

  preflight();

  const prevVersion = prevVersionArg ?? cleanRange(readInstalledRange(ROOT));
  if (!newVersionArg) {
    fatal("orchestrate.ts requires --version=<x.y.z>");
  }
  const newVersion = newVersionArg!;

  // Continuation: if a prior SDK-update PR is still open (the human hadn't
  // merged it before this newer release shipped), stack this bump onto that
  // PR's existing branch instead of opening a parallel PR. Skipped in
  // dry-run, which iterates on the prompt against a throwaway fresh branch
  // and shouldn't touch real PRs. See findOpenSdkUpdatePr for the full
  // rationale and the highest-version tie-break.
  const continuation = dryRun ? null : findOpenSdkUpdatePr();
  const inFlightBranch = continuation?.branch ?? branchName(newVersion);
  if (continuation) {
    log(
      `open SDK-update PR #${continuation.number} found on ${continuation.branch} — ` +
        `continuing the upgrade to ${newVersion} in that PR (no new PR will be opened)`,
    );
  }

  // Stash the version pair so any later announce-failure (handled in
  // `announceSafe` → `fileOrCommentRunIssueSafe`) can file/comment on
  // the same per-version run issue as the gate/CI/crash paths. Without
  // this the swallowed-announce path can't compute a dedup-friendly
  // title.
  currentUpgradeContext = { prevVersion, newVersion };

  log(`starting upgrade ${prevVersion} → ${newVersion}`);
  // Pre-read state isn't strictly needed here — patchState reads the
  // current state internally — but we keep the function exported and
  // exercised so a future "respect lastCompletedVersion before mutating"
  // check has an obvious place to land.
  void readState(ROOT);
  patchState(
    {
      inFlight: {
        version: newVersion,
        branch: inFlightBranch,
        startedAt: Date.now(),
      },
    },
    ROOT,
  );

  let prUrl: string | null = null;
  let shipped = false;
  let budgetReason: string | null = null;
  // Combined-mode tracking — hoisted so the `finally` block can patch
  // BOTH state files in lockstep with `shipped`. Set inside the try
  // block when the CC parity probe decides combined mode runs.
  let combinedCcVersion: string | null = null;
  // Explicit state-machine tracker for the finally block — derived state
  // from `shipped` + `combinedCcVersion` can't carry the four CC outcomes
  // (success / draft / sdk-fail-cc-draft / dropped) cleanly. MUST be
  // hoisted here (not inside the try): a `let` declared inside `try {}` is
  // NOT in scope in `finally {}`, so reading it there is a `Cannot find
  // name` compile error. (That exact bug shipped to main once — caught
  // only by `bun run build`, which is why the gate runs it.) Default
  // "failure" so an early throw before any decision patches only the
  // inFlight clear.
  let combinedOutcome:
    | "combined-success"
    | "combined-draft"
    | "sdk-failure-cc-draft"
    | "sdk-only-success"
    | "failure" = "failure";
  // Set true only when the run reaches its normal end without throwing.
  // Gates the "switch the working tree back to main" step in `finally` so
  // it fires on a successful finish but NOT on a crash, a local-gate
  // failure, or a dry-run (all of which leave HEAD on the branch for
  // inspection). Hoisted for the same finally-scope reason as above.
  let completedOk = false;

  // Progress announcements (start / changelog / summary / testing) are
  // suppressed when dry-run is on — dry-run is for local prompt iteration
  // and the channel shouldn't see those test firings. The post-PR
  // announces (draft / shipped / process issue) already live behind the
  // dry-run short-circuit further down, so they need no extra guard.
  const announceProgress = async (
    body: string,
    opts: { pin?: boolean } = {},
  ): Promise<void> => {
    if (dryRun) return;
    await announceSafe(body, opts);
  };

  try {
    const { branch, resumed } = checkoutFreshBranch(newVersion, {
      branchOverride: continuation?.branch,
    });
    if (resumed) {
      log(
        `RESUMING prior work on ${branch}` +
          (continuation
            ? ` (continuation of open PR #${continuation.number})`
            : "") +
          `; bump + bun install + run-notes stub will be no-ops if already done`,
      );
    }

    // 1st progress post: "found new version, starting upgrade". Goes out
    // as soon as the branch exists so the channel hears about the run
    // within seconds of cron firing — minutes before the draft PR.
    await announceProgress(
      buildStartAnnouncement({
        prevVersion,
        newVersion,
        branch,
        continuationPrNumber: continuation?.number,
      }),
    );

    bumpSdkDependency(newVersion);
    // Keep Claudius's displayed version in lock-step with the SDK. The
    // trailing `.N` release counter is git-derived (see
    // lib/shared/version.ts + scripts/claudius-release.mjs), so this commit
    // becoming the new anchor automatically resets it to .0.
    bumpClaudiusVersion(newVersion);

    // First commit lands cleanly — gives Claude a known starting point
    // and makes the dep bump easy to revert independently if needed.
    // Skip the commit when there's nothing staged: on a resumed branch
    // both bumps were no-ops because the version is already at target,
    // so `git add` adds nothing and `git commit` would fail with
    // "nothing to commit, working tree clean". The resume path picks
    // up the prior firing's bump commit verbatim.
    sh("git", ["add", "package.json", "bun.lock"]);
    const staged = sh("git", ["diff", "--cached", "--name-only"]).trim();
    if (staged !== "") {
      sh("git", [
        "commit",
        "-m",
        `chore(deps): bump claude-agent-sdk to ${newVersion}`,
      ]);
    } else {
      log(
        `no dep-bump diff to commit — package.json + bun.lock already at target (resumed branch)`,
      );
    }

    const changelog = extractChangelog(prevVersion, newVersion);
    log(`changelog: ${changelog.length} bytes`);

    // 2nd progress post: the upstream changelog body. Goes out before
    // Claude starts, so the channel has the same context Claude does
    // when reasoning about what's about to land. Body is clipped to fit
    // the chat-server's 2000-char cap; full text is always one URL away.
    await announceProgress(
      buildChangelogAnnouncement({ prevVersion, newVersion, changelog }),
    );

    // Make sure the run-notes target directory exists so Claude can write into it.
    mkdirSync(dirname(runNotesPath(newVersion)), { recursive: true });

    // Pre-create the run-notes file as a fillable template. This
    // changes Claude's task from "create this file" to "edit this
    // file" — a smaller, more concrete instruction that Claude
    // consistently follows. The file always exists after this point;
    // the validator's job is just to confirm Claude actually replaced
    // the `_(TODO …)_` placeholders.
    if (!existsSync(runNotesPath(newVersion))) {
      writeFileSync(
        runNotesPath(newVersion),
        runNotesStub(prevVersion, newVersion),
        "utf8",
      );
      log(`run-notes stub created at ${relative(ROOT, runNotesPath(newVersion))}`);
    }

    const prompt = renderPrompt(prevVersion, newVersion, changelog);
    // Archive the exact prompt Claude sees, for post-mortem inspection
    // when a run produces a surprising PR (or fails to write the
    // run-notes file as told). Mirrors the rendered prompt to disk
    // BEFORE the long-running query() call so the file is present even
    // if the run is killed.
    writeFileSync(promptArchivePath(newVersion), prompt, "utf8");
    log(`prompt archived to ${relative(ROOT, promptArchivePath(newVersion))} (${prompt.length} bytes)`);

    const claudeResult = await runClaude(prompt, transcriptPath(newVersion));
    log(
      `Claude exited: completed=${claudeResult.completed} turns=${claudeResult.turnCount}` +
        ` wall=${Math.round(claudeResult.wallMs / 1000)}s`,
    );
    budgetReason = claudeResult.budgetReason;

    // 3rd progress post: the Summary section Claude wrote into the
    // run-notes file. The prompt instructs Claude to write run-notes
    // FIRST (before coding), so by the time we get here the file
    // should have a real summary even if the implementation half had
    // to be cut short by the budget watchdog. If the Summary is still
    // the stub placeholder (or the file is missing), the builder
    // degrades to a one-liner — the validation/gate logic below
    // surfaces the empty-run-notes case via the draft-PR path anyway.
    let runNotesSummary = "";
    const notesFile = runNotesPath(newVersion);
    if (existsSync(notesFile)) {
      runNotesSummary = extractSection(readFileSync(notesFile, "utf8"), "Summary");
    }
    await announceProgress(
      buildImplementationAnnouncement({
        prevVersion,
        newVersion,
        summary: runNotesSummary,
        // Surface "Claude was killed early" right here, not three
        // announces later — the channel needs to know the summary may
        // reflect partial work before the gate result lands.
        budgetReason,
      }),
    );

    // 4th progress post: "running local gates". Bookends the previous
    // announce so the channel sees the handoff from agent work →
    // automated checks. The gate-result outcome reaches the channel
    // later via the draft-PR or shipped announce below.
    await announceProgress(
      buildTestingAnnouncement({ prevVersion, newVersion }),
    );

    const gate = await runGate(skipGates);
    const allGreen = gate.every((g) => g.ok);
    log(`gate result: ${gate.map((g) => `${g.step}=${g.skipped ? "skip" : g.ok ? "ok" : "FAIL"}`).join(" ")}`);

    if (!allGreen && !budgetReason) {
      // Claude returned cleanly but the suite is red — treat as
      // budget-exhausted so we open a draft instead of a regular PR.
      budgetReason = `Claude reported done but gate failed: ${gate
        .filter((g) => !g.ok)
        .map((g) => g.step)
        .join(", ")}`;
    }

    // Run-notes presence is part of the gate. A missing or skeletal
    // run-notes file produces an empty PR body and makes the whole
    // bot look broken — strictly worse than a draft PR with an
    // explicit "no changes needed" analysis, because reviewers have
    // nothing to react to. Treat it the same as a red gate.
    const runNotesIssue = validateRunNotes(newVersion);
    if (runNotesIssue && !budgetReason) {
      budgetReason = runNotesIssue;
      log(`gate: run-notes validation FAILED — ${runNotesIssue}`);
    } else if (runNotesIssue) {
      // Already in budget-exit territory; append for visibility.
      budgetReason = `${budgetReason}; also: ${runNotesIssue}`;
      log(`gate: run-notes validation FAILED — ${runNotesIssue}`);
    } else {
      log(`gate: run-notes validation ok`);
    }

    // 5th progress post: the gate verdict. Fires whether green or red
    // so the channel always hears the test outcome immediately, not
    // minutes later via the draft-PR announce (green) or the
    // process-issue announce (red). On a red run this is also the
    // first place reviewers see WHICH gate steps failed — the existing
    // process-issue message is intentionally generic.
    await announceProgress(
      buildGateResultAnnouncement({
        prevVersion,
        newVersion,
        results: gate,
        runNotesIssue,
        budgetReason,
      }),
    );

    // Dry-run short-circuit: everything above this point ran for real
    // (branch created, deps bumped, Claude did the work, gate ran,
    // run-notes validated). Below this point we'd push to origin,
    // open a PR, watch CI, and announce to the chat-server — none of
    // which we want during local iteration on the prompt.
    if (dryRun) {
      log("──────────────────────────────────────────────────────────");
      log(`DRY RUN — stopping before push/PR/CI/announce`);
      log(`Branch ${branch} is checked out locally with all of Claude's commits.`);
      const notesPath = runNotesPath(newVersion);
      const archived = promptArchivePath(newVersion);
      const tx = transcriptPath(newVersion);
      log(`Per-version artifacts:`);
      if (existsSync(notesPath)) {
        log(`  run-notes:  ${relative(ROOT, notesPath)} (${readFileSync(notesPath, "utf8").length} bytes)`);
      } else {
        log(`  run-notes:  (file missing — bug, the stub should have been pre-created)`);
      }
      if (existsSync(archived)) {
        log(`  prompt:     ${relative(ROOT, archived)} (${readFileSync(archived, "utf8").length} bytes)`);
      }
      if (existsSync(tx)) {
        log(`  transcript: ${relative(ROOT, tx)} (${readFileSync(tx, "utf8").length} bytes, JSONL)`);
      }
      log(`Inspect commits:  git log origin/main..HEAD --oneline`);
      log(`Inspect diff:     git diff origin/main..HEAD`);
      log(`Inspect notes:    cat ${relative(ROOT, notesPath)}`);
      log(`Inspect prompt:   cat ${relative(ROOT, archived)}`);
      log(`Inspect Claude:   jq -c '.type' ${relative(ROOT, tx)} | sort | uniq -c`);
      log(`Clean up:         git checkout main && git branch -D ${branch}`);
      log(`Push manually:    git push -u origin ${branch}`);
      log("──────────────────────────────────────────────────────────");
      return;
    }

    // ── Requested release workflow ───────────────────────────────────
    // local-green → push → draft PR (triggers CI) → CI-fix loop → mark
    // ready when green. Any unrecoverable snag files a GitHub issue and
    // pings the community channel.

    // 1. Local gate outcome.
    //
    //    Originally we returned early on a red local gate and the
    //    operator was left with a one-line "kind=local gates failed"
    //    issue and no PR — no way to see WHICH test failed without
    //    ssh'ing to the cron host to tail `cron.log`.
    //
    //    Now: a red local gate ALSO ships Claude's work as a draft +
    //    needs-human PR, with the per-step gate tail embedded in the
    //    body via `buildGateFailureBanner`. The same banner goes into
    //    the GitHub issue's body so the reviewer gets the actionable
    //    detail in BOTH surfaces. The operator can then either fix the
    //    branch by hand or re-run via `make sdk-update-fix-pr PR=<n>`
    //    to let Claude iterate.
    //
    //    Failure mode for the draft-PR-open path itself (push fails,
    //    `gh pr create` fails, etc.): we log + fall through to the
    //    issue-only behavior so an operator still hears about the
    //    underlying gate failure.
    const localGreen = allGreen && !runNotesIssue;
    if (!localGreen) {
      const reason = budgetReason ?? "local gate not green";
      const gateBanner = buildGateFailureBanner(gate);
      log(`local gate NOT green (${reason}) — opening as draft + filing process issue with tail output`);

      let draftPrUrl: string | null = null;
      try {
        pushBranch(branch);
        const draftBody = renderPrBody({
          branch,
          prevVersion,
          newVersion,
          changelog,
          budgetWarning: gateBanner,
        });
        const draftPr = openPr({
          branch,
          newVersion,
          prevVersion,
          body: draftBody,
          draft: true,
        });
        draftPrUrl = draftPr.url;
        log(`draft PR opened: ${draftPrUrl}`);
        await announceSafe(
          buildOpenedAnnouncement({
            prUrl: draftPrUrl,
            prevVersion,
            newVersion,
            created: draftPr.created,
            draft: true,
            reason,
          }),
          { pin: false },
        );
      } catch (err) {
        // Push or PR-open failed. The gate-fail issue below still
        // surfaces the actionable detail; the operator has to inspect
        // the local branch on the cron host this one time.
        log(
          `WARN could not push/open draft PR after local gate failure: ${err instanceof Error ? err.message : String(err)} — falling back to issue-only`,
        );
      }

      await reportProcessIssueSafe({
        kind: "local gates failed",
        reason,
        prevVersion,
        newVersion,
        branch,
        prUrl: draftPrUrl,
        // The banner duplicates content already in the PR body when the
        // draft-PR open path succeeded, but it's exactly what makes the
        // GitHub issue actionable on its own (e.g. when the operator
        // hits the issue from a notification and wants to know what
        // broke without navigating to the PR).
        extras: gateBanner ? [gateBanner] : undefined,
      });
      return;
    }

    // 1b. Opportunistic combined-mode probe. If the cc-parity baseline
    //     is behind the published claude-code version, run the CC parity
    //     half on the same branch BEFORE we push, so the PR carries
    //     both halves. CC failure semantics:
    //
    //     - CC green: combined PR (one PR, both halves).
    //     - CC red (or threw): peel CC commits off → ship SDK PR full;
    //       cherry-pick CC onto detached branch as draft + needs-human
    //       (cherry-pick failure → drop CC + report).
    //
    //     In all CC-fail paths the SDK PR ships — the spec is explicit
    //     about that. See `peelCcCommitsToDraftBranch` for the actual
    //     git plumbing (injectable git-runner so it's unit-testable).
    const combined = await maybeRunCombinedCc({
      prevSdkVersion: prevVersion,
      newSdkVersion: newVersion,
      branch,
      skipGates,
      announceProgress,
      // Pass the SDK half's run-notes Summary so the combined
      // implementation-summary announce can pair both halves.
      sdkRunNotesSummary: runNotesSummary,
    });

    // `combinedOutcome` is declared above the try block (next to
    // `combinedCcVersion`) so the finally block can always reference it,
    // even on an early throw. Default "failure"; pinned at each decision
    // point below.

    // Peel outcome — carried out of the failure-mode branch so the
    // draft-detached announce + CC draft PR open can happen AFTER the
    // SDK PR ships (so the announce has both URLs).
    let peelOutcome: PeelOutcome | null = null;
    if (combined.kind === "ran" && !combined.ok) {
      log(
        `combined CC half failed (${combined.budgetReason ?? "no reason given"}) — ` +
          `peeling CC commits and shipping SDK PR full`,
      );
      peelOutcome = peelCcCommitsToDraftBranch({
        shaBeforeCcWork: combined.shaBeforeCcWork,
        newSdkVersion: newVersion,
        newCcVersion: combined.newCcVersion,
        runner: realGitRunner(),
      });
      // After the peel:
      //   - "drafted": detached cc-parity branch is on origin; we'll
      //     open the draft PR after the SDK PR ships.
      //   - "dropped": CC work is lost from this firing; SDK still ships.
      // Either way, we switch the SDK branch back to its name so the
      // SDK push below targets the right ref.
      try {
        sh("git", ["checkout", branch]);
      } catch (err) {
        log(`WARN could not checkout SDK branch ${branch} after peel: ${String(err)} — SDK push may fail`);
      }
    }

    // 2. Local green → push the branch.
    pushBranch(branch);

    // 3. Open a DRAFT PR. ci.yml runs CI on `pull_request` (and pushes to
    //    main) — NOT on a push to this feature branch — so the PR is what
    //    triggers CI. We open it as a draft ("not for review yet") and
    //    only promote it to ready once CI is green (step 5): that is the
    //    user-facing "create the PR" moment.
    const isCombined = combined.kind === "ran" && combined.ok;
    if (isCombined) {
      // Record the CC version so the finally block can patch CC state
      // in lockstep with the SDK state when `shipped` flips true below.
      combinedCcVersion = combined.newCcVersion;
    } else if (
      combined.kind === "ran" &&
      !combined.ok &&
      peelOutcome?.kind === "drafted"
    ) {
      // CC half failed AND we successfully peeled to a detached
      // branch. Even though the combined PR isn't going to exist, the
      // CC version IS handled this firing — record it now so the
      // finally block knows to patch CC state in `combined-draft` mode
      // alongside the SDK ship below.
      combinedCcVersion = combined.newCcVersion;
    }
    const body = isCombined
      ? renderCombinedPrBody({
          branch,
          prevSdkVersion: prevVersion,
          newSdkVersion: newVersion,
          sdkChangelog: changelog,
          sdkRunNotes: existsSync(runNotesPath(newVersion))
            ? readFileSync(runNotesPath(newVersion), "utf8")
            : "",
          prevCcVersion: combined.prevCcVersion,
          newCcVersion: combined.newCcVersion,
          ccChangelog: combined.changelog,
          ccRunNotes: existsSync(ccRunNotesPath(combined.newCcVersion))
            ? readFileSync(ccRunNotesPath(combined.newCcVersion), "utf8")
            : "",
          budgetWarning: "",
        })
      : renderPrBody({
          branch,
          prevVersion,
          newVersion,
          changelog,
          ...(await resolveCcChangelogForSdkPr().then((cc) => ({
            ccChangelog: cc.body,
            ccChangelogUrl: cc.url,
          }))),
          budgetWarning: "",
        });
    const pr = isCombined
      ? openPrWithTitle({
          branch,
          title: `chore(deps): bump claude-agent-sdk ${prevVersion} → ${newVersion} + claude-code ${combined.prevCcVersion} → ${combined.newCcVersion}`,
          body,
          draft: true,
        })
      : openPr({ branch, newVersion, prevVersion, body, draft: true });
    prUrl = pr.url;
    const prNumber = prUrl.split("/").pop() ?? prUrl;
    log(`draft PR ${pr.created ? "opened" : "updated"}: ${prUrl} (watching CI before marking ready)`);
    await announceSafe(
      isCombined
        ? buildCombinedOpenedAnnouncement({
            prUrl,
            prevSdkVersion: prevVersion,
            newSdkVersion: newVersion,
            prevCcVersion: combined.prevCcVersion,
            newCcVersion: combined.newCcVersion,
            created: pr.created,
          })
        : buildOpenedAnnouncement({
            prUrl,
            prevVersion,
            newVersion,
            created: pr.created,
            draft: true,
            reason: "watching CI before marking ready for review",
          }),
      { pin: false },
    );

    // 4. Watch CI. While it's red, re-run Claude with the failing checks
    //    as context, re-gate locally, re-push (only when local-green), and
    //    re-watch — up to MAX_CI_FIX_ATTEMPTS times.
    let ciPassed = watchCi(prUrl).passed;
    let ciAttempt = 0;
    while (!ciPassed && ciAttempt < MAX_CI_FIX_ATTEMPTS) {
      ciAttempt++;
      log(`CI red on ${prUrl} — fix attempt ${ciAttempt}/${MAX_CI_FIX_ATTEMPTS}`);
      const meta = readPrMeta(prNumber);
      const { allGreen: fixGreen, failedSteps } = await runFixPass(
        prNumber,
        meta,
        "",
        skipGates,
      );
      if (!fixGreen) {
        log(
          `fix attempt ${ciAttempt} did not reach local green (failed: ${failedSteps.join(", ")}) — not pushing; stopping CI loop`,
        );
        break;
      }
      pushBranch(branch); // re-push the fix → triggers a fresh CI run
      ciPassed = watchCi(prUrl).passed;
    }

    // 5. SDK PR outcome.
    if (ciPassed) {
      // CI green → promote the draft to a reviewable PR + drop needs-human.
      try {
        sh("gh", ["pr", "ready", prNumber]);
        log(`CI green — marked PR #${prNumber} ready for review`);
      } catch (err) {
        log(`WARN could not mark PR ready: ${String(err)}`);
      }
      try {
        sh("gh", ["pr", "edit", prNumber, "--remove-label", "needs-human"]);
      } catch {
        // Label may not be present — fine.
      }
      shipped = true;

      // Pin the SDK-side outcome. The detached-CC block below may
      // promote `sdk-only-success` → `combined-draft` when the
      // cherry-pick worked AND the SDK CI is green.
      combinedOutcome = isCombined ? "combined-success" : "sdk-only-success";

      await announceSafe(
        isCombined
          ? buildCombinedShippedAnnouncement({
              prUrl,
              prevSdkVersion: prevVersion,
              newSdkVersion: newVersion,
              prevCcVersion: combined.prevCcVersion,
              newCcVersion: combined.newCcVersion,
            })
          : buildShippedAnnouncement({ prUrl, newVersion, prevVersion }),
        { pin: true },
      );
    } else {
      // Fix loop exhausted (or a fix run couldn't reach local green).
      // Leave the PR as a draft + needs-human and file a process issue.
      // `combinedOutcome` stays at "failure" UNLESS the CC-detached
      // block below upgrades it to "sdk-failure-cc-draft".
      const reason = `CI still red after ${ciAttempt} fix attempt(s) — see ${prUrl}`;
      log(reason);
      try {
        sh("gh", ["pr", "edit", prNumber, "--add-label", "needs-human"]);
      } catch {
        // Best-effort label.
      }
      await reportProcessIssueSafe({
        kind: "CI still red after fix attempts",
        reason,
        prevVersion,
        newVersion,
        branch,
        prUrl,
      });
    }

    // 6. Detached-CC handling — fires REGARDLESS of SDK CI outcome.
    //
    // Originally this block sat inside `if (ciPassed)`, which left an
    // orphan branch on origin when SDK CI went red AFTER we had
    // already peeled + cherry-picked CC commits to a detached branch:
    // the branch was on origin but the PR was never opened, and `cc
    // lastCompletedVersion` was never bumped, so the standalone cron
    // would refire on the same CC version next tick and open ANOTHER
    // branch. The fix is to open the CC draft PR (and bump CC state)
    // whether SDK CI passed or not — SDK draft vs SDK ready is
    // orthogonal to "CC half exists as a draft on its own branch."
    //
    // The four (ciPassed, peelOutcome) shapes resolve as:
    //   (green, drafted) → combinedOutcome upgrades to "combined-draft"
    //   (red,   drafted) → combinedOutcome upgrades to "sdk-failure-cc-draft"
    //   (green, dropped) → announce + report; combinedOutcome stays sdk-only-success
    //   (red,   dropped) → announce + report; combinedOutcome stays "failure"
    if (
      combined.kind === "ran" &&
      !combined.ok &&
      peelOutcome?.kind === "drafted"
    ) {
      const ccRunNotes = existsSync(ccRunNotesPath(combined.newCcVersion))
        ? readFileSync(ccRunNotesPath(combined.newCcVersion), "utf8")
        : "";
      const ccPrBody = buildDetachedCcPrBody({
        prevCcVersion: combined.prevCcVersion,
        newCcVersion: combined.newCcVersion,
        prevSdkVersion: prevVersion,
        newSdkVersion: newVersion,
        sdkPrUrl: prUrl,
        ccCommitShas: peelOutcome.ccCommitShas,
        ccFailReason:
          combined.budgetReason ??
          `cc-parity gate failed: ${combined.failedSteps.join(", ") || "unknown"}`,
        ccRunNotes,
        ccSessionId: combined.ccSessionId,
        detachedBranch: peelOutcome.detachedBranch,
      });
      // Promote `combinedOutcome` the moment cherry-pick succeeded —
      // regardless of whether the subsequent PR-open call succeeds.
      // The CC version IS handled this firing in either shape: the
      // branch is on origin and a reviewer can open the PR by hand if
      // `gh` fails. Distinguish (SDK CI green) from (SDK CI red): the
      // former bumps both states, the latter bumps only CC state.
      combinedOutcome = ciPassed ? "combined-draft" : "sdk-failure-cc-draft";
      let ccPrUrl: string | null = null;
      try {
        const ccPr = openPrWithTitle({
          branch: peelOutcome.detachedBranch,
          title: `feat(cc-parity): claude-code ${combined.prevCcVersion} → ${combined.newCcVersion} (detached from SDK ${newVersion})`,
          body: ccPrBody,
          draft: true,
        });
        ccPrUrl = ccPr.url;
        log(`detached cc-parity draft PR opened: ${ccPrUrl}`);
        await announceSafe(
          buildDraftDetachedAnnouncement({
            sdkPrUrl: prUrl,
            ccPrUrl,
            prevSdkVersion: prevVersion,
            newSdkVersion: newVersion,
            prevCcVersion: combined.prevCcVersion,
            newCcVersion: combined.newCcVersion,
            reason:
              combined.budgetReason ??
              `cc-parity gate failed: ${combined.failedSteps.join(", ") || "unknown"}`,
          }),
          { pin: false },
        );
      } catch (err) {
        // Opening the detached draft PR failed AFTER cherry-pick
        // succeeded. The branch is on origin; the operator can open
        // the PR by hand. CC state still gets bumped (combinedOutcome
        // is pinned above) since the version is handled — just via a
        // branch with no PR yet.
        log(
          `WARN detached cc-parity PR open failed: ${String(err)} — branch ${peelOutcome.detachedBranch} is on origin; operator can open the PR manually`,
        );
        await reportProcessIssueSafe({
          kind: "combined CC parity detached PR open failed",
          reason: err instanceof Error ? err.message : String(err),
          prevVersion,
          newVersion,
          branch: peelOutcome.detachedBranch,
          prUrl,
        });
      }
    } else if (combined.kind === "ran" && !combined.ok && peelOutcome?.kind === "dropped") {
      // CC half failed AND we couldn't even peel/cherry-pick it onto a
      // separate branch. CC state stays untouched — the standalone
      // cron will retry on its next firing. `combinedOutcome` is
      // unchanged: "sdk-only-success" if SDK CI was green, "failure"
      // if red.
      await announceSafe(
        buildCcDroppedAnnouncement({
          sdkPrUrl: prUrl,
          prevSdkVersion: prevVersion,
          newSdkVersion: newVersion,
          prevCcVersion: combined.prevCcVersion,
          newCcVersion: combined.newCcVersion,
          ccFailReason:
            combined.budgetReason ??
            `cc-parity gate failed: ${combined.failedSteps.join(", ") || "unknown"}`,
          peelFailReason: peelOutcome.reason,
        }),
        { pin: false },
      );
      // Also file a process issue so the failure has a permanent home
      // outside the chat channel.
      await reportProcessIssueSafe({
        kind: "combined CC parity dropped (peel/cherry-pick failed)",
        reason: `CC: ${combined.budgetReason ?? "gate failed"}; peel: ${peelOutcome.reason}`,
        prevVersion,
        newVersion,
        branch,
        prUrl,
      });
    }

    // Reached the normal end of the run without throwing — mark success so
    // `finally` returns the working tree to main. (A dry-run or local-gate
    // failure returns earlier and never gets here; a crash jumps to catch.)
    completedOk = true;
  } catch (err) {
    log(`orchestrator threw: ${err instanceof Error ? err.stack : String(err)}`);
    // Surface unrecoverable failures out-of-band so a human hears about
    // them. Best-effort — never let issue/announce failures mask the
    // original error or swallow the rethrow.
    await reportProcessIssueSafe({
      kind: "crashed",
      reason: err instanceof Error ? err.message : String(err),
      prevVersion,
      newVersion,
      branch: null,
      prUrl,
    }).catch(() => {});
    throw err;
  } finally {
    // State coordination: the explicit `combinedOutcome` variable
    // carries the three-way CC outcome (success / drafted / dropped)
    // that derived state from `shipped` + `combinedCcVersion` can't
    // express. Each decision point above pins `combinedOutcome` to one
    // of the four modes; the default is "failure" so an early throw
    // before any decision still patches only the inFlight clear.
    const patches = decideCombinedStateUpdates({
      mode: combinedOutcome,
      newSdkVersion: newVersion,
      newCcVersion: combinedCcVersion,
    });
    patchState(patches.sdkPatch, ROOT);
    if (patches.ccPatch) {
      patchCcState(patches.ccPatch, ROOT);
    }
    if (prUrl) {
      log(
        `final state: shipped=${shipped} mode=${combinedOutcome} pr=${prUrl}` +
          (combinedCcVersion ? ` ccVersion=${combinedCcVersion}` : ""),
      );
    }
    // On a successful finish, return the working tree (and any running dev
    // server) to main. Skipped on crash / gate-fail / dry-run so those
    // stay on the branch for debugging.
    if (completedOk) {
      returnToMainBestEffort();
    }
  }
}

// Marker so other modules (eg unit tests) can import helpers above without
// running main().
const invokedAsScript =
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (import.meta as any).main === true ||
  (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]));

if (invokedAsScript) {
  main().catch(() => {
    process.exit(1);
  });
}

// silence "imported but unused" for spawn — kept in case future
// follow-ups need a streaming child process from helpers above.
void spawn;
void relative;
