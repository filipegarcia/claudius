import { describe, expect, test } from "vitest";
import { normalizeGithubPr, normalizeGitlabMr, prBadgeLabel } from "@/lib/shared/pr-badge";

/**
 * CC 2.1.234 (H7) — normalize `gh pr view` / `glab mr view` JSON into one badge.
 */
describe("normalizeGithubPr (H7)", () => {
  test("open PR with passing checks", () => {
    expect(
      normalizeGithubPr({
        number: 123,
        state: "OPEN",
        isDraft: false,
        url: "https://github.com/o/r/pull/123",
        title: "Add thing",
        statusCheckRollup: [{ status: "COMPLETED", conclusion: "SUCCESS" }],
      }),
    ).toEqual({
      host: "github",
      number: 123,
      url: "https://github.com/o/r/pull/123",
      title: "Add thing",
      state: "open",
      checks: "passing",
    });
  });

  test("draft OPEN → draft; failing check beats pending/passing", () => {
    const b = normalizeGithubPr({
      number: 9,
      state: "OPEN",
      isDraft: true,
      url: "u",
      statusCheckRollup: [
        { status: "IN_PROGRESS" },
        { status: "COMPLETED", conclusion: "FAILURE" },
        { status: "COMPLETED", conclusion: "SUCCESS" },
      ],
    });
    expect(b?.state).toBe("draft");
    expect(b?.checks).toBe("failing");
  });

  test("merged / closed states; pending when only in-progress", () => {
    expect(normalizeGithubPr({ number: 1, state: "MERGED", url: "u" })?.state).toBe("merged");
    expect(normalizeGithubPr({ number: 1, state: "CLOSED", url: "u" })?.state).toBe("closed");
    expect(
      normalizeGithubPr({ number: 1, state: "OPEN", url: "u", statusCheckRollup: [{ status: "QUEUED" }] })?.checks,
    ).toBe("pending");
    // No checks → "none".
    expect(normalizeGithubPr({ number: 1, state: "OPEN", url: "u" })?.checks).toBe("none");
  });

  test("unusable shape → null", () => {
    expect(normalizeGithubPr(null)).toBeNull();
    expect(normalizeGithubPr({ state: "OPEN" })).toBeNull();
  });
});

describe("normalizeGitlabMr (H7)", () => {
  test("open MR (iid) with passing pipeline", () => {
    expect(
      normalizeGitlabMr({
        iid: 45,
        state: "opened",
        draft: false,
        web_url: "https://gitlab.com/o/r/-/merge_requests/45",
        title: "Fix",
        pipeline: { status: "success" },
      }),
    ).toEqual({
      host: "gitlab",
      number: 45,
      url: "https://gitlab.com/o/r/-/merge_requests/45",
      title: "Fix",
      state: "open",
      checks: "passing",
    });
  });

  test("work_in_progress → draft; failed pipeline → failing; head_pipeline fallback", () => {
    expect(normalizeGitlabMr({ iid: 1, state: "opened", work_in_progress: true, web_url: "u" })?.state).toBe("draft");
    expect(normalizeGitlabMr({ iid: 1, state: "opened", web_url: "u", pipeline: { status: "failed" } })?.checks).toBe("failing");
    expect(
      normalizeGitlabMr({ iid: 1, state: "opened", web_url: "u", head_pipeline: { status: "running" } })?.checks,
    ).toBe("pending");
  });

  test("merged/closed; unusable shape → null", () => {
    expect(normalizeGitlabMr({ iid: 2, state: "merged", web_url: "u" })?.state).toBe("merged");
    expect(normalizeGitlabMr({ state: "opened" })).toBeNull();
  });
});

describe("prBadgeLabel (H7)", () => {
  test("GitHub uses PR #, GitLab uses MR !", () => {
    expect(prBadgeLabel({ host: "github", number: 7, url: "", state: "open", checks: "none" })).toBe("PR #7");
    expect(prBadgeLabel({ host: "gitlab", number: 7, url: "", state: "open", checks: "none" })).toBe("MR !7");
  });
});
