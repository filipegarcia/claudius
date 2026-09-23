import { describe, expect, it } from "vitest";
import {
  STREAM_REBUILD_AFTER_MS,
  STREAM_RECOVERY_MAX_DELAY_MS,
  shouldRebuildTranscript,
  streamRecoveryDelayMs,
} from "@/lib/client/stream-recovery";

describe("streamRecoveryDelayMs", () => {
  it("starts at one second and doubles", () => {
    expect(streamRecoveryDelayMs(0)).toBe(1_000);
    expect(streamRecoveryDelayMs(1)).toBe(2_000);
    expect(streamRecoveryDelayMs(2)).toBe(4_000);
    expect(streamRecoveryDelayMs(3)).toBe(8_000);
  });

  it("caps so an overnight outage can't run away", () => {
    expect(streamRecoveryDelayMs(5)).toBe(STREAM_RECOVERY_MAX_DELAY_MS);
    expect(streamRecoveryDelayMs(50)).toBe(STREAM_RECOVERY_MAX_DELAY_MS);
    expect(streamRecoveryDelayMs(Number.MAX_SAFE_INTEGER)).toBe(
      STREAM_RECOVERY_MAX_DELAY_MS,
    );
  });

  it("never returns a delay a setTimeout would treat as 'immediately'", () => {
    // A 0 / NaN delay turns the retry into a hot loop against a server that
    // is, by definition, already failing.
    for (const bad of [-1, -0.5, NaN, Infinity, -Infinity]) {
      expect(streamRecoveryDelayMs(bad)).toBe(1_000);
    }
    for (let attempt = 0; attempt < 20; attempt++) {
      expect(streamRecoveryDelayMs(attempt)).toBeGreaterThanOrEqual(1_000);
    }
  });
});

describe("shouldRebuildTranscript", () => {
  it("merges a short blip so scroll position and loaded history survive", () => {
    // Well inside the 20-turn replay window: the replayed events overlap what
    // the tab already has and the by-uuid dedup stitches them together.
    expect(shouldRebuildTranscript(0)).toBe(false);
    expect(shouldRebuildTranscript(3_000)).toBe(false);
    expect(shouldRebuildTranscript(STREAM_REBUILD_AFTER_MS)).toBe(false);
  });

  it("rebuilds once the outage can outrun the replay window", () => {
    // Past this the window no longer reaches back to where the tab stopped
    // listening, so merging would leave a stale head, a fresh tail, and an
    // unreachable hole between them.
    expect(shouldRebuildTranscript(STREAM_REBUILD_AFTER_MS + 1)).toBe(true);
    expect(shouldRebuildTranscript(20 * 60 * 1_000)).toBe(true);
  });

  it("rebuilds rather than merges when the outage length is unknowable", () => {
    expect(shouldRebuildTranscript(NaN)).toBe(true);
    expect(shouldRebuildTranscript(Infinity)).toBe(true);
  });

  it("treats a negative clock delta as a blip, not a hole", () => {
    // Wall-clock can go backwards (NTP step, VM resume). Rebuilding on a
    // negative delta would repaint for no reason.
    expect(shouldRebuildTranscript(-5_000)).toBe(false);
  });
});
