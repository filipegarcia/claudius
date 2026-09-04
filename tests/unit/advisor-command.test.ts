import { describe, expect, test } from "vitest";
import {
  ADVISOR_FABLE_VALUE,
  ADVISOR_OPUS_VALUE,
  ADVISOR_SONNET_VALUE,
  resolveAdvisorCommandArg,
} from "@/lib/shared/advisor";

/**
 * Unit tests for the text form of `/advisor` — CC 2.1.260 parity for
 * `/advisor`, `/advisor <model>`, and `/advisor off`. See
 * `resolveAdvisorCommandArg`'s doc comment for the full contract; this
 * exercises it directly rather than through ChatSurface's chat composer.
 */
describe("resolveAdvisorCommandArg", () => {
  test("no argument opens the picker", () => {
    expect(resolveAdvisorCommandArg("")).toEqual({ action: "open-picker" });
    expect(resolveAdvisorCommandArg("   ")).toEqual({ action: "open-picker" });
  });

  test("'off' (any case) clears the advisor", () => {
    expect(resolveAdvisorCommandArg("off")).toEqual({ action: "set", choice: null });
    expect(resolveAdvisorCommandArg("OFF")).toEqual({ action: "set", choice: null });
    expect(resolveAdvisorCommandArg("  Off  ")).toEqual({ action: "set", choice: null });
  });

  test("a verbatim product-blessed id resolves directly", () => {
    expect(resolveAdvisorCommandArg(ADVISOR_OPUS_VALUE)).toEqual({
      action: "set",
      choice: ADVISOR_OPUS_VALUE,
    });
    expect(resolveAdvisorCommandArg(ADVISOR_SONNET_VALUE)).toEqual({
      action: "set",
      choice: ADVISOR_SONNET_VALUE,
    });
    expect(resolveAdvisorCommandArg(ADVISOR_FABLE_VALUE)).toEqual({
      action: "set",
      choice: ADVISOR_FABLE_VALUE,
    });
  });

  test("family aliases resolve like the picker's own tolerance", () => {
    expect(resolveAdvisorCommandArg("opus")).toEqual({
      action: "set",
      choice: ADVISOR_OPUS_VALUE,
    });
    expect(resolveAdvisorCommandArg("Sonnet")).toEqual({
      action: "set",
      choice: ADVISOR_SONNET_VALUE,
    });
    expect(resolveAdvisorCommandArg("fable")).toEqual({
      action: "set",
      choice: ADVISOR_FABLE_VALUE,
    });
    // Older full id, still in the opus family.
    expect(resolveAdvisorCommandArg("claude-opus-4-7")).toEqual({
      action: "set",
      choice: ADVISOR_OPUS_VALUE,
    });
  });

  test("an unrecognized value is reported invalid, not silently dropped", () => {
    expect(resolveAdvisorCommandArg("haiku")).toEqual({ action: "invalid", raw: "haiku" });
    expect(resolveAdvisorCommandArg("banana")).toEqual({ action: "invalid", raw: "banana" });
  });
});
