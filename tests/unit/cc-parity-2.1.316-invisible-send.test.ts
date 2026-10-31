/**
 * CC 2.1.316 parity — "Fixed prompts containing invisible characters needing
 * a second Enter to send; plain prompts now send cleaned on the first Enter,
 * and commands still wait for review".
 *
 * Pins the pure pieces `PromptInput.submit()` uses: the bidi count from
 * `stripInvisibleUnicode`, the hold-for-review rule, and carrying paste
 * ranges over to the cleaned text.
 */
import { describe, expect, it } from "vitest";
import {
  invisibleStripNeedsReview,
  rebaseRangesThroughStrip,
  stripInvisibleUnicode,
} from "@/lib/shared/invisible-unicode";

const ZWSP = "\u{200B}";
const RLO = "\u{202E}";
const LRI = "\u{2066}";
const TAG_A = "\u{E0041}";

function needsReview(raw: string, opts?: { hasAttachments?: boolean }): boolean {
  const { cleaned, bidiCount } = stripInvisibleUnicode(raw);
  return invisibleStripNeedsReview(cleaned, bidiCount, opts);
}

describe("stripInvisibleUnicode bidiCount (CC 2.1.316)", () => {
  it("counts only bidi controls among the removed characters", () => {
    const r = stripInvisibleUnicode(`a${ZWSP}b${RLO}c${LRI}d${TAG_A}`);
    expect(r.cleaned).toBe("abcd");
    expect(r.removedCount).toBe(4);
    expect(r.bidiCount).toBe(2);
  });

  it("is zero for zero-width-only and clean text", () => {
    expect(stripInvisibleUnicode(`hi${ZWSP}there`).bidiCount).toBe(0);
    expect(stripInvisibleUnicode("plain").bidiCount).toBe(0);
  });
});

describe("invisibleStripNeedsReview (CC 2.1.316)", () => {
  it("sends a plain prompt that only had a zero-width space", () => {
    expect(needsReview(`Please run tests${ZWSP} and report back`)).toBe(false);
    expect(needsReview(`summarize this${TAG_A}`)).toBe(false);
  });

  it("holds a prompt that had a bidi control removed", () => {
    expect(needsReview(`Please review ${RLO}gnp.exe`)).toBe(true);
    expect(needsReview(`isolate ${LRI}text`)).toBe(true);
  });

  it("holds slash commands, even after leading whitespace", () => {
    expect(needsReview(`/compact${ZWSP}`)).toBe(true);
    expect(needsReview(`  /review${ZWSP} the diff`)).toBe(true);
    expect(needsReview(`/exit${ZWSP}`)).toBe(true);
  });

  it("holds a `!` command that reached submit() without starting the raw value", () => {
    // A raw value starting with `!` never gets here — PromptInput routes it
    // to submitBash(), which keeps its 2.1.280 strip-and-run. Only a `!`
    // behind leading whitespace or a leading invisible character does.
    expect(needsReview(` !ls${ZWSP}`)).toBe(true);
    expect(needsReview(`${ZWSP}!ls`)).toBe(true);
  });

  it("sends bare exit-like words cleaned — Claudius has no bare-word exit commands", () => {
    for (const word of ["exit", "quit", ":q", ":q!", ":wq", ":wq!"]) {
      expect(needsReview(`${word}${ZWSP}`)).toBe(false);
    }
  });

  it("holds a prompt that was nothing but invisible characters (empty once cleaned)", () => {
    expect(needsReview(`${ZWSP}${ZWSP}`)).toBe(true);
    expect(needsReview(` ${ZWSP}\n`)).toBe(true);
    expect(needsReview(`${ZWSP}`, { hasAttachments: false })).toBe(true);
  });

  it("sends an attached image whose text was only invisible characters, as an image-only send does", () => {
    expect(needsReview(`${ZWSP}${ZWSP}`, { hasAttachments: true })).toBe(false);
    expect(needsReview(` ${ZWSP}\n`, { hasAttachments: true })).toBe(false);
    // An attachment doesn't excuse a bidi control or a command.
    expect(needsReview(`${RLO}`, { hasAttachments: true })).toBe(true);
    expect(needsReview(`look ${RLO}here`, { hasAttachments: true })).toBe(true);
    expect(needsReview(`/compact${ZWSP}`, { hasAttachments: true })).toBe(true);
  });
});

describe("rebaseRangesThroughStrip (CC 2.1.316)", () => {
  it("shifts a range that sits after a removed character", () => {
    const raw = `ab${ZWSP}PASTE`;
    const [r] = rebaseRangesThroughStrip([{ start: 3, end: 8 }], raw);
    const cleaned = stripInvisibleUnicode(raw).cleaned;
    expect(cleaned.slice(r.start, r.end)).toBe("PASTE");
  });

  it("shrinks a range that straddles a removed character", () => {
    const raw = `x PA${ZWSP}STE y`;
    const [r] = rebaseRangesThroughStrip([{ start: 2, end: 8 }], raw);
    const cleaned = stripInvisibleUnicode(raw).cleaned;
    expect(cleaned.slice(r.start, r.end)).toBe("PASTE");
  });

  it("handles astral (two code unit) tag characters", () => {
    const raw = `${TAG_A}${TAG_A}PASTE`;
    const [r] = rebaseRangesThroughStrip([{ start: 4, end: 9 }], raw);
    expect(r).toEqual({ start: 0, end: 5 });
  });

  it("drops a range that was only invisible characters, and is a no-op on clean text", () => {
    expect(rebaseRangesThroughStrip([{ start: 1, end: 2 }], `a${ZWSP}b`)).toEqual([]);
    const ranges = [{ start: 0, end: 3 }];
    expect(rebaseRangesThroughStrip(ranges, "abc")).toBe(ranges);
  });
});
