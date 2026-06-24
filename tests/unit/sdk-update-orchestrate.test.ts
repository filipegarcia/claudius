import { describe, expect, test, vi, beforeEach, afterEach } from "vitest";

import {
  REQUIRED_RUN_NOTE_SECTIONS,
  buildChangelogAnnouncement,
  buildFixResultAnnouncement,
  buildFixStartAnnouncement,
  buildGateFailureBanner,
  buildGateResultAnnouncement,
  buildImplementationAnnouncement,
  buildOpenedAnnouncement,
  buildRunIssue,
  buildShippedAnnouncement,
  buildStartAnnouncement,
  buildTestingAnnouncement,
  compareUrl,
  extractSection,
  parseSkipGates,
  pickContinuationPr,
  renderPrBody,
  type OpenPrSummary,
  sliceChangelog,
  sliceSingleSection,
  summarizeSdkMessage,
  validateRunNotesContent,
} from "@/scripts/sdk-update/orchestrate";

/**
 * Unit coverage for the pure helpers in
 * `scripts/sdk-update/orchestrate.ts`.
 *
 * The orchestrator's *side-effectful* halves (git, gh, child-process,
 * the Agent SDK `query()` call) are intentionally not covered here —
 * stubbing them is more harness than the test is worth and the
 * production failure modes are exit codes, not return values.
 *
 * What we do pin down:
 *   - the changelog slicer (drives what Claude sees in its prompt)
 *   - the markdown section extractor (drives what reviewers see in
 *     the PR body)
 *   - the run-notes validator (the gate that catches the empty-PR
 *     failure mode)
 *   - the skip-gates parser (drives which gate steps actually run)
 *
 * All four are pure string-in, string-out (or string-in, Set-out),
 * easy to fixture in-line.
 */

// ── sliceChangelog ────────────────────────────────────────────────────

describe("sliceChangelog", () => {
  const sample = [
    "# Changelog",
    "",
    "## [0.3.142] - 2026-05-15",
    "- new permission mode 'auto'",
    "- deprecated `maxThinkingTokens`",
    "",
    "## [0.3.141] - 2026-05-10",
    "- fixed race in session resume",
    "",
    "## [0.3.140] - 2026-05-05",
    "- initial 0.3.x line",
    "",
  ].join("\n");

  test("returns the slice between newVersion and prevVersion", () => {
    const out = sliceChangelog(sample, "0.3.141", "0.3.142");
    expect(out).toContain("new permission mode 'auto'");
    expect(out).toContain("deprecated `maxThinkingTokens`");
    expect(out).not.toContain("fixed race in session resume");
  });

  test("returns null when the new version isn't found", () => {
    expect(sliceChangelog(sample, "0.3.141", "0.99.0")).toBeNull();
  });

  test("returns from newVersion to end-of-file when prev isn't found", () => {
    // If the changelog only goes back so far, we still return what
    // we can — better than nothing for the human reading the PR.
    const out = sliceChangelog(sample, "0.0.0", "0.3.142");
    expect(out).toContain("new permission mode");
    expect(out).toContain("fixed race");
    expect(out).toContain("initial 0.3.x line");
  });

  test("matches headings with or without brackets and v-prefix", () => {
    const bare = [
      "## 0.3.142",
      "- one",
      "",
      "## 0.3.141",
      "- two",
    ].join("\n");
    expect(sliceChangelog(bare, "0.3.141", "0.3.142")).toContain("- one");

    const vPrefixed = [
      "## v0.3.142",
      "- one",
      "",
      "## v0.3.141",
      "- two",
    ].join("\n");
    expect(sliceChangelog(vPrefixed, "0.3.141", "0.3.142")).toContain("- one");
  });

  test("escapes dots in the version number so they don't act as regex wildcards", () => {
    // If `.` weren't escaped, "0.3.142" would also match "0x3x142".
    // This is a cheap guard against a future refactor breaking it.
    const trick = [
      "## [0x3x142]",
      "- WRONG match",
      "",
      "## [0.3.142]",
      "- right match",
      "",
      "## [0.3.141]",
      "- old",
    ].join("\n");
    const out = sliceChangelog(trick, "0.3.141", "0.3.142");
    expect(out).toContain("right match");
    expect(out).not.toContain("WRONG match");
  });

  test("does not blow up on pathological version strings", () => {
    // CodeQL flagged the old ad-hoc `.replace(/\./g, "\\.")` as
    // incomplete sanitization: a `\` or other regex metachar in the
    // version string would either short-circuit the escape or build
    // an invalid pattern that throws at `new RegExp`. Versions
    // ultimately come from CLI args, so we harden the slicer instead
    // of trusting upstream.
    //
    // The expectation is "returns null cleanly" — we just need to
    // confirm no `SyntaxError` from a malformed regex.
    for (const bad of [
      "0.3.142\\",
      "0.3.142[",
      "(0.3.142)",
      ".*",
      "0|3|142",
    ]) {
      expect(() => sliceChangelog("## [0.3.142]\n- one", "0.3.141", bad)).not.toThrow();
    }
  });
});

describe("sliceSingleSection", () => {
  const sample = [
    "# Changelog",
    "",
    "## 2.1.186",
    "- Added `claude mcp login`",
    "- Fixed a streaming bug",
    "",
    "## 2.1.185",
    "- the stream-stall hint changed",
    "",
  ].join("\n");

  test("returns only the requested version's section", () => {
    const out = sliceSingleSection(sample, "2.1.186");
    expect(out).toContain("Added `claude mcp login`");
    expect(out).toContain("Fixed a streaming bug");
    // Crucially, it stops at the NEXT `## ` heading — unlike
    // sliceChangelog(prev===new), which would run to EOF.
    expect(out).not.toContain("stream-stall hint changed");
  });

  test("returns the last section through EOF when it's the newest", () => {
    const out = sliceSingleSection(sample, "2.1.185");
    expect(out).toContain("stream-stall hint changed");
    expect(out).not.toContain("claude mcp login");
  });

  test("returns null when the version heading is absent", () => {
    expect(sliceSingleSection(sample, "9.9.9")).toBeNull();
  });

  test("does not throw on pathological version strings", () => {
    for (const bad of ["2.1.186\\", "2.1.186[", "(2.1.186)", ".*"]) {
      expect(() => sliceSingleSection(sample, bad)).not.toThrow();
    }
  });
});

describe("renderPrBody — Claude Code changelog section", () => {
  const TEMPLATE = [
    "# bump {{PREVIOUS_VERSION}} -> {{NEW_VERSION}}",
    "{{BUDGET_STATUS}}",
    "{{NOTES_SUMMARY}}",
    "SDK URL: {{CHANGELOG_URL}}",
    "SDK_BODY: {{CHANGELOG_BODY}}",
    "CC URL: {{CC_CHANGELOG_URL}}",
    "CC_BODY: {{CC_CHANGELOG_BODY}}",
    "{{NOTES_SDK}}",
    "{{NOTES_CODE}}",
    "{{NOTES_UI}}",
    "{{NOTES_TESTS}}",
    "{{NOTES_RISKS}}",
    "SHOTS: {{SCREENSHOTS_BLOCK}}",
  ].join("\n");

  const base = {
    branch: "sdk-update/0.3.142",
    prevVersion: "0.3.141",
    newVersion: "0.3.142",
    changelog: "SDK changelog body",
    budgetWarning: "",
    template: TEMPLATE,
    screenshotsBlock: "NO_SHOTS",
  };

  test("substitutes the CC changelog body and URL", () => {
    const out = renderPrBody({
      ...base,
      ccChangelog: "## 2.1.186\n- Added `claude mcp login`",
      ccChangelogUrl: "https://github.com/anthropics/claude-code/releases/tag/v2.1.186",
    });
    expect(out).toContain("CC_BODY: ## 2.1.186");
    expect(out).toContain("Added `claude mcp login`");
    expect(out).toContain(
      "CC URL: https://github.com/anthropics/claude-code/releases/tag/v2.1.186",
    );
    // The SDK changelog still renders alongside it.
    expect(out).toContain("SDK_BODY: SDK changelog body");
  });

  test("never leaves a literal CC placeholder when the caller omits it", () => {
    const out = renderPrBody(base);
    expect(out).not.toContain("{{CC_CHANGELOG_BODY}}");
    expect(out).not.toContain("{{CC_CHANGELOG_URL}}");
    // Falls back to a neutral note pointing at the releases page.
    expect(out).toContain("Claude Code changelog not resolved this run");
  });

  test("the REAL pr-template.md has no unsubstituted placeholders after render", () => {
    // Guards against the template file and the renderer drifting apart:
    // a placeholder added to pr-template.md with no matching `.replace()`
    // (or vice-versa) would ship a literal `{{...}}` in a real PR. We
    // render the on-disk template (no `template` override) and assert
    // nothing is left. screenshotsBlock is stubbed only to avoid a disk
    // walk — the template itself is the real one.
    const out = renderPrBody({
      branch: base.branch,
      prevVersion: base.prevVersion,
      newVersion: base.newVersion,
      changelog: "x",
      ccChangelog: "y",
      ccChangelogUrl: "z",
      budgetWarning: "",
      screenshotsBlock: "NO_SHOTS",
    });
    // Strip the template's HTML doc-comment first: it literally contains
    // `{{...}}` and `{{NEW_VERSION}}`-style examples that are
    // documentation, not rendered output, and would be false positives.
    // Loop until stable so a single pass can't leave a re-formed `<!--`
    // (CodeQL js/incomplete-multi-character-sanitization, alert #58).
    let rendered = out;
    let prev: string;
    do {
      prev = rendered;
      rendered = rendered.replace(/<!--[\s\S]*?-->/g, "");
    } while (rendered !== prev);
    const leftovers = rendered.match(/\{\{[^}]+\}\}/g);
    expect(leftovers).toBeNull();
  });
});

// ── extractSection ────────────────────────────────────────────────────

describe("extractSection", () => {
  const sample = [
    "## Summary",
    "Bumped the SDK.",
    "",
    "## Code changes",
    "- changed session.ts",
    "- bumped deps",
    "",
    "## Risks / follow-ups",
    "- none",
    "",
  ].join("\n");

  test("returns the body of a named section, trimmed", () => {
    expect(extractSection(sample, "Summary")).toBe("Bumped the SDK.");
  });

  test("returns the body of a multi-line section", () => {
    const out = extractSection(sample, "Code changes");
    expect(out).toContain("changed session.ts");
    expect(out).toContain("bumped deps");
  });

  test("handles section names containing slashes (e.g. 'Risks / follow-ups')", () => {
    // The regex was originally built without thinking about slashes
    // in section names; this test guards against a regression where
    // a future maintainer escapes the heading too aggressively.
    expect(extractSection(sample, "Risks / follow-ups")).toBe("- none");
  });

  test("returns a clearly-marked placeholder when the section is missing", () => {
    const out = extractSection(sample, "Tests");
    expect(out).toMatch(/^_\(run-notes did not include a "Tests" section\)_$/);
  });

  test("matches sections even when the heading line has trailing content", () => {
    const withTail = "## Summary - the one-liner version\nshort body\n";
    expect(extractSection(withTail, "Summary")).toBe("short body");
  });
});

// ── validateRunNotesContent ───────────────────────────────────────────

/** Compose a valid run-notes body for use as a "happy path" baseline. */
function fullRunNotes(): string {
  return REQUIRED_RUN_NOTE_SECTIONS.map(
    (heading) =>
      `## ${heading}\n\nLorem ipsum dolor sit amet, consectetur adipiscing elit.\n`,
  ).join("\n");
}

describe("validateRunNotesContent", () => {
  test("returns null when every required section has non-trivial content", () => {
    expect(validateRunNotesContent(fullRunNotes())).toBeNull();
  });

  test("flags a completely empty document", () => {
    const out = validateRunNotesContent("");
    expect(out).toMatch(/incomplete/);
    for (const section of REQUIRED_RUN_NOTE_SECTIONS) {
      expect(out).toContain(section);
    }
  });

  test("flags a document missing a single required section", () => {
    const md = REQUIRED_RUN_NOTE_SECTIONS.filter((h) => h !== "Tests")
      .map((heading) => `## ${heading}\n\n${"x".repeat(40)}\n`)
      .join("\n");
    const out = validateRunNotesContent(md);
    expect(out).toMatch(/"Tests" heading not found/);
    expect(out).not.toMatch(/"Summary" heading not found/);
  });

  test("flags sections that exist but are empty/skeletal", () => {
    // The empty-PR failure mode we're guarding against: Claude
    // writes the headings but doesn't fill them in. Length < 20 +
    // common placeholder tokens trip the check.
    const md = REQUIRED_RUN_NOTE_SECTIONS.map((heading) => `## ${heading}\n\n`).join("\n");
    const out = validateRunNotesContent(md);
    expect(out).toMatch(/incomplete/);
    // Every section should be flagged, since every body is empty.
    for (const section of REQUIRED_RUN_NOTE_SECTIONS) {
      expect(out).toContain(`"${section}" section is empty or placeholder`);
    }
  });

  test("flags common placeholder tokens (TODO/TBD/N/A/(none))", () => {
    for (const placeholder of ["TODO", "TBD", "(none)", "N/A", "- "]) {
      const md = REQUIRED_RUN_NOTE_SECTIONS.map(
        (heading, i) =>
          // Make exactly one section a placeholder, others full.
          i === 0
            ? `## ${heading}\n\n${placeholder}\n`
            : `## ${heading}\n\n${"x".repeat(40)}\n`,
      ).join("\n");
      const out = validateRunNotesContent(md);
      expect(out, `placeholder ${JSON.stringify(placeholder)} should be flagged`).toMatch(
        /empty or placeholder/,
      );
    }
  });

  test("flags the stub's `_(TODO …)_` italicised-placeholder format", () => {
    // Regression: an earlier version of the validator only matched
    // bodies starting with the literal word `TODO`. The stub the
    // orchestrator writes uses `_(TODO: long explanatory text)_`
    // which starts with `_(` and is over the 20-char threshold, so
    // it sailed through validation and produced a useless PR body.
    const stubBody = `_(TODO: one paragraph — what changed in the SDK, what we changed in Claudius.)_`;
    const md = REQUIRED_RUN_NOTE_SECTIONS.map(
      (heading) => `## ${heading}\n\n${stubBody}\n`,
    ).join("\n");
    const out = validateRunNotesContent(md);
    expect(out).toMatch(/incomplete/);
    for (const section of REQUIRED_RUN_NOTE_SECTIONS) {
      expect(out).toContain(`"${section}" section is empty or placeholder`);
    }
  });

  test("flags a single italicised line of any content as placeholder", () => {
    // `_(anything)_` on its own is a Markdown italics-only line and
    // never represents real prose. Belt-and-braces alongside the
    // `_(TODO …)_` check.
    const md = REQUIRED_RUN_NOTE_SECTIONS.map(
      (heading) => `## ${heading}\n\n_(see issue tracker)_\n`,
    ).join("\n");
    const out = validateRunNotesContent(md);
    expect(out).toMatch(/incomplete/);
  });

  test("accepts a section right at the 20-char minimum + 1", () => {
    // Boundary check — body length is the cheap signal; bumping the
    // threshold should be a conscious decision, so pin it.
    const justEnough = "x".repeat(21);
    const md = REQUIRED_RUN_NOTE_SECTIONS.map(
      (heading) => `## ${heading}\n\n${justEnough}\n`,
    ).join("\n");
    expect(validateRunNotesContent(md)).toBeNull();
  });
});

// ── parseSkipGates ────────────────────────────────────────────────────

describe("parseSkipGates", () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    // parseSkipGates calls log() which writes to stdout. We silence
    // it so vitest's runner doesn't print warning lines for the
    // "unknown step" tests.
    warnSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  });
  afterEach(() => {
    warnSpy.mockRestore();
  });

  test("returns an empty set for undefined / empty input", () => {
    expect(parseSkipGates(undefined).size).toBe(0);
    expect(parseSkipGates("").size).toBe(0);
    expect(parseSkipGates("   ").size).toBe(0);
  });

  test("accepts a single step name", () => {
    const out = parseSkipGates("e2e");
    expect(out.has("e2e")).toBe(true);
    expect(out.size).toBe(1);
  });

  test("accepts a comma-separated list and trims whitespace", () => {
    const out = parseSkipGates("lint, unit ,build,e2e");
    expect(out.size).toBe(4);
    for (const step of ["lint", "unit", "build", "e2e"] as const) {
      expect(out.has(step)).toBe(true);
    }
  });

  test("dedupes repeated entries", () => {
    const out = parseSkipGates("e2e,e2e,e2e");
    expect(out.size).toBe(1);
    expect(out.has("e2e")).toBe(true);
  });

  test("ignores unknown step names (does not throw)", () => {
    // Permissive on purpose — we'd rather evolve the gate without
    // breaking old env files.
    const out = parseSkipGates("e2e,bogus,lint");
    expect(out.size).toBe(2);
    expect(out.has("e2e")).toBe(true);
    expect(out.has("lint")).toBe(true);
  });
});

// ── summarizeSdkMessage ───────────────────────────────────────────────

describe("summarizeSdkMessage", () => {
  test("Read tool call surfaces the file path", () => {
    const msg = {
      type: "assistant",
      message: {
        content: [{ type: "tool_use", name: "Read", input: { file_path: "/x/y.ts" } }],
      },
    };
    expect(summarizeSdkMessage(msg)).toBe("type=assistant tool=Read path=/x/y.ts");
  });

  test("Edit and Write tool calls also surface the file path", () => {
    for (const name of ["Edit", "Write", "NotebookEdit"]) {
      const msg = {
        type: "assistant",
        message: {
          content: [{ type: "tool_use", name, input: { file_path: "/a.ts" } }],
        },
      };
      expect(summarizeSdkMessage(msg)).toBe(`type=assistant tool=${name} path=/a.ts`);
    }
  });

  test("Bash tool call shows the command (clipped)", () => {
    const msg = {
      type: "assistant",
      message: {
        content: [
          {
            type: "tool_use",
            name: "Bash",
            input: { command: "bun run lint && bun run test" },
          },
        ],
      },
    };
    const out = summarizeSdkMessage(msg);
    expect(out).toContain("tool=Bash");
    expect(out).toContain("cmd=");
    expect(out).toContain("bun run lint");
  });

  test("Grep/Glob tool calls surface the pattern", () => {
    for (const name of ["Grep", "Glob"]) {
      const msg = {
        type: "assistant",
        message: {
          content: [{ type: "tool_use", name, input: { pattern: "foo.*bar" } }],
        },
      };
      expect(summarizeSdkMessage(msg)).toContain(`tool=${name}`);
      expect(summarizeSdkMessage(msg)).toContain("pattern=");
    }
  });

  test("assistant text block shows a clipped text preview", () => {
    const msg = {
      type: "assistant",
      message: {
        content: [{ type: "text", text: "I'll start by reading the changelog." }],
      },
    };
    expect(summarizeSdkMessage(msg)).toMatch(/type=assistant text=/);
    expect(summarizeSdkMessage(msg)).toContain("I'll start by reading");
  });

  test("tool_use beats text when both blocks are present", () => {
    // Real SDK messages often pair a tool call with a one-liner of
    // surrounding text. The tool name is the more useful signal.
    const msg = {
      type: "assistant",
      message: {
        content: [
          { type: "text", text: "Reading the file now." },
          { type: "tool_use", name: "Read", input: { file_path: "/x.ts" } },
        ],
      },
    };
    expect(summarizeSdkMessage(msg)).toBe("type=assistant tool=Read path=/x.ts");
  });

  test("user tool_result shows size and error flag", () => {
    const ok = {
      type: "user",
      message: {
        content: [{ type: "tool_result", content: "hello", is_error: false }],
      },
    };
    expect(summarizeSdkMessage(ok)).toMatch(/tool_result 5B$/);

    const errored = {
      type: "user",
      message: {
        content: [{ type: "tool_result", content: "oops", is_error: true }],
      },
    };
    expect(summarizeSdkMessage(errored)).toContain("ERROR");
  });

  test("result envelope shows cost + duration + turns", () => {
    const msg = {
      type: "result",
      subtype: "success",
      total_cost_usd: 0.4234,
      duration_ms: 37_500,
      num_turns: 42,
    };
    const out = summarizeSdkMessage(msg);
    expect(out).toContain("subtype=success");
    expect(out).toContain("cost=$0.4234");
    expect(out).toContain("duration=38s");
    expect(out).toContain("turns=42");
  });

  test("falls back to type/subtype for unrecognized shapes", () => {
    expect(summarizeSdkMessage({ type: "system", subtype: "init" })).toContain(
      "type=system",
    );
    expect(summarizeSdkMessage({ type: "system", subtype: "init" })).toContain(
      "subtype=init",
    );
  });

  test("handles malformed messages without throwing", () => {
    expect(() => summarizeSdkMessage(null)).not.toThrow();
    expect(() => summarizeSdkMessage({})).not.toThrow();
    expect(() => summarizeSdkMessage({ type: "assistant", message: null })).not.toThrow();
  });
});

// ── Community-channel announcement builders ───────────────────────────

describe("compareUrl", () => {
  test("points at the upstream compare view between two tags", () => {
    expect(compareUrl("0.3.141", "0.3.142")).toBe(
      "https://github.com/anthropics/claude-agent-sdk-typescript/compare/v0.3.141...v0.3.142",
    );
  });
});

describe("buildOpenedAnnouncement", () => {
  const base = { prUrl: "https://github.com/o/r/pull/7", prevVersion: "0.3.141", newVersion: "0.3.142" };

  test("full PR (not draft) says 'opened, watching CI' and has no reason line", () => {
    const out = buildOpenedAnnouncement({ ...base, created: true, draft: false, reason: null });
    expect(out).toContain("PR opened, watching CI");
    expect(out).not.toMatch(/Reason:/);
    expect(out).toContain(base.prUrl);
    expect(out).toContain(compareUrl(base.prevVersion, base.newVersion));
  });

  test("re-run on an existing PR says 'updated' instead of 'opened'", () => {
    const out = buildOpenedAnnouncement({ ...base, created: false, draft: false, reason: null });
    expect(out).toContain("PR updated, watching CI");
    expect(out).not.toContain("PR opened");
  });

  test("draft PR flags 'needs a human' and includes the reason", () => {
    const out = buildOpenedAnnouncement({
      ...base,
      created: true,
      draft: true,
      reason: "gate failed: lint, e2e",
    });
    expect(out).toContain("draft PR opened, needs a human");
    expect(out).toContain("Reason: gate failed: lint, e2e");
  });

  test("clips an absurdly long draft reason to keep the body under the chat limit", () => {
    const out = buildOpenedAnnouncement({
      ...base,
      created: true,
      draft: true,
      reason: "x".repeat(5000),
    });
    expect(out.length).toBeLessThan(2000);
    expect(out).toContain("…");
  });
});

describe("buildShippedAnnouncement", () => {
  test("announces the ship with the PR + changelog links", () => {
    const out = buildShippedAnnouncement({
      prUrl: "https://github.com/o/r/pull/7",
      prevVersion: "0.3.141",
      newVersion: "0.3.142",
    });
    expect(out).toContain("has shipped to Claudius");
    expect(out).toContain("https://github.com/o/r/pull/7");
    expect(out).toContain(compareUrl("0.3.141", "0.3.142"));
  });
});

describe("buildFixStartAnnouncement", () => {
  const base = { prNumber: "42", title: "bump claude-agent-sdk", url: "https://github.com/o/r/pull/42" };

  test("names the PR number + title and the PR url", () => {
    const out = buildFixStartAnnouncement({ ...base, instruction: "" });
    expect(out).toContain("Working on PR #42");
    expect(out).toContain("bump claude-agent-sdk");
    expect(out).toContain(base.url);
    expect(out).not.toMatch(/Instruction:/);
  });

  test("includes the instruction when one was supplied", () => {
    const out = buildFixStartAnnouncement({ ...base, instruction: "fix the failing e2e" });
    expect(out).toContain("Instruction: fix the failing e2e");
  });
});

// ── Progress announcements (start / changelog / summary / testing) ───

describe("buildStartAnnouncement", () => {
  const base = { prevVersion: "0.3.141", newVersion: "0.3.142", branch: "sdk-update/0.3.142" };

  test("names both versions and the branch the upgrade runs on", () => {
    const out = buildStartAnnouncement(base);
    expect(out).toContain("0.3.141 → 0.3.142");
    expect(out).toContain("sdk-update/0.3.142");
  });

  test("links the upstream compare view so a reader can see the diff", () => {
    const out = buildStartAnnouncement(base);
    expect(out).toContain(compareUrl(base.prevVersion, base.newVersion));
  });

  test("does not embed the changelog body — that's a separate post", () => {
    // We deliberately split start vs. changelog into two messages so
    // the header line stays scannable. A future change that inlines
    // the body would defeat that and make the announce noisy.
    const out = buildStartAnnouncement(base);
    // Header is short — well under the chat-server's 2000-char limit.
    expect(out.length).toBeLessThan(500);
  });

  test("calls out the continuation PR when stacking onto an open one", () => {
    const out = buildStartAnnouncement({ ...base, continuationPrNumber: 48 });
    expect(out).toContain("#48");
    expect(out).toContain("Continuing");
    // Still names versions + branch so the post is self-contained.
    expect(out).toContain("0.3.141 → 0.3.142");
    expect(out).toContain("sdk-update/0.3.142");
  });

  test("omits the continuation wording on a fresh run", () => {
    const out = buildStartAnnouncement(base);
    expect(out).not.toContain("Continuing");
    expect(out).toContain("Starting upgrade");
  });
});

// ── pickContinuationPr — chooses which open PR to stack onto ──────────
describe("pickContinuationPr", () => {
  const pr = (
    number: number,
    headRefName: string,
  ): OpenPrSummary => ({ number, headRefName, url: `https://x/pull/${number}`, title: `pr ${number}` });

  test("returns null when there are no open PRs", () => {
    expect(pickContinuationPr([])).toBeNull();
  });

  test("ignores PRs whose branch is not an sdk-update branch", () => {
    const out = pickContinuationPr([pr(10, "feat/cheatsheet"), pr(11, "fix/login")]);
    expect(out).toBeNull();
  });

  test("returns the single open sdk-update PR with no duplicates", () => {
    const out = pickContinuationPr([pr(48, "sdk-update/0.3.169"), pr(49, "site/flipbook")]);
    expect(out?.number).toBe(48);
    expect(out?.branch).toBe("sdk-update/0.3.169");
    expect(out?.duplicates).toEqual([]);
  });

  test("picks the HIGHEST-version sdk-update PR when several are open", () => {
    // The exact double-PR mess this feature exists to consolidate: 0.3.170
    // shipped, 0.3.171 then shipped before a merge. We continue on the
    // newest (0.3.171) and report the rest as duplicates to close.
    const out = pickContinuationPr([
      pr(48, "sdk-update/0.3.170"),
      pr(50, "sdk-update/0.3.171"),
      pr(46, "sdk-update/0.3.169"),
    ]);
    expect(out?.number).toBe(50);
    expect(out?.branch).toBe("sdk-update/0.3.171");
    expect(out?.duplicates.map((d) => d.number).sort()).toEqual([46, 48]);
  });
});

describe("buildChangelogAnnouncement", () => {
  const base = { prevVersion: "0.3.141", newVersion: "0.3.142" };

  test("includes a short changelog verbatim", () => {
    const out = buildChangelogAnnouncement({
      ...base,
      changelog: "- new permission mode 'auto'\n- deprecated maxThinkingTokens",
    });
    expect(out).toContain("new permission mode");
    expect(out).toContain("deprecated maxThinkingTokens");
    expect(out).not.toContain("truncated");
  });

  test("clips an oversized changelog with a 'truncated' marker", () => {
    // The chat-server caps each message at 2000 chars. We leave ~300
    // chars of headroom for the header + URL, so any post must end up
    // strictly under that limit even with a multi-kilobyte changelog.
    const huge = "x".repeat(10_000);
    const out = buildChangelogAnnouncement({ ...base, changelog: huge });
    expect(out.length).toBeLessThan(2000);
    expect(out).toContain("truncated");
    expect(out).toContain(compareUrl(base.prevVersion, base.newVersion));
  });

  test("passes through the extractChangelog failure placeholder", () => {
    // If extractChangelog fully fails it returns a parenthetical
    // explanation. The channel should still hear that we couldn't
    // fetch the changelog, not get a blank message body.
    const failure = "_(automatic changelog extraction failed — see compare URL)_";
    const out = buildChangelogAnnouncement({ ...base, changelog: failure });
    expect(out).toContain("automatic changelog extraction failed");
  });
});

describe("buildImplementationAnnouncement", () => {
  const base = { prevVersion: "0.3.141", newVersion: "0.3.142" };

  test("includes a real Summary verbatim", () => {
    const out = buildImplementationAnnouncement({
      ...base,
      summary: "Bumped SDK; absorbed the new permission mode in session.ts.",
    });
    expect(out).toContain("finished its migration pass");
    expect(out).toContain("Bumped SDK; absorbed the new permission mode");
  });

  test("falls back to a one-liner when the Summary is still the stub", () => {
    // The orchestrator pre-writes the run-notes file with
    // `_(TODO …)_` placeholders. If Claude died before filling them
    // in, extractSection returns the placeholder — which is the cue
    // for the builder to degrade rather than post a meaningless
    // "Summary: _(TODO: one paragraph …)_" line to the channel.
    const stub = "_(TODO: one paragraph — what changed in the SDK.)_";
    const out = buildImplementationAnnouncement({ ...base, summary: stub });
    expect(out).toContain("no Summary section in run-notes");
    expect(out).not.toContain("TODO");
    expect(out).not.toContain("Summary:");
  });

  test("falls back when the run-notes file was missing entirely", () => {
    // extractSection returns the "did not include a … section"
    // sentinel when the heading is missing. Same fallback applies.
    const missing = `_(run-notes did not include a "Summary" section)_`;
    const out = buildImplementationAnnouncement({ ...base, summary: missing });
    expect(out).toContain("no Summary section in run-notes");
  });

  test("falls back when the summary is empty whitespace", () => {
    const out = buildImplementationAnnouncement({ ...base, summary: "   \n  " });
    expect(out).toContain("no Summary section in run-notes");
  });

  test("clips a very long summary to keep the post under the chat limit", () => {
    const long = "real summary " + "y".repeat(5000);
    const out = buildImplementationAnnouncement({ ...base, summary: long });
    expect(out.length).toBeLessThan(2000);
    expect(out).toContain("…");
  });

  test("prefixes a budget-exhausted warning when Claude was stopped early", () => {
    // runClaude sets budgetReason whenever it had to interrupt the
    // iterator (wall-clock, idle, turn cap, or thrown error). The
    // implementation announce must surface this so the channel knows
    // the summary may reflect partial work — otherwise an operator
    // sees "Claude finished" and trusts a half-done migration.
    const out = buildImplementationAnnouncement({
      ...base,
      summary: "Migrated session.ts.",
      budgetReason: "wall-clock budget exhausted (360 min)",
    });
    expect(out).toContain("Claude was stopped before completing");
    expect(out).toContain("wall-clock budget exhausted");
    expect(out).toContain("Partial migration pass");
    expect(out).toContain("Migrated session.ts.");
    // The "finished its migration pass" wording is reserved for the
    // happy path — it'd misrepresent a budget-killed run.
    expect(out).not.toContain("finished its migration pass");
  });

  test("budget warning also fires when the Summary is still the stub", () => {
    // Common failure mode: idle watchdog trips before Claude got to
    // editing run-notes. We still want the channel to hear WHY the
    // pass ended, not just "no Summary section".
    const out = buildImplementationAnnouncement({
      ...base,
      summary: "_(TODO: one paragraph)_",
      budgetReason: "idle timeout (no SDK message in 15 min)",
    });
    expect(out).toContain("Claude was stopped before completing");
    expect(out).toContain("idle timeout");
    expect(out).toContain("no Summary section in run-notes");
  });

  test("clips an absurdly long budgetReason", () => {
    const out = buildImplementationAnnouncement({
      ...base,
      summary: "real summary",
      budgetReason: "x".repeat(5000),
    });
    expect(out.length).toBeLessThan(2000);
  });
});

describe("buildGateResultAnnouncement", () => {
  const base = { prevVersion: "0.3.141", newVersion: "0.3.142" };
  const greenResults = [
    { step: "lint", ok: true },
    { step: "unit", ok: true },
    { step: "build", ok: true },
    { step: "e2e", ok: true },
  ];

  test("green run reports success and names every gate step that ran", () => {
    const out = buildGateResultAnnouncement({
      ...base,
      results: greenResults,
      runNotesIssue: null,
      budgetReason: null,
    });
    expect(out).toContain("Local gates green");
    expect(out).toContain("0.3.141 → 0.3.142");
    for (const step of ["lint", "unit", "build", "e2e"]) {
      expect(out).toContain(step);
    }
    expect(out).toContain("Opening draft PR");
  });

  test("green-with-skipped run notes the skipped steps separately", () => {
    const out = buildGateResultAnnouncement({
      ...base,
      results: [
        { step: "lint", ok: true },
        { step: "unit", ok: true },
        { step: "build", ok: true },
        { step: "e2e", ok: true, skipped: true },
      ],
      runNotesIssue: null,
      budgetReason: null,
    });
    expect(out).toContain("Local gates green");
    expect(out).toContain("skipped: e2e");
  });

  test("failed gate names the failing steps so reviewers know what broke", () => {
    const out = buildGateResultAnnouncement({
      ...base,
      results: [
        { step: "lint", ok: true },
        { step: "unit", ok: false },
        { step: "build", ok: true },
        { step: "e2e", ok: false },
      ],
      runNotesIssue: null,
      budgetReason: null,
    });
    expect(out).toContain("Local gates failed");
    expect(out).toContain("Failed: unit, e2e");
    expect(out).toContain("Passed: lint, build");
    expect(out).toContain("Not pushing");
  });

  test("failed gate includes the run-notes problem when present", () => {
    const out = buildGateResultAnnouncement({
      ...base,
      results: [
        { step: "lint", ok: false },
        { step: "unit", ok: true },
        { step: "build", ok: true },
        { step: "e2e", ok: true },
      ],
      runNotesIssue: `run-notes file is incomplete: "Summary" section is empty or placeholder`,
      budgetReason: null,
    });
    expect(out).toContain("Failed: lint");
    expect(out).toContain("Run-notes problem:");
    expect(out).toContain("Summary");
  });

  test("includes the budget cause when it adds info beyond the failed list", () => {
    const out = buildGateResultAnnouncement({
      ...base,
      results: [
        { step: "lint", ok: true },
        { step: "unit", ok: false },
        { step: "build", ok: true },
        { step: "e2e", ok: true },
      ],
      runNotesIssue: null,
      budgetReason: "wall-clock budget exhausted (360 min)",
    });
    expect(out).toContain("Cause: wall-clock budget exhausted");
  });

  test("does NOT echo the auto-generated 'Claude reported done but gate failed' reason", () => {
    // main() auto-fills budgetReason with the failed-step list whenever
    // Claude finished cleanly but the gate was red. Echoing that back
    // in the announce body would just duplicate the "Failed:" line.
    const out = buildGateResultAnnouncement({
      ...base,
      results: [
        { step: "lint", ok: false },
        { step: "unit", ok: true },
        { step: "build", ok: true },
        { step: "e2e", ok: true },
      ],
      runNotesIssue: null,
      budgetReason: "Claude reported done but gate failed: lint",
    });
    expect(out).toContain("Failed: lint");
    expect(out).not.toContain("Cause:");
  });

  test("clips an absurdly long budgetReason / runNotesIssue", () => {
    const out = buildGateResultAnnouncement({
      ...base,
      results: [{ step: "lint", ok: false }],
      runNotesIssue: "x".repeat(5000),
      budgetReason: "y".repeat(5000),
    });
    expect(out.length).toBeLessThan(2000);
  });
});

describe("buildTestingAnnouncement", () => {
  test("names the version range and the gate steps about to run", () => {
    const out = buildTestingAnnouncement({ prevVersion: "0.3.141", newVersion: "0.3.142" });
    expect(out).toContain("0.3.141 → 0.3.142");
    expect(out).toContain("lint");
    expect(out).toContain("unit");
    expect(out).toContain("build");
    expect(out).toContain("e2e");
  });
});

describe("buildFixResultAnnouncement", () => {
  const base = { prNumber: "42", title: "bump", url: "https://github.com/o/r/pull/42" };

  test("green result reports success and the ready transition", () => {
    const out = buildFixResultAnnouncement({
      ...base,
      allGreen: true,
      failedSteps: [],
      markedReady: true,
    });
    expect(out).toContain("all gates pass");
    expect(out).toContain("marked ready for review");
  });

  test("green-but-already-ready omits the ready note", () => {
    const out = buildFixResultAnnouncement({
      ...base,
      allGreen: true,
      failedSteps: [],
      markedReady: false,
    });
    expect(out).toContain("all gates pass");
    expect(out).not.toContain("marked ready");
  });

  test("red result lists the failing gate steps", () => {
    const out = buildFixResultAnnouncement({
      ...base,
      allGreen: false,
      failedSteps: ["lint", "e2e"],
      markedReady: false,
    });
    expect(out).toContain("still red: lint, e2e");
  });
});

describe("buildRunIssue", () => {
  const base = {
    prevVersion: "0.3.161",
    newVersion: "0.3.162",
    reason: "lint failed: 3 errors in app/api/foo/route.ts",
    branch: "sdk-update/0.3.162",
    prUrl: "https://github.com/filipegarcia/claudius/pull/29",
  };

  // Title is the dedup key. The shared `fileOrCommentRunIssueSafe`
  // helper does `gh issue list --state open` and looks for an EXACT
  // title match — if this string drifts, every previous firing's
  // issue is orphaned and a fresh ticket opens every run (the bug
  // this whole refactor exists to fix). Pin it here so the drift is
  // caught at test time, not by a duplicate showing up in the GitHub
  // issue list.
  test("collapses every failure kind for one version onto the SAME title", () => {
    const gates = buildRunIssue({ ...base, kind: "local gates failed" });
    const ciRed = buildRunIssue({ ...base, kind: "CI still red after fix attempts" });
    const crashed = buildRunIssue({ ...base, kind: "crashed" });
    const announce = buildRunIssue({ ...base, kind: "chat-server announce failed" });
    const expected = "SDK update 0.3.161 → 0.3.162 error";
    expect(gates.title).toBe(expected);
    expect(ciRed.title).toBe(expected);
    expect(crashed.title).toBe(expected);
    expect(announce.title).toBe(expected);
  });

  test("uses different titles for different version pairs (no false dedup across upgrades)", () => {
    const a = buildRunIssue({ ...base, kind: "crashed" });
    const b = buildRunIssue({
      ...base,
      prevVersion: "0.3.162",
      newVersion: "0.3.163",
      kind: "crashed",
    });
    expect(a.title).not.toBe(b.title);
  });

  test("body embeds the kind, reason, branch, PR, and the run-log breadcrumb", () => {
    const { body } = buildRunIssue({ ...base, kind: "local gates failed" });
    expect(body).toContain("local gates failed");
    expect(body).toContain("lint failed: 3 errors in app/api/foo/route.ts");
    expect(body).toContain("sdk-update/0.3.162");
    expect(body).toContain("https://github.com/filipegarcia/claudius/pull/29");
    // Run-log path is the on-call breadcrumb; if it disappears the
    // issue is much less actionable.
    expect(body).toContain(".claudius/sdk-updater/logs/");
  });

  test("renders null branch and PR as `(none)` so the report stays readable", () => {
    const { body } = buildRunIssue({
      ...base,
      kind: "crashed",
      branch: null,
      prUrl: null,
    });
    expect(body).toContain("**Branch:** `(none)`");
    expect(body).toContain("**PR:** (none)");
  });

  test("renders extras lines verbatim into both body and comment", () => {
    // The swallowed-announce path uses extras to embed chat-server
    // URL + room slug, which a reviewer needs to triage the outage.
    const { body, commentBody } = buildRunIssue({
      ...base,
      kind: "chat-server announce failed",
      extras: [
        "**Chat-server URL:** `https://chat.claudius.network`",
        "**Room slug:** `sdk-update`",
      ],
    });
    expect(body).toContain("`https://chat.claudius.network`");
    expect(body).toContain("`sdk-update`");
    expect(commentBody).toContain("`https://chat.claudius.network`");
    expect(commentBody).toContain("`sdk-update`");
  });

  test("comment body distinguishes itself from the original issue body", () => {
    const { body, commentBody } = buildRunIssue({ ...base, kind: "crashed" });
    // Each subsequent failure comments rather than refiling — its
    // body says "another failure" so a reviewer scanning the issue
    // page can tell follow-ons apart from the original at a glance.
    expect(commentBody).toContain("Another failure");
    expect(commentBody).toContain(base.reason);
    expect(commentBody).not.toEqual(body);
  });
});

// ── buildGateFailureBanner ────────────────────────────────────────────

describe("buildGateFailureBanner", () => {
  test("returns empty string when no step failed", () => {
    // All-green gate → no banner to render. Callers can pass the result
    // straight through to `{{BUDGET_STATUS}}` / issue extras
    // unconditionally without a `?:` guard.
    expect(
      buildGateFailureBanner([
        { step: "lint", ok: true, tailOutput: "tail" },
        { step: "unit", ok: true, tailOutput: "tail" },
      ]),
    ).toBe("");
  });

  test("skipped steps don't trigger a banner", () => {
    // A step skipped via --skip-gates is marked `ok: true, skipped:
    // true`. We treat skipped as not-a-failure for the banner so an
    // operator running locally with SKIP=e2e doesn't get a banner
    // saying "e2e failed".
    expect(
      buildGateFailureBanner([
        { step: "lint", ok: true, tailOutput: "tail" },
        { step: "e2e", ok: true, skipped: true },
      ]),
    ).toBe("");
  });

  test("single failed step renders one collapsible block with the tail", () => {
    const out = buildGateFailureBanner([
      { step: "lint", ok: true, tailOutput: "all green" },
      { step: "unit", ok: true, tailOutput: "all green" },
      { step: "build", ok: true, tailOutput: "all green" },
      {
        step: "e2e",
        ok: false,
        tailOutput:
          "  3 failed\n    [chromium] › tests/e2e/model-picker.spec.ts:253:7 ‹ clicking a model POSTs the new value",
      },
    ]);
    // Headline banner with the heads-up that we drafted + need-human'd.
    expect(out).toContain("Local gate failed");
    expect(out).toContain("needs-human");
    // Lists which step failed.
    expect(out).toContain("`e2e`");
    // Names the actual command so the reviewer can reproduce.
    expect(out).toContain("bun run test:e2e");
    // Embeds the captured tail in a collapsible `<details>` so the
    // banner stays scannable even with multi-screen tails.
    expect(out).toContain("<details>");
    expect(out).toContain("model-picker.spec.ts:253:7");
    // Wraps the tail in a fenced code block so GH renders it
    // verbatim (no markdown interpretation of test-name punctuation).
    expect(out).toContain("```");
  });

  test("multiple failed steps each get their own collapsible block", () => {
    const out = buildGateFailureBanner([
      {
        step: "lint",
        ok: false,
        tailOutput: "8:1  error  'foo' is defined but never used",
      },
      {
        step: "e2e",
        ok: false,
        tailOutput: "1 failed\n  tests/e2e/foo.spec.ts:42",
      },
    ]);
    // Both steps named in the headline list.
    expect(out).toContain("`lint`");
    expect(out).toContain("`e2e`");
    // Both tails embedded.
    expect(out).toContain("'foo' is defined but never used");
    expect(out).toContain("tests/e2e/foo.spec.ts:42");
    // Two collapsible blocks.
    const detailsCount = out.match(/<details>/g)?.length ?? 0;
    expect(detailsCount).toBe(2);
  });

  test("missing tailOutput degrades to a placeholder, not a blank block", () => {
    // If shStreamCapture's child died before producing any output
    // (e.g. spawn ENOENT — bun missing from PATH), `tailOutput` will be
    // empty. We render a clear placeholder so the reviewer doesn't
    // assume the test passed silently.
    const out = buildGateFailureBanner([
      { step: "build", ok: false, tailOutput: "" },
    ]);
    expect(out).toContain("no output captured");
  });
});
