import { describe, expect, test } from "vitest";
import { isTypingInField } from "@/lib/client/typing-focus";

/**
 * CC 2.1.299 — "Fixed Enter answering a question or permission prompt that
 * had been held back while you typed an unsent message". A `defaultToNo`
 * permission prompt mounting mid-draft must not steal focus (and with it the
 * Enter meant to send the draft). The unit suite runs in node, so the
 * predicate is exercised over plain element-shaped objects.
 */

describe("isTypingInField", () => {
  test("nothing focused / body focused → not typing", () => {
    expect(isTypingInField(null)).toBe(false);
    expect(isTypingInField(undefined)).toBe(false);
    expect(isTypingInField({ tagName: "BODY", textContent: "whole page text" })).toBe(false);
    expect(isTypingInField({ tagName: "BUTTON", textContent: "Send" })).toBe(false);
  });

  test("a textarea with a draft is mid-typing; an empty one is not", () => {
    expect(isTypingInField({ tagName: "TEXTAREA", value: "half a thought" })).toBe(true);
    expect(isTypingInField({ tagName: "TEXTAREA", value: "" })).toBe(false);
    expect(isTypingInField({ tagName: "TEXTAREA", value: "  \n " })).toBe(false);
  });

  test("text-like inputs count; checkbox / radio / button inputs don't", () => {
    expect(isTypingInField({ tagName: "INPUT", type: "text", value: "abc" })).toBe(true);
    expect(isTypingInField({ tagName: "INPUT", type: "search", value: "abc" })).toBe(true);
    // `type` reflects "text" for an <input> with no type attribute; an
    // element-shaped object without one is treated the same.
    expect(isTypingInField({ tagName: "INPUT", value: "abc" })).toBe(true);
    expect(isTypingInField({ tagName: "INPUT", type: "text", value: "" })).toBe(false);
    for (const type of ["checkbox", "radio", "button", "submit", "range", "color"]) {
      expect(isTypingInField({ tagName: "INPUT", type, value: "on" })).toBe(false);
    }
  });

  test("tag names are matched case-insensitively", () => {
    expect(isTypingInField({ tagName: "textarea", value: "x" })).toBe(true);
    expect(isTypingInField({ tagName: "input", type: "TEXT", value: "x" })).toBe(true);
  });

  test("contentEditable hosts use their text content", () => {
    expect(isTypingInField({ tagName: "DIV", isContentEditable: true, textContent: "draft" })).toBe(true);
    expect(isTypingInField({ tagName: "DIV", isContentEditable: true, textContent: "" })).toBe(false);
    expect(isTypingInField({ tagName: "DIV", isContentEditable: false, textContent: "draft" })).toBe(false);
  });
});
