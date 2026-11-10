import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { assignReleases, buildFile, readHistory } from "../../scripts/release-notes.mjs";
import { classifyCommit } from "@/lib/shared/release-changelog";
import {
  compareVersions,
  decideWhatsNew,
  laterVersion,
  parseReleaseNotes,
  releasesInRange,
} from "@/lib/shared/release-notes";

/**
 * Release notes bundled into every build (scripts/release-notes.mjs →
 * public/release-notes.json → lib/shared/release-notes.ts) and the
 * post-update "What's new" decision.
 */

describe("assignReleases (generator core)", () => {
  // History, oldest → newest:   a ← b ← c ← m(merge of c + p) ← d
  // where p branched off a, so it predates the v…​.1 tag but only lands in .2.
  const log = [
    { sha: "d".repeat(40), parents: ["m".repeat(40)], subject: "fix(chat): d" },
    { sha: "m".repeat(40), parents: ["c".repeat(40), "p".repeat(40)], subject: "Merge pull request #1" },
    { sha: "p".repeat(40), parents: ["a".repeat(40)], subject: "feat(files): p from a PR" },
    { sha: "c".repeat(40), parents: ["b".repeat(40)], subject: "feat(chat): c" },
    { sha: "b".repeat(40), parents: ["a".repeat(40)], subject: "fix(chat): b" },
    { sha: "a".repeat(40), parents: [], subject: "initial" },
  ];
  const tags = [
    { tag: "v0.3.10.2", sha: "d".repeat(40), date: "2026-01-03T00:00:00Z" },
    { tag: "v0.3.10.0", sha: "a".repeat(40), date: "2026-01-01T00:00:00Z" },
    { tag: "v0.3.10.1", sha: "c".repeat(40), date: "2026-01-02T00:00:00Z" },
    { tag: "v0.3.10", sha: "c".repeat(40), date: "2026-01-02T00:00:00Z" }, // legacy 3-part: ignored
  ];

  test("each commit belongs to the earliest tag that contains it; baseline omitted", () => {
    const releases = assignReleases(tags, log);
    expect(releases.map((r) => [r.tag, r.previous])).toEqual([
      ["v0.3.10.2", "v0.3.10.1"],
      ["v0.3.10.1", "v0.3.10.0"],
    ]);
    // Newest first, merge commit dropped, the PR's older commit still lands in .2.
    expect(releases[0].commits.map((c) => c.subject)).toEqual(["fix(chat): d", "feat(files): p from a PR"]);
    expect(releases[1].commits.map((c) => c.subject)).toEqual(["feat(chat): c", "fix(chat): b"]);
    expect(releases[0].commits[0].sha).toBe("dddddddd");
  });

  test("tags sort numerically, not lexically (.10 after .9)", () => {
    const releases = assignReleases(
      [
        { tag: "v0.3.9.10", sha: "c".repeat(40), date: "" },
        { tag: "v0.3.9.9", sha: "b".repeat(40), date: "" },
        { tag: "v0.3.9.1", sha: "a".repeat(40), date: "" },
      ],
      log,
    );
    expect(releases.map((r) => r.tag)).toEqual(["v0.3.9.10", "v0.3.9.9"]);
  });
});

describe("readHistory against a real git repo", () => {
  let dir: string | null = null;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = null;
  });

  function git(...args: string[]) {
    // Signing off: a global `commit.gpgsign` would otherwise prompt / fail.
    return execFileSync("git", ["-c", "commit.gpgsign=false", "-c", "tag.gpgSign=false", ...args], {
      cwd: dir!,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "t",
        GIT_AUTHOR_EMAIL: "t@example.com",
        GIT_COMMITTER_NAME: "t",
        GIT_COMMITTER_EMAIL: "t@example.com",
      },
    }).toString();
  }
  function commit(subject: string) {
    writeFileSync(join(dir!, "f.txt"), subject);
    git("add", "f.txt");
    git("commit", "-q", "-m", subject);
  }

  test("annotated + lightweight tags, head tag, and range assignment", () => {
    dir = mkdtempSync(join(tmpdir(), "claudius-release-notes-"));
    git("init", "-q", "-b", "main");
    commit("chore: initial");
    git("tag", "-a", "v1.2.3.0", "-m", "baseline"); // annotated → peeled sha
    commit("feat(chat): first feature");
    commit("docs: internal");
    git("tag", "v1.2.3.1"); // lightweight
    commit("fix(files): a fix");
    git("tag", "-a", "v1.2.3.2", "-m", "r2");

    const file = buildFile(readHistory(dir));
    expect(file.head).toBe("v1.2.3.2");
    expect(file.releases.map((r: { tag: string }) => r.tag)).toEqual(["v1.2.3.2", "v1.2.3.1"]);
    expect(file.releases[1].commits.map((c: { subject: string }) => c.subject)).toEqual([
      "docs: internal",
      "feat(chat): first feature",
    ]);

    // …and end to end through the renderer's parser.
    const notes = parseReleaseNotes(JSON.parse(JSON.stringify(file)));
    expect(notes[0]).toMatchObject({ tag: "v1.2.3.2", shown: 1, total: 1 });
    expect(notes[1]).toMatchObject({ tag: "v1.2.3.1", shown: 1, total: 2 });
    expect(notes[1].groups[0].entries[0].text).toBe("First feature");
  });

  test("a shallow clone is skipped rather than producing truncated ranges", () => {
    dir = mkdtempSync(join(tmpdir(), "claudius-release-notes-"));
    const src = join(dir, "src");
    execFileSync("git", ["init", "-q", "-b", "main", src]);
    const prev = dir;
    dir = src;
    commit("a");
    commit("b");
    dir = prev;
    execFileSync("git", ["clone", "-q", "--depth", "1", `file://${src}`, join(dir, "shallow")]);
    expect(readHistory(join(dir, "shallow")).skip).toMatch(/shallow/);
  });
});

describe("release notes model", () => {
  const file = {
    version: 1,
    head: "v0.3.12.1",
    releases: [
      {
        tag: "v0.3.12.0",
        previous: "v0.3.11.3",
        date: "2026-01-02T00:00:00Z",
        commits: [{ sha: "c1", subject: "chore: bump" }],
      },
      {
        tag: "v0.3.12.1",
        previous: "v0.3.12.0",
        date: "2026-01-03T00:00:00Z",
        commits: [
          { sha: "b2", subject: "fix(chat): newer fix" },
          { sha: "b1", subject: "feat(chat): a feature" },
        ],
      },
      {
        tag: "v0.3.11.3",
        previous: "v0.3.11.2",
        date: "2026-01-01T00:00:00Z",
        commits: [{ sha: "a1", subject: "fix(files): old fix" }],
      },
      { tag: "nope", previous: "v0.3.11.2", date: "", commits: [] }, // malformed: dropped
    ],
  };

  test("parseReleaseNotes validates, classifies, and sorts newest first", () => {
    const notes = parseReleaseNotes(file);
    expect(notes.map((n) => n.tag)).toEqual(["v0.3.12.1", "v0.3.12.0", "v0.3.11.3"]);
    expect(notes[0].groups.map((g) => g.key)).toEqual(["feat", "fix"]);
    expect(notes[0].compareUrl).toBe(
      "https://github.com/filipegarcia/claudius/compare/v0.3.12.0...v0.3.12.1",
    );
    expect(notes[1]).toMatchObject({ shown: 0, total: 1 }); // maintenance-only
    expect(parseReleaseNotes(null)).toEqual([]);
    expect(parseReleaseNotes({ releases: "x" })).toEqual([]);
  });

  test("releasesInRange: (after, upTo], newest first", () => {
    const notes = parseReleaseNotes(file);
    expect(releasesInRange(notes, "0.3.11.3", "0.3.12.1").map((n) => n.tag)).toEqual([
      "v0.3.12.1",
      "v0.3.12.0",
    ]);
    expect(releasesInRange(notes, null, "0.3.12.0").map((n) => n.tag)).toEqual([
      "v0.3.12.0",
      "v0.3.11.3",
    ]);
  });

  test("compareVersions is numeric and ignores the v prefix", () => {
    expect(compareVersions("0.3.9.10", "v0.3.9.9")).toBe(1);
    expect(compareVersions("v0.3.322", "0.3.322.0")).toBe(0);
    expect(compareVersions("0.3.100.0", "0.3.99.5")).toBe(1);
  });
});

describe("decideWhatsNew", () => {
  test("first run is quiet", () => {
    expect(decideWhatsNew(null, "0.3.322.2")).toEqual({ kind: "first-run" });
    expect(decideWhatsNew("garbage", "0.3.322.2")).toEqual({ kind: "first-run" });
  });
  test("an upgrade shows everything since the last seen version", () => {
    expect(decideWhatsNew("0.3.318.0", "0.3.322.2")).toEqual({ kind: "show", since: "0.3.318.0" });
  });
  test("same version or a downgrade shows nothing", () => {
    expect(decideWhatsNew("0.3.322.2", "0.3.322.2")).toEqual({ kind: "none" });
    expect(decideWhatsNew("0.3.322.2", "0.3.320.0")).toEqual({ kind: "none" });
  });
  test("last-seen never moves backwards", () => {
    expect(laterVersion("0.3.322.2", "0.3.320.0")).toBe("0.3.322.2");
    expect(laterVersion("0.3.320.0", "0.3.322.2")).toBe("0.3.322.2");
    expect(laterVersion(null, "0.3.322.2")).toBe("0.3.322.2");
  });
});

describe("classifyCommit hides release-machinery scopes", () => {
  test.each([
    "fix(release): pin Linux jobs to ubuntu-24.04",
    "feat(releases): reverse daily heatmap",
    "feat(update-pipeline): stack new runs onto the open PR",
    "fix(e2e): keep Tailwind's scanner out of .bun-cache",
    "fix(CI): something",
  ])("%s → internal", (msg) => {
    expect(classifyCommit(msg, "1")).toBeNull();
  });
  test("user-facing scopes, sdk-update and security stay", () => {
    expect(classifyCommit("feat(sdk-update): idleCompaction setting", "1")?.group).toBe("feat");
    expect(classifyCommit("fix(security): bump next", "1")?.group).toBe("fix");
    expect(classifyCommit("fix(chat): stop sideways scroll", "1")?.group).toBe("fix");
  });
});
