import { describe, expect, test } from "vitest";

import {
  buildHeartbeatMessage,
  classifyPr,
  gatherActivity,
  isPipelineBranch,
  selectActivity,
  selectErrorIssues,
  type GhRunner,
  type IssueJson,
  type PrJson,
} from "@/scripts/heartbeat/heartbeat";

/**
 * Coverage for the pure data layer of the heartbeat. The bugs live in
 * window selection and outcome classification — timestamp boundaries,
 * draft-vs-needs-human precedence, closed-vs-merged — so those get the
 * fixtures; the message string is smoke-tested.
 */

// A fixed clock so the window math is deterministic.
const NOW = Date.parse("2026-06-23T09:00:00Z");
const CUTOFF = NOW - 24 * 3_600_000; // 2026-06-22T09:00:00Z

function pr(overrides: Partial<PrJson>): PrJson {
  return {
    number: 1,
    title: "bump",
    url: "https://github.com/o/r/pull/1",
    headRefName: "sdk-update/0.3.170",
    state: "OPEN",
    isDraft: false,
    createdAt: "2026-06-23T08:00:00Z",
    mergedAt: null,
    closedAt: null,
    labels: [],
    ...overrides,
  };
}

describe("isPipelineBranch", () => {
  test("matches sdk-update/ and cc-parity/ prefixes", () => {
    expect(isPipelineBranch("sdk-update/0.3.170")).toBe(true);
    expect(isPipelineBranch("cc-parity/2.1.186")).toBe(true);
  });
  test("rejects unrelated branches (incl. a user branch named similarly)", () => {
    expect(isPipelineBranch("main")).toBe(false);
    expect(isPipelineBranch("feature/sdk-update-notes")).toBe(false);
  });
});

describe("selectActivity", () => {
  test("includes a pipeline PR created inside the window", () => {
    const out = selectActivity([pr({ createdAt: "2026-06-23T08:00:00Z" })], CUTOFF);
    expect(out).toHaveLength(1);
  });

  test("includes a PR created BEFORE the window but merged inside it", () => {
    const out = selectActivity(
      [pr({ createdAt: "2026-06-20T00:00:00Z", mergedAt: "2026-06-23T07:00:00Z", state: "MERGED" })],
      CUTOFF,
    );
    expect(out).toHaveLength(1);
  });

  test("excludes a pipeline PR wholly outside the window", () => {
    const out = selectActivity(
      [pr({ createdAt: "2026-06-01T00:00:00Z", mergedAt: "2026-06-02T00:00:00Z", state: "MERGED" })],
      CUTOFF,
    );
    expect(out).toHaveLength(0);
  });

  test("excludes non-pipeline branches even when recent", () => {
    const out = selectActivity(
      [pr({ headRefName: "fix/some-bug", createdAt: "2026-06-23T08:00:00Z" })],
      CUTOFF,
    );
    expect(out).toHaveLength(0);
  });

  test("catches the combined PR (rides the sdk-update/ branch) once", () => {
    const out = selectActivity(
      [pr({ headRefName: "sdk-update/0.3.170", title: "bump sdk + claude-code" })],
      CUTOFF,
    );
    expect(out).toHaveLength(1);
  });
});

describe("classifyPr", () => {
  test("merged wins over everything", () => {
    expect(classifyPr(pr({ mergedAt: "2026-06-23T07:00:00Z", state: "MERGED", labels: [{ name: "needs-human" }] })).label).toBe("merged");
  });
  test("closed-without-merging", () => {
    expect(classifyPr(pr({ state: "CLOSED", closedAt: "2026-06-23T07:00:00Z" })).label).toBe("closed without merging");
  });
  test("open + needs-human → needs attention (over draft)", () => {
    expect(classifyPr(pr({ isDraft: true, labels: [{ name: "needs-human" }] })).label).toBe("needs attention");
  });
  test("open draft without needs-human → in progress", () => {
    expect(classifyPr(pr({ isDraft: true })).label).toBe("in progress");
  });
  test("open ready → awaiting review", () => {
    expect(classifyPr(pr({})).label).toBe("awaiting review");
  });
});

describe("selectErrorIssues", () => {
  const issue = (o: Partial<IssueJson>): IssueJson => ({
    number: 9,
    title: "SDK update 0.3.169 → 0.3.170 error",
    url: "https://github.com/o/r/issues/9",
    createdAt: "2026-06-23T08:00:00Z",
    ...o,
  });

  test("matches pipeline error issues inside the window", () => {
    expect(selectErrorIssues([issue({})], CUTOFF)).toHaveLength(1);
    expect(selectErrorIssues([issue({ title: "CC parity 2.1.185 → 2.1.186 error" })], CUTOFF)).toHaveLength(1);
  });
  test("ignores unrelated 'error' issues and old ones", () => {
    expect(selectErrorIssues([issue({ title: "App throws an error on login" })], CUTOFF)).toHaveLength(0);
    expect(selectErrorIssues([issue({ createdAt: "2026-06-01T00:00:00Z" })], CUTOFF)).toHaveLength(0);
  });
});

describe("buildHeartbeatMessage", () => {
  const base = {
    nowMs: NOW,
    cutoffMs: CUTOFF,
    firstRun: false,
    context: { sdkVersion: "0.3.170", ccVersion: "2.1.186", lastCheckedMs: Date.parse("2026-06-23T08:00:00Z") },
  };

  test("all quiet when gh ok and no activity", () => {
    const out = buildHeartbeatMessage({ ...base, prsOk: true, issuesOk: true, prs: [], errorIssues: [] });
    expect(out).toContain("alive");
    expect(out).toContain("All quiet");
    expect(out).toContain("SDK on 0.3.170");
  });

  test("gh failure reports 'couldn't check', NOT all-quiet", () => {
    const out = buildHeartbeatMessage({ ...base, prsOk: false, issuesOk: true, prs: [], errorIssues: [] });
    expect(out).toContain("Couldn't check GitHub");
    expect(out).not.toContain("All quiet");
  });

  test("lists updates with outcome + url and the count", () => {
    const out = buildHeartbeatMessage({
      ...base,
      prsOk: true, issuesOk: true,
      prs: [
        pr({ title: "bump claude-agent-sdk 0.3.169 → 0.3.170", mergedAt: "2026-06-23T07:00:00Z", state: "MERGED", url: "https://github.com/o/r/pull/75" }),
        pr({ title: "claude-code parity 2.1.185 → 2.1.186", headRefName: "cc-parity/2.1.186", labels: [{ name: "needs-human" }], url: "https://github.com/o/r/pull/76" }),
      ],
      errorIssues: [],
    });
    expect(out).toContain("2 updates in");
    expect(out).toContain("✅ merged — bump claude-agent-sdk 0.3.169 → 0.3.170");
    expect(out).toContain("https://github.com/o/r/pull/75");
    expect(out).toContain("⚠️ needs attention — claude-code parity 2.1.185 → 2.1.186");
  });

  test("renders error issues section even with zero update PRs", () => {
    const out = buildHeartbeatMessage({
      ...base,
      prsOk: true, issuesOk: true,
      prs: [],
      errorIssues: [{ number: 9, title: "SDK update 0.3.169 → 0.3.170 error", url: "https://github.com/o/r/issues/9", createdAt: "2026-06-23T08:00:00Z" }],
    });
    expect(out).toContain("1 error report opened");
    expect(out).toContain("https://github.com/o/r/issues/9");
    expect(out).not.toContain("All quiet");
  });

  test("singular vs plural for a single update", () => {
    const out = buildHeartbeatMessage({ ...base, prsOk: true, issuesOk: true, prs: [pr({})], errorIssues: [] });
    expect(out).toContain("1 update in");
  });

  test("issue-query failure with no PRs does NOT claim all-quiet", () => {
    // The dangerous false positive: PRs fine + empty, but the error-issue
    // query failed → we can't know it's quiet.
    const out = buildHeartbeatMessage({ ...base, prsOk: true, issuesOk: false, prs: [], errorIssues: [] });
    expect(out).not.toContain("All quiet");
    expect(out).toContain("Couldn't check error reports");
  });
});

describe("gatherActivity", () => {
  const okPrs: PrJson[] = [pr({ headRefName: "sdk-update/0.3.170", createdAt: "2026-06-23T08:00:00Z" })];
  const okIssues: IssueJson[] = [
    { number: 9, title: "SDK update 0.3.169 → 0.3.170 error", url: "u", createdAt: "2026-06-23T08:00:00Z" },
  ];
  // Dispatch on the gh subcommand (args[0] === "pr" | "issue").
  const runner = (onPr: () => unknown, onIssue: () => unknown): GhRunner =>
    (<T>(args: string[]): T => (args[0] === "pr" ? onPr() : onIssue()) as T);

  test("both queries OK → prsOk && issuesOk, windowed results", () => {
    const a = gatherActivity(runner(() => okPrs, () => okIssues), CUTOFF);
    expect(a.prsOk).toBe(true);
    expect(a.issuesOk).toBe(true);
    expect(a.prs).toHaveLength(1);
    expect(a.errorIssues).toHaveLength(1);
  });

  test("issue query throws → issuesOk false (so window must NOT advance), prsOk stays true", () => {
    const a = gatherActivity(
      runner(() => okPrs, () => { throw new Error("rate limited"); }),
      CUTOFF,
    );
    expect(a.prsOk).toBe(true);
    expect(a.issuesOk).toBe(false);
    expect(a.prs).toHaveLength(1);
    expect(a.errorIssues).toHaveLength(0);
  });

  test("PR query throws → prsOk false", () => {
    const a = gatherActivity(
      runner(() => { throw new Error("gh down"); }, () => okIssues),
      CUTOFF,
    );
    expect(a.prsOk).toBe(false);
    expect(a.issuesOk).toBe(true);
  });
});
