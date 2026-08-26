import { describe, expect, test } from "vitest";
import { applyModelPickerCuration, type CuratedModelInfo } from "@/lib/server/model-picker-curation";

/**
 * Pure-function coverage for the `modelPicker` setting (Claude Code
 * 2.1.243 — "curate the /model picker with an ordered, labeled list of
 * models... appended to or replacing the built-in lineup").
 */

const BUILTIN: CuratedModelInfo[] = [
  { value: "sonnet", displayName: "Sonnet", description: "Latest Sonnet" },
  { value: "opus", displayName: "Opus", description: "Latest Opus" },
];

describe("applyModelPickerCuration", () => {
  test("returns the list unchanged when no setting is configured", () => {
    expect(applyModelPickerCuration(BUILTIN, undefined)).toBe(BUILTIN);
    expect(applyModelPickerCuration(BUILTIN, {})).toBe(BUILTIN);
    expect(applyModelPickerCuration(BUILTIN, { entries: [] })).toBe(BUILTIN);
  });

  test("append mode (default) adds curated entries after the built-in lineup", () => {
    const result = applyModelPickerCuration(BUILTIN, {
      entries: [{ id: "bedrock:anthropic.claude-opus-4-8", label: "Org Opus (Bedrock)" }],
    });
    expect(result).toHaveLength(3);
    expect(result[0].value).toBe("sonnet");
    expect(result[1].value).toBe("opus");
    expect(result[2]).toMatchObject({
      value: "bedrock:anthropic.claude-opus-4-8",
      displayName: "Org Opus (Bedrock)",
    });
  });

  test("append mode skips a curated id that's already in the list", () => {
    const result = applyModelPickerCuration(BUILTIN, {
      mode: "append",
      entries: [{ id: "opus", label: "Renamed Opus" }],
    });
    // Exact-value dedup: the SDK's richer "opus" entry wins, not the thin
    // curated stub — curating a model that's already present is a no-op.
    expect(result).toHaveLength(2);
    expect(result[1]).toBe(BUILTIN[1]);
  });

  test("replace mode returns ONLY the curated entries, in configured order", () => {
    const result = applyModelPickerCuration(BUILTIN, {
      mode: "replace",
      entries: [
        { id: "vertex:claude-opus-4-8@20260115" },
        { id: "claude-haiku-4-5", label: "House Haiku" },
      ],
    });
    expect(result).toEqual([
      {
        value: "vertex:claude-opus-4-8@20260115",
        displayName: "vertex:claude-opus-4-8@20260115",
        description: "Curated model (modelPicker setting).",
      },
      {
        value: "claude-haiku-4-5",
        displayName: "House Haiku",
        description: "Curated model (modelPicker setting).",
      },
    ]);
  });

  test("filters out entries with a blank id", () => {
    const result = applyModelPickerCuration(BUILTIN, {
      entries: [{ id: "  " }, { id: "" }],
    });
    expect(result).toBe(BUILTIN);
  });
});
