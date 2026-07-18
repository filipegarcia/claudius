import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { encodeProjectDir } from "./auto-memory";

/**
 * Spend/tool-call caps for a workspace. v1 stores a single JSON file per cwd.
 * The fields are independent: 0 / null / undefined disables that cap.
 *
 * `maxWebSearches` / `maxSubagents` are CC 2.1.212 parity — upstream added a
 * session-wide WebSearch call cap and subagent-spawn cap (both default 200,
 * tunable via `CLAUDE_CODE_MAX_WEB_SEARCHES_PER_SESSION` /
 * `CLAUDE_CODE_MAX_SUBAGENTS_PER_SESSION`) as a runaway-loop safety net.
 * Claudius reimplements them as per-cwd settings here instead of env vars,
 * and — unlike upstream's default-on-at-200 — follows this file's existing
 * "0/undefined disables" convention so the cap is opt-in, consistent with
 * `projectDailyUsd`/`sessionUsd` above (see run-notes 2.1.214 for the
 * rejected default-on alternative).
 */
export type Limits = {
  /** Project-wide daily USD cap. 0 disables. */
  projectDailyUsd?: number;
  /** Per-session USD cap. 0 disables. */
  sessionUsd?: number;
  /** Per-session WebSearch tool-call cap. 0/undefined disables. */
  maxWebSearches?: number;
  /** Per-session Task (subagent) spawn cap. 0/undefined disables. */
  maxSubagents?: number;
};

export type LimitsAuditEvent = {
  ts: string; // ISO
  kind: "breach" | "override";
  scope: "session" | "project";
  /** Session id when scope=session. */
  target?: string;
  capUsd: number;
  spentUsd: number;
  /** When kind=override, the calendar day (YYYY-MM-DD) the override applies to. */
  overrideDay?: string;
};

export type LimitsState = {
  limits: Limits;
  /** Day-keyed override flags. Format: { "session:<id>:2026-05-08": true } */
  overrides: Record<string, true>;
  audit: LimitsAuditEvent[];
};

function limitsDir(): string {
  return join(homedir(), ".claude", ".claudius", "limits");
}

function limitsPath(cwd: string): string {
  return join(limitsDir(), `${encodeProjectDir(cwd)}.json`);
}

async function ensureDir(): Promise<void> {
  await fs.mkdir(limitsDir(), { recursive: true });
}

const EMPTY: LimitsState = { limits: {}, overrides: {}, audit: [] };

export async function readLimits(cwd: string): Promise<LimitsState> {
  try {
    const raw = await fs.readFile(limitsPath(cwd), "utf8");
    const parsed = JSON.parse(raw) as Partial<LimitsState>;
    return {
      limits: parsed.limits ?? {},
      overrides: parsed.overrides ?? {},
      audit: Array.isArray(parsed.audit) ? parsed.audit : [],
    };
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code === "ENOENT") return { ...EMPTY, audit: [] };
    throw err;
  }
}

export async function writeLimits(cwd: string, limits: Limits): Promise<LimitsState> {
  await ensureDir();
  const cur = await readLimits(cwd);
  const next: LimitsState = { ...cur, limits };
  await fs.writeFile(limitsPath(cwd), JSON.stringify(next, null, 2), "utf8");
  return next;
}

export async function appendAudit(cwd: string, ev: LimitsAuditEvent): Promise<LimitsState> {
  await ensureDir();
  const cur = await readLimits(cwd);
  const audit = [...cur.audit, ev].slice(-200); // cap history
  const next: LimitsState = { ...cur, audit };
  await fs.writeFile(limitsPath(cwd), JSON.stringify(next, null, 2), "utf8");
  return next;
}

export async function setOverride(
  cwd: string,
  key: string,
  on: boolean,
): Promise<LimitsState> {
  await ensureDir();
  const cur = await readLimits(cwd);
  const overrides = { ...cur.overrides };
  if (on) overrides[key] = true;
  else delete overrides[key];
  const next: LimitsState = { ...cur, overrides };
  await fs.writeFile(limitsPath(cwd), JSON.stringify(next, null, 2), "utf8");
  return next;
}

export function todayKey(): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

export function sessionOverrideKey(sessionId: string): string {
  return `session:${sessionId}:${todayKey()}`;
}
