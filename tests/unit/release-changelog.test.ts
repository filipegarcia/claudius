import { describe, expect, test } from "vitest";
import {
  buildReleaseChangelog,
  classifyCommit,
  toReleaseTag,
} from "@/lib/shared/release-changelog";

/**
 * The desktop update modal's "What's new" list is built from the commit range
 * between two release tags (GitHub Releases carry no notes). Only user-facing
 * conventional-commit types survive; internal ones are counted, not shown.
 */
describe("release changelog", () => {
  test("toReleaseTag accepts versions and tags, rejects anything else", () => {
    expect(toReleaseTag("0.3.298.0")).toBe("v0.3.298.0");
    expect(toReleaseTag("v0.3.296.1")).toBe("v0.3.296.1");
    expect(toReleaseTag("0.3.298")).toBe("v0.3.298");
    expect(toReleaseTag("main")).toBeNull();
    expect(toReleaseTag("0.3.298.0...evil")).toBeNull();
    expect(toReleaseTag("../../x")).toBeNull();
    expect(toReleaseTag("")).toBeNull();
  });

  test("classifyCommit keeps feat/fix/perf/refactor and strips CC parity markers", () => {
    expect(classifyCommit("feat(cost): /usage behaviour warnings (CC 2.1.299 parity)", "abcdef0123")).toEqual({
      group: "feat",
      entry: { scope: "cost", text: "/usage behaviour warnings", sha: "abcdef01" },
    });
    expect(classifyCommit("fix(hooks): timeout on agent hooks (CC 2.1.300 review)\n\nbody", "1")?.entry.text).toBe(
      "Timeout on agent hooks",
    );
    expect(classifyCommit("perf: faster list", "1")?.group).toBe("improve");
    expect(classifyCommit("fix!: breaking thing", "1")?.entry).toMatchObject({ scope: null, text: "Breaking thing" });
  });

  test("classifyCommit drops internal commits", () => {
    for (const msg of [
      "docs(cc-parity): notes for 2.1.300",
      "test(composer): cover restore",
      "chore(release): bump claudius version → 0.3.298",
      "wip(cc-parity): commit work the agent left uncommitted",
      "Merge pull request #303 from x/y",
      "merge: cc-parity 2.1.299 group 1",
    ]) {
      expect(classifyCommit(msg, "1")).toBeNull();
    }
  });

  test("buildReleaseChangelog groups newest-first, dedupes, and counts everything", () => {
    const log = buildReleaseChangelog({
      from: "v0.3.296.1",
      to: "v0.3.298.0",
      compareUrl: "https://github.com/x/y/compare/a...b",
      commits: [
        { sha: "a1", message: "fix(chat): older fix" },
        { sha: "a2", message: "docs: internal" },
        { sha: "a3", message: "feat(cost): a feature" },
        { sha: "a4", message: "fix(chat): newer fix" },
        { sha: "a5", message: "fix(chat): Older fix (CC 2.1.300 review)" },
      ],
    });
    expect(log.total).toBe(5);
    expect(log.groups.map((g) => g.key)).toEqual(["feat", "fix"]);
    expect(log.groups[1].entries.map((e) => e.text)).toEqual(["Older fix", "Newer fix"]);
  });
});
