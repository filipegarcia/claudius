import { describe, expect, test } from "vitest";

import {
  IDLE_HISTORY_CURSOR,
  stepPromptHistory,
  type HistoryCursor,
  type HistoryStep,
} from "@/lib/shared/prompt-history";

/**
 * CC 2.1.332 parity — "[VSCode] Fixed a held Up key replacing an unsent
 * message with an earlier prompt, and Down not bringing the message back
 * after the recalled prompt got a new line or was cleared" (and CC 2.1.331's
 * "dropping edits to a recalled prompt"). Editing a recalled prompt no longer
 * ends history browsing, so ↓ still walks back to the unsent draft and the
 * draft is never overwritten.
 */
const HISTORY = ["oldest prompt", "middle prompt", "newest prompt"];

/** Drive the cursor like the composer: each step's text becomes the box's value. */
function walker(history: readonly string[], initial: string) {
  let cursor: HistoryCursor = IDLE_HISTORY_CURSOR;
  let value = initial;
  return {
    step(dir: -1 | 1): HistoryStep {
      const s = stepPromptHistory(history, cursor, value, dir);
      if (s.kind !== "pass") cursor = s.cursor;
      if (s.kind === "show") value = s.text;
      return s;
    },
    edit(next: string) {
      value = next;
    },
    get value() {
      return value;
    },
    get cursor() {
      return cursor;
    },
  };
}

describe("stepPromptHistory (CC 2.1.332)", () => {
  test("↓ brings the draft back after the recalled prompt got a new line", () => {
    const w = walker(HISTORY, "my unsent draft");
    w.step(-1);
    expect(w.value).toBe("newest prompt");
    w.edit("newest prompt\nplus a line");
    const s = w.step(1);
    expect(s).toMatchObject({ kind: "show", draft: true, text: "my unsent draft" });
    expect(w.cursor.idx).toBeNull();
  });

  test("↓ brings the draft back after the recalled prompt was cleared", () => {
    const w = walker(HISTORY, "my unsent draft");
    w.step(-1);
    w.edit("");
    w.step(1);
    expect(w.value).toBe("my unsent draft");
  });

  test("↑ after an edit walks on without overwriting the stashed draft", () => {
    const w = walker(HISTORY, "my unsent draft");
    w.step(-1);
    w.edit("newest prompt, edited");
    w.step(-1);
    expect(w.value).toBe("middle prompt");
    w.step(1);
    // The edit is kept when walking back over the entry …
    expect(w.value).toBe("newest prompt, edited");
    w.step(1);
    // … and the original draft is still there past the newest entry.
    expect(w.value).toBe("my unsent draft");
  });

  test("an edit survives a round trip to the draft until the prompt is sent", () => {
    const w = walker(HISTORY, "draft");
    w.step(-1);
    w.edit("newest prompt v2");
    w.step(1);
    expect(w.value).toBe("draft");
    w.step(-1);
    expect(w.value).toBe("newest prompt v2");
  });

  test("reverting an edit drops it", () => {
    const w = walker(HISTORY, "draft");
    w.step(-1);
    w.edit("changed");
    w.step(-1);
    w.step(1);
    w.edit("newest prompt");
    w.step(-1);
    expect(w.cursor.edits.size).toBe(0);
  });

  test("↓ on the live draft, or ↑ at the oldest entry, behave as before", () => {
    const w = walker(HISTORY, "draft");
    expect(w.step(1)).toEqual({ kind: "pass" });
    w.step(-1);
    w.step(-1);
    w.step(-1);
    expect(w.value).toBe("oldest prompt");
    expect(w.step(-1).kind).toBe("stay");
    expect(w.value).toBe("oldest prompt");
  });

  test("CC 2.1.295 — a draft equal to the newest entry starts one further back", () => {
    const w = walker(HISTORY, "newest prompt");
    w.step(-1);
    expect(w.value).toBe("middle prompt");
  });

  test("no history: nothing to recall, but a browse in progress can still return to its draft", () => {
    expect(stepPromptHistory([], IDLE_HISTORY_CURSOR, "x", -1)).toEqual({ kind: "pass" });
    const browsing: HistoryCursor = { idx: 1, stash: "kept draft", edits: new Map() };
    expect(stepPromptHistory([], browsing, "y", 1)).toMatchObject({ kind: "show", draft: true, text: "kept draft" });
  });
});
