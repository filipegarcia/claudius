import { describe, expect, test } from "vitest";

import {
  buildCcDroppedAnnouncement,
  buildCombinedGateResultAnnouncement,
  buildCombinedImplementationAnnouncement,
  buildCombinedOpenedAnnouncement,
  buildCombinedScreenshotsBlock,
  buildCombinedShippedAnnouncement,
  buildCombinedStartAnnouncement,
  buildDetachedCcPrBody,
  buildDraftDetachedAnnouncement,
  decideCombinedStateUpdates,
  detachedCcBranchName,
  extractEscapedSection,
  peelCcCommitsToDraftBranch,
  renderCombinedPrBody,
  type GitRunner,
} from "@/scripts/sdk-update/orchestrate";

/**
 * Unit coverage for the combined-mode helpers in
 * `scripts/sdk-update/orchestrate.ts`.
 *
 * Combined mode = the SDK orchestrator opportunistically running the
 * CC parity work on the same branch when both pipelines have new
 * versions on the same hourly firing. The helpers here are the pure
 * pieces of that flow — PR body rendering, state-coordination
 * decision, announcement builders. The side-effectful integration
 * (push, gh, the dynamically-imported CC orchestrator, the
 * peel+cherry-pick path) is covered separately via the git-runner
 * injection tests in the same file once commit 3 lands.
 */

// ── extractEscapedSection ─────────────────────────────────────────────

describe("extractEscapedSection", () => {
  const sample = [
    "## Summary",
    "Bumped both halves.",
    "",
    "## Implemented (bucket B)",
    "- /resume slash command",
    "",
    "## Risks / follow-ups",
    "- none",
    "",
  ].join("\n");

  test("returns the body of a plain section", () => {
    expect(extractEscapedSection(sample, "Summary")).toBe("Bumped both halves.");
  });

  test("handles section names with parens", () => {
    // The combined PR body needs to pull CC's `Implemented (bucket B)`
    // section. Without escapeRegExp() on the heading, the paren acts
    // as a regex grouping char and the literal heading wouldn't match.
    expect(extractEscapedSection(sample, "Implemented (bucket B)")).toBe(
      "- /resume slash command",
    );
  });

  test("returns a marked placeholder when the section is missing", () => {
    expect(extractEscapedSection(sample, "Tests")).toMatch(
      /^_\(run-notes did not include a "Tests" section\)_$/,
    );
  });
});

// ── renderCombinedPrBody ──────────────────────────────────────────────

const COMBINED_TEMPLATE = [
  "# combined {{PREVIOUS_SDK_VERSION}}->{{NEW_SDK_VERSION}} + {{PREVIOUS_CC_VERSION}}->{{NEW_CC_VERSION}}",
  "",
  "{{BUDGET_STATUS}}",
  "",
  "SDK URL: {{SDK_CHANGELOG_URL}}",
  "CC URL: {{CC_CHANGELOG_URL}}",
  "",
  "SDK_BODY_TAG: {{SDK_CHANGELOG_BODY}}",
  "CC_BODY_TAG: {{CC_CHANGELOG_BODY}}",
  "",
  "SDK_SUMMARY: {{SDK_NOTES_SUMMARY}}",
  "SDK_SDK: {{SDK_NOTES_SDK}}",
  "SDK_CODE: {{SDK_NOTES_CODE}}",
  "",
  "CC_SUMMARY: {{CC_NOTES_SUMMARY}}",
  "CC_CLASSIFICATION: {{CC_NOTES_CLASSIFICATION}}",
  "CC_IMPLEMENTED: {{CC_NOTES_IMPLEMENTED}}",
  "",
  "COMBINED_UI: {{COMBINED_NOTES_UI}}",
  "COMBINED_TESTS: {{COMBINED_NOTES_TESTS}}",
  "COMBINED_RISKS: {{COMBINED_NOTES_RISKS}}",
  "",
  "SHOTS: {{COMBINED_SCREENSHOTS_BLOCK}}",
].join("\n");

function fullSdkNotes(): string {
  return [
    "## Summary",
    "Bumped the SDK and migrated session.ts.",
    "",
    "## SDK changelog highlights",
    "- new permission mode (shipped)",
    "",
    "## Code changes",
    "- lib/server/session.ts edited",
    "",
    "## New UI surfaces",
    "- SDK new badge",
    "",
    "## Tests",
    "- vitest +2",
    "",
    "## Risks / follow-ups",
    "- SDK risks: none",
    "",
  ].join("\n");
}

function fullCcNotes(): string {
  return [
    "## Summary",
    "Reviewed the CC release; one bucket-B item shipped.",
    "",
    "## Changelog classification",
    "- [A] feature X (shipped via SDK)",
    "- [B] feature Y (shipped here)",
    "",
    "## Implemented (bucket B)",
    "- Added /resume slash command",
    "",
    "## New UI surfaces",
    "- CC slash-command modal",
    "",
    "## Tests",
    "- playwright +1",
    "",
    "## Risks / follow-ups",
    "- CC risks: revisit shape",
    "",
  ].join("\n");
}

describe("renderCombinedPrBody", () => {
  const base = {
    branch: "sdk-update/0.3.142",
    prevSdkVersion: "0.3.141",
    newSdkVersion: "0.3.142",
    sdkChangelog: "SDK changelog body",
    sdkRunNotes: fullSdkNotes(),
    prevCcVersion: "1.0.39",
    newCcVersion: "1.0.40",
    ccChangelog: "CC changelog body",
    ccRunNotes: fullCcNotes(),
    budgetWarning: "",
    template: COMBINED_TEMPLATE,
    screenshotsBlock: "(test shots)",
  };

  test("substitutes both versions and both changelog URLs", () => {
    const out = renderCombinedPrBody(base);
    expect(out).toContain("0.3.141->0.3.142 + 1.0.39->1.0.40");
    expect(out).toContain(
      "https://github.com/anthropics/claude-agent-sdk-typescript/compare/v0.3.141...v0.3.142",
    );
    expect(out).toContain(
      "https://github.com/anthropics/claude-code/compare/v1.0.39...v1.0.40",
    );
  });

  test("inlines both changelog bodies", () => {
    const out = renderCombinedPrBody(base);
    expect(out).toContain("SDK_BODY_TAG: SDK changelog body");
    expect(out).toContain("CC_BODY_TAG: CC changelog body");
  });

  test("pulls SDK run-notes sections via plain extractor", () => {
    const out = renderCombinedPrBody(base);
    expect(out).toContain("SDK_SUMMARY: Bumped the SDK and migrated session.ts.");
    expect(out).toContain("SDK_SDK: - new permission mode (shipped)");
    expect(out).toContain("SDK_CODE: - lib/server/session.ts edited");
  });

  test("pulls CC run-notes sections via escaped extractor (parens in heading)", () => {
    // CC's "Implemented (bucket B)" heading contains regex
    // metacharacters; if the renderer drops the escape, this assertion
    // catches the silent failure.
    const out = renderCombinedPrBody(base);
    expect(out).toContain("CC_SUMMARY: Reviewed the CC release;");
    expect(out).toContain("CC_CLASSIFICATION: - [A] feature X");
    expect(out).toContain("CC_IMPLEMENTED: - Added /resume slash command");
  });

  test("concatenates UI / Tests / Risks sections from BOTH halves", () => {
    const out = renderCombinedPrBody(base);
    // UI: both halves labelled and present.
    expect(out).toMatch(/COMBINED_UI:[\s\S]*From SDK half:[\s\S]*SDK new badge/);
    expect(out).toMatch(/COMBINED_UI:[\s\S]*From CC parity half:[\s\S]*CC slash-command modal/);
    // Tests: both halves labelled and present.
    expect(out).toMatch(/COMBINED_TESTS:[\s\S]*vitest \+2/);
    expect(out).toMatch(/COMBINED_TESTS:[\s\S]*playwright \+1/);
    // Risks: both halves labelled and present.
    expect(out).toMatch(/COMBINED_RISKS:[\s\S]*SDK risks: none/);
    expect(out).toMatch(/COMBINED_RISKS:[\s\S]*CC risks: revisit shape/);
  });

  test("injects the explicit screenshots block override", () => {
    const out = renderCombinedPrBody({ ...base, screenshotsBlock: "MY_SHOTS" });
    expect(out).toContain("SHOTS: MY_SHOTS");
  });

  test("threads budgetWarning through unchanged", () => {
    const out = renderCombinedPrBody({ ...base, budgetWarning: "**warning**" });
    expect(out).toContain("**warning**");
  });
});

// ── buildCombinedScreenshotsBlock ─────────────────────────────────────

describe("buildCombinedScreenshotsBlock", () => {
  const base = {
    branch: "sdk-update/0.3.142",
    sdkVersion: "0.3.142",
    ccVersion: "1.0.40",
    repoSlug: "filipegarcia/claudius",
  };

  test("returns a 'no screenshots' note when both halves have nothing", () => {
    const out = buildCombinedScreenshotsBlock({
      ...base,
      listSdk: () => [],
      listCc: () => [],
    });
    expect(out).toMatch(/no screenshots/);
  });

  test("emits an SDK section when only SDK shots exist", () => {
    const out = buildCombinedScreenshotsBlock({
      ...base,
      listSdk: () => ["badge.png", "modal.png"],
      listCc: () => [],
    });
    expect(out).toContain("SDK half");
    expect(out).toContain("docs/sdk-updates/0.3.142/");
    expect(out).toContain(
      "https://raw.githubusercontent.com/filipegarcia/claudius/sdk-update/0.3.142/docs/sdk-updates/0.3.142/badge.png",
    );
    expect(out).not.toContain("CC parity half");
  });

  test("emits both sections when both halves have shots", () => {
    const out = buildCombinedScreenshotsBlock({
      ...base,
      listSdk: () => ["sdk.png"],
      listCc: () => ["cc.png"],
    });
    expect(out).toContain("SDK half");
    expect(out).toContain("CC parity half");
    expect(out).toContain("docs/sdk-updates/0.3.142/sdk.png");
    expect(out).toContain("docs/cc-parity/1.0.40/cc.png");
  });
});

// ── decideCombinedStateUpdates ────────────────────────────────────────

describe("decideCombinedStateUpdates", () => {
  test("combined-success patches BOTH state files with new versions", () => {
    const out = decideCombinedStateUpdates({
      mode: "combined-success",
      newSdkVersion: "0.3.142",
      newCcVersion: "1.0.40",
    });
    expect(out.sdkPatch).toEqual({
      inFlight: null,
      lastCompletedVersion: "0.3.142",
    });
    expect(out.ccPatch).toEqual({ lastCompletedVersion: "1.0.40" });
  });

  test("combined-draft patches BOTH state files (so cc cron doesn't refire on the same version)", () => {
    // The CC half drafted as a separate PR but the version IS handled
    // for this round — the standalone CC cron must NOT re-attempt the
    // same version on its next firing.
    const out = decideCombinedStateUpdates({
      mode: "combined-draft",
      newSdkVersion: "0.3.142",
      newCcVersion: "1.0.40",
    });
    expect(out.sdkPatch).toEqual({
      inFlight: null,
      lastCompletedVersion: "0.3.142",
    });
    expect(out.ccPatch).toEqual({ lastCompletedVersion: "1.0.40" });
  });

  test("sdk-failure-cc-draft patches ONLY the CC state (SDK PR is draft, CC drafted separately)", () => {
    // Both halves are drafts — the SDK PR is itself draft+needs-human
    // because SDK CI went red, and the CC half was peeled to a detached
    // draft on its own branch. The version coordination rule for this
    // shape:
    //   - SDK lastCompletedVersion: NOT bumped (the SDK PR didn't ship)
    //   - CC lastCompletedVersion: BUMPED (the CC version IS handled
    //     this firing as a draft on origin; the standalone cron must
    //     not refire and open another branch for the same version)
    // Without this distinction, an SDK CI red + CC drafted run would
    // leave an orphan branch AND duplicate-fire the CC version.
    const out = decideCombinedStateUpdates({
      mode: "sdk-failure-cc-draft",
      newSdkVersion: "0.3.142",
      newCcVersion: "1.0.40",
    });
    expect(out.sdkPatch).toEqual({ inFlight: null });
    expect(out.sdkPatch.lastCompletedVersion).toBeUndefined();
    expect(out.ccPatch).toEqual({ lastCompletedVersion: "1.0.40" });
  });

  test("sdk-failure-cc-draft without a CC version degrades to bare failure", () => {
    // Caller-bug safety net mirroring combined-success/null-cc: if a
    // caller routes through sdk-failure-cc-draft with no CC version,
    // there's nothing to record. Fall back to "failure" semantics so we
    // don't accidentally clear any CC state we shouldn't touch.
    const out = decideCombinedStateUpdates({
      mode: "sdk-failure-cc-draft",
      newSdkVersion: "0.3.142",
      newCcVersion: null,
    });
    expect(out.sdkPatch).toEqual({ inFlight: null });
    expect(out.sdkPatch.lastCompletedVersion).toBeUndefined();
    expect(out.ccPatch).toBeNull();
  });

  test("sdk-only-success patches ONLY the SDK state", () => {
    const out = decideCombinedStateUpdates({
      mode: "sdk-only-success",
      newSdkVersion: "0.3.142",
      newCcVersion: null,
    });
    expect(out.sdkPatch).toEqual({
      inFlight: null,
      lastCompletedVersion: "0.3.142",
    });
    expect(out.ccPatch).toBeNull();
  });

  test("failure patches ONLY the inFlight clear on SDK state", () => {
    const out = decideCombinedStateUpdates({
      mode: "failure",
      newSdkVersion: "0.3.142",
      newCcVersion: null,
    });
    expect(out.sdkPatch).toEqual({ inFlight: null });
    expect(out.sdkPatch.lastCompletedVersion).toBeUndefined();
    expect(out.ccPatch).toBeNull();
  });

  test("combined-success without a CC version falls back to SDK-only (caller-bug safety net)", () => {
    // The shape "combined success with null CC version" can only come
    // from a caller bug. We choose to fail closed: never claim CC
    // shipped if we have no version to record.
    const out = decideCombinedStateUpdates({
      mode: "combined-success",
      newSdkVersion: "0.3.142",
      newCcVersion: null,
    });
    expect(out.sdkPatch.lastCompletedVersion).toBe("0.3.142");
    expect(out.ccPatch).toBeNull();
  });
});

// ── Combined-mode announcement builders ───────────────────────────────

describe("buildCombinedStartAnnouncement", () => {
  test("names both version ranges and both compare URLs", () => {
    const out = buildCombinedStartAnnouncement({
      prevSdkVersion: "0.3.141",
      newSdkVersion: "0.3.142",
      prevCcVersion: "1.0.39",
      newCcVersion: "1.0.40",
      branch: "sdk-update/0.3.142",
    });
    expect(out).toContain("SDK 0.3.141 → 0.3.142");
    expect(out).toContain("CC parity 1.0.39 → 1.0.40");
    expect(out).toContain("sdk-update/0.3.142");
    expect(out).toContain("claude-agent-sdk-typescript/compare/v0.3.141");
    expect(out).toContain("claude-code/compare/v1.0.39");
  });
});

describe("buildCombinedGateResultAnnouncement", () => {
  const base = {
    prevSdkVersion: "0.3.141",
    newSdkVersion: "0.3.142",
    prevCcVersion: "1.0.39",
    newCcVersion: "1.0.40",
  };

  test("both green → 'opening combined PR' line", () => {
    const out = buildCombinedGateResultAnnouncement({
      ...base,
      sdkOk: true,
      ccOk: true,
    });
    expect(out).toContain("Local gates green for combined");
    expect(out).toContain("Opening combined PR");
  });

  test("CC red → names which half failed", () => {
    const out = buildCombinedGateResultAnnouncement({
      ...base,
      sdkOk: true,
      ccOk: false,
    });
    expect(out).toContain("Local gates partial");
    expect(out).toContain("CC parity half failed");
  });
});

describe("buildCombinedImplementationAnnouncement", () => {
  const base = {
    prevSdkVersion: "0.3.141",
    newSdkVersion: "0.3.142",
    prevCcVersion: "1.0.39",
    newCcVersion: "1.0.40",
  };

  test("pairs SDK + CC summaries verbatim when both are real", () => {
    const out = buildCombinedImplementationAnnouncement({
      ...base,
      sdkSummary: "Migrated session.ts and added permission mode.",
      ccSummary: "Reviewed CC release; shipped /resume bucket-B.",
    });
    expect(out).toContain("Claude finished both halves");
    expect(out).toContain("SDK summary:");
    expect(out).toContain("Migrated session.ts and added permission mode.");
    expect(out).toContain("CC parity summary:");
    expect(out).toContain("Reviewed CC release; shipped /resume bucket-B.");
  });

  test("degrades cleanly when SDK Summary is a stub placeholder", () => {
    const out = buildCombinedImplementationAnnouncement({
      ...base,
      sdkSummary: "_(TODO: one paragraph)_",
      ccSummary: "Reviewed release.",
    });
    expect(out).toContain("SDK run-notes Summary missing");
    expect(out).not.toContain("TODO");
    expect(out).toContain("Reviewed release.");
  });

  test("degrades cleanly when CC Summary is missing", () => {
    const out = buildCombinedImplementationAnnouncement({
      ...base,
      sdkSummary: "Migrated session.ts.",
      ccSummary: '_(run-notes did not include a "Summary" section)_',
    });
    expect(out).toContain("CC run-notes Summary missing");
    expect(out).toContain("Migrated session.ts.");
  });
});

describe("buildCombinedOpenedAnnouncement", () => {
  test("names both versions and the PR URL", () => {
    const out = buildCombinedOpenedAnnouncement({
      prUrl: "https://github.com/o/r/pull/7",
      prevSdkVersion: "0.3.141",
      newSdkVersion: "0.3.142",
      prevCcVersion: "1.0.39",
      newCcVersion: "1.0.40",
      created: true,
    });
    expect(out).toContain("Combined upgrade");
    expect(out).toContain("SDK 0.3.141 → 0.3.142");
    expect(out).toContain("CC parity 1.0.39 → 1.0.40");
    expect(out).toContain("https://github.com/o/r/pull/7");
  });
});

describe("buildCombinedShippedAnnouncement", () => {
  test("names both versions and the PR URL", () => {
    const out = buildCombinedShippedAnnouncement({
      prUrl: "https://github.com/o/r/pull/7",
      prevSdkVersion: "0.3.141",
      newSdkVersion: "0.3.142",
      prevCcVersion: "1.0.39",
      newCcVersion: "1.0.40",
    });
    expect(out).toContain("has shipped to Claudius");
    expect(out).toContain("SDK 0.3.141 → 0.3.142");
    expect(out).toContain("CC parity 1.0.39 → 1.0.40");
  });
});

// ── Failure-mode peel + cherry-pick ───────────────────────────────────

describe("detachedCcBranchName", () => {
  test("encodes both CC and SDK versions for at-a-glance triage", () => {
    expect(
      detachedCcBranchName({ newCcVersion: "1.0.40", newSdkVersion: "0.3.142" }),
    ).toBe("cc-parity/1.0.40-detached-from-sdk-0.3.142");
  });
});

/**
 * Recording GitRunner mock: every method appends an entry to `calls`
 * and returns a configured result (or throws if the caller asked for
 * that). Lets tests assert the exact sequence of git operations the
 * failure-mode path issues, without spawning any subprocess.
 */
type CallLog = string[];
function recordingRunner(opts: {
  logResult?: string[];
  cherryPickFailsOn?: string;
  pushFails?: boolean;
}): { runner: GitRunner; calls: CallLog } {
  const calls: CallLog = [];
  const runner: GitRunner = {
    log(fromSha) {
      calls.push(`log ${fromSha}`);
      return opts.logResult ?? [];
    },
    resetHard(sha) {
      calls.push(`reset --hard ${sha}`);
    },
    checkoutNewBranchFromOriginMain(branch) {
      calls.push(`checkout -b ${branch} origin/main`);
    },
    cherryPick(sha) {
      calls.push(`cherry-pick ${sha}`);
      if (opts.cherryPickFailsOn === sha) {
        throw new Error(`mock cherry-pick conflict on ${sha}`);
      }
    },
    cherryPickAbort() {
      calls.push("cherry-pick --abort");
    },
    pushForceWithLease(branch) {
      calls.push(`push -u --force-with-lease origin ${branch}`);
      if (opts.pushFails) {
        throw new Error("mock push rejection");
      }
    },
  };
  return { runner, calls };
}

describe("peelCcCommitsToDraftBranch", () => {
  const base = {
    shaBeforeCcWork: "anchor-sha",
    newSdkVersion: "0.3.142",
    newCcVersion: "1.0.40",
  };
  const expectedBranch = "cc-parity/1.0.40-detached-from-sdk-0.3.142";

  test("happy path: log → reset → checkout → cherry-pick (oldest-first) → push", () => {
    // `git log` is newest-first; the failure path must reverse to
    // cherry-pick chronologically (oldest first). Two commits A then
    // B chronologically → git log returns [B, A] → cherry-pick order
    // must be [A, B].
    const { runner, calls } = recordingRunner({
      logResult: ["sha-B-newest", "sha-A-oldest"],
    });

    const out = peelCcCommitsToDraftBranch({ ...base, runner });

    expect(out.kind).toBe("drafted");
    if (out.kind === "drafted") {
      expect(out.detachedBranch).toBe(expectedBranch);
      // The returned SHA list is oldest-first.
      expect(out.ccCommitShas).toEqual(["sha-A-oldest", "sha-B-newest"]);
    }
    expect(calls).toEqual([
      "log anchor-sha",
      "reset --hard anchor-sha",
      `checkout -b ${expectedBranch} origin/main`,
      "cherry-pick sha-A-oldest",
      "cherry-pick sha-B-newest",
      `push -u --force-with-lease origin ${expectedBranch}`,
    ]);
  });

  test("captures SHAs BEFORE the reset (calling order, not just operations)", () => {
    // Regression guard for the "reset before log" silent-bug:
    // git log <sha>..HEAD is empty AFTER the reset, so capture must
    // happen first. We assert the index of `log` is strictly less
    // than `reset --hard`.
    const { runner, calls } = recordingRunner({
      logResult: ["sha-one"],
    });
    peelCcCommitsToDraftBranch({ ...base, runner });
    const logIdx = calls.findIndex((c) => c.startsWith("log "));
    const resetIdx = calls.findIndex((c) => c.startsWith("reset --hard "));
    expect(logIdx).toBeGreaterThanOrEqual(0);
    expect(resetIdx).toBeGreaterThan(logIdx);
  });

  test("drops if cherry-pick fails AND aborts the cherry-pick (does not push)", () => {
    const { runner, calls } = recordingRunner({
      logResult: ["sha-B-newest", "sha-A-oldest"],
      cherryPickFailsOn: "sha-A-oldest", // first cherry-pick in order
    });

    const out = peelCcCommitsToDraftBranch({ ...base, runner });

    expect(out.kind).toBe("dropped");
    if (out.kind === "dropped") {
      expect(out.reason).toMatch(/cherry-pick of sha-A-oldest/);
    }
    // Must abort, must NOT continue to subsequent cherry-picks, must
    // NOT push the half-applied detached branch.
    expect(calls).toEqual([
      "log anchor-sha",
      "reset --hard anchor-sha",
      `checkout -b ${expectedBranch} origin/main`,
      "cherry-pick sha-A-oldest",
      "cherry-pick --abort",
    ]);
    expect(calls).not.toContain("cherry-pick sha-B-newest");
    expect(calls.find((c) => c.startsWith("push "))).toBeUndefined();
  });

  test("drops if the detached push is rejected (does not patch CC state)", () => {
    const { runner, calls } = recordingRunner({
      logResult: ["sha-one"],
      pushFails: true,
    });
    const out = peelCcCommitsToDraftBranch({ ...base, runner });
    expect(out.kind).toBe("dropped");
    if (out.kind === "dropped") {
      expect(out.reason).toMatch(/push of /);
    }
    // The push attempt should still be in the call log.
    expect(calls).toContain(`push -u --force-with-lease origin ${expectedBranch}`);
  });

  test("drops cleanly when the SHA list is empty (no CC commits to peel)", () => {
    const { runner, calls } = recordingRunner({ logResult: [] });
    const out = peelCcCommitsToDraftBranch({ ...base, runner });
    expect(out.kind).toBe("dropped");
    if (out.kind === "dropped") {
      expect(out.reason).toMatch(/no CC commits to peel/);
    }
    // Crucial: we MUST NOT touch the working tree if there's nothing
    // to peel — no reset, no checkout, no push.
    expect(calls).toEqual(["log anchor-sha"]);
  });
});

// ── Detached-PR body + dual-PR announcement ───────────────────────────

describe("buildDetachedCcPrBody", () => {
  const base = {
    prevCcVersion: "1.0.39",
    newCcVersion: "1.0.40",
    prevSdkVersion: "0.3.141",
    newSdkVersion: "0.3.142",
    sdkPrUrl: "https://github.com/o/r/pull/100",
    ccCommitShas: ["sha-A", "sha-B"],
    ccFailReason: "wall-clock budget exhausted",
    ccRunNotes: "## Changelog classification\n\n- [B] feature Y\n",
  };

  test("names the SDK PR + version ranges + cherry-picked SHAs", () => {
    const out = buildDetachedCcPrBody(base);
    expect(out).toContain("CC parity `1.0.39` → `1.0.40`");
    expect(out).toContain("https://github.com/o/r/pull/100");
    expect(out).toContain("`0.3.141` → `0.3.142`");
    expect(out).toContain("- sha-A");
    expect(out).toContain("- sha-B");
    expect(out).toMatch(/draft \+ needs-human/i);
  });

  test("surfaces the CC failure reason verbatim", () => {
    const out = buildDetachedCcPrBody(base);
    expect(out).toContain("wall-clock budget exhausted");
  });

  test("inlines the CC classification section from the run-notes file (escaped extractor)", () => {
    const out = buildDetachedCcPrBody(base);
    expect(out).toContain("- [B] feature Y");
  });

  test("degrades gracefully when the CC run-notes is empty", () => {
    const out = buildDetachedCcPrBody({ ...base, ccRunNotes: "" });
    // Missing section comes through as the standard placeholder.
    expect(out).toContain("did not include a");
  });

  test("prints a resume command (branch checkout + claude --resume) when a session id is present", () => {
    const out = buildDetachedCcPrBody({
      ...base,
      ccSessionId: "11111111-2222-3333-4444-555555555555",
      detachedBranch: "cc-parity/1.0.40-detached-from-sdk-0.3.142",
    });
    expect(out).toContain("## Continue this run");
    expect(out).toContain("11111111-2222-3333-4444-555555555555");
    // Must check out the detached branch BEFORE resuming — the session
    // ran on the combined branch, not this one.
    expect(out).toContain("git checkout cc-parity/1.0.40-detached-from-sdk-0.3.142");
    expect(out).toContain("claude --resume 11111111-2222-3333-4444-555555555555");
  });

  test("renders a no-session fallback when the session id is absent", () => {
    const out = buildDetachedCcPrBody(base);
    expect(out).toContain("## Continue this run");
    expect(out).toContain("No resumable agent session");
    expect(out).not.toContain("claude --resume");
  });
});

describe("buildDraftDetachedAnnouncement", () => {
  test("names BOTH PR URLs + the failure reason", () => {
    const out = buildDraftDetachedAnnouncement({
      sdkPrUrl: "https://github.com/o/r/pull/100",
      ccPrUrl: "https://github.com/o/r/pull/101",
      prevSdkVersion: "0.3.141",
      newSdkVersion: "0.3.142",
      prevCcVersion: "1.0.39",
      newCcVersion: "1.0.40",
      reason: "cc-parity gate failed: e2e",
    });
    expect(out).toContain("Combined firing split");
    expect(out).toContain("SDK 0.3.141 → 0.3.142");
    expect(out).toContain("CC parity 1.0.39 → 1.0.40");
    expect(out).toContain("https://github.com/o/r/pull/100");
    expect(out).toContain("https://github.com/o/r/pull/101");
    expect(out).toContain("cc-parity gate failed: e2e");
  });
});

describe("buildCcDroppedAnnouncement", () => {
  test("names the SDK PR + the two failure reasons", () => {
    const out = buildCcDroppedAnnouncement({
      sdkPrUrl: "https://github.com/o/r/pull/100",
      prevSdkVersion: "0.3.141",
      newSdkVersion: "0.3.142",
      prevCcVersion: "1.0.39",
      newCcVersion: "1.0.40",
      ccFailReason: "gate failed",
      peelFailReason: "cherry-pick conflict on sha-A",
    });
    expect(out).toContain("Combined firing");
    expect(out).toContain("CC parity 1.0.39 → 1.0.40 dropped");
    expect(out).toContain("CC half failed: gate failed");
    expect(out).toContain("Peel/cherry-pick also failed: cherry-pick conflict on sha-A");
    expect(out).toContain("https://github.com/o/r/pull/100");
    expect(out).toContain("standalone cc-parity cron will re-attempt");
  });
});
