import { describe, expect, test } from "vitest";

import {
  containsOnlyBugFixEntries,
  decide,
  type UpdaterState,
} from "@/scripts/cc-parity/check";

/**
 * Unit coverage for `scripts/cc-parity/check.ts`.
 *
 * The cc-parity pipeline has no package.json range to lean on, so
 * `decide()` is the only thing keeping a freshly-deployed cron from
 * either (a) launching a giant catch-up review on its first firing or
 * (b) staying stuck on "no baseline" forever. Pin both shapes here.
 *
 * `containsOnlyBugFixEntries` is the second gate — a misclassified
 * pure-bug-fix release silently skips a real release, so the false
 * positives matter much more than the false negatives.
 */

// ── containsOnlyBugFixEntries ─────────────────────────────────────────

describe("containsOnlyBugFixEntries", () => {
  test("returns true for the 'Bug fixes and reliability improvements' catch-all", () => {
    expect(
      containsOnlyBugFixEntries("Bug fixes and reliability improvements"),
    ).toBe(true);
  });

  test("returns true when every bullet matches a bug-fix pattern", () => {
    const slice = [
      "- Bug fix: command palette no longer crashes on empty query",
      "- bugfix: trim trailing whitespace from MCP server slugs",
      "- Fixes a hang when the user paused mid-todo",
    ].join("\n");
    expect(containsOnlyBugFixEntries(slice)).toBe(true);
  });

  test("returns false when ANY line is substantive", () => {
    const slice = [
      "- Bug fix: command palette no longer crashes",
      "- Added new /resume slash command",
    ].join("\n");
    expect(containsOnlyBugFixEntries(slice)).toBe(false);
  });

  test("ignores blank lines and markdown headings", () => {
    const slice = [
      "## 1.0.40",
      "",
      "- Bug fix: trim whitespace",
      "",
      "### Acknowledgements",
      "",
      "- bugfix: cleanup",
    ].join("\n");
    expect(containsOnlyBugFixEntries(slice)).toBe(true);
  });

  test("returns false for an empty slice (no signal — DO run)", () => {
    // Critical safety property: when there's nothing to look at we must
    // NOT noop. Empty slices come from upstream changelog blips and
    // slicing misses, and silently dropping a real release is the
    // failure mode the spec calls out by name.
    expect(containsOnlyBugFixEntries("")).toBe(false);
    expect(containsOnlyBugFixEntries("   \n  \n")).toBe(false);
  });

  test("returns false for a headings-only slice (no signal)", () => {
    // Same safety property — a slice that has only markdown headings
    // and no bullets has no bug-fix evidence either way.
    expect(containsOnlyBugFixEntries("## 1.0.40\n### Details\n")).toBe(false);
  });

  test("matches case-insensitively for the catch-all line", () => {
    expect(
      containsOnlyBugFixEntries("BUG FIXES AND RELIABILITY IMPROVEMENTS"),
    ).toBe(true);
  });

  test("does not flag a substantive line that happens to contain 'fix'", () => {
    // "fix" inside prose is not a bug-fix bullet. The leading-bullet
    // guard keeps us from filtering a real feature release that
    // mentions a bug fix in its prose intro.
    const slice = "- Added /resume which can also fix interrupted sessions";
    expect(containsOnlyBugFixEntries(slice)).toBe(false);
  });

  test("handles a mixed bullet/asterisk slice", () => {
    const slice = [
      "* Bug fix: …",
      "- bugfix: …",
      "* Fixes regression in tool-use rendering",
    ].join("\n");
    expect(containsOnlyBugFixEntries(slice)).toBe(true);
  });
});

// ── decide() ──────────────────────────────────────────────────────────

/** Minimal valid state object. Tests override individual fields. */
function emptyState(): UpdaterState {
  return {
    lastCheckedAt: 0,
    lastSeenVersion: null,
    lastCompletedVersion: null,
    inFlight: null,
    skipped: [],
  };
}

describe("decide", () => {
  // ── first-run baseline behavior ─────────────────────────────────────

  test("noops with 'no baseline yet' on the first ever run", () => {
    const d = decide(emptyState(), "1.0.40", { maxMinorJump: 1 });
    expect(d.kind).toBe("noop");
    if (d.kind === "noop") {
      expect(d.reason).toMatch(/no baseline yet/);
      expect(d.current).toBeNull();
      expect(d.latest).toBe("1.0.40");
    }
  });

  test("after baseline is recorded, same-version probe noops cleanly (no stuck-on-first-run)", () => {
    // Regression on the advisor-flagged property: we must NOT stay in
    // the "no baseline" branch forever. main() records
    // lastSeenVersion = latest on the first run; the second firing
    // must therefore see baseline === latest and noop with the normal
    // "already at or ahead" reason.
    const s = emptyState();
    s.lastSeenVersion = "1.0.40";
    const d = decide(s, "1.0.40", { maxMinorJump: 1 });
    expect(d.kind).toBe("noop");
    if (d.kind === "noop") {
      expect(d.reason).toMatch(/already at or ahead/);
    }
  });

  test("after baseline is recorded, a newer release runs with previousVersion = baseline", () => {
    // The companion property: once main() seeded lastSeenVersion, a
    // later firing with a strictly newer latest must produce a run
    // decision whose previousVersion comes from the recorded baseline.
    const s = emptyState();
    s.lastSeenVersion = "1.0.40";
    const d = decide(s, "1.0.41", { maxMinorJump: 1 });
    expect(d.kind).toBe("run");
    if (d.kind === "run") {
      expect(d.previousVersion).toBe("1.0.40");
      expect(d.newVersion).toBe("1.0.41");
    }
  });

  test("lastCompletedVersion takes precedence over lastSeenVersion as the baseline", () => {
    // Real-world flow: we completed 1.0.40 and meanwhile the registry
    // briefly returned 1.0.41 (our last seen). The completed version
    // is the authoritative baseline.
    const s = emptyState();
    s.lastCompletedVersion = "1.0.40";
    s.lastSeenVersion = "1.0.41";
    const d = decide(s, "1.0.40", { maxMinorJump: 99 });
    expect(d.kind).toBe("noop");
  });

  // ── bug-fix-only filter ─────────────────────────────────────────────

  test("noops a bug-fix-only release with a descriptive reason", () => {
    const s = emptyState();
    s.lastSeenVersion = "1.0.40";
    const d = decide(s, "1.0.41", {
      maxMinorJump: 1,
      changelogSlice: "- Bug fix: …\n- bugfix: …",
    });
    expect(d.kind).toBe("noop");
    if (d.kind === "noop") {
      expect(d.reason).toMatch(/bug-fix entries/);
    }
  });

  test("does NOT noop a substantive release even with a partial bug-fix slice", () => {
    const s = emptyState();
    s.lastSeenVersion = "1.0.40";
    const d = decide(s, "1.0.41", {
      maxMinorJump: 1,
      changelogSlice: "- Bug fix: foo\n- Added a new /shipit slash command",
    });
    expect(d.kind).toBe("run");
  });

  test("does NOT noop when the changelog slice is missing (no signal)", () => {
    // Safety property: an absent slice (network blip, slicing miss)
    // must fall through to "run". This is the asymmetry that prevents
    // us from silently skipping a real release the day GitHub's raw
    // file endpoint blips.
    const s = emptyState();
    s.lastSeenVersion = "1.0.40";
    const d = decide(s, "1.0.41", {
      maxMinorJump: 1,
      changelogSlice: null,
    });
    expect(d.kind).toBe("run");
  });

  test("does NOT noop when the changelog slice is empty (no signal)", () => {
    const s = emptyState();
    s.lastSeenVersion = "1.0.40";
    const d = decide(s, "1.0.41", {
      maxMinorJump: 1,
      changelogSlice: "",
    });
    expect(d.kind).toBe("run");
  });

  // ── skipped / completed bookkeeping ─────────────────────────────────

  test("treats a version listed in state.skipped as noop", () => {
    const s = emptyState();
    s.lastSeenVersion = "1.0.40";
    s.skipped = [{ version: "1.0.41", reason: "test", at: 0 }];
    const d = decide(s, "1.0.41", { maxMinorJump: 1 });
    expect(d.kind).toBe("noop");
    if (d.kind === "noop") {
      expect(d.reason).toMatch(/previously skipped/);
    }
  });

  test("treats already-completed version as noop when lastSeenVersion drifted older", () => {
    // Defensive: ordinarily lastCompletedVersion == baseline so latest
    // can't be newer-than-baseline yet equal-to-completed. The branch
    // exists in case lastSeenVersion drifts older than
    // lastCompletedVersion (e.g. a state edit) — the completed value
    // is still authoritative, so we noop.
    const s = emptyState();
    s.lastCompletedVersion = "1.0.41";
    s.lastSeenVersion = "1.0.40";
    // baseline resolves to lastCompletedVersion (= 1.0.41) so latest
    // 1.0.41 is not newer → "already at or ahead" fires first. This
    // documents the precedence rather than asserting an unreachable
    // branch.
    const d = decide(s, "1.0.41", { maxMinorJump: 99 });
    expect(d.kind).toBe("noop");
    if (d.kind === "noop") {
      expect(d.reason).toMatch(/already at or ahead/);
    }
  });

  // ── minor-jump skip ─────────────────────────────────────────────────

  test("returns 'skip' when the minor jump exceeds the budget", () => {
    const s = emptyState();
    s.lastSeenVersion = "1.0.40";
    const d = decide(s, "1.3.0", { maxMinorJump: 1 });
    expect(d.kind).toBe("skip");
    if (d.kind === "skip") {
      expect(d.reason).toMatch(/exceeds MAX_MINOR_JUMP=1/);
    }
  });

  test("respects a wider maxMinorJump", () => {
    const s = emptyState();
    s.lastSeenVersion = "1.0.40";
    const d = decide(s, "1.3.0", { maxMinorJump: 5 });
    expect(d.kind).toBe("run");
  });

  // ── in-flight self-heal ─────────────────────────────────────────────

  test("returns 'in-flight' when an upgrade is freshly in progress", () => {
    const s = emptyState();
    s.lastSeenVersion = "1.0.40";
    s.inFlight = {
      version: "1.0.41",
      branch: "cc-parity/1.0.41",
      startedAt: Date.now() - 60_000,
    };
    const d = decide(s, "1.0.42", { maxMinorJump: 99 });
    expect(d.kind).toBe("in-flight");
    if (d.kind === "in-flight") {
      expect(d.version).toBe("1.0.41");
    }
  });

  test("self-heals when inFlight marker is older than staleInFlightMs", () => {
    const s = emptyState();
    s.lastSeenVersion = "1.0.40";
    s.inFlight = {
      version: "1.0.41",
      branch: "cc-parity/1.0.41",
      startedAt: 1_000,
    };
    const d = decide(s, "1.0.42", {
      maxMinorJump: 99,
      staleInFlightMs: 60_000,
      now: 1_000_000,
    });
    expect(d.kind).toBe("run");
  });

  test("a previously-skipped version stays skipped on subsequent firings", () => {
    // Documents the bookkeeping shape: once a version is added to
    // state.skipped (typically by the CLI on its own MAX_MINOR_JUMP
    // path), decide() must keep noop'ing it even if the operator
    // didn't manually pre-bump. The skipped entry is removed
    // automatically the moment decide() makes a `run` choice for a
    // newer version.
    const s = emptyState();
    s.lastSeenVersion = "1.0.40";
    s.skipped = [{ version: "1.3.0", reason: "minor jump too big", at: 0 }];
    expect(decide(s, "1.3.0", { maxMinorJump: 1 }).kind).toBe("noop");
    // And a newer version still wants to run (skipping doesn't poison
    // future probes for unrelated versions).
    expect(decide(s, "1.0.41", { maxMinorJump: 1 }).kind).toBe("run");
  });
});
