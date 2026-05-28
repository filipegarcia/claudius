import { describe, expect, test } from "vitest";
import { extractUserPromptText, isRealUserPrompt } from "@/lib/shared/user-prompt";

describe("extractUserPromptText", () => {
  test("returns the body of a plain string prompt", () => {
    expect(extractUserPromptText("fix the bug")).toBe("fix the bug");
  });

  test("returns the concatenated text of an array-content prompt", () => {
    expect(
      extractUserPromptText([
        { type: "text", text: "fix " },
        { type: "text", text: "the bug" },
      ]),
    ).toBe("fix the bug");
  });

  test("rejects empty / non-text content", () => {
    expect(extractUserPromptText("")).toBeNull();
    expect(extractUserPromptText([])).toBeNull();
    expect(extractUserPromptText([{ type: "tool_result", tool_use_id: "t1" }])).toBeNull();
    expect(extractUserPromptText(null)).toBeNull();
  });

  test("rejects synthetic <task-notification> wrappers", () => {
    expect(extractUserPromptText("<task-notification>done</task-notification>")).toBeNull();
  });

  test("rejects the SDK post-compact continuation summary (string content)", () => {
    const summary =
      "This session is being continued from a previous conversation that ran out of context. " +
      "The summary below covers the earlier portion of the conversation.\n\nSummary:\n1. …";
    expect(extractUserPromptText(summary)).toBeNull();
    expect(isRealUserPrompt(summary)).toBe(false);
  });

  test("rejects the continuation summary in array content and with leading whitespace", () => {
    expect(
      extractUserPromptText([
        { type: "text", text: "   \n This session is being continued from a previous conversation…" },
      ]),
    ).toBeNull();
  });

  test("does not reject a normal prompt that merely mentions the phrase mid-sentence", () => {
    const text = "note: this session is being continued from a previous conversation, fyi";
    expect(extractUserPromptText(text)).toBe(text);
    expect(isRealUserPrompt(text)).toBe(true);
  });
});
