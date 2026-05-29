import { describe, expect, test, vi, beforeEach, afterEach } from "vitest";

import {
  REQUIRED_RUN_NOTE_SECTIONS,
  buildFixResultAnnouncement,
  buildFixStartAnnouncement,
  buildOpenedAnnouncement,
  buildShippedAnnouncement,
  compareUrl,
  extractSection,
  parseSkipGates,
  sliceChangelog,
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
