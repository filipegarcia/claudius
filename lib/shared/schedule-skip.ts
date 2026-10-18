/**
 * CC 2.1.302 parity — Claude Code added "a banner on a routine's page that
 * says why its last run didn't start", and fixed routine runs that died being
 * reported as Completed instead of failed. Claudius's scheduled jobs are its
 * routines; these are the reason codes the scheduler records (as `Run.note` /
 * `Job.lastSkipReason`) and the human text the Schedule page shows for them.
 *
 * Browser-safe: no Node imports.
 */

/** A fire was skipped because the job's previous run was still going. */
export const SKIP_PREVIOUS_RUN = "previous_run_in_progress";
/** A fire was skipped because the job's working folder no longer exists. */
export const SKIP_FOLDER_MISSING = "workspace_folder_missing";
/** The agent stream ended without a final result message. */
export const RUN_ENDED_WITHOUT_RESULT = "session_ended_without_result";
/** Claudius stopped (quit, crashed, restarted) while the run was in flight. */
export const RUN_INTERRUPTED = "interrupted";

const NOTE_TEXT: Record<string, string> = {
  [SKIP_PREVIOUS_RUN]: "The previous run was still in progress",
  [SKIP_FOLDER_MISSING]: "The job's folder no longer exists",
  [RUN_ENDED_WITHOUT_RESULT]: "The session ended before the run finished",
  [RUN_INTERRUPTED]: "Claudius stopped while this run was in progress",
};

/** Readable text for a known run note; unknown notes pass through unchanged. */
export function runNoteText(note: string): string {
  return NOTE_TEXT[note] ?? note;
}

type SkipFields = {
  lastRunAt?: number;
  lastStatus?: string;
  lastSkipReason?: string;
  lastSkipAt?: number;
};

/**
 * The skip the job page should explain, or null. A skip only counts while it
 * is newer than the latest run that actually started — once a run starts the
 * scheduler clears the fields, but a stale pair (e.g. written by an older
 * build) must not keep a banner up over a newer successful run. Texts carry no
 * trailing full stop: the UI follows them with "· 2m ago".
 */
export function activeSkip(job: SkipFields): { reason: string; at: number; text: string } | null {
  const reason = job.lastSkipReason;
  const at = job.lastSkipAt;
  if (!reason || typeof at !== "number" || !Number.isFinite(at)) return null;
  if (typeof job.lastRunAt === "number" && job.lastRunAt > at) return null;
  // "Previous run still in progress" stops being true once that run ends —
  // it finishes after the skip but keeps its earlier start as `lastRunAt`.
  if (reason === SKIP_PREVIOUS_RUN && job.lastStatus !== "running") return null;
  return { reason, at, text: runNoteText(reason) };
}
