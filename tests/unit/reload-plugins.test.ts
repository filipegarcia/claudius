import { describe, expect, test } from "vitest";
import { describeReloadPluginsResult, isForceReload } from "@/lib/shared/reload-plugins";

describe("isForceReload", () => {
  test("recognizes the force query-param convention", () => {
    expect(isForceReload("1")).toBe(true);
    expect(isForceReload("true")).toBe(true);
  });

  test("treats anything else as not forced", () => {
    expect(isForceReload("0")).toBe(false);
    expect(isForceReload("false")).toBe(false);
    expect(isForceReload("")).toBe(false);
    expect(isForceReload(null)).toBe(false);
    expect(isForceReload(undefined)).toBe(false);
  });
});

describe("describeReloadPluginsResult", () => {
  test("a plain (non-held) reload reads as a simple confirmation", () => {
    expect(describeReloadPluginsResult({ held: false })).toBe("Plugins reloaded");
  });

  test("a missing/malformed payload degrades to a simple confirmation", () => {
    expect(describeReloadPluginsResult(undefined)).toBe("Plugins reloaded");
    expect(describeReloadPluginsResult(null)).toBe("Plugins reloaded");
    expect(describeReloadPluginsResult({})).toBe("Plugins reloaded");
  });

  test("a held reload with no cache_impact still names the escape hatch", () => {
    expect(describeReloadPluginsResult({ held: true })).toBe(
      "Reload held (would invalidate the prompt cache). Run /reload-plugins force to apply.",
    );
  });

  test("summarizes added/removed MCP servers and an LSP tool addition", () => {
    const msg = describeReloadPluginsResult({
      held: true,
      cache_impact: {
        mcp_servers_added: ["docs", "linear"],
        mcp_servers_removed: ["stale-server"],
        lsp_tool_change: "adds",
      },
    });
    expect(msg).toBe(
      "Reload held (would invalidate the prompt cache) — +2 MCP servers, -1 MCP server, adds LSP tool. Run /reload-plugins force to apply.",
    );
  });

  test("treats may-add / may-remove the same as their definite counterparts for copy purposes", () => {
    expect(
      describeReloadPluginsResult({
        held: true,
        cache_impact: { lsp_tool_change: "may-remove" },
      }),
    ).toContain("removes LSP tool");
    expect(
      describeReloadPluginsResult({
        held: true,
        cache_impact: { lsp_tool_change: "may-add" },
      }),
    ).toContain("adds LSP tool");
  });

  test("singularizes a single-server delta", () => {
    const msg = describeReloadPluginsResult({
      held: true,
      cache_impact: { mcp_servers_added: ["docs"] },
    });
    expect(msg).toBe(
      "Reload held (would invalidate the prompt cache) — +1 MCP server. Run /reload-plugins force to apply.",
    );
  });
});
