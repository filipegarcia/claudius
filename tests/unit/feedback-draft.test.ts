import { describe, expect, it } from "vitest";
import { extractFeedbackDraftText } from "@/lib/shared/feedback-draft";

describe("extractFeedbackDraftText", () => {
  it("returns null when no recognized field is present", () => {
    expect(extractFeedbackDraftText({})).toBeNull();
    expect(extractFeedbackDraftText({ foo: "bar" })).toBeNull();
  });

  it("ignores non-string and blank values", () => {
    expect(extractFeedbackDraftText({ report: 42 })).toBeNull();
    expect(extractFeedbackDraftText({ report: "   " })).toBeNull();
  });

  it("prefers the more specific field name when several are present", () => {
    expect(
      extractFeedbackDraftText({ text: "generic", report: "the real draft" }),
    ).toBe("the real draft");
  });

  it("falls back through the field order", () => {
    expect(extractFeedbackDraftText({ feedback: "b" })).toBe("b");
    expect(extractFeedbackDraftText({ description: "c" })).toBe("c");
    expect(extractFeedbackDraftText({ summary: "d" })).toBe("d");
    expect(extractFeedbackDraftText({ text: "e" })).toBe("e");
  });
});
