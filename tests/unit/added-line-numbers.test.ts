import { describe, expect, test } from "vitest";
import {
  addedLineNumbers,
  buildLineMap,
  removedByNewLine,
  removedLineNumbers,
} from "@/components/git/FileEditor";

/**
 * The parser drives the stripe positions in the diff-aware editor — if it
 * returns wrong line numbers the green bars land on the wrong rows. Tests
 * pin the four shapes of input we actually see from `git diff`:
 *
 *   - Single hunk with mixed +/-/ context
 *   - Multiple hunks (rightLine must reset from each header)
 *   - Untracked file → /dev/null diff with every body line `+`
 *   - Empty / no-diff input → empty set
 */
describe("addedLineNumbers", () => {
  test("returns an empty set for empty input", () => {
    expect(addedLineNumbers("")).toEqual(new Set());
  });

  test("picks out + lines and advances on context, skips - lines", () => {
    const diff = [
      "diff --git a/foo.txt b/foo.txt",
      "index abc..def 100644",
      "--- a/foo.txt",
      "+++ b/foo.txt",
      "@@ -1,4 +1,5 @@",
      " context-1", // line 1
      "+added-2", // line 2 (added)
      " context-3", // line 3 (after add)
      "-removed-X", // not in new file
      "+modified-4", // line 4 (added)
      " context-5", // line 5
    ].join("\n");
    expect(addedLineNumbers(diff)).toEqual(new Set([2, 4]));
  });

  test("anchors rightLine independently for each hunk", () => {
    const diff = [
      "@@ -1,2 +1,3 @@",
      " a", // line 1
      "+b", // line 2
      " c", // line 3
      "@@ -20,2 +21,3 @@",
      " d", // line 21
      "+e", // line 22
      " f", // line 23
    ].join("\n");
    expect(addedLineNumbers(diff)).toEqual(new Set([2, 22]));
  });

  test("treats an untracked-file diff as every body line added", () => {
    // What `git diff --no-index -- /dev/null path` emits for a new file.
    const diff = [
      "diff --git a//dev/null b/new.txt",
      "new file mode 100644",
      "--- /dev/null",
      "+++ b/new.txt",
      "@@ -0,0 +1,3 @@",
      "+alpha",
      "+beta",
      "+gamma",
    ].join("\n");
    expect(addedLineNumbers(diff)).toEqual(new Set([1, 2, 3]));
  });

  test("ignores the metadata preamble and `\\ No newline at end of file` marker", () => {
    const diff = [
      "diff --git a/x b/x",
      "index 1..2 100644",
      "--- a/x",
      "+++ b/x",
      "@@ -1,2 +1,2 @@",
      "-old-only",
      "+new-only", // line 1 (added)
      " context", // line 2
      "\\ No newline at end of file",
    ].join("\n");
    expect(addedLineNumbers(diff)).toEqual(new Set([1]));
  });
});

/**
 * `removedLineNumbers` drives the LEFT-pane red stripes in the side-by-
 * side view — it must return the 1-based line numbers in the OLD file
 * that are removed. Cases mirror the added-side tests so the two parsers
 * stay symmetric in coverage.
 */
describe("removedLineNumbers", () => {
  test("returns an empty set for empty input", () => {
    expect(removedLineNumbers("")).toEqual(new Set());
  });

  test("picks out - lines and advances on context, skips + lines", () => {
    const diff = [
      "@@ -1,4 +1,5 @@",
      " context-1", // old line 1
      "-removed-2", // old line 2 (removed)
      " context-3", // old line 3
      "+added-only", // not in old file
      "-removed-4", // old line 4 (removed)
      " context-5", // old line 5
    ].join("\n");
    expect(removedLineNumbers(diff)).toEqual(new Set([2, 4]));
  });

  test("anchors leftLine independently for each hunk", () => {
    const diff = [
      "@@ -1,2 +1,3 @@",
      " a", // line 1
      "-b", // line 2 (removed)
      " c", // line 3
      "@@ -20,2 +21,3 @@",
      " d", // line 20
      "-e", // line 21 (removed)
      " f", // line 22
    ].join("\n");
    expect(removedLineNumbers(diff)).toEqual(new Set([2, 21]));
  });

  test("returns empty for a brand-new file (no - lines)", () => {
    // Same /dev/null diff that `addedLineNumbers` marks every body line in
    // — `removedLineNumbers` should find nothing because everything is +.
    const diff = [
      "diff --git a//dev/null b/new.txt",
      "new file mode 100644",
      "--- /dev/null",
      "+++ b/new.txt",
      "@@ -0,0 +1,3 @@",
      "+alpha",
      "+beta",
      "+gamma",
    ].join("\n");
    expect(removedLineNumbers(diff)).toEqual(new Set());
  });
});

/**
 * `buildLineMap` drives hunk-aware split-mode scroll sync — given a left-
 * pane line number it returns the right-pane line that should be at the
 * same Y offset (and vice versa). Without this, panels with large adds /
 * removes visibly drift past the hunk's end.
 */
describe("buildLineMap", () => {
  test("identity mapping when there are no hunks (clean diff)", () => {
    const { oldToNew, newToOld } = buildLineMap("", 100, 100);
    // No anchors means we interpolate between (1,1) and (100,100), which
    // for matching counts collapses to identity.
    expect(oldToNew(1)).toBe(1);
    expect(oldToNew(50)).toBe(50);
    expect(oldToNew(100)).toBe(100);
    expect(newToOld(75)).toBe(75);
  });

  test("aligns context lines after an insertion", () => {
    // Old has 5 lines, new has 8 lines; lines 4-6 of the new file are
    // additions that pushed the old "C","D","E" lines down. After the
    // hunk, old line 3 (context) should map to new line 3 (also context),
    // and old line 4 (which is "C") should map to new line 7 ("C" after
    // the inserted block).
    const diff = [
      "@@ -1,5 +1,8 @@",
      " A", // old 1, new 1
      " B", // old 2, new 2
      " C", // old 3, new 3
      "+X1", // new 4
      "+X2", // new 5
      "+X3", // new 6
      " D", // old 4, new 7
      " E", // old 5, new 8
    ].join("\n");
    const { oldToNew, newToOld } = buildLineMap(diff, 5, 8);
    // Pre-hunk context lines map identity.
    expect(oldToNew(1)).toBe(1);
    expect(oldToNew(2)).toBe(2);
    expect(oldToNew(3)).toBe(3);
    // Post-insertion context lines shift by the insertion size.
    expect(oldToNew(4)).toBe(7);
    expect(oldToNew(5)).toBe(8);
    // Reverse direction holds the same anchors.
    expect(newToOld(7)).toBe(4);
    expect(newToOld(8)).toBe(5);
  });

  test("clamps below 1 to the first anchor", () => {
    const { oldToNew } = buildLineMap("", 10, 10);
    // Zero / negative inputs are clamped to line 1 before the search.
    expect(oldToNew(0)).toBe(1);
    expect(oldToNew(-5)).toBe(1);
  });
});

/**
 * `removedByNewLine` powers the gutter tooltip showing "what was here
 * before" for every `+` line in a hunk that also has `-` lines.
 */
describe("removedByNewLine", () => {
  test("maps + lines in a hunk to the - lines from the same hunk", () => {
    const diff = [
      "@@ -1,3 +1,3 @@",
      " unchanged-1", // new 1, no tooltip
      "-was-here", // not in new file
      "+is-here-now", // new 2, tooltip = ["was-here"]
      " unchanged-3", // new 3, no tooltip
    ].join("\n");
    const m = removedByNewLine(diff);
    expect(m.get(1)).toBeUndefined();
    expect(m.get(2)).toEqual(["was-here"]);
    expect(m.get(3)).toBeUndefined();
  });

  test("groups multiple - lines together for adjacent + lines", () => {
    const diff = [
      "@@ -1,4 +1,3 @@",
      " ctx-1",
      "-old-a",
      "-old-b",
      "+new-x", // tooltip = ["old-a","old-b"]
      "+new-y", // tooltip = ["old-a","old-b"]  (same hunk)
      " ctx-end",
    ].join("\n");
    const m = removedByNewLine(diff);
    expect(m.get(2)).toEqual(["old-a", "old-b"]);
    expect(m.get(3)).toEqual(["old-a", "old-b"]);
    // ctx-1 (line 1) and ctx-end (line 4) have no removed buffer.
    expect(m.get(1)).toBeUndefined();
    expect(m.get(4)).toBeUndefined();
  });

  test("a context line between - and + lines flushes the buffer", () => {
    // The - removal precedes the context line, so the + on the OTHER
    // side of the context isn't its replacement. Guards against
    // incorrectly attributing removals across context boundaries.
    const diff = [
      "@@ -1,5 +1,4 @@",
      "-orphan-removal",
      " ctx", // line 1
      "+addition", // line 2 — should NOT see orphan-removal as its tooltip
      " ctx-2", // line 3
    ].join("\n");
    const m = removedByNewLine(diff);
    expect(m.get(2)).toBeUndefined();
  });

  test("no - lines means no tooltips", () => {
    const diff = [
      "@@ -1,2 +1,4 @@",
      " ctx",
      "+a",
      "+b",
      " ctx-2",
    ].join("\n");
    expect(removedByNewLine(diff).size).toBe(0);
  });
});
