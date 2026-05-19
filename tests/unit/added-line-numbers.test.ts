import { describe, expect, test } from "vitest";
import { addedLineNumbers, removedLineNumbers } from "@/components/git/FileEditor";

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
