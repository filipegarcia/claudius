import { describe, expect, test } from "vitest";
import { findConfigWhitespaceWarnings, type McpServerConfig } from "@/lib/server/mcp";

/**
 * CC 2.1.218 parity — "a warning for MCP config values with hidden leading
 * or trailing whitespace". Pure-function coverage for the detector used by
 * `listConfigured()`; the pipe-through into the API response and the UI
 * banner are covered by the e2e spec (tests/e2e/cc-parity-2.1.218-mcp-whitespace-warning.spec.ts).
 */
describe("findConfigWhitespaceWarnings", () => {
  test("clean stdio config has no warnings", () => {
    const cfg: McpServerConfig = { command: "npx", args: ["-y", "some-mcp"], env: { API_KEY: "abc" } };
    expect(findConfigWhitespaceWarnings(cfg)).toEqual([]);
  });

  test("clean http config has no warnings", () => {
    const cfg: McpServerConfig = { type: "http", url: "https://example.com/mcp", headers: { Authorization: "Bearer x" } };
    expect(findConfigWhitespaceWarnings(cfg)).toEqual([]);
  });

  test("flags trailing whitespace on url", () => {
    const cfg: McpServerConfig = { type: "http", url: "https://example.com/mcp " };
    expect(findConfigWhitespaceWarnings(cfg)).toEqual(["url has leading/trailing whitespace"]);
  });

  test("flags leading whitespace on command", () => {
    const cfg: McpServerConfig = { command: " npx" };
    expect(findConfigWhitespaceWarnings(cfg)).toEqual(["command has leading/trailing whitespace"]);
  });

  test("flags whitespace in env keys and values independently", () => {
    const cfg: McpServerConfig = { command: "npx", env: { " API_KEY": "abc ", CLEAN: "fine" } };
    const warnings = findConfigWhitespaceWarnings(cfg);
    expect(warnings).toContain('env key " API_KEY" has leading/trailing whitespace');
    expect(warnings).toContain('env value for " API_KEY" has leading/trailing whitespace');
    expect(warnings.some((w) => w.includes("CLEAN"))).toBe(false);
  });

  test("flags whitespace in header keys and values for http/sse configs", () => {
    const cfg: McpServerConfig = { type: "sse", url: "https://example.com", headers: { "X-Token": " secret" } };
    expect(findConfigWhitespaceWarnings(cfg)).toEqual(['header value for "X-Token" has leading/trailing whitespace']);
  });

  test("internal whitespace is not flagged, only leading/trailing", () => {
    const cfg: McpServerConfig = { command: "npx run-mcp" };
    expect(findConfigWhitespaceWarnings(cfg)).toEqual([]);
  });
});
