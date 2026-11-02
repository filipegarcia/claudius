import { describe, expect, test } from "vitest";

import { transcriptPlaceholder } from "@/lib/shared/transcript-placeholder";

/**
 * CC 2.1.316 — "[Cloud sessions] Added a 'Catching up…' line that shows while
 * a cloud or Remote Control session you switch back to is still bringing its
 * messages up to date". An empty transcript is "catching up" while a
 * switched-to / resumed session replays, and the new-session splash otherwise.
 */
describe("transcriptPlaceholder", () => {
  test("an empty transcript still replaying an existing session is catching up", () => {
    expect(transcriptPlaceholder({ isEmpty: true, hasMoreAbove: false, catchingUp: true })).toBe(
      "catching-up",
    );
  });

  test("an empty transcript that isn't catching up is a brand-new session → splash", () => {
    expect(transcriptPlaceholder({ isEmpty: true, hasMoreAbove: false, catchingUp: false })).toBe(
      "splash",
    );
  });

  test("any messages, or older history to page in, renders the list", () => {
    expect(transcriptPlaceholder({ isEmpty: false, hasMoreAbove: false, catchingUp: true })).toBe("list");
    expect(transcriptPlaceholder({ isEmpty: false, hasMoreAbove: false, catchingUp: false })).toBe("list");
    expect(transcriptPlaceholder({ isEmpty: true, hasMoreAbove: true, catchingUp: true })).toBe("list");
    expect(transcriptPlaceholder({ isEmpty: true, hasMoreAbove: true, catchingUp: false })).toBe("list");
  });
});
