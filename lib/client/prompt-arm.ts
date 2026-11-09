/**
 * CC 2.1.318 parity — "Fixed permission prompts being answered by keys typed
 * just after sending a message, or before a slow prompt appeared".
 *
 * Claudius's permission card and MCP input prompt listen for Escape on
 * `window` from the moment they mount (deny / cancel). An Escape typed in the
 * composer a beat before a slow prompt appeared — meant for the composer's
 * picker or "two Escapes clear the input" — bubbled to that listener and
 * declined a request the user never saw. A short arm window after mount
 * ignores those keystrokes; Escape works as before once the prompt has been
 * on screen for {@link PROMPT_ARM_GRACE_MS}.
 */
export const PROMPT_ARM_GRACE_MS = 400;

/**
 * True while a keystroke at `eventTimeStamp` (a `KeyboardEvent.timeStamp`,
 * same clock as `performance.now()`) is too soon after the prompt armed at
 * `armedAt` to have been meant for it. `armedAt === null` (not armed yet)
 * counts as too soon.
 */
export function isBeforePromptArmed(eventTimeStamp: number, armedAt: number | null): boolean {
  if (armedAt === null) return true;
  return eventTimeStamp - armedAt < PROMPT_ARM_GRACE_MS;
}
