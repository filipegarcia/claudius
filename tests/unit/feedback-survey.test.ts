import { afterEach, describe, expect, test } from "vitest";

import {
  coerceSurveyRate,
  DEFAULT_FEEDBACK_SURVEY_RATE,
  getLastSurveyShownAt,
  noteSurveyShown,
  resetSurveyThrottle,
  shouldOfferSurvey,
  SURVEY_MIN_INTERVAL_MS,
} from "@/lib/server/feedback-survey";

afterEach(() => {
  resetSurveyThrottle();
});

describe("coerceSurveyRate", () => {
  test("passes through a valid probability", () => {
    expect(coerceSurveyRate(0.2)).toBe(0.2);
    expect(coerceSurveyRate(0)).toBe(0);
    expect(coerceSurveyRate(1)).toBe(1);
  });

  test("clamps out-of-range numbers", () => {
    expect(coerceSurveyRate(-1)).toBe(0);
    expect(coerceSurveyRate(5)).toBe(1);
  });

  test("falls back to the default for non-numbers", () => {
    expect(coerceSurveyRate(undefined)).toBe(DEFAULT_FEEDBACK_SURVEY_RATE);
    expect(coerceSurveyRate("0.5")).toBe(DEFAULT_FEEDBACK_SURVEY_RATE);
    expect(coerceSurveyRate(Number.NaN)).toBe(DEFAULT_FEEDBACK_SURVEY_RATE);
  });
});

describe("shouldOfferSurvey", () => {
  const base = {
    rate: 1,
    isError: false,
    sawUserInput: true,
    now: SURVEY_MIN_INTERVAL_MS + 1,
    lastShownAt: 0,
    random: 0.0,
  };

  test("offers when every gate passes", () => {
    expect(shouldOfferSurvey(base)).toBe(true);
  });

  test("never offers after an errored turn", () => {
    expect(shouldOfferSurvey({ ...base, isError: true })).toBe(false);
  });

  test("never offers without real user input (automated runs)", () => {
    expect(shouldOfferSurvey({ ...base, sawUserInput: false })).toBe(false);
  });

  test("never offers when the rate is zero", () => {
    expect(shouldOfferSurvey({ ...base, rate: 0 })).toBe(false);
  });

  test("respects the throttle window", () => {
    expect(
      shouldOfferSurvey({ ...base, now: 100, lastShownAt: 50 }),
    ).toBe(false);
  });

  test("respects the probability roll", () => {
    expect(shouldOfferSurvey({ ...base, rate: 0.05, random: 0.5 })).toBe(false);
    expect(shouldOfferSurvey({ ...base, rate: 0.05, random: 0.01 })).toBe(true);
  });
});

describe("throttle state", () => {
  test("noteSurveyShown advances the timestamp", () => {
    expect(getLastSurveyShownAt()).toBe(0);
    noteSurveyShown(12345);
    expect(getLastSurveyShownAt()).toBe(12345);
    resetSurveyThrottle();
    expect(getLastSurveyShownAt()).toBe(0);
  });
});
