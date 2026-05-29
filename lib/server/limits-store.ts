import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { encodeProjectDir } from "./auto-memory";

/**
 * Spend caps for a workspace. v1 stores a single JSON file per cwd. The
 * fields are independent: 0 / null / undefined disables that cap.
 */
export type Limits = {
  /** Project-wide daily USD cap. 0 disables. */
  projectDailyUsd?: number;
  /** Per-session USD cap. 0 disables. */
  sessionUsd?: number;
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
