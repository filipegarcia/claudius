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
    expect(extractFeedbackDraftText({ title: 1, details: "   " })).toBeNull();
  });

  // CC 2.1.247 (F10) — the real SendFeedbackInput schema.
  it("reads the real title + details schema, title bolded as a headline", () => {
    expect(
      extractFeedbackDraftText({
        type: "bug",
        title: "Edit tool failed on CRLF files",
        details: "**What happened:** the edit was rejected.",
      }),
    ).toBe("**Edit tool failed on CRLF files**\n\n**What happened:** the edit was rejected.");
  });

  it("works with only title or only details", () => {
    expect(extractFeedbackDraftText({ title: "Just a title" })).toBe("**Just a title**");
    expect(extractFeedbackDraftText({ details: "just details" })).toBe("just details");
  });

  it("prefers the real schema over the legacy fallback keys", () => {
    expect(
      extractFeedbackDraftText({ report: "legacy dump", title: "real title" }),
    ).toBe("**real title**");
  });

  it("still falls back through the legacy field order when title/details are absent", () => {
    expect(extractFeedbackDraftText({ report: "the real draft", text: "generic" })).toBe(
      "the real draft",
    );
    expect(extractFeedbackDraftText({ feedback: "b" })).toBe("b");
    expect(extractFeedbackDraftText({ description: "c" })).toBe("c");
    expect(extractFeedbackDraftText({ summary: "d" })).toBe("d");
    expect(extractFeedbackDraftText({ text: "e" })).toBe("e");
  });
});
