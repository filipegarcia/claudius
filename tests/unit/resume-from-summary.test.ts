import { describe, expect, it } from "vitest";
import {
  RESUME_SUMMARY_MIN_IDLE_MINUTES,
  RESUME_SUMMARY_MIN_TOKENS,
  formatSessionAge,
  formatTokenCount,
  lastActivityAt,
  staleResumeOffer,
} from "@/lib/shared/resume-from-summary";

const MIN = 60_000;
const NOW = Date.UTC(2026, 10, 10, 12, 0, 0);

describe("lastActivityAt", () => {
  it("returns the newest timestamp regardless of order", () => {
    expect(lastActivityAt([{ createdAt: 300 }, { createdAt: 900 }, { createdAt: 500 }])).toBe(900);
  });

  it("skips optimistic (pending) bubbles the model hasn't seen", () => {
    expect(lastActivityAt([{ createdAt: 100 }, { createdAt: 999, pending: true }])).toBe(100);
  });

  it("ignores messages without a usable timestamp", () => {
    expect(lastActivityAt([{}, { createdAt: Number.NaN }, { createdAt: 42 }])).toBe(42);
    expect(lastActivityAt([{}, {}])).toBeNull();
    expect(lastActivityAt([])).toBeNull();
  });
});

describe("staleResumeOffer", () => {
  const stale = NOW - (RESUME_SUMMARY_MIN_IDLE_MINUTES + 65) * MIN;

  it("offers once both the idle and token thresholds are met", () => {
    expect(
      staleResumeOffer({ lastActivityAt: stale, totalTokens: 140_000, now: NOW }),
    ).toEqual({ idleMinutes: RESUME_SUMMARY_MIN_IDLE_MINUTES + 65, tokens: 140_000, lastActivityAt: stale });
  });

  it("thresholds are inclusive, matching the TUI's `<` rejections", () => {
    const atIdle = NOW - RESUME_SUMMARY_MIN_IDLE_MINUTES * MIN;
    expect(
      staleResumeOffer({ lastActivityAt: atIdle, totalTokens: RESUME_SUMMARY_MIN_TOKENS, now: NOW }),
    ).not.toBeNull();
    expect(
      staleResumeOffer({ lastActivityAt: atIdle + 1, totalTokens: RESUME_SUMMARY_MIN_TOKENS, now: NOW }),
    ).toBeNull();
    expect(
      staleResumeOffer({ lastActivityAt: atIdle, totalTokens: RESUME_SUMMARY_MIN_TOKENS - 1, now: NOW }),
    ).toBeNull();
  });

  it("stays quiet for a recent conversation, however large", () => {
    expect(
      staleResumeOffer({ lastActivityAt: NOW - 5 * MIN, totalTokens: 900_000, now: NOW }),
    ).toBeNull();
  });

  it("stays quiet when the reading predates the last message (just sent)", () => {
    expect(
      staleResumeOffer({ lastActivityAt: NOW + MIN, totalTokens: 500_000, now: NOW }),
    ).toBeNull();
  });

  it("stays quiet without a timestamp or a token count", () => {
    expect(staleResumeOffer({ lastActivityAt: null, totalTokens: 500_000, now: NOW })).toBeNull();
    expect(staleResumeOffer({ lastActivityAt: stale, totalTokens: null, now: NOW })).toBeNull();
    expect(staleResumeOffer({ lastActivityAt: stale, totalTokens: undefined, now: NOW })).toBeNull();
  });

  it("honours custom thresholds", () => {
    expect(
      staleResumeOffer({
        lastActivityAt: NOW - 2 * MIN,
        totalTokens: 10,
        now: NOW,
        minIdleMinutes: 1,
        minTokens: 5,
      }),
    ).not.toBeNull();
  });
});

describe("formatSessionAge", () => {
  it.each([
    [0, "0m"],
    [45.9, "45m"],
    [60, "1h"],
    [135, "2h 15m"],
    [24 * 60, "1d"],
    [3 * 24 * 60 + 4 * 60 + 59, "3d 4h"],
    [-5, "0m"],
  ])("%s min → %s", (minutes, expected) => {
    expect(formatSessionAge(minutes)).toBe(expected);
  });
});

describe("formatTokenCount", () => {
  it.each([
    [950, "950"],
    [999.6, "1k"],
    [100_000, "100k"],
    [140_499, "140k"],
    [999_600, "1M"],
    [1_000_000, "1M"],
    [1_250_000, "1.3M"],
  ])("%s → %s", (n, expected) => {
    expect(formatTokenCount(n)).toBe(expected);
  });
});
