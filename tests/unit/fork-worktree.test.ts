import { describe, expect, test } from "vitest";
import { forkSlug, forkWorktreeIds, forkConfirmation } from "@/lib/shared/fork-worktree";

/**
 * CC 2.1.221 + 2.1.216 (DEC3) — fork worktree slug/branch + confirmation line.
 */
describe("fork-worktree pure helpers (DEC3)", () => {
  test("forkSlug takes the first 8 alphanumerics, lowercased", () => {
    expect(forkSlug("8DED11A6-fd42-49dc-815f-f1893b346073")).toBe("8ded11a6");
    expect(forkSlug("---")).toBe("session");
  });

  test("forkWorktreeIds derives branch + dir from the slug", () => {
    expect(forkWorktreeIds("8ded11a6-fd42")).toEqual({
      branch: "claudius/fork-8ded11a6",
      dirName: "fork-8ded11a6",
    });
  });

  test("confirmation names a worktree fork", () => {
    const line = forkConfirmation({
      title: "auth refactor",
      sessionId: "8ded11a6-fd42",
      worktree: { path: "/wt", branch: "claudius/fork-8ded11a6", dirty: false },
    });
    expect(line).toContain('"auth refactor"');
    expect(line).toContain("8ded11a6");
    expect(line).toContain("its own worktree");
    expect(line).toContain("claudius/fork-8ded11a6");
    expect(line).not.toContain("uncommitted");
  });

  test("confirmation adds the dirty note when the source tree is dirty", () => {
    const line = forkConfirmation({
      sessionId: "abcd1234",
      worktree: { path: "/wt", branch: "claudius/fork-abcd1234", dirty: true },
    });
    expect(line).toContain("untitled");
    expect(line).toContain("uncommitted changes not included");
  });

  test("confirmation falls back to shared checkout when there's no worktree", () => {
    const line = forkConfirmation({ title: "x", sessionId: "abcd1234", worktree: null });
    expect(line).toContain("shares your checkout");
    expect(line).not.toContain("worktree");
  });
});
