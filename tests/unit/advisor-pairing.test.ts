import { describe, expect, test } from "vitest";
import {
  ADVISOR_FABLE_VALUE,
  ADVISOR_OPTIONS,
  ADVISOR_OPUS_55_VALUE,
  ADVISOR_OPUS_VALUE,
  ADVISOR_SONNET_VALUE,
  advisorFamily,
  advisorOptions,
  advisorPairingRejected,
  badgeAdvisorLabel,
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

describe("advisor options — Opus 5.5 recommended", () => {
  test("Opus 5.5 is the first, recommended row and the only recommended one", () => {
    expect(ADVISOR_OPTIONS.map((o) => o.value)).toEqual([
      ADVISOR_OPUS_55_VALUE,
      ADVISOR_OPUS_VALUE,
      ADVISOR_SONNET_VALUE,
      null,
    ]);
    expect(ADVISOR_OPTIONS.filter((o) => o.recommended).map((o) => o.value)).toEqual([ADVISOR_OPUS_55_VALUE]);
    // Fable slots in just before "No advisor".
    expect(advisorOptions(true).map((o) => o.value)).toEqual([
      ADVISOR_OPUS_55_VALUE,
      ADVISOR_OPUS_VALUE,
      ADVISOR_SONNET_VALUE,
      ADVISOR_FABLE_VALUE,
      null,
    ]);
  });

  test("the recommended advisor is accepted for every current non-Fable-5.1 main model", () => {
    for (const main of [
      "claude-haiku-4-5",
      "claude-sonnet-4-6",
      "claude-sonnet-5",
      "claude-sonnet-5-5",
      "claude-opus-4-8",
      "claude-opus-5",
      "claude-opus-5-5",
    ]) {
      expect(advisorPairingRejected(main, ADVISOR_OPUS_55_VALUE)).toBe(false);
    }
  });

  test("family matching splits the two Opus rows by generation", () => {
    expect(advisorFamily("opus")).toBe(ADVISOR_OPUS_55_VALUE);
    expect(advisorFamily("claude-opus-5")).toBe(ADVISOR_OPUS_55_VALUE);
    expect(advisorFamily("claude-opus-4-7")).toBe(ADVISOR_OPUS_VALUE);
    expect(advisorFamily("claude-opus-4-8-20260101")).toBe(ADVISOR_OPUS_VALUE);
    expect(badgeAdvisorLabel(ADVISOR_OPUS_55_VALUE)).toBe("opus 5.5");
    expect(badgeAdvisorLabel(ADVISOR_OPUS_VALUE)).toBe("opus 4.8");
  });
});

/**
 * CC 2.1.293 — Claude Haiku 5.5. Rows from the Claude API advisor pairing
 * table: as an executor it takes Sonnet 5's advisors plus itself; as an
 * advisor it is accepted by Haiku 4.5, Sonnet 4.6, Sonnet 5 and Opus 4.6.
 */
describe("advisorPairingRejected — Haiku 5.5 (CC 2.1.293)", () => {
  test("a Haiku 5.5 executor accepts Sonnet 5's advisors and itself", () => {
    for (const advisor of [
      "claude-opus-5-5",
      "claude-fable-5-1",
      "claude-opus-4-8",
      "claude-opus-4-7",
      "claude-sonnet-5-5",
      "claude-sonnet-5",
      "claude-haiku-5-5",
    ]) {
      expect(advisorPairingRejected("claude-haiku-5-5", advisor)).toBe(false);
    }
  });

  test("a Haiku 5.5 executor refuses the advisors below it", () => {
    for (const advisor of ["claude-opus-4-6", "claude-sonnet-4-6", "claude-haiku-4-5"]) {
      expect(advisorPairingRejected("claude-haiku-5-5", advisor)).toBe(true);
    }
  });

  test("Haiku 5.5 is a valid advisor for Haiku 4.5, Sonnet 4.6, Sonnet 5 and Opus 4.6", () => {
    for (const executor of ["claude-haiku-4-5", "claude-sonnet-4-6", "claude-sonnet-5", "claude-opus-4-6"]) {
      expect(advisorPairingRejected(executor, "claude-haiku-5-5")).toBe(false);
    }
  });

  test("…and refused by the executors above it", () => {
    for (const executor of ["claude-sonnet-5-5", "claude-opus-4-7", "claude-opus-4-8", "claude-opus-5-5", "claude-fable-5-1"]) {
      expect(advisorPairingRejected(executor, "claude-haiku-5-5")).toBe(true);
    }
  });
});
