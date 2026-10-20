import { describe, expect, test } from "vitest";
import { splitCompactSummaryTools } from "@/lib/shared/compact-summary-tools";

/**
 * CC 2.1.304 — the engine writes `<tools-used-before-summary>…</…>` into the
 * compact summary; the "show summary" view splits it out.
 */
const PREAMBLE =
  "This session is being continued from a previous conversation that ran out of context. The summary below covers the earlier portion of the conversation.";

describe("splitCompactSummaryTools (CC 2.1.304)", () => {
  test("populated tag → tool names, tag line removed from the body", () => {
    const text = `${PREAMBLE}\n\n<tools-used-before-summary>Bash, Edit, Read</tools-used-before-summary>\nSummary:\n1. Did things.`;
    const { tools, body } = splitCompactSummaryTools(text);
    expect(tools).toEqual(["Bash", "Edit", "Read"]);
    expect(body).toBe(`${PREAMBLE}\n\nSummary:\n1. Did things.`);
    expect(body).not.toContain("tools-used-before-summary");
  });

  test("empty tag (no tools ran) → no names, tag still stripped", () => {
    const text = `${PREAMBLE}\n\n<tools-used-before-summary></tools-used-before-summary>\nSummary:\n1. Talked.`;
    const { tools, body } = splitCompactSummaryTools(text);
    expect(tools).toEqual([]);
    expect(body).toBe(`${PREAMBLE}\n\nSummary:\n1. Talked.`);
  });

  test("no tag (older engine) → text unchanged", () => {
    const text = `${PREAMBLE}\n\nSummary:\n1. Old format.`;
    expect(splitCompactSummaryTools(text)).toEqual({ tools: [], body: text });
  });

  test("a marker line before the preamble doesn't stop the match", () => {
    const text = `<artifact-content-authored-by-others/>\n${PREAMBLE}\n\n<tools-used-before-summary>mcp__github__create_issue, WebFetch</tools-used-before-summary>\nSummary:\nx`;
    const { tools, body } = splitCompactSummaryTools(text);
    expect(tools).toEqual(["mcp__github__create_issue", "WebFetch"]);
    expect(body.startsWith("<artifact-content-authored-by-others/>\n")).toBe(true);
    expect(body).not.toContain("tools-used-before-summary");
  });

  test("blank entries are dropped and duplicates collapse", () => {
    const text = `<tools-used-before-summary> Bash, , Read,Bash </tools-used-before-summary>\nSummary:`;
    expect(splitCompactSummaryTools(text)).toEqual({ tools: ["Bash", "Read"], body: "Summary:" });
  });
});
