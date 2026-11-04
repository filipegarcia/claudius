import { describe, expect, test } from "vitest";
import { buildDirTree, defaultDiffMode, type DirNode } from "@/components/git/ChangesList";
import type { GitFileChange } from "@/lib/server/git";

/**
 * "Group By → Directory" in the Git changes list. The tree has to match
 * IntelliJ's shape: folders before files, alphabetical, and single-child
 * folder chains compacted into one node (`api/src/Migrations`).
 */

function change(path: string, extra: Partial<GitFileChange> = {}): GitFileChange {
  return { path, index: "M", worktree: " ", untracked: false, ...extra } as GitFileChange;
}

/** Flatten a tree into indented lines — easy to eyeball in a failure diff. */
function render(node: DirNode, depth = 0): string[] {
  const pad = "  ".repeat(depth);
  return [
    ...node.dirs.flatMap((d) => [`${pad}${d.name}/ (${d.filePaths.length})`, ...render(d, depth + 1)]),
    ...node.files.map((f) => `${pad}${f.path}`),
  ];
}

describe("buildDirTree", () => {
  test("compacts single-child folder chains and keeps root files at the top level", () => {
    const tree = buildDirTree([
      change("settings.toml"),
      change("api/src/Migrations/4908-bakai.sql"),
      change("screening/migrations/purge_bakai_test.py"),
      change(".gitignore"),
    ]);
    expect(render(tree)).toEqual([
      "api/src/Migrations/ (1)",
      "  api/src/Migrations/4908-bakai.sql",
      "screening/migrations/ (1)",
      "  screening/migrations/purge_bakai_test.py",
      ".gitignore",
      "settings.toml",
    ]);
  });

  test("stops compacting where a folder branches or holds its own files", () => {
    const tree = buildDirTree([
      change("a/b/one.ts"),
      change("a/b/c/two.ts"),
      change("a/d/three.ts"),
    ]);
    expect(render(tree)).toEqual([
      "a/ (3)",
      "  b/ (2)",
      "    c/ (1)",
      "      a/b/c/two.ts",
      "    a/b/one.ts",
      "  d/ (1)",
      "    a/d/three.ts",
    ]);
    // Compacted node keeps the full path of its deepest folder.
    expect(tree.dirs[0].dirs[1].path).toBe("a/d");
  });

  test("filePaths lists every descendant (drives the folder checkbox)", () => {
    const tree = buildDirTree([change("x/y/1.ts"), change("x/2.ts"), change("top.ts")]);
    expect(tree.filePaths.sort()).toEqual(["top.ts", "x/2.ts", "x/y/1.ts"]);
    expect(tree.dirs[0].filePaths.sort()).toEqual(["x/2.ts", "x/y/1.ts"]);
  });

  test("sorts numerically and case-insensitively", () => {
    const tree = buildDirTree([change("f10.ts"), change("F2.ts"), change("f1.ts")]);
    expect(tree.files.map((f) => f.path)).toEqual(["f1.ts", "F2.ts", "f10.ts"]);
  });

  test("tolerates a trailing-slash entry (untracked nested repo)", () => {
    const tree = buildDirTree([change("vendor/lib/", { untracked: true, index: "?", worktree: "?" })]);
    expect(render(tree)).toEqual(["vendor/ (1)", "  vendor/lib/"]);
  });
});

describe("defaultDiffMode", () => {
  test("mirrors the group a file lands in", () => {
    expect(defaultDiffMode(change("a", { untracked: true, index: "?", worktree: "?" }))).toBe("untracked");
    expect(defaultDiffMode(change("a", { index: "M", worktree: "M" }))).toBe("staged");
    expect(defaultDiffMode(change("a", { index: " ", worktree: "M" }))).toBe("worktree");
  });
});
