import { describe, expect, test } from "vitest";
import {
  ADVISOR_FABLE_VALUE,
  ADVISOR_OPUS_VALUE,
  ADVISOR_SONNET_VALUE,
  advisorPairingRejected,
  canonicalModelId,
  prettyModelName,
} from "@/lib/shared/advisor";

/**
 * Claude Code 2.1.287 — "advisors the API would refuse are flagged up front
 * instead of being silently dropped", and "Sonnet 5.5 can now advise Opus
 * 4.7 and 4.8". The advisor must be at least as capable as the main model.
 */
describe("canonicalModelId", () => {
  test("normalizes dates, [1m] and provider wrapping", () => {
    expect(canonicalModelId("claude-sonnet-5-5")).toBe("claude-sonnet-5-5");
    expect(canonicalModelId("claude-opus-4-8[1m]")).toBe("claude-opus-4-8");
    expect(canonicalModelId("claude-opus-4-20250514")).toBe("claude-opus-4");
    expect(canonicalModelId("claude-sonnet-4-6-20260101")).toBe("claude-sonnet-4-6");
    expect(canonicalModelId("us.anthropic.claude-sonnet-5-5-v1:0")).toBe("claude-sonnet-5-5");
  });

  test("returns null for aliases and junk", () => {
    expect(canonicalModelId("sonnet")).toBeNull();
    expect(canonicalModelId("(active)")).toBeNull();
    expect(canonicalModelId(null)).toBeNull();
  });
});

describe("advisorPairingRejected", () => {
  test("Sonnet 5.5 refuses the Opus 4.8 and Sonnet 5 advisors", () => {
    expect(advisorPairingRejected("claude-sonnet-5-5", ADVISOR_OPUS_VALUE)).toBe(true);
    expect(advisorPairingRejected("claude-sonnet-5-5", ADVISOR_SONNET_VALUE)).toBe(true);
    expect(advisorPairingRejected("claude-sonnet-5-5", ADVISOR_FABLE_VALUE)).toBe(false);
    expect(advisorPairingRejected("claude-sonnet-5-5", "claude-opus-5-5")).toBe(false);
  });

  test("Sonnet 5.5 can advise Opus 4.7 and 4.8", () => {
    expect(advisorPairingRejected("claude-opus-4-8", "claude-sonnet-5-5")).toBe(false);
    expect(advisorPairingRejected("claude-opus-4-7", "claude-sonnet-5-5")).toBe(false);
  });

  test("an advisor weaker than the main model is refused", () => {
    expect(advisorPairingRejected("claude-opus-5-5", ADVISOR_OPUS_VALUE)).toBe(true);
    expect(advisorPairingRejected("claude-opus-4-8", ADVISOR_SONNET_VALUE)).toBe(true);
    expect(advisorPairingRejected("claude-fable-5-1", ADVISOR_FABLE_VALUE)).toBe(true);
  });

  test("the recommended Sonnet-main / Opus-advisor setup still passes on Sonnet 5", () => {
    expect(advisorPairingRejected("claude-sonnet-5", ADVISOR_OPUS_VALUE)).toBe(false);
  });

  test("never flags what it can't resolve", () => {
    expect(advisorPairingRejected("sonnet", ADVISOR_OPUS_VALUE)).toBe(false);
    expect(advisorPairingRejected("claude-sonnet-9", ADVISOR_OPUS_VALUE)).toBe(false);
    expect(advisorPairingRejected("claude-sonnet-5-5", "haiku")).toBe(false);
    expect(advisorPairingRejected(null, ADVISOR_OPUS_VALUE)).toBe(false);
  });
});

describe("prettyModelName", () => {
  test("renders family and version", () => {
    expect(prettyModelName("claude-sonnet-5-5")).toBe("Sonnet 5.5");
    expect(prettyModelName("claude-opus-4-8[1m]")).toBe("Opus 4.8");
    expect(prettyModelName("claude-fable-5")).toBe("Fable 5");
    expect(prettyModelName("sonnet")).toBe("sonnet");
  });
});
