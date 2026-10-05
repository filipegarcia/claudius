/**
 * CC 2.1.288 — "Ctrl+C-cleared prompt: Up on an empty prompt restores the
 * draft (text + pasted images)." Ctrl+C (when idle) and double-Esc both wipe
 * the composer; this stashes what was there so a plain ↑ on the now-empty
 * composer can bring it back, the browser analogue of the CLI's draft
 * recovery. Pure predicates so the keyboard logic stays unit-testable.
 */

/** Only stash a draft worth restoring — a non-empty composer. */
export function shouldStashClearedDraft(text: string, imageCount: number): boolean {
  return text !== "" || imageCount > 0;
}

/**
 * Plain ↑ restores the cleared draft only on an empty composer with nothing
 * else claiming the key: no picker open, not browsing history, and a stash to
 * restore. Otherwise ↑ is ordinary caret movement / history recall.
 */
export function canRestoreClearedDraft(s: {
  value: string;
  imageCount: number;
  pickerOpen: boolean;
  atActive: boolean;
  emojiActive: boolean;
  browsingHistory: boolean;
  hasStash: boolean;
}): boolean {
  return (
    s.value === "" &&
    s.imageCount === 0 &&
    !s.pickerOpen &&
    !s.atActive &&
    !s.emojiActive &&
    !s.browsingHistory &&
    s.hasStash
  );
}
