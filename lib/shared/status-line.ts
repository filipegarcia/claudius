/**
 * Pure merge helpers for the `statusLine` settings object.
 *
 * The SDK's status-line config requires both `type` and `command`; the optional
 * `padding` / `refreshInterval` / `hideVimModeIndicator` sub-fields are only
 * valid alongside a command. Editing one field must therefore MERGE into the
 * existing object rather than rebuilding it from scratch (which silently drops
 * the others). Kept React-free and side-effect-free so it can be unit-tested
 * without dragging in the "use client" settings page.
 */
export type StatusLineConfig = {
  type: "command";
  command: string;
  padding?: number;
  refreshInterval?: number;
  hideVimModeIndicator?: boolean;
};

/**
 * Set the status-line command, preserving any existing sub-fields.
 *
 * An empty/whitespace command drops the WHOLE object (returns `undefined`): the
 * SDK requires `type`+`command`, so a lone `refreshInterval`/`padding` would be
 * invalid.
 */
export function setStatusLineCommand(
  existing: StatusLineConfig | undefined,
  rawCommand: string,
): StatusLineConfig | undefined {
  const command = rawCommand.trim();
  if (!command) return undefined;
  return { ...existing, type: "command", command };
}

/**
 * Set (or clear) the status-line `refreshInterval`, preserving the rest of the
 * object.
 *
 * - No existing command → returns `existing` unchanged (an interval without a
 *   command is invalid; never create an orphaned object).
 * - `seconds` undefined/NaN → returns a copy with the `refreshInterval` key
 *   DELETED (so the status line falls back to event-driven updates), never
 *   `0`/`NaN`.
 * - Otherwise → sets `refreshInterval` to `seconds`.
 */
export function setStatusLineRefreshInterval(
  existing: StatusLineConfig | undefined,
  seconds: number | undefined,
): StatusLineConfig | undefined {
  if (!existing?.command) return existing;
  if (seconds === undefined || Number.isNaN(seconds)) {
    const next = { ...existing };
    delete next.refreshInterval;
    return next;
  }
  return { ...existing, refreshInterval: seconds };
}
