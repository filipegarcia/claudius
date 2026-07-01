#!/usr/bin/env node
// Run GitHub's CodeQL analysis locally — the SAME engine and query suite the
// `.github/workflows/codeql.yml` job runs on push/PR. This is the only true
// "GitHub security checks locally" option: ESLint plugins are a different
// engine (no taint tracking) and can't reproduce the data-flow rules
// (js/regex-injection, js/xss-through-dom, js/path-injection, …) that produce
// the Security-tab alerts.
//
// Run it: `bun run security`  (alias for `node scripts/codeql-local.mjs`)
//
// Cost: a few minutes (build the source DB + analyze), plus a one-time ~500 MB
// CLI + query-pack download on first run. Crucially, JS/TS analysis is
// SOURCE-BASED — it does NOT run `next build` or compile anything, so it
// sidesteps the whole Turbopack/standalone/native-ABI build pipeline. Nothing
// here can break or be broken by the desktop build.
//
// Exit code is non-zero when CodeQL reports any result, so this doubles as a
// gate you can wire into a hook or CI step. Use `--quiet` to suppress the
// per-finding listing (still prints the summary + exit code).

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
// All CodeQL scratch state lives under one gitignored dir so a scan never
// pollutes the working tree.
const WORK_DIR = join(REPO_ROOT, ".codeql");
const DB_DIR = join(WORK_DIR, "db");
const SARIF = join(WORK_DIR, "results.sarif");
// Mirror codeql.yml: single language pack, default (code-scanning) suite.
const LANGUAGE = "javascript-typescript";
const QUERY_PACK = "codeql/javascript-queries";

const quiet = process.argv.includes("--quiet");
// `--all` shows every finding including ones dismissed/fixed on GitHub. By
// default we match the Security-tab "open" view (see fetchSuppressed).
const showAll = process.argv.includes("--all");

/** Locate the codeql launcher on PATH or in the usual Homebrew locations. */
function findCodeql() {
  for (const candidate of ["codeql", "/opt/homebrew/bin/codeql", "/usr/local/bin/codeql"]) {
    const probe = spawnSync(candidate, ["version", "--format=terse"], { encoding: "utf8" });
    if (!probe.error && probe.status === 0) return candidate;
  }
  return null;
}

// Match the Security tab's "open" view: a finding the team already triaged
// (dismissed as won't-fix/false-positive) shouldn't re-nag locally — CodeQL
// still detects it because dismissal is a GitHub-side annotation, not a code
// change. We key by `rule\tfile\tline` — precise enough to NOT over-suppress a
// genuinely new finding that shares a file with an old dismissal (e.g. one
// insecure-randomness in a file dismissed, a different one still open). The
// trade-off: if a dismissed finding's line drifts vs the scanned commit it
// reappears here — the safe direction (show, don't hide). Returns a Set, or
// null if gh is unavailable/unauthed (then we show everything, with a note).
function fetchSuppressed() {
  const repoRes = spawnSync("gh", ["repo", "view", "--json", "nameWithOwner", "--jq", ".nameWithOwner"], {
    encoding: "utf8",
  });
  if (repoRes.error || repoRes.status !== 0) return null;
  const repo = repoRes.stdout.trim();
  const res = spawnSync(
    "gh",
    [
      "api",
      `repos/${repo}/code-scanning/alerts`,
      "--paginate",
      "--jq",
      // dismissed = intentionally won't-fix/false-positive; fixed = resolved on
      // the scanned branch (a local re-find means a regression worth showing,
      // so we DON'T suppress fixed — only dismissed).
      '.[] | select(.state=="dismissed") | "\(.rule.id)\t\(.most_recent_instance.location.path)\t\(.most_recent_instance.location.start_line)"',
    ],
    { encoding: "utf8" },
  );
  if (res.error || res.status !== 0) return null;
  return new Set(res.stdout.split("\n").filter(Boolean));
}

function run(bin, args) {
  console.log(`\n$ ${bin} ${args.join(" ")}`);
  const res = spawnSync(bin, args, { cwd: REPO_ROOT, stdio: "inherit" });
  if (res.error) throw res.error;
  if (res.status !== 0) {
    throw new Error(`\`${bin} ${args[0]}\` exited with code ${res.status}`);
  }
}

const codeql = findCodeql();
if (!codeql) {
  console.error(
    "✖ codeql CLI not found.\n" +
      "  Install it once with:  brew install codeql\n" +
      "  (or download from https://github.com/github/codeql-action/releases — the\n" +
      "   bundle ships the CLI + query packs). Then re-run `bun run security`.",
  );
  process.exit(127);
}

console.log(`▶ codeql: ${codeql}`);
mkdirSync(WORK_DIR, { recursive: true });
// A stale DB from an aborted run makes `database create` refuse; clear it.
rmSync(DB_DIR, { recursive: true, force: true });

// 1. Build the database. The JS extractor walks the source tree (it skips
//    node_modules / .git / minified assets by default), but NOT build outputs —
//    and `release/` in particular holds a copied .app whose standalone tree is a
//    full, recursively-nested copy of the source (see `bun run build:app`).
//    Without excluding it the scan double-counts every finding many times over.
//    paths-ignore mirrors the generated/output dirs we never want analyzed.
const CONFIG = join(WORK_DIR, "codeql-config.yml");
writeFileSync(
  CONFIG,
  [
    "paths-ignore:",
    "  - release",
    "  - .next",
    "  - .next-e2e",
    "  - .next-buildtest",
    "  - dist-electron",
    "  - .codeql",
    "  - .claude/worktrees",
    "  - site/vendor",
    "  - playwright-report",
    "  - blob-report",
    "  - test-results",
    "  - playwright/.cache",
    "",
  ].join("\n"),
);
run(codeql, [
  "database",
  "create",
  DB_DIR,
  `--language=${LANGUAGE}`,
  `--source-root=${REPO_ROOT}`,
  `--codescanning-config=${CONFIG}`,
  "--overwrite",
  "--threads=0",
]);

// 2. Analyze with the same pack the Action runs by default. `--download`
//    fetches/updates the query pack on first use.
run(codeql, [
  "database",
  "analyze",
  DB_DIR,
  QUERY_PACK,
  "--format=sarif-latest",
  `--output=${SARIF}`,
  "--download",
  "--threads=0",
]);

// 3. Summarize. SARIF severity lives in rule metadata; map ruleId → level.
if (!existsSync(SARIF)) {
  console.error("✖ analysis finished but no SARIF was written — unexpected.");
  process.exit(1);
}
const sarif = JSON.parse(readFileSync(SARIF, "utf8"));
const runs = sarif.runs ?? [];
const findings = [];
for (const r of runs) {
  const ruleLevels = new Map();
  for (const rule of r.tool?.driver?.rules ?? []) {
    const sev = rule.properties?.["security-severity"];
    const level = rule.defaultConfiguration?.level ?? "warning";
    ruleLevels.set(rule.id, sev ? `${level} (sev ${sev})` : level);
  }
  for (const res of r.results ?? []) {
    const loc = res.locations?.[0]?.physicalLocation;
    // SARIF URI-encodes paths (app/%5BworkspaceId%5D/…); `gh` returns them
    // decoded (app/[workspaceId]/…). Decode so paths match GitHub for the
    // dismissal filter and read cleanly in the listing.
    const rawUri = loc?.artifactLocation?.uri ?? "?";
    let file = rawUri;
    try {
      file = decodeURIComponent(rawUri);
    } catch {
      /* leave as-is if not valid percent-encoding */
    }
    findings.push({
      rule: res.ruleId,
      level: ruleLevels.get(res.ruleId) ?? res.level ?? "warning",
      file,
      line: loc?.region?.startLine ?? "?",
      message: res.message?.text ?? "",
    });
  }
}

// Partition into shown vs suppressed (dismissed on GitHub), unless --all.
const suppressedKeys = showAll ? null : fetchSuppressed();
const shown = [];
let suppressedCount = 0;
for (const f of findings) {
  if (suppressedKeys && suppressedKeys.has(`${f.rule}\t${f.file}\t${f.line}`)) {
    suppressedCount += 1;
  } else {
    shown.push(f);
  }
}

console.log(`\n${"─".repeat(60)}`);
if (!showAll && suppressedKeys === null) {
  console.log("ℹ gh unavailable — showing ALL findings (couldn't read GitHub dismissals).");
} else if (suppressedCount > 0) {
  console.log(`ℹ ${suppressedCount} finding(s) suppressed (dismissed on GitHub). Use --all to see them.`);
}
if (shown.length === 0) {
  console.log("✓ CodeQL: no open findings. (parity with the Security tab on next push)");
  process.exit(0);
}
if (!quiet) {
  for (const f of shown) {
    console.log(`\n• ${f.rule}  [${f.level}]\n  ${f.file}:${f.line}\n  ${f.message}`);
  }
}
console.log(`\n✖ CodeQL: ${shown.length} open finding(s). SARIF: ${SARIF}`);
process.exit(1);
