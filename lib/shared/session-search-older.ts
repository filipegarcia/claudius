/**
 * CC 2.1.326 parity — "Fixed /resume search saying \"No sessions match\" for
 * older sessions that exist".
 *
 * The Sessions page (what `/resume` with no args opens) only searches the
 * pages `useSessionsHistory` has already fetched, so a query matching only an
 * older session said "No sessions match." while a "Load more" was still
 * available. This decides what the empty state should do instead: keep
 * loading older pages (bounded by a loaded-count ceiling the user can raise),
 * show a "searching" line while a page is in flight, and only claim "no
 * match" once every session has been loaded.
 *
 * Pure so the decision is unit-testable without the fetch/React hook.
 */

import { SESSION_PAGE_SIZE } from "./session-pagination";

/** How many sessions a no-match search auto-loads before asking to go on. */
export const OLDER_SEARCH_STEP = SESSION_PAGE_SIZE * 5;

export type OlderSearchState =
  /** Nothing special: no query, matches found, or the initial load. */
  | "idle"
  /** Fetch the next page now (nothing in flight, more exist, under the cap). */
  | "load"
  /** A page is in flight while the query still has no match. */
  | "searching"
  /** Stopped (cap reached or a fetch failed) with more possibly on disk. */
  | "capped"
  /** Everything is loaded and nothing matches. */
  | "none";

export type OlderSearchInput = {
  /** Parsed query text (after stripping a leading `n:`). */
  query: string;
  /** Rows the current query + filters match among the loaded sessions. */
  matchCount: number;
  /** Raw count of loaded sessions (before any client-side cwd filter). */
  loadedCount: number;
  hasMore: boolean;
  /** A sessions fetch (or another search the result depends on) is in flight. */
  loading: boolean;
  /** The last sessions fetch failed. */
  failed?: boolean;
  /** Stop auto-loading once this many sessions are loaded. */
  ceiling: number;
};

export function olderSearchState(i: OlderSearchInput): OlderSearchState {
  if (!i.query.trim() || i.matchCount > 0) return "idle";
  if (i.loading) return i.loadedCount > 0 ? "searching" : "idle";
  // A failed fetch leaves `hasMore` false (the hook grew `limit` but kept the
  // old list) — don't turn that into a false "no match".
  if (i.failed) return i.loadedCount > 0 ? "capped" : "idle";
  if (!i.hasMore) return "none";
  if (i.loadedCount >= i.ceiling) return "capped";
  return "load";
}

/** The ceiling after the user asks to search further back. */
export function nextOlderSearchCeiling(ceiling: number, loadedCount: number): number {
  return Math.max(ceiling, loadedCount) + OLDER_SEARCH_STEP;
}
