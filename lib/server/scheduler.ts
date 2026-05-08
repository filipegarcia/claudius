import { randomUUID } from "node:crypto";
import { query, type Options, type SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { nextFireMs } from "@/lib/shared/cron";
import type { ServerEvent } from "@/lib/shared/events";
import {
  appendRun,
  getJob,
  listJobs,
  listRuns,
  saveJob,
  updateRun,
  type Job,
  type Run,
  type RunStatus,
} from "./scheduler-store";

const MAX_TIMEOUT_MS = 24 * 60 * 60 * 1000; // setTimeout clamps at ~24.85d; rearm every 24h max.

type RunSubscriber = (event: ServerEvent) => void;

type LiveRunBuffer = {
  events: ServerEvent[];
  subscribers: Set<RunSubscriber>;
  done: boolean;
};

class Scheduler {
  private timers = new Map<string, ReturnType<typeof setTimeout>>();
  /** Per-job mutex — true while a run is in flight. */
  private inFlight = new Set<string>();
  /** Live broadcast bus, keyed by runId. Lives only while the run is in flight. */
  private liveRuns = new Map<string, LiveRunBuffer>();
  private booted = false;

  /**
   * Subscribe to the live event stream for a run. Replays any events already
   * buffered, then forwards new events as they arrive. Returns an unsubscribe
   * function. If the run is already finished (or unknown), `fn` is called once
   * with a synthetic "done" marker and the unsubscribe is a no-op.
   */
  subscribeRun(runId: string, fn: RunSubscriber): () => void {
    const buf = this.liveRuns.get(runId);
    if (!buf) {
      // Already complete or unknown — caller should fall back to the persisted
      // transcript via /runs.
      fn({ type: "error", message: "run_not_live" });
      return () => {};
    }
    for (const ev of buf.events) fn(ev);
    if (buf.done) return () => {};
    buf.subscribers.add(fn);
    return () => {
      buf.subscribers.delete(fn);
    };
  }

  private broadcastRun(runId: string, ev: ServerEvent): void {
    const buf = this.liveRuns.get(runId);
    if (!buf) return;
    buf.events.push(ev);
    for (const sub of buf.subscribers) {
      try {
        sub(ev);
      } catch {
        // ignore subscriber errors
      }
    }
  }

  async boot(): Promise<void> {
    if (this.booted) return;
    this.booted = true;
    const jobs = await listJobs();
    for (const job of jobs) {
      if (job.enabled) this.arm(job);
    }
  }

  async arm(job: Job): Promise<void> {
    this.disarm(job.id);
    if (!job.enabled) return;
    const fireAt = nextFireMs(job.cron);
    if (fireAt == null) return;
    const updated: Job = { ...job, nextRunAt: fireAt };
    await saveJob(updated);
    const delay = Math.max(0, Math.min(MAX_TIMEOUT_MS, fireAt - Date.now()));
    const t = setTimeout(() => {
      // If the actual fire time is still in the future (we capped delay), rearm.
      if (fireAt > Date.now() + 250) {
        void this.arm(updated);
        return;
      }
      void this.fire(updated);
    }, delay);
    this.timers.set(job.id, t);
  }

  disarm(jobId: string): void {
    const t = this.timers.get(jobId);
    if (t) clearTimeout(t);
    this.timers.delete(jobId);
  }

  async runNow(jobId: string): Promise<{ runId: string } | null> {
    const job = await getJob(jobId);
    if (!job) return null;
    return await this.fire(job, /*reArm*/ false);
  }

  async deleteJob(jobId: string): Promise<void> {
    this.disarm(jobId);
  }

  /** Internal: dispatch a one-shot SDK session for the job. */
  private async fire(job: Job, reArm = true): Promise<{ runId: string }> {
    const runId = randomUUID();

    if (this.inFlight.has(job.id)) {
      const skipped: Run = {
        id: runId,
        jobId: job.id,
        startedAt: Date.now(),
        endedAt: Date.now(),
        status: "skipped",
        note: "previous_run_in_progress",
      };
      await appendRun(skipped);
      if (reArm) await this.arm(job);
      return { runId };
    }

    this.inFlight.add(job.id);
    const startedAt = Date.now();
    const initial: Run = {
      id: runId,
      jobId: job.id,
      startedAt,
      status: "running",
      transcript: [],
    };
    await appendRun(initial);
    await saveJob({ ...job, lastRunAt: startedAt, lastStatus: "running" });

    // Open the live bus before any SDK output so subscribers that connect
    // immediately see the full transcript from the start.
    const liveBuf: LiveRunBuffer = { events: [], subscribers: new Set(), done: false };
    this.liveRuns.set(runId, liveBuf);
    this.broadcastRun(runId, { type: "ready", sessionId: runId });

    const transcript: ServerEvent[] = [];
    let costUsd = 0;
    let inputTokens = 0;
    let outputTokens = 0;
    let finalStatus: RunStatus = "success";
    let note: string | undefined;

    try {
      const options: Options = {
        cwd: job.cwd,
        model: job.model,
        // No canUseTool — one-shot runs can't ask the user for permissions.
        // The session inherits user/project allow rules; deny anything not
        // pre-approved by setting permissionMode.
        permissionMode: "auto",
      };
      const q = query({ prompt: job.prompt, options });
      for await (const msg of q as AsyncIterable<SDKMessage>) {
        const env: ServerEvent = { type: "sdk", message: msg };
        transcript.push(env);
        this.broadcastRun(runId, env);
        if (msg.type === "result") {
          const r = msg as {
            subtype?: string;
            total_cost_usd?: number;
            usage?: { input_tokens?: number; output_tokens?: number };
          };
          costUsd += r.total_cost_usd ?? 0;
          inputTokens += r.usage?.input_tokens ?? 0;
          outputTokens += r.usage?.output_tokens ?? 0;
          if (r.subtype && r.subtype !== "success") {
            finalStatus = "error";
            note = r.subtype;
          }
        }
      }
    } catch (err) {
      finalStatus = "error";
      note = err instanceof Error ? err.message : String(err);
      const errEv: ServerEvent = { type: "error", message: note };
      transcript.push(errEv);
      this.broadcastRun(runId, errEv);
    } finally {
      this.inFlight.delete(job.id);
      // Close the live bus — any current subscribers will be informed by the
      // SSE route via its own done marker, then drop.
      liveBuf.done = true;
      // Keep the buffer around briefly so a late subscriber can still replay.
      setTimeout(() => {
        this.liveRuns.delete(runId);
      }, 5000);
    }

    const finished: Run = {
      ...initial,
      endedAt: Date.now(),
      status: finalStatus,
      note,
      costUsd: costUsd || undefined,
      inputTokens: inputTokens || undefined,
      outputTokens: outputTokens || undefined,
      transcript,
    };
    await updateRun(finished);
    await saveJob({ ...job, lastRunAt: startedAt, lastStatus: finalStatus });

    if (reArm) await this.arm(await this.refreshJob(job.id));
    return { runId };
  }

  private async refreshJob(jobId: string): Promise<Job> {
    const j = await getJob(jobId);
    if (!j) throw new Error(`job ${jobId} disappeared`);
    return j;
  }

  isRunLive(runId: string): boolean {
    const buf = this.liveRuns.get(runId);
    return !!buf && !buf.done;
  }

  // Re-export listing for the API layer.
  listJobs = listJobs;
  getJob = getJob;
  saveJob = saveJob;
  listRuns = listRuns;
}

declare global {
  // eslint-disable-next-line no-var
  var __claudiusScheduler: Scheduler | undefined;
}

// In dev, Next.js hot-reloads modules but leaves `globalThis` alive — meaning
// a stale Scheduler instance hangs around without new methods this file
// added. Detect that by probing for any newly-introduced method and rebuild.
function pickScheduler(): Scheduler {
  const cached = globalThis.__claudiusScheduler;
  if (cached && typeof (cached as Scheduler).subscribeRun === "function") return cached;
  const fresh = new Scheduler();
  globalThis.__claudiusScheduler = fresh;
  return fresh;
}

export const scheduler: Scheduler = pickScheduler();
