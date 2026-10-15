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

/**
 * Delivery outcome the composer works with — the same shape as
 * `SendResult` (`lib/client/types.ts`). `error` is `"network"` when the
 * server couldn't be reached at all, `"http <status>"` / `"no session"` when
 * it was reached (or never addressed) but didn't take the message, and
 * `"unknown"` when the parent only said "not delivered".
 */
export type SendDelivery = { ok: true } | { ok: false; error: string };

const DELIVERED: SendDelivery = { ok: true };
const UNDELIVERED: SendDelivery = { ok: false, error: "unknown" };

function toDelivery(v: unknown): SendDelivery {
  if (v === false) return UNDELIVERED;
  if (v != null && typeof v === "object" && "ok" in v) {
    const r = v as { ok: unknown; error?: unknown };
    if (r.ok !== false) return DELIVERED;
    return { ok: false, error: typeof r.error === "string" && r.error ? r.error : "unknown" };
  }
  return DELIVERED;
}

/**
 * Normalize whatever the composer's `onSend` returned into a delivery
 * outcome. Backwards compatible: `undefined` (every pre-existing caller, and
 * paths that handle the text locally) and `true` mean delivered; an explicit
 * `false` — or a promise resolving to `false` / rejecting — means the
 * message didn't make it, for an unknown reason. A `SendResult`
 * (`{ ok, error }`) passes its reason through so the hint can say *why*.
 * Synchronous results stay synchronous so the common path does no extra work.
 */
export function sendOutcome(ret: unknown): SendDelivery | Promise<SendDelivery> {
  if (ret != null && typeof (ret as { then?: unknown }).then === "function") {
    return Promise.resolve(ret as PromiseLike<unknown>).then(toDelivery, () => UNDELIVERED);
  }
  return toDelivery(ret);
}

/**
 * Inline footer hint shown when an undelivered message is put back
 * (`"restore"`) or parked for ↑ because the user already started a new one
 * (`"stash"`). "Couldn't reach Claudius" only when the server really was
 * unreachable — a 4xx/5xx or an unbound composer gets neutral copy, since
 * the server *was* reached and blaming the connection would mislead.
 */
export function sendFailedNotice(error: string, placement: "restore" | "stash"): string {
  if (error === "network") {
    return placement === "restore"
      ? "Couldn't reach Claudius — your message is back in the box."
      : "Couldn't reach Claudius — your message wasn't sent. Press ↑ in an empty box to get it back.";
  }
  return placement === "restore"
    ? "Message not sent — it's back in the box."
    : "Message not sent — press ↑ in an empty box to get it back.";
}

/**
 * Where an undelivered message goes, given the composer's state by the time
 * the failure is known (the POST can take a while to fail):
 *  - `"restore"` — same session, empty composer: put text + images back.
 *  - `"stash"` — same session, but the user already typed something new:
 *    don't clobber it; park the message in its own failed-send slot so ↑ on
 *    an empty composer restores it (CC 2.1.288's mechanism). Separate from
 *    the Ctrl+C / double-Esc cleared-draft slot, so clearing the box to
 *    follow the hint can't overwrite the undelivered message.
 *  - `"save-to-origin"` — the user switched sessions meanwhile: write it as
 *    the ORIGINAL session's draft so it's in the box when they go back,
 *    rather than dropping it into an unrelated tab (appended to whatever
 *    draft that session already has — see `mergeIntoDraft`).
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

const IMAGE_TOKEN_RE = /\[Image #(\d+)\]/g;

/**
 * Append an undelivered message to a session's existing draft (the
 * `"save-to-origin"` case) instead of overwriting it — the user may have
 * typed something new there before switching away. The sent message's images
 * are renumbered past the draft's highest ordinal, and its `[Image #N]`
 * tokens rewritten to match, so both halves keep pointing at their own
 * images. An empty draft just becomes the sent message.
 */
export function mergeIntoDraft<I extends { ordinal: number }>(
  current: { text: string; images: I[] },
  sent: { text: string; images: I[] },
): { text: string; images: I[] } {
  if (current.text === "" && current.images.length === 0) return sent;
  let offset = current.images.reduce((m, im) => Math.max(m, im.ordinal), 0);
  for (const m of current.text.matchAll(IMAGE_TOKEN_RE)) offset = Math.max(offset, Number(m[1]));
  const sentOrdinals = new Set(sent.images.map((im) => im.ordinal));
  const text =
    offset === 0
      ? sent.text
      : sent.text.replace(IMAGE_TOKEN_RE, (tok, n: string) =>
          sentOrdinals.has(Number(n)) ? `[Image #${Number(n) + offset}]` : tok,
        );
  return {
    text: current.text ? `${current.text}\n${text}` : text,
    images: [...current.images, ...sent.images.map((im) => ({ ...im, ordinal: im.ordinal + offset }))],
  };
}
