import { describe, expect, test } from "vitest";
import { diffRefreshToken, modeFor, statusChar, statusLabel } from "@/lib/shared/diff-overlay";
import type { GitFileChange } from "@/lib/server/git";

// CC 2.1.260 (H5) — the live-refresh token advances as Claude's edits do.
describe("diffRefreshToken", () => {
  test("changes when a new edit starts and when one completes", () => {
    expect(diffRefreshToken([])).toBe("0:0");
    const started = [{ done: false }];
    expect(diffRefreshToken(started)).toBe("1:0");
    const done = [{ done: true }];
    expect(diffRefreshToken(done)).toBe("1:1");
    expect(diffRefreshToken([{ done: true }, { done: false }])).toBe("2:1");
  });

  test("a stable edit list yields a stable token (no needless refetch)", () => {
    const edits = [{ done: true }, { done: true }];
    expect(diffRefreshToken(edits)).toBe(diffRefreshToken(edits));
  });
});

/**
 * Unit tests for `DiffOverlay`'s data-mapping helpers — CC 2.1.260 `/diff`
 * parity. See `lib/shared/diff-overlay.ts`'s doc comment for the
 * worktree-first mode-selection rationale.
 */

function file(overrides: Partial<GitFileChange>): GitFileChange {
  return { path: "src/foo.ts", index: " ", worktree: " ", untracked: false, ...overrides };
}

describe("modeFor", () => {
  test("untracked files always resolve to 'untracked'", () => {
    expect(modeFor(file({ untracked: true, index: "?", worktree: "?" }))).toBe("untracked");
  });

  test("a file with only unstaged changes resolves to 'worktree'", () => {
    expect(modeFor(file({ index: " ", worktree: "M" }))).toBe("worktree");
  });

  test("a file with only staged changes resolves to 'staged'", () => {
    expect(modeFor(file({ index: "A", worktree: " " }))).toBe("staged");
  });

  test("a partially-staged file (both slots dirty) prefers the live worktree diff", () => {
    expect(modeFor(file({ index: "M", worktree: "M" }))).toBe("worktree");
  });
});

describe("statusChar", () => {
  test("untracked files report '?'", () => {
    expect(statusChar(file({ untracked: true, index: "?", worktree: "?" }))).toBe("?");
  });

  test("prefers the worktree code when both are dirty", () => {
    expect(statusChar(file({ index: "A", worktree: "D" }))).toBe("D");
  });

  test("falls back to the index code when worktree is clean", () => {
    expect(statusChar(file({ index: "A", worktree: " " }))).toBe("A");
  });
});

describe("statusLabel", () => {
  test.each([
    ["M", "Modified"],
    ["A", "Added"],
    ["D", "Deleted"],
    ["R", "Renamed"],
    ["C", "Copied"],
    ["U", "Unmerged"],
    ["?", "Untracked"],
    ["T", "Type changed"],
    [" ", "Changed"],
  ] as const)("%s -> %s", (code, label) => {
    expect(statusLabel(code)).toBe(label);
  });
});
