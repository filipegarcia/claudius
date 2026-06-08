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
 *   2. Branch      — fetch origin, create `sdk-update/<version>` off main.
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
 *   SDK_UPDATE_MAX_TURNS       optional — agentic turn budget, default 200
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
  patchState,
  readInstalledRange,
  readState,
  repoRoot,
} from "./check";

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
const MAX_TURNS = Number(process.env.SDK_UPDATE_MAX_TURNS ?? "200");
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
 * Create the upgrade branch fresh off origin/main. Idempotent: if a
 * branch with this name already exists locally or on origin we delete
 * the local copy and re-create from the remote tip. If the branch
 * already exists on origin from a previous run, we hard-reset it to
 * origin/main — the previous run will have either landed or been
 * abandoned, and starting fresh is safer than rebasing on stale work.
 */
function checkoutFreshBranch(version: string): string {
  const branch = branchName(version);
  log(`syncing origin/main`);
  sh("git", ["fetch", "origin", "main", "--prune"]);

  // Detach so we can freely delete any branch including the current one.
  sh("git", ["checkout", "--detach", "origin/main"]);

  // Wipe local copy if present.
  const local = sh("git", ["branch", "--list", branch]);
  if (local.trim() !== "") {
    log(`deleting stale local branch ${branch}`);
    sh("git", ["branch", "-D", branch]);
  }

  log(`creating ${branch} off origin/main`);
  sh("git", ["checkout", "-b", branch, "origin/main"]);
  return branch;
}

// ── package.json bump ─────────────────────────────────────────────────

function bumpSdkDependency(version: string): void {
  const pkgPath = resolve(ROOT, "package.json");
  const raw = readFileSync(pkgPath, "utf8");
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
      const m = msg as { type?: string; subtype?: string };
      const summary = summarizeSdkMessage(m);
      lastMsgSummary = summary;
      appendTranscript(msg);
      log(`claude msg #${turnCount} ${summary}`);
      if (idleTimedOut) break;
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
  };
}

// ── Gate (lint / unit / build / e2e) ──────────────────────────────────

export type GateStep = "lint" | "unit" | "build" | "e2e";
export type GateResult = {
  step: GateStep;
  ok: boolean;
  skipped?: boolean;
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

export function runGate(skip: Set<GateStep>): GateResult[] {
  const steps: Array<{ step: GateStep; cmd: string; args: string[] }> = [
    { step: "lint", cmd: "bun", args: ["run", "lint"] },
    { step: "unit", cmd: "bun", args: ["run", "test"] },
    { step: "build", cmd: "bun", args: ["run", "build"] },
    { step: "e2e", cmd: "bun", args: ["run", "test:e2e"] },
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
    log(`gate: ${s.step}`);
    const code = shStream(s.cmd, s.args);
    out.push({ step: s.step, ok: code === 0 });
    if (code !== 0) {
      log(`gate: ${s.step} FAILED (exit ${code})`);
    }
  }
  return out;
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

function renderPrBody(args: {
  branch: string;
  prevVersion: string;
  newVersion: string;
  changelog: string;
  budgetWarning: string;
}): string {
  const notesFile = runNotesPath(args.newVersion);
  const notes = existsSync(notesFile) ? readFileSync(notesFile, "utf8") : "";
  const tpl = readFileSync(resolve(SCRIPT_DIR, "pr-template.md"), "utf8");

  return tpl
    .replace(/\{\{NEW_VERSION\}\}/g, args.newVersion)
    .replace(/\{\{PREVIOUS_VERSION\}\}/g, args.prevVersion)
    .replace(
      /\{\{CHANGELOG_URL\}\}/g,
      `https://github.com/${UPSTREAM_GH}/compare/v${args.prevVersion}...v${args.newVersion}`,
    )
    .replace(/\{\{CHANGELOG_BODY\}\}/g, args.changelog)
    .replace(/\{\{NOTES_SUMMARY\}\}/g, extractSection(notes, "Summary"))
    .replace(/\{\{NOTES_SDK\}\}/g, extractSection(notes, "SDK changelog highlights"))
    .replace(/\{\{NOTES_CODE\}\}/g, extractSection(notes, "Code changes"))
    .replace(/\{\{NOTES_UI\}\}/g, extractSection(notes, "New UI surfaces"))
    .replace(/\{\{NOTES_TESTS\}\}/g, extractSection(notes, "Tests"))
    .replace(/\{\{NOTES_RISKS\}\}/g, extractSection(notes, "Risks / follow-ups"))
    .replace(/\{\{SCREENSHOTS_BLOCK\}\}/g, buildScreenshotsBlock(args.branch, args.newVersion))
    .replace(/\{\{BUDGET_STATUS\}\}/g, args.budgetWarning);
}

// ── Push & PR ─────────────────────────────────────────────────────────

export function pushBranch(branch: string): void {
  // If Claude didn't commit anything (unlikely but possible) we make a
  // marker commit so the branch can still be pushed — that way the
  // human gets a draft PR pointing at the dependency bump even if the
  // model bailed early.
  // (Local name avoids shadowing the module-level `log()` helper.)
  const commitsAhead = sh("git", ["log", "origin/main..HEAD", "--oneline"]);
  if (commitsAhead.trim() === "") {
    sh("git", [
      "commit",
      "--allow-empty",
      "-m",
      "chore(sdk-update): empty commit so a PR can be opened",
    ]);
  }
  // Idempotency on re-run: a previous firing may have left the branch
  // on origin. We already nuked the local copy in checkoutFreshBranch
  // and built fresh on top of origin/main, so our local tree IS the
  // canonical state — force-with-lease is safe (and rejects if someone
  // else somehow pushed in between, which is the protection we want).
  // `-u` sets upstream tracking the first time and is harmless on
  // subsequent runs.
  // Push using gh's token as the credential helper rather than whatever
  // git's global `credential.helper` happens to be. Preflight already
  // verified `gh auth status`, so this makes the long-standing "if gh
  // works, push works" assumption actually true — no dependency on
  // `gh auth setup-git` having been run, or on an osxkeychain entry that
  // may not exist on a headless box. The empty `credential.helper=`
  // first clears any inherited helper (e.g. osxkeychain) so it can't
  // shadow gh with a stale/missing entry; the second installs gh.
  const pushCode = shStream("git", [
    "-c",
    "credential.helper=",
    "-c",
    "credential.helper=!gh auth git-credential",
    "push",
    "-u",
    "--force-with-lease",
    "origin",
    branch,
  ]);
  if (pushCode !== 0) {
    // Earlier this was a silent fall-through into `gh pr create`,
    // which then died with a misleading GraphQL error one step later.
    // Surface the actual cause: a 403 here means the configured `gh`
    // token is missing `repo` (classic PAT) or `Contents: Write` +
    // `Pull requests: Write` (fine-grained PAT) on this repo. Fix:
    // `gh auth login --git-protocol https --web` and re-run, or
    // regenerate the PAT with the right scopes.
    throw new Error(
      `git push exited ${pushCode} — refusing to attempt PR open.\n` +
        `Most likely cause: gh credentials don't have write access. Try:\n` +
        `  gh auth setup-git   # configure git to use gh's token\n` +
        `  gh auth status      # confirm which scopes are granted\n` +
        `If that still fails, re-do \`gh auth login --git-protocol https --web\`.`,
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
      { cwd: ROOT, input: args.body, encoding: "utf8" },
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
      input: args.body,
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
}): string {
  return [
    `🆕 **New claude-agent-sdk release: ${args.prevVersion} → ${args.newVersion}.**`,
    "",
    `Starting upgrade on branch \`${args.branch}\` — fetching changelog, then handing the migration to Claude.`,
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
  const { title, body, commentBody } = buildRunIssue(args);
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
    const url = sh("gh", ["issue", "create", "--title", title, "--body", body]).trim();
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

  const gate = runGate(skipGates);
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
}): Promise<void> {
  const issueUrl = fileOrCommentRunIssueSafe({
    prevVersion: args.prevVersion,
    newVersion: args.newVersion,
    kind: args.kind,
    reason: args.reason,
    branch: args.branch,
    prUrl: args.prUrl,
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
        branch: branchName(newVersion),
        startedAt: Date.now(),
      },
    },
    ROOT,
  );

  let prUrl: string | null = null;
  let shipped = false;
  let budgetReason: string | null = null;

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
    const branch = checkoutFreshBranch(newVersion);

    // 1st progress post: "found new version, starting upgrade". Goes out
    // as soon as the branch exists so the channel hears about the run
    // within seconds of cron firing — minutes before the draft PR.
    await announceProgress(
      buildStartAnnouncement({ prevVersion, newVersion, branch }),
    );

    bumpSdkDependency(newVersion);
    // Keep Claudius's displayed version in lock-step with the SDK. The
    // trailing `.N` release counter is git-derived (see
    // lib/shared/version.ts + scripts/claudius-release.mjs), so this commit
    // becoming the new anchor automatically resets it to .0.
    bumpClaudiusVersion(newVersion);

    // First commit lands cleanly — gives Claude a known starting point
    // and makes the dep bump easy to revert independently if needed.
    sh("git", ["add", "package.json", "bun.lock"]);
    sh("git", [
      "commit",
      "-m",
      `chore(deps): bump claude-agent-sdk to ${newVersion}`,
    ]);

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

    const gate = runGate(skipGates);
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

    // 1. Push ONLY when the local gate is green. A red local tree never
    //    reaches origin; we file a process issue + ping the channel and
    //    stop. (`allGreen`/`runNotesIssue` were computed above; reuse
    //    `budgetReason` as the human-readable cause.)
    const localGreen = allGreen && !runNotesIssue;
    if (!localGreen) {
      const reason = budgetReason ?? "local gate not green";
      log(`local gate NOT green (${reason}) — not pushing; filing process issue`);
      await reportProcessIssueSafe({
        kind: "local gates failed",
        reason,
        prevVersion,
        newVersion,
        branch,
        prUrl: null,
      });
      return;
    }

    // 2. Local green → push the branch.
    pushBranch(branch);

    // 3. Open a DRAFT PR. ci.yml runs CI on `pull_request` (and pushes to
    //    main) — NOT on a push to this feature branch — so the PR is what
    //    triggers CI. We open it as a draft ("not for review yet") and
    //    only promote it to ready once CI is green (step 5): that is the
    //    user-facing "create the PR" moment.
    const body = renderPrBody({
      branch,
      prevVersion,
      newVersion,
      changelog,
      budgetWarning: "",
    });
    const pr = openPr({ branch, newVersion, prevVersion, body, draft: true });
    prUrl = pr.url;
    const prNumber = prUrl.split("/").pop() ?? prUrl;
    log(`draft PR ${pr.created ? "opened" : "updated"}: ${prUrl} (watching CI before marking ready)`);
    await announceSafe(
      buildOpenedAnnouncement({
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

    // 5. Outcome.
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
      await announceSafe(
        buildShippedAnnouncement({ prUrl, newVersion, prevVersion }),
        { pin: true },
      );
    } else {
      // Fix loop exhausted (or a fix run couldn't reach local green).
      // Leave the PR as a draft + needs-human and file a process issue.
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
    patchState(
      {
        inFlight: null,
        ...(shipped ? { lastCompletedVersion: newVersion } : {}),
      },
      ROOT,
    );
    if (prUrl) {
      log(`final state: shipped=${shipped} pr=${prUrl}`);
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
