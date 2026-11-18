/**
 * CC 2.1.288 — "Ctrl+C-cleared prompt: Up on an empty prompt restores the
 * draft (text + pasted images)." Ctrl+C (when idle) and double-Esc both wipe
 * the composer; this stashes what was there so a plain ↑ on the now-empty
 * composer can bring it back, the browser analogue of the CLI's draft
 * recovery. Pure predicates so the keyboard logic stays unit-testable.
 */

import type { PasteRange } from "@/lib/shared/large-paste";

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

/*
 * CC 2.1.326 parity — "Fixed pasted text and images being dropped when ↑
 * recalls a draft cleared with Esc Esc". The stash held only text + images,
 * so ↑ put the paste back as if it had been typed (its `inline_pastes`
 * marking lost), and the image-ordinal counter — zeroed by the clear — wasn't
 * raised past the restored images, so the next attach reused `#1` and
 * removing either image stripped both tokens. The stash now carries the paste
 * ranges, and the restore lifts the counter past every restored ordinal.
 */

/** What a clear wipes and ↑ brings back. */
export type ClearedDraft<I extends { ordinal: number }> = {
  text: string;
  images: I[];
  pasteRanges: PasteRange[];
};

/** Snapshot the composer for ↑-restore; ranges are copied so the stash can't alias live state. */
export function stashClearedDraft<I extends { ordinal: number }>(
  text: string,
  images: I[],
  pasteRanges: PasteRange[],
): ClearedDraft<I> {
  return { text, images, pasteRanges: pasteRanges.map((r) => ({ ...r })) };
}

/** The image-ordinal counter after restoring `images`: past every restored `#N`. */
export function ordinalFloorAfterRestore(counter: number, images: { ordinal: number }[]): number {
  return images.reduce((m, im) => Math.max(m, im.ordinal), counter);
}
