import { describe, expect, test } from "vitest";
import {
  branchContextNote,
  isScreenshotChurn,
  parseEffort,
  parsePorcelainZ,
  renderPrompt as renderSdkPrompt,
  uncommittedWorkPaths,
  type DirtySnapshot,
} from "../../scripts/sdk-update/orchestrate";
import { renderPrompt as renderCcPrompt } from "../../scripts/cc-parity/orchestrate";

/**
 * The 2.1.293 parity run built a real fix and left it uncommitted; the gates
 * passed over the dirty tree, the branch was pushed without it, and the
 * release was recorded as done. These cover the pieces that now catch that:
 * the before/after dirty-tree diff, the branch the prompt names, the pinned
 * effort, and that no prompt placeholder is left unfilled.
 */

describe("parsePorcelainZ", () => {
  test("keeps the leading-space status and skips a rename's source path", () => {
    const out = " M lib/a.ts\0?? tests/b.test.ts\0R  lib/new.ts\0lib/old.ts\0 D gone.ts\0";
    expect(parsePorcelainZ(out)).toEqual([
      { xy: " M", path: "lib/a.ts" },
      { xy: "??", path: "tests/b.test.ts" },
      { xy: "R ", path: "lib/new.ts" },
      { xy: " D", path: "gone.ts" },
    ]);
  });

  test("handles empty output and paths with spaces", () => {
    expect(parsePorcelainZ("")).toEqual([]);
    expect(parsePorcelainZ("?? docs/a b.png\0")).toEqual([{ xy: "??", path: "docs/a b.png" }]);
  });
});

describe("isScreenshotChurn", () => {
  const own = "docs/cc-parity/2.1.293/";
  test("other versions' screenshots and the marketing gallery are churn", () => {
    expect(isScreenshotChurn("docs/cc-parity/2.1.205/doctor-fix.png", own)).toBe(true);
    expect(isScreenshotChurn("docs/sdk-updates/0.3.271/omit-claude-md-badge.png", own)).toBe(true);
    expect(isScreenshotChurn("site/screenshots/goal-set.png", own)).toBe(true);
  });
  test("the run's own docs folder and real code are not", () => {
    expect(isScreenshotChurn("docs/cc-parity/2.1.293/haiku-pricing.png", own)).toBe(false);
    expect(isScreenshotChurn("docs/cc-parity/2.1.293/haiku-pricing.png", "docs/cc-parity/2.1.293")).toBe(false);
    expect(isScreenshotChurn("lib/shared/cost-pricing.ts", own)).toBe(false);
    expect(isScreenshotChurn("docs/README.md", own)).toBe(false);
  });
});

describe("uncommittedWorkPaths", () => {
  const own = "docs/cc-parity/2.1.293/";
  test("reports what the run left dirty, not what was dirty before it", () => {
    const before: DirtySnapshot = new Map([
      ["notes/scratch.md", " M:aaa"],
      ["lib/touched-again.ts", " M:111"],
    ]);
    const after: DirtySnapshot = new Map([
      ["notes/scratch.md", " M:aaa"], // untouched since before → not the run's
      ["lib/touched-again.ts", " M:222"], // edited again by the run → counts
      ["lib/shared/cost-pricing.ts", " M:bbb"],
      ["tests/unit/cost-pricing-new-models.test.ts", " M:ccc"],
      ["docs/cc-parity/2.1.293/haiku.png", "??:ddd"],
      ["docs/cc-parity/2.1.205/doctor-fix.png", " M:eee"], // e2e churn
      ["site/screenshots/goal-set.png", " M:fff"], // e2e churn
    ]);
    expect(uncommittedWorkPaths(before, after, own)).toEqual([
      "docs/cc-parity/2.1.293/haiku.png",
      "lib/shared/cost-pricing.ts",
      "lib/touched-again.ts",
      "tests/unit/cost-pricing-new-models.test.ts",
    ]);
  });

  test("a clean run reports nothing", () => {
    expect(uncommittedWorkPaths(new Map(), new Map(), own)).toEqual([]);
  });
});

describe("parseEffort", () => {
  test("accepts the SDK's levels and falls back otherwise", () => {
    for (const level of ["low", "medium", "high", "xhigh", "max"] as const) {
      expect(parseEffort(level, "high")).toBe(level);
    }
    expect(parseEffort(undefined, "high")).toBe("high");
    expect(parseEffort("", "high")).toBe("high");
    expect(parseEffort("HIGH", "medium")).toBe("medium");
    expect(parseEffort("ultra", "high")).toBe("high");
  });
});

describe("branch named in the run prompts", () => {
  test("a run on its own branch is told it came from origin/main", () => {
    expect(branchContextNote("cc-parity/2.1.293", "cc-parity/2.1.293")).toContain("created from `origin/main`");
  });

  test("a run stacked on an open update PR is told to commit there", () => {
    const note = branchContextNote("sdk-update/0.3.293", "cc-parity/2.1.293");
    expect(note).toContain("stacked onto");
    expect(note).toContain("Commit your work here");
    expect(note).not.toContain("origin/main`)");
  });

  test("the cc-parity prompt names the real branch and fills every placeholder", () => {
    const prompt = renderCcPrompt("2.1.292", "2.1.293", "## 2.1.293\n\n- Added a thing", "sdk-update/0.3.293");
    expect(prompt).toContain("Checked out `sdk-update/0.3.293` — the branch of an open update PR");
    expect(prompt).not.toContain("fresh branch `cc-parity/2.1.293`");
    expect(prompt).toContain("You are the update pipeline");
    expect(prompt).not.toMatch(/\{\{[A-Z0-9_]+\}\}/);
  });

  test("the sdk-update prompt names the real branch and fills every placeholder", () => {
    const prompt = renderSdkPrompt("0.3.292", "0.3.293", "## 0.3.293\n\n- Parity", "_(no diff)_", "sdk-update/0.3.292");
    expect(prompt).toContain("Checked out `sdk-update/0.3.292` — the branch of an open update PR");
    expect(prompt).toContain("You are the update pipeline");
    // The prompt mentions the PR template's `{{SCREENSHOTS_BLOCK}}` by name on
    // purpose; nothing else may be left unfilled.
    expect(prompt.match(/\{\{[A-Z0-9_]+\}\}/g)).toEqual(["{{SCREENSHOTS_BLOCK}}"]);

    const own = renderSdkPrompt("0.3.292", "0.3.293", "- Parity", "_(no diff)_", "sdk-update/0.3.293");
    expect(own).toContain("Checked out `sdk-update/0.3.293`, created from `origin/main`");
  });
});
