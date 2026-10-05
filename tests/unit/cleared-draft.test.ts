import { describe, expect, test } from "vitest";
import { canRestoreClearedDraft, shouldStashClearedDraft } from "@/lib/client/cleared-draft";

/**
 * CC 2.1.288 (D5) — Ctrl+C / double-Esc stashes a non-empty draft; plain ↑ on
 * an empty composer (nothing else claiming the key) restores it.
 */
describe("shouldStashClearedDraft (CC 2.1.288 — D5)", () => {
  test("stashes when there's text or an image", () => {
    expect(shouldStashClearedDraft("hi", 0)).toBe(true);
    expect(shouldStashClearedDraft("", 2)).toBe(true);
  });
  test("does not stash an already-empty composer", () => {
    expect(shouldStashClearedDraft("", 0)).toBe(false);
  });
});

describe("canRestoreClearedDraft (CC 2.1.288 — D5)", () => {
  const base = {
    value: "",
    imageCount: 0,
    pickerOpen: false,
    atActive: false,
    emojiActive: false,
    browsingHistory: false,
    hasStash: true,
  };

  test("restores on a clean empty composer with a stash", () => {
    expect(canRestoreClearedDraft(base)).toBe(true);
  });

  test("never restores when there is nothing stashed", () => {
    expect(canRestoreClearedDraft({ ...base, hasStash: false })).toBe(false);
  });

  test("does not hijack ↑ when the composer isn't empty", () => {
    expect(canRestoreClearedDraft({ ...base, value: "typing" })).toBe(false);
    expect(canRestoreClearedDraft({ ...base, imageCount: 1 })).toBe(false);
  });

  test("defers to pickers and history recall", () => {
    expect(canRestoreClearedDraft({ ...base, pickerOpen: true })).toBe(false);
    expect(canRestoreClearedDraft({ ...base, atActive: true })).toBe(false);
    expect(canRestoreClearedDraft({ ...base, emojiActive: true })).toBe(false);
    expect(canRestoreClearedDraft({ ...base, browsingHistory: true })).toBe(false);
  });
});
