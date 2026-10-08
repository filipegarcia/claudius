import { describe, expect, test } from "vitest";
import {
  buildPromptHistory,
  historyEntryIndex,
  normalizeHistoryText,
} from "@/lib/shared/prompt-history";

/**
 * CC 2.1.295 parity — a queued message pulled back into the composer (Edit)
 * stays recallable from prompt history, so lifting A then B no longer loses A.
 */
describe("normalizeHistoryText", () => {
  test("strips image tokens, collapses spaces, trims", () => {
    expect(normalizeHistoryText("  look at [Image #1] this  ")).toBe("look at this");
    expect(normalizeHistoryText("[Image #2]")).toBe("");
  });
});

describe("buildPromptHistory (CC 2.1.295)", () => {
  test("sent prompts only — same behaviour as before", () => {
    expect(
      buildPromptHistory([{ text: "a" }, { text: "a" }, { text: " " }, { text: "b [Image #1]" }]),
    ).toEqual(["a", "b"]);
  });

  test("lifted texts land after older sent prompts, in lift order", () => {
    expect(
      buildPromptHistory(
        [{ text: "sent 1", at: 10 }],
        [
          { text: "lifted B", at: 30 },
          { text: "lifted A", at: 20 },
        ],
      ),
    ).toEqual(["sent 1", "lifted A", "lifted B"]);
  });

  test("a lift is slotted before prompts sent after it", () => {
    expect(
      buildPromptHistory(
        [
          { text: "first", at: 10 },
          { text: "edited A", at: 40 },
        ],
        [{ text: "A", at: 20 }],
      ),
    ).toEqual(["first", "A", "edited A"]);
  });

  test("re-sending the lifted text unchanged collapses to one entry", () => {
    expect(
      buildPromptHistory(
        [
          { text: "x", at: 1 },
          { text: "A", at: 50 },
        ],
        [{ text: "A", at: 20 }],
      ),
    ).toEqual(["x", "A"]);
  });

  test("sent prompts without a timestamp never pull a lift ahead of them", () => {
    expect(
      buildPromptHistory([{ text: "old" }, { text: "older-undated" }], [{ text: "A", at: 5 }]),
    ).toEqual(["old", "older-undated", "A"]);
  });

  test("empty lifts are dropped", () => {
    expect(buildPromptHistory([], [{ text: "   ", at: 1 }])).toEqual([]);
  });
});

describe("historyEntryIndex (CC 2.1.295)", () => {
  test("nothing to recall", () => {
    expect(historyEntryIndex([], "x")).toBeNull();
  });
  test("starts at the newest entry by default", () => {
    expect(historyEntryIndex(["a", "b"], "")).toBe(1);
    expect(historyEntryIndex(["a", "b"], "typing")).toBe(1);
  });
  test("skips the newest entry when the composer already holds it", () => {
    expect(historyEntryIndex(["A", "B"], "B")).toBe(0);
    expect(historyEntryIndex(["A", "B"], "B  ")).toBe(0);
  });
  test("a single entry equal to the draft is still returned", () => {
    expect(historyEntryIndex(["B"], "B")).toBe(0);
  });
});
