import { describe, expect, test } from "vitest";
import { parseFrontmatter } from "@/lib/server/agents";

/**
 * Pin down the YAML-backed frontmatter parser shared by agents.ts and
 * skills.ts. A-P1.5a swapped the hand-rolled scalar+flat-list parser for the
 * `yaml` package so nested structures round-trip — specifically the object
 * form of an agent's `mcpServers`. These tests guard both the new capability
 * and backward compatibility with the shapes the old parser handled, plus the
 * `{ frontmatter, body }` contract that skills.ts also depends on.
 */
describe("parseFrontmatter", () => {
  test("returns empty frontmatter + full raw body when there is no frontmatter block", () => {
    const raw = "Just a prompt body, no delimiters.\n";
    expect(parseFrontmatter(raw)).toEqual({ frontmatter: {}, body: raw });
  });

  test("parses scalars to their JS types (string / number / boolean)", () => {
    const raw = [
      "---",
      "name: my-agent",
      "maxTurns: 12",
      "background: true",
      "---",
      "Body here.",
      "",
    ].join("\n");
    const { frontmatter, body } = parseFrontmatter(raw);
    expect(frontmatter.name).toBe("my-agent");
    expect(frontmatter.maxTurns).toBe(12);
    expect(frontmatter.background).toBe(true);
    expect(body).toBe("Body here.\n");
  });

  test("parses flow lists and block lists identically to the old parser", () => {
    const flow = parseFrontmatter("---\ntools: [Read, Grep, Glob]\n---\n").frontmatter;
    expect(flow.tools).toEqual(["Read", "Grep", "Glob"]);

    const block = parseFrontmatter(
      ["---", "skills:", "  - pdf", "  - docx", "---", ""].join("\n"),
    ).frontmatter;
    expect(block.skills).toEqual(["pdf", "docx"]);
  });

  test("round-trips the OBJECT form of mcpServers (the A-P1.5a motivation)", () => {
    const raw = [
      "---",
      "name: db-agent",
      "mcpServers:",
      "  postgres:",
      "    command: npx",
      "    args:",
      "      - -y",
      // `@` is a reserved YAML indicator, so a scope-prefixed package must be
      // quoted — exactly how a real agent frontmatter would write it.
      '      - "@org/pg-mcp"',
      "  fetch:",
      "    url: https://example.com/sse",
      "---",
      "Prompt.",
      "",
    ].join("\n");
    const { frontmatter } = parseFrontmatter(raw);
    expect(frontmatter.mcpServers).toEqual({
      postgres: { command: "npx", args: ["-y", "@org/pg-mcp"] },
      fetch: { url: "https://example.com/sse" },
    });
  });

  test("still supports the string-list form of mcpServers", () => {
    const { frontmatter } = parseFrontmatter(
      ["---", "mcpServers: [postgres, fetch]", "---", ""].join("\n"),
    );
    expect(frontmatter.mcpServers).toEqual(["postgres", "fetch"]);
  });

  test("malformed YAML frontmatter falls back to empty (does not throw) and keeps the body", () => {
    // A stray unmatched bracket is invalid YAML; the parser must degrade
    // gracefully so the prompt body stays editable in the UI.
    const raw = ["---", "tools: [Read, Grep", "name: broken", "---", "Body.", ""].join("\n");
    const { frontmatter, body } = parseFrontmatter(raw);
    expect(frontmatter).toEqual({});
    expect(body).toBe("Body.\n");
  });

  test("ISO-date-looking scalars stay strings (no YAML 1.1 timestamp coercion)", () => {
    const { frontmatter } = parseFrontmatter("---\nmodel: 2026-05-28\n---\n");
    expect(frontmatter.model).toBe("2026-05-28");
    expect(typeof frontmatter.model).toBe("string");
  });

  test("a frontmatter block that is not a mapping (e.g. a bare list) yields empty frontmatter", () => {
    // yaml.parse of a top-level sequence returns an array; the contract is a
    // keyed record, so non-object roots collapse to {} rather than leaking an
    // array where callers expect Record<string, unknown>.
    const { frontmatter } = parseFrontmatter("---\n- a\n- b\n---\nbody\n");
    expect(frontmatter).toEqual({});
  });
});
