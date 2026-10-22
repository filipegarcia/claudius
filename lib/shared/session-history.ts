/**
 * CC 2.1.309 parity — Claude Code stopped filling session history with empty
 * "Untitled" sessions each time a new session was started and abandoned
 * without a message.
 *
 * Claudius has the same shape: `Session.start()` upserts a sessions-index row
 * as soon as the session is bound (so a rename before the first turn has
 * somewhere to live), and `/api/sessions/all` synthesizes a history entry for
 * every index row the SDK didn't list because it has no JSONL yet. Without a
 * filter, every new tab / `/clear` that was closed unused shows up as
 * "(untitled)" on `/sessions` and in the session picker.
 *
 * A DB-only row is worth listing when it has a title — the user named it, and
 * that rename is exactly what the fan-out exists to surface — or when the
 * session is still live (the user's currently-open empty tab must stay
 * reachable from the picker).
 */
export function isHistoryWorthyDbRow(
  row: { id: string; title: string | null },
  isLive: (id: string) => boolean,
): boolean {
  if (row.title && row.title.trim()) return true;
  return isLive(row.id);
}
