/**
 * Regression coverage for the self-update "conflict markers reach `bun install`"
 * bug — the one that shipped as:
 *
 *   Failed (install): bun install --ignore-scripts exited with code 1
 *   53 | <<<<<<< Updated upstream
 *      | ^ error: Unsupported syntax: Operators are not allowed in JSON at
 *      | …/package.json:53:1
 *
 * Root cause: a `git stash pop` during the stash-ff strategy left conflict
 * markers in a tracked file's CONTENT while the index carried no unmerged
 * entries (the markers round-tripped through the stash, or a prior conflict was
 * half-resolved). Every guard in the updater keyed off `git ls-files -u`
 * (index-level), so it saw a "clean" tree and marched into `bun install`, which
 * died parsing the marker-laden `package.json` — then mislabelled it as a
 * dependency-install failure.
 *
 * The fix adds CONTENT-level conflict detection (`conflictedFiles` /
 * `hasConflicts`) used as the chokepoint before install and as the
 * conflict-clear signal in detect/apply. These tests pin that detection against
 * real temp git repos across every way markers can show up — index-unmerged,
 * staged-with-markers, and round-tripped-through-stash — plus the false
 * positives the matcher must NOT trip on.
 *
 * Real git is the only faithful way to reproduce the index-vs-content split:
 * mocks can't recreate the "clean index, dirty content" state that fooled the
 * old guard.
 */
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  conflictedFiles,
  hasConflicts,
  hasUnmergedFiles,
  stashPop,
  stashPushIncludeUntracked,
} from "@/lib/server/updater/git";

// Build conflict markers at runtime so this test file's own tracked source
// never contains a real line-start marker (which would trip `git grep` run
// against the Claudius repo by other tooling, and is just confusing to read).
const OPEN = "<".repeat(7);
const MID = "=".repeat(7);
const CLOSE = ">".repeat(7);

/** A syntactically-broken package.json with a real conflict block (the bug). */
function conflictedPackageJson(): string {
  return [
    "{",
    '  "name": "claudius",',
    `${OPEN} Updated upstream`,
    '  "version": "2.0.0"',
    MID,
    '  "version": "1.0.0"',
    `${CLOSE} Stashed changes`,
    "}",
    "",
  ].join("\n");
}

function gitSync(args: string[], cwd: string): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "test",
      GIT_AUTHOR_EMAIL: "test@example.com",
      GIT_COMMITTER_NAME: "test",
      GIT_COMMITTER_EMAIL: "test@example.com",
      GIT_TERMINAL_PROMPT: "0",
    },
  }).trim();
}

describe("conflict-marker detection (updater git helpers)", () => {
  let repo: string;

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), "claudius-conflict-"));
    gitSync(["init", "--quiet", "-b", "main"], repo);
    writeFileSync(join(repo, "package.json"), '{\n  "name": "claudius",\n  "version": "1.0.0"\n}\n');
    gitSync(["add", "."], repo);
    gitSync(["commit", "--quiet", "-m", "base"], repo);
  });

  afterEach(() => {
    try {
      rmSync(repo, { recursive: true, force: true });
    } catch {
      // best effort
    }
  });

  test("clean tree → no conflicts detected", async () => {
    expect(await conflictedFiles(repo)).toEqual([]);
    expect(await hasConflicts(repo)).toBe(false);
    expect(await hasUnmergedFiles(repo)).toBe(false);
  });

  test("THE BUG: markers in content with a CLEAN index are detected", async () => {
    // Reproduce the exact failed state from the field: package.json has conflict
    // markers, but it's been `git add`ed so the index has zero unmerged entries.
    // The old index-only guard saw "clean" and ran `bun install` → JSON parse
    // death. `conflictedFiles` must catch this from content.
    writeFileSync(join(repo, "package.json"), conflictedPackageJson());
    gitSync(["add", "package.json"], repo);

    expect(await hasUnmergedFiles(repo)).toBe(false); // index is clean — the trap
    expect(await conflictedFiles(repo)).toEqual(["package.json"]);
    expect(await hasConflicts(repo)).toBe(true); // …but the tree is NOT safe to install
  });

  test("real stash-pop conflict is reported AND visible to content detection", async () => {
    // Local uncommitted edit to the same line upstream will change.
    writeFileSync(join(repo, "package.json"), '{\n  "name": "claudius",\n  "version": "1.5.0"\n}\n');
    const { stashed } = await stashPushIncludeUntracked(repo, "claudius-updater-stash");
    expect(stashed).toBe(true);

    // Simulate the upstream commit the ff-pull brought in: same line, different value.
    writeFileSync(join(repo, "package.json"), '{\n  "name": "claudius",\n  "version": "2.0.0"\n}\n');
    gitSync(["commit", "--quiet", "-am", "upstream bump"], repo);

    const pop = await stashPop(repo);
    expect(pop.ok).toBe(false); // stashPop correctly surfaces the conflict

    // Both index-level and content-level detection agree here.
    expect(await hasUnmergedFiles(repo)).toBe(true);
    expect(await conflictedFiles(repo)).toEqual(["package.json"]);
    expect(await hasConflicts(repo)).toBe(true);

    // And the file genuinely contains markers — proving install would have died.
    expect(readFileSync(join(repo, "package.json"), "utf8")).toContain(`${OPEN} Updated upstream`);
  });

  test("markers that ROUND-TRIP through a clean stash pop still get caught", async () => {
    // The subtle path: a tracked file already carries markers as an uncommitted
    // edit. stash push captures the marker-laden version; the pop restores it
    // CLEANLY (base unchanged → no new merge conflict), so `stashPop` returns
    // ok and `git ls-files -u` is empty. The markers are nonetheless back in the
    // tree. This is the case that made the old guard wave a poisoned tree
    // through to `bun install`; `conflictedFiles` is the safety net.
    writeFileSync(join(repo, "package.json"), conflictedPackageJson());
    const { stashed } = await stashPushIncludeUntracked(repo, "claudius-updater-stash");
    expect(stashed).toBe(true);

    const pop = await stashPop(repo);
    expect(pop.ok).toBe(true); // clean pop — no NEW conflict
    expect(await hasUnmergedFiles(repo)).toBe(false); // index clean

    // …yet the markers are back in the working tree and MUST be caught.
    expect(await conflictedFiles(repo)).toEqual(["package.json"]);
    expect(await hasConflicts(repo)).toBe(true);
  });

  test("multiple conflicted files are all reported, sorted", async () => {
    writeFileSync(join(repo, "package.json"), conflictedPackageJson());
    writeFileSync(
      join(repo, "app.ts"),
      [`${OPEN} Updated upstream`, "const a = 2;", MID, "const a = 1;", `${CLOSE} Stashed changes`, ""].join("\n"),
    );
    gitSync(["add", "."], repo);

    expect(await conflictedFiles(repo)).toEqual(["app.ts", "package.json"]);
    expect(await hasConflicts(repo)).toBe(true);
  });

  test("does not run install-blocking on untracked-marker files (git grep is tracked-only)", async () => {
    // An untracked scratch file with markers should not be flagged — only
    // tracked files feed the build. (Documents the matcher's tracked-only scope.)
    writeFileSync(join(repo, "scratch.txt"), `${OPEN} x\n${MID}\ny\n${CLOSE} z\n`);
    expect(await conflictedFiles(repo)).toEqual([]);
    expect(await hasConflicts(repo)).toBe(false);
  });

  describe("false positives the matcher must NOT trip on", () => {
    test("a markdown rule of only equals signs", async () => {
      writeFileSync(join(repo, "README.md"), `Title\n${"=".repeat(40)}\nbody\n`);
      gitSync(["add", "."], repo);
      expect(await conflictedFiles(repo)).toEqual([]);
      expect(await hasConflicts(repo)).toBe(false);
    });

    test("an opening marker with no closing marker", async () => {
      // Requires BOTH families — a lone `<<<<<<<` (e.g. quoted in docs/code) is
      // not a conflict.
      writeFileSync(join(repo, "doc.md"), `${OPEN} this is prose, not a conflict\nmore text\n`);
      gitSync(["add", "."], repo);
      expect(await conflictedFiles(repo)).toEqual([]);
      expect(await hasConflicts(repo)).toBe(false);
    });

    test("a run of < characters without the trailing space+label", async () => {
      writeFileSync(join(repo, "ascii.txt"), `${"<".repeat(20)}\n${">".repeat(20)}\n`);
      gitSync(["add", "."], repo);
      expect(await conflictedFiles(repo)).toEqual([]);
      expect(await hasConflicts(repo)).toBe(false);
    });
  });
});
