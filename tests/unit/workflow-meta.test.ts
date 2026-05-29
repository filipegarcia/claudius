import { describe, expect, test } from "vitest";

import { parseWorkflowMeta } from "@/lib/shared/workflow-meta";

/**
 * The Workflow tool's `meta` literal is the only structured handle we have on
 * a running workflow (name + description + phases). This parser drives the
 * transcript's WorkflowBlock header/phases, so it has to survive the two real
 * failure modes: a script still streaming in (truncated), and human prose with
 * apostrophes/escapes inside the strings. It must never throw.
 */
describe("parseWorkflowMeta", () => {
  test("parses name, description, and phases from a complete script", () => {
    const script = `export const meta = {
  name: 'review-changes',
  description: 'Review changed files across dimensions, verify each finding',
  phases: [
    { title: 'Review', detail: 'one agent per dimension' },
    { title: 'Verify' },
  ],
}
const x = await agent('go')`;
    const meta = parseWorkflowMeta(script);
    expect(meta.name).toBe("review-changes");
    expect(meta.description).toBe("Review changed files across dimensions, verify each finding");
    expect(meta.phases).toEqual([
      { title: "Review", detail: "one agent per dimension" },
      { title: "Verify", detail: undefined },
    ]);
  });

  test("handles a description containing an escaped apostrophe", () => {
    const script = `export const meta = { name: 'x', description: 'don\\'t break the parser', phases: [] }`;
    const meta = parseWorkflowMeta(script);
    expect(meta.name).toBe("x");
    expect(meta.description).toBe("don't break the parser");
    expect(meta.phases).toEqual([]);
  });

  test("pulls the name from a truncated/streaming script (no closing braces)", () => {
    // What the UI sees mid-stream: the meta object is incomplete and the
    // description value is cut off before its closing quote.
    const partial = `export const meta = {\n  name: 'announce-claudius',\n  description: 'Research the late`;
    const meta = parseWorkflowMeta(partial);
    expect(meta.name).toBe("announce-claudius");
    expect(meta.description).toBeUndefined(); // unterminated → not surfaced
    expect(meta.phases).toEqual([]);
  });

  test("parses meta out of the JSON-escaped __partial wire form", () => {
    // During streaming the invalid partial JSON is stored verbatim, so the
    // script's newlines are backslash-n sequences. The name should still parse.
    const wire = `{"script": "export const meta = {\\n  name: 'wire-name',\\n  phases: [`;
    const meta = parseWorkflowMeta(wire);
    expect(meta.name).toBe("wire-name");
  });

  test("returns empty meta for missing/foreign input (never throws)", () => {
    expect(parseWorkflowMeta(undefined)).toEqual({ phases: [] });
    expect(parseWorkflowMeta("")).toEqual({ phases: [] });
    expect(parseWorkflowMeta("const meta = 42")).toEqual({ phases: [] });
    expect(parseWorkflowMeta("{not even a script")).toEqual({ phases: [] });
  });
});
