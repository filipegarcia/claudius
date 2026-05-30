import { describe, expect, test } from "vitest";

import {
  nextWorktree,
  parseDirList,
  type WorktreeSettings,
} from "@/lib/shared/worktree-settings";

/**
 * The settings page's "Worktree" section is plain inputs except for two pieces
 * of logic that decide what actually lands in settings.json:
 *   1. parseDirList — turning a messy comma string into a clean array.
 *   2. nextWorktree — merging a field into the nested object while preserving
 *      sibling keys and collapsing to `undefined` when empty (so we never
 *      persist `"worktree": {}`).
 */

describe("parseDirList", () => {
  test("trims entries and drops empties", () => {
    expect(parseDirList("apps/web, , packages/ui,")).toEqual([
      "apps/web",
      "packages/ui",
    ]);
  });

  test("empty / whitespace-only input yields an empty array", () => {
    expect(parseDirList("")).toEqual([]);
    expect(parseDirList("   ,  , ")).toEqual([]);
  });

  test("a single value still parses", () => {
    expect(parseDirList("node_modules")).toEqual(["node_modules"]);
  });
});

describe("nextWorktree", () => {
  test("sets a field on an absent worktree object", () => {
    expect(nextWorktree(undefined, { sparsePaths: ["apps/web"] })).toEqual({
      sparsePaths: ["apps/web"],
    });
  });

  test("preserves sibling keys set elsewhere (baseRef/bgIsolation)", () => {
    const cur: WorktreeSettings = { baseRef: "head", bgIsolation: "worktree" };
    expect(nextWorktree(cur, { sparsePaths: ["packages/ui"] })).toEqual({
      baseRef: "head",
      bgIsolation: "worktree",
      sparsePaths: ["packages/ui"],
    });
  });

  test("updating one field leaves the other untouched", () => {
    const cur: WorktreeSettings = { sparsePaths: ["a"] };
    expect(
      nextWorktree(cur, { symlinkDirectories: ["node_modules"] }),
    ).toEqual({ sparsePaths: ["a"], symlinkDirectories: ["node_modules"] });
  });

  test("clearing a field removes that key", () => {
    const cur: WorktreeSettings = {
      sparsePaths: ["a"],
      symlinkDirectories: ["node_modules"],
    };
    expect(nextWorktree(cur, { sparsePaths: undefined })).toEqual({
      symlinkDirectories: ["node_modules"],
    });
  });

  test("clearing the last field collapses the object to undefined", () => {
    const cur: WorktreeSettings = { sparsePaths: ["a"] };
    expect(nextWorktree(cur, { sparsePaths: undefined })).toBeUndefined();
  });

  test("does not mutate the input object", () => {
    const cur: WorktreeSettings = { sparsePaths: ["a"] };
    nextWorktree(cur, { symlinkDirectories: ["b"] });
    expect(cur).toEqual({ sparsePaths: ["a"] });
  });
});
