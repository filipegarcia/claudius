/**
 * CC 2.1.243 (H9) — the session list capped at 200 with no way to see older
 * sessions. The `/api/sessions/all` route already honors a `limit` query
 * param; the client now grows it via "Load more". This pins the "is there
 * probably more to load?" rule: a full page back (returned === requested)
 * means the cap was hit, so more likely exist.
 *
 * Pure so it's unit-testable without the fetch/React hook.
 */

export const SESSION_PAGE_SIZE = 200;

/** True when the last fetch returned a full page, so another page may exist. */
export function hasMoreSessions(returnedCount: number, requestedLimit: number): boolean {
  return requestedLimit > 0 && returnedCount >= requestedLimit;
}
