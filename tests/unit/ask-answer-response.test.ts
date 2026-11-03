import { describe, expect, test } from "vitest";
import { buildAskUpdatedInput } from "@/lib/shared/events";
import type { AskQuestion } from "@/lib/shared/events";

/**
 * SDK 0.3.158 added `response?: string` to AskUserQuestionOutput.
 * This field carries freeform text the user typed instead of selecting
 * a structured option (the "Other" path). `buildAskUpdatedInput` is
 * the pure function that assembles the `updatedInput` returned to the
 * SDK; these tests pin the new `response` wiring.
 */

const OPTS = [
  { label: "Option A", description: "First option" },
  { label: "Option B", description: "Second option" },
  { label: "Other", description: "Custom answer" },
];

function makeQ(overrides?: Partial<AskQuestion>): AskQuestion {
  return {
    question: "What would you like?",
    header: "Choice",
    options: OPTS,
    multiSelect: false,
    ...overrides,
  };
}

describe("buildAskUpdatedInput — response field (SDK 0.3.158)", () => {
  test("single-question Other path: response is populated", () => {
    const result = buildAskUpdatedInput(
      [makeQ()],
      [{ label: null, custom: "  my freeform answer  " }],
    );
    expect(result.response).toBe("my freeform answer");
    // answers map still carries the text for backwards-compatibility
    expect(result.answers["What would you like?"]).toBe("my freeform answer");
  });

  test("single-question structured-option path: response is absent", () => {
    const result = buildAskUpdatedInput(
      [makeQ()],
      [{ label: "Option A" }],
    );
    expect(result.response).toBeUndefined();
    expect(result.answers["What would you like?"]).toBe("Option A");
  });

  test("multi-question form with Other path: response is absent (ambiguous mapping)", () => {
    const result = buildAskUpdatedInput(
      [makeQ({ question: "Q1" }), makeQ({ question: "Q2" })],
      [{ label: null, custom: "freeform for Q1" }, { label: "Option B" }],
    );
    expect(result.response).toBeUndefined();
    expect(result.answers["Q1"]).toBe("freeform for Q1");
    expect(result.answers["Q2"]).toBe("Option B");
  });
});

describe("buildAskUpdatedInput — annotations.unanswered (SDK 0.3.312)", () => {
  const qs = [makeQ({ question: "First?" }), makeQ({ question: "Second?" })];
  const answers = [{ label: "Option A" }, {}];

  test("marks a blank answer as skipped when the capability is advertised", () => {
    const out = buildAskUpdatedInput(qs, answers, { reportUnanswered: true });
    expect(out.answers).toEqual({ "First?": "Option A", "Second?": "" });
    expect(out.annotations).toEqual({ "Second?": { unanswered: "skipped" } });
  });

  test("keeps a preview annotation alongside unanswered on other questions", () => {
    const withPreview = [
      makeQ({ question: "First?", options: [{ label: "Option A", description: "", preview: "pv" }] }),
      makeQ({ question: "Second?" }),
    ];
    const out = buildAskUpdatedInput(withPreview, answers, { reportUnanswered: true });
    expect(out.annotations).toEqual({
      "First?": { preview: "pv" },
      "Second?": { unanswered: "skipped" },
    });
  });

  test("sends no unanswered key without the capability (default)", () => {
    const out = buildAskUpdatedInput(qs, answers);
    expect(out.annotations).toBeUndefined();
  });

  test("a fully answered form carries no unanswered key even with the capability", () => {
    const out = buildAskUpdatedInput(qs, [{ label: "Option A" }, { label: "Option B" }], { reportUnanswered: true });
    expect(out.annotations).toBeUndefined();
  });
});
