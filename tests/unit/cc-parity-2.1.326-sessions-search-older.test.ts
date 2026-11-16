import { describe, expect, test } from "vitest";
import {
  nextOlderSearchCeiling,
  OLDER_SEARCH_STEP,
  olderSearchState,
  type OlderSearchInput,
} from "@/lib/shared/session-search-older";
import { SESSION_PAGE_SIZE } from "@/lib/shared/session-pagination";

/**
 * CC 2.1.326 parity — "Fixed /resume search saying \"No sessions match\" for
 * older sessions that exist". The Sessions page only searched loaded pages;
 * these pin the decision that keeps loading older pages before giving up.
 */

const base: OlderSearchInput = {
  query: "quokka",
  matchCount: 0,
  loadedCount: SESSION_PAGE_SIZE,
  hasMore: true,
  loading: false,
  failed: false,
  ceiling: OLDER_SEARCH_STEP,
};

describe("olderSearchState", () => {
  test("no query or a match needs nothing", () => {
    expect(olderSearchState({ ...base, query: "" })).toBe("idle");
    expect(olderSearchState({ ...base, query: "   " })).toBe("idle");
    expect(olderSearchState({ ...base, matchCount: 1 })).toBe("idle");
  });

  test("no match with more on disk loads the next page", () => {
    expect(olderSearchState(base)).toBe("load");
  });

  test("a page in flight is 'searching' and never triggers another load", () => {
    expect(olderSearchState({ ...base, loading: true })).toBe("searching");
  });

  test("the very first load keeps the plain loading behaviour", () => {
    expect(olderSearchState({ ...base, loading: true, loadedCount: 0, hasMore: false })).toBe("idle");
  });

  test("only says no match once everything is loaded", () => {
    expect(olderSearchState({ ...base, hasMore: false })).toBe("none");
    expect(olderSearchState({ ...base, hasMore: false, loadedCount: 37 })).toBe("none");
  });

  test("stops at the ceiling with more possibly older", () => {
    expect(olderSearchState({ ...base, loadedCount: OLDER_SEARCH_STEP })).toBe("capped");
    expect(olderSearchState({ ...base, loadedCount: OLDER_SEARCH_STEP - SESSION_PAGE_SIZE })).toBe("load");
  });

  test("a failed fetch is not reported as no match", () => {
    // The hook grew `limit` but kept the old list, so hasMore reads false.
    expect(olderSearchState({ ...base, hasMore: false, failed: true })).toBe("capped");
    expect(olderSearchState({ ...base, hasMore: false, failed: true, loadedCount: 0 })).toBe("idle");
  });

  test("a match found while loading wins", () => {
    expect(olderSearchState({ ...base, loading: true, matchCount: 2 })).toBe("idle");
  });
});

describe("nextOlderSearchCeiling", () => {
  test("raises the ceiling one step past what is loaded", () => {
    expect(nextOlderSearchCeiling(OLDER_SEARCH_STEP, OLDER_SEARCH_STEP)).toBe(OLDER_SEARCH_STEP * 2);
    expect(nextOlderSearchCeiling(OLDER_SEARCH_STEP, OLDER_SEARCH_STEP + 200)).toBe(
      OLDER_SEARCH_STEP * 2 + 200,
    );
  });
});
