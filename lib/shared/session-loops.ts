/**
 * Shape of a "session-only" loop/wake-up — the kind that lives inside a
 * Claude session's agent runtime via the harness-provided `CronCreate` /
 * `ScheduleWakeup` tools. These are reconstructed by observing the SDK
 * tool stream (both client-side in the Activity rail and server-side for
 * cross-session visibility on `/schedule`).
 *
 * The client-side `ScheduledLoop` in `lib/client/types.ts` is the same
 * concept; this file is the **server-broadcast / API-serialized** shape
 * shared between `lib/server/session.ts` and the `/api/schedule/session-loops`
 * endpoints. They overlap intentionally — keeping them separate so the
 * client code keeps its lean local types and the API has a stable wire
 * shape independent of internal refactors.
 */
export type SessionLoopKind = "cron" | "wakeup";

export type SessionLoop = {
  kind: SessionLoopKind;
  /** Cron id (cron kind) OR tool_use_id (wakeup kind). Stable per-session. */
  id: string;
  /** tool_use_id of the call that created this entry. */
  toolUseId: string;
  /** Cron expression for `kind: "cron"`, null otherwise. */
  cron: string | null;
  /** Human-readable schedule from the tool_result (e.g. "Every minute"). */
  humanSchedule: string | null;
  /** Seconds until next fire (wakeup kind only). */
  delaySeconds: number | null;
  /** Verbatim prompt the agent scheduled. */
  prompt: string;
  /** Wake-up reason (wakeup kind only). */
  reason?: string;
  /** Whether the cron repeats. Wake-ups are always one-shot. */
  recurring: boolean;
  /** True iff CronCreate did NOT mark this session-only. */
  durable: boolean;
  /** Epoch ms when the loop was armed. */
  startedAt: number;
  /** True once `CronDelete` (or the equivalent) ran for this loop. */
  cancelled: boolean;
};

/**
 * `/api/schedule/session-loops` GET response — a flat list across every
 * live session, with enough context for the `/schedule` page to render an
 * entry without a separate fetch per session.
 */
export type SessionLoopListItem = SessionLoop & {
  /** Owning session id (so the cancel endpoint can target it). */
  sessionId: string;
  /** Optional human title for the owning session (chip subtitle on /schedule). */
  sessionTitle: string | null;
};

export type SessionLoopListResponse = {
  loops: SessionLoopListItem[];
};

export type CancelSessionLoopRequest = {
  sessionId: string;
  loopId: string;
};

export type CancelSessionLoopResponse = { ok: true } | { ok: false; error: string };

/**
 * Grace window past a wake-up's fire moment before we treat the entry as
 * "stale" and hide it from the UI. There's no SDK-level "wake-up fired"
 * signal — the wake-up triggers the next agent turn but doesn't emit a
 * matching tool_result we can observe. Inferring fired-ness from
 * `now > startedAt + delaySeconds + grace` is the cleanest signal we have:
 *
 *   - If the agent chains a fresh `ScheduleWakeup` after firing, the
 *     reducer replaces the prior wake-up with the new one — staleness
 *     never matters.
 *   - If the loop stops (no chain), the entry would otherwise sit forever
 *     showing "due now." The grace window covers brief processing delay
 *     while leaving "definitely fired and abandoned" entries to fade out.
 *
 * One minute is generous enough to absorb a slow turn (network round-trip,
 * permission prompts, etc.) without leaving stale chips visible for the
 * user to puzzle over.
 */
export const WAKEUP_STALE_GRACE_MS = 60_000;

/**
 * True iff this is a one-shot wake-up whose fire moment has passed by
 * more than the grace window. Cron loops never go stale — they are
 * explicitly armed-until-cancelled. Wake-ups without a `delaySeconds`
 * (defensive: shouldn't happen in practice) are also never stale.
 */
export function isStaleWakeup(
  loop: Pick<SessionLoop, "kind" | "startedAt" | "delaySeconds">,
  now: number,
): boolean {
  if (loop.kind !== "wakeup") return false;
  if (loop.delaySeconds == null) return false;
  const fireAt = loop.startedAt + loop.delaySeconds * 1000;
  return now > fireAt + WAKEUP_STALE_GRACE_MS;
}
