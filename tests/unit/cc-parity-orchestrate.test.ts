import { describe, expect, test } from "vitest";

import {
  REQUIRED_RUN_NOTE_SECTIONS,
  buildCcChangelogAnnouncement,
  buildCcFixResultAnnouncement,
  buildCcFixStartAnnouncement,
  buildCcGateResultAnnouncement,
  buildCcImplementationAnnouncement,
  buildCcOpenedAnnouncement,
  buildCcRunIssue,
  buildCcShippedAnnouncement,
  buildCcStartAnnouncement,
  buildCcTestingAnnouncement,
  buildCombinedPreamble,
  ccCompareUrlExported,
  extractCcSection,
  validateCcRunNotesContent,
} from "@/scripts/cc-parity/orchestrate";

/**
 * Unit coverage for the bits unique to the cc-parity orchestrator —
 * the section extractor + validator (which has to handle a heading
 * containing regex metacharacters, `Implemented (bucket B)`), and the
 * announcement builders (whose wording lets the channel tell cc-parity
 * apart from the sdk-update sibling).
 *
 * The pure helpers we reuse from sdk-update (sliceChangelog,
 * summarizeSdkMessage, parseSkipGates, etc.) already have full
 * coverage in sdk-update-orchestrate.test.ts — no need to retest here.
 */

// ── REQUIRED_RUN_NOTE_SECTIONS ────────────────────────────────────────

describe("REQUIRED_RUN_NOTE_SECTIONS", () => {
  test("contains the six cc-parity section names in order", () => {
    expect(REQUIRED_RUN_NOTE_SECTIONS).toEqual([
      "Summary",
      "Changelog classification",
      "Implemented (bucket B)",
      "New UI surfaces",
      "Tests",
      "Risks / follow-ups",
    ]);
  });
});

// ── extractCcSection ──────────────────────────────────────────────────

describe("extractCcSection", () => {
  const sample = [
    "## Summary",
    "Reviewed the release.",
    "",
    "## Changelog classification",
    "- [A] something",
    "- [B] something else",
    "",
    "## Implemented (bucket B)",
    "- shipped slash command /foo",
    "",
    "## Risks / follow-ups",
    "- none",
    "",
  ].join("\n");

  test("returns the body of a plain section, trimmed", () => {
    expect(extractCcSection(sample, "Summary")).toBe("Reviewed the release.");
  });

  test("handles section names containing parens (Implemented (bucket B))", () => {
    // This is the property the sdk-update extractor would silently
    // fail on — its regex interpolates the heading without escaping
    // metacharacters, so the literal "(" / ")" wouldn't match.
    expect(extractCcSection(sample, "Implemented (bucket B)")).toBe(
      "- shipped slash command /foo",
    );
  });

  test("handles section names containing slashes (Risks / follow-ups)", () => {
    expect(extractCcSection(sample, "Risks / follow-ups")).toBe("- none");
  });

  test("returns a clearly-marked placeholder when the section is missing", () => {
    const out = extractCcSection(sample, "Tests");
    expect(out).toMatch(/^_\(run-notes did not include a "Tests" section\)_$/);
  });

  test("handles tail content after the heading", () => {
    const withTail = "## Summary - the one-liner\nshort body\n";
    expect(extractCcSection(withTail, "Summary")).toBe("short body");
  });
});

// ── validateCcRunNotesContent ─────────────────────────────────────────

function fullRunNotes(): string {
  return REQUIRED_RUN_NOTE_SECTIONS.map(
    (heading) =>
      `## ${heading}\n\nLorem ipsum dolor sit amet, consectetur adipiscing elit.\n`,
  ).join("\n");
}

describe("validateCcRunNotesContent", () => {
  test("returns null when every required section has non-trivial content", () => {
    expect(validateCcRunNotesContent(fullRunNotes())).toBeNull();
  });

  test("explicitly recognises the 'Implemented (bucket B)' heading", () => {
    // The literal heading containing parens has to be matched by the
    // validator's escaped-regex interpolation. The fullRunNotes() path
    // exercises this implicitly; this test pins it explicitly so a
    // future refactor that drops the escapeRegExp() call shows up as
    // "missing heading" rather than as a quiet false-negative.
    const md = REQUIRED_RUN_NOTE_SECTIONS.filter(
      (h) => h !== "Implemented (bucket B)",
    )
      .map((heading) => `## ${heading}\n\n${"x".repeat(40)}\n`)
      .join("\n");
    const out = validateCcRunNotesContent(md);
    expect(out).toMatch(/incomplete/);
    expect(out).toContain('"Implemented (bucket B)" heading not found');
  });

  test("flags a single italicised placeholder line", () => {
    const md = REQUIRED_RUN_NOTE_SECTIONS.map(
      (heading) => `## ${heading}\n\n_(TODO: write this section)_\n`,
    ).join("\n");
    const out = validateCcRunNotesContent(md);
    expect(out).toMatch(/incomplete/);
    for (const section of REQUIRED_RUN_NOTE_SECTIONS) {
      expect(out).toContain(`"${section}" section is empty or placeholder`);
    }
  });

  test("flags an empty document with all six section names", () => {
    const out = validateCcRunNotesContent("");
    expect(out).toMatch(/incomplete/);
    for (const section of REQUIRED_RUN_NOTE_SECTIONS) {
      expect(out).toContain(section);
    }
  });

  test("accepts a 21-char body (boundary check)", () => {
    const justEnough = "x".repeat(21);
    const md = REQUIRED_RUN_NOTE_SECTIONS.map(
      (heading) => `## ${heading}\n\n${justEnough}\n`,
    ).join("\n");
    expect(validateCcRunNotesContent(md)).toBeNull();
  });
});

// ── compare URL ───────────────────────────────────────────────────────

describe("ccCompareUrlExported", () => {
  test("points at the upstream claude-code compare view", () => {
    expect(ccCompareUrlExported("1.0.39", "1.0.40")).toBe(
      "https://github.com/anthropics/claude-code/compare/v1.0.39...v1.0.40",
    );
  });
});

// ── Announcement builders ─────────────────────────────────────────────

describe("buildCcStartAnnouncement", () => {
  test("names cc-parity wording and both versions", () => {
    const out = buildCcStartAnnouncement({
      prevVersion: "1.0.39",
      newVersion: "1.0.40",
      branch: "cc-parity/1.0.40",
    });
    expect(out).toContain("New claude-code release");
    expect(out).toContain("1.0.39 → 1.0.40");
    expect(out).toContain("cc-parity/1.0.40");
    expect(out).toContain("parity review");
  });

  test("uses a different emoji than the sdk-update pipeline", () => {
    // The two pipelines deliberately use different lead emojis so the
    // shared channel can distinguish them at a glance.
    const out = buildCcStartAnnouncement({
      prevVersion: "1.0.39",
      newVersion: "1.0.40",
      branch: "cc-parity/1.0.40",
    });
    // sdk-update uses 🆕; cc-parity uses 🆔.
    expect(out).toContain("🆔");
    expect(out).not.toContain("🆕");
  });
});

describe("buildCcChangelogAnnouncement", () => {
  const base = { prevVersion: "1.0.39", newVersion: "1.0.40" };

  test("includes the upstream cc compare link, not the sdk-update one", () => {
    const out = buildCcChangelogAnnouncement({ ...base, changelog: "- one" });
    expect(out).toContain("anthropics/claude-code/compare");
    expect(out).not.toContain("claude-agent-sdk-typescript");
  });

  test("clips an oversized changelog with a 'truncated' marker", () => {
    const huge = "x".repeat(10_000);
    const out = buildCcChangelogAnnouncement({ ...base, changelog: huge });
    expect(out.length).toBeLessThan(2000);
    expect(out).toContain("truncated");
  });
});

describe("buildCcImplementationAnnouncement", () => {
  const base = { prevVersion: "1.0.39", newVersion: "1.0.40" };

  test("uses 'parity review' wording (not 'migration pass')", () => {
    const out = buildCcImplementationAnnouncement({
      ...base,
      summary: "Reviewed the release; shipped one bucket-B item.",
    });
    expect(out).toContain("parity review");
    expect(out).not.toContain("migration pass");
  });

  test("degrades cleanly when Claude left the Summary as a stub", () => {
    const stub = "_(TODO: one paragraph)_";
    const out = buildCcImplementationAnnouncement({ ...base, summary: stub });
    expect(out).toContain("no Summary section in run-notes");
    expect(out).not.toContain("TODO");
  });

  test("prefixes a budget warning when Claude was stopped early", () => {
    const out = buildCcImplementationAnnouncement({
      ...base,
      summary: "Reviewed half the changelog.",
      budgetReason: "wall-clock budget exhausted (360 min)",
    });
    expect(out).toContain("Claude was stopped before completing");
    expect(out).toContain("wall-clock budget exhausted");
    expect(out).toContain("Partial parity review");
  });
});

describe("buildCcTestingAnnouncement", () => {
  test("names the version range and the gate steps", () => {
    const out = buildCcTestingAnnouncement({
      prevVersion: "1.0.39",
      newVersion: "1.0.40",
    });
    expect(out).toContain("cc-parity");
    expect(out).toContain("1.0.39 → 1.0.40");
    expect(out).toContain("lint");
    expect(out).toContain("e2e");
  });
});

describe("buildCcGateResultAnnouncement", () => {
  const base = { prevVersion: "1.0.39", newVersion: "1.0.40" };
  const greenResults = [
    { step: "lint", ok: true },
    { step: "unit", ok: true },
    { step: "build", ok: true },
    { step: "e2e", ok: true },
  ];

  test("green run uses cc-parity wording", () => {
    const out = buildCcGateResultAnnouncement({
      ...base,
      results: greenResults,
      runNotesIssue: null,
      budgetReason: null,
    });
    expect(out).toContain("Local gates green for cc-parity");
    expect(out).toContain("1.0.39 → 1.0.40");
  });

  test("failed gate lists failing steps", () => {
    const out = buildCcGateResultAnnouncement({
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
    expect(out).toContain("Local gates failed for cc-parity");
    expect(out).toContain("Failed: unit, e2e");
    expect(out).toContain("Passed: lint, build");
  });
});

describe("buildCcOpenedAnnouncement", () => {
  const base = {
    prUrl: "https://github.com/o/r/pull/7",
    prevVersion: "1.0.39",
    newVersion: "1.0.40",
  };

  test("uses 'claude-code parity' wording", () => {
    const out = buildCcOpenedAnnouncement({
      ...base,
      created: true,
      draft: false,
      reason: null,
    });
    expect(out).toContain("claude-code parity");
    expect(out).not.toContain("claude-agent-sdk");
  });

  test("draft PR includes the reason", () => {
    const out = buildCcOpenedAnnouncement({
      ...base,
      created: true,
      draft: true,
      reason: "watching CI",
    });
    expect(out).toContain("draft PR opened, needs a human");
    expect(out).toContain("Reason: watching CI");
  });
});

describe("buildCcShippedAnnouncement", () => {
  test("announces the shipped milestone with cc-parity wording", () => {
    const out = buildCcShippedAnnouncement({
      prUrl: "https://github.com/o/r/pull/7",
      prevVersion: "1.0.39",
      newVersion: "1.0.40",
    });
    expect(out).toContain("claude-code parity 1.0.39 → 1.0.40");
    expect(out).toContain("has shipped to Claudius");
  });
});

describe("buildCcFixStartAnnouncement", () => {
  test("identifies this as a CC-parity fix (not an SDK-update fix)", () => {
    const out = buildCcFixStartAnnouncement({
      prNumber: "42",
      title: "feat(cc-parity): claude-code 1.0.39 → 1.0.40",
      url: "https://github.com/o/r/pull/42",
      instruction: "",
    });
    expect(out).toContain("CC-parity PR #42");
    expect(out).not.toContain("Working on PR #42 —"); // sdk-update wording
  });
});

describe("buildCcFixResultAnnouncement", () => {
  test("green result reports success with CC-parity wording", () => {
    const out = buildCcFixResultAnnouncement({
      prNumber: "42",
      title: "feat(cc-parity)",
      url: "https://github.com/o/r/pull/42",
      allGreen: true,
      failedSteps: [],
      markedReady: true,
    });
    expect(out).toContain("CC-parity PR #42");
    expect(out).toContain("marked ready for review");
  });

  test("red result names the failing steps", () => {
    const out = buildCcFixResultAnnouncement({
      prNumber: "42",
      title: "feat(cc-parity)",
      url: "https://github.com/o/r/pull/42",
      allGreen: false,
      failedSteps: ["lint"],
      markedReady: false,
    });
    expect(out).toContain("still red: lint");
  });
});

describe("buildCombinedPreamble", () => {
  test("returns an empty string in standalone mode (no combinedWith arg)", () => {
    expect(buildCombinedPreamble()).toBe("");
    expect(buildCombinedPreamble(undefined)).toBe("");
  });

  test("names both SDK versions and the SDK run-notes path in combined mode", () => {
    const out = buildCombinedPreamble({ sdkPrev: "0.3.141", sdkNew: "0.3.142" });
    expect(out).toContain("Combined-mode");
    expect(out).toContain("0.3.141");
    expect(out).toContain("0.3.142");
    // The preamble must point Claude at the SDK run-notes so it can
    // see what was migrated and avoid re-implementing bucket-A items.
    expect(out).toContain(".claudius/sdk-updater/run-notes/0.3.142.md");
  });

  test("instructs Claude to mark bucket-A items as already-shipped, not re-implement", () => {
    const out = buildCombinedPreamble({ sdkPrev: "0.3.141", sdkNew: "0.3.142" });
    expect(out).toContain("already shipped via SDK migration");
    expect(out).toContain("Bucket-A");
  });
});

describe("buildCcRunIssue", () => {
  const base = {
    prevVersion: "1.0.39",
    newVersion: "1.0.40",
    reason: "lint failed",
    branch: "cc-parity/1.0.40",
    prUrl: "https://github.com/filipegarcia/claudius/pull/100",
  };

  test("uses a 'CC parity' title prefix (NOT 'SDK update')", () => {
    // The dedup title is the single most important thing here — if it
    // ever drifted, every previous firing's issue would be orphaned
    // and a fresh ticket would open every run.
    const { title } = buildCcRunIssue({ ...base, kind: "local gates failed" });
    expect(title).toBe("CC parity 1.0.39 → 1.0.40 error");
    expect(title).not.toContain("SDK update");
  });

  test("collapses every failure kind onto the SAME title", () => {
    const gates = buildCcRunIssue({ ...base, kind: "local gates failed" });
    const ciRed = buildCcRunIssue({ ...base, kind: "CI red on opened PR" });
    const crashed = buildCcRunIssue({ ...base, kind: "crashed" });
    const announce = buildCcRunIssue({ ...base, kind: "chat-server announce failed" });
    expect(gates.title).toBe(ciRed.title);
    expect(gates.title).toBe(crashed.title);
    expect(gates.title).toBe(announce.title);
  });

  test("body breadcrumbs point at .claudius/cc-parity/", () => {
    const { body } = buildCcRunIssue({ ...base, kind: "crashed" });
    expect(body).toContain(".claudius/cc-parity/logs/");
    expect(body).not.toContain(".claudius/sdk-updater/");
  });

  test("comment body distinguishes itself from the original", () => {
    const { body, commentBody } = buildCcRunIssue({ ...base, kind: "crashed" });
    expect(commentBody).toContain("Another failure on this same cc-parity review");
    expect(commentBody).not.toEqual(body);
  });
});
