import { describe, expect, test } from "vitest";

import { arrowOutOfOther, enterPickLabel } from "@/lib/client/question-keys";

/**
 * CC 2.1.330 — "[VSCode] Fixed Enter on a question card sending your earlier
 * answer instead of picking the focused one, and arrow keys not working after
 * an 'Other' answer; answered questions reopen on your pick".
 *
 * In Claudius's reopened-question modal, Enter submitted the earlier pick
 * whatever the highlight was on (and did nothing with nothing picked), and
 * once focus was in Other's textarea the arrow keys never reached the options
 * again. The DOM half is in tests/e2e/cc-parity-2.1.330-question-enter-arrows.spec.ts.
 */

const OPTIONS = [{ label: "Vitest" }, { label: "Jest" }, { label: "Mocha" }];

describe("enterPickLabel", () => {
  test("picks the highlighted option over the earlier pick", () => {
    expect(
      enterPickLabel({ multiSelect: false, options: OPTIONS, highlighted: 2, selectedLabels: ["Vitest"], showOther: false }),
    ).toBe("Mocha");
  });

  test("picks the highlighted option when nothing is picked yet", () => {
    expect(
      enterPickLabel({ multiSelect: false, options: OPTIONS, highlighted: 1, selectedLabels: [], showOther: false }),
    ).toBe("Jest");
  });

  test("nothing to pick when the highlight is already the pick", () => {
    expect(
      enterPickLabel({ multiSelect: false, options: OPTIONS, highlighted: 0, selectedLabels: ["Vitest"], showOther: false }),
    ).toBeNull();
  });

  test("a highlighted option replaces an Other answer", () => {
    expect(
      enterPickLabel({ multiSelect: false, options: OPTIONS, highlighted: 0, selectedLabels: [], showOther: true }),
    ).toBe("Vitest");
  });

  test("multi-select keeps Enter as submit only", () => {
    expect(
      enterPickLabel({ multiSelect: true, options: OPTIONS, highlighted: 1, selectedLabels: ["Vitest"], showOther: false }),
    ).toBeNull();
  });
});

describe("arrowOutOfOther", () => {
  const key = (k: string, mods: Partial<Record<"shiftKey" | "altKey" | "ctrlKey" | "metaKey", boolean>> = {}) => ({
    key: k,
    shiftKey: false,
    altKey: false,
    ctrlKey: false,
    metaKey: false,
    ...mods,
  });
  const field = (value: string, start: number, end = start) => ({ value, selectionStart: start, selectionEnd: end });

  test("either arrow leaves an empty textarea", () => {
    expect(arrowOutOfOther(key("ArrowUp"), field("", 0))).toBe("up");
    expect(arrowOutOfOther(key("ArrowDown"), field("", 0))).toBe("down");
  });

  test("ArrowUp leaves from the very start, ArrowDown from the very end", () => {
    expect(arrowOutOfOther(key("ArrowUp"), field("both\nplease", 0))).toBe("up");
    expect(arrowOutOfOther(key("ArrowDown"), field("both\nplease", 11))).toBe("down");
  });

  test("inside the text the arrows stay the textarea's", () => {
    expect(arrowOutOfOther(key("ArrowUp"), field("both\nplease", 7))).toBeNull();
    expect(arrowOutOfOther(key("ArrowDown"), field("both\nplease", 2))).toBeNull();
    expect(arrowOutOfOther(key("ArrowUp"), field("both", 4))).toBeNull();
  });

  test("a selection or a modifier stays the textarea's", () => {
    expect(arrowOutOfOther(key("ArrowUp"), field("both", 0, 4))).toBeNull();
    expect(arrowOutOfOther(key("ArrowUp", { shiftKey: true }), field("both", 0))).toBeNull();
    expect(arrowOutOfOther(key("ArrowDown", { metaKey: true }), field("", 0))).toBeNull();
  });

  test("other keys are ignored", () => {
    expect(arrowOutOfOther(key("ArrowLeft"), field("", 0))).toBeNull();
    expect(arrowOutOfOther(key("Enter"), field("", 0))).toBeNull();
  });
});
