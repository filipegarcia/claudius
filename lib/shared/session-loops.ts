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
  /**
   * `noop` from the ScheduleWakeup call (SDK 0.3.245): the agent reporting
   * that this tick changed nothing — it checked and had nothing to report.
   * `false`/absent means the tick did something worth keeping (edited a
   * file, posted a message, surfaced a finding).
   */
  noop?: boolean;
  /**
   * How many consecutive quiet ticks this loop has now run, counting this
   * one. Claude Code collapses consecutive `noop: true` ticks in its
   * terminal view and tracks the run as a streak; we reconstruct the same
   * number as each wake-up supersedes the last, so a long quiet hold reads
   * as one chip instead of an indistinguishable series. `0`/absent for a
   * tick that did something.
   */
  noopStreak?: number;
  /**
   * Epoch ms of the cron's next run, from the structured `CronCreate` result
   * (SDK 0.3.299 `CronCreateOutput.nextFireAt`, per-job scheduler offset
   * included). A snapshot taken when the job was created — it is not updated
   * after the job fires. Absent for wake-ups and for older SDKs.
   */
  nextFireAt?: number;
  /**
   * Age at which a recurring cron ends, in ms from `startedAt` (SDK 0.3.332
   * `CronCreateOutput.maxAgeMs`, or the result text's "Auto-expires after N
   * days"). Absent when neither says; `loopEndsAt` then uses the engine's
   * 7-day default. Read with `readCronMaxAgeMs`.
   */
  maxAgeMs?: number;
  /** True once `CronDelete` (or the equivalent) ran for this loop. */
  cancelled: boolean;
};

/**
 * CC 2.1.330 — "Changed recurring scheduled tasks and `/loop` to run up to 30
 * days instead of 7 while their session keeps running, and say when they end;
 * tasks made before this release still end at 7 days".
 *
 * The engine ends a recurring job at `min(maxAgeMs ?? 7 days || ∞,
 * recurringMaxAgeMs || ∞)` after it is created, with `recurringMaxAgeMs` = 30
 * days. A job written without `maxAgeMs` (older ones) keeps the 7-day default;
 * `maxAgeMs: 0` ("never") is held to the 30-day ceiling.
 */
export const LOOP_DEFAULT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
export const LOOP_RECURRING_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Read a recurring cron's age limit off its `CronCreate` result: the
 * structured `tool_use_result.maxAgeMs` (SDK 0.3.332) first, then the result
 * text's "Auto-expires after N days" (the structured payload doesn't survive
 * every replay path). `0` resolves to the 30-day ceiling. Undefined when
 * neither says.
 */
export function readCronMaxAgeMs(toolUseResult: unknown, text: string): number | undefined {
  if (toolUseResult && typeof toolUseResult === "object") {
    const v = (toolUseResult as { maxAgeMs?: unknown }).maxAgeMs;
    if (typeof v === "number" && Number.isFinite(v) && v >= 0) return v === 0 ? LOOP_RECURRING_MAX_AGE_MS : v;
  }
  const days = /Auto-expires after (\d+) days?/i.exec(text)?.[1];
  if (days && Number(days) > 0) return Number(days) * 24 * 60 * 60 * 1000;
  return undefined;
}

/**
 * Whether a `CronCreate` job repeats, from its result: the structured
 * `recurring` first, then the result text ("Scheduled recurring job …" /
 * "Scheduled one-shot task …"). Undefined when neither says — the caller
 * falls back to the input, where an omitted `recurring` means true.
 */
export function readCronRecurring(toolUseResult: unknown, text: string): boolean | undefined {
  if (toolUseResult && typeof toolUseResult === "object") {
    const v = (toolUseResult as { recurring?: unknown }).recurring;
    if (typeof v === "boolean") return v;
  }
  if (/Scheduled recurring job/i.test(text)) return true;
  if (/Scheduled one-shot task/i.test(text)) return false;
  return undefined;
}

/**
 * Epoch ms at which a recurring cron has its last run and ends; null for
 * wake-ups and one-shot crons (they end after their single fire).
 */
export function loopEndsAt(
  loop: Pick<SessionLoop, "kind" | "recurring" | "startedAt" | "maxAgeMs">,
): number | null {
  if (loop.kind !== "cron" || !loop.recurring) return null;
  return loop.startedAt + (loop.maxAgeMs ?? LOOP_DEFAULT_MAX_AGE_MS);
}

/**
 * Read `endedLoopWakeup` (SDK 0.3.321 `CronDeleteOutput.endedLoopWakeup`) off
 * the `tool_use_result` of a `CronDelete` tool_result. `true` means the id the
 * agent deleted was the session's self-paced (`ScheduleWakeup`) wake-up rather
 * than a cron job — so the pending wake-up chip must flip to "cancelled" even
 * though its rail key is a tool_use id that never matches `CronDelete`'s `id`.
 * Tolerant: the payload arrives as `unknown`; only a literal `true` counts.
 */
export function readEndedLoopWakeup(toolUseResult: unknown): boolean {
  if (!toolUseResult || typeof toolUseResult !== "object") return false;
  return (toolUseResult as { endedLoopWakeup?: unknown }).endedLoopWakeup === true;
}

/**
 * Read `nextFireAt` (SDK 0.3.299) off the `tool_use_result` that rides on the
 * user message carrying a `CronCreate` tool_result. Tolerant: the payload
 * arrives as `unknown`, older SDKs omit the field, and only a finite
 * positive epoch-ms number is accepted.
 */
export function readCronNextFireAt(toolUseResult: unknown): number | undefined {
  if (!toolUseResult || typeof toolUseResult !== "object") return undefined;
  const v = (toolUseResult as { nextFireAt?: unknown }).nextFireAt;
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? v : undefined;
}

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
