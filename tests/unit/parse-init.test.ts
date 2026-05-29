import { describe, expect, test } from "vitest";
import { parseInitSystemMessage } from "@/lib/shared/parse-init";

/**
 * Pin down the SDK `system:init` → session-state mapping. The init message
 * announces the tools, slash commands, subagents, and skills the SDK loaded
 * for a fresh session; the client threads these into state for early paint
 * (the agent/skill/command overlays render off this list before the richer
 * `supportedAgents()` / `supportedCommands()` control requests resolve).
 *
 * The `agents` field is the focus of plan item A-P0.5: the subagent name list
 * must survive the SDK→state hop. Historically the chat renderer silently
 * dropped subagent data when an SDK field name drifted (the Task→Agent rename,
 * A-P0.1), so this parser is defensively typed and these tests guard the
 * extraction.
 */
describe("parseInitSystemMessage", () => {
  test("extracts every init field from a well-formed message", () => {
    const msg = {
      type: "system",
      subtype: "init",
      tools: ["Bash", "Read", "Edit"],
      slash_commands: ["/clear", "/compact"],
      agents: ["general-purpose", "Explore", "code-reviewer"],
      skills: ["pdf", "docx"],
      cwd: "/work/project",
      model: "claude-opus-4-7",
      permissionMode: "default",
      claude_code_version: "2.1.99",
    };

    expect(parseInitSystemMessage(msg)).toEqual({
      tools: ["Bash", "Read", "Edit"],
      slashCommands: ["/clear", "/compact"],
      agents: ["general-purpose", "Explore", "code-reviewer"],
      skills: ["pdf", "docx"],
      cwd: "/work/project",
      model: "claude-opus-4-7",
      permissionMode: "default",
      claudeCodeVersion: "2.1.99",
    });
  });

  test("threads the subagent list specifically (A-P0.5 regression guard)", () => {
    const out = parseInitSystemMessage({
      subtype: "init",
      agents: ["Explore", "migration-engineer"],
    });
    expect(out.agents).toEqual(["Explore", "migration-engineer"]);
  });

  test("missing arrays collapse to empty (not undefined) so .length is always safe", () => {
    const out = parseInitSystemMessage({ subtype: "init" });
    expect(out.tools).toEqual([]);
    expect(out.slashCommands).toEqual([]);
    expect(out.agents).toEqual([]);
    expect(out.skills).toEqual([]);
    expect(out.cwd).toBeUndefined();
    expect(out.model).toBeUndefined();
    expect(out.permissionMode).toBeUndefined();
    expect(out.claudeCodeVersion).toBeUndefined();
  });

  test("filters non-string array entries (schema-drift defense)", () => {
    const out = parseInitSystemMessage({
      agents: ["Explore", 42, null, "code-reviewer", { name: "x" }],
    });
    expect(out.agents).toEqual(["Explore", "code-reviewer"]);
  });

  test("empty-string scalars are treated as absent", () => {
    const out = parseInitSystemMessage({ cwd: "", model: "", claude_code_version: "" });
    expect(out.cwd).toBeUndefined();
    expect(out.model).toBeUndefined();
    expect(out.claudeCodeVersion).toBeUndefined();
  });

  test("tolerates null / undefined / non-object input without throwing", () => {
    for (const bad of [null, undefined, 7, "str", []]) {
      const out = parseInitSystemMessage(bad);
      expect(out.agents).toEqual([]);
      expect(out.tools).toEqual([]);
    }
  });

  test("does not read unrelated keys (only the init contract)", () => {
    const out = parseInitSystemMessage({
      agents: ["a"],
      mcp_servers: [{ name: "x", status: "connected" }],
      output_style: "default",
    });
    // Only the typed fields appear on the result.
    expect(Object.keys(out).sort()).toEqual([
      "agents",
      "claudeCodeVersion",
      "cwd",
      "model",
      "permissionMode",
      "skills",
      "slashCommands",
      "tools",
    ]);
  });
});
