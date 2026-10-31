/**
 * CC 2.1.316 parity — "[Cloud sessions] Added a 'Catching up…' line that
 * shows while a cloud or Remote Control session you switch back to is still
 * bringing its messages up to date".
 *
 * Claudius's copy: switching back to a session (or booting into one via
 * `?session=`) clears the transcript, awaits the resume POST, then replays
 * history over SSE. In that window the transcript was empty with nothing
 * older to page in, so `MessageList` showed the brand-new-session splash and
 * a session with history looked blank. `catchingUp` (set by `use-session`
 * until `replay_done`) now swaps the splash for a "Catching up…" line.
 */
export type TranscriptPlaceholder = "catching-up" | "splash" | "list";

export function transcriptPlaceholder({
  isEmpty,
  hasMoreAbove,
  catchingUp,
}: {
  isEmpty: boolean;
  hasMoreAbove: boolean;
  catchingUp: boolean;
}): TranscriptPlaceholder {
  if (!isEmpty || hasMoreAbove) return "list";
  return catchingUp ? "catching-up" : "splash";
}
