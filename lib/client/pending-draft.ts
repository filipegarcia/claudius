/**
 * CC 2.1.299 parity — "[VSCode] Fixed an unsent prompt and its attachments
 * being lost when switching to another session and back".
 *
 * The composer (`components/chat/PromptInput.tsx`) debounce-saves its draft
 * to `PUT /api/sessions/<id>/prompt-draft` 500ms after the last edit. A
 * session switch (or unmount) inside that window used to cancel the timer and
 * drop the edit on the floor — the next run of the save effect bails on the
 * "not seeded yet" guard for the new session, so nobody ever wrote it.
 *
 * Now the save effect records the latest unsaved draft here, keyed to the
 * session it belongs to, and a session-change / unmount / pagehide cleanup
 * flushes it straight to that session's endpoint. Pure helpers (plus a thin
 * ref-taking flush) so the request shape is unit-testable without React.
 */

/** Minimal image shape the draft endpoint stores — matches `AttachedImage`. */
export type PendingDraftImage = {
  id: string;
  ordinal: number;
  data: string;
  mediaType: string;
};

/** The newest composer state not yet PUT to its session's draft row. */
export type PendingDraft = {
  sessionId: string;
  text: string;
  images: PendingDraftImage[];
};

/**
 * Fetch's `keepalive` budget is 64KiB, shared by every keepalive request in
 * flight for the document. A body over it makes the fetch reject outright, so
 * only small drafts (text, no pasted screenshots) ride on keepalive; leave
 * headroom for the headers and any sibling request.
 */
export const KEEPALIVE_BODY_LIMIT = 60 * 1024;

/** UTF-8 byte length — the unit the keepalive quota is measured in. */
export function utf8ByteLength(s: string): number {
  return new TextEncoder().encode(s).length;
}

/**
 * Build the PUT that persists `pending` to its own session's draft row, or
 * null when there's nothing to flush. `unloading` is true when the page (or
 * the composer) is going away — then the request asks for `keepalive` so it
 * survives the teardown, but only when the body fits the quota. An image
 * draft over the cap goes out as a plain fetch: it may not survive a hard
 * unload, but a keepalive one would be rejected before it was even sent.
 */
export function buildDraftFlushRequest(
  pending: PendingDraft | null,
  opts: { unloading: boolean },
): { url: string; init: RequestInit } | null {
  if (!pending || !pending.sessionId) return null;
  const body = JSON.stringify({ text: pending.text, images: pending.images });
  const keepalive = opts.unloading && utf8ByteLength(body) <= KEEPALIVE_BODY_LIMIT;
  return {
    url: `/api/sessions/${pending.sessionId}/prompt-draft`,
    init: {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body,
      ...(keepalive ? { keepalive: true } : {}),
    },
  };
}

/**
 * Flush and clear the pending draft held in `ref`. Takes the ref object (not
 * its `.current`) so effect cleanups can call it without reading a ref value
 * that will have changed by the time the cleanup runs. Best-effort — a failed
 * flush leaves the user with the in-memory composer, same as a failed
 * debounced save.
 */
export function flushPendingDraft(
  ref: { current: PendingDraft | null },
  opts: { unloading: boolean },
  doFetch: (url: string, init: RequestInit) => Promise<unknown> = (url, init) => fetch(url, init),
): boolean {
  const req = buildDraftFlushRequest(ref.current, opts);
  ref.current = null;
  if (!req) return false;
  // Dispatched synchronously — on pagehide there's no later tick to wait for.
  try {
    void Promise.resolve(doFetch(req.url, req.init)).catch(() => {
      // best-effort
    });
  } catch {
    // best-effort
  }
  return true;
}
