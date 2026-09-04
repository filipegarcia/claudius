import { describe, expect, test } from "vitest";
import { tokenizeJsonPretty, tokenizeJsonValue } from "@/lib/shared/json-syntax";

/**
 * Unit tests for the hand-rolled JSON syntax tokenizer backing
 * `JsonBlock` — CC 2.1.259/2.1.260 `/workflows` "pretty-printed with
 * syntax colors" parity.
 */
describe("tokenizeJsonPretty", () => {
  test("classifies keys, string values, numbers, booleans, and null", () => {
    const pretty = JSON.stringify({ name: "widget", count: 3, active: true, note: null }, null, 2);
    const tokens = tokenizeJsonPretty(pretty);
    const byType = (t: string) => tokens.filter((tok) => tok.type === t).map((tok) => tok.text);

    expect(byType("key")).toEqual(['"name":', '"count":', '"active":', '"note":']);
    expect(byType("string")).toEqual(['"widget"']);
    expect(byType("number")).toEqual(["3"]);
    expect(byType("boolean")).toEqual(["true"]);
    expect(byType("null")).toEqual(["null"]);
  });

  test("reassembling every token's text reproduces the original string exactly", () => {
    const pretty = JSON.stringify(
      { a: [1, 2.5, -3, "x\"y", { nested: true }], b: null },
      null,
      2,
    );
    const tokens = tokenizeJsonPretty(pretty);
    expect(tokens.map((t) => t.text).join("")).toBe(pretty);
  });

  test("punctuation, indentation, and newlines are preserved verbatim as 'punct' runs", () => {
    const pretty = '{\n  "a": 1\n}';
    const tokens = tokenizeJsonPretty(pretty);
    const punct = tokens.filter((t) => t.type === "punct").map((t) => t.text);
    expect(punct).toContain("{\n  ");
    expect(punct).toContain("\n}");
  });

  test("a string that itself contains a colon is not misclassified as a key", () => {
    const pretty = JSON.stringify({ url: "https://example.com" }, null, 2);
    const tokens = tokenizeJsonPretty(pretty);
    const strings = tokens.filter((t) => t.type === "string").map((t) => t.text);
    expect(strings).toEqual(['"https://example.com"']);
  });

  test("negative and exponential numbers are matched as single number tokens", () => {
    const pretty = JSON.stringify([-3, 1.5e21, -2.25], null, 2);
    const numbers = tokenizeJsonPretty(pretty).filter((t) => t.type === "number").map((t) => t.text);
    expect(numbers).toEqual(["-3", "1.5e+21", "-2.25"]);
  });
});

describe("tokenizeJsonValue", () => {
  test("stringifies and tokenizes a plain value", () => {
    const tokens = tokenizeJsonValue({ ok: true });
    expect(tokens.some((t) => t.type === "key" && t.text === '"ok":')).toBe(true);
    expect(tokens.some((t) => t.type === "boolean" && t.text === "true")).toBe(true);
  });

  test("falls back to String(value) for a non-serializable input instead of throwing", () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(() => tokenizeJsonValue(circular)).not.toThrow();
  });
});
