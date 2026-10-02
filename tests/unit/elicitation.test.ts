import { describe, expect, test } from "vitest";
import {
  buildElicitationContent,
  initialFormValues,
  parseElicitationDecision,
  parseElicitationSchema,
  safeElicitationUrl,
} from "@/lib/shared/elicitation";

/**
 * MCP elicitation helpers. Everything here is MCP-server-authored input, so
 * the interesting cases are the hostile ones: non-http URLs, prototype keys,
 * and malformed decision bodies hitting the `/elicitation` route.
 */
describe("safeElicitationUrl", () => {
  test("accepts http(s)", () => {
    expect(safeElicitationUrl("https://auth.example.com/login?x=1")?.host).toBe("auth.example.com");
    expect(safeElicitationUrl("http://localhost:8080/cb")?.port).toBe("8080");
  });

  test("rejects javascript:, data:, file: and garbage", () => {
    for (const raw of ["javascript:alert(1)", "data:text/html,hi", "file:///etc/passwd", "not a url", "", undefined]) {
      expect(safeElicitationUrl(raw)).toBeNull();
    }
  });
});

describe("parseElicitationSchema", () => {
  test("flattens the MCP primitive subset in property order", () => {
    const fields = parseElicitationSchema({
      type: "object",
      properties: {
        email: { type: "string", format: "email", title: "Email" },
        age: { type: "integer", minimum: 0 },
        subscribe: { type: "boolean", default: true },
        plan: { type: "string", oneOf: [{ const: "free", title: "Free" }, { const: "pro", title: "Pro" }] },
        legacy: { type: "string", enum: ["a", "b"], enumNames: ["Alpha", "Beta"] },
        tags: { type: "array", items: { type: "string", enum: ["x", "y"] }, maxItems: 1 },
      },
      required: ["email"],
    });
    expect(fields.map((f) => [f.key, f.kind, f.required])).toEqual([
      ["email", "string", true],
      ["age", "number", false],
      ["subscribe", "boolean", false],
      ["plan", "enum", false],
      ["legacy", "enum", false],
      ["tags", "multi-enum", false],
    ]);
    const legacy = fields.find((f) => f.key === "legacy");
    expect(legacy && legacy.kind === "enum" ? legacy.options : []).toEqual([
      { value: "a", label: "Alpha" },
      { value: "b", label: "Beta" },
    ]);
  });

  test("skips prototype keys and unsupported shapes", () => {
    const fields = parseElicitationSchema({
      properties: JSON.parse('{"__proto__": {"type": "string"}, "nested": {"type": "object"}, "ok": {"type": "string"}}'),
    });
    expect(fields.map((f) => f.key)).toEqual(["ok"]);
  });

  test("tolerates a missing or junk schema", () => {
    expect(parseElicitationSchema(undefined)).toEqual([]);
    expect(parseElicitationSchema({ properties: "nope" } as unknown as Record<string, unknown>)).toEqual([]);
  });
});

describe("buildElicitationContent", () => {
  const fields = parseElicitationSchema({
    properties: {
      name: { type: "string", minLength: 2 },
      count: { type: "integer", minimum: 1, maximum: 5 },
      agree: { type: "boolean" },
      color: { type: "string", enum: ["red", "blue"] },
      tags: { type: "array", items: { enum: ["x", "y"] } },
    },
    required: ["name", "color"],
  });

  test("coerces valid input to MCP content", () => {
    const values = { ...initialFormValues(fields), name: " Ada ", count: "3", agree: true, color: "blue", tags: ["y"] };
    expect(buildElicitationContent(fields, values)).toEqual({
      ok: true,
      content: { name: "Ada", count: 3, agree: true, color: "blue", tags: ["y"] },
    });
  });

  test("reports per-field errors instead of sending", () => {
    const values = { ...initialFormValues(fields), name: "A", count: "2.5", color: "" };
    const out = buildElicitationContent(fields, values);
    expect(out.ok).toBe(false);
    if (!out.ok) expect(Object.keys(out.errors).sort()).toEqual(["color", "count", "name"]);
  });

  test("optional empty fields are omitted, not sent as empty strings", () => {
    const values = { ...initialFormValues(fields), name: "Ada", color: "red" };
    const out = buildElicitationContent(fields, values);
    expect(out.ok && out.content).toEqual({ name: "Ada", color: "red", agree: false });
  });
});

describe("parseElicitationDecision", () => {
  test("accepts the three actions", () => {
    expect(parseElicitationDecision({ action: "decline" })).toEqual({ action: "decline" });
    expect(parseElicitationDecision({ action: "cancel", content: { x: 1 } })).toEqual({ action: "cancel" });
    expect(parseElicitationDecision({ action: "accept" })).toEqual({ action: "accept" });
    expect(parseElicitationDecision({ action: "accept", content: { a: "s", b: 2, c: false, d: ["x"] } })).toEqual({
      action: "accept",
      content: { a: "s", b: 2, c: false, d: ["x"] },
    });
  });

  test("rejects unknown actions, nested objects, non-finite numbers and prototype keys", () => {
    expect(parseElicitationDecision({ action: "allow" })).toBeNull();
    expect(parseElicitationDecision(null)).toBeNull();
    expect(parseElicitationDecision({ action: "accept", content: { a: { b: 1 } } })).toBeNull();
    expect(parseElicitationDecision({ action: "accept", content: { a: Number.NaN } })).toBeNull();
    expect(parseElicitationDecision({ action: "accept", content: { a: [1] } })).toBeNull();
    expect(parseElicitationDecision(JSON.parse('{"action":"accept","content":{"__proto__":"x"}}'))).toBeNull();
  });
});
