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
    current.model !== initial.model
  );
}
