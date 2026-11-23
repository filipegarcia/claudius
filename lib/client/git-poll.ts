/**
 * CC 2.1.316 parity — "Improved /diff on large repositories: each refresh
 * usually runs one fewer full-repository git command, and refreshes are
 * spaced out when git is slow".
 *
 * Claudius's Git page (`useGitStatus`) used to poll `git/status` on a fixed
 * 4s `setInterval` and abort the in-flight request on every tick, and the
 * `/diff` overlay (`DiffOverlay`) aborted + re-fetched on every edit-stream
 * token. On a repo where `git status` takes longer than the gap, the list
 * never updated and server-side git children piled up until their timeout.
 * Now a refresh is never aborted by the next background one: the next poll
 * is scheduled after the previous one finishes, spaced by how long it took.
 *
 * (The "one fewer git command" half needs nothing here — Claudius already
 * runs a single full-repo `git status` per refresh, `lib/server/git.ts`.)
 */

/** How many times the last refresh's duration to wait before the next one. */
export const GIT_POLL_SLOW_FACTOR = 3;
/** Upper bound on the spacing, so a pathologically slow repo still refreshes. */
export const GIT_POLL_MAX_MS = 60_000;

function nonNegative(n: number | null | undefined): number {
  return typeof n === "number" && Number.isFinite(n) && n > 0 ? n : 0;
}

/**
 * Delay before the next git refresh: at least `baseMs` (the normal poll
 * interval), stretched to `GIT_POLL_SLOW_FACTOR ×` the last refresh's
 * duration when git is slow, capped at `GIT_POLL_MAX_MS`.
 */
export function nextGitPollDelayMs(baseMs: number, lastDurationMs: number | null | undefined): number {
  const base = nonNegative(baseMs);
  const slow = nonNegative(lastDurationMs) * GIT_POLL_SLOW_FACTOR;
  return Math.min(GIT_POLL_MAX_MS, Math.max(base, slow));
}

type Timers = {
  now?: () => number;
  setTimeout?: (fn: () => void, ms: number) => unknown;
  clearTimeout?: (handle: unknown) => void;
};

export type CoalescedRunner = {
  /** Ask for a refresh. Starts now when idle; while one is in flight (or one
   *  is already queued) it just marks a single follow-up. */
  request: () => void;
  /** Abort the in-flight run and drop any queued follow-up. */
  dispose: () => void;
};

/**
 * Runs `run` once immediately, then coalesces `request()` calls: a request
 * that lands while a run is in flight never aborts it — it queues ONE
 * follow-up, started `nextGitPollDelayMs(0, lastDuration)` after the
 * running one settles. Used by `/diff` so a burst of edits refreshes the
 * file list once git is free instead of restarting `git status` per edit.
 */
export function createCoalescedRunner(
  run: (signal: AbortSignal) => Promise<unknown>,
  timers: Timers = {},
): CoalescedRunner {
  const now = timers.now ?? (() => Date.now());
  const arm = timers.setTimeout ?? ((fn: () => void, ms: number) => setTimeout(fn, ms));
  const disarm =
    timers.clearTimeout ?? ((h: unknown) => clearTimeout(h as ReturnType<typeof setTimeout>));

  let disposed = false;
  let controller: AbortController | null = null;
  let timer: unknown = null;
  let dirty = false;

  const start = () => {
    if (disposed) return;
    timer = null;
    dirty = false;
    const ac = new AbortController();
    controller = ac;
    const startedAt = now();
    const settle = () => {
      if (controller !== ac) return;
      controller = null;
      if (!dirty || disposed) return;
      timer = arm(start, nextGitPollDelayMs(0, now() - startedAt));
    };
    let p: Promise<unknown>;
    try {
      p = Promise.resolve(run(ac.signal));
    } catch {
      p = Promise.resolve();
    }
    p.then(settle, settle);
  };

  start();

  return {
    request: () => {
      if (disposed) return;
      if (controller || timer !== null) {
        dirty = true;
        return;
      }
      start();
    },
    dispose: () => {
      disposed = true;
      dirty = false;
      if (timer !== null) disarm(timer);
      timer = null;
      controller?.abort();
      controller = null;
    },
  };
}
