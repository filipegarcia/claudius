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
 *   3. Bump        — edit package.json, `bun install`.
 *   4. Changelog   — extract upstream notes between PREV..NEW.
 *   5. Run Claude  — `query({ prompt, options })` with bypassPermissions,
 *                    streamed under a wall-clock + turn budget.
 *   6. Gate        — run lint/test/build/e2e. If green, full PR.
 *                    If red AND budget exhausted, draft PR with
 *                    `needs-human` label.
 *   7. Push + PR   — `gh pr create` with the templated body.
 *   8. CI watch    — `gh pr checks --watch`.
 *   9. Announce    — POST to chat-server /admin/announce (only on
 *                    fully-green ship).
 *  10. State       — update lastCompletedVersion / clear inFlight.
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
 */

import { spawn, spawnSync, type SpawnOptions } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
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

const MODEL = process.env.SDK_UPDATE_MODEL ?? "sonnet";
const MAX_TURNS = Number(process.env.SDK_UPDATE_MAX_TURNS ?? "200");
const MAX_WALL_MS = Number(process.env.SDK_UPDATE_MAX_WALL_MIN ?? "360") * 60_000;

// ── Logging ───────────────────────────────────────────────────────────

function log(line: string): void {
  // ISO timestamp keeps cron-log forensics easy.
  console.log(`[sdk-update/orchestrate ${new Date().toISOString()}] ${line}`);
}

function fatal(line: string): never {
  console.error(`[sdk-update/orchestrate FATAL] ${line}`);
  process.exit(1);
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

function preflight(): void {
  if (!process.env.ANTHROPIC_API_KEY) {
    fatal("ANTHROPIC_API_KEY is not set — the Agent SDK can't authenticate.");
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
  // Hard refusal on a dirty tree: we're about to bump deps and let
  // Claude reshape the world. A pre-existing diff would silently
  // ride along into the PR.
  const status = sh("git", ["status", "--porcelain"]);
  if (status.trim() !== "") {
    fatal(
      `working tree is not clean — orchestrator refuses to start.\nstatus:\n${status}`,
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
      `("${SDK_PKG_NAME.replace(/[/@\-]/g, "\\$&")}"\\s*:\\s*")([^"]+)(")`,
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

// ── Changelog extraction ──────────────────────────────────────────────

/**
 * Try, in order:
 *   1. `node_modules/@anthropic-ai/claude-agent-sdk/CHANGELOG.md` —
 *      sliced between the two version headers.
 *   2. GitHub Releases API for UPSTREAM_GH — bodies between tags.
 * If both fail, return a stub note. We never want changelog failure to
 * block the run; Claude can still read the upstream repo via the
 * compare URL we bake into the prompt.
 */
function extractChangelog(prevVersion: string, newVersion: string): string {
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
      if (sliced) return sliced;
    } catch (err) {
      log(`local CHANGELOG.md parse failed: ${String(err)} — falling back to gh`);
    }
  }
  try {
    const compare = sh("gh", [
      "api",
      `repos/${UPSTREAM_GH}/compare/v${prevVersion}...v${newVersion}`,
      "--jq",
      ".commits[] | \"- \" + (.commit.message | split(\"\\n\")[0]) + \" (\" + .sha[0:7] + \")\"",
    ]);
    if (compare.trim() !== "") {
      return `_(commit list — upstream did not publish a release body for every tag)_\n\n${compare}`;
    }
  } catch (err) {
    log(`gh compare API fallback failed: ${String(err)}`);
  }
  return `_(automatic changelog extraction failed — see https://github.com/${UPSTREAM_GH}/compare/v${prevVersion}...v${newVersion})_`;
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
    new RegExp(`^##\\s+\\[?v?${v.replace(/\./g, "\\.")}\\]?`, "i");
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
 * Hand the prompt to the Agent SDK. We import `query` dynamically so
 * the orchestrator stays importable in environments without the SDK
 * (e.g. running just `check.ts` from a slimmer container).
 *
 * Returns `{ completed, turnCount, wallMs }`. `completed = true` when
 * the iterator drained naturally; `false` means we hit the budget
 * abort. The caller decides what to do with a budget-aborted run.
 */
async function runClaude(prompt: string): Promise<{
  completed: boolean;
  turnCount: number;
  wallMs: number;
  budgetReason: string | null;
}> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const sdk: any = await import(SDK_PKG_NAME);
  const query: (args: unknown) => AsyncIterable<unknown> & {
    interrupt?: () => Promise<void>;
  } = sdk.query;

  const startedAt = Date.now();
  const deadline = startedAt + MAX_WALL_MS;
  let turnCount = 0;
  let completed = false;
  let budgetReason: string | null = null;

  const q = query({
    prompt,
    options: {
      cwd: ROOT,
      model: MODEL,
      permissionMode: "bypassPermissions",
      // Per node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts:
      // bypassPermissions is gated on this opt-in flag.
      allowDangerouslySkipPermissions: true,
      // Hard ceiling on agentic round-trips. The SDK enforces this on
      // its side; we *also* watch wall-clock below in case a single
      // turn drags on (long tool call, network hang).
      maxTurns: MAX_TURNS,
    },
  });

  // The SDK's `query` iterator emits one SDKMessage per agent step.
  // We don't need to inspect bodies here — the model writes its
  // results to the working tree, which we'll gate after the loop.
  // We log a one-liner per message so cron logs stay grep-able.
  try {
    for await (const msg of q) {
      turnCount += 1;
      const m = msg as { type?: string; subtype?: string };
      log(`claude msg #${turnCount} type=${m.type ?? "?"} subtype=${m.subtype ?? "-"}`);
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
  } catch (err) {
    log(`claude iterator threw: ${err instanceof Error ? err.message : String(err)}`);
    budgetReason = `iterator error: ${err instanceof Error ? err.message : String(err)}`;
  }

  return {
    completed,
    turnCount,
    wallMs: Date.now() - startedAt,
    budgetReason,
  };
}

// ── Gate (lint / unit / build / e2e) ──────────────────────────────────

type GateResult = {
  step: "lint" | "unit" | "build" | "e2e";
  ok: boolean;
};

function runGate(): GateResult[] {
  const steps: Array<{ step: GateResult["step"]; cmd: string; args: string[] }> = [
    { step: "lint", cmd: "bun", args: ["run", "lint"] },
    { step: "unit", cmd: "bun", args: ["run", "test"] },
    { step: "build", cmd: "bun", args: ["run", "build"] },
    { step: "e2e", cmd: "bun", args: ["run", "test:e2e"] },
  ];
  const out: GateResult[] = [];
  for (const s of steps) {
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

/** Pull a `## Section name` block out of a markdown file, exclusive of the next `## `. */
function extractSection(md: string, heading: string): string {
  const re = new RegExp(`(^|\\n)## +${heading}[^\\n]*\\n([\\s\\S]*?)(?=\\n## |$)`);
  const m = md.match(re);
  return m ? m[2]!.trim() : `_(run-notes did not include a "${heading}" section)_`;
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

function pushBranch(branch: string): void {
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
  shStream("git", ["push", "-u", "--force-with-lease", "origin", branch]);
}

function openPr(args: {
  branch: string;
  newVersion: string;
  prevVersion: string;
  body: string;
  draft: boolean;
}): string {
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
  if (existing.length > 0) {
    url = existing[0]!.url;
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
  return url;
}

// ── CI watch ──────────────────────────────────────────────────────────

function watchCi(prUrl: string): { passed: boolean } {
  log(`watching CI on ${prUrl}`);
  const code = shStream("gh", ["pr", "checks", prUrl, "--watch", "--fail-fast"]);
  return { passed: code === 0 };
}

// ── Announce ──────────────────────────────────────────────────────────

async function announce(args: {
  prUrl: string;
  newVersion: string;
  prevVersion: string;
}): Promise<void> {
  const body = [
    `**claude-agent-sdk ${args.prevVersion} → ${args.newVersion}** has shipped to Claudius.`,
    "",
    `PR: ${args.prUrl}`,
    `Upstream changelog: https://github.com/${UPSTREAM_GH}/compare/v${args.prevVersion}...v${args.newVersion}`,
  ].join("\n");

  const res = await fetch(`${CHAT_SERVER_URL.replace(/\/$/, "")}/admin/announce`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Admin-Token": CHAT_SERVER_ADMIN_TOKEN,
    },
    body: JSON.stringify({
      roomSlug: ROOM_SLUG,
      body,
      pin: true,
    }),
  });
  if (!res.ok) {
    throw new Error(
      `chat-server announce failed: HTTP ${res.status} ${await res.text()}`,
    );
  }
  log(`announced to ${ROOM_SLUG}`);
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

  preflight();

  const prevVersion = prevVersionArg ?? cleanRange(readInstalledRange(ROOT));
  if (!newVersionArg) {
    fatal("orchestrate.ts requires --version=<x.y.z>");
  }
  const newVersion = newVersionArg!;

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

  try {
    const branch = checkoutFreshBranch(newVersion);
    bumpSdkDependency(newVersion);

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

    // Make sure the run-notes target directory exists so Claude can write into it.
    mkdirSync(dirname(runNotesPath(newVersion)), { recursive: true });

    const prompt = renderPrompt(prevVersion, newVersion, changelog);
    const claudeResult = await runClaude(prompt);
    log(
      `Claude exited: completed=${claudeResult.completed} turns=${claudeResult.turnCount}` +
        ` wall=${Math.round(claudeResult.wallMs / 1000)}s`,
    );
    budgetReason = claudeResult.budgetReason;

    const gate = runGate();
    const allGreen = gate.every((g) => g.ok);
    log(`gate result: ${gate.map((g) => `${g.step}=${g.ok ? "ok" : "FAIL"}`).join(" ")}`);

    if (!allGreen && !budgetReason) {
      // Claude returned cleanly but the suite is red — treat as
      // budget-exhausted so we open a draft instead of a regular PR.
      budgetReason = `Claude reported done but gate failed: ${gate
        .filter((g) => !g.ok)
        .map((g) => g.step)
        .join(", ")}`;
    }

    pushBranch(branch);

    const budgetWarning = budgetReason
      ? [
          "> ⚠ **Opened as draft — automated run did not reach all-green.**  ",
          `> Reason: ${budgetReason}  `,
          `> Tagged with \`needs-human\` for follow-up.`,
        ].join("\n")
      : "";
    const body = renderPrBody({
      branch,
      prevVersion,
      newVersion,
      changelog,
      budgetWarning,
    });

    prUrl = openPr({
      branch,
      newVersion,
      prevVersion,
      body,
      draft: !!budgetReason,
    });
    log(`PR opened: ${prUrl}`);

    if (!budgetReason) {
      const ci = watchCi(prUrl);
      if (!ci.passed) {
        log(`CI failed on ${prUrl} — skipping announce, leaving for human triage`);
      } else {
        await announce({ prUrl, newVersion, prevVersion });
        shipped = true;
      }
    }
  } catch (err) {
    log(`orchestrator threw: ${err instanceof Error ? err.stack : String(err)}`);
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
