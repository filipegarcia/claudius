import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  branchContextNote,
  isScreenshotChurn,
  parseEffort,
  parsePorcelainZ,
  renderPrompt as renderSdkPrompt,
  rescueUncommittedWork,
  snapshotDirtyTree,
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

  test("the crash-recovery snapshot (empty before) keeps real work and drops churn", () => {
    // 2.1.295: a blind `git add -A` swept 133 regenerated PNGs into the draft.
    const dirty: DirtySnapshot = new Map([
      ["lib/plugins.ts", " M:1"],
      ["docs/cc-parity/2.1.293/new-shot.png", "??:2"],
      ["docs/cc-parity/2.1.260/old.png", " M:3"],
      ["docs/sdk-updates/0.3.271/omit-claude-md-badge.png", "??:4"],
      ["site/screenshots/goal-set.png", " M:5"],
    ]);
    expect(uncommittedWorkPaths(new Map(), dirty, own)).toEqual([
      "docs/cc-parity/2.1.293/new-shot.png",
      "lib/plugins.ts",
    ]);
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

describe("rescueUncommittedWork (real git repo)", () => {
  let repo: string;
  let savedEnv: NodeJS.ProcessEnv;
  const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();
  const write = (rel: string, body: string) => {
    mkdirSync(join(repo, rel, ".."), { recursive: true });
    writeFileSync(join(repo, rel), body);
  };
  const notesRel = ".claudius/cc-parity/run-notes/2.1.293.md";
  const args = (before: Map<string, string>) => ({
    before,
    ownDocsDir: "docs/cc-parity/2.1.293/",
    notesRel,
    scope: "cc-parity",
    version: "2.1.293",
    cwd: repo,
  });

  beforeEach(() => {
    // Strip every GIT_* var from THIS process's env — not just the helper's —
    // because `rescueUncommittedWork` spawns git itself. This repo runs unit
    // tests from pre-commit, and git exports GIT_DIR / GIT_INDEX_FILE to
    // hooks: inherited, they point every git call here at the OUTER repo
    // (an earlier draft of this test committed into it and set core.bare).
    // Identity comes from env, and config is pinned to /dev/null, so nothing
    // is ever written outside the throwaway repo.
    savedEnv = { ...process.env };
    for (const k of Object.keys(process.env)) {
      if (k.startsWith("GIT_")) delete process.env[k];
    }
    Object.assign(process.env, {
      GIT_AUTHOR_NAME: "test",
      GIT_AUTHOR_EMAIL: "test@example.com",
      GIT_COMMITTER_NAME: "test",
      GIT_COMMITTER_EMAIL: "test@example.com",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_SYSTEM: "/dev/null",
      GIT_TERMINAL_PROMPT: "0",
    });
    expect(["GIT_DIR", "GIT_INDEX_FILE", "GIT_WORK_TREE", "GIT_COMMON_DIR"].filter((k) => k in process.env)).toEqual([]);

    repo = realpathSync(mkdtempSync(join(tmpdir(), "claudius-rescue-")));
    git("init", "-q");
    expect(realpathSync(git("rev-parse", "--show-toplevel"))).toBe(repo);
    write(".gitignore", ".claudius/\n");
    write("lib/cost.ts", "export const a = 1;\n");
    write("docs/cc-parity/2.1.205/old.png", "old");
    git("add", "-A");
    git("commit", "-q", "-m", "init");
  });
  afterEach(() => {
    rmSync(repo, { recursive: true, force: true });
    for (const k of Object.keys(process.env)) {
      if (!(k in savedEnv)) delete process.env[k];
    }
    Object.assign(process.env, savedEnv);
  });

  test("commits the run's leftovers as a WIP snapshot, commits the notes, and reports the issue", () => {
    write("scratch.txt", "dirty before the run");
    const before = snapshotDirtyTree(repo);
    // what the "run" leaves behind
    write("lib/cost.ts", "export const a = 2;\n");
    write("tests/cost.test.ts", "test");
    write("docs/cc-parity/2.1.293/shot.png", "new");
    write("docs/cc-parity/2.1.205/old.png", "churn");
    write(notesRel, "# notes");

    const issue = rescueUncommittedWork(args(before));
    expect(issue).toContain("Claude left 3 file(s) uncommitted");
    expect(git("log", "--format=%s", "-3").split("\n")).toEqual([
      "wip(cc-parity): commit work the agent left uncommitted for 2.1.293",
      "docs(cc-parity): notes for 2.1.293",
      "init",
    ]);
    expect(git("show", "--name-only", "--format=", "HEAD").split("\n").sort()).toEqual([
      "docs/cc-parity/2.1.293/shot.png",
      "lib/cost.ts",
      "tests/cost.test.ts",
    ]);
    // pre-existing dirt and other versions' screenshot churn are left alone
    expect(git("status", "--porcelain")).toBe("M docs/cc-parity/2.1.205/old.png\n?? scratch.txt");
  });

  test("uncommitted notes alone are committed without failing the run", () => {
    const before = snapshotDirtyTree(repo);
    write(notesRel, "# notes");
    expect(rescueUncommittedWork(args(before))).toBeNull();
    expect(git("log", "--format=%s", "-1")).toBe("docs(cc-parity): notes for 2.1.293");
  });

  test("a run that committed everything is left untouched", () => {
    const before = snapshotDirtyTree(repo);
    write("lib/cost.ts", "export const a = 3;\n");
    write(notesRel, "# notes");
    git("add", "-A");
    git("add", "-f", notesRel);
    git("commit", "-q", "-m", "feat: the run's own commit");
    expect(rescueUncommittedWork(args(before))).toBeNull();
    expect(git("log", "--format=%s", "-1")).toBe("feat: the run's own commit");
  });
});
