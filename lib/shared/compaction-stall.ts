/**
 * CC 2.1.228 — "Compaction progress: retry countdown + stall hint during
 * compaction." The SDK exposes no compaction-progress fraction, so the banner
 * shows honest elapsed time (not a fabricated percentage). Once compaction has
 * run past this threshold with no `compact_boundary` yet, we add a one-line
 * reassurance so a long summarization doesn't read as a hang — the browser
 * analog of the CLI's stall hint. (The retry-countdown half rides the generic
 * `api_retry` → SpinnerTip path already.)
 */
export const COMPACTION_STALL_HINT_SEC = 20;

export function compactionStallHint(elapsedSec: number): string | null {
  if (elapsedSec < COMPACTION_STALL_HINT_SEC) return null;
  return "Still compacting — larger conversations take longer to summarize.";
}
