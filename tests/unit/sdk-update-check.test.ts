import { describe, expect, test } from "vitest";

import {
  cleanRange,
  decide,
  isNewer,
  minorJumpDistance,
  parseSemver,
  type UpdaterState,
} from "@/scripts/sdk-update/check";

/**
 * Unit coverage for `scripts/sdk-update/check.ts`.
 *
 * These are the pure functions the cron pipeline leans on every hour:
 * a buggy `decide()` either skips an upgrade we should run or runs an
 * upgrade we should skip, both of which are loud failure modes that
 * would burn Anthropic API budget on the wrong work. Worth pinning
 * down.
 *
 * The filesystem + network paths (`readState`, `writeState`,
 * `fetchLatestVersion`) are not covered here; they're thin wrappers
 * over node:fs and `fetch` and aren't worth the harness overhead.
 */

// ── parsing primitives ────────────────────────────────────────────────

describe("cleanRange", () => {
  test("strips caret / tilde / equals / v prefixes", () => {
    expect(cleanRange("^0.3.142")).toBe("0.3.142");
    expect(cleanRange("~1.2.3")).toBe("1.2.3");
    expect(cleanRange("=2.0.0")).toBe("2.0.0");
    expect(cleanRange("v3.1.0")).toBe("3.1.0");
  });

  test("leaves a bare version untouched", () => {
    expect(cleanRange("1.2.3")).toBe("1.2.3");
  });

  test("trims whitespace", () => {
    expect(cleanRange("  ^0.3.0  ")).toBe("0.3.0");
  });
});

describe("parseSemver", () => {
  test("returns the three numeric components", () => {
    expect(parseSemver("1.2.3")).toEqual([1, 2, 3]);
    expect(parseSemver("^0.3.142")).toEqual([0, 3, 142]);
  });

  test("ignores pre-release / build metadata after the patch", () => {
    expect(parseSemver("1.2.3-rc.1")).toEqual([1, 2, 3]);
    expect(parseSemver("1.2.3+build.42")).toEqual([1, 2, 3]);
  });

  test("returns null for non-semver input", () => {
    expect(parseSemver("not-a-version")).toBeNull();
    expect(parseSemver("1.2")).toBeNull();
    expect(parseSemver("")).toBeNull();
  });
});

describe("isNewer", () => {
  test("compares major before minor before patch", () => {
    expect(isNewer("2.0.0", "1.99.99")).toBe(true);
    expect(isNewer("1.3.0", "1.2.99")).toBe(true);
    expect(isNewer("1.2.3", "1.2.2")).toBe(true);
  });

  test("returns false for equal versions", () => {
    expect(isNewer("1.2.3", "1.2.3")).toBe(false);
  });

  test("returns false when candidate is older", () => {
    expect(isNewer("1.2.3", "1.2.4")).toBe(false);
    expect(isNewer("1.2.3", "2.0.0")).toBe(false);
  });

  test("tolerates caret-prefixed baselines (real-world package.json)", () => {
    expect(isNewer("0.3.142", "^0.2.132")).toBe(true);
    expect(isNewer("0.2.132", "^0.2.132")).toBe(false);
  });

  test("returns false when either version is unparseable", () => {
    expect(isNewer("garbage", "1.0.0")).toBe(false);
    expect(isNewer("1.0.0", "garbage")).toBe(false);
  });
});

describe("minorJumpDistance", () => {
  test("returns the minor-axis delta when major matches", () => {
    expect(minorJumpDistance("0.2.0", "0.3.0")).toBe(1);
    expect(minorJumpDistance("0.2.0", "0.5.0")).toBe(3);
    expect(minorJumpDistance("0.3.0", "0.3.99")).toBe(0);
  });

  test("returns Infinity on any major bump (no clean minor distance)", () => {
    expect(minorJumpDistance("0.9.0", "1.0.0")).toBe(Number.POSITIVE_INFINITY);
    expect(minorJumpDistance("1.2.3", "2.0.0")).toBe(Number.POSITIVE_INFINITY);
  });

  test("returns null when either side is unparseable", () => {
    expect(minorJumpDistance("garbage", "1.0.0")).toBeNull();
  });
});

// ── decide() ──────────────────────────────────────────────────────────

/**
 * Helper — minimal valid state object. Tests override individual
 * fields. Kept here rather than as a fixture file so each test reads
 * top-to-bottom without jumping.
 */
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
  test("returns 'noop' when installed is already at latest", () => {
    const d = decide(emptyState(), "^0.3.142", "0.3.142", { maxMinorJump: 1 });
    expect(d.kind).toBe("noop");
    if (d.kind === "noop") {
      expect(d.reason).toMatch(/already at or ahead of latest/);
    }
  });

  test("returns 'noop' when installed is newer than latest (weird, but possible)", () => {
    const d = decide(emptyState(), "^0.4.0", "0.3.142", { maxMinorJump: 1 });
    expect(d.kind).toBe("noop");
  });

  test("returns 'run' for a clean single-minor bump", () => {
    const d = decide(emptyState(), "^0.2.132", "0.3.0", { maxMinorJump: 1 });
    expect(d.kind).toBe("run");
    if (d.kind === "run") {
      expect(d.previousVersion).toBe("0.2.132");
      expect(d.newVersion).toBe("0.3.0");
    }
  });

  test("returns 'run' for a same-minor patch bump", () => {
    const d = decide(emptyState(), "^0.3.142", "0.3.143", { maxMinorJump: 1 });
    expect(d.kind).toBe("run");
  });

  test("returns 'skip' when the minor jump exceeds the budget", () => {
    const d = decide(emptyState(), "^0.2.0", "0.5.0", { maxMinorJump: 1 });
    expect(d.kind).toBe("skip");
    if (d.kind === "skip") {
      expect(d.reason).toMatch(/exceeds MAX_MINOR_JUMP=1/);
    }
  });

  test("returns 'skip' on a major bump even with maxMinorJump > 0", () => {
    const d = decide(emptyState(), "^0.9.0", "1.0.0", { maxMinorJump: 5 });
    expect(d.kind).toBe("skip");
  });

  test("respects a wider maxMinorJump", () => {
    const d = decide(emptyState(), "^0.2.0", "0.5.0", { maxMinorJump: 5 });
    expect(d.kind).toBe("run");
  });

  test("treats a version listed in state.skipped as noop", () => {
    const state = emptyState();
    state.skipped = [{ version: "0.3.0", reason: "test", at: 0 }];
    const d = decide(state, "^0.2.0", "0.3.0", { maxMinorJump: 1 });
    expect(d.kind).toBe("noop");
    if (d.kind === "noop") {
      expect(d.reason).toMatch(/previously skipped/);
    }
  });

  test("treats already-completed version as noop (PR not merged yet)", () => {
    // Real-world flow: orchestrator completed 0.3.142, opened a PR,
    // but the human hasn't merged. package.json still pins ^0.2.132.
    // Without this branch the next cron firing would redo the work.
    const state = emptyState();
    state.lastCompletedVersion = "0.3.142";
    const d = decide(state, "^0.2.132", "0.3.142", { maxMinorJump: 99 });
    expect(d.kind).toBe("noop");
    if (d.kind === "noop") {
      expect(d.reason).toMatch(/already completed 0\.3\.142/);
    }
  });

  test("runs when the new latest is past lastCompletedVersion", () => {
    const state = emptyState();
    state.lastCompletedVersion = "0.3.142";
    const d = decide(state, "^0.2.132", "0.3.143", { maxMinorJump: 99 });
    expect(d.kind).toBe("run");
  });

  // ── self-heal for inFlight ─────────────────────────────────────────

  test("returns 'in-flight' when an upgrade is freshly in progress", () => {
    const state = emptyState();
    state.inFlight = {
      version: "0.3.142",
      branch: "sdk-update/0.3.142",
      startedAt: Date.now() - 60_000, // 1 minute old
    };
    const d = decide(state, "^0.2.132", "0.3.143", { maxMinorJump: 99 });
    expect(d.kind).toBe("in-flight");
    if (d.kind === "in-flight") {
      expect(d.version).toBe("0.3.142");
    }
  });

  test("self-heals when inFlight marker is older than staleInFlightMs", () => {
    // The whole point of the self-heal: a SIGKILL'd run leaves
    // inFlight set forever. Without this branch the cron is bricked
    // until a human edits state.json.
    const state = emptyState();
    state.inFlight = {
      version: "0.3.142",
      branch: "sdk-update/0.3.142",
      startedAt: 1_000,
    };
    const d = decide(state, "^0.2.132", "0.3.143", {
      maxMinorJump: 99,
      staleInFlightMs: 60_000,
      now: 1_000_000, // ~16 minutes later, way past 60s threshold
    });
    expect(d.kind).toBe("run");
  });

  test("default stale threshold (24h) honors borderline cases", () => {
    const now = Date.now();
    const state = emptyState();
    state.inFlight = {
      version: "0.3.142",
      branch: "sdk-update/0.3.142",
      startedAt: now - 23 * 60 * 60 * 1000, // 23h — still active
    };
    expect(decide(state, "^0.2.132", "0.3.143", { maxMinorJump: 99, now }).kind).toBe(
      "in-flight",
    );

    state.inFlight.startedAt = now - 25 * 60 * 60 * 1000; // 25h — stale
    expect(decide(state, "^0.2.132", "0.3.143", { maxMinorJump: 99, now }).kind).toBe(
      "run",
    );
  });
});
