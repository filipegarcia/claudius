/**
 * scripts/cc-parity/orchestrate.ts
 *
 * End-to-end Claude Code parity pipeline. Sibling to scripts/sdk-update/.
 * Where the SDK updater absorbs everything that flows through
 * @anthropic-ai/claude-agent-sdk, this pipeline takes the delta — the
 * features Claude Code ships directly that Claudius reimplements in the
 * browser (settings, slash commands, UI affordances, changed defaults).
 *
 * The pipeline is deliberately thinner than its SDK sibling because most
 * of the deterministic plumbing (preflight, runClaude, runGate,
 * pushBranch, openPr, watchCi, announceSafe) is reused via direct import
 * from ../sdk-update/orchestrate.ts. What lives here is the
 * cc-parity-specific orchestration:
 *   - branch + state under .claudius/cc-parity/
 *   - the A/B/C bucketing prompt template
 *   - the cc-parity-specific run-notes shape
 *   - the cc-parity-specific PR title / issue dedup title
 *   - a different emoji for the channel announce so operators can tell
 *     the two pipelines apart at a glance
 *
 * The Claudius `version` field bump in step 12 (release coupling) lives
 * here too, with one important deviation from the SDK pipeline: the SDK
 * updater sets `version` to the SDK version (also semver 0.3.x); here we
 * INCREMENT the existing version's patch component so Claude Code's
 * 1.x/2.x range doesn't fight the SDK pipeline's 0.3.x bumps. See
 * `bumpClaudiusPatch` for the rationale.
 */

import { spawnSync } from "node:child_process";
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
  readState,
  repoRoot,
} from "./check";
import {
  ALL_GATE_STEPS,
  announceSafe,
  collectChecks,
  collectReviews,
  openPr,
  parseSkipGates,
  preflight,
  pushBranch,
  readPrMeta,
  runClaude,
  runGate,
  sliceChangelog,
  summarizeSdkMessage,
  watchCi,
  type GateResult,
  type GateStep,
  type PrMeta,
} from "../sdk-update/orchestrate";

// ── Config ────────────────────────────────────────────────────────────

const ROOT = repoRoot();
const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));

const UPSTREAM_GH = "anthropics/claude-code";

process.env.GIT_TERMINAL_PROMPT = "0";

// Quiet the bundler/runtime — these helpers are imported for their
// side-effect role in the sdk-update pipeline (announce builders, etc.)
// and are deliberately re-used unchanged. We import for re-export
// availability under one identifier.
void summarizeSdkMessage;

// ── Logging ───────────────────────────────────────────────────────────

function log(line: string): void {
  console.log(`[cc-parity/orchestrate ${new Date().toISOString()}] ${line}`);
}

function fatal(line: string): never {
  console.error(`[cc-parity/orchestrate FATAL] ${line}`);
  process.exit(1);
}

// ── Regex / string helpers ────────────────────────────────────────────

/** See sdk-update orchestrate.ts — kept verbatim for the same reasons. */
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function oneLine(s: string, n: number): string {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n)}…` : t;
}

// ── Shell helpers ─────────────────────────────────────────────────────

import type { SpawnOptions } from "node:child_process";

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

function shStream(cmd: string, args: string[], opts: SpawnOptions = {}): number {
  const result = spawnSync(cmd, args, {
    cwd: ROOT,
    stdio: "inherit",
    ...opts,
  });
  return result.status ?? -1;
}

// ── Branch management ─────────────────────────────────────────────────

function branchName(version: string): string {
  return `cc-parity/${version}`;
}

function checkoutFreshBranch(version: string): string {
  const branch = branchName(version);
  log(`syncing origin/main`);
  sh("git", ["fetch", "origin", "main", "--prune"]);

  sh("git", ["checkout", "--detach", "origin/main"]);

  const local = sh("git", ["branch", "--list", branch]);
  if (local.trim() !== "") {
    log(`deleting stale local branch ${branch}`);
    sh("git", ["branch", "-D", branch]);
  }

  log(`creating ${branch} off origin/main`);
  sh("git", ["checkout", "-b", branch, "origin/main"]);
  return branch;
}

// ── Claudius version bump ─────────────────────────────────────────────

/**
 * Bump the patch component of Claudius's own `version` field in
 * package.json. The SDK-update pipeline overwrites this field with the
 * SDK version (0.3.x) on every green run; if cc-parity wrote the
 * upstream Claude Code version (1.x/2.x) the two pipelines would fight
 * over the field and the displayed version would lurch unpredictably.
 *
 * Incrementing the existing patch keeps the version monotonic and lets
 * both pipelines coexist: SDK updater bumps minor as it tracks SDK
 * minors, cc-parity bumps patch every time it lands a parity PR. The
 * trailing `.N` release counter (computed at build time from git, see
 * scripts/claudius-release.mjs) auto-resets to .0 on the new anchor.
 *
 * Returns the new version string so the caller can log it.
 */
export function bumpClaudiusPatch(): string {
  const pkgPath = resolve(ROOT, "package.json");
  const raw = readFileSync(pkgPath, "utf8");
  const m = raw.match(/("version"\s*:\s*")(\d+)\.(\d+)\.(\d+)(")/);
  if (!m) {
    throw new Error(
      "failed to read top-level version in package.json — pattern miss",
    );
  }
  const major = Number(m[2]);
  const minor = Number(m[3]);
  const patch = Number(m[4]) + 1;
  const next = `${major}.${minor}.${patch}`;
  const updated = raw.replace(
    /("version"\s*:\s*")(\d+)\.(\d+)\.(\d+)(")/,
    `$1${next}$5`,
  );
  writeFileSync(pkgPath, updated, "utf8");
  log(`bumped claudius version → ${next} (release counter auto-resets via git)`);
  return next;
}

// ── Changelog extraction ──────────────────────────────────────────────

function ccCompareUrl(prevVersion: string, newVersion: string): string {
  return `https://github.com/${UPSTREAM_GH}/compare/v${prevVersion}...v${newVersion}`;
}

/**
 * Try, in order:
 *   1. Upstream CHANGELOG.md at v<newVersion> via `gh api`, sliced.
 *   2. Upstream CHANGELOG.md at `main` via raw.githubusercontent.com,
 *      sliced. (No tag dependency — useful if upstream pushes the
 *      changelog before tagging the release.)
 *   3. `gh api compare` commit list as a last resort.
 */
function extractChangelog(prevVersion: string, newVersion: string): string {
  const compareUrl = ccCompareUrl(prevVersion, newVersion);

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
      log(`changelog source: upstream CHANGELOG.md (slice missed — returning full file)`);
      return `_(could not slice upstream CHANGELOG.md between v${prevVersion} and v${newVersion} — returning full file. Section headers may have changed format; see ${compareUrl})_\n\n${raw}`;
    }
  } catch (err) {
    log(`upstream CHANGELOG.md fetch (tag) failed: ${String(err)} — trying main`);
  }

  // Fallback to main: claude-code sometimes lands the CHANGELOG before
  // tagging, so the tag-pinned fetch above misses.
  try {
    const url = `https://raw.githubusercontent.com/${UPSTREAM_GH}/main/CHANGELOG.md`;
    // Use a synchronous shell-out via `curl` to avoid pulling fetch into
    // sync code at the orchestrator's top level. `curl` is on every cron
    // host alongside `gh`.
    const raw = sh("curl", ["-fsSL", url]);
    if (raw.trim() !== "") {
      const sliced = sliceChangelog(raw, prevVersion, newVersion);
      if (sliced) {
        log(`changelog source: upstream CHANGELOG.md @ main`);
        return sliced;
      }
    }
  } catch (err) {
    log(`upstream CHANGELOG.md fetch (main) failed: ${String(err)} — falling back to compare`);
  }

  try {
    const compare = sh("gh", [
      "api",
      `repos/${UPSTREAM_GH}/compare/v${prevVersion}...v${newVersion}`,
      "--jq",
      ".commits[] | \"- \" + (.commit.message | split(\"\\n\")[0]) + \" (\" + .sha[0:7] + \")\"",
    ]);
    if (compare.trim() !== "") {
      log(`changelog source: compare commit list (low signal)`);
      return `_(commit list — could not fetch upstream CHANGELOG.md; this output is dominated by housekeeping commits and is low signal. Open ${compareUrl} for the real diff.)_\n\n${compare}`;
    }
  } catch (err) {
    log(`gh compare API fallback failed: ${String(err)}`);
  }

  return `_(automatic changelog extraction failed — see ${compareUrl})_`;
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

// ── Run-notes & PR body ───────────────────────────────────────────────

function runNotesPath(version: string): string {
  return resolve(ROOT, ".claudius", "cc-parity", "run-notes", `${version}.md`);
}

function promptArchivePath(version: string): string {
  return resolve(ROOT, ".claudius", "cc-parity", "run-notes", `${version}.prompt.md`);
}

function transcriptPath(version: string): string {
  return resolve(
    ROOT,
    ".claudius",
    "cc-parity",
    "run-notes",
    `${version}.transcript.jsonl`,
  );
}

/**
 * Required sections in the cc-parity run-notes file. The orchestrator
 * parses each `## ` block into the PR body and rejects a run whose
 * sections are missing or still placeholder. Different shape from the
 * SDK pipeline (different deliverable: it's classify+ship, not migrate).
 *
 * NOTE: "Implemented (bucket B)" contains regex metacharacters. The
 * extractor and validator below escape the heading before interpolating
 * into a RegExp, which is what makes that heading work at all.
 */
export const REQUIRED_RUN_NOTE_SECTIONS = [
  "Summary",
  "Changelog classification",
  "Implemented (bucket B)",
  "New UI surfaces",
  "Tests",
  "Risks / follow-ups",
] as const;

function runNotesStub(prevVersion: string, newVersion: string): string {
  return [
    `# Claude Code parity ${prevVersion} → ${newVersion}`,
    ``,
    `<!--`,
    `  This file is the PRIMARY DELIVERABLE for the CC-parity bot.`,
    `  The orchestrator parses each \`## \` section into the PR body.`,
    `  Replace EVERY \`_(TODO …)_\` placeholder with real content before`,
    `  finalizing — the gate fails the run if any section is still empty`,
    `  or placeholder.`,
    `-->`,
    ``,
    `## Summary`,
    ``,
    `_(TODO: one paragraph — which Claude Code features this release adds,`,
    `which ones Claudius reimplements in bucket B, the headline risk to`,
    `flag for review.)_`,
    ``,
    `## Changelog classification`,
    ``,
    `_(TODO: every non-bug-fix entry from the upstream changelog, tagged`,
    `[A — via SDK updater], [B — reimplement in Claudius], or`,
    `[C — CLI/terminal only], each with a one-line justification.)_`,
    ``,
    `## Implemented (bucket B)`,
    ``,
    `_(TODO: one bullet per bucket-B item that was actually shipped, with`,
    `the files touched. If no bucket-B items applied this release, write`,
    `\`- No bucket-B items in this release. <reason>\` and expand briefly.)_`,
    ``,
    `## New UI surfaces`,
    ``,
    `_(TODO: one bullet per new/changed UI element with the screenshot`,
    `path under docs/cc-parity/${newVersion}/, the Playwright spec path,`,
    `and the context the shot was taken in. If none, write`,
    `\`- No new UI surfaces this release. <reason>\`.)_`,
    ``,
    `## Tests`,
    ``,
    `_(TODO: vitest count, playwright count, anything explicitly not`,
    `covered with reason.)_`,
    ``,
    `## Risks / follow-ups`,
    ``,
    `_(TODO: what the next human should look at — design alternatives`,
    `you considered and rejected, items whose intent was ambiguous,`,
    `bucket-B items deferred to a follow-up. \`- None identified.\` is`,
    `a valid answer if you're sure.)_`,
    ``,
  ].join("\n");
}

/**
 * cc-parity-specific section extractor. We can't reuse the SDK
 * pipeline's `extractSection` because it interpolates the heading into a
 * RegExp without escaping it — fine for the SDK pipeline's metachar-free
 * section names, but our "Implemented (bucket B)" contains parens which
 * are regex metacharacters and would silently fail to match the literal
 * heading. Use this helper instead.
 *
 * Exported for unit tests.
 */
export function extractCcSection(md: string, heading: string): string {
  const re = new RegExp(
    `(^|\\n)## +${escapeRegExp(heading)}[^\\n]*\\n([\\s\\S]*?)(?=\\n## |$)`,
  );
  const m = md.match(re);
  return m
    ? m[2]!.trim()
    : `_(run-notes did not include a "${heading}" section)_`;
}

/**
 * Pure content validator parameterized on the cc-parity section list.
 * Same trivial-content heuristics as the SDK pipeline's validator —
 * empty, under 20 chars, common placeholder tokens, or a single
 * italicised line all count as "still skeleton".
 *
 * Exported for unit tests.
 */
export function validateCcRunNotesContent(md: string): string | null {
  const missing: string[] = [];
  for (const section of REQUIRED_RUN_NOTE_SECTIONS) {
    const re = new RegExp(
      `(^|\\n)## +${escapeRegExp(section)}[^\\n]*\\n([\\s\\S]*?)(?=\\n## |$)`,
    );
    const m = md.match(re);
    if (!m) {
      missing.push(`"${section}" heading not found`);
      continue;
    }
    const body = m[2]!.trim();
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

function validateRunNotes(version: string): string | null {
  const path = runNotesPath(version);
  if (!existsSync(path)) {
    return (
      `run-notes file is missing at ${relative(ROOT, path)} — ` +
      `Claude was told to write it as the primary deliverable, see prompt.md`
    );
  }
  return validateCcRunNotesContent(readFileSync(path, "utf8"));
}

function listScreenshots(version: string): string[] {
  const dir = resolve(ROOT, "docs", "cc-parity", version);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => /\.(png|jpg|jpeg|gif|webp)$/i.test(f))
    .sort();
}

function repoSlug(): string {
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
    const rel = `docs/cc-parity/${version}/${f}`;
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
    .replace(/\{\{CHANGELOG_URL\}\}/g, ccCompareUrl(args.prevVersion, args.newVersion))
    .replace(/\{\{CHANGELOG_BODY\}\}/g, args.changelog)
    .replace(/\{\{NOTES_SUMMARY\}\}/g, extractCcSection(notes, "Summary"))
    .replace(/\{\{NOTES_CLASSIFICATION\}\}/g, extractCcSection(notes, "Changelog classification"))
    .replace(/\{\{NOTES_IMPLEMENTED\}\}/g, extractCcSection(notes, "Implemented (bucket B)"))
    .replace(/\{\{NOTES_UI\}\}/g, extractCcSection(notes, "New UI surfaces"))
    .replace(/\{\{NOTES_TESTS\}\}/g, extractCcSection(notes, "Tests"))
    .replace(/\{\{NOTES_RISKS\}\}/g, extractCcSection(notes, "Risks / follow-ups"))
    .replace(/\{\{SCREENSHOTS_BLOCK\}\}/g, buildScreenshotsBlock(args.branch, args.newVersion))
    .replace(/\{\{BUDGET_STATUS\}\}/g, args.budgetWarning);
}

// ── Announcement builders ─────────────────────────────────────────────

/** Upstream compare URL — exported for the unit test. */
export function ccCompareUrlExported(prev: string, next: string): string {
  return ccCompareUrl(prev, next);
}

/**
 * The five progress posts use a 🆔 emoji prefix (different from the SDK
 * pipeline's 🆕) so the channel can tell the two updaters apart at a
 * glance. Same room, same admin POST endpoint.
 */

export function buildCcStartAnnouncement(args: {
  prevVersion: string;
  newVersion: string;
  branch: string;
}): string {
  return [
    `🆔 **New claude-code release: ${args.prevVersion} → ${args.newVersion}.**`,
    "",
    `Starting parity review on branch \`${args.branch}\` — fetching changelog, then handing the triage to Claude.`,
    `Upstream compare: ${ccCompareUrl(args.prevVersion, args.newVersion)}`,
  ].join("\n");
}

export function buildCcChangelogAnnouncement(args: {
  prevVersion: string;
  newVersion: string;
  changelog: string;
}): string {
  const MAX_CHANGELOG = 1700;
  const trimmed = args.changelog.trim();
  const body =
    trimmed.length > MAX_CHANGELOG
      ? `${trimmed.slice(0, MAX_CHANGELOG)}\n\n_(changelog truncated — full text at the compare URL below)_`
      : trimmed;
  return [
    `📋 **Upstream claude-code changelog — ${args.prevVersion} → ${args.newVersion}:**`,
    "",
    body,
    "",
    `Compare: ${ccCompareUrl(args.prevVersion, args.newVersion)}`,
  ].join("\n");
}

export function buildCcImplementationAnnouncement(args: {
  prevVersion: string;
  newVersion: string;
  summary: string;
  budgetReason?: string | null;
}): string {
  const trimmed = args.summary.trim();
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
      ? `${budgetLine}\n\n🛠️ Parity review for **${args.prevVersion} → ${args.newVersion}** ended with no Summary section in run-notes.`
      : `🛠️ Claude finished its parity review for **${args.prevVersion} → ${args.newVersion}** — no Summary section in run-notes (gate may flag it).`;
    return `${head} Tests running next.`;
  }
  const MAX = 1500;
  const body = trimmed.length > MAX ? `${trimmed.slice(0, MAX)}…` : trimmed;
  const lines: string[] = [];
  if (budgetLine) lines.push(budgetLine, "");
  lines.push(
    `🛠️ **${budgetLine ? "Partial parity review" : "Claude finished its parity review"} — ${args.prevVersion} → ${args.newVersion}.**`,
    "",
    `Summary:`,
    body,
  );
  return lines.join("\n");
}

export function buildCcTestingAnnouncement(args: {
  prevVersion: string;
  newVersion: string;
}): string {
  return `🧪 Running local gates for cc-parity **${args.prevVersion} → ${args.newVersion}** (lint, unit, build, e2e). Will open a PR once they pass.`;
}

export function buildCcGateResultAnnouncement(args: {
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

  if (failed.length === 0 && !args.runNotesIssue) {
    const passedList = passed.length ? passed.join(", ") : "(everything skipped)";
    return `✅ Local gates green for cc-parity **${args.prevVersion} → ${args.newVersion}** — ${passedList}${skipNote}. Opening draft PR and watching CI next.`;
  }

  const lines: string[] = [
    `❌ **Local gates failed for cc-parity ${args.prevVersion} → ${args.newVersion}.**`,
    "",
  ];
  if (failed.length) lines.push(`Failed: ${failed.join(", ")}`);
  if (passed.length) lines.push(`Passed: ${passed.join(", ")}`);
  if (skipped.length) lines.push(`Skipped: ${skipped.join(", ")}`);
  if (args.runNotesIssue) {
    lines.push("", `Run-notes problem: ${oneLine(args.runNotesIssue, 400)}`);
  }
  if (
    args.budgetReason &&
    !args.budgetReason.startsWith("Claude reported done but gate failed")
  ) {
    lines.push("", `Cause: ${oneLine(args.budgetReason, 400)}`);
  }
  lines.push("", "Not pushing the branch — a process issue will follow with the next steps.");
  return lines.join("\n");
}

export function buildCcOpenedAnnouncement(args: {
  prUrl: string;
  prevVersion: string;
  newVersion: string;
  created: boolean;
  draft: boolean;
  reason: string | null;
}): string {
  const verb = args.created ? "opened" : "updated";
  const head = args.draft
    ? `**claude-code parity ${args.prevVersion} → ${args.newVersion}** — draft PR ${verb}, needs a human.`
    : `**claude-code parity ${args.prevVersion} → ${args.newVersion}** — PR ${verb}, watching CI.`;
  const lines = [head, ""];
  if (args.draft && args.reason) {
    lines.push(`Reason: ${oneLine(args.reason, 600)}`, "");
  }
  lines.push(
    `PR: ${args.prUrl}`,
    `Upstream changelog: ${ccCompareUrl(args.prevVersion, args.newVersion)}`,
  );
  return lines.join("\n");
}

export function buildCcShippedAnnouncement(args: {
  prUrl: string;
  prevVersion: string;
  newVersion: string;
}): string {
  return [
    `**claude-code parity ${args.prevVersion} → ${args.newVersion}** has shipped to Claudius.`,
    "",
    `PR: ${args.prUrl}`,
    `Upstream changelog: ${ccCompareUrl(args.prevVersion, args.newVersion)}`,
  ].join("\n");
}

export function buildCcFixStartAnnouncement(args: {
  prNumber: string;
  title: string;
  url: string;
  instruction: string;
}): string {
  const lines = [`🔧 Working on CC-parity PR #${args.prNumber} — ${oneLine(args.title, 200)}.`, ""];
  if (args.instruction.trim()) {
    lines.push(`Instruction: ${oneLine(args.instruction, 400)}`, "");
  }
  lines.push(`PR: ${args.url}`);
  return lines.join("\n");
}

export function buildCcFixResultAnnouncement(args: {
  prNumber: string;
  title: string;
  url: string;
  allGreen: boolean;
  failedSteps: string[];
  markedReady: boolean;
}): string {
  const head = args.allGreen
    ? `✅ CC-parity PR #${args.prNumber} updated — all gates pass${args.markedReady ? " (marked ready for review)" : ""}.`
    : `⚠ CC-parity PR #${args.prNumber} updated but still red: ${args.failedSteps.join(", ")}. Needs another look.`;
  return [head, "", `PR: ${args.url}`].join("\n");
}

// ── Per-version run issue (cc-parity-specific dedup title) ────────────

/**
 * Builder for the per-version "CC parity X → Y error" issue — the same
 * dedup pattern as the SDK pipeline, but with a title prefix that
 * separates cc-parity tickets from sdk-update tickets in the issue list.
 * Exported for unit tests.
 */
export function buildCcRunIssue(args: {
  prevVersion: string;
  newVersion: string;
  kind: string;
  reason: string;
  branch: string | null;
  prUrl: string | null;
  extras?: string[];
}): { title: string; body: string; commentBody: string } {
  const title = `CC parity ${args.prevVersion} → ${args.newVersion} error`;
  const meta = [
    `**Branch:** \`${args.branch ?? "(none)"}\``,
    `**PR:** ${args.prUrl ?? "(none)"}`,
  ];
  const extras = args.extras && args.extras.length ? ["", ...args.extras] : [];
  const body = [
    `Automated cc-parity review for \`${args.prevVersion} → ${args.newVersion}\` hit a problem the orchestrator could not resolve on its own.`,
    "",
    `**Kind:** ${args.kind}`,
    `**What happened:** ${args.reason}`,
    "",
    ...meta,
    ...extras,
    "",
    "Filed automatically by `scripts/cc-parity/orchestrate.ts`. Subsequent failures on this same upgrade comment here rather than opening duplicates — see the comments below for the full failure history. The orchestrator run logs live in `.claudius/cc-parity/logs/` on the cron host.",
  ].join("\n");
  const commentBody = [
    `Another failure on this same cc-parity review.`,
    "",
    `**Kind:** ${args.kind}`,
    `**What happened:** ${args.reason}`,
    "",
    ...meta,
    ...extras,
    "",
    "Posted automatically by `scripts/cc-parity/orchestrate.ts` to avoid opening a duplicate issue.",
  ].join("\n");
  return { title, body, commentBody };
}

const inProcessIssueByTitle = new Map<string, string>();

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

function fileOrCommentRunIssueSafe(args: {
  prevVersion: string;
  newVersion: string;
  kind: string;
  reason: string;
  branch: string | null;
  prUrl: string | null;
  extras?: string[];
}): string | null {
  const { title, body, commentBody } = buildCcRunIssue(args);
  try {
    const existing = findOpenIssueByTitle(title);
    if (existing) {
      const comment = spawnSync(
        "gh",
        ["issue", "comment", existing, "--body-file", "-"],
        { cwd: ROOT, input: commentBody, encoding: "utf8" },
      );
      if (comment.status !== 0) {
        throw new Error(`gh issue comment exited ${comment.status}: ${comment.stderr ?? ""}`);
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
    `🛠️ **CC parity ${args.prevVersion} → ${args.newVersion} hit a problem.**`,
    `Kind: ${args.kind}`,
    oneLine(args.reason, 400),
    issueUrl ? `Issue: ${issueUrl}` : "(issue could not be filed — check run logs)",
    args.prUrl ? `PR: ${args.prUrl}` : "",
  ]
    .filter(Boolean)
    .join("\n");
  await announceSafe(channelMsg, { pin: false });
}

// ── Fix an existing PR ─────────────────────────────────────────────────

function fixTranscriptPath(prNumber: string): string {
  return resolve(
    ROOT,
    ".claudius",
    "cc-parity",
    "run-notes",
    `fix-pr-${prNumber}.transcript.jsonl`,
  );
}

function fixPromptArchivePath(prNumber: string): string {
  return resolve(
    ROOT,
    ".claudius",
    "cc-parity",
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
  const allGreen = gate.every((g: GateResult) => g.ok);
  const failedSteps = gate.filter((g: GateResult) => !g.ok).map((g: GateResult) => g.step);
  log(
    `gate result: ${gate
      .map((g: GateResult) => `${g.step}=${g.skipped ? "skip" : g.ok ? "ok" : "FAIL"}`)
      .join(" ")}`,
  );
  return { allGreen, failedSteps };
}

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

  await announceSafe(
    buildCcFixStartAnnouncement({
      prNumber,
      title: meta.title,
      url: meta.url,
      instruction,
    }),
    { pin: false },
  );

  sh("git", ["fetch", "origin", branch, "--prune"]);
  const coCode = shStream("gh", ["pr", "checkout", prNumber, "--force"]);
  if (coCode !== 0) {
    throw new Error(`gh pr checkout ${prNumber} failed (exit ${coCode})`);
  }

  const { allGreen, failedSteps } = await runFixPass(prNumber, meta, instruction, skipGates);

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
    buildCcFixResultAnnouncement({
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
  const newVersionArg = args.find((a) => a.startsWith("--version="))?.slice("--version=".length);
  const prevVersionArg = args
    .find((a) => a.startsWith("--previous="))
    ?.slice("--previous=".length);
  const dryRun = args.includes("--dry-run");
  const skipGatesArg = args
    .find((a) => a.startsWith("--skip-gates="))
    ?.slice("--skip-gates=".length);
  const skipGates = parseSkipGates(skipGatesArg);

  const fixPrArg = args.find((a) => a.startsWith("--fix-pr="))?.slice("--fix-pr=".length);
  if (fixPrArg) {
    const instruction =
      args.find((a) => a.startsWith("--instruction="))?.slice("--instruction=".length) ??
      process.env.CC_PARITY_FIX_INSTRUCTION ??
      "";
    await fixPr(fixPrArg, instruction, skipGates);
    return;
  }

  preflight();

  if (!newVersionArg) {
    fatal("orchestrate.ts requires --version=<x.y.z>");
  }
  const newVersion = newVersionArg!;
  const prevVersion =
    prevVersionArg ??
    cleanRange(readState(ROOT).lastCompletedVersion ?? readState(ROOT).lastSeenVersion ?? "");
  if (!prevVersion) {
    fatal("no previous version recorded in state — pass --previous=<x.y.z> explicitly");
  }

  log(`starting cc-parity review ${prevVersion} → ${newVersion}`);
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

  const announceProgress = async (
    body: string,
    opts: { pin?: boolean } = {},
  ): Promise<void> => {
    if (dryRun) return;
    await announceSafe(body, opts);
  };

  try {
    const branch = checkoutFreshBranch(newVersion);

    await announceProgress(
      buildCcStartAnnouncement({ prevVersion, newVersion, branch }),
    );

    // Note: cc-parity does NOT bump any package.json dependency.
    // Claudius doesn't depend on @anthropic-ai/claude-code. The
    // upstream changelog is sourced over the network for analysis.

    const changelog = extractChangelog(prevVersion, newVersion);
    log(`changelog: ${changelog.length} bytes`);

    await announceProgress(
      buildCcChangelogAnnouncement({ prevVersion, newVersion, changelog }),
    );

    mkdirSync(dirname(runNotesPath(newVersion)), { recursive: true });

    if (!existsSync(runNotesPath(newVersion))) {
      writeFileSync(
        runNotesPath(newVersion),
        runNotesStub(prevVersion, newVersion),
        "utf8",
      );
      log(`run-notes stub created at ${relative(ROOT, runNotesPath(newVersion))}`);
    }

    const prompt = renderPrompt(prevVersion, newVersion, changelog);
    writeFileSync(promptArchivePath(newVersion), prompt, "utf8");
    log(
      `prompt archived to ${relative(ROOT, promptArchivePath(newVersion))} (${prompt.length} bytes)`,
    );

    const claudeResult = await runClaude(prompt, transcriptPath(newVersion));
    log(
      `Claude exited: completed=${claudeResult.completed} turns=${claudeResult.turnCount}` +
        ` wall=${Math.round(claudeResult.wallMs / 1000)}s`,
    );
    budgetReason = claudeResult.budgetReason;

    let runNotesSummary = "";
    const notesFile = runNotesPath(newVersion);
    if (existsSync(notesFile)) {
      runNotesSummary = extractCcSection(readFileSync(notesFile, "utf8"), "Summary");
    }
    await announceProgress(
      buildCcImplementationAnnouncement({
        prevVersion,
        newVersion,
        summary: runNotesSummary,
        budgetReason,
      }),
    );

    await announceProgress(
      buildCcTestingAnnouncement({ prevVersion, newVersion }),
    );

    const gate = runGate(skipGates);
    const allGreen = gate.every((g: GateResult) => g.ok);
    log(
      `gate result: ${gate
        .map((g: GateResult) => `${g.step}=${g.skipped ? "skip" : g.ok ? "ok" : "FAIL"}`)
        .join(" ")}`,
    );

    if (!allGreen && !budgetReason) {
      budgetReason = `Claude reported done but gate failed: ${gate
        .filter((g: GateResult) => !g.ok)
        .map((g: GateResult) => g.step)
        .join(", ")}`;
    }

    const runNotesIssue = validateRunNotes(newVersion);
    if (runNotesIssue && !budgetReason) {
      budgetReason = runNotesIssue;
      log(`gate: run-notes validation FAILED — ${runNotesIssue}`);
    } else if (runNotesIssue) {
      budgetReason = `${budgetReason}; also: ${runNotesIssue}`;
      log(`gate: run-notes validation FAILED — ${runNotesIssue}`);
    } else {
      log(`gate: run-notes validation ok`);
    }

    await announceProgress(
      buildCcGateResultAnnouncement({
        prevVersion,
        newVersion,
        results: gate,
        runNotesIssue,
        budgetReason,
      }),
    );

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
      }
      if (existsSync(archived)) {
        log(`  prompt:     ${relative(ROOT, archived)} (${readFileSync(archived, "utf8").length} bytes)`);
      }
      if (existsSync(tx)) {
        log(`  transcript: ${relative(ROOT, tx)} (${readFileSync(tx, "utf8").length} bytes, JSONL)`);
      }
      log(`Clean up:         git checkout main && git branch -D ${branch}`);
      log("──────────────────────────────────────────────────────────");
      return;
    }

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

    // Local-green: bump Claudius's own patch version (cc-parity ships
    // every successful run; the SDK pipeline owns the minor channel)
    // and commit the bump.
    const bumped = bumpClaudiusPatch();
    sh("git", ["add", "package.json"]);
    sh("git", [
      "commit",
      "-m",
      `chore(release): bump claudius version → ${bumped} for cc-parity ${newVersion}`,
    ]);

    pushBranch(branch);

    const body = renderPrBody({
      branch,
      prevVersion,
      newVersion,
      changelog,
      budgetWarning: "",
    });
    // openPr takes prevVersion/newVersion to build the SDK-pipeline
    // title; we'd rather have a cc-parity-specific title, so call gh
    // directly through openPr's underlying mechanism. The simplest fix
    // is to pre-edit the title via a separate gh call right after open.
    const pr = openPr({ branch, newVersion, prevVersion, body, draft: true });
    prUrl = pr.url;
    const prNumber = prUrl.split("/").pop() ?? prUrl;
    log(`draft PR ${pr.created ? "opened" : "updated"}: ${prUrl} (watching CI before marking ready)`);

    // Rewrite the title — openPr uses the SDK-pipeline wording. We want
    // "feat(cc-parity): claude-code <prev> → <new>" so reviewers can tell
    // the two pipelines apart in the PR list.
    try {
      sh("gh", [
        "pr",
        "edit",
        prUrl,
        "--title",
        `feat(cc-parity): claude-code ${prevVersion} → ${newVersion}`,
      ]);
    } catch (err) {
      log(`WARN could not retitle PR (continuing): ${String(err)}`);
    }

    await announceSafe(
      buildCcOpenedAnnouncement({
        prUrl,
        prevVersion,
        newVersion,
        created: pr.created,
        draft: true,
        reason: "watching CI before marking ready for review",
      }),
      { pin: false },
    );

    const ciPassed = watchCi(prUrl).passed;

    if (ciPassed) {
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
        buildCcShippedAnnouncement({ prUrl, newVersion, prevVersion }),
        { pin: true },
      );
    } else {
      const reason = `CI red on ${prUrl} — leaving draft + needs-human for a reviewer`;
      log(reason);
      try {
        sh("gh", ["pr", "edit", prNumber, "--add-label", "needs-human"]);
      } catch {
        // Best-effort label.
      }
      await reportProcessIssueSafe({
        kind: "CI red on opened PR",
        reason,
        prevVersion,
        newVersion,
        branch,
        prUrl,
      });
    }
  } catch (err) {
    log(`orchestrator threw: ${err instanceof Error ? err.stack : String(err)}`);
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

// Suppress "unused but kept for parity with sdk-update orchestrator"
// — these are re-exported via the index for downstream callers but
// otherwise not referenced in main().
void ALL_GATE_STEPS;
