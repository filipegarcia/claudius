import { describe, expect, test } from "vitest";
import { findSlashCommand } from "@/lib/shared/slash-commands";

/**
 * CC 2.1.223 (D10) — `/review` is an alias of `/code-review` (reviews the
 * current branch or a PR, takes a level, and `ultra` runs the cloud review).
 * The static registry copy used to be the stale "Review a pull request".
 */
describe("/review registry metadata (CC 2.1.223 — D10)", () => {
  test("description reflects /code-review, not the stale PR-only copy", () => {
    const cmd = findSlashCommand("review");
    expect(cmd).toBeDefined();
    expect(cmd!.description).not.toBe("Review a pull request.");
    expect(cmd!.description.toLowerCase()).toContain("code-review");
    expect(cmd!.argsHint).toContain("ultra");
  });

  test("resolves by its /code-review alias", () => {
    expect(findSlashCommand("code-review")?.id).toBe("review");
  });
});
