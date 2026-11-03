/**
 * CC 2.1.317 — "Fixed a background session sometimes losing a just-made
 * change of permission mode when it was upgraded or retired".
 *
 * An SDK host's `setPermissionMode` never reaches the transcript: the engine
 * writes a `permission-mode` line only for the terminal UI, so the only
 * record is the stamp on the *next* prompt. A switch with no prompt after it
 * (Default → Plan, then close the tab) was lost when the idle reaper retired
 * the session or Claudius restarted. So `Session` records every committed
 * switch in the session's state bag (`mergeSessionState`), and a revive
 * (`resumePermissionMode`) picks whichever record is newer: that one or the
 * transcript's last stamp.
 */

/** The state-bag patch recording that the session switched to `mode` at `now`. */
export function permissionModeRecord(
  mode: string,
  now: number = Date.now(),
): { permissionMode: string; permissionModeAt: number } {
  return { permissionMode: mode, permissionModeAt: now };
}

/** Read a record written by `permissionModeRecord` back out of a state bag. */
export function readPermissionModeRecord(
  state: Record<string, unknown>,
): { mode: string; at: number } | null {
  const mode = state.permissionMode;
  const at = state.permissionModeAt;
  if (typeof mode !== "string" || !mode) return null;
  if (typeof at !== "number" || !Number.isFinite(at)) return null;
  return { mode, at };
}

/**
 * The mode a session last ran in or was switched to, given the transcript's
 * last stamp (`at` in epoch ms, null when undated) and the persisted switch.
 * The transcript wins a tie and anything undated: a prompt stamp is the mode
 * the engine actually ran a turn in.
 */
export function pickRecordedPermissionMode(
  transcript: { mode: string; at: number | null } | null,
  persisted: { mode: string; at: number } | null,
): string | null {
  if (!persisted) return transcript?.mode ?? null;
  if (!transcript) return persisted.mode;
  if (transcript.at === null) return transcript.mode;
  return persisted.at > transcript.at ? persisted.mode : transcript.mode;
}
