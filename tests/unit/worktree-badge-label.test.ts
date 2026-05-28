import { describe, expect, test } from "vitest";
import { worktreeBadge, worktreeBadgeLabel } from "@/lib/client/worktree";

describe("worktreeBadge (gate + label, normalized)", () => {
  test("null when either path is missing", () => {
    expect(worktreeBadge(null, "/home/me/proj")).toBeNull();
    expect(worktreeBadge("/home/me/proj", null)).toBeNull();
    expect(worktreeBadge(undefined, undefined)).toBeNull();
  });

  test("null when the paths are the same directory", () => {
    expect(worktreeBadge("/home/me/proj", "/home/me/proj")).toBeNull();
  });

  test("null when they differ only by a trailing slash (no spurious badge)", () => {
    expect(worktreeBadge("/home/me/proj/", "/home/me/proj")).toBeNull();
    expect(worktreeBadge("/home/me/proj", "/home/me/proj/")).toBeNull();
  });

  test("returns the relative label for a real worktree", () => {
    expect(worktreeBadge("/home/me/proj/.worktrees/x", "/home/me/proj")).toBe(".worktrees/x");
  });

  test("returns the basename for a sibling/temp worktree", () => {
    expect(worktreeBadge("/tmp/wt/abc", "/home/me/proj")).toBe("abc");
  });
});

describe("worktreeBadgeLabel", () => {
  test("returns the path relative to the session root when nested under it", () => {
    expect(worktreeBadgeLabel("/home/me/proj/.worktrees/feature-x", "/home/me/proj")).toBe(
      ".worktrees/feature-x",
    );
  });

  test("tolerates a trailing slash on the session root", () => {
    expect(worktreeBadgeLabel("/home/me/proj/wt/a", "/home/me/proj/")).toBe("wt/a");
  });

  test("falls back to the trailing segment for a sibling/temp worktree", () => {
    expect(worktreeBadgeLabel("/tmp/claude-worktrees/abc123", "/home/me/proj")).toBe("abc123");
  });

  test("does not treat a sibling that merely shares a prefix as nested", () => {
    // `/home/me/proj-wt` is NOT under `/home/me/proj` — only a `/`-delimited
    // child counts, so this falls back to the basename rather than slicing.
    expect(worktreeBadgeLabel("/home/me/proj-wt", "/home/me/proj")).toBe("proj-wt");
  });

  test("ignores a trailing slash on the worktree path", () => {
    expect(worktreeBadgeLabel("/home/me/proj/wt/a/", "/home/me/proj")).toBe("wt/a");
  });
});
