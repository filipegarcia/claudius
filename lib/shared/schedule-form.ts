/**
 * CC 2.1.273 (H10) — "Discard unsaved changes?" guard for the /schedule job
 * form. Cancelling (the form button or the header New/Cancel toggle) silently
 * threw away a typed name/prompt; now a dirty form asks first.
 *
 * Pure so the dirty check is unit-testable without React.
 */

export type ScheduleFormFields = {
  name: string;
  cron: string;
  prompt: string;
  cwd: string;
  model: string;
  /** CC 2.1.312 — optional effort level ("" = the model's default). */
  effort?: string;
};

/** True when any field differs from its initial value — i.e. there's unsaved input. */
export function isScheduleFormDirty(
  current: ScheduleFormFields,
  initial: ScheduleFormFields,
): boolean {
  return (
    current.name !== initial.name ||
    current.cron !== initial.cron ||
    current.prompt !== initial.prompt ||
    current.cwd !== initial.cwd ||
    current.model !== initial.model ||
    (current.effort ?? "") !== (initial.effort ?? "")
  );
}

/**
 * CC 2.1.312 — "[Cloud sessions] Added an effort level to the model picker
 * when you create or edit a routine". The levels a scheduled job can run at,
 * in picker order. An unset effort means the model's default.
 */
export const SCHEDULE_EFFORT_LEVELS = ["low", "medium", "high", "xhigh", "max"] as const;
export type ScheduleEffort = (typeof SCHEDULE_EFFORT_LEVELS)[number];

/**
 * Validate an untrusted `effort` from a schedule create/patch body. Returns
 * the level, `null` for an explicit clear (`null` or `""`), or `undefined`
 * when the value is absent or not a known level (the caller ignores it, or
 * rejects it with a 400).
 */
export function parseScheduleEffort(v: unknown): ScheduleEffort | null | undefined {
  if (v === null || v === "") return null;
  return typeof v === "string" && (SCHEDULE_EFFORT_LEVELS as readonly string[]).includes(v)
    ? (v as ScheduleEffort)
    : undefined;
}
