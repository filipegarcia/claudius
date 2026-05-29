import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { ServerEvent } from "@/lib/shared/events";

export type Job = {
  id: string;
  name: string;
  cron: string;
  prompt: string;
  /** When set, overrides the system prompt's default model. */
  model?: string;
  /** Working directory the one-shot session runs in. */
  cwd: string;
  enabled: boolean;
  createdAt: number;
  updatedAt: number;
  lastRunAt?: number;
  nextRunAt?: number;
  lastStatus?: RunStatus;
};

export type RunStatus = "running" | "success" | "error" | "cancelled" | "skipped";

export type Run = {
  id: string;
  jobId: string;
  startedAt: number;
  endedAt?: number;
  status: RunStatus;
  /** Reason when status === "skipped" or "cancelled". */
  note?: string;
  costUsd?: number;
  inputTokens?: number;
  outputTokens?: number;
  /** Captured ServerEvents from the SSE stream of the one-shot session. */
  transcript?: ServerEvent[];
};

const SCHED_ROOT = join(homedir(), ".claude", "claudius", "schedule");
const JOBS_FILE = join(SCHED_ROOT, "jobs.json");
const MAX_RUNS_PER_JOB = 200;

async function ensureRoot(): Promise<void> {
  await fs.mkdir(SCHED_ROOT, { recursive: true });
}

export async function listJobs(): Promise<Job[]> {
  try {
    const buf = await fs.readFile(JOBS_FILE, "utf8");
    const parsed = JSON.parse(buf) as { jobs?: Job[] };
    return Array.isArray(parsed.jobs) ? parsed.jobs : [];
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code === "ENOENT") return [];
    throw err;
  }
}

async function writeJobs(jobs: Job[]): Promise<void> {
  await ensureRoot();
  await fs.writeFile(JOBS_FILE, JSON.stringify({ jobs }, null, 2) + "\n", "utf8");
}

export async function getJob(id: string): Promise<Job | null> {
  const all = await listJobs();
  return all.find((j) => j.id === id) ?? null;
}

export async function saveJob(job: Job): Promise<void> {
  const all = await listJobs();
  const idx = all.findIndex((j) => j.id === job.id);
  if (idx === -1) all.push(job);
  else all[idx] = job;
  await writeJobs(all);
}

export async function deleteJob(id: string): Promise<boolean> {
  const all = await listJobs();
  const next = all.filter((j) => j.id !== id);
  if (next.length === all.length) return false;
  await writeJobs(next);
  // Best-effort: clear runs file too.
  try {
    await fs.rm(runsFile(id));
  } catch {
    // ignore
  }
  try {
    await fs.rm(archiveFile(id));
  } catch {
    // ignore
  }
  try {
    await fs.rmdir(jobDir(id));
  } catch {
    // ignore
  }
  return true;
}

function jobDir(jobId: string): string {
  return join(SCHED_ROOT, "jobs", jobId);
}

function runsFile(jobId: string): string {
  return join(jobDir(jobId), "runs.jsonl");
}

function archiveFile(jobId: string): string {
  return join(jobDir(jobId), "runs.archive.jsonl");
}

export async function appendRun(run: Run): Promise<void> {
  const file = runsFile(run.jobId);
  await fs.mkdir(dirname(file), { recursive: true });
  await fs.appendFile(file, JSON.stringify(run) + "\n", "utf8");
  await rotateIfNeeded(run.jobId);
}

export async function updateRun(run: Run): Promise<void> {
  const file = runsFile(run.jobId);
  let lines: string[] = [];
  try {
    const buf = await fs.readFile(file, "utf8");
    lines = buf.split("\n").filter(Boolean);
  } catch {
    return;
  }
  const next = lines.map((l) => {
    try {
      const r = JSON.parse(l) as Run;
      if (r.id === run.id) return JSON.stringify(run);
      return l;
    } catch {
      return l;
    }
  });
  await fs.writeFile(file, next.join("\n") + "\n", "utf8");
}

export async function listRuns(jobId: string, limit = 50): Promise<Run[]> {
  const file = runsFile(jobId);
  try {
    const buf = await fs.readFile(file, "utf8");
    const out: Run[] = [];
    for (const line of buf.split("\n")) {
      if (!line.trim()) continue;
      try {
        out.push(JSON.parse(line) as Run);
      } catch {
        // skip
      }
    }
    return out.slice(-limit).reverse();
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code === "ENOENT") return [];
    throw err;
  }
}

async function rotateIfNeeded(jobId: string): Promise<void> {
  const file = runsFile(jobId);
  let buf: string;
  try {
    buf = await fs.readFile(file, "utf8");
  } catch {
    return;
  }
  const lines = buf.split("\n").filter(Boolean);
  if (lines.length <= MAX_RUNS_PER_JOB) return;
  const overflow = lines.length - MAX_RUNS_PER_JOB;
  const archive = lines.slice(0, overflow);
  const keep = lines.slice(overflow);
  await fs.appendFile(archiveFile(jobId), archive.join("\n") + "\n", "utf8");
  await fs.writeFile(file, keep.join("\n") + "\n", "utf8");
}
