/**
 * scripts/heartbeat/heartbeat.ts — daily liveness + activity heartbeat.
 *
 * Posts ONE message to the community chat-server every day saying the
 * update pipelines are alive, and either:
 *   - "all quiet" — no SDK or Claude Code update PRs in the window, or
 *   - "N update(s)" — with each PR listed and its outcome (merged,
 *     needs-attention, draft/in-progress, awaiting-review, closed), plus
 *     any "… error" issues the pipelines filed (a run that failed before
 *     or without opening a PR). "merged with error or not" — both show.
 *
 * Source of truth is GitHub (the PR/issue records), NOT the state files:
 * only GitHub has the PR URLs and captures runs that errored.
 *
 * Window: anchored to the LAST heartbeat run (persisted in
 * .claudius/heartbeat/state.json), not a fixed `now-24h`. A daily cron
 * drifts and can be skipped (asleep/off); anchoring to the last run means
 * we never gap and we auto-catch-up after a missed day. First run (no
 * state) falls back to a 24h look-back.
 *
 * gh failure is reported as "couldn't check GitHub", which is a DIFFERENT
 * fact from "nothing happened" — we must never post a false "all quiet".
 *
 * Auth: reads CHAT_SERVER_* and GH_TOKEN from the env file (loaded by
 * run.sh). It does NOT read ~/.claude/.credentials.json, so the macOS
 * Full Disk Access requirement the pipelines have does not apply here.
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

const CHAT_SERVER_URL = process.env.CHAT_SERVER_URL ?? "";
const CHAT_SERVER_ADMIN_TOKEN = process.env.CHAT_SERVER_ADMIN_TOKEN ?? "";
const ROOM_SLUG =
  process.env.HEARTBEAT_ROOM_SLUG ??
  process.env.SDK_UPDATE_ROOM_SLUG ??
  "sdk-update";
const DRY_RUN = process.env.HEARTBEAT_DRY_RUN === "1";
const WINDOW_HOURS = Number(process.env.HEARTBEAT_WINDOW_HOURS ?? "24");
const MAX_BODY = 1900; // chat-server caps messages ~2000 chars.

/** Branch prefixes the two pipelines push to (combined rides sdk-update/). */
const PIPELINE_BRANCH_PREFIXES = ["sdk-update/", "cc-parity/"];

function log(msg: string): void {
  process.stdout.write(
    `[heartbeat ${new Date().toISOString()}] ${msg}\n`,
  );
}

// ── Types ─────────────────────────────────────────────────────────────

export type PrJson = {
  number: number;
  title: string;
  url: string;
  headRefName: string;
  state: string; // OPEN | CLOSED | MERGED
  isDraft: boolean;
  createdAt: string | null;
  mergedAt: string | null;
  closedAt: string | null;
  labels: Array<{ name: string }>;
};

export type IssueJson = {
  number: number;
  title: string;
  url: string;
  createdAt: string | null;
};

type HeartbeatState = { lastHeartbeatAt: number | null };

// ── Pure selectors / classifiers (unit-tested) ────────────────────────

export function isPipelineBranch(headRefName: string): boolean {
  return PIPELINE_BRANCH_PREFIXES.some((p) => headRefName.startsWith(p));
}

function parseTs(s: string | null | undefined): number {
  return s ? Date.parse(s) : NaN;
}

/**
 * PRs from a pipeline branch that were created OR merged at/after the
 * cutoff. "created" catches a new (possibly still-open or errored) run;
 * "merged" catches a run that opened earlier but landed in the window.
 */
export function selectActivity(prs: PrJson[], cutoffMs: number): PrJson[] {
  return prs.filter((pr) => {
    if (!isPipelineBranch(pr.headRefName)) return false;
    const created = parseTs(pr.createdAt);
    const merged = parseTs(pr.mergedAt);
    return (
      (!Number.isNaN(created) && created >= cutoffMs) ||
      (!Number.isNaN(merged) && merged >= cutoffMs)
    );
  });
}

export type PrOutcome = { icon: string; label: string };

/** Map a PR to a human outcome. Precedence: merged → closed → open states. */
export function classifyPr(pr: PrJson): PrOutcome {
  if (pr.mergedAt) return { icon: "✅", label: "merged" };
  if (pr.state === "CLOSED") return { icon: "❌", label: "closed without merging" };
  const needsHuman = pr.labels?.some((l) => l.name === "needs-human");
  if (needsHuman) return { icon: "⚠️", label: "needs attention" };
  if (pr.isDraft) return { icon: "🔧", label: "in progress" };
  return { icon: "👀", label: "awaiting review" };
}

/**
 * Pipeline-filed failure issues ("SDK update X → Y error" / "CC parity …").
 *
 * Keyed on `createdAt` within the window — "an error happened in the
 * window" — NOT on open-state. The pipelines dedup failures onto one
 * issue per upgrade and do NOT auto-close it on a later success, so
 * keying on "open" would make the heartbeat nag daily about failures
 * that were already resolved. The trade-off: a failure that keeps
 * recurring on an issue first opened before the window won't re-surface
 * (the orchestrator comments rather than re-creating). That's the
 * intended "what happened in the window" reading.
 */
export function selectErrorIssues(
  issues: IssueJson[],
  cutoffMs: number,
): IssueJson[] {
  const titleRe = /^(SDK update|CC parity)\b.*\berror\b/i;
  return issues.filter((i) => {
    if (!titleRe.test(i.title)) return false;
    const created = parseTs(i.createdAt);
    return !Number.isNaN(created) && created >= cutoffMs;
  });
}

function fmtTime(ms: number): string {
  return new Date(ms).toISOString().replace("T", " ").slice(0, 16) + " UTC";
}

function clip(body: string, max: number): string {
  if (body.length <= max) return body;
  const cut = body.slice(0, max);
  const lastNl = cut.lastIndexOf("\n");
  return (
    (lastNl > 0 ? cut.slice(0, lastNl) : cut) +
    "\n… (truncated — see GitHub for the full list)"
  );
}

export type HeartbeatContext = {
  sdkVersion: string | null;
  ccVersion: string | null;
  lastCheckedMs: number | null;
};

/** Build the chat-server message body. Pure — no I/O. */
export function buildHeartbeatMessage(args: {
  nowMs: number;
  cutoffMs: number;
  firstRun: boolean;
  /** The PR query succeeded — PR results are trustworthy. */
  prsOk: boolean;
  /** The error-issue query succeeded — the issue list is complete. */
  issuesOk: boolean;
  prs: PrJson[]; // already filtered to the window via selectActivity
  errorIssues: IssueJson[];
  context: HeartbeatContext;
}): string {
  const { nowMs, cutoffMs, firstRun, prsOk, issuesOk, prs, errorIssues, context } = args;
  const hours = Math.max(1, Math.round((nowMs - cutoffMs) / 3_600_000));
  const windowLabel = firstRun ? "the last 24h" : `the last ${hours}h`;

  const ctxParts: string[] = [];
  if (context.sdkVersion) ctxParts.push(`SDK on ${context.sdkVersion}`);
  if (context.ccVersion) ctxParts.push(`Claude Code parity at ${context.ccVersion}`);
  if (context.lastCheckedMs) ctxParts.push(`last npm check ${fmtTime(context.lastCheckedMs)}`);
  const ctxLine = ctxParts.join(" · ");

  const lines: string[] = ["💓 Update pipelines heartbeat — alive."];

  if (!prsOk) {
    // We did NOT observe the window — must not imply "all quiet".
    lines.push(
      "⚠️ Couldn't check GitHub for update activity this run (gh query failed — see the cron log).",
    );
  } else {
    // "All quiet" requires BOTH queries to have succeeded and returned
    // nothing — otherwise we can't claim the window was empty.
    const quiet = issuesOk && prs.length === 0 && errorIssues.length === 0;
    if (quiet) {
      lines.push("");
      lines.push(`All quiet — no SDK or Claude Code update PRs in ${windowLabel}.`);
    } else {
      if (prs.length > 0) {
        lines.push("");
        lines.push(`${prs.length} update${prs.length === 1 ? "" : "s"} in ${windowLabel}:`);
        for (const pr of prs) {
          const { icon, label } = classifyPr(pr);
          lines.push(`${icon} ${label} — ${pr.title}`);
          lines.push(`   ${pr.url}`);
        }
      }
      if (errorIssues.length > 0) {
        lines.push("");
        lines.push(
          `⚠️ ${errorIssues.length} error report${errorIssues.length === 1 ? "" : "s"} opened in ${windowLabel}:`,
        );
        for (const issue of errorIssues) {
          lines.push(`• ${issue.title}`);
          lines.push(`   ${issue.url}`);
        }
      }
      if (!issuesOk) {
        lines.push("");
        lines.push(
          "⚠️ Couldn't check error reports this run (gh query failed) — the list above may be incomplete.",
        );
      }
    }
  }

  if (ctxLine) {
    lines.push("");
    lines.push(ctxLine);
  }

  return clip(lines.join("\n"), MAX_BODY);
}

// ── Impure shell ──────────────────────────────────────────────────────

/** Runs a `gh` subcommand and returns parsed JSON. Injectable for tests. */
export type GhRunner = <T>(args: string[]) => T;

const realGh: GhRunner = <T>(args: string[]): T => {
  const out = execFileSync("gh", args, {
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
  return JSON.parse(out) as T;
};

export type Activity = {
  prs: PrJson[];
  errorIssues: IssueJson[];
  /** PR query succeeded. */
  prsOk: boolean;
  /** Error-issue query succeeded. */
  issuesOk: boolean;
};

/**
 * Gather windowed PR + error-issue activity via `gh`. The two queries
 * fail INDEPENDENTLY: a thrown PR query sets `prsOk=false`, a thrown
 * issue query sets `issuesOk=false`. The caller must advance the
 * heartbeat window only when BOTH succeeded — otherwise the unobserved
 * half would be silently skipped forever (a missed merge or a missed
 * error report). Exported so tests can pin this without real `gh`.
 */
export function gatherActivity(gh: GhRunner, cutoffMs: number): Activity {
  let prs: PrJson[] = [];
  let errorIssues: IssueJson[] = [];
  let prsOk = true;
  let issuesOk = true;

  try {
    const allPrs = gh<PrJson[]>([
      "pr",
      "list",
      "--state",
      "all",
      "--limit",
      "100",
      "--json",
      "number,title,url,headRefName,state,isDraft,createdAt,mergedAt,closedAt,labels",
    ]);
    prs = selectActivity(allPrs, cutoffMs);
  } catch (err) {
    prsOk = false;
    log(`WARN gh PR query failed — reporting as "couldn't check": ${String(err)}`);
  }

  try {
    const issues = gh<IssueJson[]>([
      "issue",
      "list",
      "--state",
      "all",
      "--limit",
      "50",
      "--search",
      "error in:title",
      "--json",
      "number,title,url,createdAt",
    ]);
    errorIssues = selectErrorIssues(issues, cutoffMs);
  } catch (err) {
    issuesOk = false;
    log(`WARN gh error-issue query failed — window will not advance: ${String(err)}`);
  }

  return { prs, errorIssues, prsOk, issuesOk };
}

function readJsonSafe<T>(path: string): T | null {
  try {
    if (!existsSync(path)) return null;
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return null;
  }
}

function readHeartbeatState(): HeartbeatState {
  const s = readJsonSafe<HeartbeatState>(
    resolve(ROOT, ".claudius", "heartbeat", "state.json"),
  );
  return { lastHeartbeatAt: s?.lastHeartbeatAt ?? null };
}

function writeHeartbeatState(state: HeartbeatState): void {
  const dir = resolve(ROOT, ".claudius", "heartbeat");
  mkdirSync(dir, { recursive: true });
  writeFileSync(resolve(dir, "state.json"), JSON.stringify(state, null, 2) + "\n");
}

function readContext(): HeartbeatContext {
  type S = {
    lastCheckedAt?: number;
    lastCompletedVersion?: string | null;
    lastSeenVersion?: string | null;
  };
  const sdk = readJsonSafe<S>(resolve(ROOT, ".claudius", "sdk-updater", "state.json"));
  const cc = readJsonSafe<S>(resolve(ROOT, ".claudius", "cc-parity", "state.json"));
  const checks = [sdk?.lastCheckedAt, cc?.lastCheckedAt].filter(
    (n): n is number => typeof n === "number",
  );
  return {
    sdkVersion: sdk?.lastCompletedVersion ?? sdk?.lastSeenVersion ?? null,
    ccVersion: cc?.lastCompletedVersion ?? cc?.lastSeenVersion ?? null,
    lastCheckedMs: checks.length ? Math.max(...checks) : null,
  };
}

async function postAnnouncement(body: string): Promise<void> {
  if (!CHAT_SERVER_URL || !CHAT_SERVER_ADMIN_TOKEN) {
    throw new Error(
      "CHAT_SERVER_URL / CHAT_SERVER_ADMIN_TOKEN not set — cannot post heartbeat",
    );
  }
  const res = await fetch(`${CHAT_SERVER_URL.replace(/\/$/, "")}/admin/announce`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Admin-Token": CHAT_SERVER_ADMIN_TOKEN,
    },
    body: JSON.stringify({ roomSlug: ROOM_SLUG, body, pin: false }),
  });
  if (!res.ok) {
    throw new Error(`chat-server announce failed: HTTP ${res.status} ${await res.text()}`);
  }
}

async function main(): Promise<void> {
  const nowMs = Date.now();
  const state = readHeartbeatState();
  const firstRun = state.lastHeartbeatAt == null;
  const cutoffMs = firstRun
    ? nowMs - WINDOW_HOURS * 3_600_000
    : state.lastHeartbeatAt!;

  const { prs, errorIssues, prsOk, issuesOk } = gatherActivity(realGh, cutoffMs);

  const body = buildHeartbeatMessage({
    nowMs,
    cutoffMs,
    firstRun,
    prsOk,
    issuesOk,
    prs,
    errorIssues,
    context: readContext(),
  });

  if (DRY_RUN) {
    log("DRY-RUN (HEARTBEAT_DRY_RUN=1) — message below, not posting, state unchanged:");
    process.stdout.write("\n" + body + "\n");
    return;
  }

  await postAnnouncement(body);
  log(`posted heartbeat to ${ROOM_SLUG} (${prs.length} update(s), ${errorIssues.length} error issue(s), prsOk=${prsOk}, issuesOk=${issuesOk})`);

  // Advance the window ONLY when BOTH queries fully observed it. If either
  // failed, leave lastHeartbeatAt so the next run re-covers the window and
  // nothing — a merge OR an error report — is silently gapped.
  if (prsOk && issuesOk) {
    writeHeartbeatState({ lastHeartbeatAt: nowMs });
  }
}

const invokedAsScript =
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (import.meta as any).main === true ||
  (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]));

if (invokedAsScript) {
  main().catch((err) => {
    console.error(
      `[heartbeat] fatal: ${err instanceof Error ? err.stack : String(err)}`,
    );
    process.exit(1);
  });
}
