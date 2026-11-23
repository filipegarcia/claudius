import { describe, expect, test } from "vitest";

import { findModelEntry, stripOneMTag } from "@/lib/shared/model-id";

/**
 * CC 2.1.316 — "[VSCode] Fixed the missing Effort slider, Ultracode switch and
 * model name when the model setting has the [1m] tag, such as opus[1m]".
 *
 * The engine's `supportedModels()` lists Opus 5.5 as plain `opus` (the `[1m]`
 * tag has no effect there), so the ModelPicker's exact `value` match missed a
 * session on `opus[1m]`. `findModelEntry` is the shared lookup the picker and
 * the SessionCard's bare-`/fast` claim now use.
 */
const OPUS = { value: "opus", resolvedModel: "claude-opus-5-5", displayName: "Opus 5.5" };
const OPUS_1M = { value: "opus[1m]", resolvedModel: "claude-opus-5-5", displayName: "Opus 5.5 (1M)" };
const SONNET = { value: "sonnet", resolvedModel: "claude-sonnet-5-5", displayName: "Sonnet 5.5" };

describe("findModelEntry", () => {
  test("opus[1m] resolves to the listed opus row", () => {
    expect(findModelEntry([SONNET, OPUS], "opus[1m]")).toBe(OPUS);
    expect(findModelEntry([SONNET, OPUS], "Opus[1M]")).toBe(OPUS);
  });

  test("exact value wins when both opus and opus[1m] are listed", () => {
    expect(findModelEntry([OPUS, OPUS_1M], "opus[1m]")).toBe(OPUS_1M);
    expect(findModelEntry([OPUS, OPUS_1M], "opus")).toBe(OPUS);
  });

  test("a tagged full id matches through resolvedModel", () => {
    expect(findModelEntry([SONNET, OPUS], "claude-opus-5-5[1m]")).toBe(OPUS);
  });

  test("a tagged full id prefers an explicit row over the leading Default row", () => {
    // The engine always lists `{ value: "default", resolvedModel: <default> }` first.
    const DEFAULT = { value: "default", resolvedModel: "claude-opus-5-5", displayName: "Default" };
    expect(findModelEntry([DEFAULT, SONNET, OPUS], "claude-opus-5-5[1m]")).toBe(OPUS);
    // Only the Default row resolves there → Default.
    expect(findModelEntry([DEFAULT, SONNET], "claude-opus-5-5[1m]")).toBe(DEFAULT);
    // An exact `default` pick still checks Default.
    expect(findModelEntry([DEFAULT, OPUS], "default")).toBe(DEFAULT);
  });

  test("never crosses families", () => {
    expect(findModelEntry([SONNET], "opus[1m]")).toBeNull();
    expect(findModelEntry([OPUS], "sonnet[1m]")).toBeNull();
  });

  test("untagged ids keep exact-only matching", () => {
    // A pinned id without the tag is unchanged from before 2.1.316.
    expect(findModelEntry([SONNET, OPUS], "claude-opus-5-5")).toBeNull();
    expect(findModelEntry([SONNET, OPUS], "Opus")).toBeNull();
  });

  test("empty inputs", () => {
    expect(findModelEntry(null, "opus")).toBeNull();
    expect(findModelEntry([OPUS], null)).toBeNull();
    expect(findModelEntry([OPUS], "")).toBeNull();
  });

  test("stripOneMTag only removes a trailing tag", () => {
    expect(stripOneMTag("opus[1m]")).toBe("opus");
    expect(stripOneMTag("claude-opus-4-8[1M]")).toBe("claude-opus-4-8");
    expect(stripOneMTag("opus")).toBe("opus");
  });
});
