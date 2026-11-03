/**
 * SDK 0.3.317 — `system/session_writes_lost` (`SDKSessionWritesLostMessage`).
 *
 * Sent at most once, as the CLI exits (after the last result), when a full
 * disk (`ENOSPC`) or an exhausted quota (`EDQUOT`) kept the CLI from saving
 * lines of a session transcript and/or changes to `~/.claude.json`. Results
 * already received stand; the practical consequence is that a later resume of
 * the session may miss part of the conversation — worth a visible warning.
 *
 * Pure (no React / SDK import) so the reducer branch in `use-session.ts` is
 * unit-testable.
 */
export type SessionWritesLostMessage = {
  error_code?: string;
  lost?: unknown;
  transcript_session_ids?: unknown;
};

const LOST_LABELS: Record<string, string> = {
  transcript: "the session transcript",
  global_config: "changes to ~/.claude.json",
};

const CAUSE_LABELS: Record<string, string> = {
  ENOSPC: "the disk is full",
  EDQUOT: "the disk quota is used up",
};

/** Pill label + detail for a `session_writes_lost` frame. Tolerates unknown codes/values. */
export function describeSessionWritesLost(msg: SessionWritesLostMessage): {
  label: string;
  detail: string;
} {
  const lost = Array.isArray(msg.lost) ? msg.lost.filter((v): v is string => typeof v === "string") : [];
  const what = lost.length > 0 ? lost.map((l) => LOST_LABELS[l] ?? l).join(" and ") : "session data";
  const cause = (msg.error_code && CAUSE_LABELS[msg.error_code]) || "the disk could not be written";
  const ids = Array.isArray(msg.transcript_session_ids)
    ? msg.transcript_session_ids.filter((v): v is string => typeof v === "string")
    : [];
  const resumeNote =
    lost.includes("transcript") || ids.length > 0
      ? " Resuming the session may miss part of the conversation."
      : "";
  return {
    label: `Couldn't save ${what}: ${cause}`,
    detail: `Free up disk space.${resumeNote}`,
  };
}
