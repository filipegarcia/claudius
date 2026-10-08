import { describe, expect, test } from "vitest";
import {
  ADVISOR_FABLE_VALUE,
  ADVISOR_OPUS_55_VALUE,
  advisorPickerState,
} from "@/lib/shared/advisor";

/**
 * CC 2.1.295 parity — a saved advisor that's no longer available (Fable on
 * an account whose live model list lacks it) opens on "No advisor" instead
 * of a checkmark on a model the account can't use.
 */
describe("advisorPickerState", () => {
  test("saved Fable + authoritative list without Fable → No advisor + unavailable note", () => {
    expect(
      advisorPickerState(ADVISOR_FABLE_VALUE, { fableAccess: false, authoritative: true }),
    ).toEqual({ current: null, includeFable: false, unavailable: "Fable 5" });
  });

  test("saved Fable + authoritative list with Fable → Fable stays checked", () => {
    expect(
      advisorPickerState(ADVISOR_FABLE_VALUE, { fableAccess: true, authoritative: true }),
    ).toEqual({ current: ADVISOR_FABLE_VALUE, includeFable: true, unavailable: null });
  });

  test("saved Fable without an authoritative list keeps today's behaviour", () => {
    expect(
      advisorPickerState(ADVISOR_FABLE_VALUE, { fableAccess: false, authoritative: false }),
    ).toEqual({ current: ADVISOR_FABLE_VALUE, includeFable: true, unavailable: null });
  });

  test("a non-Fable saved advisor is never flagged", () => {
    expect(
      advisorPickerState(ADVISOR_OPUS_55_VALUE, { fableAccess: false, authoritative: true }),
    ).toEqual({ current: ADVISOR_OPUS_55_VALUE, includeFable: false, unavailable: null });
  });

  test("Fable access adds the Fable row for any saved value", () => {
    expect(
      advisorPickerState(ADVISOR_OPUS_55_VALUE, { fableAccess: true, authoritative: true }),
    ).toEqual({ current: ADVISOR_OPUS_55_VALUE, includeFable: true, unavailable: null });
  });

  test("unset advisor → No advisor, no note", () => {
    expect(advisorPickerState(undefined, { fableAccess: false, authoritative: true })).toEqual({
      current: null,
      includeFable: false,
      unavailable: null,
    });
  });

  test("custom / alias values normalize to null and are never flagged", () => {
    for (const raw of ["claude-haiku-4-5", "fable", "claude-fable-5-1"]) {
      expect(advisorPickerState(raw, { fableAccess: false, authoritative: true })).toEqual({
        current: null,
        includeFable: false,
        unavailable: null,
      });
    }
  });
});
