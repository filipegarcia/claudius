/**
 * CC 2.1.299 parity — "[Remote Control] Fixed Remote Control sessions whose
 * computer can't be reached still appearing to send your messages; your text
 * now stays in the box and Send is off until it reconnects".
 *
 * The composer (`components/chat/PromptInput.tsx`) clears itself the moment
 * Send is pressed — a fast follow-up keystroke must not land in the message
 * that just left. When the parent later reports the message never reached
 * the server, the composer puts it back. Pure helpers so the decision table
 * is unit-testable without React.
 */

/** Inline footer hint shown when an undelivered message is put back. */
export const SEND_FAILED_RESTORED_NOTICE = "Couldn't reach Claudius — your message is back in the box.";
/** Variant when the user already started a new message: ↑ brings it back. */
export const SEND_FAILED_STASHED_NOTICE =
  "Couldn't reach Claudius — your message wasn't sent. Clear the box and press ↑ to get it back.";

/**
 * Normalize whatever the composer's `onSend` returned into a delivery
 * outcome. Backwards compatible: `undefined` (every pre-existing caller, and
 * paths that handle the text locally) and `true` mean delivered; only an
 * explicit `false` — or a promise resolving to `false` / rejecting — means
 * the message didn't make it. Synchronous results stay synchronous so the
 * common path does no extra work.
 */
export function sendOutcome(ret: unknown): boolean | Promise<boolean> {
  if (ret != null && typeof (ret as { then?: unknown }).then === "function") {
    return Promise.resolve(ret as PromiseLike<unknown>).then(
      (v) => v !== false,
      () => false,
    );
  }
  return ret !== false;
}

/**
 * Where an undelivered message goes, given the composer's state by the time
 * the failure is known (the POST can take a while to fail):
 *  - `"restore"` — same session, empty composer: put text + images back.
 *  - `"stash"` — same session, but the user already typed something new:
 *    don't clobber it; park the message in the cleared-draft slot so ↑ on an
 *    empty composer restores it (CC 2.1.288's mechanism).
 *  - `"save-to-origin"` — the user switched sessions meanwhile: write it as
 *    the ORIGINAL session's draft so it's in the box when they go back,
 *    rather than dropping it into an unrelated tab.
 */
export type FailedSendPlacement = "restore" | "stash" | "save-to-origin";

export function placeFailedSend(s: {
  originSessionId: string | null;
  currentSessionId: string | null;
  currentText: string;
  currentImageCount: number;
}): FailedSendPlacement {
  if (s.originSessionId && s.originSessionId !== s.currentSessionId) return "save-to-origin";
  if (s.currentText === "" && s.currentImageCount === 0) return "restore";
  return "stash";
}
