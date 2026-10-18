import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import { query, type Options, type SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { nextFireAfter } from "@/lib/shared/cron";
import {
  RUN_ENDED_WITHOUT_RESULT,
  RUN_INTERRUPTED,
  runNoteText,
  SKIP_FOLDER_MISSING,
  SKIP_PREVIOUS_RUN,
} from "@/lib/shared/schedule-skip";
import type { ServerEvent } from "@/lib/shared/events";
import { notificationBus } from "./notification-bus";
import {
  appendRun,
  getJob,
  listJobs,
  listRuns,
  patchJob,
  saveJob,
  updateRun,
  type Job,
  type Run,
  type RunStatus,
} from "./scheduler-store";

const MAX_TIMEOUT_MS = 24 * 60 * 60 * 1000; // setTimeout clamps at ~24.85d; rearm every 24h max.

/** True when a process with this pid exists (signal 0 only probes). */
function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM: it exists but belongs to another user — still alive.
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

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
  private bootPromise: Promise<void> | null = null;

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

  /**
   * Idempotent. Every caller awaits the same promise, so a route (e.g. Run
   * now) can't fire while the interrupted-run recovery below is still
   * rewriting runs.jsonl — a run appended in that window could be dropped by
   * the recovery's read-modify-write.
   */
  boot(): Promise<void> {
    this.bootPromise ??= (async () => {
      const jobs = await listJobs();
      await this.recoverInterruptedRuns(jobs);
      for (const job of jobs) {
        if (job.enabled) this.arm(job);
      }
    })();
    return this.bootPromise;
  }

  /**
   * CC 2.1.302 parity — "Fixed routine runs showing as Completed after their
   * cloud session stopped unexpectedly … instead of failed". When Claudius
   * quits or crashes mid-run, the run row stays `running` in runs.jsonl and the
   * job's `lastStatus` stays `running`, so the Schedule page shows "Live" (and
   * polls) forever. Mark those runs failed with note `interrupted`.
   *
   * A run is only treated as interrupted when the process that started it is
   * gone:
   *  - runs stamped with this process's pid are never touched — in dev a hot
   *    reload can build a fresh Scheduler (empty `liveRuns`) while the old
   *    instance's run is still going in the same process;
   *  - runs stamped with another pid that is still alive belong to another
   *    Claudius process sharing ~/.claude/claudius/schedule (dev server +
   *    desktop app) and are left alone;
   *  - unstamped runs (written before pids were recorded) fall back to "it
   *    started before this process did".
   */
  private async recoverInterruptedRuns(jobs: Job[]): Promise<void> {
    const processStartedAt = Date.now() - Math.round(process.uptime() * 1000);
    const ownerGone = (run: Run): boolean => {
      if (this.liveRuns.has(run.id)) return false;
      if (typeof run.pid === "number") {
        if (run.pid === process.pid) return false;
        return !pidAlive(run.pid);
      }
      return run.startedAt < processStartedAt;
    };
    for (const job of jobs) {
      let runs: Run[];
      try {
        runs = await listRuns(job.id);
      } catch {
        continue;
      }
      let recoveredLatest = false;
      for (const run of runs) {
        if (run.status !== "running") continue;
        if (!ownerGone(run)) continue;
        // No `endedAt`: when the run actually died is unknown, and "now" would
        // read as a run that took as long as Claudius was down.
        await updateRun({ ...run, status: "error", note: RUN_INTERRUPTED });
        if (run.startedAt === job.lastRunAt) recoveredLatest = true;
      }
      if (recoveredLatest && job.lastStatus === "running" && !this.inFlight.has(job.id)) {
        await patchJob(job.id, { lastStatus: "error" });
      }
    }
  }

  /**
   * Record a fire that didn't start: a `skipped` run plus the job-level reason
   * the Schedule page's banner explains. A missing folder also reaches the
   * notification inbox (it used to, as a failed run) — once per new reason,
   * not on every fire of a job that keeps skipping.
   */
  private async recordSkip(job: Job, runId: string, reason: string): Promise<void> {
    const at = Date.now();
    const skipped: Run = {
      id: runId,
      jobId: job.id,
      startedAt: at,
      endedAt: at,
      status: "skipped",
      note: reason,
    };
    await appendRun(skipped);
    const before = await getJob(job.id);
    await patchJob(job.id, { lastSkipReason: reason, lastSkipAt: at });
    if (reason === SKIP_FOLDER_MISSING && before?.lastSkipReason !== reason) {
      void notificationBus.recordSchedulerEvent(job.cwd, runId, job.id, {
        type: "run_finished",
        status: "skipped",
        note: runNoteText(reason),
      });
    }
  }

  /** True when the job's working folder exists and is a directory. */
  private async folderExists(cwd: string): Promise<boolean> {
    try {
      return (await fs.stat(cwd)).isDirectory();
    } catch {
      return false;
    }
  }

  async arm(job: Job): Promise<void> {
    this.disarm(job.id);
    if (!job.enabled) return;
    // CC 2.1.299 parity — "Fixed scheduled tasks and loops firing again after
    // every turn, or firing early, during the repeated hour when daylight
    // saving time ends". Every arm path (boot, edit, post-run re-arm, the 24h
    // cap re-arm) anchors on the last fire instead of computing from now, so
    // a re-arm inside the repeated hour can't land on the wall-clock time
    // that just fired. `lastRunAt` is cron-independent (set at fire start),
    // so it stays a valid anchor after the cron is edited.
    const fireAt = nextFireAfter(job.cron, job.lastRunAt);
    if (fireAt == null) return;
    // Patch only the field arming owns. Writing the caller's `job` back whole
    // would revert an edit (or resurrect a delete) made since it was read.
    const stored = await patchJob(job.id, { nextRunAt: fireAt });
    if (!stored?.enabled) return; // deleted or disabled while we awaited
    // A concurrent arm() may have set a timer during the await — replace it
    // rather than leaving two timers for one job.
    this.disarm(job.id);
    const delay = Math.max(0, Math.min(MAX_TIMEOUT_MS, fireAt - Date.now()));
    const t = setTimeout(() => {
      // If the actual fire time is still in the future (we capped delay), rearm.
      if (fireAt > Date.now() + 250) {
        void this.arm(stored);
        return;
      }
      // Fire the job as stored now, not the snapshot taken at arm time.
      void getJob(job.id)
        .then((current) => (current?.enabled ? this.fire(current) : undefined))
        .catch((err) => console.error("[scheduler] fire failed", job.id, err));
    }, delay);
    this.timers.set(job.id, t);
  }

  /** Re-arm from the stored job; a job deleted or disabled meanwhile stays put. */
  private async rearmFromStore(jobId: string): Promise<void> {
    const current = await getJob(jobId);
    if (current?.enabled) await this.arm(current);
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
      await this.recordSkip(job, runId, SKIP_PREVIOUS_RUN);
      if (reArm) await this.rearmFromStore(job.id);
      return { runId };
    }

    // CC 2.1.302 — say why a run didn't start. The folder is only validated
    // when the job is saved; one deleted since then used to make the SDK throw
    // and the fire read as a generic failed run rather than "didn't start".
    this.inFlight.add(job.id);
    if (!(await this.folderExists(job.cwd))) {
      this.inFlight.delete(job.id);
      await this.recordSkip(job, runId, SKIP_FOLDER_MISSING);
      if (reArm) await this.rearmFromStore(job.id);
      return { runId };
    }

    const startedAt = Date.now();
    const initial: Run = {
      id: runId,
      jobId: job.id,
      startedAt,
      status: "running",
      // Lets boot-time recovery tell a run whose process died from one a
      // still-running Claudius process (or this one, before a hot reload) owns.
      pid: process.pid,
      transcript: [],
    };
    await appendRun(initial);
    // A run started: any earlier "didn't start" reason no longer applies.
    await patchJob(job.id, {
      lastRunAt: startedAt,
      lastStatus: "running",
      lastSkipReason: undefined,
      lastSkipAt: undefined,
    });

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
    let sawResult = false;

    try {
      const options: Options = {
        cwd: job.cwd,
        model: job.model,
        // No canUseTool — one-shot runs can't ask the user for permissions.
        // The session inherits user/project allow rules; deny anything not
        // pre-approved by setting permissionMode.
        permissionMode: "auto",
        // CC 2.1.259 — this run is unattended (no browser tab to answer a
        // prompt). `permissionPrompts: "none"` makes the SDK deny anything
        // the mode/rules/hooks don't pre-approve *immediately*, with a
        // message telling Claude the session has no approval surface, instead
        // of leaving the turn to hang on a prompt nobody can see.
        permissionPrompts: "none",
      };
      const q = query({ prompt: job.prompt, options });
      for await (const msg of q as AsyncIterable<SDKMessage>) {
        const env: ServerEvent = { type: "sdk", message: msg };
        transcript.push(env);
        this.broadcastRun(runId, env);
        if (msg.type === "result") {
          sawResult = true;
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
      // CC 2.1.302 — a session that stopped without a final result didn't
      // complete; don't let the "success" default call it Completed.
      if (!sawResult) {
        finalStatus = "error";
        note = RUN_ENDED_WITHOUT_RESULT;
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
    // Patch, don't save the start-of-run `job`: if the user deleted or edited
    // the job mid-run, that must stick (CC 2.1.292 — saved tasks ignoring
    // later deletes).
    await patchJob(job.id, { lastRunAt: startedAt, lastStatus: finalStatus });

    // Surface the run finish to the workspace notification inbox. The bus
    // filters per workspace prefs; "skipped" runs (the in-flight collision)
    // never reach this codepath, so they don't notify.
    void notificationBus.recordSchedulerEvent(job.cwd, runId, job.id, {
      type: "run_finished",
      status: finalStatus,
      ...(costUsd ? { costUsd } : {}),
      // Readable text, not the raw reason code (e.g. "session_ended_without_result").
      ...(note ? { note: runNoteText(note) } : {}),
    });

    if (reArm) await this.rearmFromStore(job.id);
    return { runId };
  }

  isRunLive(runId: string): boolean {
    const buf = this.liveRuns.get(runId);
    return !!buf && !buf.done;
  }

  /**
   * CC 2.1.221 parity ("Changed `/status` to show the session kind:
   * `interactive`, or a background job that is `attached` or
   * `unattended`"). Claudius's own equivalent of a "background job" is a
   * scheduler run — it executes headlessly, with no interactive prompt
   * loop, so it's never "interactive". What CAN vary is whether a browser
   * tab currently has the run's live SSE stream open (`RunTranscript` in
   * the Schedule page): `subscribers.size > 0` means "attached", an empty
   * set while still running means "unattended" — fired and progressing
   * with nobody watching. Returns `false` once the run is no longer live
   * (finished runs aren't "unattended", they're just done).
   */
  isRunAttached(runId: string): boolean {
    const buf = this.liveRuns.get(runId);
    return !!buf && !buf.done && buf.subscribers.size > 0;
  }

  // Re-export listing for the API layer.
  listJobs = listJobs;
  getJob = getJob;
  saveJob = saveJob;
  listRuns = listRuns;
}

declare global {
  var __claudiusScheduler: Scheduler | undefined;
}

// In dev, Next.js hot-reloads modules but leaves `globalThis` alive — meaning
// a stale Scheduler instance hangs around without new methods this file
// added. Detect that by probing for any newly-introduced method and rebuild.
function pickScheduler(): Scheduler {
  const cached = globalThis.__claudiusScheduler;
  if (
    cached &&
    typeof (cached as Scheduler).subscribeRun === "function" &&
    // CC 2.1.302 — instances built before skip/interrupt recording lack this.
    typeof (cached as unknown as { recordSkip?: unknown }).recordSkip === "function"
  )
    return cached;
  const fresh = new Scheduler();
  globalThis.__claudiusScheduler = fresh;
  return fresh;
}

export const scheduler: Scheduler = pickScheduler();
