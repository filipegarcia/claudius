/**
 * CC 2.1.295 parity — stopping a self-paced `/loop`.
 *
 * Claude Code fixed Esc not stopping a self-paced (dynamic, `ScheduleWakeup`)
 * loop that had been moved to the background, and now shows a notice when a
 * pending wake-up is cancelled. Claudius had no stop for these loops at all:
 * the cancel affordances were cron-only (they always asked the agent to run
 * `CronDelete`), and a `ScheduleWakeup { stop: true }` call was mistaken for
 * a fresh arm — the pending chip vanished silently and a blank "scheduled"
 * ghost chip took its place.
 *
 * These helpers are shared by the Activity-rail chip, the `/schedule` page's
 * cancel route, and both loop reducers (client `use-session.ts`, server
 * `session.ts`) so every surface agrees on the prompt and on what a stop
 * looks like.
 */

/**
 * The user-side prompt that asks the agent to cancel a session loop. The
 * scheduling tools live inside the agent runtime, not the Claudius server,
 * so the browser can only ask. Crons are deleted by id; a self-paced loop
 * has exactly one pending wake-up, so it's stopped via `ScheduleWakeup`'s
 * own `stop: true` flag (no id needed).
 */
export function scheduledLoopCancelPrompt(loop: {
  id: string;
  kind: "cron" | "wakeup";
}): string {
  if (loop.kind === "wakeup") {
    return "Please stop the self-paced loop by calling `ScheduleWakeup` with `stop: true`. Reply with one short line confirming it's stopped — don't run any other tools.";
  }
  return `Please cancel the scheduled loop with id \`${loop.id}\` by calling \`CronDelete\` on it. Reply with one short line confirming it's cancelled — don't run any other tools.`;
}

/**
 * True iff a `ScheduleWakeup` tool input is a stop request rather than a new
 * arm. Strict boolean check — the SDK types `stop` as `boolean`, and a
 * truthy non-boolean must not end someone's loop.
 */
export function isScheduleWakeupStop(input: unknown): boolean {
  return (
    typeof input === "object" &&
    input !== null &&
    (input as { stop?: unknown }).stop === true
  );
}

/**
 * Flag every live wake-up in a loop record as `cancelled` — what a
 * `ScheduleWakeup { stop: true }` does. Crons and already-cancelled entries
 * are left alone. The entries stay in the record (mirroring how `CronDelete`
 * is displayed) so the chip reads "cancelled" instead of disappearing.
 * Returns `prev` unchanged when nothing was live, so React state setters can
 * bail out of a re-render on replays.
 *
 * `stopAt` is when the stop was issued: only wake-ups armed at or before it
 * are cancelled, so a stop replayed later (e.g. an SSE reconnect's tail)
 * can't end a newer loop the agent armed after it.
 */
export function markWakeupsStopped<
  T extends { kind: "cron" | "wakeup"; cancelled?: boolean; startedAt?: number },
>(prev: Record<string, T>, stopAt?: number): Record<string, T> {
  let next: Record<string, T> | null = null;
  for (const [k, v] of Object.entries(prev)) {
    if (v.kind !== "wakeup" || v.cancelled) continue;
    if (stopAt != null && v.startedAt != null && v.startedAt > stopAt) continue;
    next ??= { ...prev };
    next[k] = { ...v, cancelled: true };
  }
  return next ?? prev;
}
